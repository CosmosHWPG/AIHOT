import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { birdUserTweets, birdReadTweet, birdWhoami, getBirdArticleReceipt } from "@aihot/backend/providers/bird";
import { birdCredentialFingerprint } from "@aihot/backend/providers/bird-runtime";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";

const T = tag(); const profile = `bird-test-${T}`;
const root = mkdtempSync(path.join(tmpdir(), "corescope-bird-provider-"));
const cli = path.join(root, "dist/cli.js"); const state = path.join(root, "fixture.json");
const secrets = { authToken: "offline_provider_auth", ct0: "offline_provider_csrf" };
let budget: { per_minute: number; per_hour: number; per_day: number; note: string | null } | undefined;
const original = { ...process.env };
const tweet = (id = "1234567890123456789") => ({ id, text: "Original evidence", createdAt: "2026-10-13T01:00:00Z", author: { username: "example", name: "Example" } });
const change = (value: object) => writeFileSync(state, JSON.stringify(value));

before(async () => {
  [budget] = await sql`SELECT per_minute, per_hour, per_day, note FROM budgets WHERE service='bird'`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES ('bird',1000,10000,100000)
    ON CONFLICT(service) DO UPDATE SET per_minute=1000,per_hour=10000,per_day=100000`;
  mkdirSync(path.dirname(cli));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@steipete/bird", version: "0.8.0", type: "module" }));
  writeFileSync(cli, `import{readFileSync}from'node:fs';const v=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8'));const cmd=process.argv[6];if(v.delay)await new Promise(r=>setTimeout(r,v.delay));if(v.error){process.stderr.write(v.error+' '+process.env.AUTH_TOKEN);process.exit(1);}if(cmd==='whoami')process.stdout.write('🙋 @'+(v.user??'test_account')+' (Fixture)\\n🪪 '+(v.userId??'9911223344'));else process.stdout.write(JSON.stringify(v.payload));`);
  Object.assign(process.env, { BIRD_ENABLED: "true", BIRD_CLI_PATH: cli, BIRD_NODE_PATH: process.execPath,
    BIRD_CREDENTIAL_MODE: "process-env", BIRD_ACCOUNT_PROFILE: profile, BIRD_AUTH_TOKEN: secrets.authToken, BIRD_CT0: secrets.ct0 });
  for (const name of ["BIRD_CLI_SHA256", "BIRD_EXPECTED_USER_ID", "BIRD_EXPECTED_USERNAME"]) delete process.env[name];
});
beforeEach(async () => {
  process.env.BIRD_AUTH_TOKEN = secrets.authToken; delete process.env.BIRD_EXPECTED_USER_ID;
  await sql`DELETE FROM receipts WHERE service='bird' AND subject LIKE ${`%${T}%`}`;
  await sql`DELETE FROM bird_profile_gate WHERE profile=${profile}`;
  await sql`INSERT INTO bird_profile_gate(profile,verified_user_id,verified_username,credential_fingerprint,verified_at)
    VALUES (${profile},'9911223344','test_account',${birdCredentialFingerprint(secrets)},now())`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES ('bird',1000,10000,100000)
    ON CONFLICT(service) DO UPDATE SET per_minute=1000,per_hour=10000,per_day=100000`;
  change({ payload: { tweets: [tweet()], nextCursor: "page_2" } });
});
after(async () => {
  await sql`DELETE FROM bird_profile_gate WHERE profile=${profile}`;
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day},note=${budget.note} WHERE service='bird'`;
  else await sql`DELETE FROM budgets WHERE service='bird'`;
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  rmSync(root, { recursive: true, force: true }); await closeDb();
});

