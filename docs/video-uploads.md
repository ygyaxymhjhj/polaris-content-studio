# 单个 MP4 上传与媒体引用

## 状态与上线门槛

本阶段只做本地实现与隔离测试，**没有访问实际 Postiz、数据库或服务器，也未证明当前部署支持视频**。上线前必须用测试账号验收实际 Postiz 版本、100 MiB 上传、五个平台及实际 provider alias 的草稿、浏览器播放/拖动、重启后媒体持久化、存储备份与容量。只创建草稿，不执行正式发布。

## HTTP 契约

`POST /api/media/uploads` 使用登录会话和现有 same-origin 检查。请求体直接发送原始 `File` 字节，不是 multipart，也不是 JSON/base64。

- `Content-Type: video/mp4`
- `X-Upload-Request-Id: <UUID>`：同一个文件重试沿用；换文件使用新 UUID。
- `X-File-Name: encodeURIComponent(file.name)`：MP4 扩展名，最长 255 个 UTF-16 码元，不允许控制字符和目录分隔符。
- 原文件非空，最大 `100 * 1024 * 1024` 字节。`Content-Length` 可省略；有值时用于提前拒绝和检测截断，最终以实际流读取字节数为准。

仅在上游上传成功且本地不可变记录写入成功后返回 `201 { video }`。同 owner 已成功 request ID 的文件 SHA-256 相同则返回 `200 { video }`，不会再次上传或创建草稿；不同则 `409 REQUEST_ID_CONFLICT`。回放仍需读完整个请求体来核对 SHA-256，不信任客户端声称的 hash。不同 owner 的相同 request ID 互不影响。

`video` 严格投影为 `{ id, name, bytes, width, height, durationSeconds }`；不包含 Postiz ID/path、owner、checksum、密钥或临时路径。错误统一为 `{ error, code }`，包括 401、403、400、413、415、429、503、上游 502；连接取消的内部响应为 `499 UPLOAD_CANCELLED`，客户端可能收不到它。错误不会转发上游响应正文。

`GET /api/media/uploads/<UUID>` 校验登录和精确 owner（管理员也不绕过），返回 `Cache-Control: no-store` 的 307 到登记过且通过信任来源检查的 Postiz 媒体 URL。不接受客户端指定 path，不由 Polaris 代理下载视频，不附加 API key。无权限和不存在都返回 404。

**预览鉴权不代表上游媒体私有。** 浏览器在 307 后直接访问上游，公开媒体 URL 的持有者仍可能直接播放。要求真正私有播放时需另行设计上游私有存储/签名访问，不能靠本接口掩盖 URL。

## 存储与后端对接

管理员执行 `deploy/mysql/migrations/2026-10-22-video-uploads.sql`。新卷使用 `deploy/mysql/init.sql`；迁移可重复执行，`posts.video_media_id` 通过 information_schema + PREPARE 独立判断后添加。应用只获得 `video_uploads` 的 SELECT、INSERT 权限；没有 pending、lease、unknown 或新上传队列。

- `src/lib/video-types.ts` 是 client-safe 模块，导出 `MAX_VIDEO_UPLOAD_BYTES`、`VideoAttachment`、`getVideoPreviewUrl(id)`、`isVideoMediaId`、`isVideoAttachment`、`isVideoUploadResponse`。
- `getVideoUpload(ownerUserId, mediaId, connection?)` 返回 `StoredVideoUpload | null`；其额外字段是 `postizMediaId`、`postizPath`、`ownerUserId`。
- `ownsVideoUploads(ownerUserId, mediaIds, connection?)` 用一次 owner + IN SELECT 核对去重后的所有 ID。可传现有事务连接，不引入新事务/任务队列。
- AI 保存与手动保存按 owner 验证本地 ID；worker 从已冻结的 ID 重新取得 server-trusted `{ id: postizMediaId, path: postizPath }`，传给 `createStrictDraft({ ..., uploadedMedia })`。`uploadedMedia` 与 `imageUrl` 同时存在会明确拒绝，不静默选择。
- 视频引用直接复用原 `posts[].value[].image` 数组，不再下载/上传媒体。`type` 永远是 `draft`；网络失败仍标记 uncertain。Instagram standalone 保留 `__type: instagram-standalone` 并带 `post_type: post`；LinkedIn page 保留实际 `__type: linkedin-page`，不构造 reel 字段。正常图片保留 multipart 上传及原始字节，补强真实格式与资源边界校验。

## 资源与验证边界

共享 Postiz 图片上传分支只接受 sharp 实际识别并可解码的单帧 JPEG/PNG/WebP，不能把 MP4 URL 或伪装的 image MIME 当成图片上传。远端响应逐块读取、实际限 30 MiB（不信 Content-Length）；data URL 先检查编码长度再分配 Buffer。解码器上限 4000 万像素，以 1px raw probe 强制解码；原始图片字节不重编码，上传 MIME/扩展名由实际格式决定。文章原图不受编辑器的 1.5 MB / 2048px 限制。图片验证/上传失败时 strict 和 legacy 草稿入口均拒绝创建草稿，不悄悄退化为无附件稿；已登记视频仍直接复用引用，不走此图片下载路径。

请求按 chunk 写入系统临时目录的随机 `polaris-video-XXXXXX/video.mp4`（目录 0700，文件 0600），同时计算 SHA-256，不将 100 MiB 读成整块 Buffer。读取阶段限 5 分钟；ffprobe 限 15 秒、stdout/stderr 各 64 KiB、单次分配 64 MiB、单线程；上游 multipart 限 3 分钟。`openAsBlob` 从磁盘流式构造原生 FormData，明确 `adjust=false`，不依赖 Postiz 转码。

