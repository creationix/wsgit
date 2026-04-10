import crypto from "node:crypto";
import {
  ObjectType,
  type ObjectTypeByte,
  type Sha1Hex,
  hashObject,
  bufferToHex,
} from "@ws-git/protocol";

export interface SyntheticObject {
  type: ObjectTypeByte;
  hash: Sha1Hex;
  body: Uint8Array;
}

export interface SyntheticRepo {
  objects: SyntheticObject[];
  commitHash: Sha1Hex;
  treeHash: Sha1Hex;
}

/** Create a blob with the given content. */
function makeBlob(content: string | Uint8Array): SyntheticObject {
  const body = typeof content === "string" ? Buffer.from(content) : content;
  const hash = hashObject(ObjectType.BLOB, body);
  return { type: ObjectType.BLOB, hash: bufferToHex(hash), body };
}

/** Create a tree with the given entries: [mode, name, hash]. */
function makeTree(entries: [string, string, Sha1Hex][]): SyntheticObject {
  const parts: Buffer[] = [];
  for (const [mode, name, hash] of entries) {
    parts.push(Buffer.from(`${mode} ${name}\0`));
    parts.push(Buffer.from(hash, "hex"));
  }
  const body = Buffer.concat(parts);
  const hashBuf = hashObject(ObjectType.TREE, body);
  return { type: ObjectType.TREE, hash: bufferToHex(hashBuf), body };
}

/** Create a commit pointing to a tree with optional parents. */
function makeCommit(treeHash: Sha1Hex, parents: Sha1Hex[], message: string): SyntheticObject {
  const lines = [
    `tree ${treeHash}`,
    ...parents.map((p) => `parent ${p}`),
    `author Bench <bench@test> 1700000000 +0000`,
    `committer Bench <bench@test> 1700000000 +0000`,
    ``,
    message,
  ];
  const body = Buffer.from(lines.join("\n"));
  const hash = hashObject(ObjectType.COMMIT, body);
  return { type: ObjectType.COMMIT, hash: bufferToHex(hash), body };
}

/**
 * Generate a wide repo: many files, single commit.
 * Simulates a monorepo initial commit or large dataset.
 */
export function generateWideRepo(fileCount: number, fileSizeBytes: number): SyntheticRepo {
  const objects: SyntheticObject[] = [];
  const treeEntries: [string, string, Sha1Hex][] = [];

  for (let i = 0; i < fileCount; i++) {
    const content = crypto.randomBytes(fileSizeBytes);
    const blob = makeBlob(content);
    objects.push(blob);
    treeEntries.push(["100644", `file-${i.toString().padStart(6, "0")}.bin`, blob.hash]);
  }

  const tree = makeTree(treeEntries);
  objects.push(tree);

  const commit = makeCommit(tree.hash, [], `initial: ${fileCount} files × ${fileSizeBytes}B`);
  objects.push(commit);

  // Reverse so commit is first (depth-first order required by protocol)
  objects.reverse();
  return { objects, commitHash: commit.hash, treeHash: tree.hash };
}

/**
 * Generate a deep repo: few files, many commits forming a linear chain.
 */
export function generateDeepRepo(commitCount: number, filesPerCommit: number): SyntheticRepo {
  const allObjects: SyntheticObject[] = [];
  let parentHash: Sha1Hex | null = null;

  let lastCommitHash = "";
  let lastTreeHash = "";

  for (let c = 0; c < commitCount; c++) {
    const treeEntries: [string, string, Sha1Hex][] = [];
    for (let f = 0; f < filesPerCommit; f++) {
      const blob = makeBlob(`commit ${c} file ${f}: ${crypto.randomBytes(64).toString("hex")}`);
      allObjects.push(blob);
      treeEntries.push(["100644", `file-${f}.txt`, blob.hash]);
    }
    const tree = makeTree(treeEntries);
    allObjects.push(tree);

    const parents = parentHash ? [parentHash] : [];
    const commit = makeCommit(tree.hash, parents, `commit ${c}`);
    allObjects.push(commit);

    parentHash = commit.hash;
    lastCommitHash = commit.hash;
    lastTreeHash = tree.hash;
  }

  // Reverse so latest commit is first (depth-first order required by protocol)
  allObjects.reverse();
  return { objects: allObjects, commitHash: lastCommitHash, treeHash: lastTreeHash };
}

/**
 * Generate a repo with large binary blobs (simulating ML models, assets, etc.)
 */
export function generateLargeBlobRepo(blobCount: number, blobSizeMB: number): SyntheticRepo {
  const objects: SyntheticObject[] = [];
  const treeEntries: [string, string, Sha1Hex][] = [];
  const sizeBytes = blobSizeMB * 1024 * 1024;

  for (let i = 0; i < blobCount; i++) {
    const content = crypto.randomBytes(sizeBytes);
    const blob = makeBlob(content);
    objects.push(blob);
    treeEntries.push(["100644", `model-${i}.bin`, blob.hash]);
  }

  const tree = makeTree(treeEntries);
  objects.push(tree);

  const commit = makeCommit(tree.hash, [], `${blobCount} blobs × ${blobSizeMB}MB`);
  objects.push(commit);

  objects.reverse();
  return { objects, commitHash: commit.hash, treeHash: tree.hash };
}
