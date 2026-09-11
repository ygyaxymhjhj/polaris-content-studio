# 内网测试部署

- 地址：http://192.168.220.109:13300
- 系统：Ubuntu 24.04 / Node 20.19.5
- 应用目录：`/opt/polaris-content-studio/app`
- 运行账号：`polaris-studio`（非 root）
- 服务：`polaris-studio.service`，开机启动，失败自动重启
- 服务配置模板：`deploy/polaris-studio.service`
- 监听：192.168.220.109:13300；新增 UFW 规则仅允许 192.168.0.0/16 到此端口；没有修改现有网站或代理
- AI 配置：应用目录 `.env.local`，权限 600；未保存 SSH 凭据到项目
- `ARTICLE_CRAWLER_LOCAL_BROWSER=false`；需验证码的网页请粘贴/上传

## 验收状态

页面 HTTP 200；中越英切换、语言偏好保存、文章配置对齐的浏览器回归已通过。生产构建成功。

**AI 联调尚未通过**：服务器调用当前 OpenRouter 模型返回 HTTP 403：`This model is not available in your region.` 不是密钥未传输，也不是前端故障。需要选择在服务器地区可用的模型/供应商后再次验证分析和生成。未通过改变出口来规避供应商地区限制。

## 运维

```sh
systemctl status polaris-studio
journalctl -u polaris-studio -n 100 --no-pager
systemctl restart polaris-studio
# 停用（不会影响其他服务）
systemctl disable --now polaris-studio
```

更新前停止该服务（避免构建覆盖运行缓存），同步代码时排除 `.env.local`、`node_modules`、`.next`、`.git`。在服务器以 polaris-studio 用户执行 `npm ci`、`npm run build`，再启动服务。不要上传开发机的 node_modules 或 .next。

当前无登录与持久化存储，刷新丢失编辑状态；同事共用服务端 AI 额度，不开放公网。
