import Constants from 'expo-constants'
import React, { useEffect, useMemo, useState } from 'react'
import { StyleProp, View, ViewStyle } from 'react-native'
import Mapbox from '@rnmapbox/maps'

import { GOONG_MAPTILES_KEY, MAPBOX_PUBLIC_TOKEN } from '@/env'
import { buildGoongStyleUrl, regionToZoom, zoomToRegion } from '@/lib/goong-map'

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
}

export type DynamicMapProps = {
  style: StyleProp<ViewStyle>
  initialRegion?: Region
  initialCenter?: Coordinate
  initialZoom?: number
  animateOnLoad?: boolean
  region?: Region
  markers?: DynamicMapMarker[]
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
  animateOnLoad,
  region,
  markers = [],
  showUserLocation,
  showsUserLocation = false,
  showsPointsOfInterest = false,
  showsBuildings = false,
  showsIndoors = false,
  customMapStyle,
  scrollEnabled = true,
  zoomEnabled = true,
  rotateEnabled = true,
  pitchEnabled = true,
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
  const executionEnvironment = readExecutionEnvironment()
  const isExpoGo = executionEnvironment === 'storeClient'
  const goongStyleUrl = buildGoongStyleUrl(GOONG_MAPTILES_KEY)
  const styleUrl = goongStyleUrl || 'mapbox://styles/mapbox/streets-v12'
  const canRenderMapbox = !isExpoGo && !!MAPBOX_PUBLIC_TOKEN
  const initialRegionFromCenter = useMemo(() => {
    if (!initialCenter) return undefined
    return zoomToRegion(initialCenter, initialZoom ?? 14)
  }, [initialCenter, initialZoom])
  const resolvedInitialRegion = initialRegion ?? initialRegionFromCenter
  const currentRegion = region ?? resolvedInitialRegion
  const shouldShowUserLocation = showUserLocation ?? showsUserLocation
  const validMarkers = useMemo(
    () => markers.filter((m) => Number.isFinite(m.coordinate.latitude) && Number.isFinite(m.coordinate.longitude)),
    [markers],
  )

  useEffect(() => {
    if (!canRenderMapbox) return
    Mapbox.setAccessToken(MAPBOX_PUBLIC_TOKEN)
  }, [canRenderMapbox])

  if (!canRenderMapbox || !currentRegion) {
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
        centerCoordinate={toMapboxCoordinate({
          latitude: currentRegion.latitude,
          longitude: currentRegion.longitude,
        })}
        zoomLevel={regionToZoom(currentRegion)}
      />
      {shouldShowUserLocation ? <Mapbox.UserLocation visible /> : null}
      {mapReady && validMarkers.map((marker) => (
        <Mapbox.PointAnnotation
          key={String(marker.id)}
          id={String(marker.id)}
          coordinate={toMapboxCoordinate(marker.coordinate)}
          title={marker.title}
          onSelected={() => onMarkerPress?.(marker.id)}
        >
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: marker.pinColor ?? '#FF6B00',
              borderWidth: 2,
              borderColor: '#FFFFFF',
            }}
          />
        </Mapbox.PointAnnotation>
      ))}
    </Mapbox.MapView>
  )
}

export default DynamicMap