首版只接受可识别的 MP4 品牌（isom/iso2-9/mp41/mp42/avc1/dash）、一个 H.264 视频流和可选 AAC 音轨；宽高与时长必须有效。强制 mov demuxer、仅允许 file 协议、禁用 dref/绝对外部引用，不处理网络播放列表。不进行整片解码/转码，不保证检测所有比特流损伤，不把其他平台的时长/尺寸矩阵生搬为通用硬限制；实际 provider 兼容性仍是上线验收项。

单进程最多 2 个上传、每 owner 最多 1 个，范围含流读取、验证、上游上传、本地登记与清理。多实例会放大此上限；加副本前需重新评估协调与磁盘容量，不承诺跨实例限流。取消后等待上游调用和 ffprobe 进程完全 settle/close，再 finally 清理文件并释放额度；不使用 Promise.race 提前删除仍在读取的文件。

上传接口自己的预检、登记各通过 `withVideoUploadConnection` 单独取得连接，池等待和短 SQL 合计最多 5 秒；不跨文件处理或上游网络持有连接。取消/到时销毁已取得的连接，不把仍运行 SQL 的 socket 放回池；迟到取得的连接立即 release 且不执行 SQL。SQL 另外使用 mysql2 真实支持的 `execute({ sql, timeout: 5000 }, values)` inactivity timeout；外层截止也覆盖 acquire 和 prepared-statement 准备阶段。数据库连接销毁不等于 INSERT 未提交，仍可能发生已有记录但客户端未获确认的失败窗口。共享 project-db、worker 事务及 `getVideoUpload` / `ownsVideoUploads` 连接注入契约不变。

Node 20 的 execFile signal 中止可能先发 SIGTERM 并清除内部 timeout；收到中止回调后显式对 ffprobe 再发 SIGKILL，随后等待 close，避免忽略 SIGTERM 的进程长期占用额度。

每进程第一次上传会做一次有界残留清理：最多检查临时根目录前 200 个条目、删除 20 个匹配专用目录名且超过 24 小时的目录。不保证扫到所有残留；进程崩溃、权限/磁盘错误可能留下文件，运维仍需在停服后核对清理和容量。systemd `PrivateTmp=true` 提供服务私有的临时命名空间，不能假设开发机路径就是服务器路径。

跨系统没有原子事务：上游保存成功但本地 INSERT/回包失败、客户端取消或多实例竞争可能留下孤儿/重复媒体。首版接受这个失败窗口，允许重新上传，不承诺媒体 exactly-once、不回滚上游、不自动删除媒体。删除附件只是解绑；副本、archive、排队/unknown 草稿仍可能引用原媒体。人工清理 Postiz 前必须核对引用和备份。

## 运行环境

部署文档当前 Node 为 **20.19.5**，该版本提供原生 `node:fs.openAsBlob`、FormData、AbortSignal.any。开发机的 Node 22 隔离测试不能替代服务器 Node 20.19.5 的真实流式上传/中止验收。

在 Ubuntu 24.04 安装发行版 `ffmpeg` 软件包（其中包含 ffprobe），以服务用户确认二进制可执行且版本及时更新。默认从服务 PATH 查找 `ffprobe`；可用服务环境变量 `FFPROBE_PATH=/usr/bin/ffprobe` 指定绝对路径。缺失时接口安全返回 `503 FFPROBE_UNAVAILABLE`，提示安装或设置变量，不返回磁盘路径。开发机可设 `FFPROBE_PATH=/opt/homebrew/bin/ffprobe`。

媒体 URL 默认只信任 `POSTIZ_API_URL` 和 `POSTIZ_UI_URL` 的 origin，以及官方文档响应示例的 `https://uploads.postiz.com`。若实际存储使用独立 CDN，设置 `POSTIZ_MEDIA_ORIGINS=https://media.example.com,https://postiz.example.com`；显式列表**替换**默认值，仅支持精确 http(s) origin，不允许凭据、路径、查询和通配符。它只约束登记/预览的目标 URL，不保证该 URL 以后不由上游重定向至其他来源。

已有 systemd `PrivateTmp=true`、`ProtectSystem=strict`、`UMask=0077`；无需新永久媒体目录。上线前确认其可写临时空间及部署用户运行 ffprobe 的权限。如果实际存在反向代理，只对该上传路由设置至少 100 MiB 的二进制请求限额及足够超时；不修改全站限制，不以 Server Actions 的 bodySizeLimit 代替本接口流式边界。

## 本地隔离验证

```sh
ls /tmp
FFPROBE_PATH=/opt/homebrew/bin/ffprobe FFMPEG_PATH=/opt/homebrew/bin/ffmpeg node scripts/test-video-uploads.mjs
npx eslint src/lib/video-types.ts src/lib/video-uploads.ts src/lib/video-validation.ts src/lib/postiz.ts src/app/api/media/uploads/route.ts 'src/app/api/media/uploads/[mediaId]/route.ts' scripts/test-video-uploads.mjs
npx tsc --noEmit --incremental false
```

测试只使用合成配置、内存 SQL stub、mock fetch 和 /tmp 的短 MP4 fixture；不读取 .env，不访问实际 Postiz/MySQL/SSH。不运行生产构建或部署。真实测试环境验收仍需覆盖 Postiz 版本/持久化、Node20、100 MiB、Chrome/Safari 播放拖动和实际账号草稿。

官方契约依据：[上传接口](https://docs.postiz.com/public-api/uploads/upload-file)、[Instagram](https://docs.postiz.com/public-api/providers/instagram)、[LinkedIn](https://docs.postiz.com/public-api/providers/linkedin)、[Node20 openAsBlob](https://nodejs.org/docs/latest-v20.x/api/fs.html#fsopenasblobpath-options)。文档能力不代表当前自托管版本已通过验收。
