import { put, list } from "@vercel/blob";

/**
 * Vercel Blob-backed LFS store.
 * Pathname: <repo>/lfs/<oid>
 */
export class BlobLfsStore {
  constructor(private repo: string) {}

  private pathname(oid: string): string {
    return `${this.repo}/lfs/${oid}`;
  }

  async has(oid: string): Promise<boolean> {
    const { blobs } = await list({ prefix: this.pathname(oid), limit: 1 });
    return blobs.length > 0;
  }

  async size(oid: string): Promise<number | null> {
    const { blobs } = await list({ prefix: this.pathname(oid), limit: 1 });
    if (blobs.length === 0) return null;
    return blobs[0].size;
  }

  async put(oid: string, data: Buffer): Promise<void> {
    await put(this.pathname(oid), data, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
  }

  /** Get a download URL for the LFS object. */
  async getDownloadUrl(oid: string): Promise<string | null> {
    const { blobs } = await list({ prefix: this.pathname(oid), limit: 1 });
    if (blobs.length === 0) return null;
    return blobs[0].downloadUrl;
  }

  /** Get an upload URL — for Blob, we proxy through the function. */
  getUploadUrl(_oid: string): string | null {
    // Blob doesn't support pre-signed upload URLs.
    // Upload goes through the function's PUT handler.
    return null;
  }
}
