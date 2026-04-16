import { put, get, list } from "@vercel/blob";
import type { Sha1Hex } from "@ws-git/protocol";

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
    const result = await get(this.pathname(ref), { access: "private" });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString().trim() as Sha1Hex;
  }

  async list(prefix: string): Promise<Record<string, Sha1Hex>> {
    console.log(`[blob-ref] list(${prefix}) start`);
    const result: Record<string, Sha1Hex> = {};
    const pathPrefix = this.pathname(prefix);

    let cursor: string | undefined;
    do {
      const start = Date.now();
      const res = await list({ prefix: pathPrefix, cursor, limit: 1000 });
      console.log(`[blob-ref] list(${prefix}) blob.list returned ${res.blobs.length} in ${Date.now() - start}ms`);
      for (const blob of res.blobs) {
        const ref = blob.pathname.slice(`${this.repo}/refs/`.length);
        const hash = await this.get(ref);
        if (hash) result[ref] = hash;
      }
      cursor = res.cursor;
    } while (cursor);

    console.log(`[blob-ref] list(${prefix}) done with ${Object.keys(result).length} refs`);
    return result;
  }

  async set(ref: string, hash: Sha1Hex): Promise<void> {
    await put(this.pathname(ref), hash, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/plain",
    });
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
