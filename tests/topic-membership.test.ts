// Failure cases: a single-topic count disagrees with the membership list; a null company pattern
// still depends on titles; a title match bypasses required tags; one subject differs from several;
// an original-title or case-insensitive match is lost; a company name matches inside another word;
// non-selected, withdrawn and unreleased reports change the selected list or pool count incorrectly.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { findTopic, loadTopicPage, topicMembership } from "@aihot/backend/publication/topics";
import type { GroupReportsResponse, TimelineResponse } from "@aihot/contracts/site";
import { buildApp } from "../apps/api/src/app.ts";

after(closeDb);

test("topic lists and pool counts share the exact membership predicate", async () => {
  const prefix = `membership-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const now = new Date(+at + 1000);
  const cases = [
    { title: "", original: null, tags: ["Agent"], topics: ["agent"] },
    { title: "Anthropic Agent", original: null, tags: [], topics: [] },
    { title: "", original: null, tags: ["entity:anthropic"], topics: ["anthropic"] },
    { title: "Unrelated", original: null, tags: ["entity:anthropic", "entity:openai"], topics: [] },
    { title: "Unrelated", original: "ANTHROPIC launches a model", tags: ["entity:anthropic", "entity:openai"], topics: ["anthropic"] },
    { title: "Metadata", original: null, tags: ["entity:meta", "entity:openai"], topics: [] },
    { title: "发布Meta的新模型", original: null, tags: ["entity:meta", "entity:openai"], topics: ["meta"] },
    { title: "Unselected", original: null, tags: ["Agent", "entity:anthropic"], topics: ["agent", "anthropic"], selected: false },
    { title: "Withdrawn", original: null, tags: ["Agent", "entity:anthropic"], topics: ["agent", "anthropic"], visibility: "withdrawn" },
    { title: "Future", original: null, tags: ["Agent", "entity:anthropic"], topics: ["agent", "anthropic"], future: true },
  ];
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T1')`;
  for (const [i, row] of cases.entries()) {
    const id = `${prefix}-${i}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${prefix}, ${id}, ${`https://example.org/${id}`}, ${row.title}, ${at}, ${at})`;
    await sql`INSERT INTO publications (article_id, source_id, title, original_title, url, discovered_at, timeline_at,
      sort_at, visible_after, selected, eligible, visibility, channel, tags)
      VALUES (${id}, ${prefix}, ${row.title}, ${row.original}, ${`https://example.org/${id}`}, ${at}, ${at},
        ${at}, ${row.future ? new Date(+now + 1) : at}, ${row.selected ?? true}, true, ${row.visibility ?? "public"}, 'news', ${row.tags})`;
  }
  const topics = ["anthropic", "meta", "agent"].map(slug => findTopic(slug)!);
  const membership = new Map((await sql<{ id: string; topics: string[] }[]>`
    SELECT p.article_id AS id, ${topicMembership(topics)} AS topics FROM publications p WHERE p.source_id = ${prefix}`)
    .map(row => [row.id, row.topics]));
  for (const [i, row] of cases.entries()) assert.deepEqual(new Set(membership.get(`${prefix}-${i}`)), new Set(row.topics));
  for (const topic of topics) {
    const page = await loadTopicPage(topic.slug, 1, now);
    assert.ok(page);
    const visible = cases.map((row, i) => ({ ...row, id: `${prefix}-${i}` }))
      .filter(row => row.topics.includes(topic.slug) && !row.visibility && !row.future);
    assert.equal(page.topic.poolTotal, visible.length, `${topic.slug} pool`);
    assert.deepEqual(page.items.map(row => row.id).sort(), visible.filter(row => row.selected !== false).map(row => row.id).sort(), `${topic.slug} selected`);
  }
});

test("the cross-perspective topic applies to the selected list, cursor and group reports", async () => {
  const source = `cross-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const factKey = `${source}-fact`;
  await sql`INSERT INTO sources (id,name,kind) VALUES (${source},${source},'rss')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title) VALUES(${factKey},${factKey}) RETURNING id`;
  for (const n of [0, 1, 2]) {
    const id = source + n;
    const url = `https://example.org/${id}`;
    const tags = n ? ["核心网", "AI"] : ["核心网"];
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${url},${id},${at},${at})`;
    await sql`INSERT INTO publications(article_id,source_id,title,url,discovered_at,timeline_at,sort_at,visible_after,selected,eligible,channel,tags,fact_id)
      VALUES(${id},${source},${id},${url},${at},${at},${at},${at},true,true,'news',${tags},${n < 2 ? fact!.id : null})`;
    if (n < 2) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'primary')`;
  }
  const app = await buildApp();
  try {
    const params = new URLSearchParams({ tag: "核心网", topic: "ai", limit: "1" });
    const get = (path: string) => app.inject({ url: path });
    const first = (await get(`/api/site/timeline?${params}`)).json<TimelineResponse>();
    assert.equal(first.filters.topic, "ai");
    assert.equal(first.hot, null);
    assert.ok(first.nextCursor, "the second matching card remains available");
    const second = (await get(`/api/site/timeline?${params}&cursor=${first.nextCursor}`)).json<TimelineResponse>();
    assert.deepEqual(new Set([...first.cards, ...second.cards].map(card => card.item.id)), new Set([source + 1, source + 2]));
    params.delete("topic");
    assert.equal((await get(`/api/site/timeline?${params}&cursor=${first.nextCursor}`)).statusCode, 400);
    assert.equal((await get("/api/site/timeline?topic=no-such-topic")).statusCode, 400);
    const group = (await get(`/api/site/groups/${factKey}/reports?topic=ai`)).json<GroupReportsResponse>();
    assert.deepEqual(group.reports.map(report => report.id), [source + 1]);
  } finally {
    await app.close();
  }
});
