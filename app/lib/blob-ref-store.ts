import { put, get, list } from "@vercel/blob";
import type { Sha1Hex } from "@ws-git/protocol";

/**
 * Module-level ref cache that persists across function invocations
 * on the same Fluid Compute instance. Maps repo -> (ref -> hash).
 * Updated on every get/set, so reads after writes are free.
 */
const refCache = new Map<string, Map<string, Sha1Hex | null>>();

function getRepoCache(repo: string): Map<string, Sha1Hex | null> {
  let m = refCache.get(repo);
  if (!m) { m = new Map(); refCache.set(repo, m); }
  return m;
}

/**
 * Vercel Blob-backed ref store.
 * Pathname: <repo>/refs/<ref-name>
 * Content: plain text hash string
 *
 * CAS is best-effort — Blob doesn't support conditional writes.
 * Read-compare-write with a race window. Fine for single-writer
 * scenarios (one push at a time per repo).
 */
export class BlobRefStore {
  constructor(private repo: string) {}

  private pathname(ref: string): string {
    return `${this.repo}/refs/${ref}`;
  }

  async get(ref: string): Promise<Sha1Hex | null> {
    const cache = getRepoCache(this.repo);
    if (cache.has(ref)) return cache.get(ref)!;

    const result = await get(this.pathname(ref), { access: "private" });
    if (!result || !result.stream) {
      cache.set(ref, null);
      return null;
    }
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const hash = Buffer.concat(chunks).toString().trim() as Sha1Hex;
    cache.set(ref, hash);
    return hash;
  }

  async list(prefix: string): Promise<Record<string, Sha1Hex>> {
    const result: Record<string, Sha1Hex> = {};
    const pathPrefix = this.pathname(prefix);

    let cursor: string | undefined;
    do {
      const res = await list({ prefix: pathPrefix, cursor, limit: 1000 });
      for (const blob of res.blobs) {
        const ref = blob.pathname.slice(`${this.repo}/refs/`.length);
        const hash = await this.get(ref);
        if (hash) result[ref] = hash;
      }
      cursor = res.cursor;
    } while (cursor);

    return result;
  }

  async set(ref: string, hash: Sha1Hex): Promise<void> {
    await put(this.pathname(ref), hash, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/plain",
    });
    getRepoCache(this.repo).set(ref, hash);
  }

  async cas(ref: string, oldHash: Sha1Hex | null, newHash: Sha1Hex): Promise<boolean> {
    const current = await this.get(ref);
    if (current !== oldHash) return false;
    await this.set(ref, newHash);
    return true;
  }

  close(): void {
    // No-op
  }
}
