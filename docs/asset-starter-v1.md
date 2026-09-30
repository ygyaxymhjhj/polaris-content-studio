# 社媒素材初稿规范

产品当前只覆盖五个社媒渠道：Facebook、Threads、LinkedIn、X、Instagram，每个渠道产出 1 条素材。每个渠道独立调用模型，同一批最多 5 个并发（凑满一次并发波次）。格式检查不通过时最多修订一次；长篇原文可能仍需要数十秒，且比单次生成消耗更多 API 额度。来源不足时允许较短初稿，不凑字数或虚构细节。

平台语气规范来自根目录 `Prompt Social.md`，在 `src/lib/social-guidelines.ts` 中维护。绝大多数渠道按 `config.language` 选择中/越/英版本注入；**LinkedIn 例外**：该文档要求 LinkedIn 内容必须 100% 英文，因此它是英文单语渠道，固定注入英文规范，不受 `config.language` 影响，brief 仍可用其他语言提交。渠道语言与规范语种统一由 `channelVoice()` 解析，生成与改写都取该函数的返回值，因此提示词里的输出语言、项目上下文与规范语种三者同源，不出现互相冲突的语言指令。五个渠道在 `Prompt Social.md` 中都有对应章节，因此每个渠道都会同时注入格式 brief 与渠道语气规范。修改 `Prompt Social.md` 后必须同步更新 `src/lib/social-guidelines.ts`；退役某个渠道时，`Prompt Social.md`、`social-guidelines.ts`、`asset-specs.ts`、`types.ts` 四处必须一起改。

| 平台 | 数量 | 初稿交付结构 |
| --- | --- | --- |
| Facebook | 1 | 短文案：第一行直接说重点（有亮眼数据用其中最亮一条，不硬塞、不编造），一两段内只补必要信息、不重讲全文；不套固定 Hook→内容→CTA 模板；结尾相关 Hashtag；配图建议、图中文字、首评单列 |
| Threads | 1 | 1 句开头 + 1 段正文 |
| LinkedIn | 1 | 英文专业开头、背景、事实要点、谨慎解读、讨论问题 |
| X | 1 | 单条快讯短帖，≤280 字符 |
| Instagram | 1 | 6 页标题与正文、发布配文、视觉方向 |

正文与制作建议分开。`content` 包含完整可编辑文案，多段格式也在其中完整展开；`meta` 保存结构化制作信息，可在编辑器 JSON 区域修改。修改后回到待审核状态。

卡片标记 AI 初稿/本地初稿，提示卡片仅为预览。编辑器显示风险和结构检查问题。导出包含完整 Markdown 与每条素材 JSON，包括制作说明，必须逐条批准。

本地模板只使用已确认且允许社媒使用的原文事实；文字框架支持中越英，但不会翻译事实摘录，必须人工核对语言。LinkedIn 本地稿固定使用英文框架，摘录内容不是英文时附带风险标记，说明必须改写为英文后才能发布。字数和完整性不保证仅靠模板满足，检查问题会保留。AI 格式检查也不等于事实已被独立核实。

旧项目中已退役渠道（官网 SEO、短视频、社区、Push、KOL LIVE、FAQ）的素材与勾选会在载入时被丢弃，其余内容照常恢复，见 `parseSnapshot()`。严格校验本身仍然拒绝这些平台值。

测试：`node scripts/test-asset-starters.mjs`（不调用付费 API）；界面回归：`node scripts/test-ui-languages.mjs` 和 `node scripts/test-source-config.mjs`（需启动开发服务）。
