import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { Sha1Hex, ObjectTypeByte } from "@ws-git/protocol";

export interface StoredObject {
  type: ObjectTypeByte;
  compressedBody: Uint8Array;
}

/**
 * S3-backed object store. Same interface as the filesystem ObjectStore.
 * Layout: <prefix>/<repo>/objects/<hash>
 * Stored format: [type:1 byte][lz4-compressed body]
 */
export class S3ObjectStore {
  private known = new Set<Sha1Hex>();

  constructor(
    private s3: S3Client,
    private bucket: string,
    private prefix: string,
  ) {}

  private key(hash: Sha1Hex): string {
    return `${this.prefix}/objects/${hash}`;
  }

  async put(hash: Sha1Hex, type: ObjectTypeByte, compressedBody: Uint8Array): Promise<void> {
    if (this.known.has(hash)) return;
    const buf = Buffer.alloc(1 + compressedBody.length);
    buf[0] = type;
    Buffer.from(compressedBody).copy(buf, 1);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(hash),
      Body: buf,
    }));
    this.known.add(hash);
  }

  async get(hash: Sha1Hex): Promise<StoredObject | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash),
      }));
      const data = Buffer.from(await res.Body!.transformToByteArray());
      this.known.add(hash);
      return { type: data[0] as ObjectTypeByte, compressedBody: data.subarray(1) };
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async has(hash: Sha1Hex): Promise<boolean> {
    if (this.known.has(hash)) return true;
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash),
      }));
      this.known.add(hash);
      return true;
    } catch {
      return false;
    }
  }
}
