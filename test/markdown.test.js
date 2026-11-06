import { describe, it, expect } from "vitest";
import { escapeHtml, renderMd } from "../src/markdown.js";

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
    expect(renderMd("**粗体**")).toBe("<strong>粗体</strong>");
  });
  it("斜体", () => {
    expect(renderMd("*斜体*")).toBe("<em>斜体</em>");
  });
  it("行内代码", () => {
    expect(renderMd("`code`")).toBe("<code>code</code>");
  });
  it("删除线", () => {
    expect(renderMd("~~删除~~")).toBe("<del>删除</del>");
  });
  it("自动链接带安全属性", () => {
    expect(renderMd("https://example.com")).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'
    );
  });
  it("http 也可链接", () => {
    expect(renderMd("http://a.cn")).toContain('<a href="http://a.cn"');
  });
  it("混排", () => {
    expect(renderMd("a **b** *c* `d` ~~e~~")).toBe(
      "a <strong>b</strong> <em>c</em> <code>d</code> <del>e</del>"
    );
  });
  it("多行换行保留（不因渲染丢失换行）", () => {
    expect(renderMd("第一行\n第二行")).toBe("第一行\n第二行");
  });
});

describe("XSS 反例（安全核心）", () => {
  it("script 标签整体转义", () => {
    expect(renderMd("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(renderMd("<script>alert(1)</script>")).not.toContain("<script");
  });
  it("img onerror 转义", () => {
    const out = renderMd("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("粗体内嵌 script 仍被转义", () => {
    expect(renderMd("**<script>**")).toBe("<strong>&lt;script&gt;</strong>");
  });
  it("已有 a 标签被转义而非复用", () => {
    const out = renderMd('<a href="javascript:alert(1)">a</a>');
    expect(out).not.toContain("<a href=\"javascript");
    expect(out).toBe("&lt;a href=&quot;javascript:alert(1)&quot;&gt;a&lt;/a&gt;");
  });
  it("闭合标签逃逸被转义", () => {
    expect(renderMd("</div><svg onload=alert(1)>")).toBe(
      "&lt;/div&gt;&lt;svg onload=alert(1)&gt;"
    );
  });
  it("代码内 script 仍转义", () => {
    expect(renderMd("`<script>`")).toBe("<code>&lt;script&gt;</code>");
  });
  it("javascript: 不生成链接", () => {
    expect(renderMd("javascript:alert(1)")).not.toContain("<a");
    expect(renderMd("[x](javascript:alert(1))")).not.toContain("<a");
  });
  it("引号属性逃逸被实体化", () => {
    const out = renderMd('" onmouseover="alert(1)');
    expect(out).not.toContain('onmouseover="');
    expect(out).toBe("&quot; onmouseover=&quot;alert(1)");
  });
  it("伪造占位符不产生注入", () => {
    const forged = "\u00000\u0000";
    const out = renderMd(forged);
    expect(out).not.toContain("<code>");
    expect(out).not.toContain("\u0000");
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
    expect(renderMd("*未闭合")).toBe("*未闭合");
    expect(renderMd("**未闭合")).toBe("**未闭合");
  });
  it("代码内不解析其他语法", () => {
    expect(renderMd("`**不是粗体**`")).toBe("<code>**不是粗体**</code>");
  });
  it("行内代码不跨行", () => {
    expect(renderMd("`a\nb`")).toBe("`a\nb`");
  });
  it("超长文本不抛异常", () => {
    const long = "**x**".repeat(500);
    expect(() => renderMd(long)).not.toThrow();
    expect(renderMd(long)).toContain("<strong>x</strong>");
  });
  it("小于号在代码内不丢字符", () => {
    expect(renderMd("`a < b`")).toBe("<code>a &lt; b</code>");
  });
  it("非字符串输入不抛异常", () => {
    expect(() => renderMd(null)).not.toThrow();
    expect(() => renderMd(undefined)).not.toThrow();
  });
});

describe("注入自包含性（toString 注入约束）", () => {
  it("renderMd 不依赖模块内其他标识符", () => {
    const src = renderMd.toString();
    // 若调用 escapeHtml 等外部函数，注入内嵌页面后会 ReferenceError
    expect(src).not.toMatch(/[^.\w]escapeHtml\s*\(/);
  });
  it("toString 结果可独立求值执行", () => {
    const fn = new Function("return " + renderMd.toString())();
    expect(fn("**x**")).toBe("<strong>x</strong>");
  });
  it("不含嵌套函数声明（防 esbuild 注入 __name）", () => {
    // wrangler 打包会把嵌套箭头/函数声明改写成 __name(...)，
    // 而 __name 在内联 <script> 中不存在，会让整个聊天脚本崩溃。已实测踩中。
    const src = renderMd.toString();
    expect(src).not.toContain("__name");
    // 任何箭头函数都不允许（无论参数与体形式）
    expect(src).not.toContain("=>");
    // 不允许 "x = function" 形式的具名赋值；replace 回调用的是裸 function (…)
    expect(src).not.toMatch(/=\s*function\b/);
  });
  it("行内代码回填不被误认（数字内容）", () => {
    // 回填若借用 <code>N</code> 中转，会错配用户真实的 `123`
    expect(renderMd("`123`")).toBe("<code>123</code>");
    expect(renderMd("`1` `2`")).toBe("<code>1</code> <code>2</code>");
    expect(renderMd("`0` `0`")).toBe("<code>0</code> <code>0</code>");
  });
});
