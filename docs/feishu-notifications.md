# 飞书社交提交、拒审与正式发布通知

工作区飞书通知默认关闭。普通自托管的标准流程只需配置服务端 `FEISHU_ENCRYPTION_KEY`，在管理界面保存机器人 Webhook 并勾选所需通知；生产应用通过 `npm start` / `next start` 常驻运行后，内建调度默认每 60 秒检查发布状态与待重试通知，关闭浏览器也会继续执行。无需手动 runner、`--require-worker`、任务令牌或内部 URL。此检查不会代替用户在 Postiz 发布，也不承诺严格 60 秒内送达。

只有高级的外部 HTTP 调度模式才需要独立任务令牌。未配置飞书或工作区通知关闭时，普通预检不要求加密密钥或任务令牌；通知数据表及应用账号授权仍需完成迁移。本文的服务器配置和发送命令供管理员在批准部署后自行执行，实施代码不等于已部署或已真实发送。

## 行为与权限边界

- Polaris 向 Postiz 提交的仍是**草稿**，不是立即发布。草稿提交成功后可以发送一条“已提交”通知；用户在 Postiz 正式发布后，后台确认 `PUBLISHED` 才发送“已发布”通知。
- 成员只能提交给自己拥有的社交账号；管理员可以选择任意社交账号。项目始终私有，即使管理员也不能把提交关联到别人的私人项目。没有项目关联的提交仍会保留审计记录。
- 提交历史继续限定在自己的项目及自己提交的无项目记录。正式发布状态、实际链接和发布时间来自独立跟踪记录，不覆盖原始提交审计。
- 管理员保存的飞书机器人配置供**整个工作区**使用，并非每个成员一份。飞书群成员会看到通知中的提交者、社交账号、平台、内容摘要、事件时间及发布链接（如已返回）。启用前确认群成员获准接收这些数据；通知不包含账号令牌、Webhook 或签名密钥。项目关联信息保留在服务器审计与跟踪记录中。
- 只为启用相应通知后的新提交创建事件，不回填已有历史。关闭工作区通知、修改既有草稿/发布开关或有效更换凭据后，仍按原合同递增全局配置版本，取消旧版本的待发消息及旧通知订阅，不会把它们转发给新机器人；Postiz 状态事实仍照常同步。仅修改拒审开关不会升级全局版本，不影响已有正式发布通知。关闭拒审开关会在保存事务内清除已有跟踪的拒审通知订阅，并取消 `pending/sending` 的 `draft_rejected` 消息、清除其租约；重新开启不恢复积压或为旧跟踪补订阅。未改变有效配置的空保存保留版本、密文及更新时间。
- Postiz 返回成功但没有真实帖子 ID 时，仍返回 `success: true` 和 warning；不会伪造帖子 ID，这条提交无法自动跟踪正式发布。登记或通知失败也不能撤回上游草稿，所以**不要因为 warning 再次提交**。
- 正式发布链接可能暂缺。只有 Postiz 确认 `PUBLISHED` 才显示已发布；`DRAFT`、`QUEUE`、`ERROR` 不会被当作已发布。历史 `publishedAt` 优先采用 Postiz 的发布时间，否则使用首次确认时间，均以 ISO 日期返回。

## 当前 Postiz 部署合同与轮询边界

目标服务为 `https://postiz.030802.xyz/`。建议管理员将 `POSTIZ_API_URL` 配为根域 `https://postiz.030802.xyz`，`POSTIZ_UI_URL` 同样指向该浏览器可达根域；这只是配置建议，不会自动写入环境文件。沿用原有 `POSTIZ_API_KEY`，不生成、替换或打印密钥。状态查询严格使用公开 `GET /api/public/v1/posts`，`Authorization` 直接放原始 API key，**不是 `Bearer`**；本文后面的内部 worker `Bearer` 令牌是不同接口的独立鉴权。

该部署分支提供自定义 `saveAction` 字段，合法值为 `pass`、`update`、`draft`、`schedule`、`now` 或 `null`。只有 **`state === 'DRAFT' && saveAction === 'pass'`** 是“审核不通过”；`pass` 不代表通过，其他状态即使带 `pass` 也不据此判成拒审。未返回字段、未知值及 `null` 均不臆造通过/不通过结论；`PUBLISHED` 仍以真实发布状态为准。客户端只读取此合同并同步本地跟踪事实，不修改远程帖子的审核或发布状态。

