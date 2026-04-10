import { compressSync, uncompressSync } from "lz4-napi";
import { type ObjectTypeByte, type Sha1Hex, HASH_BYTES } from "./types.js";

/**
 * Binary frame layout:
 *   [type: 1 byte][sha1: 20 bytes][lz4-compressed body]
 *
 * Want frame layout:
 *   [sha1: 20 bytes]×N (concatenated hashes, no type byte)
 */

/** Encode an object into a binary frame. */
export function encodeObjectFrame(
  type: ObjectTypeByte,
  hash: Buffer,
  body: Uint8Array,
): Buffer {
  const compressed = compressSync(Buffer.from(body));
  const frame = Buffer.alloc(1 + HASH_BYTES + compressed.length);
  frame[0] = type;
  hash.copy(frame, 1);
  compressed.copy(frame, 1 + HASH_BYTES);
  return frame;
}

/** Decode a binary object frame. Returns null if too short. */
export function decodeObjectFrame(data: Buffer): {
  type: ObjectTypeByte;
  hash: Buffer;
  body: Uint8Array;
} | null {
  if (data.length < 1 + HASH_BYTES) return null;
  const type = data[0] as ObjectTypeByte;
  const hash = data.subarray(1, 1 + HASH_BYTES);
  const compressed = data.subarray(1 + HASH_BYTES);
  if (compressed.length === 0) return { type, hash: Buffer.from(hash), body: compressed };
  const body = uncompressSync(compressed);
  return { type, hash: Buffer.from(hash), body };
}

/** Encode one or more SHA-1 hashes into a want frame. */
export function encodeWantFrame(hashes: Buffer[]): Buffer {
  const frame = Buffer.alloc(hashes.length * HASH_BYTES);
  for (let i = 0; i < hashes.length; i++) {
    hashes[i].copy(frame, i * HASH_BYTES);
  }
  return frame;
}

/** Decode a want frame into individual hash buffers. */
export function decodeWantFrame(data: Buffer): Buffer[] {
  const count = Math.floor(data.length / HASH_BYTES);
  const hashes: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    hashes.push(Buffer.from(data.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES)));
  }
  return hashes;
}

/**
 * Distinguish object frames from want frames.
 * Want frames are exact multiples of 20 bytes with no type prefix.
 * Object frames always have a type byte (1-5) before the hash.
 *
 * Heuristic: if first byte is 1-5 and length > HASH_BYTES, it's an object frame.
 * If length is an exact multiple of HASH_BYTES and first byte is NOT 1-5, it's a want frame.
 *
 * For the push endpoint, server receives objects and the client doesn't send wants.
 * For the fetch endpoint, server receives wants and the client doesn't send objects.
 * So disambiguation is context-dependent — callers know which endpoint they're on.
 */

// --- Hex helpers ---

export function hexToBuffer(hex: Sha1Hex): Buffer {
  return Buffer.from(hex, "hex");
}

export function bufferToHex(buf: Buffer): Sha1Hex {
  return buf.toString("hex");
}
