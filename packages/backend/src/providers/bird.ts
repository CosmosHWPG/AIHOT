// Independently scheduled, receipt-backed read access to a pinned local Bird CLI.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { paidRequest, logicalKeyFor, BudgetExceededError, ProviderRejectedError, type ReceiptRequest } from "./receipts.ts";
import type { SdArticle, SearchResult } from "./socialdata.ts";
import { birdRuntime, loadBirdSecrets, birdCredentialFingerprint, runBirdCommand, redactBirdResponse, BirdConfigurationError,
  type BirdRuntime, type BirdSecrets } from "./bird-runtime.ts";
import { normalizeBirdTweet, decodeBirdTweets, parseBirdWhoami, birdTweetArticle, sanitizeBirdPublicPayload, type BirdTweet } from "./bird-normalize.ts";
export { normalizeBirdTweet, decodeBirdTweets, parseBirdWhoami, BirdConfigurationError };
export type { BirdTweet };

export interface BirdOptions { purpose?: string; subject: string; window?: string; accountProfile?: string; signal?: AbortSignal }
export interface BirdSearchOptions extends BirdOptions { window: string; cursor?: string | null }
interface ProfileRow {
  lease_until: Date | null; cooldown_until: Date | null; credential_fingerprint: string | null;
  verified_user_id: string | null; verified_username: string | null; verified_at: Date | null;
}

async function takeLease(runtime: BirdRuntime, secrets: BirdSecrets, verify: boolean): Promise<string> {
  const owner = randomUUID(); const fingerprint = birdCredentialFingerprint(secrets);
  await sql.begin(async tx => {
    await tx`INSERT INTO bird_profile_gate (profile) VALUES (${runtime.profile}) ON CONFLICT DO NOTHING`;
    const [row] = await tx<ProfileRow[]>`SELECT lease_until, cooldown_until, credential_fingerprint,
      verified_user_id, verified_username, verified_at FROM bird_profile_gate WHERE profile = ${runtime.profile} FOR UPDATE`;
    if (row!.lease_until && row!.lease_until.getTime() > Date.now()) throw new BudgetExceededError("bird", "profile-busy", 5);
    if (verify && row!.cooldown_until && row!.cooldown_until.getTime() > Date.now()) {
      throw new BudgetExceededError("bird", "profile-cooldown", Math.ceil((row!.cooldown_until.getTime() - Date.now()) / 1000));
    }
    if (verify && (!row!.verified_at || row!.credential_fingerprint !== fingerprint)) {
      throw new BirdConfigurationError("Bird session requires an authenticated whoami check");
    }
    if (verify && ((runtime.expectedUserId && row!.verified_user_id !== runtime.expectedUserId)
      || (runtime.expectedUsername && row!.verified_username?.toLowerCase() !== runtime.expectedUsername.toLowerCase()))) {
      throw new BirdConfigurationError("Bird authenticated account does not match the configured identity");
    }
    // The child has a <=45s total deadline. A crashed owner cannot hold the account indefinitely.
    await tx`UPDATE bird_profile_gate SET lease_owner = ${owner}, lease_until = now() + interval '120 seconds', updated_at = now()
      WHERE profile = ${runtime.profile}`;
  });
  return owner;
}
async function releaseLease(profile: string, owner: string): Promise<void> {
  await sql`UPDATE bird_profile_gate SET lease_owner = NULL, lease_until = NULL, updated_at = now()
    WHERE profile = ${profile} AND lease_owner = ${owner}`;
}
async function recordCooldown(runtime: BirdRuntime, error: unknown): Promise<void> {
  if (!(error instanceof ProviderRejectedError)) return;
  if (error.status === 429) {
    await sql`UPDATE bird_profile_gate SET cooldown_until = now() + interval '15 minutes', cooldown_reason = 'HTTP 429', updated_at = now()
      WHERE profile = ${runtime.profile}`;
  } else if (error.status === 401 || error.status === 403) {
    await sql`UPDATE bird_profile_gate SET cooldown_until = now() + interval '30 minutes', cooldown_reason = ${`HTTP ${error.status}`},
      verified_at = NULL, credential_fingerprint = NULL, updated_at = now() WHERE profile = ${runtime.profile}`;
  }
}
function request(runtime: BirdRuntime, command: string, args: string[], opts: BirdOptions): ReceiptRequest {
  return { service: "bird", purpose: opts.purpose ?? "source_collect", subject: opts.subject, requireBudget: true,
    identity: { command, args, window: opts.window ?? "stable", profile: runtime.profile,
      expectedUserId: runtime.expectedUserId, expectedUsername: runtime.expectedUsername, version: "0.8.0", cliHash: runtime.cliHash },
    requestSummary: { command, profile: runtime.profile, window: opts.window ?? null, readOnly: true, maxPages: 1 } };
}
function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout.replace(/^\uFEFF/, "")); }
  catch { throw new ProviderRejectedError("Bird returned invalid JSON", null, false); }
}