本地跟踪使用 `review_status`（`unknown/pending/rejected`）、`save_action` 与 `rejected_detected_at`，独立于草稿/排队/发布/错误状态。首次发现拒审的时间是**本地首次检测时间，不是实际审核操作时间**。接口没有可信的拒绝原因、审核人字段，页面和通知不得编造这些信息。

这不是 Webhook 推送，也没有审核历史接口。公开列表按 `publishDate` 日期区间返回，查询未来窗口为 365 天；超过未来窗口的记录可能暂不可见，这不是完整历史扫描。轮询只能看到查询时刻的快照；`saveAction` 是瞬态值，若两次轮询间已变更、记录不在查询日期范围内、停机或上游故障，拒审动作可能漏检。因此不承诺完整审核历史、每次审核都可捕获或严格分钟级送达。拒审通知仅适用于启用后新提交时建立的通知订阅，扩大查询窗口不会为旧记录补订阅或补发。

## 首次服务器配置

服务器应用目录为 `/opt/polaris-content-studio/app`，应用使用此目录已有的 `.env.local`，由 `polaris-studio` 用户读取。不要把真实密钥写入仓库、systemd 单元文本或工单日志。

管理员自行运行以下命令生成加密密钥，再使用安全编辑器把输出保存到服务器 `.env.local`。命令只输出随机值，不自动创建、追加或覆盖任何环境变量文件：

```bash
# FEISHU_ENCRYPTION_KEY：标准 Base64 编码的 32 字节密钥
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

### 启用通知所需环境变量

```dotenv
FEISHU_ENCRYPTION_KEY=<上述命令生成的值>
```

占位符不能直接使用。`FEISHU_ENCRYPTION_KEY` 加密数据库里的 Webhook 和签名凭据，必须安全备份；**不要随意重置密钥**，否则已有密文不可读。轮换时须保留旧值并安排重新配置，不能以重新生成覆盖旧值的方式“修复”通知错误。保存后重启应用，再在管理界面配置 Webhook。

### 可选：内建调度开关

- `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED` 未设置时：`NODE_ENV=production` 的常驻应用默认启用内建调度，开发环境默认不启用。
- `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED=false`：关闭内建后台调度，修改后需重启应用。关闭调度不等于关闭提交时的即时通知。
- `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED=true`：开发环境显式选择启用；连接真实工作区时可能产生真实消息，不要把它当作无副作用测试。
- 构建阶段不运行调度；Vercel/serverless 不启动此常驻调度，设置 `true` 也不能提供持久任务保证。这类环境需要另行安排受保护的外部调度；现有 CLI 的私网 URL 限制不因此放宽，公网 serverless 地址不能直接交给该 CLI。

应用进程停止、机器关机或休眠期间不会运行检查；恢复后只按现有待处理记录和重试规则继续，不保证补跑停机期间每一分钟。无数据库配置时不能依靠内建调度完成通知；显式关闭调度只会停止这部分后台工作，不会补齐数据库、迁移或通知配置。

### 仅外部 HTTP 调度需要的环境变量

标准自托管流程无需以下变量；高级外部模式的配置和随机令牌生成命令见后文：

```dotenv
SOCIAL_NOTIFICATIONS_TOKEN=<独立随机任务令牌>
SOCIAL_NOTIFICATIONS_INTERNAL_URL=http://192.168.220.109:13300/api/internal/social-notifications
```

环境变量修改后必须重启应用。应用和可选运行器通过 Next.js 的 `@next/env` 加载环境变量；显式 systemd `Environment` 优先于 `.env.local`。

## 迁移与只读预检

先由数据库管理员应用原通知迁移 `deploy/mysql/migrations/2026-10-14-feishu-notifications.sql`，再应用 `deploy/mysql/migrations/2026-10-15-draft-rejection.sql`；后者逐列检查 `information_schema` 后使用 `PREPARE/EXECUTE`，支持 MySQL 8 部分执行后的重复运行。不要只依赖旧通知迁移或假定当前部署脚本已包含新迁移。新装库的 `init.sql` 已包含相同字段。迁移不修改原提交审计、不增加其 UPDATE/DELETE 授权，保留 `(publish_audit_id, event_type)` 唯一键。拒审订阅默认 `0`、审核状态默认 `unknown`，旧记录只同步事实，不补发拒审通知。然后从应用目录执行：

```bash
NODE_ENV=production node scripts/check-feishu-notifications.mjs
```

预检复用应用数据库连接，只运行 `SELECT`、元数据读取和 `SHOW GRANTS`；检查三个通知表的新旧所需列、审核/动作/事件枚举、审计与事件的完整唯一索引及应用账号 `SELECT/INSERT/UPDATE` 权限，不修改配置、不读取机器人凭据、不输出完整 grants。缺少新迁移的旧库会得到带迁移文件路径的明确安全错误，而不是继续启动通知处理。

普通预检在没有配置行或通知关闭时可以通过，并提示未启用；启用时要求标准 32 字节加密密钥，**不要求内部任务令牌或 URL**。成功提示中的 `encryption key ready; automatic scheduling starts with production application` 仅说明配置前提和生产应用默认行为，不验证调度实际运行；显式关闭调度或不支持常驻进程的环境仍适用上述限制。缺表、缺列、缺授权均须修复后再启动对应版本，不能用“通知关闭”掩盖不完整迁移。部署的 `--no-db` 只跳过备份与迁移，不跳过只读预检，不代表支持无数据库部署。

仅在主动选用外部 HTTP 调度时添加 `--require-worker`：此时即使通知关闭，也会严格校验任务令牌和内部 URL。返回的 `workerReady` 仅表示显式要求的外部 HTTP 配置已校验，不表示内建调度或外部 timer 正在运行；普通预检返回 `workerReady: false` 是预期行为。

## 管理界面设置

以管理员身份打开工作区飞书通知设置，在飞书目标群添加官方“自定义机器人”，填入机器人 Webhook。可选配置机器人签名密钥，并分别选择“草稿提交”“正式发布”和“审核不通过”（`Draft rejected`）事件，再保存和启用。拒审通知默认关闭，`notifyRejected` 在 PATCH 中可省略；旧客户端省略时保留已保存的选择，不会将其清除。只支持官方 `https://open.feishu.cn/open-apis/bot/v2/hook/...` 地址。

