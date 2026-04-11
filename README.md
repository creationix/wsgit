# ws-git

An experimental alternative to Git's Smart HTTP protocol. Instead of packfiles,
individual git objects are streamed over WebSocket. The server is a thin proxy
over a content-addressable store — no git library needed server-side.

|                   | Smart HTTP (current)                | WebSocket (ws-git)                            |
|-------------------|-------------------------------------|-----------------------------------------------|
| **Server memory** | O(repo size) — full packfile in RAM | O(1) — one object at a time                   |
| **Server CPU**    | Delta compression/decompression     | Near zero — lz4 pass-through                  |
| **Server code**   | Full git protocol library           | ~500 lines + WebSocket lib                    |
| **Push latency**  | 2 HTTP requests + pack assembly     | Continuous stream, bounded by wavefront depth |
| **Resumability**  | Retry entire packfile               | Resume from where it stopped                  |

## Status

Working prototype. Tested with repos up to 175K objects (1.73 GB). See
[FINDINGS.md](FINDINGS.md) for performance analysis and [PROPOSAL.md](PROPOSAL.md)
for the full protocol specification.

What works:
- `git push`, `git fetch`, `git clone` over `wsgit://` URLs
- Server-driven push with wavefront-based object discovery
- Incremental push/fetch (only new objects transferred)
- Resumed pushes (previously stored objects are skipped)
- Fast-forward verification on push
- Git LFS support (Batch API with basic transfer)
- lz4 compression (Rust native bindings via napi-rs)
- Per-repo isolated storage (objects, LFS, refs)
- Configurable latency injection for benchmarking

Known limitations:
- Wavefront round trips dominate at high latency (~71x slowdown at 30ms RTT)
- No authentication
- No delta encoding

## Quick start

```sh
# Install dependencies and build
npm install
npm run build

# Install git-remote-wsgit and wsgit-server on PATH
npm link
```

### Start the server

```sh
wsgit-server --port 9418
```

Options:
- `--port <n>` — listen port (default: 9418)
- `--store <path>` — storage root (default: `.wsgit-store/`)
- `--latency-ms <n>` — simulated per-direction latency for benchmarking
- `--jitter-ms <n>` — random jitter added to latency

Storage layout:
```
.wsgit-store/
  <owner>/<repo>/
    objects/     — git objects (lz4-compressed, flat layout)
    lfs/         — LFS objects (SHA-256 keyed)
    refs.db      — SQLite ref store
```

### Push a repo

```sh
cd your-repo
git remote add wsgit wsgit://localhost:9418/owner/repo
git push wsgit main
```

### Clone a repo

```sh
git clone wsgit://localhost:9418/owner/repo
```

### Fetch updates

```sh
git fetch wsgit
```

### LFS

LFS works automatically. The remote helper configures `lfs.url` on the remote
so `git-lfs` discovers the server's Batch API endpoint. No manual configuration
needed.

## Development

```sh
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run the server in dev mode (no build step)
npm run dev -w packages/server -- --port 9418

# Run synthetic benchmarks
npm run bench -w packages/bench
```

## Architecture

```
packages/
  protocol/   — Wire format: lz4 frame codec, object parser, types
  server/     — WebSocket server, object store, ref store, LFS API
  client/     — Git remote helper (git-remote-wsgit)
  bench/      — Synthetic repo generator + benchmark harness
```

### Push flow (server-driven)

1. Client sends control message: `{ ref, new: commitHash }`
2. If the server already has the commit, skip to ref update (graph completeness invariant)
3. Otherwise, server sends want frame for the commit hash
4. Client reads the object via `git cat-file --batch`, lz4-compresses, sends it
5. Server stores it (compressed), parses children, checks which are missing
6. Server sends want frames for missing children
7. Client responds with requested objects
8. Repeat until the entire subgraph is stored
9. Server updates the ref via compare-and-swap

### Key invariant

If an object exists in the store, its entire reachable subgraph is also present.
This holds because a push only succeeds (ref update) when every object in the
graph has been stored. Consequences:

- `has(hash) = true` means stop — no need to recurse into children
- No-op pushes complete instantly
- Incremental pushes only transfer genuinely new objects
- No garbage collection needed — no orphan objects can exist

### Wire format

```
Object frame:  [type:1][sha1:20][lz4-compressed body]
Want frame:    [sha1:20]×N (concatenated hashes)
Control:       JSON text frame
```

## Performance

Tested on vercel/proxy (175K objects, 1.73 GB raw):

| Metric | Value |
|--------|-------|
| Push throughput (0ms RTT) | 8,000 obj/s, 34 MB/s wire |
| Compression ratio | 59% (1.73 GB raw → 731 MB wire) |
| Incremental push | 160 objects in 0.23s |
| No-op push | instant |
| Push throughput (30ms RTT) | 112 obj/s (wavefront-limited) |

See [FINDINGS.md](FINDINGS.md) for detailed analysis.

## License

MIT
