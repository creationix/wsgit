import { put, get, list } from "@vercel/blob";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  compressedBody: Uint8Array;
}

/**
 * Module-level "known" cache: objects confirmed stored in Blob.
 * Keyed by repo because different repos may have different storage state.
 */
const knownCache = new Map<string, Set<Sha1Hex>>();

/** Per-repo preload state: a promise that resolves when the
 *  initial full `list()` sweep has populated the known set. */
const preloadPromises = new Map<string, Promise<void>>();

function getKnown(repo: string): Set<Sha1Hex> {
  let s = knownCache.get(repo);
  if (!s) { s = new Set(); knownCache.set(repo, s); }
  return s;
}

async function preload(repo: string): Promise<void> {
  let p = preloadPromises.get(repo);
  if (p) return p;
  p = (async () => {
    const known = getKnown(repo);
    const prefix = `${repo}/objects/`;
    let cursor: string | undefined;
    do {
      const res = await list({ prefix, cursor, limit: 1000 });
      for (const blob of res.blobs) {
        known.add(blob.pathname.slice(prefix.length));
      }
      cursor = res.cursor;
    } while (cursor);
    console.log(`[blob] preloaded ${known.size} known objects for ${repo}`);
  })();
  preloadPromises.set(repo, p);
  return p;
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

  /** Trigger a background preload of the known set. Idempotent per repo. */
  preload(): Promise<void> {
    return preload(this.repo);
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

    // Wait for preload if in progress — usually it's complete and this is a no-op.
    const pending = preloadPromises.get(this.repo);
    if (pending) {
      await pending;
      if (known.has(hash)) return true;
    }

    // Session-local negative cache
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