Webhook 和签名密钥不会回显。机器人未启用签名校验时，请保持“启用签名校验（仅在飞书机器人已启用时勾选）”关闭，只填写 Webhook，无需签名密钥。机器人已启用签名时，勾选该选项并填写密钥；已有签名密钥时留空会保留，取消勾选并保存则明确清除已保存的签名密钥。Webhook 留空会保留，清除需勾选对应选项。`FEISHU_ENCRYPTION_KEY` 是独立的服务端存储加密密钥，不是机器人签名密钥；即使不使用签名，仍需它保护数据库中的 Webhook。建议启用飞书签名校验，并确认群机器人的其他安全设置不会拦截通知。测试按钮使用**已保存**配置；测试会真实发送消息，只有得到管理员授权后才执行。页面状态和错误为脱敏诊断，不提供机器人秘密。

## 默认：由生产应用自动调度

生产应用启动后由服务端内建调度直接处理发布确认与通知重试，不通过内部 HTTP 接口，因此不需要配置 `SOCIAL_NOTIFICATIONS_TOKEN`，也不需要用户保持页面打开或手工执行任务。管理员在界面勾选“正式发布”并保存启用后，相应新提交会按现有订阅规则被后台检查；这不是自动在 Postiz 发布，也不会补发开启前的历史。

每 60 秒检查不是“每分钟送达”的 SLA。状态轮询退避、批次限额、批间发送等待、积压、数据库或网络故障和重试都会延迟送达。处理函数的数据库并发锁保护多进程及手动调用之间的竞争，但不要同时安排内建调度和旧外部 timer。

应用处理函数采用 **45 秒协作式预算**，在处理步骤之间检查剩余时间，不足时推迟后续工作；这不是 SQL 执行或数据库连接等待的硬超时，不能强制中断已经开始的操作。单条机器人发送有 5 秒超时，发送批量上限 20。内部路由声明 `maxDuration=50`，但自托管 Next.js 不保证据此强制停止请求；运行器最多等待 55 秒、oneshot 最多 60 秒也只限制调用端，不会撤回应用端已经开始的处理。不能将这些期限表述为严格的服务端停止保证。

