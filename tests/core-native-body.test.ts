// Exact public detail parsing uses synthetic bodies and never reaches an external service.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativeBody, extractNativeBody, type NativeBodyAdapter } from "@aihot/backend/content/native-body";
import { sanitizeFeedBody, type FeedBodyProof } from "@aihot/backend/content/feed-body";
import { sha256 } from "@aihot/backend/lib/ids";

const mitUrl = "https://www.mittrchina.com/news/detail/17164";
const speechUrl = "https://speechhome.com/post/2116116444335968256";
const title = "A reviewed public report about acoustic model engineering";
const body = `<h2>Acoustic model engineering</h2><p>${"The public experiment describes measured acoustic recognition results and reproducible engineering evidence. ".repeat(7)}</p><p>The final experiment reports the measured conclusion.</p>`;
const urlFor = (adapter: NativeBodyAdapter) => adapter === "mittrchina" ? mitUrl : speechUrl;
function proof(html = body, url = mitUrl): FeedBodyProof {
  const text = sanitizeFeedBody(html, url).text;
  return { bodySha256: sha256(text), tailSha256: sha256(text.slice(-200)), requiredTerms: ["acoustic", "engineering", "final experiment"] };
}
function response(adapter: NativeBodyAdapter, content = body, item: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}): string {
  return JSON.stringify(adapter === "mittrchina"
    ? { code: 10000, data: { id: 17164, name: title, status: 1, is_vip: 2, content, ...item }, ...envelope }
    : { status: 200, data: { isSucceed: true, result: { id: "2116116444335968256", title, statusCode: 0, content, ...item } }, ...envelope });
}
const adapters: NativeBodyAdapter[] = ["mittrchina", "speechhome"];

test("MIT exact anonymous detail yields only the reviewed body and fixed endpoint provenance", () => {
  const got = parseNativeBody("mittrchina", response("mittrchina"), mitUrl, title, proof());
  assert.ok(got); assert.equal(got.evidence.adapter, "mittrchina");
  assert.equal(got.evidence.endpoint, "https://apii.web.mittrchina.com/information/details?id=17164");
  assert.equal(got.evidence.itemId, "17164"); assert.equal(got.evidence.itemUrl, mitUrl);
  assert.equal(got.evidence.field, "content"); assert.equal(got.evidence.bodySha256, sha256(got.body.text));
  assert.equal(got.evidence.tailSha256, sha256(got.body.text.slice(-200)));
  assert.equal(got.evidence.chars, got.body.text.length); assert.deepEqual(got.body.images, []);
});

test("Speechhome preserves the 19-digit string identity without rounding and unwraps the public response", () => {
  const got = parseNativeBody("speechhome", response("speechhome"), speechUrl, title, proof(body, speechUrl));
  assert.ok(got); assert.equal(got.evidence.adapter, "speechhome");
  assert.equal(got.evidence.endpoint, "https://speechhome.com/api/api/post/detail/2116116444335968256");
  assert.equal(got.evidence.itemId, "2116116444335968256"); assert.equal(got.evidence.itemUrl, speechUrl);
  for (const id of [2116116444335968256, "2116116444335968257", "02116116444335968256", null]) {
    assert.equal(parseNativeBody("speechhome", response("speechhome", body, { id }), speechUrl, title, proof(body, speechUrl)), null);
  }
});

