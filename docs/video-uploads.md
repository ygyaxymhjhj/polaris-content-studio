# 单个 MP4 异步兼容处理与媒体引用

## 状态与上线门槛

本阶段只做本地实现与隔离测试，**没有访问实际 Postiz、数据库或服务器，也未证明当前部署支持视频**。上线前必须用测试账号验收实际 Postiz 版本、100 MiB 上传、五个平台及实际 provider alias 的草稿、浏览器播放/拖动、重启后媒体持久化、存储备份与容量。只创建草稿，不执行正式发布。

## HTTP 契约

`POST /api/media/uploads` 使用登录会话和现有 same-origin 检查。请求体直接发送原始 `File` 字节，不是 multipart，也不是 JSON/base64。

- `Content-Type: video/mp4`
- `X-Upload-Request-Id: <UUID>`：同一个文件重试沿用；换文件使用新 UUID。
- `X-File-Name: encodeURIComponent(file.name)`：MP4 扩展名，最长 255 个 UTF-16 码元，不允许控制字符和目录分隔符。
- 原文件非空，最大 `100 * 1024 * 1024` 字节。`Content-Length` 可省略；有值时用于提前拒绝和检测截断，最终以实际流读取字节数为准。

正常收流完成后，关闭 `input.part`、原子改名为 `input.mp4` 并提交持久任务，立即返回 `202 { job }`；请求不会等待 ffprobe、兼容处理或 Postiz。`after(wakeVideoProcessingWorker)` 只唤醒持久 worker，不是任务存储。202 不是媒体已可用，也不创建草稿。

同 owner 已成功 request ID 的文件 SHA-256 相同则保留 `200 { video }` 回放；未成功的同 owner/request/hash 返回原 `202 { job }`，不会再入队；不同 hash 为 `409 REQUEST_ID_CONFLICT`。失败或取消任务不会原地重跑，重试需新 request ID。回放仍完整收流核对 SHA-256，不信客户端 hash；不同 owner 的 request ID 互不影响。已取消任务不能返回可消费的 video。

`GET /api/media/video-jobs/<UUID>` 是只读、短 SQL 的 owner-only 查询，返回 `200 { job }`，不触发上游上传。`DELETE` 同一路径要求 same-origin，按同一行锁将 queued/running 变成 cancelled；重复取消或取消已完成任务返回当前终态。管理员也不绕过 owner；非法 UUID、不存在和不属于当前 owner 一律 404。所有响应 `Cache-Control: no-store`，不接受客户端文件路径。

`VideoProcessingJob` 为 `{ id, state, phase, video?, error?, code? }`：state 为 `queued | running | succeeded | failed | cancelled`；phase 为 `validating | converting | saving`。仅 succeeded 必须携带合法 `VideoAttachment`，其余状态不携带 video。client-safe `isVideoProcessingResponse` 校验整个契约；failed/cancelled 不可当媒体附件使用。

`video` 严格投影为 `{ id, name, bytes, width, height, durationSeconds }`；不包含 Postiz ID/path、owner、checksum、密钥或临时路径。错误统一为 `{ error, code }`，包括 401、403、400、413、415、429、503、上游 502；连接取消的内部响应为 `499 UPLOAD_CANCELLED`，客户端可能收不到它。错误不会转发上游响应正文。

`GET /api/media/uploads/<UUID>` 校验登录和精确 owner（管理员也不绕过），返回 `Cache-Control: no-store` 的 307 到登记过且通过信任来源检查的 Postiz 媒体 URL。不接受客户端指定 path，不由 Polaris 代理下载视频，不附加 API key。无权限和不存在都返回 404。

**预览鉴权不代表上游媒体私有。** 浏览器在 307 后直接访问上游，公开媒体 URL 的持有者仍可能直接播放。要求真正私有播放时需另行设计上游私有存储/签名访问，不能靠本接口掩盖 URL。

## 存储与后端对接

