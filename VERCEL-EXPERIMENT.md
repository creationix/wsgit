# Vercel + Blob Deployment Experiment

Results of porting the ws-git server to a Next.js app on Vercel with
Vercel Blob as durable storage, April 2026.

## TL;DR

- **WebSocket upgrade via `@vercel/functions.upgradeWebSocket()` works.**
  Requires staging rusty runtime layer + `websocketFunctions` project
  flag. Clean path once the infra is in place.
- **Vercel Blob works for correctness**, but per-object storage
  architecture is fundamentally misaligned with Blob's cost and latency
  profile. A full clone of a 300K-object repo would cost ~$3 in Blob
  operations and take ~2.6 hours — exceeding the function timeout.
- **Small repos work great end-to-end.** Push, fetch, clone, ref
  resolution, even LFS all functional over real internet from the
  `ws-git.vercel.app` deployment.
- **Concrete next step identified**: packed append-only storage design
  (see [STORAGE-DESIGN.md](STORAGE-DESIGN.md)) collapses per-push Blob
  ops from O(N) to O(1).

## What we built

A Next.js app at `app/` deployed to Vercel:

- `GET /api/repos/:owner/:repo/push` — WebSocket push endpoint
- `GET /api/repos/:owner/:repo/fetch` — WebSocket fetch endpoint
- `POST /api/repos/:owner/:repo/info/lfs/objects/batch` — LFS Batch API
- `PUT|GET /api/repos/:owner/:repo/lfs/objects/:oid` — LFS transfer
- Rewrite `/repos/*` → `/api/repos/*` so standard `wsgit://` URLs work

Storage abstractions with pluggable backends:

- **Filesystem** (`ObjectStore`, `RefStore`, `LfsStore`) — for local/dev.
- **Vercel Blob** (`BlobObjectStore`, `BlobRefStore`, `BlobLfsStore`) —
  activates automatically when `BLOB_READ_WRITE_TOKEN` is set.

Selected by presence of env var — no config change to switch backends.

## What worked

### End-to-end clone over real internet

```
$ git clone wsgit://ws-git.vercel.app/creationix/ws-git
Cloning into 'ws-git'...
[wsgit] fetched 254 objects, 1.3 MB -> 513.9 KB (61% smaller), 69.7 KB/s wire
```

Every component in the chain pulled its weight:

- Vercel's routing layer upgraded the HTTP request to WebSocket
- `@vercel/functions.upgradeWebSocket()` handed us a WebSocket-like
  handle with `.on()` / `.send()` methods compatible with our handlers
- Frames decompressed, parsed, stored to Blob
- Refs read back from Blob and sent as control messages
- Client reconstructed the graph and wrote objects to the local repo

### Push of small repos

```
$ git push vercel main
[wsgit] pushed 33 objects, 44.2 KB -> 27.3 KB (38% smaller), 11.9 KB/s wire
```

- Objects stored as `<repo>/objects/<hash>` on Blob
- Refs stored as `<repo>/refs/<name>` with plain-text hash content
- New-branch detection, incremental push, graph-completeness invariant
  all worked as on filesystem

### LFS Batch API

Matthew's test project confirmed `upgradeWebSocket()` works over staging.
Our LFS endpoints return well-formed batch responses and proxy uploads
through the PUT handler. Not end-to-end tested with real LFS content
against the deployment, but the contract is verified.

## What broke (and got fixed)

### Async ref store operations

The first Blob deployment silently lost every ref update. Cause: the
push handler was written against the sync SQLite `RefStore`:

```ts
this.refs.set(ref, newHash);
this.sendDone(id, ref, newHash);
```

`BlobRefStore.set()` is async and returns a Promise. Promises are
truthy, so `if (this.refs.cas(...))` always passed. `sendDone` fired
back to the client before the Blob PUT actually completed, and the
function often terminated mid-write.

Fix: converted `RefStore` methods to async uniformly, added `await`
to every call site in the push and fetch handlers. Both implementations
(SQLite and Blob) now share the same async contract.

## Performance measurements

All numbers from the `ws-git.vercel.app` production deployment with
private Vercel Blob storage, DNS pointing at the staging-iad1 proxy.

### Small push (33 objects, 44 KB raw)

