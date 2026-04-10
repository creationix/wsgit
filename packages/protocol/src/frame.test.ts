import { describe, it, expect } from "vitest";
import {
  encodeObjectFrame,
  decodeObjectFrame,
  encodeWantFrame,
  decodeWantFrame,
  hexToBuffer,
  bufferToHex,
} from "./frame.js";
import { ObjectType } from "./types.js";

describe("frame codec", () => {
  it("round-trips an object frame", () => {
    const body = Buffer.from("hello world");
    const hash = hexToBuffer("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");

    const encoded = encodeObjectFrame(ObjectType.BLOB, hash, body);
    const decoded = decodeObjectFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(ObjectType.BLOB);
    expect(bufferToHex(decoded!.hash)).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(Buffer.from(decoded!.body).toString()).toBe("hello world");
  });

  it("round-trips want frames", () => {
    const hashes = [
      hexToBuffer("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"),
      hexToBuffer("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"),
    ];

    const encoded = encodeWantFrame(hashes);
    expect(encoded.length).toBe(40);

    const decoded = decodeWantFrame(encoded);
    expect(decoded).toHaveLength(2);
    expect(bufferToHex(decoded[0])).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(bufferToHex(decoded[1])).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("returns null for too-short frames", () => {
    expect(decodeObjectFrame(Buffer.alloc(10))).toBeNull();
  });
});