管理员先执行 `deploy/mysql/migrations/2026-10-22-video-uploads.sql`，再执行新增 `2026-10-22-video-processing.sql`，历史上传迁移不修改。新卷用 `deploy/mysql/init.sql`。应用仍只获得不可变 `video_uploads` 的 SELECT、INSERT；新增 `video_processing_jobs` 的 SELECT、INSERT、UPDATE，不授权 DDL 或任务 DELETE。任务保留 owner/request unique、输入 SHA-256/字节/文件名、state/phase、video_media_id、错误、随机 lease token/deadline 和文件清理时间；不存客户端提供的路径。

- `src/lib/video-types.ts` 是 client-safe 模块，另导出 `VideoProcessingJob` 与 `isVideoProcessingResponse`，原附件/预览契约保留。
- `getVideoUpload(ownerUserId, mediaId, connection?)` 返回 `StoredVideoUpload | null`；其额外字段是 `postizMediaId`、`postizPath`、`ownerUserId`。
- `ownsVideoUploads(ownerUserId, mediaIds, connection?)` 用一次 owner + IN SELECT 核对去重后的所有 ID。可传现有事务连接，不引入新事务/任务队列。
- AI 保存与手动保存按 owner 验证本地 ID；worker 从已冻结的 ID 重新取得 server-trusted `{ id: postizMediaId, path: postizPath }`，传给 `createStrictDraft({ ..., uploadedMedia })`。`uploadedMedia` 与 `imageUrl` 同时存在会明确拒绝，不静默选择。
- 视频引用直接复用原 `posts[].value[].image` 数组，不再下载/上传媒体。`type` 永远是 `draft`；网络失败仍标记 uncertain。Instagram standalone 保留 `__type: instagram-standalone` 并带 `post_type: post`；LinkedIn page 保留实际 `__type: linkedin-page`，不构造 reel 字段。正常图片保留 multipart 上传及原始字节，补强真实格式与资源边界校验。

## 资源与验证边界

共享 Postiz 图片上传分支只接受 sharp 实际识别并可解码的单帧 JPEG/PNG/WebP，不能把 MP4 URL 或伪装的 image MIME 当成图片上传。远端响应逐块读取、实际限 30 MiB（不信 Content-Length）；data URL 先检查编码长度再分配 Buffer。解码器上限 4000 万像素，以 1px raw probe 强制解码；原始图片字节不重编码，上传 MIME/扩展名由实际格式决定。文章原图不受编辑器的 1.5 MB / 2048px 限制。图片验证/上传失败时 strict 和 legacy 草稿入口均拒绝创建草稿，不悄悄退化为无附件稿；已登记视频仍直接复用引用，不走此图片下载路径。

请求按 chunk 写入 spool 下随机 job UUID 的 `input.part`，计算 SHA-256，目录 0700、文件 0600，不将 100 MiB 读成整块 Buffer。原流/temp 工具保留，但此入口采用持久 spool。流完整关闭后原子改名并入队；明确回滚/未提交才删输入，COMMIT 结果不确定保留待核对，不能在请求 finally 无条件删除。

读取阶段限 5 分钟。ffprobe 每次限 15 秒、输出 64 KiB、单次分配 64 MiB、单线程；ffmpeg 兼容处理限 300 秒；上游 multipart 限 180 秒；完整 worker lease/deadline 为 15 分钟，包含验证、转码、上传和登记。`openAsBlob` 从文件构造原生 FormData，明确 `adjust=false`，不依赖 Postiz 转码。兼容的 H.264/yuv420p/AAC MP4 直接使用输入，不重编码；AV1/HEVC 等由本地兼容模块决定是否转为 H.264 MP4，必要时处理音轨、旋转、像素格式、尺寸和帧率。输入与输出均有 100 MiB 边界，服务资源预算不是五个平台的通用发布保证。

