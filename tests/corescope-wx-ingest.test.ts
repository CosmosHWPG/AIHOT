import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { checkMpAccount, scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { previewSource, sourceIdentity } from "@aihot/backend/admin/sources";

const T = tag();
const SOURCE = `test-wx-cache-${T}`;
const FAILED = `test-wx-cache-failed-${T}`;
const PAUSED = `test-wx-cache-paused-${T}`;
const directory = mkdtempSync(path.join(tmpdir(), "corescope-wx-ingest-"));
const username = "gh_ingest_test_account";
const account = "回归测试公众号";
const now = Math.floor(Date.now() / 1000);
const table = `Msg_${createHash("md5").update(username).digest("hex")}`;
const contact = new DatabaseSync(path.join(directory, "c".repeat(32) + ".db"));
contact.exec("CREATE TABLE contact (username TEXT, nick_name TEXT, alias TEXT, delete_flag INTEGER); CREATE TABLE biz_info (username TEXT)");
contact.prepare("INSERT INTO contact VALUES (?, ?, ?, 0)").run(username, account, "ingest-test");
contact.prepare("INSERT INTO biz_info VALUES (?)").run(username);
contact.close();
const message = new DatabaseSync(path.join(directory, "d".repeat(32) + ".db"));
message.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, message_content TEXT, compress_content BLOB)`);
const items = [0, 1].map((i) => `<item><title>核心网测试发布 ${i} ${T}</title><url>https://mp.weixin.qq.com/s/ingest-${i}-${T}</url><digest>来源公开文章摘要 ${i}</digest><pub_time>${now - 120 - i * 60}</pub_time></item>`).join("");
message.prepare(`INSERT INTO "${table}" VALUES (1, ?, ?, NULL)`).run(now - 60, `<msg><appmsg><mmreader><category>${items}</category></mmreader></appmsg></msg>`);
message.close();
const originalDirectory = process.env.WX_CACHE_DIRECTORY;
process.env.WX_CACHE_DIRECTORY = directory;

before(async () => {
  const cfg = sql.json({ transport: "wx_cache", account, limit: 1, fetchPublicContent: true });
  await sql`INSERT INTO sources (id, name, kind, config, cursor, next_fetch_at, enabled)
    VALUES (${SOURCE}, 'Test public account', 'mp_account', ${cfg}, NULL, '2100-01-01', true),
      (${FAILED}, 'Test missing public account', 'mp_account', ${sql.json({ transport: "wx_cache", account: "未授权的公众号" })}, ${sql.json({ marker: "preserved" })}, now() - interval '1 minute', true),
      (${PAUSED}, 'Test paused public account', 'mp_account', ${cfg}, NULL, NULL, false)`;
});
after(async () => {
  if (originalDirectory === undefined) delete process.env.WX_CACHE_DIRECTORY;
  else process.env.WX_CACHE_DIRECTORY = originalDirectory;
  await stopBoss();
  await closeDb();
  const owned = path.resolve(directory);
  assert.equal(path.dirname(owned), path.resolve(tmpdir()));
  assert.ok(path.basename(owned).startsWith("corescope-wx-ingest-"));
  rmSync(owned, { recursive: true });
});

test("native public-account ingest keeps source identity and dates, queues public body extraction, and drains unseen entries idempotently", async () => {
  const first = await checkMpAccount(SOURCE, "manual");
  const second = await checkMpAccount(SOURCE, "manual");
  const third = await checkMpAccount(SOURCE, "manual");
  assert.deepEqual([first.status, second.status, third.status], ["ok", "ok", "ok"]);
  assert.deepEqual([first.created, second.created, third.created], [1, 1, 0], "known entries do not consume the new-material cap");
  const articles = await sql<{ id: string; source_id: string; published_at: Date; revision: number; body_status: string; excerpt: string }[]>`
    SELECT id, source_id, published_at, revision, body_status, excerpt FROM articles WHERE source_id = ${SOURCE} ORDER BY published_at DESC`;
  assert.equal(articles.length, 2);
  assert.deepEqual(articles.map((a) => [a.source_id, a.published_at.getTime(), a.revision, a.body_status]), [[SOURCE, (now - 120) * 1000, 1, "pending"], [SOURCE, (now - 180) * 1000, 1, "pending"]]);
  const jobs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'content.extract-body' AND data->>'articleId' IN ${sql(articles.map((a) => a.id))}`;
  assert.equal(jobs[0]!.n, 2);
  const [health] = await sql<{ health: string; cursor: any; fail_count: number }[]>`SELECT health, cursor, fail_count FROM sources WHERE id = ${SOURCE}`;
  assert.equal(health!.health, "ok");
  assert.equal(health!.fail_count, 0);
  assert.equal(health!.cursor.wxCache.transport, "wx_cache");
});

test("missing public-account cache records failure without advancing cursor, and reconciliation honors pause and retry backoff", async () => {
  const failed = await checkMpAccount(FAILED, "schedule");
  assert.equal(failed.status, "failed");
  const [state] = await sql<{ cursor: any; fail_count: number; health: string; next_fetch_at: Date }[]>`SELECT cursor, fail_count, health, next_fetch_at FROM sources WHERE id = ${FAILED}`;
  assert.deepEqual(state!.cursor, { marker: "preserved" });
  assert.equal(state!.fail_count, 1);
  assert.equal(state!.health, "degraded");
  assert.ok(state!.next_fetch_at.getTime() > Date.now() + 30 * 60_000);
  assert.equal((await checkMpAccount(PAUSED, "schedule")).status, "paused");
  await scheduleMpReconcile();
  const [jobs] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'sources.mp' AND data->>'sourceId' IN ${sql([FAILED, PAUSED])}`;
  assert.equal(jobs!.n, 0, "neither a backoff source nor paused source is queued");
});

test("public-account preview and account duplicate identity work without storing a preview", async () => {
  const preview = await previewSource({ id: "wx-preview", kind: "mp_account", config: { transport: "wx_cache", account, limit: 2 } });
  assert.equal(preview.count, 2);
  assert.equal(sourceIdentity("mp_account", { transport: "wx_cache", account: ` ${account} ` }), `mp:${account}`);
  const [stored] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = 'wx-preview'`;
  assert.equal(stored!.n, 0);
});
