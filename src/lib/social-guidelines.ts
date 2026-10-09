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
  ].join("\n"),
  th: [
    "- เขียนภาษาไทยอย่างเป็นธรรมชาติ อ่านง่าย และเข้ากับบริบท หลีกเลี่ยงศัพท์เทคนิคที่หนักเกินไป คำขวัญกลวง หรือน้ำเสียงเป็นทางการจนเกินไป",
    "- ไม่ต้องขึ้นบรรทัดใหม่ทุกประโยคหากไม่จำเป็น แบ่งย่อหน้าอย่างสมเหตุสมผล",
    "- ห้ามแต่งตัวเลข แหล่งข้อมูล ราคา เวลา สถานที่ ฟีเจอร์ หรือข้อมูลใด ๆ ที่ต้นฉบับไม่มี",
    "- อย่าทำให้ทุกแคปชันกลายเป็นโฆษณา CTA ต้องเหมาะกับเป้าหมายและแพลตฟอร์ม",
    "- อย่าลอกวิธีเขียนแบบเดียวกันไปใช้ทุกแพลตฟอร์ม แต่ละแพลตฟอร์มต้องมีวิธีเล่าเป็นของตัวเอง",
    "- อย่าใช้สูตรแคปชันเดิมซ้ำกับทุกบทความ อ่านเนื้อหาแล้วเลือกมุมที่เหมาะสม",
    "- แคปชันแต่ละชิ้นโฟกัสหนึ่งมุมหลัก ไม่ยัดข้อมูลมากเกินไป",
    "- เปิดด้วยรายละเอียดที่ชัดที่สุดของบทความ: ตัวเลข ความขัดแย้ง หรือชื่อที่ผูกกับเหตุการณ์สำคัญ ห้ามเปิดด้วยประโยคภาพรวมอย่าง “ตลาดสัปดาห์นี้มีความเคลื่อนไหวหลายอย่าง” หรือคำถามกว้าง ๆ อย่าง “โบรกเกอร์กำลังทำอะไรกันอยู่” — การเปิดแบบนั้นทำลายการมีส่วนร่วม",
    "- ไอคอน/อีโมจิต้องอิงตามเนื้อหาและบริบทของแต่ละบทความ เลือกไอคอนที่มีความหมาย ไม่ใช้ซ้ำแบบกลไกหรือใช้ชุดเดิมกับทุกแคปชัน",
    "- ใช้ไอคอนพอประมาณ อย่าใส่อีโมจิในทุกประโยค",
    "- สำหรับเนื้อหาการเงิน ให้แยกข้อมูล ความเห็น และการคาดการณ์ออกจากกันอย่างชัดเจน ห้ามสัญญาผลตอบแทนหรือยืนยันความแน่นอนโดยไม่มีหลักฐาน"
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
 * the source of truth: when it changes, update this file too, and keep its channel sections to the
 * five channels Polaris publishes to. Every channel here has voice rules of its own, so the format
 * brief in ASSET_SPECS is never injected alone.
 */
export const PLATFORM_GUIDELINES: Partial<Record<Platform, Record<Language, string>>> = {
  facebook: {
    vi: [
      "- Viết lại nội dung gốc thành một caption Facebook ngắn: thông tin rõ ràng, có trọng tâm, dễ đọc.",
      "- Mỗi caption chỉ giữ một thông tin cốt lõi, không cố đưa toàn bộ nội dung bài viết vào caption; ưu tiên chọn phần đáng chú ý nhất và có giá trị thông tin nhất của bài làm trọng tâm.",
      "- Dòng đầu nói thẳng vào thông tin chính: chuyện gì đã xảy ra và điểm đáng chú ý nhất là gì; không mở đầu bằng câu dẫn không mang thông tin thực.",
      "- Sau dòng đầu, chỉ bổ sung thông tin cần thiết, thường gọn trong một đến hai đoạn và linh hoạt theo lượng thông tin của bài; mỗi câu phải có ích, ví dụ số liệu chính, diễn biến mới hoặc bối cảnh cần thiết.",
      "- Không kể lại toàn bộ bài viết theo trình tự gốc từ bối cảnh, nguyên nhân, diễn biến, kết quả đến tác động; caption Facebook không phải bản tóm tắt bài báo hay thông cáo báo chí.",
      "- Không dồn thành một khối chữ dài; giữ nhịp đọc thoáng, khi có nhiều thông tin thì chia thành tối đa hai đoạn ngắn thay vì nhồi tất cả vào một đoạn.",
      "- Không áp dụng công thức cố định “hook → nội dung → CTA”: không phải caption nào cũng cần CTA, câu hỏi hay phần tổng kết; thông tin nói đủ là dừng, không thêm một câu chỉ để đủ bố cục.",
      "- Viết tiếng Việt tự nhiên, ngắn gọn, đúng cách người Việt đọc Facebook hằng ngày: trực tiếp, dễ hiểu; không dùng ngôn ngữ báo chí cứng nhắc, không viết như thông báo chính thức, không mở đầu sáo rỗng theo lối mòn, không cố làm cho câu chuyện kịch tính và không viết thành quảng cáo.",
      "- Nội dung tài chính (chứng khoán, forex, vàng, thị trường…) phải giữ tính thông tin, khách quan và trung lập; không tự thêm nhận định chủ quan, đánh giá, dự đoán, khuyên đầu tư, nguyên nhân hay tác động mà bài gốc không nêu, và không thêm số liệu không có trong bài. Bài gốc chỉ đưa thông tin thì caption cũng chỉ truyền đạt thông tin.",
      "- Với nội dung về Forex Broker / sàn giao dịch, giữ trung lập, khách quan và hướng thông tin: không vì bài gốc nêu một ưu điểm mà biến caption thành nội dung quảng cáo cho sàn, cũng không ngụ ý sàn đáng tin cậy hay đáng để giao dịch.",
      "- Mỗi caption phải có Emoji/Icon, nhưng phải chọn theo nội dung cụ thể và dùng vừa phải; không lặp một bộ emoji cho mọi bài và không máy móc chèn các ký hiệu như 📉, 💰, 🔥, 📈 chỉ để “giống caption Facebook”.",
      "- Thêm hashtag liên quan trực tiếp đến nội dung ở cuối caption; không nhồi nhiều hashtag và không tự thêm hashtag liên quan đến chính trị.",
      "- Hiệu quả cuối cùng phải giống một người chia sẻ ngắn gọn một thông tin đáng chú ý trên Facebook: thông tin chính → vài câu bổ sung cần thiết → kết thúc; không phải bản nén của cả bài báo thành một đoạn dài. Độ dài, cách chia đoạn và cách diễn đạt linh hoạt theo nội dung bài, nhưng luôn ưu tiên: ngắn, rõ, có trọng tâm và tự nhiên."
    ].join("\n"),
    zh: [
      "- 将原文内容改写成适合 Facebook 发布的短文案：信息清晰、有重点、容易阅读。",
      "- 一篇内容只抓住一个核心信息，不把原文所有内容都塞进文案；优先选择原文中最值得关注、最有信息价值的内容作为重点。",
      "- 第一行直接说重点：告诉读者发生了什么、这件事最值得关注的地方是什么；不要先写没有实际信息的铺垫。",
      "- 第一行之后只补充必要的信息，通常控制在两段，根据原文的信息量灵活调整；每句话都应该有作用，例如补充关键数据、事件进展或必要背景。",
      "- 不要把整篇文章重新讲一遍：不要按原文顺序把背景、原因、经过、结果、影响全部复述；Facebook 文案不是文章摘要，也不是新闻稿。",
      "- 不要写成一整段很长的文字：内容较多时分成一两个短段落，保持阅读节奏，不要把所有信息堆在一个大段落里。",
      "- 不使用固定的「Hook → 内容 → CTA」模板：不是每篇内容都需要 CTA、提问或总结；信息说清楚之后就可以结束，不要为了完整而强行加一句。",
      "- 使用自然、简洁、符合中文读者 Facebook 阅读习惯的中文：直接、容易理解；不使用生硬的新闻媒体语言，不写成正式公告，不使用空泛、套路化的开场白，不故意写得夸张、戏剧化，不把文案写成广告。",
      "- 财经、股票、外汇、黄金、市场等内容必须保持信息型、客观、中立的表达；不得自行增加主观判断、评价、预测、投资建议、原文没有提到的原因或影响、原文没有的数据。原文只是提供信息时，文案也只负责传达信息。",
      "- 涉及 Forex Broker / 交易平台时保持中立、客观、信息导向：不能因为原文提到某一个优点就把文案写成对该平台的宣传，也不能暗示其值得信赖或值得交易。",
      "- 每篇文案必须有 Emoji / Icon，但必须根据具体内容选择、数量适中；不要每篇都使用同一套 Emoji，不要为了“像 Facebook 文案”而机械加入 📉、💰、🔥、📈 等固定符号。",
      "- 文案结尾添加与内容直接相关的 Hashtag；不要堆砌 Hashtag，也不要自行添加政治相关 Hashtag。",
      "- 最终效果应该像一个人在 Facebook 上简洁地分享一条值得关注的信息：重点信息 → 补充几句必要信息 → 结束；而不是把整篇新闻压缩成一大段文字。整体长度、分段方式和具体表达根据原文内容调整，但始终优先保证：短、清楚、有重点、自然。"
    ].join("\n"),
    en: [
      "- Rewrite the source into a short Facebook caption: clear, focused and easy to read.",
      "- One caption carries one core message; never cram the whole article into it. Pick the most notable, most informative part of the source as the focus.",
      "- State the point in the first line: what happened and what matters most about it. Never open with filler that carries no real information.",
      "- After the first line, add only the necessary information, usually within one or two paragraphs and adjusted to how much the source holds; every sentence must do a job, such as a key figure, a development or essential context.",
      "- Do not retell the whole article in its original order of background, cause, events, outcome and impact; a Facebook caption is not an article summary or a press release.",
      "- Never one long block of text: when there is more to say, split it into one or two short paragraphs and keep a readable rhythm instead of piling everything together.",
      "- No fixed “hook → body → CTA” template: not every caption needs a CTA, a question or a wrap-up — when the information is complete, stop instead of adding a sentence just to complete the structure.",
      "- Write natural, concise English that fits how readers take in Facebook daily: direct and easy to follow; no stiff newsroom language, no formal notice tone, no empty formulaic openers, no deliberate dramatisation, and never advertising copy.",
      "- Finance content (stocks, forex, gold, markets and the like) must stay informational, objective and neutral; never add subjective judgement, evaluation, forecasts, investment advice, causes or impacts the source does not mention, or figures the source does not contain. When the source only informs, the caption only informs.",
      "- For content about a Forex broker or trading platform, stay neutral, objective and informational: a merit the source mentions must not turn the caption into promotion for that platform, and nothing may imply it is trustworthy or worth trading with.",
      "- Every caption must carry an emoji/icon, chosen for the specific content and used in moderation; never repeat one set of emoji across captions and never mechanically inject symbols such as 📉, 💰, 🔥 or 📈 just to “look like a Facebook caption”.",
      "- End with hashtags directly related to the content; do not pile on hashtags and never add political hashtags.",
    "- The finished caption should read like a person briefly sharing one noteworthy piece of news on Facebook: the key information → a few necessary details → the end. Length, paragraphs and phrasing follow the source, but always keep it short, clear, focused and natural."
    ].join("\n"),
    th: [
      "- เขียนต้นฉบับใหม่ให้เป็นแคปชัน Facebook สั้น ๆ: ข้อมูลชัดเจน มีจุดโฟกัส อ่านง่าย",
      "- แคปชันหนึ่งชิ้นมีสาระหลักเพียงเรื่องเดียว ห้ามยัดทั้งบทความลงไป เลือกส่วนที่น่าสนใจและมีคุณค่าด้านข้อมูลมากที่สุดของต้นฉบับเป็นจุดโฟกัส",
      "- ประโยคแรกบอกประเด็นตรง ๆ: เกิดอะไรขึ้นและอะไรน่าสนใจที่สุด ห้ามเปิดด้วยประโยคเกริ่นที่ไม่มีข้อมูลจริง",
      "- หลังประโยคแรก เพิ่มเฉพาะข้อมูลที่จำเป็น ปกติกระชับในหนึ่งถึงสองย่อหน้า ปรับตามปริมาณข้อมูลของต้นฉบับ ทุกประโยคต้องมีประโยชน์ เช่น ตัวเลขสำคัญ ความคืบหน้าใหม่ หรือบริบทที่จำเป็น",
      "- ห้ามเล่าบทความทั้งหมดตามลำดับเดิมตั้งแต่บริบท สาเหตุ เหตุการณ์ ผลลัพธ์ ไปจนถึงผลกระทบ แคปชัน Facebook ไม่ใช่บทสรุปบทความหรือข่าวประชาสัมพันธ์",
      "- ห้ามเขียนเป็นก้อนข้อความยาว ๆ รักษาจังหวะการอ่านให้โปร่ง เมื่อมีข้อมูลมากให้แบ่งเป็นไม่เกินสองย่อหน้าสั้น ๆ แทนที่จะยัดทั้งหมดไว้ในย่อหน้าเดียว",
      "- ไม่ใช้สูตรตายตัว “ฮุก → เนื้อหา → CTA”: ไม่ใช่ทุกแคปชันต้องมี CTA คำถาม หรือบทสรุป เมื่อข้อมูลครบแล้วให้หยุด ไม่ต้องเพิ่มประโยคเพียงเพื่อให้โครงสร้างครบ",
      "- เขียนภาษาไทยที่เป็นธรรมชาติ กระชับ ตามแบบที่คนอ่าน Facebook ในชีวิตประจำวัน: ตรงไปตรงมา เข้าใจง่าย ไม่ใช้ภาษาเชิงข่าวที่แข็งทื่อ ไม่เขียนเหมือนประกาศทางการ ไม่เปิดด้วยประโยคซ้ำซากจำเจ ไม่พยายามทำให้เรื่องดูเกินจริง และไม่เขียนเป็นโฆษณา",
      "- เนื้อหาการเงิน (หุ้น ฟอเร็กซ์ ทองคำ ตลาด ฯลฯ) ต้องคงความเป็นข้อมูล ปรนัย และเป็นกลาง ห้ามเพิ่มความเห็น การประเมิน การคาดการณ์ คำแนะนำการลงทุน สาเหตุหรือผลกระทบที่ต้นฉบับไม่ได้กล่าวถึง และห้ามเพิ่มตัวเลขที่ไม่มีในต้นฉบับ ถ้าต้นฉบับให้เพียงข้อมูล แคปชันก็ทำหน้าที่เพียงส่งต่อข้อมูล",
      "- เนื้อหาเกี่ยวกับ Forex Broker / แพลตฟอร์มซื้อขาย ให้คงความเป็นกลาง ปรนัย และเน้นข้อมูล: อย่าเปลี่ยนแคปชันเป็นโฆษณาให้แพลตฟอร์มเพียงเพราะต้นฉบับกล่าวถึงข้อดีข้อหนึ่ง และห้ามสื่อเป็นนัยว่าแพลตฟอร์มนั้นน่าเชื่อถือหรือน่าลงทุน",
      "- ทุกแคปชันต้องมีอีโมจิ/ไอคอน แต่ต้องเลือกตามเนื้อหาเฉพาะและใช้พอประมาณ ห้ามใช้ชุดอีโมจิเดิมซ้ำทุกบทความ และห้ามยัดสัญลักษณ์อย่าง 📉 💰 🔥 📈 แบบกลไกเพียงเพื่อ “ให้ดูเป็นแคปชัน Facebook”",
      "- ใส่แฮชแท็กที่เกี่ยวข้องโดยตรงกับเนื้อหาตอนท้ายแคปชัน ห้ามใส่แฮชแท็กมากเกินไป และห้ามเพิ่มแฮชแท็กเกี่ยวกับการเมือง",
      "- ผลลัพธ์สุดท้ายต้องอ่านเหมือนคนแชร์ข้อมูลน่าสนใจสั้น ๆ บน Facebook: ข้อมูลหลัก → ประโยคเสริมเท่าที่จำเป็น → จบ ไม่ใช่การย่อทั้งบทความให้เหลือย่อหน้ายาว ๆ ความยาว การแบ่งย่อหน้า และการเรียบเรียงยืดหยุ่นตามเนื้อหา แต่ยึดหลักเสมอ: สั้น ชัด มีจุดโฟกัส และเป็นธรรมชาติ"
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
    ].join("\n"),
    th: [
      "- เลือกข้อมูลที่น่าสนใจที่สุดจากต้นฉบับ อย่าพยายามยัดบทความทั้งเรื่องลงในแคปชัน",
      "- ผลลัพธ์คือ 1 ประโยคเปิด + 1 ย่อหน้าหลัก",
      "- ประโยคเปิดต้องดึงดูดและบอกผู้อ่านทันทีว่าโพสต์กำลังพูดถึงเรื่องอะไร",
      "- ย่อหน้าหลักเก็บเฉพาะข้อมูลที่จำเป็นที่สุด เขียนสั้น ชัด และต่อเนื่อง",
      "- ทุกแคปชันต้องมีไอคอน/อีโมจิ โดยเลือกจากเนื้อหาของบทความ"
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
    ].join("\n"),
    th: [
      "- เขียนในสไตล์ข่าวเร็ว นำข้อมูลสำคัญที่สุดขึ้นก่อน",
      "- “ข่าวเร็ว” เป็นเพียงคำอธิบายโทน ไม่ใช่ป้ายที่ต้องพิมพ์: ห้ามเปิดด้วยคำนำอย่าง BREAKING หรือ FLASH ให้เริ่มที่ตัวข้อมูลเลย",
      "- ประโยคสั้น ตรงประเด็น ข้อมูลแน่น เน้นเขียนให้เหมือน headline / news update",
      "- เลือกจุดเน้นจากเนื้อหาจริง: ความคืบหน้า ตัวเลข คำกล่าว สาเหตุ ผลกระทบ หรือรายละเอียดใหม่ ไม่บังคับให้ทุกโพสต์มีครบทุกองค์ประกอบ",
      "- ให้น้ำหนักกับความสดใหม่และข้อมูลใหม่ โดยเฉพาะเนื้อหาการเงินและตลาด",
      "- ใช้ไอคอน/อีโมจิได้เมื่อเหมาะกับเนื้อหา",
      "- ใช้แฮชแท็กเฉพาะเมื่อเกี่ยวข้องจริง ๆ ห้ามยัดแฮชแท็ก",
      "- หากแนบลิงก์บทความ ตัวแคปชันต้องมีข้อมูลพอให้ผู้อ่านเข้าใจทันทีว่าเป็นข่าวอะไรโดยไม่ต้องเปิดลิงก์"
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
    ].join("\n"),
    th: [
      "- เลือกวิธีเขียนแคปชันให้เหมาะกับเนื้อหาบทความและภาพที่แนบมา ไม่ใช้สูตรตายตัว",
      "- แคปชันต้องสั้น อ่านง่าย มีจุดโฟกัส เสริมภาพ/วิดีโอแทนการพูดซ้ำทั้งหมด",
      "- เน้นวิธีเขียนที่เข้ากับพฤติกรรมผู้ใช้ Instagram: อ่านง่าย มองเห็นเป็นภาพ ดึงดูด และกระตุ้นการมีส่วนร่วม",
      "- ไอคอน/อีโมจิต้องเลือกให้ตรงกับเนื้อหาและบริบท ใช้พอประมาณ",
      "- CTA และแฮชแท็กต้องเหมาะกับเนื้อหา เป้าหมายของโพสต์ และธรรมเนียมของ Instagram",
      "- ห้ามเพิ่มข้อมูลเองหรือเปลี่ยนแคปชันเป็นโฆษณาเมื่อบทความไม่ได้มีเจตนานั้น"
    ].join("\n")
  },
};
