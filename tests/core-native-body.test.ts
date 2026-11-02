// Exact public detail parsing uses synthetic bodies and never reaches an external service.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativeBody, extractNativeBody, parseRoutineNativeBody, extractRoutineNativeBody, type NativeBodyAdapter } from "@aihot/backend/content/native-body";
import { sanitizeFeedBody, type FeedBodyProof } from "@aihot/backend/content/feed-body";
import { sha256 } from "@aihot/backend/lib/ids";
import { config } from "@aihot/backend/config";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

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

test("routine extraction accepts unseen article IDs and bodies without a precomputed recovery proof", () => {
  const laterTitle = "New public research on acoustic model deployment";
  const laterBody = `<h2>New model deployment</h2><p>${"A newly published experiment reports measured model deployment results and limitations. ".repeat(8)}</p>`;
  const cases: Array<[NativeBodyAdapter, string, string]> = [
    ["mittrchina", "https://www.mittrchina.com/news/detail/19521", response("mittrchina", laterBody, { id: 19521, name: laterTitle })],
    ["speechhome", "https://speechhome.com/post/2216116444335968257", response("speechhome", laterBody, { id: "2216116444335968257", title: laterTitle })],
  ];
  for (const [adapter, url, raw] of cases) {
    const got = parseRoutineNativeBody(adapter, raw, url, laterTitle);
    assert.ok(got); assert.equal(got.body.text, sanitizeFeedBody(laterBody, url).text);
    assert.equal(got.evidence.bodySha256, sha256(got.body.text));
    assert.equal(parseNativeBody(adapter, raw, url, laterTitle, undefined as unknown as FeedBodyProof), null,
      "daily extraction must not weaken the fixed recovery proof contract");
  }
});

test("Speechhome routine and reviewed parsing support only the verified post and blogs/all detail paths", () => {
  const dynamic = speechUrl.replace("/post/", "/blogs/all/");
  for (const url of [speechUrl, dynamic]) {
    const got = parseRoutineNativeBody("speechhome", response("speechhome"), url, title);
    assert.ok(got); assert.equal(got.evidence.itemId, "2116116444335968256");
    assert.equal(got.evidence.endpoint, "https://speechhome.com/api/api/post/detail/2116116444335968256");
    assert.ok(parseNativeBody("speechhome", response("speechhome"), url, title, proof(body, url)));
  }
  for (const path of ["/blogs", "/blogs/all", "/blogs/2116116444335968256", "/blogs/acoustic", "/blogs/all/2116116444335968256/extra"]) {
    assert.equal(parseRoutineNativeBody("speechhome", response("speechhome"), "https://speechhome.com" + path, title), null);
  }
});

test("routine public fields retain exact ID, title, successful publication and free access requirements", () => {
  for (const item of [{ id: 17163 }, { id: "17164" }, { name: "Other title" }, { is_vip: 1 }, { is_vip: 0 }, { status: 0 }]) {
    assert.equal(parseRoutineNativeBody("mittrchina", response("mittrchina", body, item), mitUrl, title), null);
  }
  for (const item of [{ id: 2116116444335968256 }, { id: "2116116444335968257" }, { title: "Other title" }, { statusCode: 1 }, { statusCode: null }]) {
    assert.equal(parseRoutineNativeBody("speechhome", response("speechhome", body, item), speechUrl, title), null);
  }
  assert.equal(parseRoutineNativeBody("mittrchina", response("mittrchina", body, {}, { code: 401 }), mitUrl, title), null);
  assert.equal(parseRoutineNativeBody("speechhome", response("speechhome", body, {}, { data: { isSucceed: false, result: {} } }), speechUrl, title), null);
});

test("routine parsing never promotes summary or count-only shells, short content, teasers or verification pages", () => {
  for (const adapter of adapters) {
    assert.equal(parseRoutineNativeBody(adapter, response(adapter, body, { content: undefined, summary: body, readingCount: 4000 }), urlFor(adapter), title), null);
    for (const content of ["x".repeat(199), `<p>${"Preview of an acoustic experiment. ".repeat(12)}Continue reading</p>`,
      `<p>Verify you are human</p>${body}`, `<p>登录后阅读全文</p>${body}`, `<p>付费后查看正文</p>${body}`]) {
      assert.equal(parseRoutineNativeBody(adapter, response(adapter, content), urlFor(adapter), title), null);
    }
    assert.equal(parseRoutineNativeBody(adapter, "<html><body>Site navigation</body></html>", urlFor(adapter), title), null);
  }
});

test("routine parsing keeps the original 200-character minimum and guarded publisher URLs", async () => {
  const exact = "a".repeat(200);
  for (const adapter of adapters) {
    assert.ok(parseRoutineNativeBody(adapter, response(adapter, exact), urlFor(adapter), title));
    for (const url of [urlFor(adapter).replace("https:", "http:"), urlFor(adapter) + "?token=private", urlFor(adapter) + "#other",
      urlFor(adapter).replace("https://", "https://user:password@"), urlFor(adapter).replace(".com/", ".com:8443/"), "https://other.example/news/detail/17164"]) {
      assert.equal(parseRoutineNativeBody(adapter, response(adapter), url, title), null);
      assert.equal(await extractRoutineNativeBody({ adapter, originalUrl: url, title }), null);
    }
  }
});

test("routine network extraction calls the exact anonymous endpoint and refuses HTTP errors or non-JSON shells", async () => {
  const oldDispatcher = getGlobalDispatcher(), oldProxy = config.egressProxyUrl, oldPrivate = config.allowPrivateNetworkFetch;
  const mock = new MockAgent(); mock.disableNetConnect();
  config.egressProxyUrl = null; config.allowPrivateNetworkFetch = true; setGlobalDispatcher(mock);
  try {
    for (const adapter of adapters) {
      const endpoint = new URL(adapter === "mittrchina" ? "https://apii.web.mittrchina.com/information/details?id=17164"
        : "https://speechhome.com/api/api/post/detail/2116116444335968256");
      const input = { adapter, originalUrl: urlFor(adapter), title };
      mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search, method: "GET" })
        .reply(200, response(adapter), { headers: { "content-type": "application/json" } });
      assert.ok(await extractRoutineNativeBody(input));
      for (const status of [401, 403, 429, 500]) {
        mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search }).reply(status, response(adapter), { headers: { "content-type": "application/json" } });
        if (status === 429 || status >= 500) await assert.rejects(extractRoutineNativeBody(input), /temporarily unavailable/);
        else assert.equal(await extractRoutineNativeBody(input), null);
      }
      mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search }).reply(200, response(adapter), { headers: { "content-type": "text/html" } });
      assert.equal(await extractRoutineNativeBody(input), null);
    }
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(oldDispatcher); config.egressProxyUrl = oldProxy; config.allowPrivateNetworkFetch = oldPrivate; await mock.close();
  }
});
