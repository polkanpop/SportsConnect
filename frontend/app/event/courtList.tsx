import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { makeDistanceMatrixCacheKey, peekDistanceMatrixCached, prefetchDistanceMatrixBatchCached, subscribeDistanceMatrixCache, listCourtInfoCached, CourtInfoRow, listFavouriteCourtsCached, FavouriteCourt, listCourts } from '@/lib/backendApi'
import { useQuery } from '@tanstack/react-query'
import { getCache, setCache } from '@/lib/cache'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useAuthContext } from '@/hooks/use-auth-context'
import * as Location from 'expo-location'
import { getCachedUserCoord, setCachedUserCoord } from '@/lib/userLocation'
import { SkeletonList } from '@/components/ui/skeleton'

type Coord = { latitude: number; longitude: number }

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

// Helper to normalise venue value to array of strings
function asArray(v: CourtInfoRow['venue'] | undefined | null): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    // Split on common separators if it looks like a delimited string
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

const LIST_ACCENT = '#2563eb' // Courts

const CourtListScreen = () => {
  const router = useRouter()
  const [allCourts, setAllCourts] = useState<CourtInfoRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'venue' | 'price' | 'distance' | null>(null)
    // Price filter state (inputs interpret value as thousands: 50 => 50,000 VND)
    const [minPriceK, setMinPriceK] = useState<string>('')
    const [maxPriceK, setMaxPriceK] = useState<string>('')
    const minPrice = useMemo(() => {
      const v = parseInt(minPriceK, 10); return Number.isNaN(v) ? null : v * 1000
    }, [minPriceK])
    const maxPrice = useMemo(() => {
      const v = parseInt(maxPriceK, 10); return Number.isNaN(v) ? null : v * 1000
    }, [maxPriceK])

    // Fetch courts base data (price per hour)
    const { data: courtsBase } = useQuery({ queryKey: ['courts'], queryFn: () => listCourts() })
    const priceByCourtId: Record<number, number> = useMemo(() => {
      const map: Record<number, number> = {}
      Array.isArray(courtsBase) && courtsBase.forEach((c: any) => { if (typeof c.courtid === 'number' && c.price != null) map[c.courtid] = Number(c.price) })
      return map
    }, [courtsBase])

    const formatCurrency = (n: number | null | undefined) => {
      if (n == null) return ''
      const s = String(Math.round(Number(n)))
      return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [favouriteCourtIds, setFavouriteCourtIds] = useState<number[]>([])
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const favLoadAbortRef = useRef<AbortController | null>(null)

  // Distance filter state (matches Map numeric rules)
  const [closeToMe, setCloseToMe] = useState(true)
  const [selectedDistanceKm, setSelectedDistanceKm] = useState<number | null>(null)
  const [distanceKmInput, setDistanceKmInput] = useState<string>('')
  const [distanceKmError, setDistanceKmError] = useState<string | null>(null)
  const [userCoord, setUserCoord] = useState<Coord | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const distanceFilterActive = closeToMe || selectedDistanceKm != null
  const requestedDistanceKeysRef = useRef<Set<string>>(new Set())
  const autoPrefetchedKeysRef = useRef<Set<string>>(new Set())
  const [, setDistanceMatrixTick] = useState(0)

  const { profile } = useAuthContext()

  useEffect(() => {
    return subscribeDistanceMatrixCache(() => setDistanceMatrixTick(t => (t + 1) % 1_000_000))
  }, [])

  const sanitizeKmInput = useCallback((raw: string) => {
    let s = raw.replace(',', '.')
    s = s.replace(/[^0-9.]/g, '')
    const parts = s.split('.')
    if (parts.length > 2) {
      s = `${parts[0]}.${parts.slice(1).join('')}`
    }
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
    // If origin changes, allow a fresh prefetch batch.
    autoPrefetchedKeysRef.current.clear()
  }, [userCoord])

  // Unified numeric user id resolver similar to Home.tsx
  const resolveUserId = useCallback(async (): Promise<number | null> => {
    if (profile && typeof (profile as any).userid === 'number') return (profile as any).userid
    try {
      const raw = await AsyncStorage.getItem('@backendProfile')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.userid === 'number') return parsed.userid
      }
    } catch {}
    try {
      const { data } = await supabase.auth.getSession()
      const uid = data.session?.user?.id
      if (uid && /^\d+$/.test(uid)) {
        const asInt = parseInt(uid, 10)
        if (!Number.isNaN(asInt)) return asInt
      }
    } catch {}
    return null
  }, [profile])

  const loadCourts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Attempt cached value first
      const cached = await getCache<CourtInfoRow[]>('cache:courtinfo:v1')
      if (cached && cached.length) {
        setAllCourts(cached.filter(r => (r.availability || '').toLowerCase() === 'available'))
      }
      const rows = await listCourtInfoCached()
      const available = rows.filter(r => (r.availability || '').toLowerCase() === 'available')
      setAllCourts(available)
      await setCache('cache:courtinfo:v1', rows, 5 * 60 * 1000, 5 * 60 * 1000)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch court info once
  useEffect(() => {
    loadCourts()
  }, [loadCourts])

  // Refresh on screen focus (handles coming back after Court Register)
  useFocusEffect(useCallback(() => { loadCourts() }, [loadCourts]))

  // Load favourites for current user
  const loadFavourites = useCallback(async () => {
    if (favLoadAbortRef.current) favLoadAbortRef.current.abort()
    const controller = new AbortController()
    favLoadAbortRef.current = controller
    try {
      const uid = await resolveUserId()
      setCurrentUserId(uid)
      if (uid == null) { setFavouriteCourtIds([]); return }
      const rows = await listFavouriteCourtsCached({ userid: uid })
      if (controller.signal.aborted) return
      const favRows: FavouriteCourt[] = Array.isArray(rows) ? (rows as any[]).filter(r => typeof r === 'object' && 'courtid' in r) : []
      setFavouriteCourtIds(favRows.map(r => r.courtid))
    } catch (e) {
      // silent failure keeps favourites empty
    }
  }, [resolveUserId])

  useEffect(() => { loadFavourites() }, [profile, loadFavourites])

  // Derive unique venue options
  const venueOptions = useMemo(() => {
    const set = new Set<string>()
    allCourts.forEach(c => {
      asArray(c.venue).forEach(v => set.add(v))
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [allCourts])

  // Filtering
  const filteredCourts = useMemo(() => {
    return allCourts.filter(c => {
      const name = (c.name || '').toLowerCase()
      const address = (c.address || '').toLowerCase()
      const queryOk = !search || name.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if (!queryOk) return false
      const venueArr = asArray(c.venue)
      const venueOk = selectedVenues.length === 0 || selectedVenues.every(sel => venueArr.includes(sel))
      const favOk = !showFavouritesOnly || favouriteCourtIds.includes(c.courtid)
      if (!(venueOk && favOk)) return false
      // Price filter
      const price = priceByCourtId[c.courtid]
      if (minPrice != null && (price == null || price < minPrice)) return false
      if (maxPrice != null && (price == null || price > maxPrice)) return false
      return true
    })
  }, [allCourts, search, selectedVenues, showFavouritesOnly, favouriteCourtIds, minPrice, maxPrice, priceByCourtId])

  const displayCourts = useMemo(() => {
    let list = filteredCourts
    if (!distanceFilterActive || !userCoord) return list

    if (selectedDistanceKm != null) {
      const maxMeters = selectedDistanceKm * 1000
      list = list.filter(c => {
        if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return false
        const d = haversineMeters(userCoord.latitude, userCoord.longitude, c.latitude, c.longitude)
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
  }, [filteredCourts, distanceFilterActive, userCoord, selectedDistanceKm, closeToMe])

  // Incremental rendering (pagination) state
  const BATCH_SIZE = 15
  const [visibleCount, setVisibleCount] = useState<number>(BATCH_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)

  // Reset visible items when filters/search/favourite toggle change
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
    setLoadingMore(false)
  }, [search, selectedVenues, showFavouritesOnly, minPriceK, maxPriceK, closeToMe, selectedDistanceKm])

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return
    const nextCount = Math.min(visibleCount + BATCH_SIZE, displayCourts.length)
    if (nextCount <= visibleCount) return

    setLoadingMore(true)
    try {
      const origin = await ensureUserLocation()
      // If we can't get location, still allow loading more (distance tags cannot be computed).
      if (!origin) {
        setVisibleCount(nextCount)
        return
      }

      const nextBatch = displayCourts.slice(visibleCount, nextCount)
      const dests: { dest_lat: number; dest_lng: number }[] = []
      for (const c of nextBatch) {
        if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') continue
        const payload = { origin_lat: origin.latitude, origin_lng: origin.longitude, dest_lat: c.latitude, dest_lng: c.longitude }
        const key = makeDistanceMatrixCacheKey(payload)
        if (requestedDistanceKeysRef.current.has(key)) continue
        requestedDistanceKeysRef.current.add(key)
        dests.push({ dest_lat: c.latitude, dest_lng: c.longitude })
      }

      // Batch prefetch; wait before revealing the next chunk.
      await prefetchDistanceMatrixBatchCached({ origin_lat: origin.latitude, origin_lng: origin.longitude, destinations: dests })
      setVisibleCount(nextCount)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, visibleCount, displayCourts, ensureUserLocation])

  const visibleCourts = useMemo(() => displayCourts.slice(0, visibleCount), [displayCourts, visibleCount])

  // Lazy Distance Matrix fetch only when distance filter is being used, and only for visible items.
  useEffect(() => {
    if (!distanceFilterActive) return
    if (!userCoord) return

    const AUTO_PREFETCH_LIMIT = 15
    const allowBeyondLimit = openFilter === 'distance' || selectedDistanceKm != null

    const dests: { dest_lat: number; dest_lng: number }[] = []
    for (const c of visibleCourts) {
      if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') continue
      const payload = { origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, dest_lat: c.latitude, dest_lng: c.longitude }
      const key = makeDistanceMatrixCacheKey(payload)
      if (requestedDistanceKeysRef.current.has(key)) continue

      if (!allowBeyondLimit && autoPrefetchedKeysRef.current.size >= AUTO_PREFETCH_LIMIT) continue

      const peeked = peekDistanceMatrixCached(payload)
      if (peeked?.status === 'loaded' || peeked?.status === 'error') {
        requestedDistanceKeysRef.current.add(key)
        continue
      }
      requestedDistanceKeysRef.current.add(key)
      if (!allowBeyondLimit) autoPrefetchedKeysRef.current.add(key)
      dests.push({ dest_lat: c.latitude, dest_lng: c.longitude })
    }

    if (dests.length) {
      void prefetchDistanceMatrixBatchCached({ origin_lat: userCoord.latitude, origin_lng: userCoord.longitude, destinations: dests })
    }
  }, [distanceFilterActive, userCoord, visibleCourts, openFilter, selectedDistanceKm])

  // Toggle selections
  const toggleVenue = (v: string) => {
    setSelectedVenues(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  // Close dropdown when tapping outside
  const handleOutsidePress = () => {
    if (openFilter) setOpenFilter(null)
  }

  const onPullToRefresh = useCallback(async () => {
    await Promise.all([
      loadCourts(),
      loadFavourites(),
    ])
  }, [loadCourts, loadFavourites])

  return (
    <SafeAreaView style={styles.safe}>
      {/* Back button row (moved above search bar) */}
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
      </View>
      {/* Search row */}
      <View style={styles.searchRow}>
        <View style={styles.searchContainer}>
          <Image source={ICONS.search} style={styles.searchIcon} />
          <TextInput
            placeholder='Search for courts...'
            placeholderTextColor={COLORS.neutral750}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
          />
        </View>
      </View>
      <View style={styles.container}>

        {/* Filter buttons row */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersInner}>
            <TouchableOpacity
              style={[styles.filterButton, (openFilter === 'venue' || selectedVenues.length > 0) && styles.filterButtonActive]}
              onPress={() => setOpenFilter(openFilter === 'venue' ? null : 'venue')}
            >
              <Image source={ICONS.menu} style={styles.filterIcon} />
              <Text style={[styles.filterText, (openFilter === 'venue' || selectedVenues.length > 0) && styles.filterTextActive]}>Venue</Text>
              {selectedVenues.length > 0 && <Text style={styles.countBadge}>{selectedVenues.length}</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.filterButton, showFavouritesOnly && styles.filterButtonActive]}
              onPress={() => setShowFavouritesOnly(prev => !prev)}
            >
              <Image source={ICONS.favouriteStar} style={[styles.filterIcon, showFavouritesOnly && styles.favStarActive]} />
              <Text style={[styles.filterText, showFavouritesOnly && styles.filterTextActive]}>Favourite</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.filterButton, (minPriceK || maxPriceK || openFilter === 'price') && styles.filterButtonActive]}
              onPress={() => setOpenFilter(openFilter === 'price' ? null : 'price')}
            >
              <Image source={ICONS.menu} style={styles.filterIcon} />
              <Text style={[styles.filterText, (openFilter === 'price' || minPriceK || maxPriceK) && styles.filterTextActive]}>Price</Text>
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
        {/* Subheader */}
        <Text style={styles.sectionTitle}>Court</Text>

        {/* Dropdown */}
        {openFilter === 'venue' && (
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
        {openFilter === 'price' && (
          <View style={[styles.dropdownWrapper, styles.priceDropdownWrapper]}> 
            <View style={[styles.dropdown, { paddingHorizontal: 12, paddingVertical: 10 }]}> 
              <View style={styles.priceDropdownHeader}>
                <Text style={styles.priceFilterTitle}>Price Range (×1,000₫)</Text>
              </View>
              <View style={styles.priceInputsRow}>
                <View style={styles.priceInputWrapper}>
                  <Text style={styles.priceLabel}>Min</Text>
                  <TextInput
                    value={minPriceK}
                    onChangeText={t => setMinPriceK(t.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 50"
                    placeholderTextColor={COLORS.neutral650}
                    keyboardType="numeric"
                    style={styles.priceInput}
                  />
                </View>
                <View style={styles.priceInputWrapper}>
                  <Text style={styles.priceLabel}>Max</Text>
                  <TextInput
                    value={maxPriceK}
                    onChangeText={t => setMaxPriceK(t.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 120"
                    placeholderTextColor={COLORS.neutral650}
                    keyboardType="numeric"
                    style={styles.priceInput}
                  />
                </View>
              </View>
              <View style={styles.priceFooterRow}>
                <TouchableOpacity
                  style={[styles.clearPriceBtn, styles.priceCloseBtn]}
                  onPress={() => { setMinPriceK(''); setMaxPriceK(''); }}
                >
                  <Text style={[styles.clearPriceBtnText, styles.priceCloseText]}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.clearPriceBtn, styles.priceCloseBtn]} onPress={() => { setOpenFilter(null) }}>
                  <Text style={[styles.clearPriceBtnText, styles.priceCloseText]}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {openFilter === 'distance' && (
          <View style={[styles.dropdownWrapper, styles.distanceDropdownWrapper]}>
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
              {!!locationError && (distanceFilterActive || openFilter === 'distance') && (
                <Text style={styles.distanceErrorText}>{locationError}</Text>
              )}

              <View style={styles.priceFooterRow}>
                <TouchableOpacity
                  style={[styles.clearPriceBtn, styles.priceCloseBtn]}
                  onPress={() => {
                    setCloseToMe(false)
                    setSelectedDistanceKm(null)
                    setDistanceKmInput('')
                    setDistanceKmError(null)
                    setLocationError(null)
                  }}
                >
                  <Text style={[styles.clearPriceBtnText, styles.priceCloseText]}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.clearPriceBtn, styles.priceCloseBtn]} onPress={() => { setOpenFilter(null) }}>
                  <Text style={[styles.clearPriceBtnText, styles.priceCloseText]}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
        {openFilter && <Pressable style={styles.overlay} onPress={handleOutsidePress} />}

        {/* Content list */}
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={onPullToRefresh}
            />
          }
        >
          {loading && visibleCourts.length === 0 && (
            <SkeletonList count={6} style={{ paddingTop: 6 }} />
          )}
          {error && <Text style={[styles.statusText, { color: COLORS.danger }]}>Failed: {error}</Text>}
          {!loading && !error && filteredCourts.length === 0 && (
            <Text style={styles.statusText}>No courts match your filters.</Text>
          )}
          {visibleCourts.map(c => {
            const venues = asArray(c.venue)
            // Venue tag logic: if both indoor & outdoor present, show In/Outdoor single tag
            let venueDisplay: string[] = []
            const lowerVenues = venues.map(v => v.toLowerCase())
            if (lowerVenues.includes('indoor') && lowerVenues.includes('outdoor')) {
              venueDisplay = ['In/Outdoor']
            } else if (venues.length) {
              venueDisplay = [venues[0]]
            }
            const isFav = favouriteCourtIds.includes(c.courtid)

            const distanceNode = (() => {
              if (!distanceFilterActive) return null
              if (!userCoord) return null
              if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return null
              const payload = {
                origin_lat: userCoord.latitude,
                origin_lng: userCoord.longitude,
                dest_lat: c.latitude,
                dest_lng: c.longitude,
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
              // Instant straight-line distance while route distance loads.
              const approxMeters = haversineMeters(userCoord.latitude, userCoord.longitude, c.latitude, c.longitude)
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
              <View key={c.courtinfoid} style={styles.cardWrap}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.card}
                  onPress={() => router.push(`/event/courtBooking?courtid=${c.courtid}` as any)}
                >
                  <Image source={ICONS.sillball} style={styles.cardSilhouette} />
                  <View style={styles.cardLeft}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{c.name || `Court ${c.courtid}`}</Text>
                    <Text style={styles.cardAddress} numberOfLines={1}>{c.address || 'Unknown address'}</Text>
                    <View style={styles.tagRow}>
                      {venueDisplay.map(v => (
                        <View key={v} style={[styles.tag, styles.venueTag]}>
                          <Text style={[styles.tagText, { color: COLORS.neutral0 }]}>{v}</Text>
                        </View>
                      ))}
                      {distanceNode}
                    </View>
                    {priceByCourtId[c.courtid] != null && (
                      <View style={styles.entryRow}>
                        <View style={[styles.tag, styles.priceTag, styles.entryTagRow]}>
                          <Text style={[styles.tagText, styles.priceTagText]}>{`${formatCurrency(priceByCourtId[c.courtid])}₫/hr`}</Text>
                        </View>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>

                {isFav && (
                  <View pointerEvents="none" style={styles.bookmarkWrap}>
                    <Image source={ICONS.bookMark} style={styles.bookmarkIcon} />
                  </View>
                )}
              </View>
            )
          })}

          {visibleCount < displayCourts.length && (
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
    </SafeAreaView>
  )
}

export default CourtListScreen

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.neutral0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 6, marginBottom: 13 },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 4 },
  backButton: { padding: 8, marginRight: 8, borderRadius: 28, backgroundColor: COLORS.neutral175 },
  backIcon: { width: 24, height: 24, tintColor: COLORS.neutral925, resizeMode: 'contain' },
  searchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.neutral125, borderRadius: 24, paddingHorizontal: 14, paddingVertical: 10 },
  searchIcon: { width: 18, height: 18, tintColor: COLORS.neutral800, marginRight: 8, resizeMode: 'contain' },
  container: { flex: 1, paddingHorizontal: 12, paddingTop: 4 },
  // Increased spacing below search bar
  searchWrapper: { marginBottom: 10 },
  searchInput: { flex: 1, color: COLORS.neutral975, fontSize: 15, paddingVertical: 0 },
  // More space below filters
  filterRow: { marginBottom: 12 },
  filtersInner: { flexDirection: 'row', gap: 10, paddingRight: 4 },
  sectionTitle: { fontSize: 22, fontWeight: '500', color: COLORS.neutral950, marginBottom: 12, marginLeft: 4, marginTop: 15 },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.neutral125,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  filterIcon: { width: 16, height: 16, tintColor: COLORS.neutral800, marginRight: 6, resizeMode: 'contain' },
  filterText: { color: COLORS.neutral950, fontSize: 13, fontWeight: '600' },
  favStarActive: { tintColor: COLORS.neutral0 },
  countBadge: { marginLeft: 6, backgroundColor: COLORS.neutral525, color: COLORS.neutral975, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, fontSize: 11, overflow: 'hidden', fontWeight: '600' },
  dropdownWrapper: { position: 'absolute', top: 100, left: 12, right: 12, zIndex: 20 },
  priceDropdownWrapper: { position: 'absolute', top: 45, left: 12, right: 12, zIndex: 30 },
  dropdown: { maxHeight: 200, backgroundColor: COLORS.neutral0, borderRadius: 8, paddingVertical: 4, borderWidth: 1, borderColor: COLORS.neutral350 },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  dropdownItemText: { color: COLORS.neutral950, fontSize: 14 },
  tickBox: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: COLORS.neutral550, alignItems: 'center', justifyContent: 'center' },
  tickBoxSelected: { backgroundColor: COLORS.limeGreen, borderColor: COLORS.limeGreen },
  tickText: { color: COLORS.neutral0, fontSize: 14 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Push list a bit further down
  list: { flex: 1, marginTop: 14 },
  loadMoreWrap: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  loadMoreText: { color: LIST_ACCENT, fontWeight: '700', fontSize: 13 },
  statusText: { color: COLORS.neutral800, fontSize: 12, paddingVertical: 12, textAlign: 'center' },
  cardWrap: { position: 'relative', overflow: 'visible', marginBottom: 16 },
  card: {
    flexDirection: 'row',
    backgroundColor: COLORS.neutral0,
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
    minHeight: 140,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderLeftWidth: 5,
    borderLeftColor: LIST_ACCENT,
    overflow: 'hidden',
  },
  bookmarkWrap: { position: 'absolute', top: -3, right: -6, zIndex: 50, elevation: 50 },
  bookmarkIcon: { width: 32, height: 32, tintColor: COLORS.gold, resizeMode: 'contain' },
  cardLeft: { flex: 1, paddingRight: 78, zIndex: 1 },
  cardSilhouette: { position: 'absolute', top: -14, right: -18, width: 128, height: 128, opacity: 0.14, tintColor: LIST_ACCENT, resizeMode: 'contain', zIndex: 0 },
  cardTitle: { color: COLORS.neutral950, fontSize: 16, fontWeight: '800', marginBottom: 4 },
  cardAddress: { color: COLORS.neutral800, fontSize: 13, fontWeight: '500' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  tag: { backgroundColor: COLORS.neutral125, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginRight: 6, marginBottom: 6 },
  tagFallback: { backgroundColor: COLORS.neutral125 },
  venueTag: { backgroundColor: COLORS.slateBlue },
  tagText: { color: COLORS.neutral900, fontSize: 11, fontWeight: '700' },
  distanceTag: { backgroundColor: COLORS.neutral125, borderColor: COLORS.neutral350, borderWidth: 1, borderRadius: 0 },
  distanceTagText: { color: COLORS.neutral925, fontWeight: '700' },
  distanceTagLoading: { paddingHorizontal: 10 },
  // Price filter & tag styles
  priceFilterTitle: { fontSize: 13, fontWeight: '700', color: COLORS.neutral950, marginBottom: 8 },
  distanceFilterTitle: { fontSize: 13, fontWeight: '700', color: COLORS.neutral950, marginBottom: 8, marginTop: 10 },
  distanceDropdownWrapper: { position: 'absolute', top: 45, left: 12, right: 12, zIndex: 30 },
  distanceInput: { backgroundColor: COLORS.neutral125, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: COLORS.neutral975 },
  distanceInputError: { borderWidth: 1, borderColor: COLORS.danger },
  distanceErrorText: { color: COLORS.danger, fontSize: 12, marginTop: 6 },
  distanceHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeToMeBtn: { backgroundColor: COLORS.neutral125, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: COLORS.neutral350 },
  closeToMeBtnActive: { backgroundColor: COLORS.limeGreen, borderColor: COLORS.limeGreen },
  closeToMeText: { fontSize: 12, fontWeight: '700', color: COLORS.neutral925 },
  closeToMeTextActive: { color: COLORS.neutral0 },
  locationSpinnerWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  priceInputsRow: { flexDirection: 'row', gap: 12 },
  priceInputWrapper: { flex: 1 },
  priceLabel: { fontSize: 12, fontWeight: '600', color: COLORS.neutral900, marginBottom: 4 },
  priceInput: { backgroundColor: COLORS.neutral125, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: COLORS.neutral975 },
  clearPriceBtn: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: COLORS.lightgrey, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  clearPriceBtnText: { fontSize: 12, fontWeight: '600', color: COLORS.neutral925 },
  // header layout for price dropdown (title + optional close)
  priceDropdownHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  priceTag: { backgroundColor: COLORS.orangeSoft, borderColor: COLORS.orangeAccent, borderWidth: 1 },
  priceTagText: { color: COLORS.brown900, fontWeight: '700' },
  // Generic active filter appearance (green)
  filterButtonActive: { backgroundColor: COLORS.limeGreen },
  filterTextActive: { color: COLORS.neutral0 },
  // Price dropdown additions
  priceCloseBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: COLORS.neutral175, borderRadius: 8 },
  priceCloseText: { fontSize: 12, fontWeight: '700', color: COLORS.neutral925 },
  priceFooterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  entryRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 6 },
  entryTagRow: { paddingHorizontal: 10, paddingVertical: 6 },
})