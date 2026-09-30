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
- `--no-build` / `--no-db`：跳过构建 / 跳过数据库备份

手动兜底步骤（脚本不可用时）：停服 → 同步代码（排除 `.env.local`、`node_modules`、`.next`、`.git`）→ 以 polaris-studio 用户执行 `npm ci`、`npm run build` → 启动服务。不要上传开发机的 node_modules 或 .next。

## 网络与代理

- 服务器**直连部分海外站点**（含 wikifxtips.com 的 CDN）会在 TLS 握手阶段被重置，相关流量需经服务器本机 v2rayA 代理 `127.0.0.1:20171` 出网。
- `runtime/openrouter-proxy.cjs` 经 `NODE_OPTIONS` 注入，把 `openrouter.ai` 与 WikiFX 系域名（`wikifx.com`、`wikifxtips.com`）的 fetch 请求路由到该代理，其他域名不受影响。
- 文章抓取对阿里云 WAF 挑战（`acw_sc__v2`）已有自动求解与 cookie 缓存（`src/lib/acw-challenge.ts`）。

## 验收状态

页面 HTTP 200；中越英切换、语言偏好保存、文章配置对齐的浏览器回归已通过。生产构建成功。AI 调用经代理出网（journal 可见成功的计费调用）。

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
