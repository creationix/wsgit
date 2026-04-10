import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ObjectTypeByte, Sha1Hex } from "@ws-git/protocol";
import { ObjectType } from "@ws-git/protocol";

const exec = promisify(execFile);

const TYPE_MAP: Record<string, ObjectTypeByte> = {
  commit: ObjectType.COMMIT,
  tree: ObjectType.TREE,
  blob: ObjectType.BLOB,
  tag: ObjectType.TAG,
};

const TYPE_NAME: Record<number, string> = {
  [ObjectType.COMMIT]: "commit",
  [ObjectType.TREE]: "tree",
  [ObjectType.BLOB]: "blob",
  [ObjectType.TAG]: "tag",
};

export interface LocalObject {
  type: ObjectTypeByte;
  hash: Sha1Hex;
  body: Buffer;
}

/**
 * Read a git object from the local repo using `git cat-file`.
 */
export async function readObject(hash: Sha1Hex, gitDir?: string): Promise<LocalObject> {
  const opts = gitDir ? { cwd: gitDir } : {};

  // Get type
  const { stdout: typeStr } = await exec("git", ["cat-file", "-t", hash], opts);
  const type = TYPE_MAP[typeStr.trim()];
  if (!type) throw new Error(`Unknown object type: ${typeStr.trim()}`);

  // Get content (binary-safe via maxBuffer)
  const { stdout: body } = await exec(
    "git",
    ["cat-file", type === ObjectType.COMMIT ? "commit" : typeStr.trim(), hash],
    { ...opts, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" as any },
  );

  return { type, hash, body: body as unknown as Buffer };
}

/**
 * List all objects reachable from `refs` that are NOT reachable from `exclude`.
 * Returns hashes in topological order (commits first).
 */
export async function listObjects(
  refs: string[],
  exclude: string[],
  gitDir?: string,
): Promise<Sha1Hex[]> {
  const opts = gitDir ? { cwd: gitDir } : {};
  const args = ["rev-list", "--objects", ...refs];
  for (const ex of exclude) {
    args.push(`^${ex}`);
  }

  const { stdout } = await exec("git", args, { ...opts, maxBuffer: 256 * 1024 * 1024 });
  // Output: "<hash> <path?>\n" per line — we only need the hash
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => line.split(" ")[0]);
}

/**
 * Resolve a ref to a hash.
 */
export async function resolveRef(ref: string, gitDir?: string): Promise<Sha1Hex | null> {
  const opts = gitDir ? { cwd: gitDir } : {};
  try {
    const { stdout } = await exec("git", ["rev-parse", ref], opts);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Write an object to the local repo using `git hash-object`.
 * Uses spawn to pipe body via stdin (execFile+input hangs with promisify).
 */
export async function writeObject(
  type: ObjectTypeByte,
  body: Buffer,
  gitDir?: string,
): Promise<Sha1Hex> {
  const typeName = TYPE_NAME[type];
  if (!typeName) throw new Error(`Unknown type byte: ${type}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["hash-object", "-w", "-t", typeName, "--stdin"], {
      cwd: gitDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d; });
    proc.stderr.on("data", (d: Buffer) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`git hash-object failed (${code}): ${stderr}`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
    proc.stdin.end(body);
  });
}

/**
 * Update a local ref to point to a hash.
 */
export async function updateRef(
  ref: string,
  hash: Sha1Hex,
  gitDir?: string,
): Promise<void> {
  const opts = gitDir ? { cwd: gitDir } : {};
  await exec("git", ["update-ref", ref, hash], opts);
}

/**
 * List local refs matching a pattern.
 */
export async function listLocalRefs(
  pattern: string,
  gitDir?: string,
): Promise<Record<string, Sha1Hex>> {
  const opts = gitDir ? { cwd: gitDir } : {};
  try {
    const { stdout } = await exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", pattern], opts);
    const refs: Record<string, Sha1Hex> = {};
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [ref, hash] = line.split(" ");
      refs[ref] = hash;
    }
    return refs;
  } catch {
    return {};
  }
}
