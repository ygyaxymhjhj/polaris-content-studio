# 社媒账号授权与分配模型

## 1. 决策：团队共享账号池

社媒账号是团队资产，不归授权人个人：任何成员都可以发起授权、从共享池中选择账号发布。

理由（公司官方号场景）：

- 授权人休假或离职不能阻断全团队发布，账号也不能散落个人名下。
- 内容是流水线协作（运营写、审核批、可能第三人发布），私有化会切断流程。
- 风控靠「角色 + 权限 + 审批 + 审计」实现，而不是靠账号私有化。

「自己授权的账号归自己」只适用于单用户个人版产品。所有成熟的团队级社媒工具（Buffer、Hootsuite、Later、SocialBee、Sprout Social、Mixpost、Postiz）都是组织拥有账号。

## 2. 授权网关：Postiz

各平台 OAuth、token 加密存储与自动刷新全部由自托管 Postiz 承担，Polaris 不自研 OAuth。

- 连接入口：发布弹窗的「连接新账号」按钮打开 `POSTIZ_UI_URL`（未配置时从 `POSTIZ_API_URL` 去掉 `/api` 后缀推导）。授权完成后点「刷新账号」即可看到新渠道；发布弹窗打开时也会自动刷新一次。
- 连接渠道需要 Postiz 侧登录账号：给成员各开一个 Postiz User，或由管理员统一连接。
- 外部所有者（品牌方、KOL）可用 Postiz 的 invite link 自行授权，渠道落入团队组织，全程不接触团队密码，也不占席位。

## 3. 发布审计

`social_publishes` 表，每次发布尝试一行（成功与失败都留痕）：

| 字段 | 说明 |
|---|---|
| `project_id` / `asset_id` | 关联内容项目与素材（发布请求携带，`project_id` 可空） |
| `platform` / `integration_id` / `account_name` | 目标平台与账号（账号名为发布时快照） |
| `published_by` / `published_by_name` | 发布人（id + 显示名快照） |
| `content_preview` | 正文前 200 字符 |
| `postiz_post_id` / `published_url` | Postiz 返回的 post 标识与链接 |
| `scheduled_at` | 定时发布时间（立即发布为 NULL，UTC DATETIME(3)） |
| `status` / `error` | `published` / `failed` 与失败原因 |

要点：

- **append-only**：`polaris_app` 对该表仅有 SELECT、INSERT 权限，应用侧 bug 或会话泄漏不能改写历史。
- **审计不改变发布结果**：写审计失败只记 `console.error`——内容已发出，无法回滚，不能把审计失败伪装成发布失败。
- **全员可见**：`GET /api/social/publishes?assetId=…`（或 `projectId=…`，limit 50）对所有登录成员开放；共享池模型下「谁、何时、把哪条内容发到了哪个账号」是团队公共事实。
- 发布弹窗底部展示该素材的发布记录（时间、账号、发布人、状态、链接、错误）。

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

参考实现层数据模型（未来扩展时）：

```sql
workspaces (id, name)
workspace_members (workspace_id, user_id, role)
social_accounts (id, workspace_id, platform, status, tokens)
account_access (user_id, account_id, level)
publish_log (workspace_id, account_id, user_id, post_id)
```

## 5. 升级路径与触发条件（本期均未实现）

| 触发条件 | 升级项 | 参考对象 |
|---|---|---|
| 账号多 / 多品牌，需要过滤视图 | 账号分组过滤 | Later Access Groups / Postiz customer groups（只过滤不设权限） |
| 出现「部分账号不能让所有人发」 | 账号级权限 | Buffer 三档（Full / Needs Approval / No Access），每用户 × 每账号一格 |
| 需要「成员发起、管理员批准」 | 发布审批流 | 先做 Buffer/Later 式「审批作为权限级别」；Sprout 多层工作流留到确有多级合规需求 |
| 品牌方 / 合规要看稿 | 外部审稿 | Postiz preview links（外部人无账号可评论，不阻塞发布） |

## 6. 运维

- **已有 MySQL 卷**：以管理员手动执行 `deploy/mysql/migrations/2026-10-08-social-publishes.sql`（文件头部有 docker exec 命令；幂等，可重复执行）。**新卷**由 `deploy/mysql/init.sql` 自动建表，无需迁移。
- 服务器 `.env.local` 配置 `POSTIZ_UI_URL` 为浏览器可达地址（如 `http://192.168.220.109:5000`）；服务端调 Postiz API 仍走 `POSTIZ_API_URL`（可为 localhost），两者可以不同。
- Token 失效的账号在 Postiz 侧显示红色感叹号（需重连），发布失败会留 `failed` 审计行并在弹窗记录中显示错误。
