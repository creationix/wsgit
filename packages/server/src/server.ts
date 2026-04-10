import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { type LatencyConfig, wrapWithLatency } from "@ws-git/protocol";
import { ObjectStore } from "./object-store.js";
import { RefStore } from "./ref-store.js";
import { PushHandler } from "./push-handler.js";
import { FetchHandler } from "./fetch-handler.js";

export interface ServerConfig {
  port: number;
  storePath: string;
  dbPath: string;
  latency?: LatencyConfig;
}

let connId = 0;

function log(id: number, repo: string, msg: string) {
  console.log(`[${id}] ${repo} ${msg}`);
}

export function createServer(config: ServerConfig) {
  const objects = new ObjectStore(config.storePath);
  const refs = new RefStore(config.dbPath);

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("Not found — connect via WebSocket\n");
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
