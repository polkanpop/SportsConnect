import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { makeDistanceMatrixCacheKey, peekDistanceMatrixCached, prefetchDistanceMatrixBatchCached, subscribeDistanceMatrixCache, listTrainingSessionsCombinedCached, CombinedTrainingSession, CourtInfoRow } from '@/lib/backendApi'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import * as Location from 'expo-location'
import { getCachedUserCoord, setCachedUserCoord } from '@/lib/userLocation'
import { SkeletonList } from '@/components/ui/skeleton'

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

function asArray(v: CourtInfoRow['venue'] | undefined | null): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

const LIST_ACCENT = COLORS.orangeAccent // Training sessions

const TrainingSessionListScreen = () => {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [allSessions, setAllSessions] = useState<CombinedTrainingSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'venue' | 'payment' | 'distance' | null>(null)
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [freeOnly, setFreeOnly] = useState(false)
  const [paymentSelections, setPaymentSelections] = useState<string[]>([])

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

  const { data: sessionsData, isLoading: loading, isFetching, refetch, error: queryError } = useQuery({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombinedCached(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  })
  useEffect(() => { if (Array.isArray(sessionsData)) setAllSessions(sessionsData) }, [sessionsData])
  useEffect(() => { if (!loading && !sessionsData) setError('Failed to load sessions') }, [loading, sessionsData])

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
        setLocationError('Location permission is required')
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
      setLocationError('Unable to get your location')
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
    const s = new Set<string>(); allSessions.forEach(r => asArray(r.venue).forEach(x => s.add(x)))
    return [...s].sort((a,b)=>a.localeCompare(b))
  }, [allSessions])

  const filteredSessions = useMemo(() => {
    return allSessions.filter(s => {
      const status = String((s as any)?.status ?? '').toLowerCase()
      if (status.includes('cancel') || status.includes('complete')) return false

      // Hide past sessions (prefer end time when available).
      const startRaw = String((s as any)?.start_timestamp ?? (s as any)?.time ?? '').trim()
      const endRaw = String((s as any)?.end_timestamp ?? '').trim()
      const start = parseMaybeTimestamp(startRaw)
      const end = parseMaybeTimestamp(endRaw)
      const nowTs = Date.now()
      if (end && !Number.isNaN(end.getTime())) {
        if (end.getTime() < nowTs) return false
      } else if (start && !Number.isNaN(start.getTime())) {
        if (start.getTime() < nowTs) return false
      }

      const title = (s.title||'').toLowerCase(); const address=(s.address||'').toLowerCase()
      const queryOk = !search || title.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if(!queryOk) return false
      const venues = asArray(s.venue)
      const venueOk = selectedVenues.length===0 || selectedVenues.every(sel => venues.includes(sel))
      if(!venueOk) return false
      // Free filter logic (assumes entry_fee meta similar to events; if absent treat as free)
      const entryFee = (s as any).entry_fee
      const supportMethod = ((s as any).support_payment_method||'').toLowerCase()
      if (freeOnly) {
        if (entryFee != null) return false
      } else if (paymentSelections.length) {
        if (paymentSelections.length === 1) {
          const allowed = new Set<string>(paymentSelections)
          if (paymentSelections.some(m => m === 'cash' || m === 'vnpay')) allowed.add('both')
          if (!allowed.has(supportMethod)) return false
        } else {
          // Multiple payment selections -> require item to explicitly support both
          if (supportMethod !== 'both') return false
        }
      }
      return true
    })
  }, [allSessions, search, selectedVenues, freeOnly, paymentSelections])

  const displaySessions = useMemo(() => {
    let list = filteredSessions
    if (!distanceFilterActive || !userCoord) return list

    if (selectedDistanceKm != null) {
      const maxMeters = selectedDistanceKm * 1000
      list = list.filter(s => {
        if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') return false
        const d = haversineMeters(userCoord.latitude, userCoord.longitude, s.latitude, s.longitude)
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
  }, [filteredSessions, distanceFilterActive, userCoord, selectedDistanceKm, closeToMe])

  const toggleFree = () => {
    setFreeOnly(f => { const next=!f; if (next) setPaymentSelections([]); return next })
  }
  const togglePaymentPanel = () => { if(freeOnly) return; setOpenFilter(f=>f==='payment'?null:'payment') }
  const togglePaymentSelection = (opt:string) => {
    setPaymentSelections(prev => {
      let next = prev.includes(opt)? prev.filter(x=>x!==opt): [...prev,opt]
      return next
    })
  }

  // Incremental rendering state (pagination)
  const BATCH_SIZE = 15
  const [visibleCount, setVisibleCount] = useState<number>(BATCH_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
    setLoadingMore(false)
  }, [search, selectedVenues, freeOnly, paymentSelections, closeToMe, selectedDistanceKm])

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return
    const nextCount = Math.min(visibleCount + BATCH_SIZE, displaySessions.length)
    if (nextCount <= visibleCount) return

    setLoadingMore(true)
    try {
      const origin = await ensureUserLocation()
      if (!origin) {
        setVisibleCount(nextCount)
        return
      }

      const nextBatch = displaySessions.slice(visibleCount, nextCount)
      const dests: { dest_lat: number; dest_lng: number }[] = []
      for (const s of nextBatch) {
        if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') continue
        const p = { origin_lat: origin.latitude, origin_lng: origin.longitude, dest_lat: s.latitude, dest_lng: s.longitude }
        const key = makeDistanceMatrixCacheKey(p)
        if (requestedDistanceKeysRef.current.has(key)) continue
        requestedDistanceKeysRef.current.add(key)
        dests.push({ dest_lat: s.latitude, dest_lng: s.longitude })
      }

      await prefetchDistanceMatrixBatchCached({ origin_lat: origin.latitude, origin_lng: origin.longitude, destinations: dests })
      setVisibleCount(nextCount)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, visibleCount, displaySessions, ensureUserLocation])

  const visibleSessions = useMemo(() => displaySessions.slice(0, visibleCount), [displaySessions, visibleCount])

  useEffect(() => {
    if (!distanceFilterActive) return
    if (!userCoord) return

    const AUTO_PREFETCH_LIMIT = 15
    const allowBeyondLimit = openFilter === 'distance' || selectedDistanceKm != null

    const dests: { dest_lat: number; dest_lng: number }[] = []
    for (const s of visibleSessions) {
      if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') continue
      const p = { origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, dest_lat: s.latitude, dest_lng: s.longitude }
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
      dests.push({ dest_lat: s.latitude, dest_lng: s.longitude })
    }
    if (dests.length) {
      void prefetchDistanceMatrixBatchCached({ origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, destinations: dests })
    }
  }, [distanceFilterActive, userCoord, visibleSessions, openFilter, selectedDistanceKm])

  const toggleVenue = (v: string) => setSelectedVenues(p => p.includes(v)?p.filter(x=>x!==v):[...p,v])
  const toggleExpand = (id: number) => setExpandedIds(prev => { const n=new Set(prev); if(n.has(id)) n.delete(id); else n.add(id); return n })
  const handleOutsidePress = () => { if(openFilter) setOpenFilter(null) }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Session List</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.searchRow}>
        <View style={styles.searchContainer}>
          <Image source={ICONS.search} style={styles.searchIcon} />
          <TextInput placeholder='Search sessions...' placeholderTextColor={COLORS.neutral750} value={search} onChangeText={setSearch} style={styles.searchInput} />
        </View>
      </View>
      <View style={styles.container}>
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersInner}>
          <TouchableOpacity style={[styles.filterButton, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterButtonActive]} onPress={() => setOpenFilter(openFilter==='venue'?null:'venue')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterTextActive]}>Venue</Text>
            {selectedVenues.length>0 && <Text style={styles.countBadge}>{selectedVenues.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterButton, freeOnly && styles.filterButtonActive]} onPress={toggleFree}>
            <Image source={ICONS.freeIcon} style={styles.filterIcon} />
            <Text style={[styles.filterText, freeOnly && styles.filterTextActive]}>Free</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterButtonActive, freeOnly && styles.filterButtonDisabled]}
            onPress={togglePaymentPanel}
            disabled={freeOnly}
          >
            <Image source={ICONS.paymentMethod} style={[styles.filterIcon, freeOnly && { tintColor: COLORS.neutral600 }]} />
            <Text style={[styles.filterText, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterTextActive, freeOnly && { color: COLORS.neutral650 }]}>Payment</Text>
            {paymentSelections.length>0 && !freeOnly && <Text style={styles.countBadge}>{paymentSelections.length}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'distance' || distanceFilterActive) && styles.filterButtonActive]}
            onPress={() => setOpenFilter(openFilter === 'distance' ? null : 'distance')}
          >
            <Image source={ICONS.radar} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'distance' || distanceFilterActive) && styles.filterTextActive]}>
              {selectedDistanceKm != null ? `Distance: ${selectedDistanceKm}km` : (closeToMe ? 'Nearby Location' : 'Distance')}
            </Text>
          </TouchableOpacity>
          </ScrollView>
        </View>
        {/* Subheader removed (title is in header row) */}
        {openFilter && openFilter!=='payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {venueOptions.map(opt => {
                const selected = selectedVenues.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => toggleVenue(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}
        {openFilter==='payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {['cash','vnpay'].map(opt => {
                const selected = paymentSelections.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => togglePaymentSelection(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt==='cash'?'Cash':'VNPay'}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
              {paymentSelections.length===0 && <Text style={{ padding:10, fontSize:12, color: COLORS.neutral850 }}>Select payment methods to filter sessions.</Text>}
              
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
                  <Text style={[styles.closeToMeText, closeToMe && styles.closeToMeTextActive]}>Nearby Location</Text>
                </TouchableOpacity>
                {locationLoading && (
                  <View style={styles.locationSpinnerWrap}>
                    <ActivityIndicator size="small" color={COLORS.neutral800} />
                  </View>
                )}
              </View>
              <Text style={styles.distanceFilterTitle}>Type distance (km)</Text>
              <TextInput
                value={distanceKmInput}
                onChangeText={(t) => {
                  const cleaned = sanitizeKmInput(t)
                  setDistanceKmInput(cleaned)
                  if (cleaned.trim().length === 0) {
                    setDistanceKmError(null)
                    setSelectedDistanceKm(null)
                    return
                  }
                  const parsed = parseKmInput(cleaned)
                  if (parsed == null) {
                    setDistanceKmError('Please type in number')
                    return
                  }
                  setDistanceKmError(null)
                  setSelectedDistanceKm(parsed)
                }}
                placeholder="e.g. 2"
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
                  <Text style={styles.distanceFooterBtnText}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.distanceFooterBtn}
                  onPress={() => setOpenFilter(null)}
                >
                  <Text style={styles.distanceFooterBtnText}>Close</Text>
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
              onRefresh={() => refetch()}
            />
          }
        >
          {(loading || isFetching) && visibleSessions.length === 0 && (
            <SkeletonList count={6} style={{ paddingTop: 6 }} />
          )}
          {error && <Text style={[styles.statusText,{color: COLORS.danger}]}>Failed: {error}</Text>}
          {!loading && !isFetching && !error && filteredSessions.length === 0 && (
            <Text style={[styles.statusText, { paddingVertical: 30 }]}>No sessions found</Text>
          )}
          {visibleSessions.map(s => {
            const venues = asArray(s.venue)
            let venueDisplay:string[]=[]
            const lowerVenues = venues.map(v=>v.toLowerCase())
            if(lowerVenues.includes('indoor') && lowerVenues.includes('outdoor')) venueDisplay=['In/Outdoor']
            else if(venues.length) venueDisplay=[venues[0]]
            const expanded = expandedIds.has(s.sessionid)

            const distanceNode = (() => {
              if (!distanceFilterActive) return null
              if (!userCoord) return null
              if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') return null
              const payload = {
                origin_lat: userCoord.latitude,
                origin_lng: userCoord.longitude,
                dest_lat: s.latitude,
                dest_lng: s.longitude,
              }
              const entry = peekDistanceMatrixCached(payload)
              const routeMeters = typeof entry?.result?.distance_meters === 'number' ? entry.result.distance_meters : null
              const routeText = formatKmFromMeters(routeMeters)
              if (entry?.status === 'loaded' && routeText) {
                return (
                  <View style={[styles.tag, styles.distanceTag]}>
                    <Text style={[styles.tagText, styles.distanceTagText]}>{routeText}</Text>
                  </View>
                )
              }
              const approxMeters = haversineMeters(userCoord.latitude, userCoord.longitude, s.latitude, s.longitude)
              const approxText = formatKmFromMeters(approxMeters)
              if (approxText) {
                return (
                  <View style={[styles.tag, styles.distanceTag]}>
                    <Text style={[styles.tagText, styles.distanceTagText]}>{`~${approxText}`}</Text>
                  </View>
                )
              }
              return null
            })()

            return (
              <TouchableOpacity
                key={s.sessionid}
                activeOpacity={0.8}
                style={[styles.card, expanded && styles.cardExpanded]}
                onPress={() => router.push(`/event/tsBooking?sessionid=${s.sessionid}` as any)}
              >
                <Image source={ICONS.sillball} style={styles.cardSilhouette} />
                <View style={styles.cardLeft}>
                  <View style={styles.titleRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{s.title || `Session ${s.sessionid}`}</Text>
                    <TouchableOpacity onPress={() => toggleExpand(s.sessionid)} style={styles.expandButton}>
                      <Image source={ICONS.arrowdown} style={[styles.expandIcon, expanded && { transform:[{rotate:'180deg'}]}]} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.dateText}>{(() => {
                    const start = (s as any)?.start_timestamp ?? s.time
                    const end = (s as any)?.end_timestamp
                    if (!start) return 'Unknown date'
                    const startD = parseMaybeTimestamp(String(start)) || new Date(String(start))
                    const endD = end ? (parseMaybeTimestamp(String(end)) || new Date(String(end))) : null
                    const day = startD.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })
                    const startTime = startD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })
                    const endTime = endD ? endD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : ''
                    return `${day}, ${startTime}${endTime?` - ${endTime}`:''}`
                  })()}</Text>
                  <View style={styles.tagRow}>
                    {venueDisplay.map(v => <View key={v} style={[styles.tag, styles.venueTag]}><Text style={[styles.tagText,{color: COLORS.white}]}>{v}</Text></View>)}
                    {distanceNode}
                  </View>
                  {/* Entry fee + payment methods displayed on their own line (match events layout) */}
                  <View style={styles.entryRow}>
                    <View style={[styles.tag, (s as any).entry_fee == null ? styles.freeTag : styles.entryTag, styles.entryTagRow]}>
                      <Text style={[styles.tagText, (s as any).entry_fee == null ? styles.freeTagText : styles.entryTagText]}>{(s as any).entry_fee == null ? 'Entry: Free' : `${String(Math.round(Number((s as any).entry_fee))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}₫/player`}</Text>
                    </View>
                    {(s as any).entry_fee != null && (s as any).support_payment_method && (
                      <View style={[styles.tag, styles.methodTag, styles.methodIcons, styles.methodIconsRow]}>
                        {((s as any).support_payment_method.toLowerCase()==='cash' || (s as any).support_payment_method.toLowerCase()==='both') && (
                          <Image source={ICONS.cashIcon} style={styles.methodIconImg} />
                        )}
                        {((s as any).support_payment_method.toLowerCase()==='vnpay' || (s as any).support_payment_method.toLowerCase()==='both') && (
                          <Image source={ICONS.vnpayIcon} style={styles.methodIconImg} />
                        )}
                      </View>
                    )}
                  </View>
                  <View style={styles.participantsRow}>
                    <Image source={ICONS.participants} style={styles.participantsIconLarge} />
                    <Text style={styles.participantsText}>{(s.numberofpeople ?? 0)}/{(s.participants_cap ?? 0)} participants</Text>
                  </View>
                  {expanded && (
                    <View style={styles.expandedContent}>
                      <Text style={styles.expandedLine}>Coach: {s.coachName || s.coachid}</Text>
                      <Text style={styles.expandedLine}>Address: {s.address || 'Unknown address'}</Text>
                      <Text style={styles.expandedDescLabel}>Description:</Text>
                      <Text style={styles.expandedDesc} numberOfLines={4}>{s.description || 'No description'}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            )
          })}

          {visibleCount < displaySessions.length && (
            <View style={styles.loadMoreWrap}>
              {loadingMore ? (
                <ActivityIndicator size="small" color={COLORS.neutral800} />
              ) : (
                <Pressable onPress={handleLoadMore} hitSlop={8}>
                  <Text style={styles.loadMoreText}>Load more...</Text>
                </Pressable>
              )}
            </View>
          )}
        </ScrollView>
      </View>
      <TouchableOpacity style={[styles.fab, { bottom: 30 + Math.max(insets.bottom || 0, 12) }]} onPress={() => router.push('/event/tsCreate' as any)}>
        <Image source={ICONS.buttonBooking} style={styles.fabIcon} />
        <Text style={styles.fabText}>Create</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

