import Constants from 'expo-constants'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, View, ViewStyle } from 'react-native'
import Mapbox from '@rnmapbox/maps'

import { GOONG_MAPTILES_KEY, MAPBOX_PUBLIC_TOKEN } from '@/env'
import { buildGoongStyleUrl, regionToZoom, zoomToRegion } from '@/lib/goong-map'
import { useTheme } from '@/providers/theme-provider'

const MAPBOX_TOKEN_RUNTIME = (
  MAPBOX_PUBLIC_TOKEN ||
  ((Constants.expoConfig?.extra as any)?.MAPBOX_PUBLIC_TOKEN as string | undefined) ||
  ((Constants.expoConfig?.extra as any)?.mapboxPublicToken as string | undefined) ||
  ''
).trim()

if (MAPBOX_TOKEN_RUNTIME) {
  Mapbox.setAccessToken(MAPBOX_TOKEN_RUNTIME)
}

type Coordinate = {
  latitude: number
  longitude: number
}

type Region = {
  latitude: number
  longitude: number
  latitudeDelta: number
  longitudeDelta: number
}

type MapStyleElement = Record<string, unknown>

export type DynamicMapMarker = {
  id: string | number
  coordinate: Coordinate
  title?: string
  description?: string
  pinColor?: string
  /** Optional image key for non-court markers: 'event' | 'training' */
  imageKey?: 'court' | 'event' | 'training'
}

type GeoFeature = {
  type: 'Feature'
  id: string
  geometry: {
    type: 'Point'
    coordinates: [number, number]
  }
  properties: {
    markerId: string | number
    title?: string
    description?: string
    pinColor?: string
    imageKey?: string
  }
}

type GeoFeatureCollection = {
  type: 'FeatureCollection'
  features: GeoFeature[]
}

export type DynamicMapProps = {
  style: StyleProp<ViewStyle>
  initialRegion?: Region
  initialCenter?: Coordinate
  initialZoom?: number
  minZoomLevel?: number
  maxZoomLevel?: number
  maxBounds?: {
    northEast: Coordinate
    southWest: Coordinate
  }
  animateOnLoad?: boolean
  region?: Region
  cameraCommandId?: number
  markers?: DynamicMapMarker[]
  selectedMarkerId?: string | number | null
  showUserLocation?: boolean
  showsUserLocation?: boolean
  showsPointsOfInterest?: boolean
  showsBuildings?: boolean
  showsIndoors?: boolean
  customMapStyle?: MapStyleElement[]
  scrollEnabled?: boolean
  zoomEnabled?: boolean
  rotateEnabled?: boolean
  pitchEnabled?: boolean
  onMarkerPress?: (markerId: string | number) => void
  onPress?: (coordinate: Coordinate) => void
  onRegionChangeComplete?: (region: Region) => void
}

function readExecutionEnvironment() {
  return Constants.executionEnvironment ?? 'bare'
}

function toMapboxCoordinate(coordinate: Coordinate) {
  return [coordinate.longitude, coordinate.latitude] as [number, number]
}

