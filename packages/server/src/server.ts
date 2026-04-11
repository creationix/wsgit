import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { type LatencyConfig, wrapWithLatency } from "@ws-git/protocol";
import { ObjectStore } from "./object-store.js";
import { RefStore } from "./ref-store.js";
import { LfsStore } from "./lfs-store.js";
import { PushHandler } from "./push-handler.js";
import { FetchHandler } from "./fetch-handler.js";

export interface ServerConfig {
  port: number;
  storePath: string;
  dbPath: string;
  lfsPath?: string;
  latency?: LatencyConfig;
}

let connId = 0;

function log(id: number, repo: string, msg: string) {
  console.log(`[${id}] ${repo} ${msg}`);
}

export function createServer(config: ServerConfig) {
  const objects = new ObjectStore(config.storePath);
  const refs = new RefStore(config.dbPath);
  const lfs = new LfsStore(config.lfsPath ?? config.storePath.replace(/objects$/, "lfs"));

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res, config, lfs);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(push|fetch)$/);

    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const repo = match[1];
    const mode = match[2] as "push" | "fetch";

    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = ++connId;
      let conn: WebSocket = ws;
      if (config.latency) {
        conn = wrapWithLatency(ws, config.latency);
      }

      log(id, repo, `${mode} connected`);

      if (mode === "push") {
        handlePush(id, conn, repo, objects, refs);
      } else {
        handleFetch(id, conn, repo, objects, refs);
      }
    });
  });

  return {
    listen: (cb?: () => void) => httpServer.listen(config.port, cb),
    close: () => {
      httpServer.close();
      refs.close();
    },
    httpServer,
  };
}

function handlePush(id: number, ws: WebSocket, repo: string, objects: ObjectStore, refs: RefStore) {
  const handler = new PushHandler(ws, repo, objects, refs);
  let objectCount = 0;
  const startTime = Date.now();

  handler.onResult = (ref, status, message) => {
    if (status === "done") {
      log(id, repo, `push ${ref} ok`);
    } else {
      log(id, repo, `push ${ref} rejected: ${message}`);
    }
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      objectCount++;
      handler.handleObject(Buffer.from(data as ArrayBuffer));
    } else {
      const msg = JSON.parse(data.toString());
      if (msg.skip) {
        handler.handleSkip(msg.skip);
      } else {
        log(id, repo, `push ${msg.ref} → ${msg.new.slice(0, 8)}${msg.force ? " (force)" : ""}${msg.old ? ` (cas from ${msg.old.slice(0, 8)})` : ""}`);
        handler.handleControl(msg);
      }
    }
  });

  ws.on("close", () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(id, repo, `push disconnected — ${objectCount} objects in ${elapsed}s`);
  });
}

// --- LFS HTTP handlers ---

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ServerConfig,
  lfs: LfsStore,
) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  // POST /repos/:owner/:repo/info/lfs/objects/batch
  const batchMatch = url.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/info\/lfs\/objects\/batch$/,
  );
  if (batchMatch && method === "POST") {
    const repo = batchMatch[1];
    const body = JSON.parse((await readBody(req)).toString());
    await handleLfsBatch(req, res, config, repo, lfs, body);
    return;
  }

  // PUT/GET /repos/:owner/:repo/lfs/objects/:oid
  const objMatch = url.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/lfs\/objects\/([0-9a-f]{64})$/,
  );
  if (objMatch && method === "PUT") {
    const [, repo, oid] = objMatch;
    await handleLfsUpload(req, res, repo, lfs, oid);
    return;
  }
  if (objMatch && method === "GET") {
    const [, repo, oid] = objMatch;
    await handleLfsDownload(res, repo, lfs, oid);
    return;
  }

  res.writeHead(404);
  res.end("Not found\n");
}

async function handleLfsBatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ServerConfig,
  repo: string,
  lfs: LfsStore,
  body: {
    operation: "upload" | "download";
    objects: Array<{ oid: string; size: number }>;
  },
) {
  const host = req.headers.host ?? `localhost:${config.port}`;
  const baseUrl = `http://${host}/repos/${repo}/lfs/objects`;
  const { operation, objects: requested } = body;

  console.log(`[lfs] ${repo} batch ${operation} — ${requested.length} objects`);

  const responseObjects = await Promise.all(
    requested.map(async (obj) => {
      const exists = await lfs.has(obj.oid);

      if (operation === "upload") {
        if (exists) {
          // Already have it — no action needed
          return { oid: obj.oid, size: obj.size };
        }
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: {
            upload: {
              href: `${baseUrl}/${obj.oid}`,
            },
          },
        };
      } else {
        // download
        if (!exists) {
          return {
            oid: obj.oid,
            size: obj.size,
            error: { code: 404, message: "Object not found" },
          };
        }
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: {
            download: {
              href: `${baseUrl}/${obj.oid}`,
            },
          },
        };
      }
    }),
  );

  res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
  res.end(JSON.stringify({ transfer: "basic", objects: responseObjects, hash_algo: "sha256" }));
}

async function handleLfsUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repo: string,
  lfs: LfsStore,
  oid: string,
) {
  console.log(`[lfs] ${repo} upload ${oid.slice(0, 12)}`);
  const { stream, path } = lfs.createWriteStream(oid);
  req.pipe(stream);
  stream.on("finish", () => {
    res.writeHead(200);
    res.end();
  });
  stream.on("error", (err) => {
    res.writeHead(500);
    res.end(err.message);
  });
}

async function handleLfsDownload(
  res: http.ServerResponse,
  repo: string,
  lfs: LfsStore,
  oid: string,
) {
  const size = await lfs.size(oid);
  if (size === null) {
    res.writeHead(404);
    res.end("Not found\n");
    return;
  }
  console.log(`[lfs] ${repo} download ${oid.slice(0, 12)}`);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": size,
  });
  lfs.createReadStream(oid).pipe(res);
}

// --- WebSocket handlers ---

function handleFetch(id: number, ws: WebSocket, repo: string, objects: ObjectStore, refs: RefStore) {
  const handler = new FetchHandler(ws, repo, objects, refs);
  let wantCount = 0;
  let sentCount = 0;
  const startTime = Date.now();

  const origHandleWant = handler.handleWant.bind(handler);
  handler.handleWant = async (data: Buffer) => {
    const hashCount = data.length / 20;
    wantCount += hashCount;
    await origHandleWant(data);
    sentCount += hashCount;
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      handler.handleWant(Buffer.from(data as ArrayBuffer));
    } else {
      const msg = JSON.parse(data.toString());
      if (msg.status === "done") {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(id, repo, `fetch done — ${sentCount} objects sent in ${elapsed}s`);
        ws.close();
      } else {
        log(id, repo, `fetch refs ${msg.ref}`);
        handler.handleControl(msg);
      }
    }
  });

  ws.on("close", () => {
    if (wantCount === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(id, repo, `fetch disconnected — ${elapsed}s`);
    }
  });
}