test("saved Bird page replays once with cost unknown, no credit reservation and stable provider identity", async () => {
  const opts = { subject: T, window: T };
  const first = await birdUserTweets("example", opts); const again = await birdUserTweets("example", opts);
  assert.equal(first.tweets[0]?.id_str, tweet().id); assert.equal(first.nextCursor, "page_2");
  assert.equal(again.receiptId, first.receiptId); assert.equal(again.reused, true);
  const [row] = await sql`SELECT service,status,cost,currency,request FROM receipts WHERE id=${first.receiptId}`;
  assert.equal(row!.service, "bird"); assert.equal(row!.cost, null); assert.equal(row!.currency, null);
  assert.equal(row!.request.maxPages, 1);
  const [attempts] = await sql`SELECT count(*)::int AS count,sum(reserved_credits)::int AS credits FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(attempts!.count, 1); assert.equal(attempts!.credits, 0);
});
test("missing finite budget and unverified or rotated session block the CLI", async () => {
  await sql`DELETE FROM budgets WHERE service='bird'`;
  await assert.rejects(birdUserTweets("example", { subject: T, window: T }), /unconfigured/);
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES ('bird',1000,10000,100000)`;
  process.env.BIRD_AUTH_TOKEN = "offline_rotated_cookie";
  await assert.rejects(birdUserTweets("example", { subject: T, window: T }), /whoami check/);
  const [attempts] = await sql`SELECT count(*)::int AS count FROM receipts WHERE service='bird' AND subject=${T}`;
  assert.equal(attempts!.count, 0);
});
test("whoami establishes the current credential identity and rejects expected account mismatch", async () => {
  await sql`UPDATE bird_profile_gate SET verified_at=NULL,credential_fingerprint=NULL WHERE profile=${profile}`;
  change({}); process.env.BIRD_EXPECTED_USER_ID = "9911223344";
  const auth = await birdWhoami({ subject: T, window: T }); assert.equal(auth.id, "9911223344");
  const [row] = await sql`SELECT verified_at,credential_fingerprint FROM bird_profile_gate WHERE profile=${profile}`;
  assert.ok(row!.verified_at); assert.equal(row!.credential_fingerprint, birdCredentialFingerprint(secrets));
  process.env.BIRD_EXPECTED_USER_ID = "000999";
  await assert.rejects(birdWhoami({ subject: T, window: T + "mismatch" }), /does not match/);
});
test("429 cools the whole profile and diagnostics do not persist a credential prefix", async () => {
  change({ error: "HTTP 429 rate limit" });
  await assert.rejects(birdUserTweets("example", { subject: T, window: T }), /HTTP 429/);
  const [row] = await sql`SELECT cooldown_until,lease_owner FROM bird_profile_gate WHERE profile=${profile}`;
  assert.ok(row!.cooldown_until); assert.equal(row!.lease_owner, null);
  await assert.rejects(birdUserTweets("another", { subject: T, window: T + "next" }), error => error instanceof BudgetExceededError && /profile-cooldown/.test(error.message));
  const [receipt] = await sql`SELECT error FROM receipts WHERE service='bird' AND subject=${T}`;
  assert.equal(receipt!.error, "Bird HTTP 429"); assert.ok(!receipt!.error.includes(secrets.authToken));
});
test("profile lease prevents another CoreScope process from starting an overlapping CLI", async () => {
  change({ payload: { tweets: [tweet()], nextCursor: null }, delay: 700 });
  const first = birdUserTweets("example", { subject: T, window: T });
  for (let i = 0; i < 100; i++) {
    const [row] = await sql`SELECT lease_owner FROM bird_profile_gate WHERE profile=${profile}`;
    if (row?.lease_owner) break; await new Promise(resolve => setTimeout(resolve, 5));
  }
  const code = `import {birdUserTweets} from '@aihot/backend/providers/bird';import{closeDb}from'@aihot/backend/db';try{await birdUserTweets('another',{subject:${JSON.stringify(T)},window:'other-process'});process.stdout.write('overlap');}catch(e){process.stdout.write(/profile-busy/.test(e.message)?'busy':'unexpected');}finally{await closeDb();}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, AUTH_TOKEN: "offline_only", CT0: "offline_only" }, timeout: 10_000 });
  assert.equal(stdout, "busy"); await first;
});
test("Article read emits only confirmed body blocks and exposes its business completion receipt", async () => {
  change({ payload: { ...tweet(), text: "Article title", article: { title: "Article title", previewText: "Preview only" } } });
  const preview = await getBirdArticleReceipt(tweet().id, { subject: T, window: "preview" }); assert.equal(preview.article, null);
  assert.ok(preview.receiptId > 0);
  change({ payload: { ...tweet(), text: "Article title\n\nConfirmed full article body", article: { title: "Article title", previewText: "Preview only" },
    _raw: { article: { article_results: { result: { title: "Article title", content_state: { blocks: [{ type: "unstyled", text: "Confirmed full article body" }] } } } } } } });
  const full = await getBirdArticleReceipt(tweet().id, { subject: T, window: "full" });
  assert.equal(full.article?.content_state?.blocks?.[0]?.text, "Confirmed full article body");
  change({ payload: tweet("999") });
  await assert.rejects(birdReadTweet(tweet().id, { subject: T, window: "wrong-id" }), /different tweet id/);
});
