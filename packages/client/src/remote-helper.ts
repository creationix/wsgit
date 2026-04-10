#!/usr/bin/env node
/**
 * Git remote helper for the wsgit:// protocol.
 *
 * Git invokes this as: git-remote-wsgit <remote-name> <url>
 * Communication is via stdin/stdout line protocol.
 *
 * Uses "push"/"fetch" capabilities with git plumbing to read/write
 * objects directly, matching the per-object WebSocket protocol.
 */
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const promisifiedExec = promisify(execFile);
import {
  ObjectType,
  type ObjectTypeByte,
  type Sha1Hex,
  encodeObjectFrame,
  decodeObjectFrame,
  encodeWantFrame,
  decodeWantFrame,
  hexToBuffer,
  bufferToHex,
  hashObject,
  parseChildren,
  type LatencyConfig,
  wrapWithLatency,
} from "@ws-git/protocol";
import {
  readObject,
  listObjects,
  resolveRef,
  writeObject,
  updateRef,
} from "./git-plumbing.js";

const remoteName = process.argv[2];
const remoteUrl = process.argv[3];

if (!remoteUrl) {
  process.stderr.write("Usage: git-remote-wsgit <remote> <url>\n");
  process.exit(1);
}

const latencyMs = parseInt(process.env.GIT_WSGIT_LATENCY_MS ?? "0", 10);
const latency: LatencyConfig | undefined =
  latencyMs > 0 ? { latencyMs: latencyMs / 2 } : undefined;

function toWsUrl(wsgitUrl: string, endpoint: string): string {
  const parsed = new URL(wsgitUrl.replace("wsgit://", "http://"));
  const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${wsScheme}//${parsed.host}/repos${parsed.pathname}/${endpoint}`;
}

/** Query remote refs via the fetch endpoint. */
async function remoteRefs(refPrefix: string): Promise<Record<string, Sha1Hex>> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(toWsUrl(remoteUrl, "fetch"));
    if (latency) ws = wrapWithLatency(ws, latency);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, ref: refPrefix }));
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        if (msg.status === "refs") {
          ws.send(JSON.stringify({ id: 1, status: "done" }));
          resolve(msg.refs as Record<string, Sha1Hex>);
        }
      }
    });

    ws.on("close", () => resolve({}));
    ws.on("error", reject);
  });
}

/** Push objects for a ref update. */
async function doPush(
  localRef: string,
  remoteRef: string,
  force: boolean,
): Promise<{ ok: boolean; message?: string }> {
  const localHash = await resolveRef(localRef);
  if (!localHash) return { ok: false, message: `cannot resolve ${localRef}` };

  // Get remote's current hash for this ref to compute diff
  const refs = await remoteRefs(remoteRef);
  const remoteHash = refs[remoteRef] ?? null;

  // List objects to send
  const exclude = remoteHash ? [remoteHash] : [];
  const objectHashes = await listObjects([localHash], exclude);

  process.stderr.write(`[wsgit] pushing ${objectHashes.length} objects\n`);

  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(toWsUrl(remoteUrl, "push"));
    if (latency) ws = wrapWithLatency(ws, latency);

    ws.on("open", async () => {
      // Send control message
      const ctrl: Record<string, unknown> = {
        id: 1,
        ref: remoteRef,
        new: localHash,
      };
      if (force) ctrl.force = true;
      else if (remoteHash) ctrl.old = remoteHash;
      ws.send(JSON.stringify(ctrl));

      // Stream objects
      for (const hash of objectHashes) {
        try {
          const obj = await readObject(hash);
          const frame = encodeObjectFrame(
            obj.type,
            hexToBuffer(obj.hash),
            obj.body,
          );
          ws.send(frame);
        } catch (err) {
          process.stderr.write(`[wsgit] warning: could not read ${hash}\n`);
        }
      }
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      ws.close();
      if (msg.status === "done") {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, message: msg.message });
      }
    });

    ws.on("error", reject);
  });
}

/** Check if a git object exists locally. */
async function hasLocalObject(hash: Sha1Hex): Promise<boolean> {
  try {
    await promisifiedExec("git", ["cat-file", "-e", hash]);
    return true;
  } catch {
    return false;
  }
}

