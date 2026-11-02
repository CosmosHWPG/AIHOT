import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { parseWxCacheMessage, readWxCache } from "@aihot/backend/sources/wx-cache";

const directory = mkdtempSync(path.join(tmpdir(), "corescope-wx-cache-"));
const contactPath = path.join(directory, "a".repeat(32) + ".db");
const messagePath = path.join(directory, "b".repeat(32) + ".db");
const username = "gh_test_public_account";
const account = "测试通信公众号";
const now = new Date();
const received = Math.floor(now.getTime() / 1000) - 60;
const published = received - 120;
const table = `Msg_${createHash("md5").update(username).digest("hex")}`;
const xml = (stamp: string, includeDeleted = false) => `<msg><appmsg><mmreader><category><item><title><![CDATA[核心网架构公开更新]]></title><url><![CDATA[https://mp.weixin.qq.com/s/test-public?scene=21]]></url>${stamp}<digest><![CDATA[来源文章摘要]]></digest></item>${includeDeleted ? '<item><title>已删除公开文章</title><url>https://mp.weixin.qq.com/s/deleted</url><pub_time>1</pub_time><del_flag>1</del_flag></item>' : ""}</category></mmreader></appmsg></msg>`;

const contacts = new DatabaseSync(contactPath);
contacts.exec("CREATE TABLE contact (username TEXT, nick_name TEXT, alias TEXT, delete_flag INTEGER); CREATE TABLE biz_info (username TEXT)");
contacts.prepare("INSERT INTO contact VALUES (?, ?, ?, 0)").run(username, account, "test-public");
contacts.prepare("INSERT INTO biz_info VALUES (?)").run(username);
contacts.prepare("INSERT INTO contact VALUES (?, ?, ?, 0)").run("wxid_test_private", "测试个人联系人", "private-contact");
contacts.close();
const messages = new DatabaseSync(messagePath);
messages.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, message_content BLOB, compress_content BLOB);
  CREATE TABLE "Msg_private_unrelated" (local_id INTEGER, create_time INTEGER, message_content BLOB)`);
messages.prepare(`INSERT INTO "${table}" VALUES (1, ?, ?, NULL)`).run(received, zstdCompressSync(Buffer.from(xml(`<pub_time>${published}</pub_time>`, true))));
messages.prepare("INSERT INTO Msg_private_unrelated VALUES (1, ?, ?)").run(received, Buffer.from("This private fixture must never be collected"));
messages.close();

after(() => {
  const owned = path.resolve(directory);
  assert.equal(path.dirname(owned), path.resolve(tmpdir()));
  assert.ok(path.basename(owned).startsWith("corescope-wx-cache-"));
  rmSync(owned, { recursive: true });
});

test("public cache collection reads exact public-account messages without modifying cache files or collecting private chats", () => {
  const before = readdirSync(directory).map((name) => ({ name, bytes: readFileSync(path.join(directory, name)), modified: statSync(path.join(directory, name)).mtimeMs }));
  const result = readWxCache({ config: { account, limit: 8 } }, { directory, now });
  assert.equal(result.accountUsername, username);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.title, "核心网架构公开更新");
  assert.equal(result.candidates[0]!.publishedAt!.getTime(), published * 1000);
  assert.equal(result.candidates[0]!.bodyStatus, "pending", "a public push contains a digest, not full text");
  assert.equal(result.stale, false);
  assert.equal(result.latestMessageAt!.getTime(), received * 1000);
  const afterRead = readdirSync(directory).map((name) => ({ name, bytes: readFileSync(path.join(directory, name)), modified: statSync(path.join(directory, name)).mtimeMs }));
  assert.deepEqual(afterRead, before, "the cache files, timestamps and directory entries are unchanged");
  assert.throws(() => readWxCache({ config: { account: "测试个人联系人" } }, { directory, now }), /public account is not present/);
  assert.throws(() => readWxCache({ config: { account: "测试通信" } }, { directory, now }), /public account is not present/, "account matching is exact");
});

test("a missing source publication time stays null; push delivery time is separate provenance", () => {
  const got = parseWxCacheMessage(xml(""), received, account);
  assert.equal(got[0]!.publishedAt, null);
  assert.equal((got[0]!.raw as any).wxCache.messageCreatedAt, received);
  assert.deepEqual(parseWxCacheMessage('<msg><appmsg><title>A private share</title><url>https://mp.weixin.qq.com/s/private-share</url></appmsg></msg>', received, account), []);
});

test("stale cache state is reported explicitly, and invalid configuration cannot expose another credential as a path", () => {
  const old = new Date(now.getTime() - 3 * 86400_000);
  utimesSync(messagePath, old, old);
  const read = readWxCache({ config: { account } }, { directory, now });
  assert.equal(read.stale, true);
  assert.equal(read.cacheUpdatedAt.toISOString(), old.toISOString());
  assert.throws(() => readWxCache({ config: { account, cacheDirectoryEnv: "OPENAI_API_KEY" } }, { directory, now }), /WX_ collector setting/);
});
