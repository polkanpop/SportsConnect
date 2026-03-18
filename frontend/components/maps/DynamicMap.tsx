import Mapbox from '@rnmapbox/maps'
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Platform, StyleProp, View, ViewStyle } from 'react-native'

import { GOONG_MAPTILES_KEY, MAPBOX_PUBLIC_TOKEN } from '@/env'
import { buildGoongStyleUrl } from '@/lib/goong-map'

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Ho Chi Minh City fallback [lng, lat] — Mapbox coordinate order. */
const HCMC_CENTER: [number, number] = [106.660172, 10.762622]
const INITIAL_ZOOM = 5
const STREET_ZOOM = 15
const FLY_DURATION = 2000
const MARKER_FLY_DURATION = 1500
const LOCATION_FALLBACK_MS = 3000

const STYLE_URL =
  buildGoongStyleUrl(GOONG_MAPTILES_KEY) ||
  'mapbox://styles/mapbox/streets-v12'

const MAX_BOUNDS = {
  ne: [110.0, 25.0] as [number, number],
  sw: [100.0, 2.0] as [number, number],
}

const CAMERA_PADDING = {
  paddingTop: 0,
  paddingLeft: 0,
  paddingRight: 0,
  paddingBottom: 300,
}

// Marker color hierarchy: favorite → selected → default
const COLOR_FAVORITE = '#FFD700'
const COLOR_SELECTED = '#00FF00'
const COLOR_DEFAULT = '#FF6B00'

// ─── Token init (module scope — runs once before any component mounts) ──────
Mapbox.setAccessToken(MAPBOX_PUBLIC_TOKEN || '')

// ─── Types ──────────────────────────────────────────────────────────────────────

type Coordinate = {
  latitude: number
  longitude: number
}

type Region = Coordinate & {
  latitudeDelta: number
  longitudeDelta: number
}

export type DynamicMapMarker = {
  id: string | number
  coordinate: Coordinate
  title?: string
  description?: string
  /** Used internally for favorite-color matching. */
  courtId?: number
}

/** Imperative handle exposed to the parent via ref. */
export type DynamicMapRef = {
  flyTo: (center: Coordinate, zoom?: number) => void
}

export type DynamicMapProps = {
  style?: StyleProp<ViewStyle>
  markers?: DynamicMapMarker[]
  /** Currently selected court id — drives camera fly-to and green highlight. */
  selectedCourtId?: string | number | null
  /** Court ids the user has favorited (yellow markers). */
  favoriteCourtIds?: number[]
  /** User GPS position; when provided the initial swoop targets it. */
  userLocation?: Coordinate | null
  showUserLocation?: boolean
  /** Override the starting center (default: HCMC). */
  initialCenter?: Coordinate
  /** Override the starting zoom (default: 5 when animateOnLoad, else 15). */
  initialZoom?: number
  /** Set false to skip the zoom-5→15 swoop on load (e.g. mapVerify). */
  animateOnLoad?: boolean
  onMarkerPress?: (markerId: string | number) => void
  onPress?: (coordinate: Coordinate) => void
  onRegionChangeComplete?: (region: Region) => void
}

// ─── Component ──────────────────────────────────────────────────────────────────