部署脚本会先停止旧 timer 和正在执行的外部任务，再停止应用、备份单元、同步、构建和迁移；启动前运行普通通知预检，不生成令牌、不要求 `--require-worker`。应用启动并通过 UI 健康检查后执行 `systemctl disable --now polaris-notifications.timer`，防止旧 timer 在重启后恢复，默认不启用外部任务。旧单元仍可安装留作高级手动选项。日志 `notification scheduling: managed by the application; legacy timer disabled` 仅描述调度归属和旧 timer 的禁用操作，不表示已验证后台检查或真实发送成功。整个流程不会生成或覆盖 `.env.local` 密钥。

暂停所有通知应优先在工作区管理界面关闭飞书通知；停止应用也会停止该进程的后台检查，但影响整个服务。只暂停内建检查可设置 `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED=false` 后重启，提交时的即时发送仍可能发生。单独停止旧 timer 不会停止默认内建调度，也不会关闭即时通知。在途消息的限制见后文。

## 高级可选：外部 HTTP 调度与手动执行

这不是普通上线的必备步骤。只有确实需要由外部系统调度时，才先设置 `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED=false` 并重启应用，避免双重调度，再单独生成任务令牌并安全保存至应用 `.env.local`：

```bash
# SOCIAL_NOTIFICATIONS_TOKEN：至少 32 个 ASCII 非空白字符，不能复用加密密钥
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

任务令牌不得复用会话、用户密码、Postiz API 密钥或 Webhook 的随机部分。应用必须读取同一份令牌并重启，外部运行器也须获得该令牌。内部接口鉴权不因默认内建调度而放宽：不配置令牌时，只有内建直接调用可用，HTTP 入口仍拒绝调用。

`deploy/polaris-notifications.service` 是 `polaris-studio` 用户的 oneshot，工作目录与应用相同，只请求本机/局域网内部 HTTP 接口，不直接连接 Postiz 或飞书。真正的数据库与上游处理由应用服务完成，应用沿用现有运行时代理配置，无需给通知单元添加新代理或更改其他网络服务。模板 URL 指向局域网应用端口；本地手动运行器默认地址为 `http://127.0.0.1:3000/api/internal/social-notifications`。

内部 URL 仅接受 HTTP(S) 的 loopback（`localhost`、`127.0.0.0/8`、`::1`）或 RFC 1918 私有 IPv4 地址。路径必须完全等于 `/api/internal/social-notifications`，禁止用户信息、查询参数、片段和重定向；公网地址、云元数据地址及任意外部域名均被拒绝。HTTP 内网传输的安全性依赖受信任网络，跨机器不可信网络应使用私有 HTTPS，不能把内部接口暴露公网。若改变应用监听地址，须同步调整运行器 URL 和通知单元的 systemd drop-in。

`deploy/polaris-notifications.timer` 开机一分钟后开始，约每分钟触发一次，`AccuracySec=5s` 允许触发时间偏移，不提供送达 SLA。systemd 不会同时启动同一个仍在执行的 oneshot；应用处理函数另有数据库并发锁。

完成上述外部模式配置并获准操作后，管理员可安装旧单元并显式启用（部署脚本默认只安装且会禁用 timer，每次重新部署后外部模式均需重新确认）：

```bash
cd /opt/polaris-content-studio/app
NODE_ENV=production node scripts/check-feishu-notifications.mjs --require-worker
sudo install -m 644 deploy/polaris-notifications.service /etc/systemd/system/polaris-notifications.service
sudo install -m 644 deploy/polaris-notifications.timer /etc/systemd/system/polaris-notifications.timer
sudo systemctl daemon-reload
sudo systemctl enable --now polaris-notifications.timer
sudo systemctl status polaris-notifications.timer
sudo journalctl -u polaris-notifications.service --since '15 minutes ago'

# 单次手动处理：会同步状态并可能真实发送通知，不是 dry-run
NODE_ENV=production node scripts/run-social-notifications.mjs

# 仅暂停此外部调度；不能据此认定工作区已停止全部消息
sudo systemctl disable --now polaris-notifications.timer
sudo systemctl stop polaris-notifications.service
```

