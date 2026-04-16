import type { WebSocket } from "ws";
import {
  type FetchRequest,
  encodeObjectFrameRaw,
  decodeWantFrame,
} from "@ws-git/protocol";
import type { ObjectStore } from "./object-store.js";
import type { RefStore } from "./ref-store.js";

/**
 * Detect object type from stored canonical git object body.
 * Objects are stored without the git header, so we need heuristics
 * or store type metadata alongside. For the prototype, we store
 * the type byte as the first byte of the stored data.
 *
 * Alternative approach: store as "<type-byte><body>" in the object store.
 * This is what we'll do — the object store stores [type:1][body:N].
 */
export class FetchHandler {
  constructor(
    private ws: WebSocket,
    private objects: ObjectStore,
    private refs: RefStore,
  ) { }

  async handleControl(msg: FetchRequest): Promise<void> {
    const refs = await this.refs.list(msg.ref);
    this.ws.send(JSON.stringify({
      id: msg.id,
      status: "refs",
      refs,
    }));
  }

  async handleWant(data: Buffer): Promise<void> {
    const hashes = decodeWantFrame(data);
    for (const hashBuf of hashes) {
      const hex = hashBuf.toString("hex");
      const stored = await this.objects.get(hex);
      if (!stored) continue;

      const frame = encodeObjectFrameRaw(stored.type, hashBuf, stored.compressedBody);
      this.ws.send(frame);
    }
  }
}
