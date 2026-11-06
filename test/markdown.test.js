import { describe, it, expect } from "vitest";
import { escapeHtml, renderMd } from "../public/markdown.js";

describe("escapeHtml", () => {
  it("五个危险字符全部实体化", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });
  it("普通文本不变", () => {
    expect(escapeHtml("你好 abc 123")).toBe("你好 abc 123");
  });
});

describe("Markdown 语法正例", () => {
  it("粗体", () => {
    expect(renderMd("**粗体**")).toBe("<p><strong>粗体</strong></p>");
  });
  it("斜体", () => {
    expect(renderMd("*斜体*")).toBe("<p><em>斜体</em></p>");
  });
  it("行内代码", () => {
    expect(renderMd("`code`")).toBe("<p><code>code</code></p>");
  });
  it("删除线", () => {
    expect(renderMd("~~删除~~")).toBe("<p><del>删除</del></p>");
  });
  it("自动链接带安全属性", () => {
    expect(renderMd("https://example.com")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a></p>'
    );
  });
  it("http 也可链接", () => {
    expect(renderMd("http://a.cn")).toContain('<a href="http://a.cn"');
  });
  it("混排", () => {
    expect(renderMd("a **b** *c* `d` ~~e~~")).toBe(
      "<p>a <strong>b</strong> <em>c</em> <code>d</code> <del>e</del></p>"
    );
  });
  it("多行换行保留（不因渲染丢失换行）", () => {
    expect(renderMd("第一行\n第二行")).toBe("<p>第一行\n第二行</p>");
  });
});

describe("自动链接 href 边界（回归）", () => {
  // 历史缺陷：[^\s]+ 会把前一步生成的闭合标签吞进 href，
  // 产出 href="https://example.com</strong>"，点击得到无效地址。
  function hrefOf(input) {
    const m = renderMd(input).match(/href="([^"]*)"/);
    return m && m[1];
  }
  it("裸链接 href 严格等于 URL", () => {
    expect(hrefOf("https://example.com")).toBe("https://example.com");
  });
  it("粗体包裹时 href 不含 </strong>", () => {
    expect(hrefOf("**https://example.com**")).toBe("https://example.com");
  });
  it("删除线包裹时 href 不含 </del>", () => {
    expect(hrefOf("~~https://example.com~~")).toBe("https://example.com");
  });
  it("斜体包裹时 href 不含 </em>", () => {
    expect(hrefOf("*https://example.com*")).toBe("https://example.com");
  });
  it("行内代码包裹时不产出链接", () => {
    expect(renderMd("`https://example.com`")).toBe("<p><code>https://example.com</code></p>");
  });
  it("链接后紧跟中文标点不吞入", () => {
    expect(hrefOf("看 https://example.com，还有")).toBe("https://example.com");
  });
});

