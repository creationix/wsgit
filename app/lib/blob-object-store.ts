import { put, get, list } from "@vercel/blob";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  compressedBody: Uint8Array;
}

/**
 * Module-level "known" cache: objects we've confirmed exist in Blob.
 * Safe to share across invocations because storage is monotonically
 * growing — once an object is stored, it stays stored.
 */
const knownCache = new Map<string, Set<Sha1Hex>>();

function getKnown(repo: string): Set<Sha1Hex> {
  let s = knownCache.get(repo);
  if (!s) { s = new Set(); knownCache.set(repo, s); }
  return s;
}

/**
 * Vercel Blob-backed object store.
 * Pathname: <repo>/objects/<hash>
 * Stored format: [type:1 byte][lz4-compressed body]
 */
export class BlobObjectStore {
  /** Per-session negative cache — we checked Blob, it wasn't there.
   *  Session-local to avoid stale misses if another session stores it. */
  private sessionMissing = new Set<Sha1Hex>();

  constructor(private repo: string) {}

  private pathname(hash: Sha1Hex): string {
    return `${this.repo}/objects/${hash}`;
  }

  async put(hash: Sha1Hex, type: ObjectTypeByte, compressedBody: Uint8Array): Promise<void> {
    const known = getKnown(this.repo);
    if (known.has(hash)) return;
    const buf = Buffer.alloc(1 + compressedBody.length);
    buf[0] = type;
    Buffer.from(compressedBody).copy(buf, 1);
    await put(this.pathname(hash), buf, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
    known.add(hash);
    this.sessionMissing.delete(hash);
  }

  async get(hash: Sha1Hex): Promise<StoredObject | null> {
    const result = await get(this.pathname(hash), { access: "private" });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    getKnown(this.repo).add(hash);
    return { type: data[0] as ObjectTypeByte, compressedBody: data.subarray(1) };
  }

  async has(hash: Sha1Hex): Promise<boolean> {
    const known = getKnown(this.repo);
    if (known.has(hash)) return true;
    // Session-local negative cache: if we already checked this session, trust it.
    if (this.sessionMissing.has(hash)) return false;

    const { blobs } = await list({ prefix: this.pathname(hash), limit: 1 });
    if (blobs.length > 0) {
      known.add(hash);
      return true;
    }
    this.sessionMissing.add(hash);
    return false;
  }
}
