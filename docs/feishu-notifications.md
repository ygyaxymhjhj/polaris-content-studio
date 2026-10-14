# 飞书社交提交与正式发布通知

默认关闭。未配置飞书、加密密钥或任务令牌时，不会因为通知功能而阻断已有项目的部署；通知数据表及应用账号授权仍需完成迁移。本文的服务器配置和发送命令供管理员在批准部署后自行执行，实施代码不等于已部署或已真实发送。

## 行为与权限边界

- Polaris 向 Postiz 提交的仍是**草稿**，不是立即发布。草稿提交成功后可以发送一条“已提交”通知；用户在 Postiz 正式发布后，后台确认 `PUBLISHED` 才发送“已发布”通知。
- 成员只能提交给自己拥有的社交账号；管理员可以选择任意社交账号。项目始终私有，即使管理员也不能把提交关联到别人的私人项目。没有项目关联的提交仍会保留审计记录。
- 提交历史继续限定在自己的项目及自己提交的无项目记录。正式发布状态、实际链接和发布时间来自独立跟踪记录，不覆盖原始提交审计。
- 管理员保存的飞书机器人配置供**整个工作区**使用，并非每个成员一份。飞书群成员会看到通知中的提交者、社交账号、平台、内容摘要、事件时间及发布链接（如已返回）。启用前确认群成员获准接收这些数据；通知不包含账号令牌、Webhook 或签名密钥。项目关联信息保留在服务器审计与跟踪记录中。
- 只为启用相应通知后的新提交创建事件，不回填已有历史。关闭通知或有效更换配置后，取消旧配置版本的待发消息及旧通知订阅，不会把它们转发给新机器人；Postiz 发布事实仍照常同步。未改变有效配置的空保存不会升级版本，也不会取消已有消息或订阅。
- Postiz 返回成功但没有真实帖子 ID 时，仍返回 `success: true` 和 warning；不会伪造帖子 ID，这条提交无法自动跟踪正式发布。登记或通知失败也不能撤回上游草稿，所以**不要因为 warning 再次提交**。
- 正式发布链接可能暂缺。只有 Postiz 确认 `PUBLISHED` 才显示已发布；`DRAFT`、`QUEUE`、`ERROR` 不会被当作已发布。历史 `publishedAt` 优先采用 Postiz 的发布时间，否则使用首次确认时间，均以 ISO 日期返回。

## 首次服务器配置

服务器应用目录为 `/opt/polaris-content-studio/app`，应用及运行器使用此目录已有的 `.env.local`，由 `polaris-studio` 用户读取。不要把真实密钥写入仓库、systemd 单元文本或工单日志。

管理员自行运行以下命令，**分别生成两份不同的随机值**，再使用安全编辑器把输出保存到服务器 `.env.local` 对应变量中。下列命令只输出随机值，不自动创建、追加或覆盖任何环境变量文件：

```bash
# FEISHU_ENCRYPTION_KEY：标准 Base64 编码的 32 字节密钥
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'

# SOCIAL_NOTIFICATIONS_TOKEN：独立内部任务令牌，至少 32 个 ASCII 非空白字符
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

需要保存的变量名称：

```dotenv
FEISHU_ENCRYPTION_KEY=<上述第一条命令生成的值>
SOCIAL_NOTIFICATIONS_TOKEN=<上述第二条命令生成的值>
SOCIAL_NOTIFICATIONS_INTERNAL_URL=http://192.168.220.109:13300/api/internal/social-notifications
```

占位符不能直接使用。`FEISHU_ENCRYPTION_KEY` 加密数据库里的 Webhook 和签名凭据，必须安全备份；**不要随意重置密钥**，否则已有密文不可读。轮换时须保留旧值并安排重新配置，不能以重新生成覆盖旧值的方式“修复”通知错误。内部任务令牌不得复用会话、用户密码、Postiz API 密钥或 Webhook 的随机部分。

环境变量修改后必须重启应用才能让内部接口读取新令牌。运行器通过现有 Next.js 的 `@next/env` 加载环境变量；显式 systemd `Environment` 优先于 `.env.local`。模板将内部 URL 指向局域网应用端口；本地手动运行时默认地址为 `http://127.0.0.1:3000/api/internal/social-notifications`。