内部入口是 `POST /api/internal/social-notifications`，严格要求空请求体和独立 `Bearer` 令牌，不能通过 cookie 或用户会话代替令牌。未配置服务端令牌返回 503，错误令牌返回 401，有内容或两秒内未完成读取的请求体返回 400；不累积请求体内容。所有内部响应均设置 `Cache-Control: no-store`。调用方不能输入待确认状态、接收者或任意发送 URL。返回及运行器日志只有计数、锁状态和通用诊断，没有项目或账号身份，也不会打印完整响应或令牌。

运行器日志以 `Social notifications:` 开头，后接白名单计数与锁状态摘要。`failed > 0` 或存在通用 `warning` 时退出码为 1，即使 `failed=0` 也不能把未完成处理报为成功；仅因其他任务持锁而 `locked=true` 且无 warning 的正常跳过退出码为 0。普通预检输出 `PASS: ... Feishu notifications are not enabled.` 只表示配置关闭且数据表授权健全，不表示后台已运行。`--require-worker` 成功也仅表示外部配置合法，并未发送请求或验证 timer 运行。

## 失败、重试与重复消息

提交事务同时记录审计、真实 Postiz 帖子跟踪和待投递事件。即时发送在提交响应之前等待完成，没有响应后悬空任务。机器人关闭或未产生通知事件时跳过，不制造“待发送”警告；即时发送失败则返回 `Draft submitted, but notification delivery is pending. Do not submit again.`，之后由后台重试。

同一审计及事件类型有唯一键，租约用于防止并发重复领取，草稿提交事件在正式发布事件之前处理；跨不同提交的消息不承诺全局顺序。飞书 Webhook 没有可依赖的端到端幂等确认：如果飞书已收到消息但客户端超时，或者发送成功后数据库确认失败，重试可能导致重复消息。因此实现是可靠重试加去重约束，**不保证 exactly-once**。

通知异常不应触发再次向 Postiz 提交。先检查页面状态及应用的脱敏任务日志，再检查数据库迁移、授权、环境变量、机器人签名与网络。停用内建调度或旧 timer 都不等于关闭即时通知；要停止新的消息投递，需先关闭工作区飞书通知，并留意在途请求。

关闭通知或更换群机器人会影响后续配置版本检查及旧待发事件，不是对在途消息的撤回。某次投递通过检查并已经进入 `fetch` 后，即使随后关闭通知、拒审开关或更换配置，该请求仍允许完成，已到达飞书的消息无法撤回；拒审开关关闭会取消 `pending/sending` 的拒审事件并清除租约，迟到的成功确认或失败回调不能凭旧租约恢复队列，但不宣称撤回在途网络请求或已发送消息。`sent/failed` 终态及其他事件类型保持不变。有效配置变更取消旧通知订阅不等于取消事实跟踪：审核与正式发布状态、链接和时间仍继续同步；未改变有效配置的空保存不升级版本、不触发取消。

## 无真实网络的开发验证

```bash
node scripts/test-feishu-runner.mjs
node scripts/test-feishu-config.mjs
node scripts/test-postiz-status.mjs
node scripts/test-feishu-ui.mjs
bash -n scripts/deploy-lan.sh
```

聚焦测试使用假的 `fetch`、伪数据库和测试令牌，覆盖地址限制、令牌验证、空 POST、禁止重定向、超时、响应脱敏、已启用通知在无任务令牌时通过普通预检，以及显式外部模式仍严格校验令牌和 URL，不读取真实环境变量文件，不真实发送、迁移或部署。真实 systemd 运行、MySQL 并发锁及 Postiz/飞书端到端集成均尚未验真，不能声称这些集成测试已经通过；仍需在获得授权后单独验证。

## 官方参考

- [飞书开放平台：自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)：Webhook、消息格式及签名校验。
- [Postiz 官方 API 文档](https://docs.postiz.com/public-api)：草稿提交与帖子状态查询，实际字段以已部署 Postiz 版本为准。
- [Next.js 环境变量文档](https://nextjs.org/docs/app/guides/environment-variables)：应用和 `@next/env` 的环境文件加载规则。
- [systemd.timer 官方手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)：单元触发、周期和持久化配置。`Persistent=true` 的补偿语义主要适用于 `OnCalendar`；当前单调时间 timer 不承诺补跑关机期间的每一分钟。
