import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "@ws-git/server";
import { pushObjects, type PushObject } from "@ws-git/client";
import { generateWideRepo, generateDeepRepo } from "./repo-generator.js";

interface BenchResult {
  scenario: string;
  latencyMs: number;
  objectCount: number;
  totalBytes: number;
  pushDurationMs: number;
  pushThroughputMBps: number;
}

const LATENCIES = [0, 10, 50, 100, 200];

async function benchPush(
  scenario: string,
  objects: PushObject[],
  commitHash: string,
  latencyMs: number,
): Promise<BenchResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsgit-bench-"));
  const port = 19418 + Math.floor(Math.random() * 1000);

  const server = createServer({
    port,
    storePath: path.join(tmpDir, "objects"),
    dbPath: path.join(tmpDir, "refs.db"),
    latency: latencyMs > 0 ? { latencyMs: latencyMs / 2 } : undefined, // half per direction = full RTT
  });

  await new Promise<void>((resolve) => server.listen(resolve));

  const totalBytes = objects.reduce((sum, o) => sum + o.body.length, 0);

  const start = performance.now();
  const result = await pushObjects(
    `ws://localhost:${port}/repos/test/repo/push`,
    { id: 1, ref: "refs/heads/main", new: commitHash },
    objects,
    latencyMs > 0 ? { latencyMs: latencyMs / 2 } : undefined,
  );
  const elapsed = performance.now() - start;

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (result.status !== "done") {
    throw new Error(`Push failed: ${result.message}`);
  }

  return {
    scenario,
    latencyMs,
    objectCount: objects.length,
    totalBytes,
    pushDurationMs: Math.round(elapsed),
    pushThroughputMBps: Math.round((totalBytes / (1024 * 1024)) / (elapsed / 1000) * 100) / 100,
  };
}

async function main() {
  console.log("Generating synthetic repos...");

  const scenarios: { name: string; objects: PushObject[]; commitHash: string }[] = [];

  // Wide: 1000 files × 1KB
  const wide = generateWideRepo(1000, 1024);
  scenarios.push({ name: "wide-1k-files", objects: wide.objects, commitHash: wide.commitHash });

  // Wide small: 100 files × 10KB
  const wideSmall = generateWideRepo(100, 10240);
  scenarios.push({ name: "wide-100×10KB", objects: wideSmall.objects, commitHash: wideSmall.commitHash });

  // Deep: 100 commits × 5 files
  const deep = generateDeepRepo(100, 5);
  scenarios.push({ name: "deep-100-commits", objects: deep.objects, commitHash: deep.commitHash });

  // Deep small: 20 commits × 3 files
  const deepSmall = generateDeepRepo(20, 3);
  scenarios.push({ name: "deep-20-commits", objects: deepSmall.objects, commitHash: deepSmall.commitHash });

  console.log("Running benchmarks...\n");

  const results: BenchResult[] = [];

  for (const scenario of scenarios) {
    for (const latency of LATENCIES) {
      process.stdout.write(`  ${scenario.name} @ ${latency}ms RTT... `);
      const result = await benchPush(scenario.name, scenario.objects, scenario.commitHash, latency);
      results.push(result);
      console.log(`${result.pushDurationMs}ms (${result.pushThroughputMBps} MB/s)`);
    }
  }

  // Output as markdown table
  console.log("\n## Results\n");
  console.log("| Scenario | RTT (ms) | Objects | Size | Duration (ms) | Throughput (MB/s) |");
  console.log("|----------|----------|---------|------|---------------|-------------------|");
  for (const r of results) {
    const sizeMB = (r.totalBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `| ${r.scenario} | ${r.latencyMs} | ${r.objectCount} | ${sizeMB} MB | ${r.pushDurationMs} | ${r.pushThroughputMBps} |`,
    );
  }

  // Also write CSV
  const csvPath = path.join(process.cwd(), "bench-results.csv");
  const csv = [
    "scenario,latency_ms,objects,total_bytes,push_duration_ms,push_throughput_mbps",
    ...results.map(
      (r) => `${r.scenario},${r.latencyMs},${r.objectCount},${r.totalBytes},${r.pushDurationMs},${r.pushThroughputMBps}`,
    ),
  ].join("\n");
  fs.writeFileSync(csvPath, csv);
  console.log(`\nCSV written to ${csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
