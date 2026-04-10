# ws-git Local Prototype Plan

## Goal

Validate the protocol design by benchmarking push/pull of massive datasets over
localhost with configurable artificial latency. Measure round-trip cost of the
wavefront approach vs packfile assembly.

---

## Architecture

```
┌─────────────────────┐         WebSocket          ┌─────────────────────┐
│   git-remote-wsgit  │◄──────────────────────────►│     wsgit-server    │
│   (remote helper)   │    binary + JSON frames     │                     │
│                     │                             │  ┌───────────────┐  │
│  git fast-export ──►│── object frames ──────────►│  │  Object Store │  │
│  git fast-import ◄──│◄── object frames ──────────│  │  (filesystem) │  │
│                     │                             │  └───────────────┘  │
│  latency injection  │                             │  ┌───────────────┐  │
│  (client-side opt.) │                             │  │   Ref Store   │  │
└─────────────────────┘                             │  │   (SQLite)    │  │
                                                    │  └───────────────┘  │
                                                    │                     │
                                                    │  latency injection  │
                                                    │  (server-side)      │
                                                    └─────────────────────┘
```

---

## Components

### 1. Shared: `packages/protocol`

Wire format encoding/decoding — used by both client and server.

- **Frame codec** — encode/decode binary frames: `[type:1][sha:20][body:zstd]`
- **Control messages** — TypeScript types + validation for JSON control frames
- **Object parser** — extract child hashes from commits and trees (~50 lines)
- **zstd wrapper** — compress/decompress using `fzstd` (pure JS, no native deps)
- **SHA-1 hashing** — Node crypto for verification

### 2. Server: `packages/server`

Stateless WebSocket server. No git library.

- **WebSocket handler** — `ws` library, separate `/push` and `/fetch` routes
- **Object store** — content-addressed filesystem
  - Layout: `<root>/objects/<hex[0:2]>/<hex[2:]>` (same as loose git objects)
  - Operations: `put(hash, bytes)`, `get(hash)`, `has(hash)`, `list(prefix?)`
  - Store raw (already zstd-compressed on wire, store decompressed canonical form)
- **Ref store** — SQLite via `better-sqlite3`
  - Table: `refs (repo TEXT, ref TEXT, hash TEXT, PRIMARY KEY (repo, ref))`
  - Compare-and-swap: `UPDATE refs SET hash=? WHERE repo=? AND ref=? AND hash=?`
  - Returns rows affected — 0 means conflict
- **Push handler** — implements the expect-set state machine
  - Maintain expect set per stream `id`
  - Validate hash on arrival, parse children, check store, expand expect set
  - When empty → attempt ref update (ff-check / force / cas depending on control msg)
- **Fetch handler** — ref resolution + object streaming
  - Resolve refs matching prefix filter
  - Respond to want frames by reading from store and sending object frames
- **Latency injector** — configurable middleware
  - Delay before processing each incoming frame (simulates network RTT)
  - Delay before sending each outgoing frame
  - Configurable via CLI flags: `--latency-ms 50` (applied to both directions = 100ms RTT)
  - Optional jitter: `--jitter-ms 10`

### 3. Client: `packages/client` (`git-remote-wsgit`)

