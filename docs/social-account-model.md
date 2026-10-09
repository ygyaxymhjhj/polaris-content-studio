# 社媒账号授权与分配模型

## 1. 决策：个人归属 + 管理员分配

社媒账号归属到个人，访问由服务端强制校验（本次已确认的规则）：

- 成员默认只能查看、只能发布到自己**授权**或**管理员分配**的账号；其他成员的账号不可见、不可用（服务端强制，不只是界面过滤）。
- 管理员可查看、分配、使用工作区内全部账号；可把存量账号分配/改派/收回给任意成员。
- **不对 Postiz 做任何修改**。Postiz 里已授权的存量账号不动，进入「未分配」池（仅管理员可见），由管理员分配给成员。
- 成员新授权完成的账号自动归属发起成员（快照 + 差异认领，见第 3 节），无需 Postiz 回调。

为什么不沿用共享池：出现「部分账号不能让所有人发」的需求后，团队共享池无法表达账号级访问。风控仍靠「服务端校验 + 分配留痕 + 发布审计」实现，账号归属只是可见性与发布权的边界，token 依旧由 Postiz 统一管理。

## 2. 授权网关：Postiz

各平台 OAuth、token 加密存储与自动刷新全部由自托管 Postiz 承担，Polaris 不自研 OAuth。

- 独立入口：侧栏「社媒账号」展示账号列表、可用状态、刷新时间；「添加社媒账号」打开独立的平台选择界面。设置页和发布弹窗也保留入口。
- 直连授权参考 `social-autopub` 的白标流程：登录成员选择平台 → `POST /api/social/connect` → 服务端用 HS256 JWT 调用 Postiz `/api/enterprise/url` → 新窗口打开平台官方授权页面 → Postiz 保存账号与令牌 → 返回 Polaris，刷新账号列表。支持 Facebook、Instagram、X、Threads、LinkedIn，前提是对应平台应用已在 Postiz 中正确配置。
- 必须配置服务端 `POSTIZ_JWT_SECRET`，其值与自托管 Postiz 实例的 `JWT_SECRET` 一致。API Key 和签名 JWT 不返回浏览器；签名有效期 10 分钟。该密钥具有敏感权限，不要提供给浏览器、普通用户或提交到 Git。
- Polaris 的返回状态使用 10 分钟有效的 HttpOnly / SameSite=Lax Cookie，绑定当前登录用户；过期、缺失或换账号后的返回不会视为有效。授权发生在新窗口，原工作区与未保存草稿保持打开。新窗口返回、关闭后会刷新；直接在 Postiz 中连接后可点「刷新账号」。
- 本地只登记**归属**（`social_accounts`），账号本体与 token 仍完全由 Postiz 管理；列表接口始终以 Postiz 实时数据为准，登记表只做归属装饰，绝不单独用登记表出数据。
- 返回授权流程并不等于所有平台步骤都完成。Facebook 等平台可能还需要在 Postiz 中选主页；以刷新后的账号是否出现及状态为准，不用 URL 上的标记伪造连接成功。
- 降级入口「改用 Postiz 连接」打开 `POSTIZ_UI_URL`，**仅管理员可见**：Postiz 界面本身无法按成员隔离，普通成员不应持有 Postiz 登录。
- 外部所有者（品牌方、KOL）可用 Postiz 的 invite link 自行授权，渠道落入团队组织，全程不接触团队密码，也不占席位。

## 3. 归属登记与自动认领

两张本地表（见 `deploy/mysql/init.sql` 与 `deploy/mysql/migrations/2026-10-08-social-account-ownership.sql`）：

- `social_accounts`：`integration_id` 主键、`provider`/`account_name` 快照、`owner_user_id`（NULL = 未分配，仅管理员可见）、`assigned_by_user_id`、`origin ENUM('connect','admin')`。
- `social_connect_attempts`：`state_hash` 主键（= 连接 Cookie 值 `sha256(userId:state)`）、`user_id`、`provider`、`snapshot_ids JSON`、`expires_at`、`consumed_at`。

自动认领机制（新账号归属发起人，无需 Postiz 回调）：

