import type { WebSocket } from "ws";
import {
  type FetchRequest,
  encodeObjectFrame,
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
    private repo: string,
    private objects: ObjectStore,
    private refs: RefStore,
  ) { }

  handleControl(msg: FetchRequest): void {
    const refs = this.refs.list(this.repo, msg.ref);
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

      const frame = encodeObjectFrame(stored.type, hashBuf, stored.body);
      this.ws.send(frame);
    }
  }
}
