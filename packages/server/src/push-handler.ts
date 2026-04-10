import type { WebSocket } from "ws";
import {
  type Sha1Hex,
  type PushRequest,
  type ObjectTypeByte,
  ObjectType,
  decodeObjectFrame,
  bufferToHex,
  hashObject,
  parseChildren,
} from "@ws-git/protocol";
import type { ObjectStore } from "./object-store.js";
import type { RefStore } from "./ref-store.js";

/** Extract only parent hashes from a commit object body. */
function parseCommitParents(body: Uint8Array): Sha1Hex[] {
  const text = Buffer.from(body).toString("utf8");
  const parents: Sha1Hex[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("parent ")) {
      parents.push(line.slice(7, 47));
    } else if (line === "") {
      break;
    }
  }
  return parents;
}

/** Check if newHash is a descendant of ancestorHash by walking parent links. */
async function isAncestor(
  store: ObjectStore,
  newHash: Sha1Hex,
  ancestorHash: Sha1Hex,
): Promise<boolean> {
  const visited = new Set<Sha1Hex>();
  const queue: Sha1Hex[] = [newHash];

  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (hash === ancestorHash) return true;
    if (visited.has(hash)) continue;
    visited.add(hash);

    const obj = await store.get(hash);
    if (!obj || obj.type !== ObjectType.COMMIT) continue;
    for (const parent of parseCommitParents(obj.body)) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return false;
}

interface PushStream {
  request: PushRequest;
  expectSet: Set<Sha1Hex>;
}

export class PushHandler {
  private streams = new Map<number, PushStream>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private ws: WebSocket,
    private repo: string,
    private objects: ObjectStore,
    private refs: RefStore,
  ) { }

  /** Enqueue an operation to run serially. */
  enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn);
  }

  handleControl(msg: PushRequest): void {
    const stream: PushStream = {
      request: msg,
      expectSet: new Set([msg.new]),
    };
    this.streams.set(msg.id, stream);
  }

  async handleObject(data: Buffer): Promise<void> {
    const frame = decodeObjectFrame(data);
    if (!frame) {
      this.sendError(0, "invalid object frame");
      return;
    }

    const { type, hash, body } = frame;
    const hexHash = bufferToHex(hash);

    // Find which stream(s) expect this hash
    const matchingStreams: PushStream[] = [];
    for (const stream of this.streams.values()) {
      if (stream.expectSet.has(hexHash)) {
        matchingStreams.push(stream);
      }
    }

    if (matchingStreams.length === 0) {
      this.sendError(0, `unexpected object: ${hexHash}`);
      return;
    }

    // Verify hash (skip for deltas)
    if (type !== ObjectType.DELTA) {
      const computed = hashObject(type, body);
      if (bufferToHex(computed) !== hexHash) {
        this.sendError(matchingStreams[0].request.id, `hash mismatch`);
        return;
      }
    }

    // Store the object
    await this.objects.put(hexHash, type, body);

    // Parse children and expand expect sets
    const children = parseChildren(type, body);
    for (const stream of matchingStreams) {
      stream.expectSet.delete(hexHash);
      for (const child of children) {
        if (!(await this.objects.has(child))) {
          stream.expectSet.add(child);
        }
      }
      // Check if stream is complete
      if (stream.expectSet.size === 0) {
        await this.finalizeStream(stream);
      }
    }
  }

  private async finalizeStream(stream: PushStream): Promise<void> {
    const { request } = stream;
    const { id, ref, force } = request;
    const newHash = request.new;
    const oldHash = request.old;

    this.streams.delete(id);

    if (force) {
      // Force push — unconditional set
      this.refs.set(this.repo, ref, newHash);
      this.sendDone(id, ref, newHash);
    } else if (oldHash !== undefined) {
      // Force-with-lease — compare-and-swap
      if (this.refs.cas(this.repo, ref, oldHash, newHash)) {
        this.sendDone(id, ref, newHash);
      } else {
        const actual = this.refs.get(this.repo, ref);
        this.sendError(id, "ref conflict", { expected: oldHash, actual });
      }
    } else {
      // Normal push — check fast-forward then CAS
      const currentHash = this.refs.get(this.repo, ref);
      if (currentHash === null) {
        // New ref
        if (this.refs.cas(this.repo, ref, null, newHash)) {
          this.sendDone(id, ref, newHash);
        } else {
          this.sendError(id, "ref conflict");
        }
      } else {
        // Verify fast-forward: new must be a descendant of current
        const ff = await isAncestor(this.objects, newHash, currentHash);
        if (!ff) {
          this.sendError(id, "non-fast-forward", { current: currentHash });
        } else if (this.refs.cas(this.repo, ref, currentHash, newHash)) {
          this.sendDone(id, ref, newHash);
        } else {
          this.sendError(id, "ref conflict", { current: currentHash });
        }
      }
    }
  }

  private sendDone(id: number, ref: string, hash: Sha1Hex): void {
    this.ws.send(JSON.stringify({ id, status: "done", ref, hash }));
  }

  private sendError(id: number, message: string, extra: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ id, status: "error", message, ...extra }));
  }
}
