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
      let conn: WebSocket = ws;
      if (config.latency) {
        conn = wrapWithLatency(ws, config.latency);
      }

      if (mode === "push") {
        handlePush(conn, repo, objects, refs);
      } else {
        handleFetch(conn, repo, objects, refs);
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

function handlePush(ws: WebSocket, repo: string, objects: ObjectStore, refs: RefStore) {
  const handler = new PushHandler(ws, repo, objects, refs);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      handler.enqueue(() => handler.handleObject(Buffer.from(data as ArrayBuffer)));
    } else {
      const msg = JSON.parse(data.toString());
      handler.handleControl(msg);
    }
  });
}

function handleFetch(ws: WebSocket, repo: string, objects: ObjectStore, refs: RefStore) {
  const handler = new FetchHandler(ws, repo, objects, refs);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      handler.handleWant(Buffer.from(data as ArrayBuffer));
    } else {
      const msg = JSON.parse(data.toString());
      if (msg.status === "done") {
        ws.close();
      } else {
        handler.handleControl(msg);
      }
    }
  });
}
