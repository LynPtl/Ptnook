// 最小内联 Markdown 渲染。零依赖。
//
// 安全模型：先整体转义，再仅对白名单标记套标签。
// 用户文本只出现在标签内容位置，从不进入属性位置，
// 故无需通用 sanitizer（见 docs/superpowers/specs/2026-11-06-markdown-render-design.md）。
//
// 约束一：renderMd 经 toString() 注入内嵌前端，必须是自包含单函数，
//         不可调用本模块内其他标识符（否则浏览器端 ReferenceError）。
// 约束二：renderMd 体内**不得出现任何嵌套函数声明/箭头函数**。
//         wrangler 打包（esbuild, keepNames）会把它们改写成 __name(...) 调用，
//         而该辅助函数在内联 <script> 中不存在，会导致整段脚本崩溃。
//         已实测踩中，故全部改为内联正则替换表达式。测试固化该约束。

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// 对外导出版（供测试/其他用途）。renderMd 内部另行内联，不复用此函数。
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function renderMd(raw) {
  if (typeof raw !== "string") return "";

  // 1. 剔除 NUL，防止伪造行内代码占位符
  var s = raw.replace(/\u0000/g, "");
  // 2. 全量转义（此后输入不含 < > " ' &，无法构造标签或属性）
  s = s.replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });

  // 3. 行内代码抽为占位符，避免内部语法被继续解析
  var slots = [];
  s = s.replace(/`([^`\n]+)`/g, function (m, code) {
    slots.push(code);
    return "\u0000" + (slots.length - 1) + "\u0000";
  });

  // 4. 白名单内联标记
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  // 5. 自动链接：仅 http/https（正则已保证），属性由常量模板拼接
  s = s.replace(/(https?:\/\/[^\s]+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  // 6. 回填行内代码（占位符仅由步骤 3 产生，序号可靠）
  return s.replace(/\u0000(\d+)\u0000/g, function (m, i) {
    return "<code>" + slots[Number(i)] + "</code>";
  });
}
