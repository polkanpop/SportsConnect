// cache.ts
// Lightweight AsyncStorage-based cache with TTL + stale-while-revalidate helper.
// Keys are versioned externally; values stored as JSON envelope: { v: any, exp?: number, swrExp?: number }
// Semantics:
// - exp: hard expiry timestamp (remove after this)
// - swrExp: soft expiry timestamp (after this, value is considered stale and will be refreshed in background)
// Storing small JSON only. Large arrays ok but avoid huge blobs.

import AsyncStorage from '@react-native-async-storage/async-storage'

type CacheEnvelope<T> = { v: T; exp?: number; swrExp?: number }

const inFlightFetches = new Map<string, Promise<any>>()

async function runSingleFlight<T>(key: string, fetcher: () => Promise<T>, ttlMs: number, swrMs?: number): Promise<T> {
  const existing = inFlightFetches.get(key)
  if (existing) return existing as Promise<T>

  const promise = (async () => {
    const fresh = await fetcher()
    await setCache(key, fresh, ttlMs, swrMs)
    return fresh
  })()

  inFlightFetches.set(key, promise)
  try {
    return await promise
  } finally {
    if (inFlightFetches.get(key) === promise) inFlightFetches.delete(key)
  }
}

// Core get (returns null if missing or expired hard TTL)
export async function getCache<T = any>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return null
    const parsed: CacheEnvelope<T> = JSON.parse(raw)
    if (parsed.exp && Date.now() > parsed.exp) {
      // Hard expiry reached
      await AsyncStorage.removeItem(key)
      return null
    }
    return parsed.v
  } catch { return null }
}

// Set value with TTL (ms) and optional stale-while-revalidate window (swrMs)
export async function setCache<T = any>(key: string, value: T, ttlMs?: number, swrMs?: number): Promise<void> {
  const envelope: CacheEnvelope<T> = { v: value }
  const now = Date.now()
  // If swrMs is provided, treat ttlMs as the "fresh" window and (ttlMs + swrMs) as the hard expiry.
  if (ttlMs && ttlMs > 0) {
    if (swrMs && swrMs > 0) {
      envelope.swrExp = now + ttlMs
      envelope.exp = now + ttlMs + swrMs
    } else {
      envelope.exp = now + ttlMs
    }
  }
  try { await AsyncStorage.setItem(key, JSON.stringify(envelope)) } catch {}
}

// Remove key
export async function invalidateCache(key: string): Promise<void> {
  // Cancel any in-flight runSingleFlight deduplication for this key so the next
  // caller starts a fresh network request rather than piggy-backing on a stale
  // in-flight fetch that was started before the mutation.
  inFlightFetches.delete(key)
  try { await AsyncStorage.removeItem(key) } catch {}
}

// Bulk invalidate by prefix (iterate keys)
export async function invalidateByPrefix(prefix: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys()
    const targets = keys.filter(k => k.startsWith(prefix))
    if (targets.length) await AsyncStorage.multiRemove(targets)
  } catch {}
}

// fetchWithCache: read-through caching with optional stale-while-revalidate
// If hard TTL expired: fetcher() awaited & result cached.
// If within hard TTL: returns cached immediately.
// If within hard TTL but past swrExp: triggers background refresh (non-blocking).
export async function fetchWithCache<T = any>(opts: {
  key: string
  ttlMs: number
  swrMs?: number // additional stale-while-revalidate window after ttl
  fetcher: () => Promise<T>
  onBackgroundRefreshError?: (err: any) => void
}): Promise<T> {
  const { key, ttlMs, swrMs, fetcher, onBackgroundRefreshError } = opts
  const raw = await AsyncStorage.getItem(key)
  if (raw) {
    try {
      const envelope: CacheEnvelope<T> = JSON.parse(raw)
      const now = Date.now()
      // Hard expiry check
      if (envelope.exp && now > envelope.exp) {
        // expired -> fetch fresh synchronously
        return runSingleFlight(key, fetcher, ttlMs, swrMs)
      }
      // Still valid hard ttl
      const val = envelope.v
      // Stale-while-revalidate background pass
      if (envelope.swrExp && now > envelope.swrExp) {
        // Fire & forget refresh
        runSingleFlight(key, fetcher, ttlMs, swrMs)
          .catch(err => {
            if (onBackgroundRefreshError) onBackgroundRefreshError(err)
          })
      }
      return val
    } catch { /* fall through to fetch */ }
  }
  // No cache
  return runSingleFlight(key, fetcher, ttlMs, swrMs)
}

// Utility: hydrate state from cache then refresh in background
// Returns cachedOrNull immediately; also kicks off background fetch updating cache.
export async function hydrateThenRefresh<T = any>(key: string, ttlMs: number, swrMs: number | undefined, fetcher: () => Promise<T>, apply: (val: T) => void): Promise<void> {
  const cached = await getCache<T>(key)
  if (cached != null) apply(cached)
  // Background fresh fetch (always) if no cache or stale
  Promise.resolve()
    .then(fetcher)
    .then(fresh => {
      apply(fresh)
      setCache(key, fresh, ttlMs, swrMs)
    })
    .catch(err => console.warn('[cache] hydrateThenRefresh fetch error', key, err))
}
