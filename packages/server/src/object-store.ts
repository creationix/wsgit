import fs from "node:fs";
import path from "node:path";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  body: Uint8Array;
}

/**
 * Content-addressable filesystem object store.
 * Layout: <root>/<hex[0:2]>/<hex[2:]>
 * Stored format: [type:1 byte][body:N bytes]
 */
export class ObjectStore {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private objectPath(hash: Sha1Hex): string {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2));
  }

  async put(hash: Sha1Hex, type: ObjectTypeByte, body: Uint8Array): Promise<void> {
    const p = this.objectPath(hash);
    const dir = path.dirname(p);
    await fs.promises.mkdir(dir, { recursive: true });
    const buf = Buffer.alloc(1 + body.length);
    buf[0] = type;
    Buffer.from(body).copy(buf, 1);
    await fs.promises.writeFile(p, buf, { flag: "wx" }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return; // idempotent
      throw err;
    });
  }

  async get(hash: Sha1Hex): Promise<StoredObject | null> {
    try {
      const data = await fs.promises.readFile(this.objectPath(hash));
      return { type: data[0] as ObjectTypeByte, body: data.subarray(1) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async has(hash: Sha1Hex): Promise<boolean> {
    try {
      await fs.promises.access(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }
}
