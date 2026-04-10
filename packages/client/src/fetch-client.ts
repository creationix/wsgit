import { WebSocket } from "ws";
import {
  type Sha1Hex,
  type ObjectTypeByte,
  type FetchRequest,
  type FetchRefs,
  decodeObjectFrame,
  encodeWantFrame,
  hexToBuffer,
  bufferToHex,
  type LatencyConfig,
  wrapWithLatency,
} from "@ws-git/protocol";

export interface FetchedObject {
  type: ObjectTypeByte;
  hash: Sha1Hex;
  body: Uint8Array;
}

export interface FetchResult {
  refs: Record<string, Sha1Hex>;
  objects: FetchedObject[];
}

/**
 * Fetch objects from a wsgit server.
 *
 * @param haveCheck - callback that returns true if the client already has this hash.
 *   Used to avoid requesting objects we already have locally.
 */
export async function fetchObjects(
  url: string,
  refPrefix: string,
  haveCheck: (hash: Sha1Hex) => Promise<boolean>,
  latency?: LatencyConfig,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket = new WebSocket(url);
    if (latency) ws = wrapWithLatency(ws, latency);

    const result: FetchResult = { refs: {}, objects: [] };
    let controlId = 1;

    ws.on("open", () => {
      const req: FetchRequest = { id: controlId, ref: refPrefix };
      ws.send(JSON.stringify(req));
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        // Object frame
        const frame = decodeObjectFrame(Buffer.from(data as ArrayBuffer));
        if (frame) {
          result.objects.push({
            type: frame.type,
            hash: bufferToHex(frame.hash),
            body: frame.body,
          });

          // Parse children and request missing ones
          const { parseChildren } = await import("@ws-git/protocol");
          const children = parseChildren(frame.type, frame.body);
          const missing: Buffer[] = [];
          for (const child of children) {
            const have = await haveCheck(child);
            if (!have && !result.objects.some((o) => o.hash === child)) {
              missing.push(hexToBuffer(child));
            }
          }
          if (missing.length > 0) {
            ws.send(encodeWantFrame(missing));
          }

          // Check if we're done — no more outstanding wants
          // This is a simplification; real impl would track pending wants
        }
      } else {
        // Control message
        const msg = JSON.parse(data.toString());
        if (msg.status === "refs") {
          const refsMsg = msg as FetchRefs;
          result.refs = refsMsg.refs;

          // Request all ref target hashes we don't have
          const missing: Buffer[] = [];
          for (const hash of Object.values(refsMsg.refs)) {
            if (!(await haveCheck(hash))) {
              missing.push(hexToBuffer(hash));
            }
          }
          if (missing.length > 0) {
            ws.send(encodeWantFrame(missing));
          } else {
            // Already up to date
            ws.send(JSON.stringify({ id: controlId, status: "done" }));
          }
        }
      }
    });

    ws.on("close", () => resolve(result));
    ws.on("error", reject);
  });
}