仅接受本地、有效 MP4，宽高/时长及流结构要满足兼容模块边界。强制 mov demuxer、仅 file 协议、禁用 dref/绝对外部引用，不处理网络播放列表。worker 先检查账户未禁用、UUID 派生目录、文件类型/权限/单链接、实际大小与 SHA-256；文件来源不由客户端决定。兼容输出重新探测；错误不回传 stderr、密钥或磁盘路径。实际 provider 兼容性仍需上线验收。

收流仍每进程最多 2 个、每 owner 1 个；queued+running 每 owner 1 个、全局 8 个，MySQL GET_LOCK 短锁串行保护事务中的 count+insert，不能裸 COUNT 竞争。worker 每进程只跑 1 个，claim 使用 `FOR UPDATE SKIP LOCKED` 和随机 lease。本方案只支持单应用进程/单节点；共享数据库锁不等于跨节点共享 spool 或跨实例收流限流。

排队任务重启后可继续。running 先查已有 receipt 恢复成功；lease 过期且没有 receipt 则保守置 `failed / PROCESSING_INTERRUPTED`，绝不静默回 queued 或自动重新上传疑似已成功的上游媒体。ready receipt INSERT 与 success UPDATE 在同一短事务内，先锁 job 核验 running/token/deadline；取消取得同一行锁，迟到 worker 不能给 cancelled 创建 receipt。取消触发本进程 AbortController，另每 2 秒短轮询跨模块/进程状态；必须等待子进程 close 和上游请求 settle 才清理源/输出，不能 Promise.race 提前 unlink。

上传接口自己的预检、登记各通过 `withVideoUploadConnection` 单独取得连接，池等待和短 SQL 合计最多 5 秒；不跨文件处理或上游网络持有连接。取消/到时销毁已取得的连接，不把仍运行 SQL 的 socket 放回池；迟到取得的连接立即 release 且不执行 SQL。SQL 另外使用 mysql2 真实支持的 `execute({ sql, timeout: 5000 }, values)` inactivity timeout；外层截止也覆盖 acquire 和 prepared-statement 准备阶段。数据库连接销毁不等于 INSERT 未提交，仍可能发生已有记录但客户端未获确认的失败窗口。共享 project-db、worker 事务及 `getVideoUpload` / `ownsVideoUploads` 连接注入契约不变。

Node 20 的 execFile signal 中止可能先发 SIGTERM 并清除内部 timeout；收到中止回调后显式对 ffprobe 再发 SIGKILL，随后等待 close，避免忽略 SIGTERM 的进程长期占用额度。

持久 spool 每分钟至多一次有界清理：检查至多 200 项、删除至多 20 个超过 24 小时且数据库无引用的 UUID 目录；未知提交的文件不能凭文件名直接删。queued 在持有 claim 行锁时取消并确认提交后，可立即清理无人读取的输入，避免反复取消积累 100 MiB 文件。已运行的终态任务只在本 worker 完全 settle 后清输入/输出并记录 files_cleaned_at；崩溃遗留的终态文件在 updated_at 和保留的 lease 均超过 24 小时后批量清理（每批 20），DB 任务行保留追踪。不会删除本进程 active worker 的目录。受目录遍历上限、停服、磁盘/权限错误影响，不保证立即扫净所有文件；运维仍需容量告警及停服后核对。长期停服/频繁崩溃可留下 spool，不能宣传磁盘硬配额或崩溃零残留。

跨系统没有原子事务：上游保存成功但本地 INSERT/回包失败、客户端取消或多实例竞争可能留下孤儿/重复媒体。首版接受这个失败窗口，允许重新上传，不承诺媒体 exactly-once、不回滚上游、不自动删除媒体。删除附件只是解绑；副本、archive、排队/unknown 草稿仍可能引用原媒体。人工清理 Postiz 前必须核对引用和备份。

## 运行环境

部署文档当前 Node 为 **20.19.5**，该版本提供原生 `node:fs.openAsBlob`、FormData、AbortSignal.any。开发机的 Node 22 隔离测试不能替代服务器 Node 20.19.5 的真实流式上传/中止验收。

