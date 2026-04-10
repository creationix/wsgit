import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import {
  ObjectType,
  encodeObjectFrame,
  decodeObjectFrame,
  decodeWantFrame,
  encodeWantFrame,
  hashObject,
  bufferToHex,
  hexToBuffer,
} from "@ws-git/protocol";
import { createServer } from "./server.js";

let tmpDir: string;
let server: ReturnType<typeof createServer>;
let port: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsgit-test-"));
  port = 19418 + Math.floor(Math.random() * 10000);
  server = createServer({
    port,
    storePath: path.join(tmpDir, "objects"),
    dbPath: path.join(tmpDir, "refs.db"),
  });
  await new Promise<void>((resolve) => server.listen(resolve));
});

afterEach(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function wsUrl(endpoint: string) {
  return `ws://localhost:${port}/repos/test/repo/${endpoint}`;
}

/** Helper: push objects by responding to server want frames. */
function pushObjects(
  url: string,
  ctrl: Record<string, unknown>,
  objectMap: Map<string, { type: number; hash: Buffer; body: Buffer }>,
): Promise<{ status: string; ref?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    ws.on("open", () => {
      ws.send(JSON.stringify(ctrl));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Server wants objects — send them
        const wanted = decodeWantFrame(Buffer.from(data as ArrayBuffer));
        for (const hashBuf of wanted) {
          const hex = bufferToHex(hashBuf);
          const obj = objectMap.get(hex);
          if (obj) {
            ws.send(encodeObjectFrame(obj.type, obj.hash, obj.body));
          }
        }
      } else {
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      }
    });

    ws.on("error", reject);
  });
}