1. 发起授权时（`POST /api/social/connect`）先取当前 Postiz 账号 id 快照，连同 `provider` 写入 attempt 行（10 分钟有效，与 Cookie 一致；快照失败记 NULL）。
2. 授权完成返回时（`GET /api/social/connect`）校验 Cookie/state 后原子消费 attempt（重复返回或过期一律不再认领），再取实时列表与快照做差集：只认领「快照后新增 + 平台匹配 + 未占用」的账号，条件 upsert 保证**先返回者优先**、已归属不覆盖。
3. 任何一步失败（Postiz 不可达、数据库异常）只记录日志，不影响返回跳转；账号落「未分配」，由管理员分配。

访问与发布规则（服务端强制）：

- `GET /api/social/channels`：实时列表 + 归属装饰；成员只返回 `ownerUserId === 自己` 的账号，管理员返回全部并带 `ownerName`。Postiz 报错时返回空列表 + 错误，不回落登记表。
- `POST /api/social/publish`：调用 Postiz 前校验归属——成员发他人或未分配账号（含登记表无此行）返回 403，且不写审计、不调用 Postiz；管理员放行。
- `PATCH /api/social/accounts/:id`（管理员 + 同源校验）：`{ ownerUserId: uuid | null }` 分配/收回；账号不在登记表时 404，成员一律 403。

存量账号处理：升级后 Postiz 里已有的账号（如 Distant）首次出现在列表时登记为「未分配」，仅管理员可见；管理员在账号页的分配下拉里指派给成员后，该成员即可查看与发布。

发布审计（`social_publishes`）：**保持全员可见**。审计回答「谁、何时、把哪条内容发到了哪个账号」，按素材/项目查询，本身落在各人的项目范围内，不在本次收紧。

边界与已知限制：

- 同一时刻两人授权同一平台：先返回者认领成功，另一个账号落「未分配」，管理员改派（不改 Postiz 无法完全消除，先返回者优先是安全降级）。
- 直接在 Postiz UI 连接的账号：进「未分配」池，由管理员分配。
- 授权超过 10 分钟才返回：Cookie 过期 → 不认领（与现有语义一致），账号落「未分配」。
- 成员账号 token 失效后的重连由管理员在 Postiz 处理（后续可选做 refreshId 自助重连，不在本期）。

## 4. 成熟系统对照

### 4.1 新账号连接（授权流程）

标准 OAuth 重定向骨架：服务端生成带 `state` 的授权 URL → 平台授权页 → 回调校验 `state` 换 token → （平台有多个目标时）「继续集成」步骤选择具体 Page/公司页/频道 → token 加密落库 → 发布前自动刷新，失效标记「需重连」。

Postiz 按平台自动选择四类连接方式：OAuth 重定向（大多数平台）、凭证表单（Bluesky/WordPress 等填 app password）、应用内对话框（Telegram）、浏览器扩展（无公开 API 的平台）。

邀请链接模式：账号所有者不是团队成员时（客户、品牌方），生成 invite link 由对方在平台自己的授权页完成连接，渠道落入组织；只覆盖能干净重定向的平台。

### 4.2 权限分配：两层模型

所有成熟系统都是「组织级角色 + 账号级访问级别」两层：

| 系统 | 组织角色 | 账号级访问级别 | 谁能连接新账号 |
|---|---|---|---|
| Buffer | Owner / Admin | Full Access / Needs Approval / No Access（逐频道） | 仅 Admin/Owner |
| Hootsuite | Super Admin / Admin / 自定义 | 每账号每成员单独配（Editor/Limited/自定义） | Admin 或持 Connect 权限者 |
| Later | Account Owner | Reviewer / Member / Member-Restricted，挂在 Access Group 上 | Owner/Admin |
| SocialBee | Owner / Manager / Publisher / Contributor | 随角色（Publisher 可发，Contributor 只能写） | Manager 及以上 |
| Sprout | 公司权限开关组 | 六档：No Access → Read Only → Needs Approval → Reply Only → Reply+React+Repost → Full Publishing，另有多层审批工作流 | 持 Manage Profiles 权限者 |
| Mixpost | Admin / Member / Viewer | 审批权单独授予（与角色分离） | 平台管理员 |
| Postiz | Super Admin / Admin / User | 无账号级权限；customer groups 仅视图过滤 | 任意成员（或 invite link） |

共性设计要点：

