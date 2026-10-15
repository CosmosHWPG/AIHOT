// The native supervisor uses IPC so Windows can run the same graceful SIGTERM handlers as Docker.
import { pathToFileURL } from "node:url";

let stopping = false;
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "action" in message && message.action === "shutdown") {
    stopping = true;
    process.emit("SIGTERM", "SIGTERM");
  }
});

const entry = process.argv[2];
if (!entry) throw new Error("Missing CoreScope child entry");
process.argv = [process.argv[0]!, entry, ...process.argv.slice(3)];
await import(pathToFileURL(entry).href);
if (!stopping) process.send?.({ ready: true, pid: process.pid });
// A watch-style entry can finish after closing its DB. IPC must not keep that drained child alive.
process.channel?.unref();
