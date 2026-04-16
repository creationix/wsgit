# Packed Object Storage Design

Status: **proposal** — design sketch, not yet implemented.

## Motivation

The current `BlobObjectStore` stores one Vercel Blob per git object. For our
reference repo (`vercel/proxy`, 303,661 objects) this means:

| Metric | Per-object blob | Target |
|---|---|---|
| Blob PUT ops per full push | ~300K | O(1) per push |
| Blob LIST ops per has() check | ~300K | 0 (in-memory) |
| Full-push cost (at $5/M ops) | ~$3 | ~$0.000015 |
| Full-push duration (≥100ms/op) | >8 hours | seconds |
| Function timeout (300s Pro) | ❌ exceeded | ✓ fits |

At current per-object rates, a full clone of the proxy repo would take
~2.6 hours — longer than Vercel's 300s Pro function timeout. Cost aside,
**the design does not support repos above ~3,000 objects per session**.

Git objects are immutable and content-addressed. An append-only log with
an in-memory hash index is a natural fit — and is essentially what git
does with packfiles.

## Design goals

1. **O(1) Blob operations per push**, regardless of object count.
2. **Zero Blob operations for `has()`** after cold start.
3. **Range reads** for `get()` — don't download whole chunks to fetch one
   object.
4. **No coordination required** between concurrent pushes.
5. **Content-addressed everything** — no ID collisions, no mutable state
   beyond refs.
6. **Preserve the existing `ObjectStore` interface** so the push/fetch
   handlers are unchanged.

## Layout

```
<repo>/
  chunks/<chunk-hash>.bin       # append-only data, immutable once written
  index/<index-hash>.idx        # append-only index segments, immutable
  refs/<ref-name>               # unchanged from current design
```

Chunks and index segments are named by the SHA-256 hash of their content,
so naming is decentralized and write-once.

### Chunk format

A chunk is a concatenation of entries:

```
entry = [type:1][hash:20][body-len:4][lz4-compressed body:body-len]
```

Chunks are capped at 64 MB (configurable). A push that doesn't fit in
one chunk rotates to a new chunk. Empty-chunk edge cases are disallowed
(at least one entry per chunk).

Chunks have no header or footer — they're just concatenated entries.
The index is the sole authority on what's inside.

### Index segment format

An index segment is a concatenation of fixed-width entries:

```
entry = [obj-hash:20][chunk-hash-prefix:8][offset:4][body-len:4]   # 36 bytes
```

- `obj-hash`: the SHA-1 of the git object
- `chunk-hash-prefix`: first 8 bytes of the chunk's SHA-256 filename
  (collision risk at 2^-32 per repo — acceptable)
- `offset`: byte offset of the entry within the chunk
- `body-len`: length of the compressed body (same as in the chunk entry)

Index segments are not sorted. They're read into an in-memory `Map` once
at cold start.

### Ref layout

Unchanged — one small blob per ref.

## Operations

### `put(hash, type, compressedBody)`

No-op if already in the in-memory index. Otherwise buffer the entry in
the session's pending chunk buffer. Flushed at one of:

- Buffer reaches the chunk size cap (64 MB)
- Push finalizes
- Expect set drains to zero

Flush = write the chunk blob, then append a new index segment blob.

### `get(hash)`

1. Look up `(chunk-hash, offset, length)` in the in-memory index.
2. If not present, return null.
3. Issue a single Blob GET with `Range: bytes=offset-(offset+26+length)`
   — grab the full entry header + body.
4. Return the decoded entry.

### `has(hash)`

In-memory lookup on the index map. Zero Blob ops.

### `list()` (for refs)

Unchanged — uses the ref store, not this.

## Write path during a push

```
client                 server
──────                 ──────
control msg            → add target to expect set, send want
object frame           → validate hash, append to pending chunk buffer,
                         add to in-memory index (tentative), send wants
...                    →
last object arrives    → expect set empty
                       → flush pending chunk to Blob
                       → write index segment to Blob
                       → CAS ref update
                       ← done
```

If the function dies between "flush chunk" and "write index segment", the
chunk exists on Blob but isn't indexed — it's orphaned bytes. A later
compaction pass can detect and reclaim. No correctness impact.

If the function dies between "write index segment" and "ref update", the
objects are indexed but no ref points to them. On next push, the client
may re-send the same objects; `put()` sees them in-memory and becomes a
no-op. No correctness impact.

## Cold-start bootstrapping

On the first request per repo per function instance:

1. `list({ prefix: "<repo>/index/" })` — enumerate all index segments.
2. Download all segments in parallel (or sequentially if memory pressure).
3. Parse each into the in-memory `Map<hash, {chunk, offset, length}>`.
4. Cache in module-level map keyed by repo — survives Fluid Compute reuse.

