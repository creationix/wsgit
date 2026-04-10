import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "@ws-git/server";

const exec = promisify(execFile);

let tmpDir: string;
let server: ReturnType<typeof createServer>;
let port: number;
let helperPath: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsgit-e2e-"));
  port = 29418 + Math.floor(Math.random() * 10000);

  server = createServer({
    port,
    storePath: path.join(tmpDir, "server-store", "objects"),
    dbPath: path.join(tmpDir, "server-store", "refs.db"),
  });
  await new Promise<void>((resolve) => server.listen(resolve));

  // Point to the remote helper script via tsx
  helperPath = path.resolve(import.meta.dirname, "remote-helper.ts");
});

afterEach(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run a git command with wsgit helper on PATH. */
async function git(args: string[], cwd: string, env?: Record<string, string>) {
  // Create a wrapper script that invokes tsx with our helper
  const wrapperDir = path.join(tmpDir, "bin");
  fs.mkdirSync(wrapperDir, { recursive: true });
  const wrapperPath = path.join(wrapperDir, "git-remote-wsgit");
  if (!fs.existsSync(wrapperPath)) {
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexec npx tsx "${helperPath}" "$@"\n`,
    );
    fs.chmodSync(wrapperPath, 0o755);
  }

  const PATH = `${wrapperDir}:${process.env.PATH}`;
  const result = await exec("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PATH, ...env },
  });
  return result;
}

describe("end-to-end", () => {
  it("pushes and fetches a repo", async () => {
    // Create a source repo
    const srcDir = path.join(tmpDir, "source");
    fs.mkdirSync(srcDir);
    await git(["init", "--initial-branch=main"], srcDir);
    await git(["config", "user.email", "test@test"], srcDir);
    await git(["config", "user.name", "Test"], srcDir);

    // Add some files
    fs.writeFileSync(path.join(srcDir, "README.md"), "# Hello wsgit\n");
    fs.writeFileSync(path.join(srcDir, "data.txt"), "some data\n");
    await git(["add", "."], srcDir);
    await git(["commit", "-m", "initial commit"], srcDir);

    // Add the wsgit remote
    await git(
      ["remote", "add", "origin", `wsgit://localhost:${port}/test/repo`],
      srcDir,
    );

    // Push
    const pushResult = await git(["push", "origin", "main"], srcDir);
    process.stderr.write(`push stderr: ${pushResult.stderr}\n`);

    // Now fetch into a new bare repo
    const dstDir = path.join(tmpDir, "dest");
    fs.mkdirSync(dstDir);
    await git(["init", "--bare", "--initial-branch=main"], dstDir);
    await git(
      ["remote", "add", "origin", `wsgit://localhost:${port}/test/repo`],
      dstDir,
    );

    const fetchResult = await git(["fetch", "origin"], dstDir);
    process.stderr.write(`fetch stderr: ${fetchResult.stderr}\n`);

    // Verify the ref was fetched
    const { stdout: refHash } = await exec("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: dstDir }).catch(() => ({ stdout: "" }));

    // Verify the ref exists on the remote
    const { stdout: srcHash } = await exec("git", ["rev-parse", "HEAD"], { cwd: srcDir });

    expect(refHash.trim()).toBe(srcHash.trim());

    // Verify we can read the blob content
    const { stdout: readmeContent } = await exec(
      "git",
      ["show", "refs/remotes/origin/main:README.md"],
      { cwd: dstDir },
    );
    expect(readmeContent).toBe("# Hello wsgit\n");
  }, 30_000);
});
