import fs from "node:fs";
import path from "node:path";

/**
 * Content-addressable LFS object store.
 * Layout: <root>/<oid[0:2]>/<oid[2:4]>/<oid>
 * Objects are stored as raw binary, keyed by SHA-256 OID.
 */
export class LfsStore {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private objectPath(oid: string): string {
    return path.join(this.root, oid.slice(0, 2), oid.slice(2, 4), oid);
  }

  async has(oid: string): Promise<boolean> {
    try {
      await fs.promises.access(this.objectPath(oid));
      return true;
    } catch {
      return false;
    }
  }

  async size(oid: string): Promise<number | null> {
    try {
      const stat = await fs.promises.stat(this.objectPath(oid));
      return stat.size;
    } catch {
      return null;
    }
  }

  async put(oid: string, data: Buffer): Promise<void> {
    const p = this.objectPath(oid);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, data, { flag: "wx" }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    });
  }

  createReadStream(oid: string): fs.ReadStream {
    return fs.createReadStream(this.objectPath(oid));
  }

  createWriteStream(oid: string): { stream: fs.WriteStream; path: string } {
    const p = this.objectPath(oid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return { stream: fs.createWriteStream(p), path: p };
  }
}