在 Ubuntu 24.04 安装发行版 `ffmpeg`（含 ffprobe），以服务用户确认二进制及 H.264/AAC 编码器可用、版本及时更新。默认从 PATH 查找；可设置 `FFPROBE_PATH=/usr/bin/ffprobe`、`FFMPEG_PATH=/usr/bin/ffmpeg`。缺失时任务安全失败并给出操作提示，不返回路径；不是 HTTP 202 后再改变原响应状态。实际 Node20、解码器资源和取消行为仍需验收。

媒体 URL 默认只信任 `POSTIZ_API_URL` 和 `POSTIZ_UI_URL` 的 origin，以及官方文档响应示例的 `https://uploads.postiz.com`。若实际存储使用独立 CDN，设置 `POSTIZ_MEDIA_ORIGINS=https://media.example.com,https://postiz.example.com`；显式列表**替换**默认值，仅支持精确 http(s) origin，不允许凭据、路径、查询和通配符。它只约束登记/预览的目标 URL，不保证该 URL 以后不由上游重定向至其他来源。

`VIDEO_PROCESSING_DIRECTORY` 默认项目内 `.data/video-processing`（已 gitignore），只适合本地开发。生产必须使用 systemd 模板指定的 `/var/lib/polaris-content-studio/video-processing`：`StateDirectory=polaris-content-studio/video-processing`、`StateDirectoryMode=0700`、对应 Environment/ReadWritePaths；保留 UMask/PrivateTmp/ProtectSystem。该目录在 app rsync --delete 范围外，重启/代码同步不会清空输入，不需要改全局 rsync 规则。已有服务器必须由管理员安装更新后的服务模板并 daemon-reload 后再启动；当前部署脚本只同步源码/安装 drop-in，不会自动替换主 service 模板。持久 spool 不是最终媒体库，最终媒体仍在 Postiz。

生产 worker 由 instrumentation 独立自动启动，与通知开关无关；开发定时恢复需显式 `VIDEO_PROCESSING_SCHEDULER_ENABLED=true`，正常开发 POST 的 after 唤醒不依赖此开关。显式 false 停止周期恢复但不屏蔽请求唤醒。Vercel/生产构建不启动此 worker；不支持 serverless 持久任务。反向代理只给该上传路径配置至少 100 MiB 和足够收流超时，不修改全站或用 Server Actions bodySizeLimit 代替。

## 本地隔离验证

```sh
ls /tmp
FFPROBE_PATH=/opt/homebrew/bin/ffprobe FFMPEG_PATH=/opt/homebrew/bin/ffmpeg node scripts/test-video-uploads.mjs
FFPROBE_PATH=/opt/homebrew/bin/ffprobe FFMPEG_PATH=/opt/homebrew/bin/ffmpeg node scripts/test-video-processing.mjs
node scripts/test-social-notification-scheduler.mjs
node scripts/test-draft-submission-scheduler.mjs
npx eslint src/lib/video-types.ts src/lib/video-uploads.ts src/lib/video-validation.ts src/lib/postiz.ts src/app/api/media/uploads/route.ts 'src/app/api/media/uploads/[mediaId]/route.ts' scripts/test-video-uploads.mjs
npx tsc --noEmit --incremental false
```

测试只使用合成配置、内存 SQL stub、mock fetch 和 /tmp 的短 MP4 fixture；不读取 .env，不访问实际 Postiz/MySQL/SSH。不运行生产构建或部署。真实测试环境验收仍需覆盖 Postiz 版本/持久化、Node20、100 MiB、Chrome/Safari 播放拖动和实际账号草稿。

官方契约依据：[上传接口](https://docs.postiz.com/public-api/uploads/upload-file)、[Instagram](https://docs.postiz.com/public-api/providers/instagram)、[LinkedIn](https://docs.postiz.com/public-api/providers/linkedin)、[Node20 openAsBlob](https://nodejs.org/docs/latest-v20.x/api/fs.html#fsopenasblobpath-options)。文档能力不代表当前自托管版本已通过验收。
