import type { Platform, ProjectConfig } from "./types";

export type Language = ProjectConfig["language"];

export interface ChannelVoice {
  /** Language the published copy must be written in. */
  language: Language;
  /** Voice rules injected into the prompt, already written in that language. */
  guidelines?: string;
  /** True when the channel publishes in one language whatever the project language says. */
  fixed: boolean;
}

/**
 * Voice for one channel: the language its copy is published in, plus the rules for writing it.
 * The two travel together on purpose. "Prompt Social.md" fixes some channels to a single
 * language — LinkedIn publishes in English only — and a channel must never be asked for copy in
 * a language it does not publish, nor handed rules written for a different one. Callers that need
 * to know whether the project language was overridden ask this function rather than re-deriving
 * the rule from a comparison, so the channel policy stays in one place.
 */
export function channelVoice(platform: Platform, configured: Language): ChannelVoice {
  if (platform === "linkedin") return { language: "en", guidelines: LINKEDIN_GUIDELINES, fixed: true };
  return { language: configured, guidelines: PLATFORM_GUIDELINES[platform]?.[configured], fixed: false };
}

/** Writing principles for every channel, kept in the language the copy is written in. */
export const GLOBAL_GUIDELINES: Record<Language, string> = {
  vi: [
    "- Viết tiếng Việt tự nhiên, dễ đọc, đúng ngữ cảnh; không lạm dụng từ Hán–Việt, khẩu hiệu sáo rỗng hoặc văn phong quá trang trọng.",
    "- Không viết mỗi câu một dòng nếu không cần thiết; chia đoạn hợp lý.",
    "- Tuyệt đối không tự bịa số liệu, nguồn tin, giá, thời gian, địa điểm, tính năng hoặc thông tin không có trong nội dung gốc.",
    "- Không biến mọi caption thành quảng cáo; CTA phải phù hợp với mục tiêu và nền tảng.",
    "- Không copy cùng một cách viết cho nhiều nền tảng; mỗi nền tảng phải có cách triển khai riêng.",
    "- Không lặp một công thức caption cho mọi bài; phải đọc nội dung và chọn góc triển khai phù hợp.",
    "- Mỗi caption chỉ tập trung vào một góc chính, không nhồi quá nhiều thông tin.",
    "- Mở đầu bằng chi tiết cụ thể nhất của bài: một con số, một sự tương phản, hoặc một tên gọi gắn với mốc mới. Không mở đầu bằng câu tổng quan kiểu \"thị trường tuần qua ghi nhận nhiều diễn biến\" hay câu hỏi chung chung \"các sàn đang làm gì?\" — loại mở đầu đó giết tương tác.",
    "- Icon/emoji phải dựa trên nội dung và ngữ cảnh của từng bài; chọn icon có ý nghĩa, không dùng máy móc hoặc lặp một bộ icon cho mọi caption.",
    "- Số lượng icon vừa phải, không chèn emoji vào mọi câu.",
    "- Với nội dung tài chính, phân biệt rõ thông tin, nhận định và dự báo; không dùng ngôn ngữ đảm bảo lợi nhuận hoặc khẳng định chắc chắn khi chưa có căn cứ."
  ].join("\n"),
  zh: [
    "- 用自然、易读、贴合语境的中文写作；避免堆砌书面腔、空洞口号或过度正式的表达。",
    "- 非必要不要一句一行；合理分段。",
    "- 绝对不要编造数据、来源、价格、时间、地点、功能或原文没有的信息。",
    "- 不要把每条文案都写成广告；CTA 必须与内容和平台目标匹配。",
    "- 不要在多平台之间复制同一种写法；每个平台都要有自己的展开方式。",
    "- 不要对所有文章重复同一套文案公式；必须先读内容再选择合适角度。",
    "- 每条文案只聚焦一个主要角度，不要塞入过多信息。",
    "- 开头必须用文中最具体的细节：一个数字、一个反差，或一个名称加新纪录。不要用「本周市场录得多项进展」式的综述开头，也不要用「各家平台都在做什么？」式的泛泛提问——这类开头最消耗互动。",
    "- 图标/emoji 要依据每篇文章的内容与语境；选择有意义的图标，不要机械套用或对所有文案重复同一组。",
    "- 图标数量适中，不要每句都插 emoji。",
    "- 涉及金融内容时，明确区分信息、观点和预测；不要使用保证收益或缺乏依据的确定性表述。"
  ].join("\n"),
  en: [
    "- Write natural, readable English that fits the context; avoid heavy jargon, empty slogans or an overly formal tone.",
    "- Do not put every sentence on its own line unless necessary; use sensible paragraphs.",
    "- Never invent figures, sources, prices, times, places, features or any information absent from the source.",
    "- Do not turn every caption into an advertisement; the CTA must fit the goal and the platform.",
    "- Do not copy one writing approach across platforms; each platform needs its own treatment.",
    "- Do not repeat one caption formula for every article; read the content and choose a fitting angle.",
    "- Each caption focuses on one main angle; do not cram in too much information.",
    "- Open with the single most concrete detail in the article: a number, a contrast, or a name tied to a milestone. Never open with a market-roundup sentence like \"the market saw several developments this week\" or a generic question like \"what are brokers doing?\" — that kind of opener kills engagement.",
    "- Icons/emoji must follow each article's content and context; pick meaningful ones, never a mechanical or repeated set.",
    "- Use icons sparingly; do not put emoji in every sentence.",
    "- For financial content, clearly separate information, opinion and forecast; never promise returns or assert certainty without evidence."
  ].join("\n")
};

