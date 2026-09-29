// DEFECT-014 — research quality / web_fetch focus & honesty.
//
// The extractor must prefer <article>/<main>/[role=main] content over
// boilerplate, annotate CSS-hidden static text, and window the extracted text
// via offset/truncated/nextOffset so the model can keep reading the same page.
import assert from "node:assert/strict";
import { extractTextFromHtml, executeWebFetch, HIDDEN_STATIC_CONTENT_NOTE } from "../src/agent/web-fetch";
import { TOOL_web_fetch } from "../src/agent/tools";
import { toolCtx, mockConnectorFetch } from "./helpers/connectors-testkit";

console.log("▶ DEFECT-014 web fetch focus");

const FIXTURE = `<!doctype html>
<html><head><title>Research Page</title>
<style>.ad { display:none } .x { visibility:hidden }</style>
</head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<header><h1>Site Brand</h1></header>
<aside>Sidebar promo text that is boilerplate</aside>
<div style="display:none">invisible tracking words</div>
<div style="visibility:hidden">hidden counter text</div>
<article>
<h1>Real Article Heading</h1>
<p>First paragraph of the actual research content with the key finding.</p>
<p>Second paragraph with deeper analysis.</p>
</article>
<footer>Copyright 2026 ExampleCorp. All rights reserved.</footer>
</body></html>`;

console.log("  [1] article/main content preferred over nav/header/aside/footer boilerplate");
{
  const { title, text } = extractTextFromHtml(FIXTURE);
  assert.equal(title, "Research Page");
  assert.ok(text.includes("Real Article Heading"), "正文必须保留 article 标题");
  assert.ok(text.includes("First paragraph of the actual research content"), "正文必须保留段落");
  assert.ok(!text.includes("Site Brand"), "header 样板不得混入");
  assert.ok(!text.includes("Sidebar promo"), "aside 样板不得混入");
  assert.ok(!text.includes("Copyright 2026"), "footer 样板不得混入");
  assert.ok(!text.includes("Home"), "nav 不得混入");
  console.log("    ✅ article extracted; nav/header/aside/footer excluded");
}

console.log("  [2] <main> and div[role=main] fallbacks");
{
  const mainHtml = '<html><body><nav>nav words</nav><main><p>Main region content is here.</p></main></body></html>';
  const roleHtml = '<html><body><div role="main"><p>Role-main region content.</p></div></body></html>';
  assert.ok(extractTextFromHtml(mainHtml).text.includes("Main region content"), "<main> 必须被优先提取");
  assert.ok(!extractTextFromHtml(mainHtml).text.includes("nav words"), "<main> 之外的样板不得混入");
  assert.ok(extractTextFromHtml(roleHtml).text.includes("Role-main region content"), "div[role=main] 必须被优先提取");
  // No marked region → old whole-page behaviour, boilerplate stripped tag-wise.
  const plain = extractTextFromHtml("<html><body><p>Just a paragraph.</p></body></html>");
  assert.ok(plain.text.includes("Just a paragraph."));
  console.log("    ✅ <main> and role=main honoured; unmarked pages unchanged");
}

console.log("  [3] hidden display:none / visibility:hidden content is annotated");
{
  // Whole-page extraction (no marked main region) keeps the static hidden
  // text — that is exactly the case the honesty marker must cover.
  const wholePage = extractTextFromHtml(
    '<html><body><div style="display:none">invisible tracking words</div>' +
    '<div style="visibility:hidden">hidden counter text</div>' +
    "<p>visible paragraph</p></body></html>",
  );
  assert.ok(wholePage.text.includes("invisible tracking words"), "隐藏文本属于页面静态内容，会进入提取文本——必须让模型知情");
  assert.ok(wholePage.text.includes("hidden counter text"));
  const clean = extractTextFromHtml("<html><body><p>clean page</p></body></html>");
  assert.ok(!clean.text.includes("note:"), "无隐藏内容的页面不得误标");
  // The runtime annotation marker is stable and exported.
  assert.equal(HIDDEN_STATIC_CONTENT_NOTE, "[note: page contains hidden/static content; JavaScript was not executed]");
  console.log("    ✅ hidden text detected + stable marker exported");
}

// Deterministic long article: each paragraph carries a unique numeric marker.
function longArticle(paragraphs: number): string {
  const para = (i: number) => `<p>PARA_${String(i).padStart(4, "0")} The study examines long-form extraction behaviour in detail.</p>`;
  return `<html><head><style>.x{display:none}</style></head><body><article>${Array.from({ length: paragraphs }, (_, i) => para(i)).join("\n")}</article></body></html>`;
}