describe("push + fetch integration", () => {
  it("pushes a blob→tree→commit and updates a ref", async () => {
    const blobBody = Buffer.from("hello wsgit\n");
    const blobHash = hashObject(ObjectType.BLOB, blobBody);

    const treeBody = Buffer.concat([
      Buffer.from("100644 hello.txt\0"),
      blobHash,
    ]);
    const treeHash = hashObject(ObjectType.TREE, treeBody);

    const commitText = [
      `tree ${bufferToHex(treeHash)}`,
      "author Test <t@t> 1700000000 +0000",
      "committer Test <t@t> 1700000000 +0000",
      "",
      "initial commit",
    ].join("\n");
    const commitBody = Buffer.from(commitText);
    const commitHash = hashObject(ObjectType.COMMIT, commitBody);
    const commitHex = bufferToHex(commitHash);

    const objectMap = new Map([
      [commitHex, { type: ObjectType.COMMIT, hash: commitHash, body: commitBody }],
      [bufferToHex(treeHash), { type: ObjectType.TREE, hash: treeHash, body: treeBody }],
      [bufferToHex(blobHash), { type: ObjectType.BLOB, hash: blobHash, body: blobBody }],
    ]);

    const result = await pushObjects(wsUrl("push"),
      { id: 1, ref: "refs/heads/main", new: commitHex },
      objectMap,
    );

    expect(result.status).toBe("done");
    expect(result.ref).toBe("refs/heads/main");

    // Verify objects are stored (format: [type:1][body:N])
    const storedBlob = await fs.promises.readFile(
      path.join(tmpDir, "objects", bufferToHex(blobHash).slice(0, 2), bufferToHex(blobHash).slice(2)),
    );
    expect(storedBlob[0]).toBe(ObjectType.BLOB);
    expect(storedBlob.subarray(1).toString()).toBe("hello wsgit\n");
  });

  it("rejects unexpected objects", async () => {
    const blobBody = Buffer.from("rogue data");
    const blobHash = hashObject(ObjectType.BLOB, blobBody);

    // Push a blob without first declaring a control message whose graph includes it
    const result = await new Promise<{ status: string; message?: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));

      ws.on("open", () => {
        ws.send(encodeObjectFrame(ObjectType.BLOB, blobHash, blobBody));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // ignore want frames
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      });

      ws.on("error", reject);
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("unexpected");
  });

  it("rejects non-fast-forward pushes", async () => {
    // Push first commit
    const blob1 = Buffer.from("v1");
    const blob1Hash = hashObject(ObjectType.BLOB, blob1);
    const tree1 = Buffer.concat([Buffer.from("100644 f.txt\0"), blob1Hash]);
    const tree1Hash = hashObject(ObjectType.TREE, tree1);
    const commit1Text = `tree ${bufferToHex(tree1Hash)}\nauthor T <t@t> 1700000000 +0000\ncommitter T <t@t> 1700000000 +0000\n\nfirst`;
    const commit1Body = Buffer.from(commit1Text);
    const commit1Hash = hashObject(ObjectType.COMMIT, commit1Body);
    const commit1Hex = bufferToHex(commit1Hash);

    const objects1 = new Map([
      [commit1Hex, { type: ObjectType.COMMIT, hash: commit1Hash, body: commit1Body }],
      [bufferToHex(tree1Hash), { type: ObjectType.TREE, hash: tree1Hash, body: tree1 }],
      [bufferToHex(blob1Hash), { type: ObjectType.BLOB, hash: blob1Hash, body: blob1 }],
    ]);
    await pushObjects(wsUrl("push"),
      { id: 1, ref: "refs/heads/main", new: commit1Hex },
      objects1,
    );

    // Push unrelated commit (not a descendant of commit1) — should be rejected
    const blob2 = Buffer.from("v2");
    const blob2Hash = hashObject(ObjectType.BLOB, blob2);
    const tree2 = Buffer.concat([Buffer.from("100644 f.txt\0"), blob2Hash]);
    const tree2Hash = hashObject(ObjectType.TREE, tree2);
    const commit2Text = `tree ${bufferToHex(tree2Hash)}\nauthor T <t@t> 1700000001 +0000\ncommitter T <t@t> 1700000001 +0000\n\nunrelated`;
    const commit2Body = Buffer.from(commit2Text);
    const commit2Hash = hashObject(ObjectType.COMMIT, commit2Body);
    const commit2Hex = bufferToHex(commit2Hash);

    const objects2 = new Map([
      [commit2Hex, { type: ObjectType.COMMIT, hash: commit2Hash, body: commit2Body }],
      [bufferToHex(tree2Hash), { type: ObjectType.TREE, hash: tree2Hash, body: tree2 }],
      [bufferToHex(blob2Hash), { type: ObjectType.BLOB, hash: blob2Hash, body: blob2 }],
    ]);
    const result = await pushObjects(wsUrl("push"),
      { id: 1, ref: "refs/heads/main", new: commit2Hex },
      objects2,
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("non-fast-forward");

    // Push descendant commit (parent = commit1) — should succeed
    const blob3 = Buffer.from("v3");
    const blob3Hash = hashObject(ObjectType.BLOB, blob3);
    const tree3 = Buffer.concat([Buffer.from("100644 f.txt\0"), blob3Hash]);
    const tree3Hash = hashObject(ObjectType.TREE, tree3);
    const commit3Text = `tree ${bufferToHex(tree3Hash)}\nparent ${commit1Hex}\nauthor T <t@t> 1700000002 +0000\ncommitter T <t@t> 1700000002 +0000\n\nchild`;
    const commit3Body = Buffer.from(commit3Text);
    const commit3Hash = hashObject(ObjectType.COMMIT, commit3Body);
    const commit3Hex = bufferToHex(commit3Hash);

    const objects3 = new Map([
      [commit3Hex, { type: ObjectType.COMMIT, hash: commit3Hash, body: commit3Body }],
      [bufferToHex(tree3Hash), { type: ObjectType.TREE, hash: tree3Hash, body: tree3 }],
      [bufferToHex(blob3Hash), { type: ObjectType.BLOB, hash: blob3Hash, body: blob3 }],
    ]);
    const result2 = await pushObjects(wsUrl("push"),
      { id: 1, ref: "refs/heads/main", new: commit3Hex },
      objects3,
    );

    expect(result2.status).toBe("done");
  });

  it("fetches objects after push", async () => {
    // First push
    const blobBody = Buffer.from("fetch me\n");
    const blobHash = hashObject(ObjectType.BLOB, blobBody);

    const treeBody = Buffer.concat([
      Buffer.from("100644 data.txt\0"),
      blobHash,
    ]);
    const treeHash = hashObject(ObjectType.TREE, treeBody);

    const commitText = [
      `tree ${bufferToHex(treeHash)}`,
      "author T <t@t> 1700000000 +0000",
      "committer T <t@t> 1700000000 +0000",
      "",
      "add data",
    ].join("\n");
    const commitBody = Buffer.from(commitText);
    const commitHash = hashObject(ObjectType.COMMIT, commitBody);
    const commitHex = bufferToHex(commitHash);

    const objectMap = new Map([
      [commitHex, { type: ObjectType.COMMIT, hash: commitHash, body: commitBody }],
      [bufferToHex(treeHash), { type: ObjectType.TREE, hash: treeHash, body: treeBody }],
      [bufferToHex(blobHash), { type: ObjectType.BLOB, hash: blobHash, body: blobBody }],
    ]);
    await pushObjects(wsUrl("push"),
      { id: 1, ref: "refs/heads/main", new: commitHex },
      objectMap,
    );

    // Now fetch
    const fetched = await new Promise<{
      refs: Record<string, string>;
      objects: { type: number; hash: string; body: string }[];
    }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("fetch"));
      const objects: { type: number; hash: string; body: string }[] = [];
      let refs: Record<string, string> = {};

      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/" }));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const frame = decodeObjectFrame(Buffer.from(data as ArrayBuffer));
          if (frame) {
            objects.push({
              type: frame.type,
              hash: bufferToHex(frame.hash),
              body: Buffer.from(frame.body).toString("utf8"),
            });

            // Walk the graph: request children we haven't seen yet
            if (frame.type === ObjectType.COMMIT) {
              const text = Buffer.from(frame.body).toString();
              const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
              if (treeMatch) {
                ws.send(encodeWantFrame([hexToBuffer(treeMatch[1])]));
              }
            } else if (frame.type === ObjectType.TREE) {
              const buf = Buffer.from(frame.body);
              let i = 0;
              const childHashes: Buffer[] = [];
              while (i < buf.length) {
                const nullIdx = buf.indexOf(0, i);
                if (nullIdx === -1) break;
                childHashes.push(Buffer.from(buf.subarray(nullIdx + 1, nullIdx + 21)));
                i = nullIdx + 21;
              }
              if (childHashes.length > 0) {
                ws.send(encodeWantFrame(childHashes));
              }
            }

            if (objects.length === 3) {
              ws.send(JSON.stringify({ id: 1, status: "done" }));
            }
          }
        } else {
          const msg = JSON.parse(data.toString());
          if (msg.status === "refs") {
            refs = msg.refs;
            const hash = Object.values(refs)[0] as string;
            ws.send(encodeWantFrame([hexToBuffer(hash)]));
          }
        }
      });

      ws.on("close", () => resolve({ refs, objects }));
      ws.on("error", reject);
    });

    expect(fetched.refs).toEqual({ "refs/heads/main": commitHex });
    expect(fetched.objects).toHaveLength(3);

    const types = fetched.objects.map((o) => o.type).sort();
    expect(types).toEqual([ObjectType.COMMIT, ObjectType.TREE, ObjectType.BLOB].sort());

    const blob = fetched.objects.find((o) => o.type === ObjectType.BLOB);
    expect(blob?.body).toBe("fetch me\n");
  });
});
