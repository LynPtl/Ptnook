// 最小 Markdown 渲染：块级 + 行内。零依赖。
//
// 安全模型：先整体转义，再仅对白名单标记套标签。
// 用户文本只出现在标签内容位置，从不进入属性位置，
// 故无需通用 sanitizer（见 docs/superpowers/specs/2026-11-06-markdown-render-design.md）。
//
// 本文件是**唯一源**，经 `[assets]` 以静态资源 /markdown.js 提供，
// 前端用 `<script type="module">import { renderMd } from "/markdown.js"` 引入。
// 早期版本通过 renderMd.toString() 内联注入，导致函数体内不得出现任何嵌套函数
// （esbuild keepNames 会插入 __name(...)，在内联脚本中 ReferenceError），
// 块级解析无法实现；迁移到 ES module 后该约束已解除，此处可自由使用辅助函数。

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// ---- 行内渲染 ----
// 输入的 line 已经过 HTML 转义，不含 < > " ' &。

// 字符类别：空白 / 标点 / 其他（按 CommonMark 的 Unicode 定义近似）
function isSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}
function isPunct(ch) {
  return ch !== undefined && /[!-/:-@[-`{-~]/.test(ch);
}

// CommonMark 分隔符链（delimiter run）判定：
// 左分隔符（可开标记）：右侧不是空白，且（右侧不是标点 或 左侧是空白/标点）
// 右分隔符（可闭标记）：左侧不是空白，且（左侧不是标点 或 右侧是空白/标点）
// 这使「空格 * 空格」与「5 * 3 * 2」中的 * 两侧都不成立，不再误配为斜体。
function canOpen(before, after) {
  if (isSpace(after)) return false;
  if (!isPunct(after)) return true;
  return isSpace(before) || isPunct(before);
}
function canClose(before, after) {
  if (isSpace(before)) return false;
  if (!isPunct(before)) return true;
  return isSpace(after) || isPunct(after);
}

// 统一处理 * 与 **：扫描出所有分隔符链，用栈按「从内到外」配对。
// 单次扫描而非两条 replace，保证 **a *b* c** 能正确嵌套。
const RE_EMPH = /\*+/g;
const EM_TAGS = { 1: "em", 2: "strong" };

// 强调解析：逐个 * 字符判定，按 CommonMark 分隔符规则配对，支持嵌套。
// 不用位置算术、不用事后排序——每个 * 字符直接标注它属于哪个配对的
// 「开」「闭」或「原文保留」，然后一次拼接，从根本上避免偏移与排序歧义。
// 强调解析：对称优先、由内到外。
//
// 策略（由用户确认）：
//   1. 先找「最内层」「两侧标记数对称」的配对：**x** 或 *x*（含 ***x***）。
//      对称 = 开闭两侧 * 数量相同，因此 **a *b* c** 会先命中内层 *b*。
//   2. 命中的内容替换为占位符并登记，后续迭代不再看到它。
//   3. 重复直到无可配对。这天然实现「从中间向外」的嵌套顺序。
//   4. 不跨越手动换行（\n）：每个 \n 之间独立成段，避免长文本里
//      跨越段落去找对称标记产生误配。
//
// 分隔符判定（沿用 CommonMark 近似）：
//   - 开标记右侧不能是空白
//   - 闭标记左侧不能是空白
//   这使 `5 * 3 * 2 = 30` 里的 * 两侧都是空白，不会被当作斜体。
function renderEmphasis(text) {
  if (text.indexOf("*") < 0) return text;

  const slots = [];
  // 占位符用 \u0001 包裹。\u0000/\u0001/\u0002 均在 renderMd 入口处从
  // 原文剔除，用户无法伪造。
  const PH_OPEN = "\u0001";
  const PH_CLOSE = "\u0002";

  function protect(html) {
    slots.push(html);
    return PH_OPEN + (slots.length - 1) + PH_CLOSE;
  }

  // 对称配对正则，按「内侧优先」顺序尝试。
  // 内容里不允许出现任何 *，保证命中的是最内层（已保护的部分不含 *）。
  const PATTERNS = [
    { re: /\*\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*\*/g, name: "both" },
    { re: /\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, name: "strong" },
    { re: /(^|[^*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, name: "em" },
  ];

  let prev;
  do {
    prev = text;
    for (const { re, name } of PATTERNS) {
      re.lastIndex = 0;
      text = text.replace(re, (m, a, b) => {
        if (name === "em") {
          // 保留前置字符 a，中间内容 b
          return a + protect("<em>" + b + "</em>");
        }
        const inner = name === "both"
          ? "<em><strong>" + m.slice(3, -3) + "</strong></em>"
          : "<strong>" + m.slice(2, -2) + "</strong>";
        return protect(inner);
      });
    }
  } while (text !== prev);

  // 回填占位符
  let guard = 0;
  while (text.indexOf(PH_OPEN) >= 0 && guard++ < slots.length + 2) {
    text = text.replace(/\u0001(\d+)\u0002/g, (m, i) => slots[Number(i)]);
  }
  return text;
}

function renderInline(line) {
  if (!line) return "";

  // 1. 行内代码抽为占位符，内部不再解析其他语法。
  //    占位符用 U+0000 包裹且原文 NUL 已被剔除，用户无法伪造。
  const slots = [];
  let s = line.replace(/`([^`\n]+)`/g, (m, code) => {
    slots.push(code);
    return "\u0000" + (slots.length - 1) + "\u0000";
  });

  // 2. 强调与删除线（分隔符链判定，支持嵌套）
  s = renderEmphasis(s);
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  // 3. 自动链接：仅 http/https。
  //    安全：排除 < > ` " 与其后的全角终止符，避免把上一步生成的
  //    </strong> 等闭合标签或 code 占位符边界吞进 href。
  //    中文/全角标点在**匹配阶段**即终止（否则贪婪匹配会越过），
  //    ASCII 句末标点则在匹配后从尾部剥离（URL 内部允许 . 与 ()）。
  s = s.replace(/(https?:\/\/[^\s<>`"，。；：！？、）】」』…]+)/gi, (m) => {
    let url = m;
    let prev;
    do {
      prev = url;
      url = url.replace(/[.,;:!?'*~_\]]+$/, "");
    } while (url !== prev && url.length > 0);
    // 剥不成对的尾部右括号，成对的（如维基链接）保留
    while (
      url.endsWith(")") &&
      url.split("(").length - 1 < url.split(")").length - 1
    ) {
      url = url.slice(0, -1);
    }
    if (url === "https://" || url === "http://") return m;
    const tail = m.slice(url.length);
    return (
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>" + tail
    );
  });

  // 4. 回填行内代码
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + slots[Number(i)] + "</code>");
}

// ---- 块级识别（在**未转义**原文上进行，避免 &gt; 干扰引用识别）----
// 均允许最多 3 个行首空格（CommonMark 规范），容忍移动端输入法/粘贴带来的前置空格。
const IND = " {0,3}";
const RE_HEADING = new RegExp("^" + IND + "(#{1,6})[\\t ]+(.*)$");
const RE_UL = new RegExp("^" + IND + "[-*+][\\t ]+(.*)$");
const RE_OL = new RegExp("^" + IND + "\\d{1,9}[.)][\\t ]+(.*)$");
// 分割线：三个以上相同标记，标记之间允许空格（CommonMark 认可 - - - / * * * / _ _ _）
const RE_HR = new RegExp("^" + IND + "(?:(?:-[ \\t]*){3,}|(?:\\*[ \\t]*){3,}|(?:_[ \\t]*){3,})$");
const RE_QUOTE = new RegExp("^" + IND + ">[\\t ]?(.*)$");

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

function isBlockStart(line) {
  return (
    RE_HEADING.test(line) ||
    RE_HR.test(line.trim()) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line) ||
    isFence(line)
  );
}

// 引用/列表项多行合并用空格；段落保留换行（.body 已是 pre-wrap）。
function joinLines(lines) {
  return lines.join(" ");
}

export function renderMd(raw) {
  if (typeof raw !== "string") return "";

  // 1. 剔除所有用作内部占位符的控制字符，防止用户伪造占位符。
  //    \u0000 用于行内代码占位；\u0001/\u0002 用于强调嵌套保护。
  let cleaned = raw.replace(/[\u0000\u0001\u0002]/g, "");
  // 1b. 换行归一化：\r\n 与孤立 \r 统一为 \n。
  //     Windows 浏览器 / 粘贴内容可能带 \r，残留会让所有块级正则失效
  //     （标题、列表、引用全部退化成普通段落）。已实测踩中。
  cleaned = cleaned.replace(/\r\n?/g, "\n");

  // 2. 按行识别块级结构。此阶段**不转义**：
  //    转义会把 > 变成 &gt;，使引用正则失效；且块级标记本身
  //    （# - 1. > ``` ---）不含需转义字符。行内容统一走 escapeHtml。
  const lines = cleaned.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行：块分隔
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // 围栏代码块：整体抽走，内部只转义、不解析
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const firstRest = fence[2];
      const buf = [];
      // 单行围栏 ```x``` ：开闭同一行
      const inlineClose = firstRest.match(/^(.*?)(`{3,}|~{3,})\s*$/);
      if (inlineClose && firstRest.trim()) {
        out.push("<pre><code>" + escapeHtml(inlineClose[1].trim()) + "</code></pre>");
        i++;
        continue;
      }
      i++;
      let closed = false;
      while (i < lines.length) {
        const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === marker && close[1].length >= len) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      if (!closed) {
        // 未闭合围栏：回退到围栏起始行，按普通段落处理
        i = i - buf.length - 1;
        out.push("<p>" + renderInline(escapeHtml(lines.slice(i, i + buf.length + 1).join("\n"))) + "</p>");
        i = i + buf.length + 1;
        continue;
      }
      out.push("<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
      continue;
    }

    // 分割线（必须先于列表判断，否则 --- 会被当成列表项）
    if (RE_HR.test(line.trim())) {
      out.push("<hr>");
      i++;
      continue;
    }

    // ATX 标题
    const h = line.match(RE_HEADING);
    if (h) {
      const level = h[1].length;
      out.push("<h" + level + ">" + renderInline(escapeHtml(h[2].trim())) + "</h" + level + ">");
      i++;
      continue;
    }

    // 引用：连续 > 行合并
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].match(RE_QUOTE)[1]);
        i++;
      }
      out.push("<blockquote>" + renderInline(escapeHtml(joinLines(buf))) + "</blockquote>");
      continue;
    }

    // 无序列表
    if (RE_UL.test(line)) {
      const buf = [];
      while (i < lines.length && RE_UL.test(lines[i]) && !RE_HR.test(lines[i].trim())) {
        buf.push(lines[i].match(RE_UL)[1]);
        i++;
      }
      out.push(
        "<ul>" +
          buf.map((t) => "<li>" + renderInline(escapeHtml(t)) + "</li>").join("") +
          "</ul>"
      );
      continue;
    }

    // 有序列表
    if (RE_OL.test(line)) {
      const buf = [];
      while (i < lines.length && RE_OL.test(lines[i])) {
        buf.push(lines[i].match(RE_OL)[1]);
        i++;
      }
      out.push(
        "<ol>" +
          buf.map((t) => "<li>" + renderInline(escapeHtml(t)) + "</li>").join("") +
          "</ol>"
      );
      continue;
    }

    // 段落：连续非空、非块级起始的行
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      out.push("<p>" + renderInline(escapeHtml(buf.join("\n"))) + "</p>");
    } else {
      // 保底避免死循环
      i++;
    }
  }

  return out.join("");
}
