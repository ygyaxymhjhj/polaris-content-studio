# 内网测试部署

- 地址：http://192.168.220.109:13300
- 系统：Ubuntu 24.04 / Node 20.19.5
- 应用目录：`/opt/polaris-content-studio/app`（`DEPLOYED_COMMIT` 记录已部署提交的完整 SHA）
- 运行账号：`polaris-studio`（非 root）
- 服务：`polaris-studio.service`，开机启动，失败自动重启
- 服务配置模板：`deploy/polaris-studio.service`
- 运行时集成文件：`/opt/polaris-content-studio/runtime/openrouter-proxy.cjs` 与 systemd drop-in `40-openrouter-proxy.conf`，均由部署脚本从仓库 `deploy/` 安装，**不要手工改服务器上的这两处**
- 监听：192.168.220.109:13300；新增 UFW 规则仅允许 192.168.0.0/16 到此端口；没有修改现有网站或代理
- AI 配置：应用目录 `.env.local`，权限 600
- `ARTICLE_CRAWLER_LOCAL_BROWSER=false`；需验证码的网页请粘贴/上传

## 一键部署（从开发机）

前置：本机 `~/.ssh/config` 已配置别名 `polaris-server`（密钥 `~/.ssh/id_ed25519_polaris`，免密）。日常部署：

```sh
bash scripts/deploy-lan.sh          # 等价：npm run deploy:lan
```

脚本流程：停服 → 备份（`.env.local`、runtime、服务配置、源码打包、数据库 dump）→ rsync 同步（默认部署 **HEAD 提交**，排除 `.env.local`/`node_modules`/`.next`/`.git` 等）→ 安装运行时文件 → 以 polaris-studio 用户 `npm ci && npm run build` → 写入 `DEPLOYED_COMMIT` → 启动并健康检查。

常用参数：

- `--worktree`：连同工作区未提交改动一起部署（默认不部署未提交内容）
- `--ref <commit>`：部署指定提交（回滚即部署旧提交）
- `--dry-run`：只预览 rsync 变更，不做任何修改
- `--no-db`：跳过数据库备份
- 不支持 `--no-build`：部署必须重新构建生产产物，该参数会在停服、同步前被拒绝。旧 `.next` 即使连接已迁移数据库，也可能仍执行旧的无权限代码。

手动兜底步骤（脚本不可用时）：停服 → 同步代码（排除 `.env.local`、`node_modules`、`.next`、`.git`）→ 以 polaris-studio 用户执行 `npm ci`、`npm run build` → 启动服务。不要上传开发机的 node_modules 或 .next。

## 账号与登录

应用不再匿名开放：未登录访问 `/` 会 307 跳转到 `/login`，九个 API 路由全部返回 401。

**全新环境**：`init.sql` 仅在新数据卷上自动执行。初始化表和授权后，必须显式创建管理员；普通账号不能管理成员：

```sh
# 1. 初始化 schema 和应用账号权限（容器内已有 MYSQL_ROOT_PASSWORD）
docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' \
  < /opt/polaris-content-studio/app/deploy/mysql/init.sql

# 2. 创建首个管理员；密码隐藏输入，之后在「设置 → 成员」中创建普通账号
cd /opt/polaris-content-studio/app
node scripts/create-user.mjs --admin admin "Administrator"
node scripts/check-user-roles.mjs
```

不带 `--admin` 的初始化命令创建普通成员；网页添加成员始终创建普通成员，不会按用户名提权。已有 `admin` 账号不需要重建或重置密码。

**已有环境升级角色权限**：先停服并备份，将迁移文件同步到服务器后，使用有 DDL 权限的数据库管理员执行以下迁移，再启动新代码。应用数据库账号没有 ALTER 权限，不应扩权。重跑 `CREATE TABLE IF NOT EXISTS` 的 `init.sql` **不会**给旧表补 `role` 列。

```sh
docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' \
  < /opt/polaris-content-studio/app/deploy/mysql/migrations/2026-10-08-user-roles.sql
cd /opt/polaris-content-studio/app
node scripts/check-user-roles.mjs
```

迁移仅将既有用户名 `admin` 设为管理员，其余账号默认为普通成员，保留用户 ID、密码、会话和项目归属。预检必须确认 `users.role` 存在且 `admin` 是启用的管理员，否则不能启动新版本。部署脚本强制重新构建，并在启动前执行此预检，但不代替管理员执行迁移。权限升级不能通过跳过构建复用旧 `.next`。

健康检查探测的是 **`/login`**（未登录时返回 200）；`/` 现在返回 307，不能用它做健康检查。匿名 `/login` 的 200 不代表数据库角色升级成功，角色验收必须通过上述预检并分别验证管理员和普通成员的实际权限。

**残余风险**：内网是纯 HTTP，密码在局域网内**明文传输**，同网段嗅探可截获（UFW 已限制到 `192.168.0.0/16`，但不足以消除该风险）。彻底解决需在前面加一层 TLS 反向代理（如 Caddy）。另外登录不限制单账号消耗共享 AI 额度的速度。

## 网络与代理

- 服务器**直连部分海外站点**（含 wikifxtips.com 的 CDN）会在 TLS 握手阶段被重置，相关流量需经服务器本机 v2rayA 代理 `127.0.0.1:20171` 出网。
- `runtime/openrouter-proxy.cjs` 经 `NODE_OPTIONS` 注入，把 `openrouter.ai` 与 WikiFX 系域名（`wikifx.com`、`wikifxtips.com`）的 fetch 请求路由到该代理，其他域名不受影响。
- 文章抓取对阿里云 WAF 挑战（`acw_sc__v2`）已有自动求解与 cookie 缓存（`src/lib/acw-challenge.ts`）。

## 验收状态

未登录访问 `/login` 返回 HTTP 200，访问 `/` 返回 307；中越英切换、语言偏好保存、文章配置对齐的浏览器回归已通过。生产构建成功。AI 调用经代理出网（journal 可见成功的计费调用）。

## 运维

```sh
systemctl status polaris-studio
journalctl -u polaris-studio -n 100 --no-pager
systemctl restart polaris-studio
# 停用（不会影响其他服务）
systemctl disable --now polaris-studio
```

回滚：`bash scripts/deploy-lan.sh --ref <旧提交>`；备份目录 `/opt/polaris-content-studio/backup-YYYYMMDD-HHMMSS-<short-sha>/`。

数据库为服务器上的独立 Docker 实例（`polaris-mysql`，见 `deploy/mysql/`）；同事共用服务端 AI 额度，不开放公网。
