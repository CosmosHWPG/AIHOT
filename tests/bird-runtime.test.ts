// Offline fixtures only: no browser extraction, X request or real credential is used.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { birdRuntime, loadBirdSecrets, runBirdCommand, birdChildEnvironment, redactBirdResponse, classifyBirdFailure,
  readBirdUserCredentials, BirdCredentialReadError,
  type BirdRuntime } from "@aihot/backend/providers/bird-runtime";
import { normalizeBirdTweet, decodeBirdTweets, birdTweetArticle, parseBirdWhoami, sanitizeBirdPublicPayload } from "@aihot/backend/providers/bird-normalize";

const roots: string[] = [];
const names = ["BIRD_ENABLED", "BIRD_CLI_PATH", "BIRD_NODE_PATH", "BIRD_CREDENTIAL_MODE", "BIRD_CLI_SHA256", "BIRD_ACCOUNT_PROFILE", "BIRD_EXPECTED_USER_ID", "BIRD_EXPECTED_USERNAME", "BIRD_PROCESS_TIMEOUT_MS", "BIRD_MAX_OUTPUT_BYTES", "BIRD_AUTH_TOKEN", "BIRD_CT0", "AUTH_TOKEN", "CT0"];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
afterEach(() => {
  for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(code: string): BirdRuntime {
  const root = mkdtempSync(path.join(tmpdir(), "corescope bird with spaces ")); roots.push(root);
  mkdirSync(path.join(root, "dist")); writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@steipete/bird", version: "0.8.0", type: "module" }));
  writeFileSync(path.join(root, "dist/cli.js"), code);
  Object.assign(process.env, { BIRD_ENABLED: "true", BIRD_CLI_PATH: path.join(root, "dist/cli.js"), BIRD_NODE_PATH: process.execPath,
    BIRD_CREDENTIAL_MODE: "process-env", BIRD_ACCOUNT_PROFILE: "offline-fixture", BIRD_AUTH_TOKEN: "offline_auth_cookie", BIRD_CT0: "offline_csrf_cookie" });
  delete process.env.BIRD_CLI_SHA256; delete process.env.BIRD_EXPECTED_USER_ID; delete process.env.BIRD_EXPECTED_USERNAME;
  return { ...birdRuntime(), cwd: root, queryCache: path.join(root, "query-cache.json") };
}
const raw = (id = "1234567890123456789") => ({ id, text: "Original evidence", createdAt: "2026-10-13T01:00:00.000Z",
  author: { username: "example", name: "Example" }, authorId: "9911" });

test("direct Node invocation preserves literal arguments and never forwards backend secrets", async () => {
  const runtime = fixture(`process.stdout.write(JSON.stringify({args:process.argv.slice(2),hasCookie:!!process.env.AUTH_TOKEN,db:process.env.DATABASE_URL??null,model:process.env.DEEPSEEK_API_KEY??null,nodeOptions:process.env.NODE_OPTIONS??null,cache:process.env.BIRD_QUERY_IDS_CACHE}));`);
  const secrets = await loadBirdSecrets(runtime);
  const args = ["a b", "$(not-a-command)", "x;y", 'quote"value'];
  const answer = JSON.parse(await runBirdCommand(runtime, "search", args, secrets));
  assert.deepEqual(answer.args.slice(5), args); assert.equal(answer.args[4], "search");
  assert.equal(answer.hasCookie, true); assert.equal(answer.db, null); assert.equal(answer.model, null); assert.equal(answer.nodeOptions, null);
  assert.equal(answer.cache, runtime.queryCache); assert.equal(birdChildEnvironment(runtime, secrets).AUTH_TOKEN, secrets.authToken);
  await assert.rejects(runBirdCommand(runtime, "tweet", ["not allowed"], secrets), /read-only allowlist/);
  await assert.rejects(runBirdCommand(runtime, "check", [], secrets), /read-only allowlist/);
  await assert.rejects(runBirdCommand(runtime, "read", ["--auth-token=echo"], secrets), /read-only allowlist/);
});
test("CLI failure diagnostics cannot expose even an echoed cookie", async () => {
  const runtime = fixture(`process.stderr.write('HTTP 401 '+process.env.AUTH_TOKEN+' '+process.env.CT0);process.exit(1);`);
  const secrets = await loadBirdSecrets(runtime);
  await assert.rejects(runBirdCommand(runtime, "read", ["123"], secrets), error => {
    assert.equal((error as any).status, 401); assert.equal((error as Error).message, "Bird HTTP 401");
    assert.ok(!(error as Error).message.includes(secrets.authToken)); return true;
  });
  const redacted = redactBirdResponse({ nested: { auth_token: "echo", text: `before ${secrets.authToken} ${secrets.ct0}` } }, secrets) as any;
  assert.equal(redacted.nested.auth_token, "[redacted]"); assert.ok(!redacted.nested.text.includes(secrets.ct0));
});
test("total process deadline, cancellation and output cap terminate only the owned child", async () => {
  const runtime = fixture(`setInterval(()=>{},1000);`); const secrets = await loadBirdSecrets(runtime);
  await assert.rejects(runBirdCommand({ ...runtime, timeoutMs: 120 }, "read", ["123"], secrets), /total time limit/);
  const abort = new AbortController(); const running = runBirdCommand(runtime, "read", ["123"], secrets, abort.signal);
  setTimeout(() => abort.abort(), 100); await assert.rejects(running, /cancelled/);
  writeFileSync(runtime.cliPath, `process.stdout.write('x'.repeat(20000));`);
  await assert.rejects(runBirdCommand({ ...runtime, maxBytes: 1000 }, "read", ["123"], secrets), /size limit/);
});
test("missing paired credentials and mismatched package integrity stop before invocation", async () => {
  const runtime = fixture(`throw new Error('must never run');`);
  delete process.env.BIRD_AUTH_TOKEN; delete process.env.AUTH_TOKEN;
  await assert.rejects(loadBirdSecrets(runtime), /AUTH_TOKEN and CT0 are required/);
  process.env.BIRD_CLI_SHA256 = "0".repeat(64); assert.throws(() => birdRuntime(), /integrity/);
  assert.equal(classifyBirdFailure("HTTP 429 private echo").retryable, true);
});
test("only an idempotent local credential timeout or resource failure can retry once", async () => {
  for (const reason of [{ killed: true, signal: "SIGTERM" }, { code: "ETIMEDOUT" }, { code: "EAGAIN" }, { code: "ENOMEM" }]) {
    let calls = 0;
    const result = await readBirdUserCredentials(async () => {
      if (++calls === 1) throw Object.assign(new Error("private stdout must never escape"), reason);
      return '\uFEFF' + JSON.stringify({ authToken: "offline_retry_auth", ct0: "offline_retry_csrf" });
    });
    assert.deepEqual(result, { authToken: "offline_retry_auth", ct0: "offline_retry_csrf" });
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(readBirdUserCredentials(async () => {
    calls++; throw Object.assign(new Error("offline_secret_in_message"), { killed: true, stdout: "offline_secret_in_stdout",
      stderr: "offline_secret_in_stderr", cmd: "offline_secret_in_command", cause: new Error("offline_secret_in_cause") });
  }), error => {
    assert.ok(error instanceof BirdCredentialReadError); assert.equal(error.category, "timeout"); assert.equal(error.attempts, 2);
    assert.match(error.message, /before Bird CLI/); assert.equal(error.status, null); assert.equal(Object.hasOwn(error, "cause"), false);
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /offline_secret/); return true;
  });
  assert.equal(calls, 2);
});
test("nontransient local credential errors expose only their safe class and never retry", async () => {
  for (const [reason, category] of [
    [{ code: "ENOENT" }, "executable-unavailable"], [{ code: "EACCES" }, "permission-denied"],
    [{ code: "EPERM" }, "permission-denied"], [{ code: 7 }, "child-exit"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "output-limit"], [{ code: "unknown-secret-code" }, "local-read-failed"],
  ] as const) {
    let calls = 0;
    await assert.rejects(readBirdUserCredentials(async () => {
      calls++; throw Object.assign(new Error("offline_secret"), reason, { stdout: "offline_secret", stderr: "offline_secret" });
    }), error => {
      assert.ok(error instanceof BirdCredentialReadError); assert.equal(error.category, category); assert.equal(error.attempts, 1);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /offline_secret|unknown-secret-code/); return true;
    });
    assert.equal(calls, 1);
  }
});
test("credential output parsing cannot expose raw output or mistake invalid JSON for missing cookies", async () => {
  for (const output of ['{"authToken":"offline_secret', "null", "[]", '"offline_secret"']) {
    let calls = 0;
    await assert.rejects(readBirdUserCredentials(async () => { calls++; return output; }), error => {
      assert.ok(error instanceof BirdCredentialReadError); assert.equal(error.category, "invalid-output");
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /offline_secret/); return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readBirdUserCredentials(async () => { calls++; return JSON.stringify({ authToken: "offline_auth" }); }), /AUTH_TOKEN and CT0 are required/);
  assert.equal(calls, 1);
});
test("unclassified CLI exit keeps safe process evidence without retrying or leaking echoed cookies", async () => {
  const runtime = fixture(`import{appendFileSync}from'node:fs';appendFileSync('cli-count.txt','1');process.stderr.write('unclassified '+process.env.AUTH_TOKEN+' '+process.env.CT0);process.exit(7);`);
  const secrets = await loadBirdSecrets(runtime);
  await assert.rejects(runBirdCommand(runtime, "read", ["123"], secrets), error => {
    assert.equal((error as any).status, null); assert.equal((error as any).retryable, true);
    assert.match((error as Error).message, /unclassified; CLI exit 7/);
    assert.doesNotMatch(String((error as Error).stack) + JSON.stringify(error), /offline_auth_cookie|offline_csrf_cookie/); return true;
  });
  assert.equal(readFileSync(path.join(runtime.cwd, "cli-count.txt"), "utf8"), "1");
});
test("target visibility keywords retain uncertainty instead of manufacturing an HTTP 404", () => {
  const unknown = classifyBirdFailure("Failed to fetch tweets: User @SpaceXAI not found or unavailable", { code: 1, signal: null });
  assert.equal(unknown.status, null); assert.equal(unknown.retryable, false);
  assert.match(unknown.message, /no HTTP status reported; CLI exit 1; cause not confirmed/);
  const forbidden = classifyBirdFailure("HTTP 403 protected user", { code: 1, signal: null });
  assert.equal(forbidden.status, null); assert.match(forbidden.message, /reported HTTP 403/);
  assert.equal(classifyBirdFailure("HTTP 404 missing").status, 404);
  assert.equal(classifyBirdFailure("HTTP 401 auth failure").status, 401);
  assert.equal(classifyBirdFailure("HTTP 429 protected user").retryable, true);
  const signal = classifyBirdFailure("unclassified", { code: null, signal: "SIGTERM" });
  assert.match(signal.message, /CLI exit unknown; signal SIGTERM/);
  const unsafe = classifyBirdFailure("unclassified", { code: NaN, signal: "offline_secret" as any });
  assert.doesNotMatch(unsafe.message, /NaN|offline_secret/);
});
test("normalization retains Note Tweet, Article evidence, references and exact large IDs", () => {
  const note = normalizeBirdTweet({ ...raw(), text: "truncated", _raw: { note_tweet: { note_tweet_results: { result: { text: "Complete long Note Tweet" } } } } });
  assert.equal(note.id_str, raw().id); assert.equal(note.full_text, "Complete long Note Tweet"); assert.equal(note.birdContent.kind, "note");
  const preview = normalizeBirdTweet({ ...raw(), text: "Article title", article: { title: "Article title", previewText: "Preview only" } });
  assert.equal(preview.birdContent.bodyLevel, "preview"); assert.equal(birdTweetArticle(preview), null);
  const full = normalizeBirdTweet({ ...raw(), text: "Article title\n\nConfirmed whole body", article: { title: "Article title", previewText: "Preview only" },
    _raw: { article: { article_results: { result: { title: "Article title", content_state: { blocks: [{ type: "unstyled", text: "Confirmed whole body" }] } } } } } }, "read");
  assert.equal(full.birdContent.bodyLevel, "full"); assert.equal(birdTweetArticle(full)?.content_state?.blocks?.[0]?.text, "Confirmed whole body");
  const quote = normalizeBirdTweet({ ...raw(), inReplyToStatusId: "111", quotedTweet: { ...raw("222"), author: { username: "quoted_author" } } });
  assert.equal(quote.in_reply_to_status_id_str, "111"); assert.equal(quote.quoted_status?.user.screen_name, "quoted_author");
  assert.throws(() => normalizeBirdTweet({ ...raw(), author: {} }), /actor/);
  assert.throws(() => normalizeBirdTweet({ ...raw(), createdAt: "" }), /original date/);
  assert.equal(decodeBirdTweets([raw()]).nextCursor, null);
  assert.equal(decodeBirdTweets({ tweets: [raw()], nextCursor: "opaque_cursor" }).nextCursor, "opaque_cursor");
  assert.throws(() => decodeBirdTweets({ ok: true }), /missing tweets/);
});
test("Article read commentary, previews and links are never promoted into a full Article body", () => {
  for (const mappedText of ["Read my commentary about this article https://x.com/i/article/987", "Article title\nPreview only\nhttps://x.com/i/article/987", "Long commentary\n\nSeveral paragraphs from the post, not the Article body"]) {
    const read = normalizeBirdTweet({ ...raw(), text: mappedText, article: { title: "Article title", previewText: "Preview only" },
      _raw: { article: { article_results: { result: { title: "Article title", preview_text: "Preview only" } } } } }, "read");
    assert.equal(read.birdContent.bodyLevel, "preview"); assert.equal(birdTweetArticle(read), null);
  }
  const plain = normalizeBirdTweet({ ...raw(), article: { title: "Article title" },
    _raw: { article: { article_results: { result: { title: "Article title", plain_text: "Confirmed raw Article body" } } } } }, "read");
  assert.equal(plain.birdContent.bodyLevel, "full"); assert.equal(birdTweetArticle(plain)?.content_state?.blocks?.[0]?.text, "Confirmed raw Article body");
  const titleOnly = normalizeBirdTweet({ ...raw(), article: { title: "Article title" },
    _raw: { article: { article_results: { result: { title: "Article title", content_state: { blocks: [{ type: "header-one", text: "Article title" }] } } } } } }, "read");
  assert.equal(titleOnly.birdContent.bodyLevel, "preview");
});
test("whoami parses only public account identity from the pinned CLI's textual output", () => {
  assert.deepEqual(parseBirdWhoami("🙋 @example (Example Name)\n🪪 9911223344\nsource: environment"), { username: "example", id: "9911223344", name: "Example Name" });
  assert.throws(() => parseBirdWhoami("no account"), /authenticated username/);
});
test("protected authors are rejected and protected quote bodies cannot enter a public receipt", () => {
  const privateGraph = { rest_id: "222", legacy: { full_text: "private body must disappear", created_at: "2026-10-13T01:00:00Z" },
    core: { user_results: { result: { rest_id: "333", legacy: { screen_name: "private_actor", protected: true } } } } };
  const privateTweet = { ...raw("222"), text: "private body must disappear", author: { username: "private_actor" }, _raw: privateGraph };
  assert.throws(() => normalizeBirdTweet(privateTweet), error => {
    assert.equal((error as any).status, 404); assert.equal((error as Error).message, "Bird target is not public"); return true;
  });
  assert.throws(() => decodeBirdTweets({ tweets: [privateTweet], nextCursor: null }), /not public/);
  const publicQuote = { ...raw(), quotedTweet: privateTweet, _raw: { legacy: { quoted_status_id_str: "222" },
    quoted_status_result: { result: privateGraph } } };
  const normalized = normalizeBirdTweet(publicQuote);
  assert.equal(normalized.full_text, "Original evidence"); assert.equal(normalized.quoted_status, null);
  assert.equal(normalized.birdContent.quotedTweetId, "222");
  const sanitized = sanitizeBirdPublicPayload({ tweets: [publicQuote], nextCursor: "next" }) as any;
  assert.equal(sanitized.tweets.length, 1); assert.equal(sanitized.tweets[0].quotedTweet, undefined);
  assert.ok(!JSON.stringify(sanitized).includes("private body must disappear"));
  assert.ok(!JSON.stringify(sanitized).includes("private_actor"));
  assert.equal(decodeBirdTweets(sanitized).tweets[0]?.quoted_status, null);
});