test("MIT numeric item identity must be exact and safe rather than a differently typed or neighbouring ID", () => {
  for (const id of [17163, "17164", 17164.1, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(parseNativeBody("mittrchina", response("mittrchina", body, { id }), mitUrl, title, proof()), null);
  }
});

test("both adapters refuse a different or empty title, while harmless text normalization retains identity", () => {
  for (const adapter of adapters) {
    const key = adapter === "mittrchina" ? "name" : "title";
    for (const actual of ["A different article", "", null]) {
      assert.equal(parseNativeBody(adapter, response(adapter, body, { [key]: actual }), urlFor(adapter), title, proof()), null);
    }
    assert.ok(parseNativeBody(adapter, response(adapter, body, { [key]: ` ${title.toUpperCase()}  ` }), urlFor(adapter), title, proof()));
  }
});

test("MIT access, publication and success states must retain the observed public values", () => {
  for (const item of [{ is_vip: 1 }, { is_vip: 0 }, { is_vip: null }, { status: 0 }, { status: "1" }]) {
    assert.equal(parseNativeBody("mittrchina", response("mittrchina", body, item), mitUrl, title, proof()), null);
  }
  assert.equal(parseNativeBody("mittrchina", response("mittrchina", body, {}, { code: 401 }), mitUrl, title, proof()), null);
  assert.equal(parseNativeBody("mittrchina", response("mittrchina", body, {}, { code: "10000" }), mitUrl, title, proof()), null);
});

test("Speechhome failure, unknown visibility state and missing result are not public body permission", () => {
  for (const statusCode of [1, -1, "0", null]) {
    assert.equal(parseNativeBody("speechhome", response("speechhome", body, { statusCode }), speechUrl, title, proof()), null);
  }
  for (const data of [{ isSucceed: false, result: { id: "2116116444335968256", title, statusCode: 0, content: body } },
    { isSucceed: "true", result: {} }, { isSucceed: true, result: null }]) {
    assert.equal(parseNativeBody("speechhome", response("speechhome", body, {}, { data }), speechUrl, title, proof()), null);
  }
  assert.equal(parseNativeBody("speechhome", response("speechhome", body, {}, { status: 403 }), speechUrl, title, proof()), null);
});

test("malformed JSON, shell HTML and list-shaped responses cannot become a detail body", () => {
  for (const adapter of adapters) for (const raw of ["not json", "<html><body>Platform navigation</body></html>", "null", "[]", "{}",
    JSON.stringify({ code: 10000, status: 200, data: [{ id: 17164, name: title, content: body }] }),
    JSON.stringify({ code: 10000, status: 200, data: { items: [{ id: 17164, name: title, content: body }] } })]) {
    assert.equal(parseNativeBody(adapter, raw, urlFor(adapter), title, proof()), null);
  }
});

test("missing, empty and short actual content never falls back to title, summary, neighbours or page chrome", () => {
  for (const adapter of adapters) for (const content of ["", "<div>Home Login Search Categories About</div>", "x".repeat(199)]) {
    assert.equal(parseNativeBody(adapter, response(adapter, content, { summary: body, description: body }), urlFor(adapter), title, proof(content)), null);
  }
  for (const adapter of adapters) for (const content of [null, 1, [], { html: body }]) {
    assert.equal(parseNativeBody(adapter, response(adapter, body, { content }), urlFor(adapter), title, proof()), null);
  }
});

test("the existing 200-character extraction minimum is preserved", () => {
  const text = "acoustic engineering final experiment " + "a".repeat(200 - "acoustic engineering final experiment ".length);
  assert.equal(text.length, 200);
  for (const adapter of adapters) assert.ok(parseNativeBody(adapter, response(adapter, text), urlFor(adapter), title, proof(text)));
});

test("an exact proof does not authorize a teaser or security/login/paywall interstitial", () => {
  for (const suffix of ["Continue reading", "Read more"]) {
    const teaser = `<p>${"The acoustic engineering experiment provides a preview. ".repeat(12)} final experiment ${suffix}</p>`;
    for (const adapter of adapters) assert.equal(parseNativeBody(adapter, response(adapter, teaser), urlFor(adapter), title, proof(teaser)), null);
  }
  for (const prefix of ["Verify you are human", "Performing security verification", "Enable JavaScript and cookies to continue", "登录后阅读全文", "付费后查看正文"]) {
    const restricted = `<p>${prefix}</p>${body}`;
    for (const adapter of adapters) assert.equal(parseNativeBody(adapter, response(adapter, restricted), urlFor(adapter), title, proof(restricted)), null);
  }
});

test("every native body requires exact whole-body, tail and topic proof rather than length alone", () => {
  const valid = proof();
  const bad = [undefined, {}, { ...valid, bodySha256: "0".repeat(64) }, { ...valid, tailSha256: "0".repeat(64) },
    { ...valid, bodySha256: "not a hash" }, { ...valid, requiredTerms: ["unrelated topic"] },
    { ...valid, requiredTerms: [] }, { ...valid, requiredTerms: [""] }, { ...valid, requiredTerms: ["a"] },
    { ...valid, requiredTerms: ["x".repeat(101)] }, { ...valid, requiredTerms: Array(13).fill("acoustic") }];
  for (const adapter of adapters) for (const invalid of bad) {
    assert.equal(parseNativeBody(adapter, response(adapter), urlFor(adapter), title, invalid as FeedBodyProof), null);
  }
});

test("proof binds cleaned HTML and all reviewed topics; script and handlers never become body text", () => {
  for (const adapter of adapters) {
    const html = `<script>untrusted()</script>${body}<img src="/plot.png" onerror="alert(1)">`;
    const got = parseNativeBody(adapter, response(adapter, html), urlFor(adapter), title, proof(html, urlFor(adapter)));
    assert.ok(got); assert.doesNotMatch(got.body.html, /script|onerror|untrusted\(\)/i);
    assert.match(got.body.html, /https:\/\/(?:www\.mittrchina|speechhome)\.com\/plot\.png/);
    assert.ok(parseNativeBody(adapter, response(adapter), urlFor(adapter), title,
      { ...proof(), requiredTerms: [" ACOUSTIC ", "engineering", "final experiment"] }));
  }
});

test("URLs remain bound to the reviewed HTTPS origin, article route, selector and exact adapter", async () => {
  const badUrls: Array<[NativeBodyAdapter, string]> = [
    ["mittrchina", mitUrl.replace("https:", "http:")], ["speechhome", speechUrl.replace("https:", "http:")],
    ["mittrchina", mitUrl.replace("www.mittrchina.com", "evil.example")], ["speechhome", speechUrl.replace("speechhome.com", "speechhome.com.evil.example")],
    ["speechhome", speechUrl.replace("speechhome.com", "speechhome.com@evil.example")],
    ["mittrchina", mitUrl.replace("https://", "https://user:secret@")],
    ["mittrchina", mitUrl + "?id=17163"], ["speechhome", speechUrl + "?token=secret"],
    ["speechhome", speechUrl + "#another"], ["mittrchina", mitUrl.replace(".com/", ".com:8443/")],
    ["mittrchina", "https://www.mittrchina.com/news/detail/0"], ["mittrchina", "https://www.mittrchina.com/news/detail/017164"],
    ["speechhome", "https://speechhome.com/blogs/2116116444335968256"],
    ["speechhome", "https://speechhome.com/post/0"], ["speechhome", "https://speechhome.com/post/2116116444335968256/other"],
    ["mittrchina", speechUrl], ["speechhome", mitUrl], ["mittrchina", "file:///news/detail/17164"],
  ];
  for (const [adapter, originalUrl] of badUrls) {
    assert.equal(parseNativeBody(adapter, response(adapter), originalUrl, title, proof()), null);
    // These invalid inputs fail before guardedFetch; no local server or outside network is needed.
    assert.equal(await extractNativeBody({ adapter, originalUrl, title, bodyProof: proof() }), null);
  }
  assert.ok(parseNativeBody("mittrchina", response("mittrchina"), mitUrl.replace("www.", ""), title, proof()));
});

test("responses larger than the native body read cap are refused before JSON parsing", () => {
  const oversized = " ".repeat(6 * 1024 * 1024 + 1);
  for (const adapter of adapters) assert.equal(parseNativeBody(adapter, oversized, urlFor(adapter), title, proof()), null);
});