console.log("  [4] runtime fetch: default 12000 window, truncated/nextOffset, hidden-content note, offset continuation");
{
  const mock = mockConnectorFetch([
    { match: "long-form.test", reply: () => ({ status: 200, raw: new Response(longArticle(400), { status: 200, headers: { "content-type": "text/html" } }) }) },
  ]);
  try {
    const r1 = await executeWebFetch("https://long-form.test/article");
    assert.equal(r1.status, 200);
    assert.ok(r1.text.includes("PARA_0000"), "第一窗口从正文开头开始");
    assert.equal(r1.truncated, true, "默认窗口应该截断长文");
    assert.ok(r1.nextOffset !== undefined && r1.nextOffset > 0, "truncated 时必须给出 nextOffset");
    assert.ok(r1.text.includes(HIDDEN_STATIC_CONTENT_NOTE), "页面含 display:none 时必须附加隐藏内容标注");
    const body1 = r1.text.replace(HIDDEN_STATIC_CONTENT_NOTE, "").trimEnd();
    assert.equal(body1.length, 12000, `默认窗口必须是 12000 字符（实际 ${body1.length}）`);

    // Deterministic slice check: rebuild the full extracted text from the same
    // fixture, then window N+1 must equal exactly the next maxChars slice.
    const full = extractTextFromHtml(longArticle(400)).text;
    assert.equal(body1, full.slice(0, 12000), "窗口 1 必须等于提取文本的 [0, 12000)");

    const r2 = await executeWebFetch("https://long-form.test/article", { offset: r1.nextOffset });
    const body2 = r2.text.replace(HIDDEN_STATIC_CONTENT_NOTE, "").trimEnd();
    assert.equal(body2, full.slice(12000, 24000), "窗口 2 必须等于提取文本的 [12000, 24000)");
    assert.ok(!body2.includes("PARA_0000"), "第二窗口不得重复第一窗口开头");
    assert.equal(r2.truncated, true, "400 段长文需要两个以上窗口");
    assert.ok(r2.nextOffset !== undefined && r2.nextOffset > r1.nextOffset!, "nextOffset 必须单调推进");

    // Explicit small window: exact offset arithmetic.
    const a = await executeWebFetch("https://long-form.test/article", { maxChars: 1000 });
    const b = await executeWebFetch("https://long-form.test/article", { maxChars: 1000, offset: 1000 });
    const bodyA = a.text.replace(HIDDEN_STATIC_CONTENT_NOTE, "").trimEnd();
    const bodyB = b.text.replace(HIDDEN_STATIC_CONTENT_NOTE, "").trimEnd();
    assert.equal(bodyA, full.slice(0, 1000));
    assert.equal(bodyB, full.slice(1000, 2000), "offset=1000 必须返回紧接的下一个窗口");
  } finally {
    mock.restore();
  }
  console.log("    ✅ offset windows advance, truncated/nextOffset present, note appended");
}

console.log("  [5] short content: not truncated, no nextOffset");
{
  const mock = mockConnectorFetch([
    { match: "tiny.test", reply: () => ({ status: 200, raw: new Response("<html><body><article>abcdefghij</article></body></html>", { status: 200, headers: { "content-type": "text/html" } }) }) },
  ]);
  try {
    const r = await executeWebFetch("https://tiny.test/x", { maxChars: 100 });
    assert.ok(!r.truncated);
    assert.equal(r.nextOffset, undefined);
    assert.ok(r.text.includes("abcdefghij"));
    // offset beyond the text length yields an empty (but honest) window.
    const beyond = await executeWebFetch("https://tiny.test/x", { maxChars: 100, offset: 500 });
    assert.equal(beyond.truncated, false);
    assert.ok(beyond.text.includes(HIDDEN_STATIC_CONTENT_NOTE) === false);
  } finally {
    mock.restore();
  }
  console.log("    ✅ truncated=false and nextOffset absent when content fits");
}

console.log("  [6] TOOL_web_fetch schema + result text carry the continuation contract");
{
  const schema = JSON.stringify(TOOL_web_fetch.parameters);
  assert.ok(schema.includes("offset"), "web_fetch schema 必须暴露 offset 参数");
  const desc = TOOL_web_fetch.description;
  assert.ok(/12000/.test(desc), "描述应体现默认窗口提升到 12000");
  assert.match(desc, /truncated|nextOffset|继续/, "描述应说明可分页续读");

  const mock = mockConnectorFetch([
    { match: "schema.test", reply: () => ({ status: 200, raw: new Response(longArticle(400), { status: 200, headers: { "content-type": "text/html" } }) }) },
  ]);
  try {
    const r = await TOOL_web_fetch.run(toolCtx({ PUBLIC_BASE_URL: "https://app.example.com" } as any, "ws-1"), { url: "https://schema.test/page" });
    assert.ok(r.ok, `web_fetch 应成功：${(r as any)?.error}`);
    const data = r.data as { text: string; truncated: boolean; nextOffset?: number };
    assert.equal(data.truncated, true);
    assert.ok(data.nextOffset !== undefined && data.nextOffset > 0);
    assert.match(
      data.text,
      /truncated=true; call web_fetch again with offset=\d+ to continue reading this page/,
      "截断时正文必须包含显式续读指令",
    );
    // The evidence metadata must also record truncation + nextOffset.
    if (r.external?.ok) {
      assert.equal(r.external.evidence.metadata?.truncated, true);
      assert.equal(r.external.evidence.metadata?.nextOffset, data.nextOffset);
    }
  } finally {
    mock.restore();
  }
  console.log("    ✅ schema exposes offset; truncated result instructs continuation");
}

console.log("✅ web-fetch-focus tests passed");
