import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * S3-backed LFS store.
 * Layout: <prefix>/lfs/<oid>
 */
export class S3LfsStore {
  constructor(
    private s3: S3Client,
    private bucket: string,
    private prefix: string,
  ) {}

  private key(oid: string): string {
    return `${this.prefix}/lfs/${oid}`;
  }

  async has(oid: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key(oid),
      }));
      return true;
    } catch {
      return false;
    }
  }

  async size(oid: string): Promise<number | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key(oid),
      }));
      return res.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  /** Get a pre-signed upload URL (client uploads directly to S3). */
  async getUploadUrl(oid: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(oid),
      ContentType: "application/octet-stream",
    }), { expiresIn });
  }

  /** Get a pre-signed download URL. */
  async getDownloadUrl(oid: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(oid),
    }), { expiresIn });
  }
}