export default TrainingSessionListScreen

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
  filterButtonDisabled:{backgroundColor:COLORS.neutral200,opacity:0.6},
  filterIcon:{width:16,height:16,tintColor:COLORS.neutral800,marginRight:6,resizeMode:'contain'},
  loadMoreWrap: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  loadMoreText: { color: LIST_ACCENT, fontWeight: '700', fontSize: 13 },
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
  statusText:{color:COLORS.neutral800,fontSize:12,paddingVertical:12,textAlign:'center'},
  card:{flexDirection:'row',backgroundColor:COLORS.white,borderRadius:14,padding:16,marginBottom:16,alignItems:'flex-start',minHeight:140,borderWidth:1,borderColor:LIST_ACCENT,borderLeftWidth:5,borderLeftColor:LIST_ACCENT,overflow:'hidden'},
  cardExpanded:{minHeight:180},
  cardLeft:{flex:1,paddingRight:78,zIndex:1},
  cardSilhouette:{position:'absolute',top:-14,right:-18,width:128,height:128,opacity:0.14,tintColor:LIST_ACCENT,resizeMode:'contain',zIndex:0},
  titleRow:{flexDirection:'row',alignItems:'center'},
  expandButton:{padding:4,marginLeft:6},
  expandIcon:{width:18,height:18,tintColor:COLORS.neutral500},
  cardTitle:{color:COLORS.neutral950,fontSize:16,fontWeight:'800',flexShrink:1},
  dateText:{color:COLORS.neutral800,fontSize:13,fontWeight:'600',marginTop:2},
  tagRow:{flexDirection:'row',flexWrap:'wrap',marginTop:6},
  tag:{backgroundColor:COLORS.neutral125,paddingHorizontal:8,paddingVertical:4,borderRadius:12,marginRight:6,marginBottom:6,flexDirection:'row',alignItems:'center'},
  tagFallback:{backgroundColor:COLORS.neutral125},
  freeTag:{backgroundColor:COLORS.greenSoft, borderColor:COLORS.seaGreen, borderWidth:1},
  entryTag:{backgroundColor:COLORS.orangeSoft, borderColor:COLORS.orangeAccent, borderWidth:1},
  methodTag:{backgroundColor:COLORS.blue50, borderColor:COLORS.blue500, borderWidth:1},
  methodIcons:{flexDirection:'row',alignItems:'center'},
  methodIconImg:{width:16,height:16,resizeMode:'contain',marginHorizontal:2},
  freeTagText:{color:COLORS.green900,fontSize:11,fontWeight:'700'},
  entryTagText:{color:COLORS.brown900,fontSize:11,fontWeight:'700'},
  entryRow:{flexDirection:'row',alignItems:'center',marginTop:6,marginBottom:6},
  entryTagRow:{paddingHorizontal:10,paddingVertical:6},
  methodIconsRow:{flexDirection:'row',alignItems:'center',marginLeft:8},
  venueTag:{backgroundColor:COLORS.slateBlue},
  tagText:{color:COLORS.neutral900,fontSize:11,fontWeight:'700'},
  participantsRow:{flexDirection:'row',alignItems:'center',marginTop:4},
  participantsIcon:{width:14,height:14,tintColor:COLORS.neutral525,marginRight:4,resizeMode:'contain'},
  participantsIconLarge:{width:18,height:18,tintColor:COLORS.neutral525,marginRight:6,resizeMode:'contain'},
  participantsText:{color:COLORS.neutral800,fontSize:13,fontWeight:'600'},
  expandedContent:{marginTop:10},
  expandedLine:{color:COLORS.neutral800,fontSize:13,fontWeight:'500',marginBottom:4},
  expandedDescLabel:{color:COLORS.neutral800,fontSize:13,marginTop:4,fontWeight:'700'},
  expandedDesc:{color:COLORS.neutral800,fontSize:13,marginTop:4},
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
  distanceTag:{backgroundColor:COLORS.neutral125,borderColor:COLORS.neutral350,borderWidth:1,borderRadius:0},
  distanceTagText:{color:COLORS.neutral925,fontWeight:'700'},
  distanceTagLoading:{paddingHorizontal:10},
})