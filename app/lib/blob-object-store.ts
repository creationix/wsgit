import { put, get, list } from "@vercel/blob";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  compressedBody: Uint8Array;
}

/**
 * Vercel Blob-backed object store.
 * Pathname: <repo>/objects/<hash>
 * Stored format: [type:1 byte][lz4-compressed body]
 */
export class BlobObjectStore {
  private known = new Set<Sha1Hex>();

  constructor(private repo: string) {}

  private pathname(hash: Sha1Hex): string {
    return `${this.repo}/objects/${hash}`;
  }

  async put(hash: Sha1Hex, type: ObjectTypeByte, compressedBody: Uint8Array): Promise<void> {
    if (this.known.has(hash)) return;
    const buf = Buffer.alloc(1 + compressedBody.length);
    buf[0] = type;
    Buffer.from(compressedBody).copy(buf, 1);
    await put(this.pathname(hash), buf, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
    this.known.add(hash);
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
    this.known.add(hash);
    return { type: data[0] as ObjectTypeByte, compressedBody: data.subarray(1) };
  }

  async has(hash: Sha1Hex): Promise<boolean> {
    if (this.known.has(hash)) return true;
    // Use list with exact prefix + limit 1 as lightweight existence check
    const { blobs } = await list({
      prefix: this.pathname(hash),
      limit: 1,
    });
    if (blobs.length > 0) {
      this.known.add(hash);
      return true;
    }
    return false;
  }
}
