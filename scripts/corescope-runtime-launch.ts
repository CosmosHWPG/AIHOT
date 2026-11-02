// A background process owns its console and has no pipe back to the startup window.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** The private file takes precedence over shell settings, including Windows key casing. */
export function loadLaunchEnvironment(envFile: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configured = { ...parseEnv(readFileSync(envFile, "utf8")), NODE_ENV: "production" };
  const identity = (key: string) => process.platform === "win32" ? key.toUpperCase() : key;
  const configuredKeys = new Set(Object.keys(configured).map(identity));
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !configuredKeys.has(identity(key)))), ...configured };
}

export interface DetachedLaunchOptions {
  cwd: string;
  stdout: string;
  stderr: string;
  env?: NodeJS.ProcessEnv;
  /** A short control command (pg_ctl), whose real exit code must be checked. */
  waitForExit?: boolean;
  timeoutMs?: number;
}

export interface DetachedLaunchResult {
  pid: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export function launchDetached(executable: string, args: string[], options: DetachedLaunchOptions): Promise<DetachedLaunchResult> {
  const out = openSync(options.stdout, "a");
  let err: number | undefined;
  try {
    err = openSync(options.stderr, "a");
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env ?? process.env,
      detached: true, windowsHide: true, stdio: ["ignore", out, err],
    });
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("spawn", () => {
        child.unref();
        if (!options.waitForExit) return resolve({ pid: child.pid! });
        // The timer keeps this control invocation alive while the child is detached.
        timer = setTimeout(() => reject(new Error(`Background control timed out after ${options.timeoutMs ?? 70_000} ms; inspect its logs before retrying.`)), options.timeoutMs ?? 70_000);
      });
      child.once("exit", (exitCode, signal) => {
        clearTimeout(timer);
        if (options.waitForExit) resolve({ pid: child.pid!, exitCode, signal });
      });
    });
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
}
