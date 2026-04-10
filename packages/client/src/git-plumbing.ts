import { execFile, spawn, type ChildProcess } from "node:child_process";
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
 * Persistent `git cat-file --batch` process for fast object reads.
 * Protocol: write "<hash>\n" to stdin, read "<hash> <type> <size>\n<body>\n" from stdout.
 */
class CatFileBatch {
  private proc: ChildProcess;
  private queue: Array<{ resolve: (obj: LocalObject) => void; reject: (err: Error) => void; hash: Sha1Hex }> = [];
  private buffer = Buffer.alloc(0);
  private parsing: { hash: Sha1Hex; type: ObjectTypeByte; size: number } | null = null;

  constructor(gitDir?: string) {
    const opts = gitDir ? { cwd: gitDir } : {};
    this.proc = spawn("git", ["cat-file", "--batch"], { ...opts, stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("error", (err) => {
      for (const req of this.queue) req.reject(err);
      this.queue = [];
    });
  }

  read(hash: Sha1Hex): Promise<LocalObject> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, hash });
      this.proc.stdin!.write(hash + "\n");
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain() {
    while (this.buffer.length > 0) {
      if (!this.parsing) {
        // Look for header line: "<hash> <type> <size>\n"
        const nlIdx = this.buffer.indexOf(10); // \n
        if (nlIdx === -1) return;
        const header = this.buffer.subarray(0, nlIdx).toString();
        this.buffer = this.buffer.subarray(nlIdx + 1);

        const parts = header.split(" ");
        if (parts.length < 3 || parts[1] === "missing") {
          const req = this.queue.shift();
          if (req) req.reject(new Error(`object not found: ${req.hash}`));
          continue;
        }
        const type = TYPE_MAP[parts[1]];
        const size = parseInt(parts[2], 10);
        if (!type) {
          const req = this.queue.shift();
          if (req) req.reject(new Error(`unknown type: ${parts[1]}`));
          // Skip past body + trailing newline
          if (this.buffer.length >= size + 1) {
            this.buffer = this.buffer.subarray(size + 1);
          }
          continue;
        }
        this.parsing = { hash: parts[0], type, size };
      }

      // Need size bytes + 1 trailing newline
      if (this.buffer.length < this.parsing.size + 1) return;

      const body = Buffer.from(this.buffer.subarray(0, this.parsing.size));
      this.buffer = this.buffer.subarray(this.parsing.size + 1);
      const req = this.queue.shift();
      if (req) {
        req.resolve({ type: this.parsing.type, hash: req.hash, body });
      }
      this.parsing = null;
    }
  }

  close() {
    this.proc.stdin!.end();
  }
}

let batchProc: CatFileBatch | null = null;

function getBatch(): CatFileBatch {
  if (!batchProc) batchProc = new CatFileBatch();
  return batchProc;
}

/**
 * Read a git object from the local repo using a persistent `git cat-file --batch` process.
 */
export async function readObject(hash: Sha1Hex, gitDir?: string): Promise<LocalObject> {
  if (gitDir) {
    // One-off for non-default repos
    const batch = new CatFileBatch(gitDir);
    const result = await batch.read(hash);
    batch.close();
    return result;
  }
  return getBatch().read(hash);
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
