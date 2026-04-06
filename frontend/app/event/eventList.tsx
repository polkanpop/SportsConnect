import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { makeDistanceMatrixCacheKey, peekDistanceMatrixCached, prefetchDistanceMatrixBatchCached, subscribeDistanceMatrixCache, listEventsCombinedCached, invalidateEventsCombinedCache, CombinedEvent, CourtInfoRow } from '@/lib/backendApi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import * as Location from 'expo-location'
import { getCachedUserCoord, setCachedUserCoord } from '@/lib/userLocation'
import { SkeletonList } from '@/components/ui/skeleton'
import { useTranslation } from '@/constants/translations'

const SURFACE_TRANSLATION_MAP: Record<string, string> = {
  concrete: 'COURT_SURFACE_CONCRETE',
  hardwood: 'COURT_SURFACE_HARDWOOD',
  synthetic: 'COURT_SURFACE_SYNTHETIC',
  grass: 'COURT_SURFACE_GRASS',
  clay: 'COURT_SURFACE_CLAY',
  indoor: 'MAP_LABEL_INDOOR',
  outdoor: 'MAP_LABEL_OUTDOOR',
}

const translateSurface = (raw: string, tFn: (k: any) => string) => {
  const key = SURFACE_TRANSLATION_MAP[raw.toLowerCase()]
  return key ? tFn(key) : raw.charAt(0).toUpperCase() + raw.slice(1)
}

type Coord = { latitude: number; longitude: number }

function parseMaybeTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  let d = new Date(s)
  if (!Number.isNaN(d.getTime())) return d
  // Postgres: "YYYY-MM-DD HH:mm:ss" (Hermes can treat as invalid)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/)
  if (m) {
    d = new Date(`${m[1]}T${m[2]}:00`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function formatKmFromMeters(distanceMeters: number | null | undefined) {
  if (distanceMeters == null || !Number.isFinite(distanceMeters)) return null
  const km = distanceMeters / 1000
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km)
  const text = String(rounded).replace('.', ',')
  return `${text} km`
}

// Reuse helper from courtList (duplicated locally to avoid circular import)
function asArray(v: CourtInfoRow['venue'] | undefined | null): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

function formatPaymentMethod(method: string) {
  switch (method?.toLowerCase()) {
    case 'cash': return 'Cash'
    case 'vnpay': return 'VNPay'
    default: return method
  }
}

function formatCurrency(n: number | null | undefined) {
  if (n == null) return ''
  const s = String(Math.round(Number(n)))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const LIST_ACCENT = '#f97316' // Events

const EventListScreen = () => {
  const router = useRouter()
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const [allEvents, setAllEvents] = useState<CombinedEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'venue' | 'payment' | 'distance' | 'surface' | null>(null)
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [selectedSurfaces, setSelectedSurfaces] = useState<string[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [freeOnly, setFreeOnly] = useState<boolean>(false)
  const [paymentSelections, setPaymentSelections] = useState<string[]>([]) // 'cash','vnpay'

  // Distance filter state (matches Map numeric rules)
  const [closeToMe, setCloseToMe] = useState(true)
  const [selectedDistanceKm, setSelectedDistanceKm] = useState<number | null>(null)
  const [distanceKmInput, setDistanceKmInput] = useState<string>('')
  const [distanceKmError, setDistanceKmError] = useState<string | null>(null)
  const [userCoord, setUserCoord] = useState<Coord | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const distanceFilterActive = closeToMe || selectedDistanceKm != null
  const requestedDistanceKeysRef = React.useRef<Set<string>>(new Set())
  const autoPrefetchedKeysRef = React.useRef<Set<string>>(new Set())
  const [, setDistanceMatrixTick] = useState(0)

  // React Query fetch with cache key; create/update screens invalidate this key.
  const qc = useQueryClient()
  const { data: eventsData, isLoading: loading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  })
  // Snapshot TQ data before clearing AsyncStorage so we can merge back any
  // optimistically-added events still missing from a warm backend Redis cache.
  const handleRefresh = useCallback(async () => {
    const snapshot = qc.getQueryData<any[]>(queryKeys.eventsCombined)
    await invalidateEventsCombinedCache()
    await refetch()
    if (Array.isArray(snapshot) && snapshot.length > 0) {
      qc.setQueryData(queryKeys.eventsCombined, (current: any) => {
        if (!Array.isArray(current)) return current
        const serverIds = new Set(current.map((r: any) => r?.eventid).filter(Boolean))
        const missing = snapshot.filter((r: any) => r?.eventid && !serverIds.has(r.eventid))
        return missing.length > 0 ? [...missing, ...current] : current
      })
    }
  }, [refetch, qc])
  // Push data into local state for existing code references.
  useEffect(() => { if (Array.isArray(eventsData)) setAllEvents(eventsData) }, [eventsData])
  useEffect(() => { if (!loading && !eventsData) setError('Failed loading events') }, [loading, eventsData])

  useEffect(() => {
    return subscribeDistanceMatrixCache(() => setDistanceMatrixTick(t => (t + 1) % 1_000_000))
  }, [])

  const sanitizeKmInput = useCallback((raw: string) => {
    let s = raw.replace(',', '.')
    s = s.replace(/[^0-9.]/g, '')
    const parts = s.split('.')
    if (parts.length > 2) s = `${parts[0]}.${parts.slice(1).join('')}`
    return s
  }, [])

  const parseKmInput = useCallback((value: string): number | null => {
    if (!value) return null
    if (value === '.') return null
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    if (n <= 0) return null
    return n
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cached = await getCachedUserCoord()
      if (!cancelled && cached && !userCoord) setUserCoord(cached)
    })()
    return () => { cancelled = true }
  }, [])

  const ensureUserLocation = useCallback(async () => {
    if (userCoord) return userCoord
    if (locationLoading) return null
    setLocationLoading(true)
    setLocationError(null)
    try {
      const cached = await getCachedUserCoord()
      if (cached) {
        setUserCoord(cached)
        return cached
      }

      const perm = await Location.getForegroundPermissionsAsync()
      let status = perm.status
      if (status !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync()
        status = req.status
      }
      if (status !== 'granted') {
        setLocationError(t('TS_LIST_ERR_LOCATION_PERM'))
        return null
      }

      const last = await Location.getLastKnownPositionAsync()
      if (last?.coords) {
        const next = { latitude: last.coords.latitude, longitude: last.coords.longitude }
        setUserCoord(next)
        void setCachedUserCoord(next)
        return next
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      })
      const next = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setUserCoord(next)
      void setCachedUserCoord(next)
      return next
    } catch {
      setLocationError(t('TS_LIST_ERR_LOCATION_FAIL'))
      return null
    } finally {
      setLocationLoading(false)
    }
  }, [userCoord, locationLoading])

  useEffect(() => {
    if (!distanceFilterActive) return
    void ensureUserLocation()
  }, [distanceFilterActive, ensureUserLocation])

  useEffect(() => {
    autoPrefetchedKeysRef.current.clear()
  }, [userCoord])

  const venueOptions = useMemo(() => {
    const set = new Set<string>()
    allEvents.forEach(ev => asArray(ev.venue).forEach(v => set.add(v)))
    return [...set].sort((a,b) => a.localeCompare(b))
  }, [allEvents])

  const surfaceOptions = useMemo(() => {
    const set = new Set<string>()
    allEvents.forEach(ev => { if (ev.surface) set.add(ev.surface) })
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [allEvents])

  // Filtering
  const filteredEvents = useMemo(() => {
    return allEvents.filter(ev => {
      const status = String((ev as any)?.status ?? '').toLowerCase()
      if (status.includes('cancel')) {
        const cancelledAt = typeof (ev as any)?._cancelledAt === 'number' ? (ev as any)._cancelledAt : 0
        // Unlist cancelled events; allow a short grace window for freshly-cancelled items.
        if (!cancelledAt) return false
        if (Date.now() - cancelledAt >= 15_000) return false
      }

      // Never list completed events.
      if (status.includes('complete')) return false

      // Hide past events (prefer end time when available).
      const startRaw = String((ev as any)?.start_timestamp ?? (ev as any)?.time ?? '').trim()
      const endRaw = String((ev as any)?.end_timestamp ?? '').trim()
      const start = parseMaybeTimestamp(startRaw)
      const end = parseMaybeTimestamp(endRaw)
      const nowTs = Date.now()
      if (end && !Number.isNaN(end.getTime())) {
        if (end.getTime() < nowTs) return false
      } else if (start && !Number.isNaN(start.getTime())) {
        if (start.getTime() < nowTs) return false
      }

      // text search
      const title = (ev.title || '').toLowerCase()
      const address = (ev.address || '').toLowerCase()
      const queryOk = !search || title.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if (!queryOk) return false
      // venue filters
      const venues = asArray(ev.venue)
      const venueOk = selectedVenues.length === 0 || selectedVenues.some(sel => venues.includes(sel))
      if (!venueOk) return false
      const surfaceOk = selectedSurfaces.length === 0 || (ev.surface != null && selectedSurfaces.includes(ev.surface))
      if (!surfaceOk) return false
      // Free filter
      if (freeOnly) {
        if (ev.entry_fee != null) return false
      } else {
        // Payment method filter (only when not free)
        if (paymentSelections.length) {
          const method = (ev.support_payment_method || '').toLowerCase()
          if (paymentSelections.length === 1) {
            const allowed = new Set<string>(paymentSelections)
            if (paymentSelections.some(m => m === 'cash' || m === 'vnpay')) allowed.add('both')
            if (!allowed.has(method)) return false
          } else {
            if (method !== 'both') return false
          }
        }
      }
      return true
    })
  }, [allEvents, search, selectedVenues, selectedSurfaces, freeOnly, paymentSelections])

  const displayEvents = useMemo(() => {
    let list = filteredEvents
    if (!distanceFilterActive || !userCoord) return list

    if (selectedDistanceKm != null) {
      const maxMeters = selectedDistanceKm * 1000
      list = list.filter(ev => {
        if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') return false
        const d = haversineMeters(userCoord.latitude, userCoord.longitude, ev.latitude, ev.longitude)
        return d <= maxMeters
      })
    }

    if (closeToMe) {
      list = [...list].sort((a, b) => {
        const aHas = typeof a.latitude === 'number' && typeof a.longitude === 'number'
        const bHas = typeof b.latitude === 'number' && typeof b.longitude === 'number'
        if (!aHas && !bHas) return 0
        if (!aHas) return 1
        if (!bHas) return -1
        const da = haversineMeters(userCoord.latitude, userCoord.longitude, a.latitude as number, a.longitude as number)
        const db = haversineMeters(userCoord.latitude, userCoord.longitude, b.latitude as number, b.longitude as number)
        return da - db
      })
    }

    return list
  }, [filteredEvents, distanceFilterActive, userCoord, selectedDistanceKm, closeToMe])

  const toggleFree = () => {
    setFreeOnly(f => {
      const next = !f
      if (next) setPaymentSelections([]) // disable payment filter when free is active
      return next
    })
  }
  const togglePaymentFilterPanel = () => {
    if (freeOnly) return
    setOpenFilter(f => f === 'payment' ? null : 'payment')
  }
  const togglePaymentSelection = (opt: string) => {
    setPaymentSelections(prev => {
      let next = prev.includes(opt) ? prev.filter(x => x !== opt) : [...prev, opt]
      return next
    })
  }

  // Pagination state for incremental rendering
  const BATCH_SIZE = 15
  const [visibleCount, setVisibleCount] = useState<number>(BATCH_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
    setLoadingMore(false)
  }, [search, selectedVenues, selectedSurfaces, freeOnly, paymentSelections, closeToMe, selectedDistanceKm])

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return
    const nextCount = Math.min(visibleCount + BATCH_SIZE, displayEvents.length)
    if (nextCount <= visibleCount) return

    setLoadingMore(true)
    try {
      const origin = await ensureUserLocation()
      if (!origin) {
        setVisibleCount(nextCount)
        return
      }

      const nextBatch = displayEvents.slice(visibleCount, nextCount)
      const dests: { dest_lat: number; dest_lng: number }[] = []
      for (const ev of nextBatch) {
        if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') continue
        const p = { origin_lat: origin.latitude, origin_lng: origin.longitude, dest_lat: ev.latitude, dest_lng: ev.longitude }
        const key = makeDistanceMatrixCacheKey(p)
        if (requestedDistanceKeysRef.current.has(key)) continue
        requestedDistanceKeysRef.current.add(key)
        dests.push({ dest_lat: ev.latitude, dest_lng: ev.longitude })
      }

      await prefetchDistanceMatrixBatchCached({ origin_lat: origin.latitude, origin_lng: origin.longitude, destinations: dests })
      setVisibleCount(nextCount)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, visibleCount, displayEvents, ensureUserLocation])

  const visibleEvents = useMemo(() => displayEvents.slice(0, visibleCount), [displayEvents, visibleCount])

  useEffect(() => {
    if (!distanceFilterActive) return
    if (!userCoord) return

    const AUTO_PREFETCH_LIMIT = 15
    const allowBeyondLimit = openFilter === 'distance' || selectedDistanceKm != null

    const dests: { dest_lat: number; dest_lng: number }[] = []
    for (const ev of visibleEvents) {
      if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') continue
      const p = { origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, dest_lat: ev.latitude, dest_lng: ev.longitude }
      const key = makeDistanceMatrixCacheKey(p)
      if (requestedDistanceKeysRef.current.has(key)) continue

      if (!allowBeyondLimit && autoPrefetchedKeysRef.current.size >= AUTO_PREFETCH_LIMIT) continue

      const peeked = peekDistanceMatrixCached(p)
      if (peeked?.status === 'loaded' || peeked?.status === 'error') {
        requestedDistanceKeysRef.current.add(key)
        continue
      }
      requestedDistanceKeysRef.current.add(key)
      if (!allowBeyondLimit) autoPrefetchedKeysRef.current.add(key)
      dests.push({ dest_lat: ev.latitude, dest_lng: ev.longitude })
    }
    if (dests.length) {
      void prefetchDistanceMatrixBatchCached({ origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, destinations: dests })
    }
  }, [distanceFilterActive, userCoord, visibleEvents, openFilter, selectedDistanceKm])

  const toggleVenue = (v: string) => setSelectedVenues(p => p.includes(v) ? p.filter(x => x!==v) : [...p, v])
  const toggleSurface = (v: string) => setSelectedSurfaces(p => p.includes(v) ? p.filter(x => x!==v) : [...p, v])
  const toggleExpand = (id: number) => setExpandedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const handleOutsidePress = () => { if (openFilter) setOpenFilter(null) }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Back */}
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('EVENT_LIST_HEADER_TITLE')}</Text>
        <View style={styles.headerSpacer} />
      </View>
      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchContainer}>
          <Image source={ICONS.search} style={styles.searchIcon} />
          <TextInput
            placeholder={t('EVENT_LIST_SEARCH_PLACEHOLDER')}
            placeholderTextColor={COLORS.neutral750}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
          />
        </View>
      </View>
      <View style={styles.container}>
        {/* Filters */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersInner}>
          <TouchableOpacity style={[styles.filterButton, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterButtonActive]} onPress={() => setOpenFilter(openFilter==='venue'?null:'venue')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterTextActive]}>{t('COURT_LIST_FILTER_SPACE')}</Text>
            {selectedVenues.length>0 && <Text style={styles.countBadge}>{selectedVenues.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'surface' || selectedSurfaces.length>0) && styles.filterButtonActive]}
            onPress={() => setOpenFilter(openFilter==='surface'?null:'surface')}
          >
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'surface' || selectedSurfaces.length>0) && styles.filterTextActive]}>{t('COURT_LIST_FILTER_SURFACE')}</Text>
            {selectedSurfaces.length>0 && <Text style={styles.countBadge}>{selectedSurfaces.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterButton, freeOnly && styles.filterButtonActive]} onPress={toggleFree}>
            <Image source={ICONS.freeIcon} style={styles.filterIcon} />
            <Text style={[styles.filterText, freeOnly && styles.filterTextActive]}>{t('COMMON_LABEL_FREE')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterButtonActive, freeOnly && styles.filterButtonDisabled]}
            onPress={togglePaymentFilterPanel}
            disabled={freeOnly}
          >
            <Image source={ICONS.paymentMethod} style={[styles.filterIcon, freeOnly && { tintColor: COLORS.neutral600 }]} />
            <Text style={[styles.filterText, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterTextActive, freeOnly && { color: COLORS.neutral650 }]}>{t('MAP_FILTER_PAYMENT')}</Text>
            {paymentSelections.length>0 && !freeOnly && <Text style={styles.countBadge}>{paymentSelections.length}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'distance' || distanceFilterActive) && styles.filterButtonActive]}
            onPress={() => setOpenFilter(openFilter === 'distance' ? null : 'distance')}
          >
            <Image source={ICONS.radar} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'distance' || distanceFilterActive) && styles.filterTextActive]}>
              {selectedDistanceKm != null ? `${t('MAP_FILTER_DISTANCE')}: ${selectedDistanceKm}km` : (closeToMe ? t('MAP_FILTER_NEARBY') : t('MAP_FILTER_DISTANCE'))}
            </Text>
          </TouchableOpacity>
          </ScrollView>
        </View>
        {/* Subheader removed (title is in header row) */}
        {openFilter === 'venue' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {venueOptions.map(opt => {
                const selected = selectedVenues.includes(opt)
                const label = opt.toLowerCase() === 'indoor' ? t('MAP_LABEL_INDOOR') : opt.toLowerCase() === 'outdoor' ? t('MAP_LABEL_OUTDOOR') : opt
                return (
                  <Pressable key={opt} onPress={() => toggleVenue(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{label}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}
        {openFilter === 'surface' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {surfaceOptions.map(opt => {
                const selected = selectedSurfaces.includes(opt)
                const label = translateSurface(opt, t)
                return (
                  <Pressable key={opt} onPress={() => toggleSurface(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{label}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}
        {openFilter === 'payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {['cash','vnpay'].map(opt => {
                const selected = paymentSelections.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => togglePaymentSelection(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt === 'cash' ? t('BOOKING_COURT_PAYMENT_CASH') : t('BOOKING_COURT_PAYMENT_VNPAY')}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
              {paymentSelections.length===0 && <Text style={{ padding:10, fontSize:12, color: COLORS.neutral850 }}>{t('EVENT_LIST_PAYMENT_HINT')}</Text>}
              
            </ScrollView>
          </View>
        )}

        {openFilter === 'distance' && (
          <View style={styles.dropdownWrapper}>
            <View style={[styles.dropdown, { paddingHorizontal: 12, paddingVertical: 10 }]}> 
              <View style={styles.distanceHeaderRow}>
                <TouchableOpacity
                  style={[styles.closeToMeBtn, closeToMe && styles.closeToMeBtnActive]}
                  onPress={() => setCloseToMe(v => !v)}
                >
                  <Text style={[styles.closeToMeText, closeToMe && styles.closeToMeTextActive]}>{t('MAP_FILTER_NEARBY')}</Text>
                </TouchableOpacity>
                {locationLoading && (
                  <View style={styles.locationSpinnerWrap}>
                    <ActivityIndicator size="small" color={COLORS.neutral800} />
                  </View>
                )}
              </View>
              <Text style={styles.distanceFilterTitle}>{t('MAP_FILTER_DISTANCE_INPUT_TITLE')}</Text>
              <TextInput
                value={distanceKmInput}
                onChangeText={(rawInput) => {
                  const cleaned = sanitizeKmInput(rawInput)
                  setDistanceKmInput(cleaned)
                  if (cleaned.trim().length === 0) {
                    setDistanceKmError(null)
                    setSelectedDistanceKm(null)
                    return
                  }
                  const parsed = parseKmInput(cleaned)
                  if (parsed == null) {
                    setDistanceKmError(t('TS_CREATE_ERR_TYPE_NUMBER'))
                    return
                  }
                  setDistanceKmError(null)
                  setSelectedDistanceKm(parsed)
                }}
                placeholder={t('MAP_FILTER_DISTANCE_PLACEHOLDER')}
                placeholderTextColor={COLORS.neutral650}
                keyboardType="numeric"
                style={[styles.distanceInput, distanceKmError ? styles.distanceInputError : null]}
              />
              {!!distanceKmError && (
                <Text style={styles.distanceErrorText}>{distanceKmError}</Text>
              )}
              {!!locationError && distanceFilterActive && (
                <Text style={styles.distanceErrorText}>{locationError}</Text>
              )}
              <View style={styles.distanceFooterRow}>
                <TouchableOpacity
                  style={styles.distanceFooterBtn}
                  onPress={() => {
                    setCloseToMe(false)
                    setSelectedDistanceKm(null)
                    setDistanceKmInput('')
                    setDistanceKmError(null)
                    setLocationError(null)
                  }}
                >
                  <Text style={styles.distanceFooterBtnText}>{t('COMMON_BTN_CANCEL')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.distanceFooterBtn}
                  onPress={() => setOpenFilter(null)}
                >
                  <Text style={styles.distanceFooterBtnText}>{t('COMMON_BTN_CLOSE')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
        {openFilter && <Pressable style={styles.overlay} onPress={handleOutsidePress} />}
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 100 }}
          refreshControl={
            <RefreshControl
              refreshing={loading || isFetching}
              onRefresh={handleRefresh}
            />
          }
        >
          {(loading || isFetching) && visibleEvents.length === 0 && (
            <SkeletonList count={6} style={{ paddingTop: 6 }} />
          )}
          {error && <Text style={[styles.statusText,{color: COLORS.danger}]}>{t('EVENT_LIST_ERR_FAILED')} {error}</Text>}
          {!loading && !isFetching && !error && filteredEvents.length === 0 && (
            <Text style={[styles.statusText, { paddingVertical: 30 }]}>{t('EVENT_LIST_NO_RESULTS')}</Text>
          )}
            {visibleEvents.map(ev => {
              const venues = asArray(ev.venue)
              let venueDisplay: string[] = []
              const lowerVenues = venues.map(v => v.toLowerCase())
              if (lowerVenues.includes('indoor') && lowerVenues.includes('outdoor')) venueDisplay=[t('MAP_LABEL_IN_OUTDOOR')]
              else if (lowerVenues.includes('indoor')) venueDisplay=[t('MAP_LABEL_INDOOR')]
              else if (lowerVenues.includes('outdoor')) venueDisplay=[t('MAP_LABEL_OUTDOOR')]
              else if (venues.length) venueDisplay=[venues[0]]
              const expanded = expandedIds.has(ev.eventid)

              // First image from event images
              const imageUrl = (Array.isArray(ev.images) && ev.images.length > 0) ? ev.images[0] : null

              const distanceText = (() => {
                if (!distanceFilterActive) return null
                if (!userCoord) return null
                if (typeof ev.latitude !== 'number' || typeof ev.longitude !== 'number') return null
                const payload = {
                  origin_lat: userCoord.latitude,
                  origin_lng: userCoord.longitude,
                  dest_lat: ev.latitude,
                  dest_lng: ev.longitude,
                }
                const entry = peekDistanceMatrixCached(payload)
                const routeMeters = typeof entry?.result?.distance_meters === 'number' ? entry.result.distance_meters : null
                const routeFormatted = formatKmFromMeters(routeMeters)
                if (entry?.status === 'loaded' && routeFormatted) return routeFormatted
                const approxMeters = haversineMeters(userCoord.latitude, userCoord.longitude, ev.latitude, ev.longitude)
                const approxFormatted = formatKmFromMeters(approxMeters)
                if (approxFormatted) return `~${approxFormatted}`
                return null
              })()

              // Date/time display
              const dateDisplay = (() => {
                const start = ev.start_timestamp || ev.time
                const end = ev.end_timestamp
                if (!start) return t('COMMON_LABEL_UNKNOWN_DATE')
                const startD = parseMaybeTimestamp(start) || new Date(start)
                const endD = end ? (parseMaybeTimestamp(end) || new Date(end)) : null
                const day = startD.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })
                const startTime = startD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })
                const endTime = endD ? endD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : ''
                return `${day}, ${startTime}${endTime?` - ${endTime}`:''}`
              })()

              return (
                <TouchableOpacity
                  key={ev.eventid}
                  activeOpacity={0.85}
                  style={styles.card}
                  onPress={() => router.push(`/event/eventBooking?eventid=${ev.eventid}` as any)}
                >
                  {/* Image section */}
                  <View style={styles.cardImageWrap}>
                    {imageUrl ? (
                      <Image source={{ uri: imageUrl }} style={styles.cardImage} />
                    ) : (
                      <View style={styles.cardImagePlaceholder}>
                        <Image source={ICONS.sillball} style={styles.cardPlaceholderIcon} />
                      </View>
                    )}

                    {/* Overlay tags — top left */}
                    <View style={styles.cardOverlayTags}>
                      {venueDisplay.map(v => (
                        <View key={v} style={[styles.overlayTag, styles.venueTag]}><Text style={styles.overlayTagText}>{v}</Text></View>
                      ))}
                      {distanceText && (
                        <View style={[styles.overlayTag, styles.distanceOverlayTag]}><Text style={styles.overlayTagText}>{distanceText}</Text></View>
                      )}
                      <View style={[styles.overlayTag, ev.entry_fee == null ? styles.freeOverlayTag : styles.entryOverlayTag]}>
                        <Text style={styles.overlayTagText}>{ev.entry_fee == null ? t('EVENT_LIST_ENTRY_FREE') : `${formatCurrency(ev.entry_fee)}₫`}</Text>
                      </View>
                    </View>

                    {/* Expand arrow — top right */}
                    <TouchableOpacity onPress={() => toggleExpand(ev.eventid)} style={styles.expandBtnOverlay}>
                      <Image source={ICONS.arrowdown} style={[styles.expandIconOverlay, expanded && { transform:[{rotate:'180deg'}]}]} />
                    </TouchableOpacity>
                  </View>

                  {/* Info section */}
                  <View style={styles.cardInfoSection}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{ev.title || `Event ${ev.eventid}`}</Text>
                    <Text style={styles.cardAddress} numberOfLines={1}>{ev.address || ev.court_name || t('EVENT_LIST_EXPANDED_UNKNOWN_ADDRESS')}</Text>
                    <View style={styles.cardMetaRow}>
                      <Text style={styles.dateText}>{dateDisplay}</Text>
                      <View style={styles.participantsInline}>
                        <Image source={ICONS.participants} style={styles.participantsIconSmall} />
                        <Text style={styles.participantsText}>{(ev.numberofpeople ?? 0)}/{(ev.participants_cap ?? 0)}</Text>
                      </View>
                    </View>
                    {expanded && (
                      <View style={styles.expandedContent}>
                        <Text style={styles.expandedLine}>{t('EVENT_LIST_EXPANDED_ORGANIZER')} {ev.organizerName || ev.organizerid}</Text>
                        <Text style={styles.expandedDescLabel}>{t('COMMON_LABEL_DESCRIPTION')}:</Text>
                        <Text style={styles.expandedDesc} numberOfLines={4}>{ev.description || t('EVENT_LIST_EXPANDED_NO_DESC')}</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              )
            })}

            {visibleCount < displayEvents.length && (
              <View style={styles.loadMoreWrap}>
                {loadingMore ? (
                  <ActivityIndicator size="small" color={COLORS.neutral800} />
                ) : (
                  <Pressable onPress={handleLoadMore} hitSlop={8}>
                    <Text style={styles.loadMoreText}>{t('COMMON_LABEL_LOAD_MORE')}</Text>
                  </Pressable>
                )}
              </View>
            )}
        </ScrollView>
      </View>
      {/* Floating Create Button */}
      <TouchableOpacity style={[styles.fab, { bottom: 30 + Math.max(insets.bottom || 0, 12) }]} onPress={() => router.push('/event/eventCreate' as any)}>
        <Image source={ICONS.buttonBooking} style={styles.fabIcon} />
        <Text style={styles.fabText}>{t('EVENT_LIST_BTN_CREATE')}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

export default EventListScreen

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:COLORS.white},
  headerRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingTop:6,marginBottom:13},
  headerTitle:{flex:1,textAlign:'center',fontSize:20,fontWeight:'700',color:COLORS.neutral925},
  headerSpacer:{width:40},
  backButton:{padding:8,marginRight:8,borderRadius:28,backgroundColor:COLORS.neutral175},
  backIcon:{width:24,height:24,tintColor:COLORS.neutral925,resizeMode:'contain'},
  searchRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingBottom:4},
  searchContainer:{flex:1,flexDirection:'row',alignItems:'center',backgroundColor:COLORS.neutral125,borderRadius:24,paddingHorizontal:14,paddingVertical:10},
  searchIcon:{width:18,height:18,tintColor:COLORS.neutral800,marginRight:8,resizeMode:'contain'},
  searchInput:{flex:1,color:COLORS.neutral975,fontSize:15,paddingVertical:0},
  container:{flex:1,paddingHorizontal:12,paddingTop:4},
  filterRow:{marginBottom:12},
  filtersInner:{flexDirection:'row',gap:10,paddingRight:4},
  filterButton:{flexDirection:'row',alignItems:'center',backgroundColor:COLORS.neutral125,paddingHorizontal:12,paddingVertical:6,borderRadius:20},
  filterButtonActive:{backgroundColor:COLORS.limeGreen},
  filterButtonDisabled:{backgroundColor:COLORS.neutral200, opacity:0.6},
  filterIcon:{width:16,height:16,tintColor:COLORS.neutral800,marginRight:6,resizeMode:'contain'},
  filterText:{color:COLORS.neutral950,fontSize:13,fontWeight:'600'},
  filterTextActive:{ color:COLORS.white },
  countBadge:{marginLeft:6,backgroundColor:COLORS.neutral525,color:COLORS.neutral975,paddingHorizontal:6,paddingVertical:2,borderRadius:10,fontSize:11,overflow:'hidden',fontWeight:'600'},
  
  sectionTitle:{fontSize:22,fontWeight:'500',color:COLORS.neutral950,marginBottom:12,marginLeft:4,marginTop:15},
  dropdownWrapper:{position:'absolute',top:100,left:12,right:12,zIndex:20},
  dropdown:{maxHeight:200,backgroundColor:COLORS.white,borderRadius:8,paddingVertical:4,borderWidth:1,borderColor:COLORS.neutral350},
  dropdownItem:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:12,paddingVertical:8},
  dropdownItemText:{color:COLORS.neutral950,fontSize:14},
  tickBox:{width:20,height:20,borderRadius:4,borderWidth:1,borderColor:COLORS.neutral550,alignItems:'center',justifyContent:'center'},
  tickBoxSelected:{backgroundColor:COLORS.limeGreen,borderColor:COLORS.limeGreen},
  tickText:{color:COLORS.white,fontSize:14},
  overlay:{position:'absolute',top:0,left:0,right:0,bottom:0},
  list:{flex:1},
  loadMoreWrap:{paddingVertical:14,alignItems:'center',justifyContent:'center'},
  loadMoreText:{color:LIST_ACCENT,fontWeight:'700',fontSize:13},
  statusText:{color:COLORS.neutral800,fontSize:12,paddingVertical:12,textAlign:'center'},
  card:{
    backgroundColor:COLORS.white,
    borderRadius:16,
    marginBottom:16,
    overflow:'hidden',
    borderWidth:1,
    borderColor:COLORS.neutral200 ?? '#E5E5E5',
    shadowColor:'#000',
    shadowOffset:{width:0,height:2},
    shadowOpacity:0.08,
    shadowRadius:8,
    elevation:3,
  },
  cardImageWrap:{
    width:'100%',
    height:170,
    backgroundColor:COLORS.neutral125,
    position:'relative',
  },
  cardImage:{
    width:'100%',
    height:'100%',
    resizeMode:'cover',
  },
  cardImagePlaceholder:{
    width:'100%',
    height:'100%',
    justifyContent:'center',
    alignItems:'center',
    backgroundColor:COLORS.neutral125,
  },
  cardPlaceholderIcon:{
    width:80,
    height:80,
    opacity:0.15,
    tintColor:LIST_ACCENT,
    resizeMode:'contain',
  },
  cardOverlayTags:{
    position:'absolute',
    top:10,
    left:10,
    flexDirection:'row',
    flexWrap:'wrap',
    gap:6,
  },
  overlayTag:{
    paddingHorizontal:10,
    paddingVertical:5,
    borderRadius:8,
  },
  overlayTagText:{
    color:COLORS.white,
    fontSize:11,
    fontWeight:'700',
  },
  venueTag:{backgroundColor:COLORS.slateBlue},
  distanceOverlayTag:{backgroundColor:'rgba(0,0,0,0.55)'},
  freeOverlayTag:{backgroundColor:COLORS.seaGreen ?? '#2E8B57'},
  entryOverlayTag:{backgroundColor:COLORS.orangeAccent},
  expandBtnOverlay:{position:'absolute',top:10,right:10,backgroundColor:'rgba(255,255,255,0.85)',borderRadius:14,padding:5},
  expandIconOverlay:{width:18,height:18,tintColor:COLORS.neutral800},
  cardInfoSection:{
    paddingHorizontal:14,
    paddingVertical:12,
  },
  cardTitle:{color:COLORS.neutral950,fontSize:15,fontWeight:'700',marginBottom:3},
  cardAddress:{color:COLORS.neutral800,fontSize:13,fontWeight:'500'},
  cardMetaRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:4},
  dateText:{color:COLORS.neutral800,fontSize:12,fontWeight:'600'},
  participantsInline:{flexDirection:'row',alignItems:'center'},
  participantsIconSmall:{width:14,height:14,tintColor:COLORS.neutral525,marginRight:4,resizeMode:'contain'},
  participantsText:{color:COLORS.neutral800,fontSize:12,fontWeight:'600'},
  expandedContent:{marginTop:10,borderTopWidth:StyleSheet.hairlineWidth,borderTopColor:COLORS.neutral200 ?? '#E5E5E5',paddingTop:10},
  expandedLine:{color:COLORS.neutral800,fontSize:13,fontWeight:'500',marginBottom:6},
  expandedDescLabel:{color:COLORS.neutral800,fontSize:13,marginTop:6,fontWeight:'700'},
  expandedDesc:{color:COLORS.neutral800,fontSize:13,marginTop:6,lineHeight:18},
  fab:{position:'absolute',right:20,bottom:30,backgroundColor:COLORS.orangeAccent,paddingHorizontal:18,paddingVertical:12,borderRadius:30,flexDirection:'row',alignItems:'center',shadowColor:COLORS.black,shadowOpacity:0.3,shadowRadius:6,elevation:5},
  fabIcon:{width:22,height:22,tintColor:COLORS.white,marginRight:8,resizeMode:'contain'},
  fabText:{color:COLORS.white,fontSize:14,fontWeight:'700'},

  distanceFilterTitle:{fontSize:13,fontWeight:'700',color:COLORS.neutral950,marginBottom:8,marginTop:10},
  distanceInput:{backgroundColor:COLORS.neutral125,borderRadius:8,paddingHorizontal:10,paddingVertical:8,fontSize:14,color:COLORS.neutral975},
  distanceInputError:{borderWidth:1,borderColor:COLORS.danger},
  distanceErrorText:{color:COLORS.danger,fontSize:12,marginTop:6},
  distanceHeaderRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  closeToMeBtn:{backgroundColor:COLORS.neutral125,borderRadius:16,paddingHorizontal:12,paddingVertical:8,borderWidth:1,borderColor:COLORS.neutral350},
  closeToMeBtnActive:{backgroundColor:COLORS.limeGreen,borderColor:COLORS.limeGreen},
  closeToMeText:{fontSize:12,fontWeight:'700',color:COLORS.neutral925},
  closeToMeTextActive:{color:COLORS.neutral0},
  locationSpinnerWrap:{width:22,height:22,alignItems:'center',justifyContent:'center'},
  distanceFooterRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:12},
  distanceFooterBtn:{paddingHorizontal:10,paddingVertical:6,backgroundColor:COLORS.neutral175,borderRadius:8},
  distanceFooterBtnText:{fontSize:12,fontWeight:'700',color:COLORS.neutral925},
})