A [git remote helper](https://git-scm.com/docs/gitremote-helpers) using the
`import`/`export` capability interface.

- **Remote helper binary** — `#!/usr/bin/env node` script installed on PATH
  - Reads commands from stdin: `capabilities`, `import`, `export`
  - `capabilities` → responds with `import\nexport\n`
- **Export (push) path:**
  - Runs `git fast-export --all` or specific refs
  - Parses the fast-export stream into individual objects (commits, trees, blobs)
  - Hashes each object (git canonical format), sends as binary frames
  - Sends control messages for ref updates, waits for confirmation
- **Import (fetch) path:**
  - Sends control message with ref filter
  - Receives ref listing, determines what's needed locally
  - Sends want frames for missing objects
  - Receives object frames, reconstructs and feeds to `git fast-import`
- **WebSocket client** — `ws` library connecting to server
- **Latency injector** — same configurable delay as server, for client-side testing
  - `GIT_WSGIT_LATENCY_MS=50 git push origin main`

### 4. Benchmark harness: `packages/bench`

Automated benchmarks comparing protocol performance.

- **Repo generator** — create synthetic repos of various shapes:
  - Wide: many files, shallow history (e.g., monorepo initial commit)
  - Deep: few files, long history (e.g., active project)
  - Large blobs: binary assets, ML models
  - Mixed: realistic combination
- **Benchmark runner** — for each scenario:
  - Start wsgit-server with configurable latency
  - Push entire repo, measure wall time + bytes transferred
  - Clone from scratch, measure wall time + bytes transferred
  - Incremental push (1 commit), measure
  - Incremental fetch (1 commit), measure
  - Repeat with latencies: 0ms, 10ms, 50ms, 100ms, 200ms
- **Baseline comparison** — run same scenarios against `git daemon` or local
  HTTP server for Smart HTTP baseline
- **Output** — CSV + markdown table of results

---

## Tech Stack

| Concern              | Choice                    | Why                                             |
|----------------------|---------------------------|-------------------------------------------------|
| Language             | TypeScript                | Single codebase, native Vercel, good WS support |
| Runtime              | Node.js 22+              | Stable WebSocket, crypto, Buffer APIs           |
| Build                | tsup                      | Fast, zero-config TS bundling                   |
| Monorepo             | npm workspaces            | Simple, no extra tooling                        |
| WebSocket            | `ws`                      | Battle-tested, supports binary frames natively  |
| Compression          | `fzstd`                   | Pure JS zstd, no native compilation needed      |
| Object store (local) | Filesystem (loose layout) | Simple, fast on SSD, easy to inspect/debug      |
| Ref store (local)    | `better-sqlite3`          | Synchronous CAS via transactions, zero setup    |
| SHA-1                | Node `crypto`             | Built-in, fast                                  |
| Testing              | Vitest                    | Fast, TS-native, good watch mode                |
| Benchmarking         | Custom + `perf_hooks`     | Need precise control over scenarios             |

---

## Milestone Plan

### M1: Wire protocol + object store (foundation)

- [x] Set up monorepo structure (npm workspaces, tsconfig, tsup)
- [x] Implement frame codec (encode/decode binary frames)
- [x] Implement git object parser (extract children from commit/tree)
- [x] Implement filesystem object store (put/get/has)
- [x] Implement SQLite ref store (get/set/cas)
- [x] Unit tests for all of the above

### M2: Server push + fetch handlers

- [x] WebSocket server skeleton with routing
- [x] Push handler with expect-set state machine
- [x] Fetch handler with ref resolution + object streaming
- [x] Integration test: push objects via raw WebSocket client, verify storage
- [x] Integration test: fetch objects via raw WebSocket client

### M3: Git remote helper (client)

- [x] Remote helper skeleton (stdin/stdout protocol, capabilities)
- [x] Export path: fast-export → object frames → push
- [x] Import path: fetch → object frames → fast-import
- [x] End-to-end test: `git push wsgit://localhost/test/repo main`
- [x] End-to-end test: `git clone wsgit://localhost/test/repo`

### M4: Latency injection + benchmarks

- [x] Latency injection middleware (server + client)
- [x] Synthetic repo generator
- [x] Benchmark runner with CSV output
- [x] Run full benchmark suite, analyze results
- [x] Write up findings — does wavefront depth dominate at realistic latencies?

### M5: Vercel deployment prep

- [ ] Swap filesystem store → S3 (object store interface stays the same)
- [ ] Swap SQLite → DynamoDB or Vercel KV for refs
- [ ] Deploy server on Vercel Fluid with WebSocket support
- [ ] Test with real network latency

---

## Key Design Decisions

### Why not use git's pack protocol directly?

The whole point is to avoid packfile assembly. The remote helper uses
`import`/`export` which gives us loose objects — exactly what we want.

### Why filesystem over SQLite for objects?

For the local prototype, filesystem is simpler to debug (`ls`, `hexdump`),
naturally content-addressed, and has no write amplification from WAL. The
interface is abstract enough to swap in S3 later.

### Why SQLite for refs but not objects?

Refs need compare-and-swap atomicity. SQLite gives us that with zero setup.
Objects are write-once/read-many with no update semantics — filesystem is ideal.

### Why `fzstd` over native zstd bindings?

No compilation step, works everywhere. If benchmarks show compression is a
bottleneck, swap in `@aspect-build/zstd` (native) — the interface is the same.

### Remote helper: import/export vs connect?

`import`/`export` is simpler and well-documented. `connect` would let us stream
closer to the wire but requires reimplementing more of git's internals. Start
with import/export, optimize later if needed.

### Latency injection approach

Wrapping the WebSocket `send()` and `on('message')` with `setTimeout` is the
simplest approach. Both server and client support it independently so you can
simulate asymmetric latency (e.g., fast upload, slow download). This is more
accurate than `tc netem` for this use case since we want to measure protocol
round trips, not TCP behavior.

---

## Benchmark Findings

Benchmarks measured push throughput across four scenarios at 0–200ms simulated
RTT (latency applied half per direction on both client and server).

| Scenario | Objects | Data | 0ms RTT | 50ms RTT | 200ms RTT | Slowdown |
|-----------|---------|------|---------|----------|-----------|----------|
| wide-1k-files (1K×1KB) | 1002 | 1.02 MB | 320ms | 286ms | 577ms | 1.8× |
| wide-100×10KB | 102 | 0.98 MB | 33ms | 131ms | 441ms | 13× |
| deep-100-commits | 700 | 0.11 MB | 128ms | 231ms | 527ms | 4.1× |
| deep-20-commits | 100 | 0.01 MB | 20ms | 126ms | 435ms | 22× |

### Does wavefront depth dominate at realistic latencies?

**Yes, for deep histories. No, for wide repos.**

- **Wide repos** (flat tree, wavefront depth ~3) degrade gracefully. `wide-1k-files`
  only slows 1.8× at 200ms RTT because the entire object graph is only 3 levels
  deep (commit → tree → blobs). All blobs are discovered in one wavefront and
  can be sent in parallel.

- **Deep commit chains** are much more latency-sensitive. `deep-20-commits` (only
  100 objects, 14KB total) takes 435ms at 200ms RTT — a 22× slowdown. Each
  commit in the chain adds ~2 wavefront levels (commit → tree), creating a
  serial dependency that multiplies with RTT.

- **Object count vs object size**: `wide-100×10KB` (102 objects, ~1MB) is 10×
  faster than `wide-1k-files` (1002 objects, ~1MB) at zero latency, showing
  significant per-frame overhead. At high latency they converge because RTT
  dominates.

### Implications for the protocol

1. **Client-side pre-walking is critical.** The current implementation sends
   objects as the server discovers them. For push, the client already knows its
   entire commit graph — it should stream all objects without waiting for
   server-side wavefront expansion. This would make deep histories perform like
   wide repos.

2. **Batching want frames helps fetch.** During fetch, the client should batch
   multiple want requests into a single frame rather than waiting for each
   object's children to be parsed before requesting more.

3. **The protocol's advantage over packfiles holds.** Even with latency
   sensitivity, the protocol starts streaming immediately rather than waiting for
   packfile assembly. For the common case (shallow pushes, few commits), the
   wavefront depth is 3–5 and latency impact is minimal.

4. **Delta encoding priority is low.** Given that latency (not bandwidth) is the
   bottleneck, delta encoding would add wavefront depth for marginal bandwidth
   savings — net negative at realistic latencies.

---

## Open Questions

1. **fast-export object identity** — Does `git fast-export` give us enough info
   to reconstruct canonical git objects (with correct headers) for SHA-1
   verification? Need to verify the format maps cleanly. If not, we may need to
   read from the local `.git/objects` directly instead.

2. **Concurrent want frames** — During fetch, should the client batch want
   frames or send them individually as it discovers needs? Batching reduces
   frame count but adds client-side latency. Worth benchmarking both.

3. **Object existence bloom filter** — The proposal mentions the server building
   an in-memory hash set at connection start. For the local prototype this is
   easy (just `readdir`). For S3 this becomes a bloom filter or prefix listing.
   How large does this get for repos with millions of objects?

4. **Delta encoding priority** — Should M1-M4 include delta support or defer to
   later? Delta encoding helps bandwidth but adds wavefront depth. The
   benchmark should measure both to see the tradeoff.