For the proxy repo after one migration: 303K × 36 B = **10.4 MB** of
index data. One `list()` call returns up to 1000 blobs — if we're below
that, it's two API calls: one list, one batch download.

## Concurrent writers

Two simultaneous pushes to the same repo:

- Each generates its own chunk (content-addressed by chunk hash, so
  unique).
- Each writes its own index segment.
- Neither conflicts. Readers merge both segments.
- Only the ref update races, and that's handled by the existing
  read-compare-write in `BlobRefStore.cas()`.

If both pushes store the same object, both chunks contain a copy —
wasted bytes until compaction.

## Compaction (deferred)

Over time, index segments accumulate (one per push). Cold start cost
grows linearly with push history. A periodic compaction job:

1. Read all index segments into one merged `Map`.
2. Copy referenced objects into new, densely-packed chunks.
3. Write a single fresh index segment.
4. Delete old chunks and index segments.

Can run as a Vercel Cron, triggered manually, or on-demand when the
number of segments crosses a threshold.

Not required for correctness. Only affects cold-start latency and
storage efficiency.

## Range reads on Blob

Critical assumption: Vercel Blob supports HTTP Range requests. This
needs to be verified with a simple test:

```
curl -H "Range: bytes=0-100" <blob-url>
```

Should return status 206 with a partial body. If Blob doesn't support
ranges, we'd have to download full chunks and cache them — still better
than per-object, but less efficient.

The blob SDK's `get()` with a pathname doesn't expose range options. We'd
need to either:
- Use the blob URL + native `fetch()` with `Range` header.
- Use the SDK's `head()` to get the URL then range-fetch.

## Interface compatibility

The `BlobPackObjectStore` implements the same interface as the existing
`ObjectStore` / `BlobObjectStore`:

```ts
class BlobPackObjectStore {
  async put(hash, type, compressedBody): Promise<void>
  async get(hash): Promise<StoredObject | null>
  async has(hash): Promise<boolean>
  async flush(): Promise<void>   // new — called at end of push
}
```

The only change for the push handler is to call `flush()` at the end of
each push session (or we wire it into the handler's finalize step).

## Migration path

Existing deployments have objects already stored as one-blob-per-object.
Options:

1. **Cold switch**: a new store type is selected by env var. Old data
   is inaccessible under the new store.
2. **Dual-read, single-write**: read from both old and new layouts,
   write only to new. Old data remains readable forever.
3. **Migration script**: walk existing blobs and repack into chunks,
   then delete the old blobs.

Option 2 is the pragmatic choice for production. The old per-object blobs
act as an always-there fallback; everything new is packed.

## Open questions

1. **Range-read support on Blob** — confirm before building.
2. **Chunk size** — 64 MB is a guess. Smaller = faster flushes, more
   cold-start files. Larger = fewer files, but unused parts of chunks
   still count toward Blob storage.
3. **Index segment merging threshold** — when does a segment become big
   enough to be its own compacted artifact? Probably when a push has
   >N objects.
4. **Hash collision on 8-byte chunk prefix** — 2^-32 birthday bound.
   Per-repo, fine. Upgrade to 16 bytes if paranoid.
5. **Cold-start download concurrency** — `Promise.all` is simplest,
   but thousands of pending fetches might rate-limit. Cap at ~50 in
   flight.
6. **Flush granularity** — flush only at push end, or also at periodic
   intervals during long pushes? Periodic is safer but costs extra Blob
   writes.

## Non-goals

- **Delta encoding**. Git's pack delta chains save bandwidth but add
  wavefront depth and complexity. We already do better on bandwidth
  than uncompressed loose objects via lz4. Worth revisiting only if
  storage cost becomes dominant.
- **Replacing packfiles wholesale**. Git's on-disk format stays as-is.
  This design is only for the server-side wsgit store.
- **Cross-repo deduplication**. Identical content in two repos is
  stored twice. Simpler model; easier deletion.

## Estimated savings

For a full proxy-repo push (303K objects):

| | Before | After |
|---|---|---|
| Blob ops | ~600K | 3 |
| Blob op cost | ~$3 | ~$0.00002 |
| Push duration | >8 hours | seconds |
| Fits Vercel timeout | ❌ | ✓ |
| Storage | 1.4 GB (many blobs) | 1.4 GB (few blobs) |

Incremental pushes (100 new objects): both approaches roughly break
even on dollars, but the packed design is still ~100x faster because
`has()` is in-memory instead of per-object LIST calls.
