import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Sha1Hex } from "@ws-git/protocol";

/**
 * S3-backed ref store. Uses conditional writes for CAS.
 * Layout: <prefix>/refs/<ref-name> (content is the hash string)
 *
 * CAS uses S3 conditional requests:
 * - New ref: PutObject with IfNoneMatch: "*"
 * - Update: PutObject with IfMatch: <etag>
 */
export class S3RefStore {
  private etags = new Map<string, string>();

  constructor(
    private s3: S3Client,
    private bucket: string,
    private prefix: string,
  ) {}

  private key(ref: string): string {
    return `${this.prefix}/refs/${ref}`;
  }

  async get(ref: string): Promise<Sha1Hex | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(ref),
      }));
      const hash = await res.Body!.transformToString();
      if (res.ETag) this.etags.set(ref, res.ETag);
      return hash.trim() as Sha1Hex;
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<Record<string, Sha1Hex>> {
    const result: Record<string, Sha1Hex> = {};
    const keyPrefix = this.key(prefix);

    let continuationToken: string | undefined;
    do {
      const res = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: keyPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const ref = obj.Key.slice(this.prefix.length + "/refs/".length);
        const hash = await this.get(ref);
        if (hash) result[ref] = hash;
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return result;
  }

  /** Unconditional set (for force push). */
  async set(ref: string, hash: Sha1Hex): Promise<void> {
    const res = await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(ref),
      Body: hash,
      ContentType: "text/plain",
    }));
    if (res.ETag) this.etags.set(ref, res.ETag);
  }

  /**
   * Compare-and-swap. Returns true if the update succeeded.
   * If old is null, only succeeds if the ref doesn't exist yet.
   */
  async cas(ref: string, oldHash: Sha1Hex | null, newHash: Sha1Hex): Promise<boolean> {
    try {
      if (oldHash === null) {
        // New ref — fail if already exists
        await this.s3.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(ref),
          Body: newHash,
          ContentType: "text/plain",
          IfNoneMatch: "*",
        }));
      } else {
        // Read current to get ETag if we don't have it cached
        if (!this.etags.has(ref)) {
          await this.get(ref);
        }
        const etag = this.etags.get(ref);
        if (!etag) return false;

        await this.s3.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(ref),
          Body: newHash,
          ContentType: "text/plain",
          IfMatch: etag,
        }));
      }
      // Update cached ETag — next get will refresh it
      this.etags.delete(ref);
      return true;
    } catch (err: any) {
      // Precondition failed = CAS conflict
      if (err.$metadata?.httpStatusCode === 412 || err.name === "PreconditionFailed") {
        return false;
      }
      throw err;
    }
  }

  close(): void {
    // No-op for S3
  }
}
