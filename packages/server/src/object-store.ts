import fs from "node:fs";
import path from "node:path";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  /** lz4-compressed body */
  compressedBody: Uint8Array;
}

/**
 * Content-addressable filesystem object store.
 * Layout: <root>/<full hex hash>
 * Stored format: [type:1 byte][lz4-compressed body:N bytes]
 *
 * Objects are stored in their wire-compressed form to avoid
 * decompressing on ingest and recompressing on fetch.
 * Flat layout — modern filesystems handle large directories fine,
 * and this maps directly to S3/blob storage keys.
 */
export class ObjectStore {
  private known = new Set<Sha1Hex>();

  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private objectPath(hash: Sha1Hex): string {
    return path.join(this.root, hash);
  }

  async put(hash: Sha1Hex, type: ObjectTypeByte, compressedBody: Uint8Array): Promise<void> {
    if (this.known.has(hash)) return;
    const p = this.objectPath(hash);
    const buf = Buffer.alloc(1 + compressedBody.length);
    buf[0] = type;
    Buffer.from(compressedBody).copy(buf, 1);
    await fs.promises.writeFile(p, buf, { flag: "wx" }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    });
    this.known.add(hash);
  }

  async get(hash: Sha1Hex): Promise<StoredObject | null> {
    try {
      const data = await fs.promises.readFile(this.objectPath(hash));
      this.known.add(hash);
      return { type: data[0] as ObjectTypeByte, compressedBody: data.subarray(1) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async has(hash: Sha1Hex): Promise<boolean> {
    if (this.known.has(hash)) return true;
    try {
      await fs.promises.access(this.objectPath(hash));
      this.known.add(hash);
      return true;
    } catch {
      return false;
    }
  }
}
