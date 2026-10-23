// The native supervisor uses IPC so Windows can run the same graceful SIGTERM handlers as Docker.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A watch entry may wait at top level until SIGTERM, while an early disconnect may precede its handler. */
export function childShutdownController(hooks: {
  hasHandler: () => boolean;
  signal: () => void;
  exit: (code: number) => void;
  timeoutMs?: number;
}) {
  let stopping = false;
  let loaded = false;
  let delivered = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const deliver = () => {
    if (!stopping || delivered) return;
    if (hooks.hasHandler()) {
      delivered = true;
      hooks.signal();
    } else if (loaded) {
      delivered = true;
      hooks.exit(0);
    } else {
      // Do not wait for a long-running top-level import to return before delivering shutdown.
      poll = setTimeout(deliver, 10);
      poll.unref();
    }
  };
  return {
    get stopping() { return stopping; },
    request() {
      if (stopping) return;
      stopping = true;
      deadline = setTimeout(() => hooks.exit(1), hooks.timeoutMs ?? 205_000);
      deadline.unref();
      deliver();
    },
    loaded() { loaded = true; deliver(); },
    dispose() { clearTimeout(deadline); clearTimeout(poll); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shutdown = childShutdownController({
    hasHandler: () => process.listenerCount("SIGTERM") > 0,
    signal: () => { process.emit("SIGTERM", "SIGTERM"); },
    exit: code => process.exit(code),
  });
  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "action" in message && message.action === "shutdown") shutdown.request();
  });
  // Loss of the actual parent IPC channel is sufficient authority for this child to drain itself.
  process.on("disconnect", () => shutdown.request());
  const entry = process.argv[2];
  if (!entry) throw new Error("Missing CoreScope child entry");
  process.argv = [process.argv[0]!, entry, ...process.argv.slice(3)];
  await import(pathToFileURL(entry).href);
  shutdown.loaded();
  if (!shutdown.stopping && process.connected) process.send?.({ ready: true, pid: process.pid }, error => { if (error) shutdown.request(); });
  // A watch-style entry can finish after closing its DB. IPC must not keep that drained child alive.
  process.channel?.unref();
}
