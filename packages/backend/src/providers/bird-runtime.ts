// Bird runs in a restricted read-only child; X cookies never enter arguments or logs.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { config, credential } from "../config.ts";
import { ProviderRejectedError } from "./receipts.ts";

const execFileAsync = promisify(execFile);
export const BIRD_VERSION = "0.8.0";
export const BIRD_READ_COMMANDS = new Set(["user-tweets", "search", "read", "thread", "whoami", "--version"]);
export interface BirdSecrets { authToken: string; ct0: string }
export interface BirdRuntime {
  cliPath: string; nodePath: string; profile: string; credentialMode: "user-env" | "process-env";
  proxyUrl: string | null; queryCache: string; cwd: string; timeoutMs: number; maxBytes: number;
  expectedUserId: string | null; expectedUsername: string | null; cliHash: string;
}
export class BirdConfigurationError extends ProviderRejectedError {
  constructor(message: string) { super(message, null, false); }
}

const setting = (name: string) => credential("collectors", name);
function systemEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    const found = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found) env[name] = found[1];
  }
  return env;
}
function bounded(name: string, fallback: number, maximum: number): number {
  const value = setting(name); const parsed = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new BirdConfigurationError(`Invalid ${name}`);
  return parsed;
}
export function birdRuntime(accountProfile?: string): BirdRuntime {
  if (!/^(1|true)$/i.test(setting("BIRD_ENABLED") ?? "false")) throw new BirdConfigurationError("Bird collection is disabled");
  const profile = setting("BIRD_ACCOUNT_PROFILE") ?? "birdclaw-primary";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile) || (accountProfile && accountProfile !== profile)) {
    throw new BirdConfigurationError("Bird account profile is not configured");
  }
  const projectCli = path.resolve(import.meta.dirname, "../../../../node_modules/@steipete/bird/dist/cli.js");
  const cli = setting("BIRD_CLI_PATH") ?? (existsSync(projectCli) ? projectCli : path.join(process.env.APPDATA ?? "", "npm/node_modules/@steipete/bird/dist/cli.js"));
  const nodePath = setting("BIRD_NODE_PATH") ?? process.execPath;
  if (!path.isAbsolute(cli) || !existsSync(cli) || !path.isAbsolute(nodePath) || !existsSync(nodePath)) {
    throw new BirdConfigurationError("Bird CLI or Node executable is unavailable");
  }
  const cliPath = realpathSync(cli);
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(readFileSync(path.resolve(path.dirname(cliPath), "../package.json"), "utf8")); }
  catch { throw new BirdConfigurationError("Bird package manifest is unavailable"); }
  if (manifest.name !== "@steipete/bird" || manifest.version !== BIRD_VERSION) throw new BirdConfigurationError("Bird requires the pinned 0.8.0 package");
  const cliHash = createHash("sha256").update(readFileSync(cliPath)).digest("hex");
  const expectedHash = setting("BIRD_CLI_SHA256");
  if (expectedHash && cliHash !== expectedHash.toLowerCase()) throw new BirdConfigurationError("Bird CLI integrity check failed");
  const mode = setting("BIRD_CREDENTIAL_MODE") ?? (process.platform === "win32" ? "user-env" : "process-env");
  if (mode !== "user-env" && mode !== "process-env") throw new BirdConfigurationError("Invalid BIRD_CREDENTIAL_MODE");
  if (mode === "user-env" && process.platform !== "win32") throw new BirdConfigurationError("Bird user-env credentials require Windows");
  const proxyUrl = setting("BIRD_PROXY_URL") ?? config.egressProxyUrl;
  if (proxyUrl) {
    try { if (!["http:", "https:"].includes(new URL(proxyUrl).protocol)) throw new Error(); }
    catch { throw new BirdConfigurationError("Invalid Bird proxy URL"); }
  }
  const expectedUserId = setting("BIRD_EXPECTED_USER_ID");
  const expectedUsername = setting("BIRD_EXPECTED_USERNAME")?.replace(/^@/, "") ?? null;
  if ((expectedUserId && !/^\d+$/.test(expectedUserId)) || (expectedUsername && !/^[a-zA-Z0-9_]{1,15}$/.test(expectedUsername))) {
    throw new BirdConfigurationError("Invalid Bird expected account identity");
  }
  const cwd = path.resolve(config.dataDir, "runtime/bird");
  return { cliPath, cliHash, nodePath, profile, credentialMode: mode, proxyUrl, cwd,
    queryCache: path.join(cwd, "query-ids-cache.json"), timeoutMs: bounded("BIRD_PROCESS_TIMEOUT_MS", 45_000, 45_000),
    maxBytes: bounded("BIRD_MAX_OUTPUT_BYTES", 8 * 1024 * 1024, 8 * 1024 * 1024), expectedUserId, expectedUsername };
}