1. **连接 ≠ 访问权**。Buffer：「Admin access does not automatically include channel access」——连接是管理动作，访问是分配动作。
2. **审批是一种权限级别**，不是独立工作流：Buffer 的 Needs Approval、Later 的 Publish Without Approval 开关、SocialBee 的 Contributor。多层审批流（Sprout）只在企业合规场景需要。
3. **分组是权限的载体**：Later Access Groups、Hootsuite Teams、Sprout Groups——账号一多按组分配，不逐账号点。
4. **所有者保护**：Owner 永远 Full Access 且不可降级。
5. **内容归组织、操作留审计**：Postiz「成员移除后其创建的 posts 和 channels 留在组织」；Buffer「队列里能看到每条 post 是谁创建的」。

本项目当前实现的是两层模型的第一层（组织角色 admin/member）+ 最简账号级访问（owner 一人可见可用 + 管理员全量）。`social_accounts.owner_user_id` 单列即「每用户 × 每账号一格」的当前形态，向「多档访问级别 / 分组」扩展时只需给该表加列或加关联表。

## 5. 升级路径与触发条件

| 触发条件 | 升级项 | 参考对象 |
|---|---|---|
| 账号多 / 多品牌，需要过滤视图 | 账号分组过滤 | Later Access Groups / Postiz customer groups（只过滤不设权限） |
| 一个账号需要多人协作（编辑+发布） | 多档账号级权限 | Buffer 三档（Full / Needs Approval / No Access），每用户 × 每账号一格 |
| 需要「成员发起、管理员批准」 | 发布审批流 | 先做 Buffer/Later 式「审批作为权限级别」；Sprout 多层工作流留到确有多级合规需求 |
| 品牌方 / 合规要看稿 | 外部审稿 | Postiz preview links（外部人无账号可评论，不阻塞发布） |
| 成员账号失效需自助重连 | refreshId 重连流程 | Postiz `/enterprise/url` 的 `refreshId` 参数（本期未实现） |

## 6. 运维

- **已有 MySQL 卷**：以管理员手动执行本次迁移（文件头部有 docker exec 命令；幂等，可重复执行）：
  ```bash
  docker exec -i polaris-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' \
    < deploy/mysql/migrations/2026-10-08-social-account-ownership.sql
  ```
  **新卷**由 `deploy/mysql/init.sql` 自动建表，无需迁移。早前的 `2026-10-08-social-publishes.sql`、`2026-10-08-user-roles.sql` 同理。
- 服务器 `.env.local` 配置 `POSTIZ_UI_URL` 为浏览器可达地址（如 `http://192.168.220.109:5000`）；服务端调 Postiz API 仍走 `POSTIZ_API_URL`（可为 localhost），两者可以不同。
- `POSTIZ_API_URL` 可填根地址、`/api` 或 `/api/public/v1`；项目统一规范化为 `/api` 后再拼接接口路径。直连授权新增 `POSTIZ_JWT_SECRET` 后需要重启应用；不要把它改成 `NEXT_PUBLIC_` 变量。
- 平台 OAuth 的开发者应用回调仍是 Postiz 的 `{POSTIZ_UI_URL}/integrations/social/{provider}`，不是 Polaris 的返回接口。Polaris 返回地址由当前访问域名生成，请从同一个域名发起并完成流程。
- **不要把 Postiz 登录给普通成员**：Postiz 界面本身无法按成员隔离渠道；Polaris 内的「打开 Postiz / 改用 Postiz 连接 / 在 Postiz 中重连」入口已只对管理员展示。
- 无真实平台凭证的回归：`node scripts/test-postiz-connect.mjs`（签名、密钥保护、匿名拦截、跨站拒绝、用户绑定的 state、成员隐藏 Postiz 入口）、`node scripts/test-user-roles.mjs`、`node scripts/test-social-ownership.mjs`（列表过滤、发布 403、认领规则、分配 API、返回容错）。真实 OAuth 与浏览器回归（`node scripts/test-auth.mjs`，需 `TEST_BASE_URL` 指向本地服务）仍需运维配置匹配的 JWT secret 与各平台应用后人工验收。
- Token 失效的账号在 Postiz 侧显示红色感叹号（需重连），发布失败会留 `failed` 审计行并在弹窗记录中显示错误；重连由管理员处理。
