# ws-git Prototype Findings

## What we built

A WebSocket-based git object sync protocol where individual git objects are
streamed over WebSocket frames instead of assembled into packfiles. The server
is a thin proxy over a content-addressable filesystem store with SQLite refs —
no git library needed server-side.

## Architecture

```
Client (git-remote-wsgit)          Server (wsgit-server)
─────────────────────────          ─────────────────────
git cat-file --batch ──►           WebSocket handler
  read objects on demand           ├─ object store (filesystem)
                                   ├─ ref store (SQLite + CAS)
lz4 compress ──────────►           ├─ lz4 decompress
WebSocket frames ──────►           ├─ parse children
                                   ├─ expand want set
         ◄────── want frames       └─ send wants for missing objects
```

### Push flow (server-driven)

1. Client sends control message with target ref + commit hash
2. Server checks if it has the commit — if yes, skip to ref update
3. If not, server sends want frame for the commit
4. Client reads the object, compresses, sends it
5. Server stores it, parses children, checks which are missing
6. Server sends want frames for missing children
7. Repeat until the entire subgraph is stored
8. Server updates the ref via compare-and-swap

The server never stores an unexpected object. The **graph completeness
invariant** guarantees that if an object exists in the store, its entire
reachable subgraph is also present — because the push that stored it only
succeeded after the want set fully drained.

## Performance results

### Test repo: vercel/proxy (174,938 objects, 1.73 GB)

| Configuration | Time | obj/s | Wire throughput | Wire size |
|---|---|---|---|---|
| Serial processing | 34.1s | 5,100 | 21.7 MB/s | 730.9 MB |
| + SHA-1 skip | 32.4s | 5,400 | 21.7 MB/s | 730.9 MB |
| + No compression | 31.6s | 5,500 | 56.1 MB/s | 1.73 GB |
| + Concurrent writes | **21.7s** | **8,000** | **33.7 MB/s** | 730.9 MB |

### Compression comparison

lz4-napi (Rust lz4-flex via napi-rs) vs node:zlib gzip:

| Size | gzip compress | lz4 compress | Speedup | Ratio |
|---|---|---|---|---|
| 1 KB | 0.012ms | 0.001ms | 15x | Same |
| 10 KB | 0.022ms | 0.001ms | 19x | Same |
| 100 KB | 0.145ms | 0.005ms | 28x | Same |
| 400 KB | 1.343ms | 0.023ms | 57x | Same |

Compression turned out to not be a bottleneck — the no-compression run was
only marginally faster (31.6s vs 32.4s). lz4 is essentially free.

### Latency sensitivity

| RTT | obj/s | Slowdown vs 0ms |
|---|---|---|
| 0ms | 8,000 | — |
| 30ms | 112 | **71x** |

**The wavefront round-trip problem is severe.** At 30ms RTT, each level of
the commit graph costs a full round trip. With thousands of commits in a
linear chain, throughput collapses. A projected full push at 30ms would take
~25 minutes vs 22 seconds at 0ms.

### Where the time goes (0ms RTT)

Profiling during the 21.7s push:

| Process | CPU | Role |
|---|---|---|
| wsgit-server (node) | 125-140% | Bottleneck — frame decode, parse children, fs writes |
| git-remote-wsgit (node) | 20-50% | lz4 compress + send, mostly idle waiting for wants |
| git cat-file --batch | 7-12% | Reading objects from packfile |

## Key findings

### 1. Compression is free, don't skip it

lz4-napi adds negligible CPU cost but saves 59% bandwidth. The performance
difference between compressed and uncompressed was <1s on a 1.73GB push.
Always compress.

### 2. The serial processing queue was the biggest local bottleneck

Moving from serial `enqueue()` to concurrent `handleObject()` calls gave a
33% speedup (32.4s → 21.7s). JS single-threading prevents real data races
since Set mutations happen synchronously between await points.

### 3. In-memory caching eliminates filesystem overhead

Adding a `known` Set to the object store cut redundant `fs.access()` and
`fs.mkdir()` calls. Most `has()` checks hit the cache after the first
wavefront level.

### 4. Wavefront depth is the fundamental problem

On localhost, the protocol works well — wavefront levels resolve in
microseconds. Over a network, each level costs a full RTT. A repo with
5000 commits has ~5000 wavefront levels through the commit chain, meaning
~150 seconds of pure waiting at 30ms RTT.

### 5. Graph completeness enables instant no-op pushes

If the target commit already exists in the store, the push completes
instantly — no graph walking needed. This is a direct consequence of the
invariant: a completed push guarantees the full subgraph is stored.

## What's needed for production

### Hash negotiation (critical for latency)

The client should send a manifest of its object hashes upfront. The server
responds with a single want frame for everything missing. This collapses
the wavefront from O(graph depth) round trips to O(1). This is the single
most important optimization for real-world use.

### LFS awareness

The current skip mechanism works but is reactive — the server asks for an
LFS-managed object, the client says "skip", and the server removes it from
the want set. A proper implementation would either:
- Have the client declare LFS-managed paths upfront
- Use git's smudge/clean filter detection to identify pointer files

### Delta encoding (low priority)

The benchmarks show bandwidth is not the bottleneck — latency is. Delta
encoding would save bandwidth but add wavefront depth (deltas depend on
base objects). Net negative at realistic latencies until hash negotiation
eliminates the wavefront problem.

### Authentication

Bearer token support during WebSocket upgrade handshake, as described in
the proposal. Not implemented in the prototype.
