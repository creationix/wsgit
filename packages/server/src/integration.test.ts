import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import {
  ObjectType,
  encodeObjectFrame,
  decodeObjectFrame,
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

describe("push + fetch integration", () => {
  it("pushes a blob→tree→commit and updates a ref", async () => {
    // Create objects
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

    // Push
    const result = await new Promise<{ status: string; ref: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));

      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/main", new: commitHex }));
        ws.send(encodeObjectFrame(ObjectType.COMMIT, commitHash, commitBody));
        ws.send(encodeObjectFrame(ObjectType.TREE, treeHash, treeBody));
        ws.send(encodeObjectFrame(ObjectType.BLOB, blobHash, blobBody));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      });

      ws.on("error", reject);
    });

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
        // Send object without any control message
        ws.send(encodeObjectFrame(ObjectType.BLOB, blobHash, blobBody));
      });

      ws.on("message", (data) => {
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

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/main", new: commit1Hex }));
        ws.send(encodeObjectFrame(ObjectType.COMMIT, commit1Hash, commit1Body));
        ws.send(encodeObjectFrame(ObjectType.TREE, tree1Hash, tree1));
        ws.send(encodeObjectFrame(ObjectType.BLOB, blob1Hash, blob1));
      });
      ws.on("message", () => { ws.close(); resolve(); });
      ws.on("error", reject);
    });

    // Push unrelated commit (not a descendant of commit1) — should be rejected
    const blob2 = Buffer.from("v2");
    const blob2Hash = hashObject(ObjectType.BLOB, blob2);
    const tree2 = Buffer.concat([Buffer.from("100644 f.txt\0"), blob2Hash]);
    const tree2Hash = hashObject(ObjectType.TREE, tree2);
    const commit2Text = `tree ${bufferToHex(tree2Hash)}\nauthor T <t@t> 1700000001 +0000\ncommitter T <t@t> 1700000001 +0000\n\nunrelated`;
    const commit2Body = Buffer.from(commit2Text);
    const commit2Hash = hashObject(ObjectType.COMMIT, commit2Body);
    const commit2Hex = bufferToHex(commit2Hash);

    const result = await new Promise<{ status: string; message?: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/main", new: commit2Hex }));
        ws.send(encodeObjectFrame(ObjectType.COMMIT, commit2Hash, commit2Body));
        ws.send(encodeObjectFrame(ObjectType.TREE, tree2Hash, tree2));
        ws.send(encodeObjectFrame(ObjectType.BLOB, blob2Hash, blob2));
      });
      ws.on("message", (data) => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on("error", reject);
    });

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

    const result2 = await new Promise<{ status: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/main", new: commit3Hex }));
        ws.send(encodeObjectFrame(ObjectType.COMMIT, commit3Hash, commit3Body));
        ws.send(encodeObjectFrame(ObjectType.TREE, tree3Hash, tree3));
        ws.send(encodeObjectFrame(ObjectType.BLOB, blob3Hash, blob3));
      });
      ws.on("message", (data) => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on("error", reject);
    });

    expect(result2.status).toBe("done");
  });

  it("fetches objects after push", async () => {
    // First push a blob→tree→commit
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

    // Push
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("push"));
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, ref: "refs/heads/main", new: commitHex }));
        ws.send(encodeObjectFrame(ObjectType.COMMIT, commitHash, commitBody));
        ws.send(encodeObjectFrame(ObjectType.TREE, treeHash, treeBody));
        ws.send(encodeObjectFrame(ObjectType.BLOB, blobHash, blobBody));
      });
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.status === "done") { ws.close(); resolve(); }
        else { ws.close(); reject(new Error(msg.message)); }
      });
      ws.on("error", reject);
    });

    // Now fetch — list refs, then request objects
    const fetched = await new Promise<{
      refs: Record<string, string>;
      objects: { type: number; hash: string; body: string }[];
    }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl("fetch"));
      const objects: { type: number; hash: string; body: string }[] = [];
      let refs: Record<string, string> = {};
      let wantsSent = 0;

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
              // Parse tree hash from commit
              const text = Buffer.from(frame.body).toString();
              const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
              if (treeMatch) {
                ws.send(encodeWantFrame([hexToBuffer(treeMatch[1])]));
                wantsSent++;
              }
            } else if (frame.type === ObjectType.TREE) {
              // Parse entry hashes from tree
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
                wantsSent++;
              }
            }

            // After we have all 3 objects (commit + tree + blob), close
            if (objects.length === 3) {
              ws.send(JSON.stringify({ id: 1, status: "done" }));
            }
          }
        } else {
          const msg = JSON.parse(data.toString());
          if (msg.status === "refs") {
            refs = msg.refs;
            // Request the commit
            const commitHash = Object.values(refs)[0] as string;
            ws.send(encodeWantFrame([hexToBuffer(commitHash)]));
            wantsSent++;
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