内部 URL 仅接受 HTTP(S) 的 loopback（`localhost`、`127.0.0.0/8`、`::1`）或 RFC 1918 私有 IPv4 地址。路径必须完全等于 `/api/internal/social-notifications`，禁止用户信息、查询参数、片段和重定向；公网地址、云元数据地址及任意外部域名均被拒绝。HTTP 内网传输的安全性依赖受信任网络，跨机器不可信网络应使用私有 HTTPS，不能把内部接口暴露公网。若改变应用监听地址，须同时调整通知单元的 URL（通过 systemd drop-in）和部署预检的地址。

## 迁移与只读预检

先由数据库管理员应用 `deploy/mysql/migrations/2026-10-14-feishu-notifications.sql`（部署脚本正常流程会执行），然后从应用目录执行：

```bash
NODE_ENV=production node scripts/check-feishu-notifications.mjs
NODE_ENV=production node scripts/check-feishu-notifications.mjs --require-worker
```

预检复用应用数据库连接，只运行 `SELECT`、元数据读取和 `SHOW GRANTS`；检查三个新增表的所需列及应用账号 `SELECT/INSERT/UPDATE` 权限，不修改配置、不读取机器人凭据、不输出完整 grants。

普通预检在没有配置行或通知关闭时可以通过，并提示未启用；启用时要求标准 32 字节加密密钥及有效内部任务令牌和 URL。`--require-worker` 即使通知关闭也要求内部任务配置完整，作为允许启动 timer 的独立门槛。缺表、缺列、缺授权均须修复后再启动对应版本，不能用“通知关闭”掩盖不完整迁移。

## 管理界面设置

以管理员身份打开工作区飞书通知设置，在飞书目标群添加官方“自定义机器人”，填入机器人 Webhook。可选配置机器人签名密钥，并分别选择“草稿提交”和“正式发布”事件，再保存和启用。只支持官方 `https://open.feishu.cn/open-apis/bot/v2/hook/...` 地址。

Webhook 和签名密钥不会回显。留空表示保留已保存的凭据；清除操作必须明确选择。建议启用飞书签名校验，并确认群机器人的其他安全设置不会拦截通知。测试按钮使用**已保存**配置；测试会真实发送消息，只有得到管理员授权后才执行。页面状态和错误为脱敏诊断，不提供机器人秘密。

## 自动任务与手动执行

`deploy/polaris-notifications.service` 是 `polaris-studio` 用户的 oneshot，工作目录与应用相同，只请求本机/局域网内部 HTTP 接口，不直接连接 Postiz 或飞书。真正的数据库与上游处理由应用服务完成，因此应用沿用现有运行时代理配置，无需给通知单元添加新代理或更改其他网络服务。

`deploy/polaris-notifications.timer` 开机一分钟后开始，约每分钟触发一次；这不是“每分钟送达”的 SLA。`AccuracySec=5s` 允许触发时间偏移，状态轮询、批次限额、批间发送等待、积压和重试也会延迟送达。systemd 不会同时启动同一个仍在执行的 oneshot；应用处理函数另有数据库并发锁，手动调用与 timer 竞争时只返回安全锁状态。

应用处理函数采用 **45 秒协作式预算**，在处理步骤之间检查剩余时间，不足时推迟后续工作；这不是 SQL 执行或数据库连接等待的硬超时，不能强制中断已经开始的操作。单条机器人发送有 5 秒超时，发送批量上限 20。内部路由声明 `maxDuration=50`，但自托管 Next.js 不保证据此强制停止请求；运行器最多等待 55 秒、oneshot 最多 60 秒也只限制调用端，不会撤回应用端已经开始的处理。不能将这些期限表述为严格的服务端停止保证。

部署脚本会先停止 timer 和正在执行的任务，再停止 UI、备份单元、同步、构建和迁移；应用启动并通过健康检查后才尝试启用 timer。若任务令牌未配置，单元仅安装，timer 保持停止，不会声称通知后台已运行。健康检查成功不会提前跳过 timer 配置步骤。整个流程不会生成或覆盖 `.env.local` 密钥。

完成服务器配置并获准操作后，管理员可以执行：