async function invoke<T>(runtime: BirdRuntime, command: string, args: string[], opts: BirdOptions,
  parse: (stdout: string) => T, verify = true): Promise<{ response: T; receiptId: number; reused: boolean }> {
  const req = request(runtime, command, args, opts);
  // Already received answers are replayable while a session is cooling or its cookies are rotated.
  const [saved] = await sql<{ id: number; response: unknown }[]>`SELECT id, response FROM receipts
    WHERE logical_key = ${logicalKeyFor(req)} AND status IN ('received', 'completed')`;
  if (saved) return { response: saved.response as T, receiptId: saved.id, reused: true };
  opts.signal?.throwIfAborted();
  const secrets = await loadBirdSecrets(runtime); const owner = await takeLease(runtime, secrets, verify);
  try {
    const result = await paidRequest(req, async () => {
      try {
        const stdout = await runBirdCommand(runtime, command, args, secrets, opts.signal);
        const response = parse(stdout);
        const redacted = redactBirdResponse(response, secrets) as T;
        if (command === "whoami") {
          const identity = redacted as { id?: string; username: string };
          if ((runtime.expectedUserId && identity.id !== runtime.expectedUserId)
            || (runtime.expectedUsername && identity.username.toLowerCase() !== runtime.expectedUsername.toLowerCase())) {
            throw new BirdConfigurationError("Bird authenticated account does not match the configured identity");
          }
          await sql`UPDATE bird_profile_gate SET verified_user_id = ${identity.id ?? null}, verified_username = ${identity.username},
            credential_fingerprint = ${birdCredentialFingerprint(secrets)}, verified_at = now(), cooldown_until = NULL,
            cooldown_reason = NULL, updated_at = now() WHERE profile = ${runtime.profile} AND lease_owner = ${owner}`;
        }
        const tweets = (redacted as any)?.tweets;
        return { response: redacted, usage: { cliCalls: 1, ...(Array.isArray(tweets) ? { tweets: tweets.length } : {}) }, cost: null };
      } catch (error) { await recordCooldown(runtime, error); throw error; }
    });
    return { response: result.response as T, receiptId: result.receiptId, reused: result.reused };
  } finally { await releaseLease(runtime.profile, owner); }
}

export async function birdUserTweets(handle: string, opts: BirdSearchOptions): Promise<Omit<SearchResult, "tweets"> & { tweets: BirdTweet[] }> {
  const username = handle.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new BirdConfigurationError("Invalid Bird target handle");
  if (opts.cursor && (opts.cursor.length > 8192 || /[\r\n]/.test(opts.cursor))) throw new BirdConfigurationError("Invalid Bird pagination cursor");
  const runtime = birdRuntime(opts.accountProfile);
  const args = [username, "-n", "20", "--max-pages", "1", "--delay", "1000", "--json-full"];
  if (opts.cursor) args.push("--cursor", opts.cursor);
  const result = await invoke(runtime, "user-tweets", args, opts, stdout => {
    const payload = parseJson(stdout); decodeBirdTweets(payload); return sanitizeBirdPublicPayload(payload);
  });
  return { ...decodeBirdTweets(result.response), receiptId: result.receiptId, reused: result.reused };
}

export async function birdReadTweet(id: string, opts: BirdOptions): Promise<{ tweet: BirdTweet | null; receiptId: number; reused: boolean }> {
  if (!/^\d+$/.test(id)) throw new BirdConfigurationError("Invalid Bird tweet id");
  const runtime = birdRuntime(opts.accountProfile);
  const result = await invoke(runtime, "read", [id, "--json-full"], { ...opts, purpose: opts.purpose ?? "body_extract" }, stdout => {
    const payload = parseJson(stdout); const tweet = normalizeBirdTweet(payload, "read");
    if (tweet.id_str !== id) throw new ProviderRejectedError("Bird read returned a different tweet id", null, false);
    return sanitizeBirdPublicPayload(payload);
  });
  return { tweet: normalizeBirdTweet(result.response, "read"), receiptId: result.receiptId, reused: result.reused };
}
export async function getBirdArticleReceipt(id: string, opts: BirdOptions): Promise<{ article: SdArticle | null; receiptId: number; reused: boolean }> {
  const result = await birdReadTweet(id, { ...opts, purpose: opts.purpose ?? "body_extract" });
  return { article: birdTweetArticle(result.tweet), receiptId: result.receiptId, reused: result.reused };
}
export async function getBirdArticle(id: string, opts: BirdOptions): Promise<SdArticle | null> {
  return (await getBirdArticleReceipt(id, opts)).article;
}
export async function birdWhoami(opts: Partial<BirdOptions> = {}): Promise<{ id?: string; username: string; name?: string; receiptId: number; reused: boolean }> {
  const runtime = birdRuntime(opts.accountProfile);
  const result = await invoke(runtime, "whoami", [], { subject: opts.subject ?? `bird-account:${runtime.profile}`, purpose: "bird_auth_check",
    window: opts.window ?? new Date().toISOString(), accountProfile: opts.accountProfile, signal: opts.signal }, parseBirdWhoami, false);
  return { ...result.response, receiptId: result.receiptId, reused: result.reused };
}
export async function birdConfigurationStatus(): Promise<{ enabled: boolean; configured: boolean; credentialsConfigured: boolean; profile?: string; version?: string; identityVerified?: boolean; cooldownUntil?: string | null; reason?: string }> {
  try {
    const runtime = birdRuntime(); const secrets = await loadBirdSecrets(runtime);
    const [row] = await sql<ProfileRow[]>`SELECT lease_until, cooldown_until, credential_fingerprint, verified_user_id, verified_username, verified_at
      FROM bird_profile_gate WHERE profile = ${runtime.profile}`;
    return { enabled: true, configured: true, credentialsConfigured: true, profile: runtime.profile, version: "0.8.0",
      identityVerified: Boolean(row?.verified_at && row.credential_fingerprint === birdCredentialFingerprint(secrets)
        && (!runtime.expectedUserId || row.verified_user_id === runtime.expectedUserId)
        && (!runtime.expectedUsername || row.verified_username?.toLowerCase() === runtime.expectedUsername.toLowerCase())),
      cooldownUntil: row?.cooldown_until?.toISOString() ?? null };
  } catch (error) {
    return { enabled: !/disabled/.test(error instanceof Error ? error.message : ""), configured: false, credentialsConfigured: false,
      reason: error instanceof BirdConfigurationError ? error.message : "Bird configuration or status is unavailable" };
  }
}
