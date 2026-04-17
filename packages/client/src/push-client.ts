import { WebSocket } from "ws";
import {
  type Sha1Hex,
  type ObjectTypeByte,
  type PushRequest,
  type PushResponse,
  encodeObjectFrame,
  hexToBuffer,
  type LatencyConfig,
  wrapWithLatency,
} from "@ws-git/protocol";

export interface PushObject {
  type: ObjectTypeByte;
  hash: Sha1Hex;
  body: Uint8Array;
}

export interface PushResult {
  id: number;
  status: "done" | "error";
  ref: string;
  message?: string;
}

/**
 * Push objects and update a ref over a WebSocket connection.
 */
export async function pushObjects(
  url: string,
  request: PushRequest,
  objects: PushObject[],
  latency?: LatencyConfig,
): Promise<PushResult> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(url);
    if (latency) ws = wrapWithLatency(ws, latency);

    let settled = false;

    ws.on("open", () => {
      // Send control message
      ws.send(JSON.stringify(request));

      // Stream all objects
      for (const obj of objects) {
        const frame = encodeObjectFrame(obj.type, hexToBuffer(obj.hash), obj.body);
        ws.send(frame);
      }
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as PushResponse;
      if (msg.id === request.id) {
        settled = true;
        ws.close();
        resolve({
          id: msg.id,
          status: msg.status,
          ref: request.ref,
          message: msg.status === "error" ? msg.message : undefined,
        });
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket closed before server sent a result"));
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