/** Fetch objects for a ref. */
async function doFetch(remoteRef: string, remoteHash: Sha1Hex): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(toWsUrl(remoteUrl, "fetch"));
    if (latency) ws = wrapWithLatency(ws, latency);

    const received = new Set<Sha1Hex>();
    const requested = new Set<Sha1Hex>();
    let objectCount = 0;
    /** Objects we've requested but not yet received. */
    let outstanding = 0;
    /** Serialize async message processing to avoid races. */
    let msgQueue: Promise<void> = Promise.resolve();

    function finish() {
      ws.send(JSON.stringify({ id: 1, status: "done" }));
    }

    function checkDone() {
      if (outstanding === 0) {
        process.stderr.write(`[wsgit] fetched ${objectCount} objects\n`);
        finish();
      }
    }

    function requestObjects(hashes: Sha1Hex[]) {
      const toRequest: Buffer[] = [];
      for (const h of hashes) {
        if (!received.has(h) && !requested.has(h)) {
          requested.add(h);
          toRequest.push(hexToBuffer(h));
        }
      }
      if (toRequest.length > 0) {
        outstanding += toRequest.length;
        ws.send(encodeWantFrame(toRequest));
      }
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, ref: remoteRef }));
    });

    ws.on("message", (data, isBinary) => {
      msgQueue = msgQueue.then(async () => {
        if (isBinary) {
          const frame = decodeObjectFrame(Buffer.from(data as ArrayBuffer));
          if (!frame) return;

          const hex = bufferToHex(frame.hash);
          if (received.has(hex)) return;
          received.add(hex);
          outstanding--;
          objectCount++;

          await writeObject(frame.type, Buffer.from(frame.body));

          const children = parseChildren(frame.type, frame.body);
          const missing: Sha1Hex[] = [];
          for (const child of children) {
            if (!received.has(child) && !requested.has(child)) {
              if (!(await hasLocalObject(child))) {
                missing.push(child);
              }
            }
          }
          requestObjects(missing);
          checkDone();
        } else {
          const msg = JSON.parse(data.toString());
          if (msg.status === "refs") {
            const refs = msg.refs as Record<string, Sha1Hex>;
            const hash = refs[remoteRef];
            if (!hash) {
              finish();
              return;
            }
            if (await hasLocalObject(hash)) {
              process.stderr.write("[wsgit] already up to date\n");
              finish();
            } else {
              requestObjects([hash]);
            }
          }
        }
      });
    });

    ws.on("close", () => resolve());
    ws.on("error", reject);
  });
}

// --- Main stdin/stdout protocol loop ---

const rl = readline.createInterface({ input: process.stdin });
const lines: string[] = [];
let processing = false;

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim();

  if (trimmed === "capabilities") {
    process.stdout.write("push\n");
    process.stdout.write("fetch\n");
    process.stdout.write("\n");
  } else if (trimmed === "list" || trimmed === "list for-push") {
    const refs = await remoteRefs("refs/");
    for (const [ref, hash] of Object.entries(refs)) {
      process.stdout.write(`${hash} ${ref}\n`);
    }
    process.stdout.write("\n");
  } else if (trimmed.startsWith("push ")) {
    // Format: "push +<src>:<dst>" or "push <src>:<dst>"
    const spec = trimmed.slice(5);
    const force = spec.startsWith("+");
    const refspec = force ? spec.slice(1) : spec;
    const [src, dst] = refspec.split(":");

    const result = await doPush(src, dst, force);
    if (result.ok) {
      process.stdout.write(`ok ${dst}\n`);
    } else {
      process.stdout.write(`error ${dst} ${result.message ?? "push failed"}\n`);
    }
    process.stdout.write("\n");
  } else if (trimmed.startsWith("fetch ")) {
    // Format: "fetch <hash> <ref>"
    const parts = trimmed.slice(6).split(" ");
    const hash = parts[0];
    const ref = parts[1];

    await doFetch(ref, hash);
    // Git may send multiple fetch lines before a blank line
    // Don't respond until we get the blank line
  } else if (trimmed === "") {
    // End of fetch batch — respond
    process.stdout.write("\n");
  } else {
    process.stderr.write(`[wsgit] unknown command: ${trimmed}\n`);
  }
}

rl.on("line", async (line) => {
  lines.push(line);
  if (processing) return;
  processing = true;
  while (lines.length > 0) {
    const next = lines.shift()!;
    await processLine(next);
  }
  processing = false;
});

rl.on("close", () => {
  process.exit(0);
});

// Handle EPIPE gracefully — git may close its end before we finish writing
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