describe("XSS 反例（安全核心）", () => {
  it("script 标签整体转义", () => {
    expect(renderMd("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
    expect(renderMd("<script>alert(1)</script>")).not.toContain("<script");
  });
  it("img onerror 转义", () => {
    const out = renderMd("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });
  it("粗体内嵌 script 仍被转义", () => {
    expect(renderMd("**<script>**")).toBe("<p><strong>&lt;script&gt;</strong></p>");
  });
  it("已有 a 标签被转义而非复用", () => {
    const out = renderMd('<a href="javascript:alert(1)">a</a>');
    expect(out).not.toContain("<a href=\"javascript");
    expect(out).toBe("<p>&lt;a href=&quot;javascript:alert(1)&quot;&gt;a&lt;/a&gt;</p>");
  });
  it("闭合标签逃逸被转义", () => {
    expect(renderMd("</div><svg onload=alert(1)>")).toBe(
      "<p>&lt;/div&gt;&lt;svg onload=alert(1)&gt;</p>"
    );
  });
  it("代码内 script 仍转义", () => {
    expect(renderMd("`<script>`")).toBe("<p><code>&lt;script&gt;</code></p>");
  });
  it("javascript: 不生成链接", () => {
    expect(renderMd("javascript:alert(1)")).not.toContain("<a");
    expect(renderMd("[x](javascript:alert(1))")).not.toContain("<a");
  });
  it("引号属性逃逸被实体化", () => {
    const out = renderMd('" onmouseover="alert(1)');
    expect(out).not.toContain('onmouseover="');
    expect(out).toBe("<p>&quot; onmouseover=&quot;alert(1)</p>");
  });
  it("伪造占位符不产生注入", () => {
    const forged = "\u00000\u0000";
    const out = renderMd(forged);
    expect(out).not.toContain("<code>");
    expect(out).not.toContain("\u0000");
  });
  it("伪造强调占位符不复制已渲染内容", () => {
    // 强调嵌套的占位符用 \u0001/\u0002，若未剔除则可命中 slots[i] 复制内容。
    // 剔除后仅剩普通字符 "0"，不得出现额外的 <strong>a</strong>。
    expect(renderMd("**a**\u00010\u0002")).toBe("<p><strong>a</strong>0</p>");
    expect(renderMd("**a**\u00010\u0002").match(/<strong>/g)).toHaveLength(1);
    expect(renderMd("\u00010\u0002")).toBe("<p>0</p>");
    expect(renderMd("**a**")).not.toContain("\u0001");
  });
  it("链接 URL 中的引号无法闭合属性", () => {
    const out = renderMd('https://a.com/"onmouseover="alert(1)');
    const href = out.match(/href="([^"]*)"/);
    expect(href).not.toBeNull();
    // href 值内不得出现裸双引号
    expect(href[1]).not.toContain('"');
  });
  it("链接中的 & 正确实体化（属性语义）", () => {
    expect(renderMd("https://a.com/?x=1&y=2")).toContain("x=1&amp;y=2");
  });
});

describe("边界与回归", () => {
  it("空字符串", () => {
    expect(renderMd("")).toBe("");
  });
  it("未闭合标记原样保留", () => {
    expect(renderMd("*未闭合")).toBe("<p>*未闭合</p>");
    expect(renderMd("**未闭合")).toBe("<p>**未闭合</p>");
  });
  it("代码内不解析其他语法", () => {
    expect(renderMd("`**不是粗体**`")).toBe("<p><code>**不是粗体**</code></p>");
  });
  it("行内代码不跨行", () => {
    expect(renderMd("`a\nb`")).toBe("<p>`a\nb`</p>");
  });
  it("超长文本不抛异常", () => {
    const long = "**x**".repeat(500);
    expect(() => renderMd(long)).not.toThrow();
    expect(renderMd(long)).toContain("<strong>x</strong>");
  });
  it("小于号在代码内不丢字符", () => {
    expect(renderMd("`a < b`")).toBe("<p><code>a &lt; b</code></p>");
  });
  it("非字符串输入不抛异常", () => {
    expect(() => renderMd(null)).not.toThrow();
    expect(() => renderMd(undefined)).not.toThrow();
  });
});

describe("块级语法", () => {
  it("ATX 标题 h1-h6", () => {
    expect(renderMd("# 标题")).toBe("<h1>标题</h1>");
    expect(renderMd("## 二级")).toBe("<h2>二级</h2>");
    expect(renderMd("###### 六级")).toBe("<h6>六级</h6>");
  });
  it("七级不成标题，按段落处理", () => {
    expect(renderMd("####### 七级")).toBe("<p>####### 七级</p>");
  });
  it("无井号空格不是标题", () => {
    expect(renderMd("#标签")).toBe("<p>#标签</p>");
  });
  it("无序列表 - 与 *", () => {
    expect(renderMd("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMd("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });
  it("有序列表", () => {
    expect(renderMd("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  it("引用", () => {
    expect(renderMd("> 引用")).toBe("<blockquote>引用</blockquote>");
    expect(renderMd("> 第一行\n> 第二行")).toBe("<blockquote>第一行 第二行</blockquote>");
  });
  it("分割线 --- 与 ***", () => {
    expect(renderMd("---")).toBe("<hr>");
    expect(renderMd("***")).toBe("<hr>");
    expect(renderMd("___")).toBe("<hr>");
  });
  it("分割线允许标记之间带空格", () => {
    // CommonMark 认可这三种；旧实现只认连续三个，会误当成列表项
    expect(renderMd("- - -")).toBe("<hr>");
    expect(renderMd("* * *")).toBe("<hr>");
    expect(renderMd("_ _ _")).toBe("<hr>");
    expect(renderMd("-  -  -")).toBe("<hr>");
  });
  it("分割线优先级高于列表", () => {
    expect(renderMd("- - -")).not.toContain("<ul>");
    expect(renderMd("* * *")).not.toContain("<ul>");
  });
  it("列表内的普通项不受影响", () => {
    expect(renderMd("- -")).toBe("<ul><li>-</li></ul>");
    expect(renderMd("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    // CommonMark §4.1："If any line is a thematic break then that line is not a list item."
    // 故 `- ---` 整体构成分割线，而非列表项。
    expect(renderMd("- ---")).toBe("<hr>");
  });
  it("围栏代码块内不解析内联语法", () => {
    expect(renderMd("```\n**星号**\n```")).toBe("<pre><code>**星号**</code></pre>");
    expect(renderMd("```x```")).toBe("<pre><code>x</code></pre>");
    expect(renderMd("```\n*a* ~~b~~ https://a.com\n```")).toBe(
      "<pre><code>*a* ~~b~~ https://a.com</code></pre>"
    );
  });
  it("围栏内 HTML 仍转义", () => {
    expect(renderMd("```\n<script>alert(1)</script>\n```")).toBe(
      "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>"
    );
  });
  it("未闭合围栏原样保留", () => {
    expect(renderMd("```\na")).toBe("<p>```\na</p>");
  });
  it("普通文本包成段落", () => {
    expect(renderMd("正文")).toBe("<p>正文</p>");
    expect(renderMd("第一行\n第二行")).toBe("<p>第一行\n第二行</p>");
  });
  it("空块跳过，不产生空段落", () => {
    expect(renderMd("\n\n")).toBe("");
    expect(renderMd("a\n\nb")).toBe("<p>a</p><p>b</p>");
  });
  it("块级内可含内联标记", () => {
    expect(renderMd("# **粗体**标题")).toBe("<h1><strong>粗体</strong>标题</h1>");
    expect(renderMd("- **a** 和 *b*")).toBe("<ul><li><strong>a</strong> 和 <em>b</em></li></ul>");
  });
  it("块级元素内的链接 href 严格等于 URL", () => {
    expect(renderMd("- **https://example.com**")).toBe(
      '<ul><li><strong><a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a></strong></li></ul>'
    );
    expect(renderMd("# https://example.com")).toContain('href="https://example.com"');
  });
  it("块级内 XSS 仍被转义", () => {
    expect(renderMd("# <img src=x onerror=alert(1)>")).toBe(
      "<h1>&lt;img src=x onerror=alert(1)&gt;</h1>"
    );
    expect(renderMd("> <script>alert(1)</script>")).toBe(
      "<blockquote>&lt;script&gt;alert(1)&lt;/script&gt;</blockquote>"
    );
  });
});

describe("斜体分隔符判定（乘号不误配）", () => {
  // 根因：旧规则 (^|[^*])\*([^*\n]+)\* 只看两侧各有一个 *，
  // 不判断两侧字符性质，故「空格 * 空格」也被当成斜体。
  it("乘法表达式不产生 em", () => {
    expect(renderMd("5 * 3 * 2 = 30")).toBe("<p>5 * 3 * 2 = 30</p>");
    expect(renderMd("2 * 3 * 4 * 5")).toBe("<p>2 * 3 * 4 * 5</p>");
    expect(renderMd("时间 10 * 20 * 30")).toBe("<p>时间 10 * 20 * 30</p>");
    expect(renderMd("a * b * c")).toBe("<p>a * b * c</p>");
  });
  it("开标记右侧不能是空白", () => {
    // 注意：行首 "* " 会被块级层识别为列表项，故用行内位置构造
    expect(renderMd("x * 不是斜体* y")).toBe("<p>x * 不是斜体* y</p>");
  });
  it("闭标记左侧不能是空白", () => {
    expect(renderMd("*不是斜体 *")).toBe("<p>*不是斜体 *</p>");
  });
  it("紧贴文字仍正常斜体", () => {
    expect(renderMd("a*b*c")).toBe("<p>a<em>b</em>c</p>");
    expect(renderMd("*a* *b*")).toBe("<p><em>a</em> <em>b</em></p>");
    expect(renderMd("中文*斜体*文字")).toBe("<p>中文<em>斜体</em>文字</p>");
  });
  it("粗体不受影响", () => {
    expect(renderMd("**a b**")).toBe("<p><strong>a b</strong></p>");
    expect(renderMd("**a** **b**")).toBe("<p><strong>a</strong> <strong>b</strong></p>");
  });
});

describe("粗体内嵌斜体（嵌套）", () => {
  // 根源：旧实现先跑 ** 后跑 *，但 * 规则会把 **a *b* c** 的内层吃掉，
  // 之后外层 ** 再无法配对。需按分隔符链从内到外处理。
  it("**a *b* c** 同时生效", () => {
    expect(renderMd("**a *b* c**")).toBe(
      "<p><strong>a <em>b</em> c</strong></p>"
    );
  });
  it("斜体内嵌粗体", () => {
    expect(renderMd("*a **b** c*")).toBe(
      "<p><em>a <strong>b</strong> c</em></p>"
    );
  });
  it("嵌套不影响外层紧邻语法", () => {
    expect(renderMd("**a *b* c** 和 *d*")).toBe(
      "<p><strong>a <em>b</em> c</strong> 和 <em>d</em></p>"
    );
  });
  it("嵌套内仍不解析标记字符本身", () => {
    expect(renderMd("**a `*b*` c**")).toBe(
      "<p><strong>a <code>*b*</code> c</strong></p>"
    );
  });
  it("嵌套中的 XSS 仍转义", () => {
    expect(renderMd("**a *<script>* c**")).toBe(
      "<p><strong>a <em>&lt;script&gt;</em> c</strong></p>"
    );
  });
  it("紧贴混合嵌套按对称原则由内到外", () => {
    // 对称优先：先命中内层 **b**，再处理外层 *a ... c*
    expect(renderMd("*a**b**c*")).toBe("<p><em>a<strong>b</strong>c</em></p>");
  });
  it("三连星号同时产生粗体与斜体", () => {
    expect(renderMd("***a***")).toBe("<p><em><strong>a</strong></em></p>");
  });
  it("嵌套不跨越手动换行", () => {
    // 长文本下跨段落找对称标记会误配，故每个 \n 之间独立
    expect(renderMd("**a\n*b*")).toBe("<p>**a\n<em>b</em></p>");
    expect(renderMd("a * b\nc * d")).toBe("<p>a * b\nc * d</p>");
  });
});

describe("CRLF 与缩进容错（Windows 输入）", () => {
  // 浏览器 textarea 在 Windows 上可能提交 \r\n。\r 残留会让所有块级正则失效，
  // 标题/列表/引用全部退化成普通段落（已实测踩中）。
  it("CRLF 下的标题", () => {
    expect(renderMd("# 标题\r\n")).toBe("<h1>标题</h1>");
    expect(renderMd("# 标题\r")).toBe("<h1>标题</h1>");
  });
  it("CRLF 下的列表", () => {
    expect(renderMd("- 项一\r\n- 项二")).toBe("<ul><li>项一</li><li>项二</li></ul>");
    expect(renderMd("1. a\r\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  it("CRLF 下的引用与围栏", () => {
    expect(renderMd("> 引用\r\n> 第二行")).toBe("<blockquote>引用 第二行</blockquote>");
    expect(renderMd("```\r\nx\r\n```")).toBe("<pre><code>x</code></pre>");
  });
  it("CRLF 混排整体正确", () => {
    const crlf = "# 标题\r\n- 项一\r\n- 项二\r\n> 引用\r\n---\r\n```\r\nx\r\n```";
    const lf = crlf.replace(/\r/g, "");
    expect(renderMd(crlf)).toBe(renderMd(lf));
    expect(renderMd(crlf)).toBe(
      "<h1>标题</h1><ul><li>项一</li><li>项二</li></ul><blockquote>引用</blockquote><hr><pre><code>x</code></pre>"
    );
  });
  it("单独车符不残留到输出", () => {
    expect(renderMd("正文\r")).not.toContain("\r");
    expect(renderMd("a\rb")).not.toContain("\r");
  });
  it("列表项允许行首缩进", () => {
    // 移动端输入法 / 粘贴常见前置空格
    expect(renderMd(" - 项一\n - 项二")).toBe("<ul><li>项一</li><li>项二</li></ul>");
    expect(renderMd("  1. a\n  2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
});

describe("块内行内代码与占位符", () => {
  it("行内代码回填不被误认（数字内容）", () => {
    // 回填若借用 <code>N</code> 中转，会错配用户真实的 `123`
    expect(renderMd("`123`")).toBe("<p><code>123</code></p>");
    expect(renderMd("`1` `2`")).toBe("<p><code>1</code> <code>2</code></p>");
    expect(renderMd("`0` `0`")).toBe("<p><code>0</code> <code>0</code></p>");
  });
});