export function DynamicMap({
  style,
  initialRegion,
  initialCenter,
  initialZoom,
  minZoomLevel,
  maxZoomLevel,
  maxBounds,
  animateOnLoad,
  region,
  cameraCommandId,
  markers = [],
  selectedMarkerId,
  showUserLocation,
  showsUserLocation = false,
  showsPointsOfInterest = false,
  showsBuildings = false,
  showsIndoors = false,
  customMapStyle,
  scrollEnabled = true,
  zoomEnabled = true,
  rotateEnabled = false,
  pitchEnabled = false,
  onMarkerPress,
  onPress,
  onRegionChangeComplete,
}: DynamicMapProps) {
  void animateOnLoad
  void showsPointsOfInterest
  void showsBuildings
  void showsIndoors
  void customMapStyle

  const [mapReady, setMapReady] = useState(false)
  const cameraRef = useRef<Mapbox.Camera>(null)
  const lastAppliedCameraCommandRef = useRef<number | undefined>(undefined)
  const commandedRegionRef = useRef<Region | undefined>(undefined)
  const executionEnvironment = readExecutionEnvironment()
  const isExpoGo = executionEnvironment === 'storeClient'
  const { theme: themeMode } = useTheme()
  const goongStyleUrl = buildGoongStyleUrl(GOONG_MAPTILES_KEY, themeMode)
  const styleUrl = goongStyleUrl || 'mapbox://styles/mapbox/streets-v12'
  const canRenderMapbox = !isExpoGo && !!MAPBOX_TOKEN_RUNTIME
  const initialRegionFromCenter = useMemo(() => {
    if (!initialCenter) return undefined
    return zoomToRegion(initialCenter, initialZoom ?? 14)
  }, [initialCenter, initialZoom])
  const resolvedInitialRegion = initialRegion ?? initialRegionFromCenter
  const currentRegion = region ?? resolvedInitialRegion
  const initialCameraRegionRef = useRef<Region | undefined>(currentRegion)
  const shouldShowUserLocation = showUserLocation ?? showsUserLocation
  const validMarkers = useMemo(
    () => markers.filter((m) => Number.isFinite(m.coordinate.latitude) && Number.isFinite(m.coordinate.longitude)),
    [markers],
  )
  const markerFeatures = useMemo<GeoFeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: validMarkers.map((marker) => ({
      type: 'Feature',
      id: String(marker.id),
      geometry: {
        type: 'Point',
        coordinates: toMapboxCoordinate(marker.coordinate),
      },
      properties: {
        markerId: marker.id,
        title: marker.title,
        description: marker.description,
        pinColor: marker.pinColor,
        imageKey: marker.imageKey ?? 'court',
      },
    })),
  }), [validMarkers])

  useEffect(() => {
    if (!canRenderMapbox) return
    Mapbox.setAccessToken(MAPBOX_TOKEN_RUNTIME)
  }, [canRenderMapbox])

  useEffect(() => {
    if (!region) return
    commandedRegionRef.current = region
  }, [region])

  useEffect(() => {
    if (!mapReady) return
    if (cameraCommandId == null) return
    if (lastAppliedCameraCommandRef.current === cameraCommandId) return

    const target = commandedRegionRef.current
    if (!target) return

    lastAppliedCameraCommandRef.current = cameraCommandId
    cameraRef.current?.setCamera({
      centerCoordinate: toMapboxCoordinate({
        latitude: target.latitude,
        longitude: target.longitude,
      }),
      zoomLevel: regionToZoom(target),
      animationDuration: 900,
    })
  }, [cameraCommandId, mapReady])

  if (!canRenderMapbox || !initialCameraRegionRef.current) {
    return <View style={style} />
  }

  return (
    <Mapbox.MapView
      style={style}
      styleURL={styleUrl}
      logoEnabled={false}
      attributionEnabled={false}
      compassEnabled={false}
      scaleBarEnabled={false}
      onDidFinishLoadingMap={() => setMapReady(true)}
      zoomEnabled={zoomEnabled}
      scrollEnabled={scrollEnabled}
      rotateEnabled={rotateEnabled}
      pitchEnabled={pitchEnabled}
      onPress={onPress ? (feature: any) => {
        const coordinates = feature?.geometry?.coordinates
        if (!Array.isArray(coordinates) || coordinates.length < 2) return
        onPress({ latitude: coordinates[1], longitude: coordinates[0] })
      } : undefined}
      onMapIdle={onRegionChangeComplete ? (state: any) => {
        const center = state?.properties?.center
        const zoom = state?.properties?.zoom
        if (!Array.isArray(center) || center.length < 2 || typeof zoom !== 'number') return
        onRegionChangeComplete(zoomToRegion({ latitude: center[1], longitude: center[0] }, zoom))
      } : undefined}
    >
      <Mapbox.Camera
        ref={cameraRef}
        minZoomLevel={minZoomLevel}
        maxZoomLevel={maxZoomLevel}
        maxBounds={maxBounds ? {
          ne: toMapboxCoordinate(maxBounds.northEast),
          sw: toMapboxCoordinate(maxBounds.southWest),
        } : undefined}
        defaultSettings={{
          centerCoordinate: toMapboxCoordinate({
            latitude: initialCameraRegionRef.current.latitude,
            longitude: initialCameraRegionRef.current.longitude,
          }),
          zoomLevel: regionToZoom(initialCameraRegionRef.current),
        }}
      />
      {shouldShowUserLocation ? <Mapbox.UserLocation visible /> : null}
      {mapReady ? (
        <Mapbox.ShapeSource
          id="court-markers-source"
          shape={markerFeatures as any}
          onPress={onMarkerPress ? (event: any) => {
            const feature = Array.isArray(event?.features) ? event.features[0] : null
            const markerId = feature?.properties?.markerId
            if (markerId != null) onMarkerPress(markerId)
          } : undefined}
        >
          <Mapbox.Images
            images={{
              courtMarker: {
                image: require('../../assets/icons/map_markers.png'),
                sdf: true,
              },
            }}
          />
          {/* Court markers: SDF with dynamic color tinting */}
          <Mapbox.SymbolLayer
            id="court-markers-symbol"
            filter={['==', ['get', 'imageKey'], 'court']}
            style={{
              iconImage: 'courtMarker',
              iconAllowOverlap: true,
              iconIgnorePlacement: true,
              iconSize: 0.07,
              iconColor: selectedMarkerId != null
                ? ['case', ['==', ['get', 'markerId'], String(selectedMarkerId)], '#2AA84B', ['coalesce', ['get', 'pinColor'], '#FF5733']]
                : ['coalesce', ['get', 'pinColor'], '#FF5733'],
              iconAnchor: 'bottom',
              iconOpacity: 1,
            }}
          />
          {/* Event / Training session markers: same SDF icon with distinct colors */}
          <Mapbox.SymbolLayer
            id="event-ts-markers-symbol"
            filter={['in', ['get', 'imageKey'], ['literal', ['event', 'training']]]}
            style={{
              iconImage: 'courtMarker',
              iconAllowOverlap: true,
              iconIgnorePlacement: true,
              iconSize: 0.07,
              iconColor: ['match', ['get', 'imageKey'], 'event', '#1E88E5', 'training', '#7C4DFF', '#FF5733'],
              iconAnchor: 'bottom',
              iconOpacity: 1,
            }}
          />
        </Mapbox.ShapeSource>
      ) : null}
    </Mapbox.MapView>
  )
}

export default DynamicMap