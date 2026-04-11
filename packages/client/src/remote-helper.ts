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
import { execFile, execFileSync } from "node:child_process";
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
  parseChildren,
  type LatencyConfig,
  wrapWithLatency,
} from "@ws-git/protocol";
import {
  readObject,
  resolveRef,
  writeObject,
} from "./git-plumbing.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRate(bytes: number, elapsedMs: number): string {
  if (elapsedMs === 0) return "-- /s";
  return `${formatSize((bytes / elapsedMs) * 1000)}/s`;
}

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

function toLfsUrl(wsgitUrl: string): string {
  const parsed = new URL(wsgitUrl.replace("wsgit://", "http://"));
  const httpScheme = parsed.protocol === "https:" ? "https:" : "http:";
  return `${httpScheme}//${parsed.host}/repos${parsed.pathname}/info/lfs`;
}

// Configure LFS endpoint for this remote so git-lfs talks to our server
if (remoteName) {
  const lfsUrl = toLfsUrl(remoteUrl);
  try {
    execFileSync("git", ["config", `remote.${remoteName}.lfsurl`, lfsUrl]);
  } catch {
    // Non-fatal — LFS may not be installed
  }
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

  process.stderr.write(`[wsgit] pushing ${localRef} → ${remoteRef}\n`);

  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(toWsUrl(remoteUrl, "push"));
    if (latency) ws = wrapWithLatency(ws, latency);

    let sent = 0;
    let expected = 0;
    let rawBytes = 0;
    let wireBytes = 0;
    const startTime = Date.now();
    let lastProgress = startTime;

    function showProgress() {
      const now = Date.now();
      if (now - lastProgress >= 500) {
        const elapsed = now - startTime;
        const objRate = Math.round((sent / elapsed) * 1000);
        process.stderr.write(`\r[wsgit] pushing: ${sent}/${expected} objects, ${objRate} obj/s, ${formatRate(rawBytes, elapsed)} raw, ${formatRate(wireBytes, elapsed)} wire`);
        lastProgress = now;
      }
    }

    ws.on("open", () => {
      const ctrl: Record<string, unknown> = {
        id: 1,
        ref: remoteRef,
        new: localHash,
      };
      if (force) ctrl.force = true;
      else if (remoteHash) ctrl.old = remoteHash;
      ws.send(JSON.stringify(ctrl));
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        // Server is asking for objects via want frames
        const wanted = decodeWantFrame(Buffer.from(data as ArrayBuffer));
        expected += wanted.length;
        const skipped: string[] = [];
        for (const hashBuf of wanted) {
          const hash = bufferToHex(hashBuf);
          try {
            const obj = await readObject(hash);
            const frame = encodeObjectFrame(obj.type, hashBuf, obj.body);
            ws.send(frame);
            sent++;
            rawBytes += obj.body.length;
            wireBytes += frame.length;
            showProgress();
          } catch (err) {
            skipped.push(hash);
          }
        }
        if (skipped.length > 0) {
          ws.send(JSON.stringify({ id: 1, skip: skipped }));
        }
      } else {
        // Control response — done or error
        const msg = JSON.parse(data.toString());
        const totalElapsed = Date.now() - startTime;
        const ratio = rawBytes > 0 ? ((1 - wireBytes / rawBytes) * 100).toFixed(0) : "0";
        process.stderr.write(`\r[wsgit] pushed ${sent} objects, ${formatSize(rawBytes)} -> ${formatSize(wireBytes)} (${ratio}% smaller), ${formatRate(wireBytes, totalElapsed)} wire\n`);
        ws.close();
        if (msg.status === "done") {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, message: msg.message });
        }
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
    let totalExpected = 0;
    let rawBytes = 0;
    let wireBytes = 0;
    /** Objects we've requested but not yet received. */
    let outstanding = 0;
    /** Serialize async message processing to avoid races. */
    let msgQueue: Promise<void> = Promise.resolve();
    const startTime = Date.now();
    let lastProgress = startTime;

    function finish() {
      const elapsed = Date.now() - startTime;
      const ratio = rawBytes > 0 ? ((1 - wireBytes / rawBytes) * 100).toFixed(0) : "0";
      process.stderr.write(`\r[wsgit] fetched ${objectCount} objects, ${formatSize(rawBytes)} -> ${formatSize(wireBytes)} (${ratio}% smaller), ${formatRate(wireBytes, elapsed)} wire\n`);
      ws.send(JSON.stringify({ id: 1, status: "done" }));
    }

    function checkDone() {
      const now = Date.now();
      if (now - lastProgress >= 500) {
        const elapsed = now - startTime;
        const objRate = Math.round((objectCount / elapsed) * 1000);
        process.stderr.write(`\r[wsgit] fetching: ${objectCount}/${totalExpected} objects, ${objRate} obj/s, ${formatRate(rawBytes, elapsed)} raw, ${formatRate(wireBytes, elapsed)} wire`);
        lastProgress = now;
      }
      if (outstanding === 0) {
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
        totalExpected += toRequest.length;
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

          const rawData = data as ArrayBuffer;
          const hex = bufferToHex(frame.hash);
          if (received.has(hex)) return;
          received.add(hex);
          outstanding--;
          objectCount++;
          rawBytes += frame.body.length;
          wireBytes += rawData.byteLength;

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