/**
 * LinkedIn is an English-only channel, so its rules exist once, in English, and are never
 * localized: the brief, the article and the project fields may arrive in Vietnamese or Chinese,
 * but the published copy is English. Transcribed from the LinkedIn section of "Prompt Social.md",
 * which states the copy must be written 100% in English.
 */
const LINKEDIN_GUIDELINES = [
  "LinkedIn is an English-only channel, reaching an international audience interested in finance, forex, gold, trading, fintech, business and related topics. The article, the brief and the project fields are editorial input and may be written in another language; the published copy is English.",
  "- Write 100% of the copy in English.",
  "- Write the English directly from the source facts; never translate a draft sentence by sentence or word by word.",
  "- Do not carry over phrasing, structures or wordplay that only work in another language and read awkwardly in English.",
  "- Wording must be natural, clear, professional and suited to an international setting.",
  "- Industry terms (finance, forex, gold, trading, fintech, regulation) are fine, but a general reader must still follow the content.",
  "- Project fields such as title, audience and cta are editorial context: express them in natural English instead of copying them verbatim in another language.",
  "- Do not write like a press release or stiff corporate copy.",
  "- Avoid empty phrases such as “In today's rapidly changing world”, “We are thrilled to announce” or “This marks a new era…” unless truly necessary.",
  "- Delivery notes and meta values are English as well. A revision request may arrive in another language: follow it, but answer in English."
].join("\n");

/**
 * Platform voice rules transcribed from "Prompt Social.md" at the repository root. That document is
 * the source of truth: when it changes, update this file too. website and faq have no section in the
 * document and keep their ASSET_SPECS brief unchanged.
 */
