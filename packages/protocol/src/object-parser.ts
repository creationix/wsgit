import crypto from "node:crypto";
import { ObjectType, type ObjectTypeByte, type Sha1Hex } from "./types.js";
import { bufferToHex } from "./frame.js";

/**
 * Compute the SHA-1 hash of a git object in canonical format.
 * Format: "<type> <size>\0<content>"
 */
export function hashObject(type: ObjectTypeByte, content: Uint8Array): Buffer {
  const typeStr = objectTypeName(type);
  const header = Buffer.from(`${typeStr} ${content.length}\0`);
  const full = Buffer.concat([header, content]);
  return crypto.createHash("sha1").update(full).digest();
}

function objectTypeName(type: ObjectTypeByte): string {
  switch (type) {
    case ObjectType.COMMIT: return "commit";
    case ObjectType.TREE: return "tree";
    case ObjectType.BLOB: return "blob";
    case ObjectType.TAG: return "tag";
    default: throw new Error(`Unknown object type: ${type}`);
  }
}

/**
 * Extract child hashes from a commit object body.
 * Returns: tree hash + parent hashes.
 */
export function parseCommitChildren(body: Uint8Array): Sha1Hex[] {
  const text = Buffer.from(body).toString("utf8");
  const children: Sha1Hex[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("tree ")) {
      children.push(line.slice(5, 45));
    } else if (line.startsWith("parent ")) {
      children.push(line.slice(7, 47));
    } else if (line === "") {
      break; // End of headers
    }
  }

  return children;
}

/**
 * Extract child hashes from a tree object body.
 * Tree format: repeating "<mode> <name>\0<20-byte hash>"
 */
export function parseTreeChildren(body: Uint8Array): Sha1Hex[] {
  const buf = Buffer.from(body);
  const children: Sha1Hex[] = [];
  let i = 0;

  while (i < buf.length) {
    // Skip mode and name until null byte
    const nullIdx = buf.indexOf(0, i);
    if (nullIdx === -1) break;
    // Hash is the 20 bytes after the null
    const hashStart = nullIdx + 1;
    const hashEnd = hashStart + 20;
    if (hashEnd > buf.length) break;
    children.push(bufferToHex(Buffer.from(buf.subarray(hashStart, hashEnd))));
    i = hashEnd;
  }

  return children;
}

/**
 * Extract child hashes from a tag object body.
 * Returns: the tagged object hash.
 */
export function parseTagChildren(body: Uint8Array): Sha1Hex[] {
  const text = Buffer.from(body).toString("utf8");
  for (const line of text.split("\n")) {
    if (line.startsWith("object ")) {
      return [line.slice(7, 47)];
    }
  }
  return [];
}

/** Extract all child hashes from any git object. */
export function parseChildren(type: ObjectTypeByte, body: Uint8Array): Sha1Hex[] {
  switch (type) {
    case ObjectType.COMMIT: return parseCommitChildren(body);
    case ObjectType.TREE: return parseTreeChildren(body);
    case ObjectType.TAG: return parseTagChildren(body);
    case ObjectType.BLOB: return [];
    default: return [];
  }
}
