// Body-only feed lookup uses no database, models, Jina or source collection.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractFeedBody, sanitizeFeedBody, type FeedBodyProof } from "@aihot/backend/content/feed-body";
import { sha256 } from "@aihot/backend/lib/ids";

const oldPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(() => { config.allowPrivateNetworkFetch = oldPrivate; });
const originalUrl = "https://publisher.example/posts/exact-article-123?article=123";
const title = "A scientific report about Claude antibody engineering";
const rawBody = `<h2>Claude antibody engineering</h2><p>${"Reviewed evidence supports this exact antibody engineering study. ".repeat(9)}</p><p>The final experiment confirms the finding.</p>`;
const feedItem = (opts: { url?: string; title?: string; encoded?: string; description?: string } = {}) =>
  `<item><link><![CDATA[${opts.url ?? originalUrl}]]></link><title><![CDATA[${opts.title ?? title}]]></title>`
  + (opts.encoded === undefined ? `<content:encoded><![CDATA[${rawBody}]]></content:encoded>` : `<content:encoded><![CDATA[${opts.encoded}]]></content:encoded>`)
  + (opts.description ? `<description><![CDATA[${opts.description}]]></description>` : "") + "</item>";
const feed = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Public publisher feed</title>${items.join("")}</channel></rss>`;

async function withFeed(xml: string, run: (feedUrl: string, hits: () => number) => Promise<void>, options: { status?: number; location?: string } = {}) {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(options.status ?? 200, { "content-type": "application/rss+xml", ...(options.location ? { location: options.location } : {}) });
    res.end(xml);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}/feed`, () => hits); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function proof(raw: string): FeedBodyProof {
  const text = sanitizeFeedBody(raw, originalUrl).text;
  return { bodySha256: sha256(text), tailSha256: sha256(text.slice(-200)), requiredTerms: ["Claude", "antibody", "final experiment"] };
}

test("the exact public item yields sanitized content:encoded and provenance without collecting its neighbours", async () => {
  await withFeed(feed(feedItem({ url: "https://publisher.example/posts/other", title: "Another article" }), feedItem()), async feedUrl => {
    const got = await extractFeedBody({ originalUrl, title, feedUrl, bodyProof: proof(rawBody) });
    assert.ok(got); assert.equal(got.evidence.field, "content:encoded");
    assert.equal(got.evidence.itemUrl, originalUrl); assert.equal(got.evidence.feedUrl, feedUrl);
    assert.equal(got.evidence.bodySha256, sha256(got.body.text));
    assert.equal(got.evidence.tailSha256, sha256(got.body.text.slice(-200)));
    assert.equal(got.evidence.chars, got.body.text.length); assert.deepEqual(got.body.images, []);
  });
});

test("only safe analytics tracking is ignored, while selectors, fragments, origin and arbitrary source stay bound", async () => {
  for (const url of [originalUrl + "&source=rss----abcd---4&utm_source=reader", originalUrl + "&utm_campaign=feed"]) {
    await withFeed(feed(feedItem({ url })), async feedUrl => assert.ok(await extractFeedBody({ originalUrl, title, feedUrl })));
  }
  for (const url of [originalUrl + "&source=another-article", originalUrl + "&article=124", originalUrl + "#other-section",
    originalUrl.replace("publisher.example", "other.example"), originalUrl.replace("123?", "124?")]) {
    await withFeed(feed(feedItem({ url })), async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null));
  }
});

test("a duplicate canonical item is ambiguous even when both copies have the same text", async () => {
  await withFeed(feed(feedItem(), feedItem({ url: originalUrl + "&source=rss----another" })), async feedUrl => {
    assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null);
  });
});

test("an aggregator may omit a final word, but different or short ambiguous headlines are refused", async () => {
  await withFeed(feed(feedItem({ title: title + " worldwide" })), async feedUrl => assert.ok(await extractFeedBody({ originalUrl, title, feedUrl, bodyProof: proof(rawBody) })));
  for (const actual of ["A different report about an unrelated incident", "A scientific report", ""]) {
    await withFeed(feed(feedItem({ title: actual })), async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null));
  }
});

test("the original RSS minimum and teaser rule still refuse short or advertised excerpts", async () => {
  for (const encoded of ["<p>Too short.</p>", `<p>${"A teaser sentence. ".repeat(20)} Continue reading</p>`]) {
    await withFeed(feed(feedItem({ encoded })), async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null));
  }
});

