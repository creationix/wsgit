import type { Sha1Hex } from "./types.js";

/**
 * Global content-addressable cache: hash → direct children hashes.
 *
 * Git objects are immutable and content-addressed — a given hash always
 * has the same children regardless of which repo it lives in. Safe to
 * share across repos, sessions, and function invocations.
 *
 * The cache is lossy: entries may be evicted under memory pressure.
 * Callers must handle cache misses by re-parsing the object.
 */
const cache = new Map<Sha1Hex, Sha1Hex[]>();

export function getCachedChildren(hash: Sha1Hex): Sha1Hex[] | undefined {
  return cache.get(hash);
}

export function cacheChildren(hash: Sha1Hex, children: Sha1Hex[]): void {
  cache.set(hash, children);
}

export function childrenCacheSize(): number {
  return cache.size;
}
