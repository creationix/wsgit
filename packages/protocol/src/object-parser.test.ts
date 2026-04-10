import { describe, it, expect } from "vitest";
import { hashObject, parseCommitChildren, parseTreeChildren, parseChildren } from "./object-parser.js";
import { ObjectType, bufferToHex } from "./index.js";

describe("object parser", () => {
  it("hashes a blob correctly", () => {
    // "hello world" blob has known SHA-1 in git
    const body = Buffer.from("hello world\n");
    const hash = hashObject(ObjectType.BLOB, body);
    // git hash-object -t blob --stdin <<< "hello world"
    expect(bufferToHex(hash)).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("parses commit children", () => {
    const commitBody = Buffer.from(
      [
        "tree 4b825dc642cb6eb9a060e54bf899d69f7cb46b00",
        "parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "parent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "author Test <test@test> 1700000000 +0000",
        "committer Test <test@test> 1700000000 +0000",
        "",
        "test commit",
      ].join("\n"),
    );

    const children = parseCommitChildren(commitBody);
    expect(children).toEqual([
      "4b825dc642cb6eb9a060e54bf899d69f7cb46b00",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("parses tree children", () => {
    // Build a tree with two entries
    const entry1Hash = Buffer.from("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d", "hex");
    const entry2Hash = Buffer.from("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed", "hex");

    const tree = Buffer.concat([
      Buffer.from("100644 file1.txt\0"),
      entry1Hash,
      Buffer.from("100644 file2.txt\0"),
      entry2Hash,
    ]);

    const children = parseTreeChildren(tree);
    expect(children).toEqual([
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
      "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed",
    ]);
  });

  it("returns empty for blobs", () => {
    expect(parseChildren(ObjectType.BLOB, Buffer.from("data"))).toEqual([]);
  });
});