export const DynamicMap = forwardRef<DynamicMapRef, DynamicMapProps>(
  function DynamicMap(
    {
      style,
      markers = [],
      selectedCourtId,
      favoriteCourtIds = [],
      userLocation,
      showUserLocation = true,
      initialCenter,
      initialZoom,
      animateOnLoad = true,
      onMarkerPress,
      onPress,
      onRegionChangeComplete,
    },
    ref,
  ) {
    const cameraRef = useRef<any>(null)
    const [mapReady, setMapReady] = useState(false)
    const hasSwoopedRef = useRef(false)

    // Resolve initial camera position
    const startCenter = useMemo<[number, number]>(() => {
      if (initialCenter) return [initialCenter.longitude, initialCenter.latitude]
      return HCMC_CENTER
    }, [initialCenter])

    const startZoom = initialZoom ?? (animateOnLoad ? INITIAL_ZOOM : STREET_ZOOM)

    // ── Imperative ref for parent camera control ──────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        flyTo(center: Coordinate, zoom = STREET_ZOOM) {
          cameraRef.current?.setCamera({
            centerCoordinate: [center.longitude, center.latitude],
            zoomLevel: zoom,
            animationMode: 'flyTo',
            animationDuration: MARKER_FLY_DURATION,
          })
        },
      }),
      [],
    )

    // ── Favorite set for O(1) color lookups ───────────────────────────────────
    const favoriteIdSet = useMemo(() => new Set(favoriteCourtIds), [favoriteCourtIds])

    // ── Initial swoop animation ───────────────────────────────────────────────
    useEffect(() => {
      if (!animateOnLoad) return
      if (!mapReady || hasSwoopedRef.current) return

      // If user location is known, swoop there immediately.
      if (userLocation) {
        hasSwoopedRef.current = true
        cameraRef.current?.setCamera({
          centerCoordinate: [userLocation.longitude, userLocation.latitude],
          zoomLevel: STREET_ZOOM,
          animationMode: 'flyTo',
          animationDuration: FLY_DURATION,
        })
        return
      }

      // Otherwise wait briefly for location, then fall back to HCMC.
      const timer = setTimeout(() => {
        if (hasSwoopedRef.current) return
        hasSwoopedRef.current = true
        cameraRef.current?.setCamera({
          centerCoordinate: HCMC_CENTER,
          zoomLevel: STREET_ZOOM,
          animationMode: 'flyTo',
          animationDuration: FLY_DURATION,
        })
      }, LOCATION_FALLBACK_MS)

      return () => clearTimeout(timer)
    }, [animateOnLoad, mapReady, userLocation])

    // ── Fly to selected court when it changes ─────────────────────────────────
    useEffect(() => {
      if (!mapReady || selectedCourtId == null) return
      const marker = markers.find((m) => m.id === selectedCourtId)
      if (!marker) return
      const { latitude, longitude } = marker.coordinate
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return

      cameraRef.current?.setCamera({
        centerCoordinate: [longitude, latitude],
        zoomLevel: STREET_ZOOM,
        animationMode: 'flyTo',
        animationDuration: MARKER_FLY_DURATION,
      })
    }, [selectedCourtId, markers, mapReady])

    // ── Callbacks ─────────────────────────────────────────────────────────────
    const handleMapLoaded = useCallback(() => {
      setMapReady(true)
    }, [])

    const handleMapPress = useCallback(
      (feature: any) => {
        if (!onPress) return
        const coords = feature?.geometry?.coordinates
        if (!Array.isArray(coords) || coords.length < 2) return
        onPress({ latitude: coords[1], longitude: coords[0] })
      },
      [onPress],
    )

    const handleMapIdle = useCallback(
      (state: any) => {
        if (!onRegionChangeComplete) return
        const center = state?.properties?.center
        const zoom = state?.properties?.zoom
        if (!Array.isArray(center) || center.length < 2 || typeof zoom !== 'number') return
        const clampedZoom = Math.max(0, Math.min(20, zoom))
        const longitudeDelta = 360 / Math.pow(2, clampedZoom)
        const latitudeDelta = longitudeDelta * 0.6
        onRegionChangeComplete({
          latitude: center[1],
          longitude: center[0],
          latitudeDelta,
          longitudeDelta,
        })
      },
      [onRegionChangeComplete],
    )

    // ── Guard against null coordinates ────────────────────────────────────────
    const validMarkers = useMemo(
      () =>
        markers.filter((m) => {
          const { latitude, longitude } = m.coordinate
          return (
            typeof latitude === 'number' &&
            Number.isFinite(latitude) &&
            typeof longitude === 'number' &&
            Number.isFinite(longitude)
          )
        }),
      [markers],
    )

    // ── Render ────────────────────────────────────────────────────────────────
    return (
      <Mapbox.MapView
        style={style}
        styleURL={STYLE_URL}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        scaleBarEnabled={false}
        onDidFinishLoadingMap={handleMapLoaded}
        onPress={handleMapPress}
        onMapIdle={handleMapIdle}
      >
        <Mapbox.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: startCenter,
            zoomLevel: startZoom,
          }}
          maxBounds={MAX_BOUNDS}
          padding={CAMERA_PADDING}
          minZoomLevel={3}
          maxZoomLevel={18}
        />

        {showUserLocation && <Mapbox.UserLocation visible />}

        {validMarkers.map((marker) => {
          const isFavorite = marker.courtId != null && favoriteIdSet.has(marker.courtId)
          const isSelected = marker.id === selectedCourtId
          const color = isFavorite ? COLOR_FAVORITE : isSelected ? COLOR_SELECTED : COLOR_DEFAULT
          const coord: [number, number] = [
            marker.coordinate.longitude,
            marker.coordinate.latitude,
          ]

          return (
            <Mapbox.PointAnnotation
              key={String(marker.id)}
              id={String(marker.id)}
              coordinate={coord}
              onSelected={() => onMarkerPress?.(marker.id)}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: color,
                  borderWidth: 3,
                  borderColor: '#FFFFFF',
                  ...Platform.select({
                    android: { elevation: 5 },
                    ios: {
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.3,
                      shadowRadius: 3,
                    },
                  }),
                }}
              />
            </Mapbox.PointAnnotation>
          )
        })}
      </Mapbox.MapView>
    )
  },
)

export default DynamicMap