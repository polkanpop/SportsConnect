import { COLORS } from '@/constants/colors'
import { ICONS } from '@/constants/icons'
import { setCache } from '@/lib/cache'
import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE, Region } from 'react-native-maps'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

const COURT_REGISTER_VERIFY_STORAGE_KEY = '@courtRegisterVerifiedLocation'
const COURT_REGISTER_VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

type Coord = { latitude: number; longitude: number }

// Hide default map POIs (cafes/hotels/etc.) so only app marker remains.
const MAP_STYLE_HIDE_POI = [
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
]

export default function MapVerifyPage() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const insets = useSafeAreaInsets()

  const initial = useMemo<Coord | null>(() => {
    const latRaw = Array.isArray(params.lat) ? params.lat[0] : params.lat
    const lngRaw = Array.isArray(params.lng) ? params.lng[0] : params.lng
    const lat = latRaw != null ? Number(latRaw) : NaN
    const lng = lngRaw != null ? Number(lngRaw) : NaN
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { latitude: lat, longitude: lng }
  }, [params.lat, params.lng])

  const formattedAddress = useMemo(() => {
    const v = Array.isArray(params.formatted) ? params.formatted[0] : params.formatted
    return typeof v === 'string' ? v : undefined
  }, [params.formatted])

  const address = useMemo(() => {
    const v = Array.isArray(params.address) ? params.address[0] : params.address
    return typeof v === 'string' ? v : undefined
  }, [params.address])

  const [selectedCoord, setSelectedCoord] = useState<Coord | null>(initial)
  const [editMode, setEditMode] = useState(false)
  const [bottomBarHeight, setBottomBarHeight] = useState(0)

  const mapRef = useRef<MapView | null>(null)
  const blink = useRef(new Animated.Value(1)).current

  const DEFAULT_DELTA = 0.005

  // Vietnam bounding box (approx). Keeps the user from panning outside Vietnam.
  const VIETNAM_BOUNDS = {
    minLat: 8.0,
    maxLat: 23.6,
    minLng: 102.0,
    maxLng: 109.6,
  }

  const isInVietnam = (c: Coord) => {
    return (
      c.latitude >= VIETNAM_BOUNDS.minLat &&
      c.latitude <= VIETNAM_BOUNDS.maxLat &&
      c.longitude >= VIETNAM_BOUNDS.minLng &&
      c.longitude <= VIETNAM_BOUNDS.maxLng
    )
  }

  const lastValidRegionRef = useRef<Region | null>(null)

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.25, duration: 550, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    )
    anim.start()
    return () => anim.stop()
  }, [blink])

  useEffect(() => {
    if (!initial) return
    const region: Region = {
      latitude: initial.latitude,
      longitude: initial.longitude,
      latitudeDelta: DEFAULT_DELTA,
      longitudeDelta: DEFAULT_DELTA,
    }
    lastValidRegionRef.current = region
    const t = setTimeout(() => {
      try {
        mapRef.current?.animateToRegion(region, 700)
      } catch {}
    }, 50)
    return () => clearTimeout(t)
  }, [initial])

  const handleSubmit = async () => {
    if (!selectedCoord) return
    const payload = {
      latitude: selectedCoord.latitude,
      longitude: selectedCoord.longitude,
      formatted_address: formattedAddress || address || null,
    }
    // Persist briefly; CourtRegister will consume + clear it.
    try { await setCache(COURT_REGISTER_VERIFY_STORAGE_KEY, payload, COURT_REGISTER_VERIFY_TTL_MS) } catch {}
    router.back()
  }

  if (!initial) {
    return (
      <View style={styles.screen}>
        <SafeAreaView edges={['top']} />
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Image source={ICONS.arrowLeft} style={styles.backIcon} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Map View</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Missing coordinates</Text>
          <Text style={styles.errorText}>Please go back and verify the address again.</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} />
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Map View</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          style={styles.map}
          provider={PROVIDER_GOOGLE}
          showsPointsOfInterest={false}
          showsBuildings={false}
          showsIndoors={false}
          customMapStyle={MAP_STYLE_HIDE_POI}
          initialRegion={{
            latitude: initial.latitude,
            longitude: initial.longitude,
            latitudeDelta: DEFAULT_DELTA,
            longitudeDelta: DEFAULT_DELTA,
          }}
          onRegionChangeComplete={(r) => {
            // Keep center point inside Vietnam
            const center: Coord = { latitude: r.latitude, longitude: r.longitude }
            if (isInVietnam(center)) {
              lastValidRegionRef.current = r
              return
            }
            const fallback = lastValidRegionRef.current
            if (!fallback) return
            try {
              mapRef.current?.animateToRegion(fallback, 250)
            } catch {}
          }}
          onPress={(e) => {
            if (!editMode) return
            const c = e.nativeEvent.coordinate
            if (!c) return
            if (!isInVietnam({ latitude: c.latitude, longitude: c.longitude })) return
            setSelectedCoord({ latitude: c.latitude, longitude: c.longitude })
          }}
        >
          {!!selectedCoord && (
            <Marker coordinate={selectedCoord} title="Temporary Court">
              <Animated.View style={[styles.markerOuter, { opacity: blink }]}>
                <View style={styles.markerInner} />
              </Animated.View>
            </Marker>
          )}
        </MapView>

        <TouchableOpacity
          style={[
            styles.fab,
            {
              bottom: (bottomBarHeight || 92) + 12,
            },
          ]}
          onPress={() => setEditMode((p) => !p)}
          activeOpacity={0.85}
        >
          <Image
            source={editMode ? ICONS.x : ICONS.touch}
            style={styles.fabIcon}
          />
          <Text style={styles.fabText}>{editMode ? 'Cancel' : 'Edit Marker'}</Text>
        </TouchableOpacity>
      </View>

      <View
        style={[
          styles.bottomBar,
          {
            paddingBottom: 18 + Math.max(insets.bottom, 14),
          },
        ]}
        onLayout={(e) => {
          const h = e?.nativeEvent?.layout?.height
          if (typeof h === 'number' && h > 0) setBottomBarHeight(h)
        }}
      >
        <TouchableOpacity
          style={[styles.submitBtn, !selectedCoord && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={!selectedCoord}
          activeOpacity={0.85}
        >
          <Text style={styles.submitText}>Submit Location</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.neutral0 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.neutral0,
  },
  backBtn: {
    padding: 10,
    borderRadius: 28,
    backgroundColor: COLORS.neutral175,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: { width: 22, height: 22, tintColor: COLORS.neutral925 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: COLORS.neutral925, textAlign: 'center' },
  headerSpacer: { width: 42 },

  mapWrap: { flex: 1, position: 'relative' },
  map: { flex: 1 },

  markerOuter: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.orange200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.orangeAccent,
    borderWidth: 2,
    borderColor: COLORS.neutral0,
  },

  fab: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: COLORS.neutral0,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
  },
  fabIcon: { width: 18, height: 18, tintColor: COLORS.neutral975 },
  fabText: { fontSize: 13, fontWeight: '900', color: COLORS.neutral975 },

  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: COLORS.neutral0,
  },
  submitBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.blue600,
  },
  submitText: { color: COLORS.neutral0, fontSize: 15, fontWeight: '900' },
  btnDisabled: { opacity: 0.45 },

  errorBox: { paddingHorizontal: 18, paddingTop: 18 },
  errorTitle: { fontSize: 16, fontWeight: '900', color: COLORS.neutral975, marginBottom: 6 },
  errorText: { fontSize: 14, fontWeight: '700', color: COLORS.neutral800 },
})