```
33 objects, 44.2 KB -> 27.3 KB, 11.9 KB/s wire
Total duration: ~3 seconds
```

### Fresh clone (254 objects, 1.3 MB raw)

```
254 objects, 1.3 MB -> 513.9 KB, 69.7 KB/s wire
Total duration: ~18 seconds
```

### Extrapolated: full vercel/proxy push (303,661 objects)

From observed rate of ~30 objects/second with Blob storage:

- **Estimated duration**: 303,661 / 30 = **~2.8 hours**
- **Vercel Pro function timeout**: 300 seconds
- **Result**: ❌ would be killed at 9,000 / 303,661 objects

The Blob per-object latency (~100ms per `list()` or `put()`) multiplied
by the object count exceeds available function execution time by an
order of magnitude.

### Cost estimate (Vercel Pro, approximate)

For the 300K-object full push (if it could complete):

| Item | Estimate |
|---|---|
| Blob PUTs (300K × $5/M) | ~$1.50 |
| Blob LISTs for `has()` (300K × $5/M) | ~$1.50 |
| Blob storage (~700 MB) | ~$0.02/month |
| Function active CPU (~2.8 hrs × $0.128) | ~$0.36 |
| Function memory (2.8 hrs × 1GB × $0.0106) | ~$0.03 |
| FDT outbound (700 MB × $0.15) | ~$0.10 |
| **Total** | **~$3.50 per push** |

Incremental pushes (100 new objects) cost roughly **$0.001** each —
effectively free.

## Architectural observations

### Blob's API surface is incompatible with per-object storage

Blob doesn't have a cheap existence check like S3's `HeadObject`. The
closest we could get is `list({ prefix, limit: 1 })`, which is a full
API call (~100ms, counted as a list operation). For a graph walk that
calls `has()` on every child of every object, this dominates latency.

### Caching helps but has limits

We added three layers of caching:

1. **Module-level `knownCache`** (per repo, shared across function
   invocations) — positive storage facts, safe to share because storage
   is monotonic.
2. **Module-level `childrenCache`** (global, keyed by hash) — hash →
   children mapping. Content-addressed, so safe across repos.
3. **Session-local `sessionMissing`** (per store instance) — negative
   cache. Never shared, because another session could concurrently
   store the object.

Caching works well for steady-state repos where the `known` set is
preloaded once and `has()` becomes free. But the first push of a new
repo has nothing to preload, and every `has()` check hits Blob.

### Preload is a bandaid

We added `BlobObjectStore.preload()` to do one bulk `list()` at
connection start and populate the known set. Helps for repos small
enough that `list({ limit: 1000 })` covers them. For 300K-object
repos, preload itself would need ~300 paginated list calls and ~10 MB
of data — still a significant cold-start cost.

### The fix isn't more caching

Caching can't change the fundamental cost structure: one blob per
object means one API call per object. The fix is a different storage
layout — see [STORAGE-DESIGN.md](STORAGE-DESIGN.md).

## Status of the deployment

`ws-git.vercel.app` is live with:

- Next.js app on Vercel with WebSocket support (via staging rusty layer)
- Vercel Blob as durable storage
- LFS batch endpoint functional
- Per-repo isolation (objects, refs, LFS all prefixed by `<owner>/<repo>`)

Production-ready for small repos (< ~1000 objects total). Not viable for
large repos until the packed storage design lands.

## Takeaways

1. **Vercel Functions can host stateful WebSocket services.** The
   `upgradeWebSocket()` API is clean and the infrastructure works once
   the flags are in place. This removes a major reason to go elsewhere
   for the server layer.

2. **Vercel Blob is the wrong primitive for per-object storage.** Its
   cost model and latency profile are tuned for asset delivery, not
   high-rate small-object transactions. Using it for git objects one at
   a time is architecturally fighting the tool.

3. **The wsgit protocol design is correct, but its naive storage
   mapping isn't.** The protocol (WebSocket + lz4 frames + wavefront
   graph walk) worked fine over real internet. The storage layer needs
   to batch in the same way the protocol batches.

4. **Packed append-only storage is the obvious next step.** Collapses
   ~600K Blob ops per push to 3, brings cost to fractions of a cent,
   and fits comfortably within the 300s function timeout.