export async function loadBirdSecrets(runtime: Pick<BirdRuntime, "credentialMode">): Promise<BirdSecrets> {
  let authToken: string | undefined; let ct0: string | undefined;
  if (runtime.credentialMode === "user-env") {
    // Read the current user registry rather than an old host environment snapshot. stdout is private
    // in-memory IPC only; neither the output nor child-process errors are forwarded to logging.
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; @{authToken=[Environment]::GetEnvironmentVariable('AUTH_TOKEN','User');ct0=[Environment]::GetEnvironmentVariable('CT0','User')} | ConvertTo-Json -Compress";
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    try {
      const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8", env: systemEnvironment() });
      const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ""));
      authToken = parsed.authToken; ct0 = parsed.ct0;
    } catch { throw new BirdConfigurationError("Unable to read Bird current-user credentials"); }
  } else {
    authToken = setting("BIRD_AUTH_TOKEN") ?? process.env.AUTH_TOKEN;
    ct0 = setting("BIRD_CT0") ?? process.env.CT0;
  }
  if (typeof authToken !== "string" || typeof ct0 !== "string" || !authToken.trim() || !ct0.trim()
    || authToken.length > 4096 || ct0.length > 4096 || /[\x00-\x20\x7F]/.test(authToken + ct0)) {
    throw new BirdConfigurationError("Bird AUTH_TOKEN and CT0 are required");
  }
  return { authToken, ct0 };
}
export function birdCredentialFingerprint(secrets: BirdSecrets): string {
  return createHash("sha256").update(secrets.authToken).update("\0").update(secrets.ct0).digest("hex");
}
export function birdChildEnvironment(runtime: BirdRuntime, secrets: BirdSecrets): NodeJS.ProcessEnv {
  const env = systemEnvironment();
  Object.assign(env, { NODE_ENV: "production", AUTH_TOKEN: secrets.authToken, CT0: secrets.ct0, NO_COLOR: "1",
    BIRD_QUERY_IDS_CACHE: runtime.queryCache, NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost,127.0.0.1,::1" });
  if (runtime.proxyUrl) Object.assign(env, { HTTP_PROXY: runtime.proxyUrl, HTTPS_PROXY: runtime.proxyUrl, ALL_PROXY: runtime.proxyUrl });
  return env;
}
export function classifyBirdFailure(stderr: string): ProviderRejectedError {
  const status = /HTTP\s+(\d{3})\b/i.exec(stderr)?.[1];
  const code = status ? Number(status) : null;
  if (code === 403 && /private|protected|suspended/i.test(stderr)) return new ProviderRejectedError("Bird target is unavailable", 404, false);
  if (code !== null) return new ProviderRejectedError(`Bird HTTP ${code}`, code, code === 429 || code >= 500);
  if (/credentials|unauthorized|authentication/i.test(stderr)) return new ProviderRejectedError("Bird authentication failed", 401, false);
  if (/suspended|not found|private|protected/i.test(stderr)) return new ProviderRejectedError("Bird target is unavailable", 404, false);
  if (/unknown option|unexpected|JSON/i.test(stderr)) return new ProviderRejectedError("Bird response or command is incompatible", null, false);
  return new ProviderRejectedError("Bird command failed", null, true);
}

/** No shell and no credential arguments. A Node CLI does not create an uncontrolled child tree. */
export async function runBirdCommand(runtime: BirdRuntime, command: string, args: string[], secrets: BirdSecrets, signal?: AbortSignal): Promise<string> {
  if (!BIRD_READ_COMMANDS.has(command) || args.some(a => /^(?:--auth-token|--ct0)(?:=|$)/.test(a))) {
    throw new BirdConfigurationError("Bird command is outside the read-only allowlist");
  }
  signal?.throwIfAborted();
  mkdirSync(runtime.cwd, { recursive: true });
  return new Promise<string>((resolve, reject) => {
    const child = spawn(runtime.nodePath, [runtime.cliPath, "--timeout", "20000", "--quote-depth", "1", command, ...args], {
      cwd: runtime.cwd, env: birdChildEnvironment(runtime, secrets), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    let failed: Error | null = null;
    const stop = (error: Error) => { if (!failed) { failed = error; child.kill("SIGKILL"); } };
    const abort = () => stop(new Error("Bird task was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("Bird process exceeded its total time limit")), runtime.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > runtime.maxBytes) stop(new Error("Bird JSON output exceeded its size limit")); else stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.length; if (errBytes <= 256 * 1024) stderr.push(chunk); else stop(new Error("Bird diagnostic output exceeded its size limit")); });
    child.on("error", () => { failed = new BirdConfigurationError("Unable to launch the configured Bird CLI"); });
    child.on("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failed) reject(failed);
      else if (code !== 0) reject(classifyBirdFailure(Buffer.concat(stderr).toString("utf8")));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    if (signal?.aborted) abort();
  });
}

/** Even a malformed CLI echo must not persist a credential into a reusable receipt. */
export function redactBirdResponse(value: unknown, secrets: BirdSecrets, depth = 0): unknown {
  if (depth > 40) throw new ProviderRejectedError("Bird response nesting exceeds its limit", null, false);
  if (typeof value === "string") return value.replaceAll(secrets.authToken, "[redacted]").replaceAll(secrets.ct0, "[redacted]");
  if (Array.isArray(value)) return value.map(item => redactBirdResponse(item, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /cookie|auth.?token|ct0|authorization|api.?key|password/i.test(key) ? "[redacted]" : redactBirdResponse(item, secrets, depth + 1)]));
  return value;
}