```bash
cd /opt/polaris-content-studio/app
NODE_ENV=production node scripts/check-feishu-notifications.mjs --require-worker
sudo systemctl daemon-reload
sudo systemctl enable --now polaris-notifications.timer
sudo systemctl status polaris-notifications.timer
sudo journalctl -u polaris-notifications.service --since '15 minutes ago'

# 单次手动处理：会同步状态并可能真实发送通知，不是 dry-run
NODE_ENV=production node scripts/run-social-notifications.mjs

# 临时暂停后台触发；还应在管理界面关闭通知以阻止新提交的即时发送
sudo systemctl stop polaris-notifications.timer polaris-notifications.service
```

内部入口是 `POST /api/internal/social-notifications`，严格要求空请求体和独立 `Bearer` 令牌，不能通过 cookie 或用户会话代替令牌。未配置服务端令牌返回 503，错误令牌返回 401，有内容或两秒内未完成读取的请求体返回 400；不累积请求体内容。所有内部响应均设置 `Cache-Control: no-store`。调用方不能输入待确认状态、接收者或任意发送 URL。返回及运行器日志只有计数、锁状态和通用诊断，没有项目或账号身份，也不会打印完整响应或令牌。

运行器日志以 `Social notifications:` 开头，后接白名单计数与锁状态摘要。`failed > 0` 或存在通用 `warning` 时退出码为 1，即使 `failed=0` 也不能把未完成处理报为成功；仅因其他任务持锁而 `locked=true` 且无 warning 的正常跳过退出码为 0。普通预检输出 `PASS: ... Feishu notifications are not enabled.` 只表示配置关闭且数据表授权健全，不表示后台已运行。只有部署实际执行 `systemctl is-active polaris-notifications.timer` 成功后才输出 `notification timer: active`。

## 失败、重试与重复消息

提交事务同时记录审计、真实 Postiz 帖子跟踪和待投递事件。即时发送在提交响应之前等待完成，没有响应后悬空任务。机器人关闭或未产生通知事件时跳过，不制造“待发送”警告；即时发送失败则返回 `Draft submitted, but notification delivery is pending. Do not submit again.`，之后由后台重试。

同一审计及事件类型有唯一键，租约用于防止并发重复领取，草稿提交事件在正式发布事件之前处理；跨不同提交的消息不承诺全局顺序。飞书 Webhook 没有可依赖的端到端幂等确认：如果飞书已收到消息但客户端超时，或者发送成功后数据库确认失败，重试可能导致重复消息。因此实现是可靠重试加去重约束，**不保证 exactly-once**。

通知异常不应触发再次向 Postiz 提交。先检查页面状态及脱敏任务日志，再检查数据库迁移、授权、环境变量、机器人签名与网络。停用 timer 不等于关闭即时通知；要完全停止消息，需先关闭工作区飞书通知。

关闭通知或更换群机器人会影响后续配置版本检查及旧待发事件，不是对在途消息的撤回。某次投递通过版本检查并已经进入 `fetch` 后，即使随后关闭通知或更换配置，该请求仍允许完成，已到达飞书的消息无法撤回。有效配置变更取消旧通知订阅不等于取消事实跟踪：正式发布状态、链接和时间仍继续同步；未改变有效配置的空保存不升级版本、不触发取消。

## 无真实网络的开发验证

```bash
node --test scripts/test-feishu-runner.mjs
bash -n scripts/deploy-lan.sh
```

聚焦测试使用假的 `fetch`、伪数据库和测试令牌，覆盖地址限制、令牌验证、空 POST、禁止重定向、超时、响应脱敏以及只读预检，不读取真实环境变量文件，不真实发送、迁移或部署。真实 systemd 运行、MySQL 并发锁及 Postiz/飞书端到端集成均尚未验真，不能声称这些集成测试已经通过；仍需在获得授权后单独验证。

## 官方参考

- [飞书开放平台：自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)：Webhook、消息格式及签名校验。
- [Postiz 官方 API 文档](https://docs.postiz.com/public-api)：草稿提交与帖子状态查询，实际字段以已部署 Postiz 版本为准。
- [Next.js 环境变量文档](https://nextjs.org/docs/app/guides/environment-variables)：应用和 `@next/env` 的环境文件加载规则。
- [systemd.timer 官方手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)：单元触发、周期和持久化配置。`Persistent=true` 的补偿语义主要适用于 `OnCalendar`；当前单调时间 timer 不承诺补跑关机期间的每一分钟。