test("description is never a body without a single-article reviewed proof", async () => {
  await withFeed(feed(feedItem({ encoded: "", description: rawBody })), async feedUrl => {
    assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null);
    const got = await extractFeedBody({ originalUrl, title, feedUrl, descriptionProof: proof(rawBody) });
    assert.ok(got); assert.equal(got.evidence.field, "description"); assert.equal(got.evidence.bodySha256, proof(rawBody).bodySha256);
  });
});

test("description proof binds the cleaned whole body, its tail, and all reviewed topic terms", async () => {
  const good = proof(rawBody);
  const bad = [{ ...good, bodySha256: "0".repeat(64) }, { ...good, tailSha256: "0".repeat(64) },
    { ...good, requiredTerms: ["unrelated-topic"] }, { ...good, requiredTerms: [] }, { ...good, requiredTerms: [""] },
    { ...good, bodySha256: "not-a-hash" }];
  await withFeed(feed(feedItem({ encoded: "", description: rawBody })), async feedUrl => {
    for (const descriptionProof of bad) assert.equal(await extractFeedBody({ originalUrl, title, feedUrl, descriptionProof }), null);
  });
});

test("encoded content takes priority; a bad encoded body does not silently become the description", async () => {
  await withFeed(feed(feedItem({ encoded: "<p>Short encoded preview</p>", description: rawBody })), async feedUrl => {
    assert.equal(await extractFeedBody({ originalUrl, title, feedUrl, descriptionProof: proof(rawBody) }), null);
  });
  await withFeed(feed(feedItem()), async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl,
    bodyProof: { ...proof(rawBody), bodySha256: "0".repeat(64) } }), null));
});

test("fixed recovery requires proof for the actual chosen field when a description feed gains encoded content", async () => {
  await withFeed(feed(feedItem({ description: rawBody })), async feedUrl => {
    assert.equal(await extractFeedBody({ originalUrl, title, feedUrl, requireProof: true, descriptionProof: proof(rawBody) }), null);
    const got = await extractFeedBody({ originalUrl, title, feedUrl, requireProof: true, bodyProof: proof(rawBody) });
    assert.ok(got); assert.equal(got.evidence.field, "content:encoded");
  });
});

test("matching and body proof use sanitized content instead of script or navigation text", async () => {
  const dangerous = `<script>secret()</script>${rawBody}<img src="/plot.png" onerror="alert(1)">`;
  await withFeed(feed(feedItem({ encoded: dangerous })), async feedUrl => {
    const got = await extractFeedBody({ originalUrl, title, feedUrl, bodyProof: proof(dangerous) });
    assert.ok(got); assert.doesNotMatch(got.body.html, /script|onerror|secret\(\)/);
    assert.match(got.body.html, /https:\/\/publisher\.example\/plot\.png/);
  });
});

test("non-feed and error responses or external redirects yield no article body", async () => {
  for (const xml of ["<html><body>Just a moment...</body></html>", '<!DOCTYPE rss [<!ENTITY example "body">]><rss><channel/></rss>', "<rss><channel/></rss>"]) {
    await withFeed(xml, async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null));
  }
  await withFeed(feed(feedItem()), async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null), { status: 403 });
  await withFeed("", async feedUrl => assert.equal(await extractFeedBody({ originalUrl, title, feedUrl }), null), { status: 302, location: "https://other.example/feed" });
});

test("unsafe URLs fail before dispatch and a successful feed is shared by repeated/concurrent body lookups", async () => {
  await withFeed(feed(feedItem()), async (feedUrl, hits) => {
    assert.equal(await extractFeedBody({ originalUrl: originalUrl.replace("https://", "https://user:password@"), title, feedUrl }), null);
    assert.equal(await extractFeedBody({ originalUrl, title, feedUrl: feedUrl + "?token=secret" }), null);
    assert.equal(hits(), 0);
    const results = await Promise.all(Array.from({ length: 5 }, () => extractFeedBody({ originalUrl, title, feedUrl })));
    assert.ok(results.every(Boolean)); assert.equal(hits(), 1);
    assert.ok(await extractFeedBody({ originalUrl, title, feedUrl })); assert.equal(hits(), 1);
  });
});
