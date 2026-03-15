import { useEffect, useMemo, useState } from 'react'

import {
  peekDistanceMatrixCached,
  prefetchDistanceMatrixBatchCached,
  subscribeDistanceMatrixCache,
} from '@/lib/backendApi'

type DistanceMarker = {
  id: number
  latitude: number
  longitude: number
}

type UserLocationInput = {
  latitude: number
  longitude: number
} | null

type DistanceMatrixState = {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  distanceMeters: number | null
  durationSeconds: number | null
}

export function useDistanceMatrixPrefetch(params: {
  enabled: boolean
  userLocation: UserLocationInput
  markers: DistanceMarker[]
  maxPrefetch?: number
  deferMs?: number
}) {
  const {
    enabled,
    userLocation,
    markers,
    maxPrefetch = 12,
    deferMs = 250,
  } = params
  const [cacheVersion, setCacheVersion] = useState(0)

  useEffect(() => {
    return subscribeDistanceMatrixCache(() => {
      setCacheVersion((value) => value + 1)
    })
  }, [])

  const candidates = useMemo(() => {
    if (!enabled || !userLocation) return [] as DistanceMarker[]
    const seen = new Set<number>()
    const next: DistanceMarker[] = []
    for (const marker of markers) {
      if (!marker || typeof marker.id !== 'number') continue
      if (!Number.isFinite(marker.latitude) || !Number.isFinite(marker.longitude)) continue
      if (seen.has(marker.id)) continue
      seen.add(marker.id)
      next.push(marker)
      if (next.length >= maxPrefetch) break
    }
    return next
  }, [enabled, maxPrefetch, markers, userLocation])

  useEffect(() => {
    if (!userLocation || !candidates.length) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      void prefetchDistanceMatrixBatchCached({
        origin_lat: userLocation.latitude,
        origin_lng: userLocation.longitude,
        destinations: candidates.map((marker) => ({
          dest_lat: marker.latitude,
          dest_lng: marker.longitude,
        })),
      })
    }, deferMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [candidates, deferMs, userLocation])

  const distanceStateById = useMemo<Record<number, DistanceMatrixState>>(() => {
    if (!userLocation) return {}
    const next: Record<number, DistanceMatrixState> = {}
    for (const marker of candidates) {
      const cached = peekDistanceMatrixCached({
        origin_lat: userLocation.latitude,
        origin_lng: userLocation.longitude,
        dest_lat: marker.latitude,
        dest_lng: marker.longitude,
      })
      next[marker.id] = {
        status: cached?.status ?? 'idle',
        distanceMeters: typeof cached?.result?.distance_meters === 'number' ? cached.result.distance_meters : null,
        durationSeconds: typeof cached?.result?.duration_seconds === 'number' ? cached.result.duration_seconds : null,
      }
    }
    return next
  }, [cacheVersion, candidates, userLocation])

  return {
    distanceStateById,
  }
}