export const PLATFORM_GUIDELINES: Partial<Record<Platform, Record<Language, string>>> = {
  facebook: {
    vi: [
      "- Caption phải giúp người đọc biết ngay bài đang nói về vấn đề gì và thông tin nào đáng chú ý nhất (1 câu đầu + đoạn phân tích bên dưới + kèm hashtag).",
      "- Chọn cách mở đầu và cách triển khai dựa trên chính nội dung bài viết, không áp dụng một mẫu cố định.",
      "- Giữ lại thông tin cần thiết để người đọc hiểu sự việc, đồng thời rút gọn và diễn đạt lại theo cách phù hợp với Facebook.",
      "- Không biến caption thành bài báo, bài phân tích hoặc quảng cáo.",
      "- Không tự thêm nhận định, kết luận hoặc thông tin mà bài gốc không có.",
      "- Mỗi caption đều phải có icon/emoji; icon phải được lựa chọn dựa trên nội dung và đặt ở vị trí phù hợp, không dùng máy móc một bộ icon cho mọi bài."
    ].join("\n"),
    zh: [
      "- 文案要让读者一眼看出这篇在讲什么问题、哪条信息最值得关注（1 句开头 + 下方分析段落 + 附带话题标签）。",
      "- 开头方式与展开方式要基于文章内容本身，不要套用固定模板。",
      "- 保留让读者理解事件所必需的信息，同时按 Facebook 的表达方式精简和改写。",
      "- 不要把文案写成新闻报道、分析长文或广告。",
      "- 不要自行添加原文没有的观点、结论或信息。",
      "- 每条文案都必须有图标/emoji；图标要依据内容选择并放在合适位置，不要对所有文章机械套用同一组。"
    ].join("\n"),
    en: [
      "- The caption must tell readers immediately what the post is about and which detail matters most (1 opening sentence + an analysis paragraph below + hashtags).",
      "- Choose the opening and the structure from the article itself; never apply a fixed template.",
      "- Keep the information readers need to understand the story, while condensing and rewording it for Facebook.",
      "- Do not turn the caption into an article, an analysis piece or an advertisement.",
      "- Do not add opinions, conclusions or information the source article does not contain.",
      "- Every caption must include an icon/emoji; choose it from the content and place it sensibly — never a mechanical set for every article."
    ].join("\n")
  },
  threads: {
    vi: [
      "- Dựa vào nội dung gốc để chọn thông tin đáng chú ý nhất, không cố đưa toàn bộ nội dung bài viết vào caption.",
      "- Đầu ra gồm 1 câu mở đầu + 1 đoạn nội dung chính.",
      "- Câu mở đầu cần thu hút và cho người đọc biết ngay bài đang nói về gì.",
      "- Đoạn nội dung chính chỉ giữ lại những thông tin cần thiết nhất, viết ngắn, rõ và liền mạch.",
      "- Mỗi caption phải có icon/emoji, lựa chọn dựa trên nội dung bài."
    ].join("\n"),
    zh: [
      "- 基于原文挑选最值得关注的信息，不要试图把整篇文章都塞进文案。",
      "- 输出为 1 句开头 + 1 段正文。",
      "- 开头句要吸引人，并让读者立刻明白这篇在讲什么。",
      "- 正文只保留最必要的信息，写得简短、清晰、连贯。",
      "- 每条文案都要有图标/emoji，依据文章内容选择。"
    ].join("\n"),
    en: [
      "- Pick the most notable detail from the source; do not try to fit the whole article into the caption.",
      "- Output is 1 opening sentence + 1 main body paragraph.",
      "- The opening sentence must be engaging and tell readers immediately what the post is about.",
      "- The body keeps only the essential information — short, clear and continuous.",
      "- Every caption needs an icon/emoji chosen from the article content."
    ].join("\n")
  },
  x: {
    vi: [
      "- Viết theo phong cách tin nhanh, đưa thông tin quan trọng nhất lên đầu.",
      "- \"Tin nhanh\" chỉ là mô tả phong cách; không mở đầu bằng nhãn mục như \"TIN NHANH\" — vào thẳng thông tin.",
      "- Câu chữ ngắn, trực diện, giàu thông tin, ưu tiên cách viết giống headline/news update.",
      "- Dựa vào nội dung thực tế để chọn điểm nhấn: diễn biến, con số, phát biểu, nguyên nhân, tác động hoặc thông tin mới; không ép bài nào cũng phải có đủ các yếu tố này.",
      "- Ưu tiên tính thời điểm và thông tin mới, đặc biệt với nội dung tài chính và thị trường.",
      "- Có thể dùng icon/emoji khi phù hợp với nội dung.",
      "- Hashtag chỉ dùng khi thực sự liên quan; không nhồi hashtag.",
      "- Nếu dẫn link bài viết, phần caption phải đủ thông tin để người đọc hiểu ngay tin gì đang được đề cập mà không cần mở link."
    ].join("\n"),
    zh: [
      "- 按快讯风格写，最重要的信息放最前。",
      "- 「快讯」只是风格描述，不要把「快讯」「突发」这类栏目标签写进文案开头；直接以信息开头。",
      "- 句子短、直接、信息密度高，优先写成 headline / news update 的样子。",
      "- 依据实际内容选择重点：进展、数字、表态、原因、影响或新信息；不要强求每篇都齐备这些要素。",
      "- 优先时效性与新信息，金融和市场内容尤其如此。",
      "- 合适时可以少量使用图标/emoji。",
      "- 只在确实相关时使用话题标签；不要堆砌。",
      "- 如果附上文章链接，文案本身要能让读者不开链接就明白在讲什么。"
    ].join("\n"),
    en: [
      "- Write in fast-news style; lead with the most important information.",
      "- \"Fast-news\" describes the tone, not a label to print: never open with BREAKING, FLASH or similar prefixes — start with the information itself.",
      "- Short, direct, information-dense sentences — closer to a headline or news update.",
      "- Choose the emphasis from the actual content: a development, figure, statement, cause, impact or new detail; do not force every element into every post.",
      "- Prioritise timeliness and new information, especially for finance and market content.",
      "- Icons/emoji are acceptable when they fit the content.",
      "- Use hashtags only when genuinely relevant; never stuff them.",
      "- If you link the article, the caption alone must tell readers what the news is without opening the link."
    ].join("\n")
  },
  instagram: {
    vi: [
      "- Dựa vào nội dung bài viết và visual đi kèm để lựa chọn cách triển khai caption phù hợp; không áp dụng một công thức cố định.",
      "- Caption cần ngắn gọn, dễ đọc, có điểm nhấn, bổ trợ cho hình ảnh/video thay vì lặp lại toàn bộ nội dung.",
      "- Ưu tiên cách viết phù hợp với hành vi người dùng Instagram: dễ đọc, trực quan, có tính thu hút và khuyến khích tương tác.",
      "- Icon/emoji phải được lựa chọn theo đúng nội dung và ngữ cảnh, sử dụng vừa phải.",
      "- CTA và hashtag phải phù hợp với nội dung, mục tiêu bài viết và đặc điểm Instagram.",
      "- Không tự thêm thông tin hoặc biến caption thành nội dung quảng cáo nếu bài viết không có mục đích đó."
    ].join("\n"),
    zh: [
      "- 依据文章内容和配套视觉选择合适的文案展开方式；不要套用固定公式。",
      "- 文案要简短、易读、有重点，为图片/视频做补充，而不是重复全部内容。",
      "- 优先符合 Instagram 用户行为的写法：易读、直观、有吸引力、鼓励互动。",
      "- 图标/emoji 要贴合内容与语境，使用适度。",
      "- CTA 和话题标签要匹配内容、文章目标和 Instagram 的特点。",
      "- 不要自行添加信息，也不要在文章本无此意图时把文案写成广告。"
    ].join("\n"),
    en: [
      "- Choose the caption approach from the article and its visuals; never a fixed formula.",
      "- The caption is short, readable and pointed — it supports the image/video rather than repeating it.",
      "- Match Instagram user behaviour: readable, visual, appealing, encouraging interaction.",
      "- Choose icons/emoji to match the content and context; use them in moderation.",
      "- CTA and hashtags must fit the content, the post's goal and Instagram's conventions.",
      "- Do not add information or turn the caption into advertising when the article has no such intent."
    ].join("\n")
  },
  short_video: {
    vi: [
      "- Viết voice tiếng Việt phù hợp video 40–70 giây, nội dung liền mạch, tự nhiên.",
      "- Ưu tiên câu chữ đơn giản, dễ hiểu, giống cách nói thực tế; không chèn icon/emoji hoặc hashtag vào voice.",
      "- Dựa vào nội dung và mục đích của từng bài để tự lựa chọn cách triển khai, không áp dụng một cấu trúc cố định cho mọi video.",
      "- Nếu nội dung cần nhiều thời lượng hơn để truyền tải đầy đủ, được phép viết dài hơn, tuyệt đối không cắt bớt hoặc rút gọn khiến thông tin sai lệch, thiếu ngữ cảnh.",
      "- Kiểm tra lại voice khi đọc thành tiếng, đảm bảo không bị vấp, lặp từ hoặc chuyển ý thiếu tự nhiên.",
      "- Caption: viết 1 câu duy nhất, ngắn gọn, đánh đúng trọng tâm video.",
      "- Caption: thêm hashtag phù hợp với nội dung; không nhồi hashtag."
    ].join("\n"),
    zh: [
      "- 撰写适配 40–70 秒视频的中文口播，内容连贯、自然。",
      "- 用词简单易懂，接近真实说话方式；口播里不要插入图标/emoji 或话题标签。",
      "- 根据每篇内容和目的自行选择展开方式，不要对所有视频套用固定结构。",
      "- 如果内容需要更长时间才能讲清楚，可以写得更长；绝不要为了缩短而删减到信息失真、语境缺失。",
      "- 把口播读出声检查一遍，确保不拗口、不重复用词、语义衔接自然。",
      "- 配文：只写 1 句话，简短，正中视频重点。",
      "- 配文：添加与内容相符的话题标签；不要堆砌。"
    ].join("\n"),
    en: [
      "- Write a spoken script for a 40–70 second video; keep it coherent and natural.",
      "- Simple, easy wording close to real speech; no icons/emoji or hashtags in the spoken script.",
      "- Choose the treatment from each article's content and goal; never a fixed structure for every video.",
      "- If the content needs more time to be told properly, write longer — never cut or compress it into something misleading or missing context.",
      "- Read the script aloud once; no stumbles, repeated words or unnatural transitions.",
      "- Caption: write exactly one sentence — short, hitting the video's core point.",
      "- Caption: add hashtags that fit the content; do not stuff them."
    ].join("\n")
  },
  community: {
    vi: [
      "- Ưu tiên thông báo tính năng, hướng dẫn ngắn, cập nhật dữ liệu, sự kiện, giải đáp và nội dung có ích khi sử dụng app.",
      "- Nói rõ người dùng được gì hoặc cần làm gì.",
      "- Nếu có thao tác, viết theo trình tự đơn giản; không hướng dẫn sai hoặc tự đoán giao diện.",
      "- Không gửi quá nhiều thông báo cho những nội dung không thiết yếu.",
      "- Không biến mọi bài thành lời nhắc kiểm tra broker; chỉ đề cập khi phù hợp với nội dung.",
      "- CTA nên là mở app, xem nội dung, phản hồi, đặt câu hỏi hoặc tham gia hoạt động cộng đồng."
    ].join("\n"),
    zh: [
      "- 优先功能公告、简短指引、数据更新、活动、答疑，以及使用 App 时真正有用的内容。",
      "- 讲清楚用户能得到什么、需要做什么。",
      "- 若涉及操作，按简单顺序写；不要给出错误指引或臆测界面。",
      "- 非必要内容不要过度推送。",
      "- 不要每篇都变成“检查交易商”的提醒；只在内容合适时提及。",
      "- CTA 应为：打开 App、查看内容、反馈、提问或参与社区活动。"
    ].join("\n"),
    en: [
      "- Prioritise feature announcements, short how-tos, data updates, events, Q&A and content genuinely useful inside the app.",
      "- State clearly what the user gets or what they need to do.",
      "- If steps are involved, keep them in a simple order; never misinstruct or guess at the UI.",
      "- Do not over-notify for non-essential content.",
      "- Do not turn every post into a broker-check reminder; mention it only when the content warrants.",
      "- CTA should be: open the app, view the content, give feedback, ask a question or join a community activity."
    ].join("\n")
  },
  push: {
    vi: [
      "- Tiêu đề: ngắn, nói thẳng nội dung; tránh giật tít mơ hồ.",
      "- Nội dung: một lợi ích hoặc một thông tin chính; không nhồi nhiều ý.",
      "- CTA: một hành động rõ — Xem ngay, Cập nhật giá, Đọc phân tích, Tham gia.",
      "- Tần suất: chỉ gửi khi có lý do; tránh lặp lại cùng một thông tin.",
      "- Giọng: rõ, nhanh, hữu ích; không quá bán hàng.",
      "- Mẫu: “[Thông tin đáng chú ý] — [điểm chính]. Mở app để [hành động cụ thể].”"
    ].join("\n"),
    zh: [
      "- 标题：短，直说内容；避免含糊的标题党。",
      "- 正文：只讲一个利益点或一条主要信息；不要塞多个意思。",
      "- CTA：一个明确动作——立即查看、查看最新价格、阅读分析、参加。",
      "- 频控：只在有理由时发送；避免重复同一条信息。",
      "- 语气：清晰、快速、有用；不要过度推销。",
      "- 模板：“[值得关注的信息] — [要点]。打开 App 即可 [具体动作]。”"
    ].join("\n"),
    en: [
      "- Title: short, states the content plainly; no vague clickbait.",
      "- Body: one benefit or one key piece of information; do not stack multiple ideas.",
      "- CTA: one clear action — View now, Check the latest price, Read the analysis, Join.",
      "- Frequency: send only when there is a reason; avoid repeating the same information.",
      "- Tone: clear, quick, useful; not overly salesy.",
      "- Template: “[Notable information] — [key point]. Open the app to [specific action].”"
    ].join("\n")
  },
  kol_live: {
    vi: [
      "- Nêu thông tin cơ bản của KOL, chủ đề và thời gian thật rõ.",
      "- Hook có thể dựa trên câu hỏi người xem đang quan tâm: giá vàng, diễn biến thị trường, nhận định, giải đáp hoặc chủ đề của buổi live.",
      "- Tạo cảm giác tương tác: gửi câu hỏi, để lại vấn đề muốn KOL phân tích, tham gia dự đoán nếu hoạt động có thật.",
      "- Không hứa hẹn kết quả đầu tư, không dùng ngôn ngữ chắc chắn dự đoán thị trường.",
      "- Nếu có minigame hoặc hoạt động dự đoán giá vàng, phải nêu đúng thể lệ, thời gian và phần thưởng đã được xác nhận.",
      "- CTA nên rõ: vào live, đặt câu hỏi trước, bật nhắc lịch hoặc chia sẻ cho người quan tâm.",
      "- Khung: “Tối nay [KOL] sẽ cùng bạn nói về [chủ đề]. Nếu đang quan tâm [vấn đề], đây là lúc gửi câu hỏi. Hẹn gặp lúc [thời gian] trên [kênh].”"
    ].join("\n"),
    zh: [
      "- 清楚说明 KOL 的基本信息、主题和时间。",
      "- Hook 可以来自观众正在关心的问题：金价、市场走势、观点、答疑或直播主题。",
      "- 营造互动感：提问、留下希望 KOL 分析的问题、在活动真实存在时参与预测。",
      "- 不要承诺投资结果，不要用确定性语言预测市场。",
      "- 若有小游戏或金价竞猜，必须准确写明已确认的规则、时间和奖品。",
      "- CTA 要明确：进入直播、提前提问、开启提醒或分享给感兴趣的人。",
      "- 框架：“今晚 [KOL] 将和大家聊 [主题]。如果你正在关注 [问题]，现在就可以提问。到时见——[时间]，[渠道]。”"
    ].join("\n"),
    en: [
      "- State the KOL's basic details, the topic and the time clearly.",
      "- The hook can come from what viewers care about: gold prices, market moves, views, Q&A or the live topic.",
      "- Create interaction: send questions, leave a topic for the KOL to analyse, join a prediction only if the activity is real.",
      "- Never promise investment outcomes or use certain-sounding market predictions.",
      "- For any mini-game or gold-price prediction, state only the confirmed rules, timing and prizes.",
      "- CTA should be clear: join the live, ask ahead, set a reminder or share with someone interested.",
      "- Framework: “Tonight [KOL] will talk about [topic]. If [issue] matters to you, this is the time to send your question. See you at [time] on [channel].”"
    ].join("\n")
  }
};
