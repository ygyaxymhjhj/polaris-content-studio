const $ = id => document.getElementById(id);
const copy = {
  zh: { intro: '先在浏览器正常打开文章，再点击读取。验证码请自行完成。', extract: '读取当前文章', titleLabel: '标题（可修改）', bodyLabel: '正文预览（可修改）', targetLabel: '发送到', privacy: '仅发送这里的标题、正文与原文链接，不读取 Cookie 或密码。请检查无私人信息后再发送；工具中仍需确认导入。', send: '确认并发送到工具', reading: '正在读取当前页面…', ready: '请核对正文，删去无关内容后发送。', sending: '正在连接工具，请保持此窗口打开…', sent: '已送达！请在工具中确认替换来源。', failed: '未能完成。请打开工具最新版后重试，或使用正文粘贴。', blocked: '页面需要正常登录或验证，请完成后再读取。', empty: '没有识别到足够正文。请确认文章已经显示，或使用手动粘贴。', unsupported: '请在普通 HTTP/HTTPS 文章页面使用，不要在工具、设置页或 PDF 页面使用。', long: '正文超过 120,000 字符，请改用粘贴并精简。' },
  vi: { intro: 'Mở bài viết bình thường rồi bấm đọc. Tự hoàn thành xác minh nếu có.', extract: 'Đọc bài viết hiện tại', titleLabel: 'Tiêu đề (có thể sửa)', bodyLabel: 'Xem trước nội dung (có thể sửa)', targetLabel: 'Gửi tới', privacy: 'Chỉ gửi tiêu đề, nội dung và liên kết hiển thị ở đây; không đọc cookie hay mật khẩu. Kiểm tra thông tin riêng tư trước khi gửi. Cần xác nhận trong công cụ.', send: 'Xác nhận và gửi', reading: 'Đang đọc trang…', ready: 'Kiểm tra nội dung và xóa phần không liên quan trước khi gửi.', sending: 'Đang kết nối, hãy giữ cửa sổ này mở…', sent: 'Đã gửi! Xác nhận thay nguồn trong công cụ.', failed: 'Không hoàn tất. Mở bản mới nhất của công cụ rồi thử lại hoặc dán nội dung.', blocked: 'Hãy đăng nhập hoặc hoàn thành xác minh bình thường trước.', empty: 'Không tìm thấy đủ nội dung. Kiểm tra bài đã hiển thị hoặc dán thủ công.', unsupported: 'Dùng trên trang bài viết HTTP/HTTPS, không phải trang công cụ, cài đặt hay PDF.', long: 'Nội dung vượt 120.000 ký tự. Hãy dán và rút gọn.' },
  en: { intro: 'Open the article normally, complete any verification, then read the page.', extract: 'Read current article', titleLabel: 'Title (editable)', bodyLabel: 'Article preview (editable)', targetLabel: 'Send to', privacy: 'Only this title, text and source URL are sent. No cookies or passwords are read. Check for private information before sending. Confirm the import inside the tool.', send: 'Confirm and send', reading: 'Reading current page…', ready: 'Check the text and remove unrelated content before sending.', sending: 'Connecting to the tool; keep this popup open…', sent: 'Delivered! Confirm source replacement inside the tool.', failed: 'Could not complete. Open the latest tool and retry, or paste the article.', blocked: 'Complete normal login or verification before reading.', empty: 'Not enough article text found. Check it is visible or paste manually.', unsupported: 'Use on an HTTP/HTTPS article, not the tool, a settings page or PDF.', long: 'Article exceeds 120,000 characters. Paste and shorten it instead.' }
};
let article = null;
let language = navigator.language.startsWith('vi') ? 'vi' : navigator.language.startsWith('zh') ? 'zh' : 'en';
$('language').value = language;
function render() { document.documentElement.lang = language; for (const id of ['intro', 'extract', 'titleLabel', 'bodyLabel', 'targetLabel', 'privacy', 'send']) $(id).textContent = copy[language][id]; }
function status(key) { $('status').textContent = copy[language][key]; }
function count() { $('count').textContent = `${$('body').value.length.toLocaleString()} / 120,000`; }
$('language').onchange = () => { language = $('language').value; render(); };
$('body').oninput = count;
$('extract').onclick = async () => {
  $('extract').disabled = true; $('preview').hidden = true; article = null; status('reading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol) || ['192.168.220.109', 'localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('UNSUPPORTED_PAGE');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: globalThis.polarisExtractArticle });
    if (result.error) throw new Error(result.error.message);
    article = result.result;
    if (!article?.text) throw new Error('NO_ARTICLE');
    $('title').value = article.title; $('body').value = article.text; $('url').textContent = article.sourceUrl;
    count(); $('preview').hidden = false; status('ready');
  } catch (error) {
    const message = String(error.message);
    status(message.includes('VERIFICATION_REQUIRED') ? 'blocked' : message.includes('ARTICLE_TOO_LONG') ? 'long' : message.includes('NO_ARTICLE') ? 'empty' : 'unsupported');
  } finally { $('extract').disabled = false; }
};
$('send').onclick = async () => {
  if (!article) return;
  const text = $('body').value.trim();
  if (text.length < 80) { status('empty'); return; }
  if (text.length > 120000) { status('long'); return; }
  $('send').disabled = true; $('extract').disabled = true; status('sending');
  try {
    const target = new URL($('target').value);
    const tabs = await chrome.tabs.query({ url: `${target.origin}/*` });
    let tab = tabs.find(t => { try { return new URL(t.url).pathname === '/'; } catch { return false; } });
    if (!tab) tab = await chrome.tabs.create({ url: target.href, active: false });
    let delivered = false;
    for (let i = 0; i < 25; i++) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'POLARIS_DELIVER_ARTICLE', article: { ...article, title: $('title').value.trim().slice(0, 500), text, characterCount: text.length } });
        if (result?.ok) { delivered = true; break; }
      } catch { /* New tab may still be loading. */ }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!delivered) throw new Error('DELIVERY_FAILED');
    status('sent'); await chrome.tabs.update(tab.id, { active: true });
  } catch { status('failed'); }
  finally { $('send').disabled = false; $('extract').disabled = false; }
};
render();
