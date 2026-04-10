#!/usr/bin/env node
import path from "node:path";
import { createServer } from "./server.js";

const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const port = parseInt(flag("port", "9418"), 10);
const storePath = flag("store", path.join(process.cwd(), ".wsgit-store", "objects"));
const dbPath = flag("db", path.join(process.cwd(), ".wsgit-store", "refs.db"));
const latencyMs = parseInt(flag("latency-ms", "0"), 10);
const jitterMs = parseInt(flag("jitter-ms", "0"), 10);

const server = createServer({
  port,
  storePath,
  dbPath,
  latency: latencyMs > 0 ? { latencyMs, jitterMs } : undefined,
});

server.listen(() => {
  console.log(`wsgit-server listening on ws://localhost:${port}`);
  if (latencyMs > 0) {
    console.log(`  latency: ${latencyMs}ms ±${jitterMs}ms per direction`);
  }
  console.log(`  store: ${storePath}`);
  console.log(`  refs:  ${dbPath}`);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
