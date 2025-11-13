// cache.ts
// Lightweight AsyncStorage-based cache with TTL + stale-while-revalidate helper.
// Keys are versioned externally; values stored as JSON envelope: { v: any, exp?: number, swrExp?: number }
// Storing small JSON only. Large arrays ok but avoid huge blobs.

import AsyncStorage from '@react-native-async-storage/async-storage'

type CacheEnvelope<T> = { v: T; exp?: number; swrExp?: number }

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
  if (ttlMs && ttlMs > 0) envelope.exp = now + ttlMs
  if (swrMs && swrMs > 0) envelope.swrExp = (envelope.exp || now) + swrMs
  try { await AsyncStorage.setItem(key, JSON.stringify(envelope)) } catch {}
}

// Remove key
export async function invalidateCache(key: string): Promise<void> {
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
// If hard TTL ok but stale window elapsed (swrExp exceeded): triggers background refresh (non-blocking).
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
        const fresh = await fetcher()
        await setCache(key, fresh, ttlMs, swrMs)
        return fresh
      }
      // Still valid hard ttl
      const val = envelope.v
      // Stale-while-revalidate background pass
      if (envelope.swrExp && now > envelope.swrExp) {
        // Fire & forget refresh
        fetcher().then(fresh => setCache(key, fresh, ttlMs, swrMs)).catch(err => {
          if (onBackgroundRefreshError) onBackgroundRefreshError(err)
        })
      }
      return val
    } catch { /* fall through to fetch */ }
  }
  // No cache
  const fresh = await fetcher()
  await setCache(key, fresh, ttlMs, swrMs)
  return fresh
}

// Utility: hydrate state from cache then refresh in background
// Returns cachedOrNull immediately; also kicks off background fetch updating cache.
export async function hydrateThenRefresh<T = any>(key: string, ttlMs: number, swrMs: number | undefined, fetcher: () => Promise<T>, apply: (val: T) => void): Promise<void> {
  const cached = await getCache<T>(key)
  if (cached != null) apply(cached)
  // Background fresh fetch (always) if no cache or stale
  fetcher().then(fresh => { apply(fresh); setCache(key, fresh, ttlMs, swrMs) }).catch(err => console.warn('[cache] hydrateThenRefresh fetch error', key, err))
}
