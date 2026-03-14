import Constants from 'expo-constants'
import React, { useEffect, useMemo } from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import MapView, {
  Marker,
  PROVIDER_GOOGLE,
  type MapStyleElement,
  type MapPressEvent,
  type Region,
} from 'react-native-maps'

import { GOONG_MAPTILES_KEY, MAPBOX_PUBLIC_TOKEN } from '@/env'
import { buildGoongStyleUrl, regionToZoom, zoomToRegion } from '@/lib/goong-map'

type Coordinate = {
  latitude: number
  longitude: number
}

export type DynamicMapMarker = {
  id: string | number
  coordinate: Coordinate
  title?: string
  description?: string
  pinColor?: string
}

export type DynamicMapProps = {
  style: StyleProp<ViewStyle>
  initialRegion: Region
  region?: Region
  markers?: DynamicMapMarker[]
  showsUserLocation?: boolean
  showsPointsOfInterest?: boolean
  showsBuildings?: boolean
  showsIndoors?: boolean
  customMapStyle?: MapStyleElement[]
  scrollEnabled?: boolean
  zoomEnabled?: boolean
  rotateEnabled?: boolean
  pitchEnabled?: boolean
  onPress?: (coordinate: Coordinate) => void
  onRegionChangeComplete?: (region: Region) => void
}

type MapboxModule = {
  setAccessToken?: (token: string) => void
  MapView: React.ComponentType<any>
  Camera: React.ComponentType<any>
  PointAnnotation: React.ComponentType<any>
}

function loadMapboxModule(): MapboxModule | null {
  try {
    // Avoid a hard dependency during Expo Go development until @rnmapbox/maps is installed.
    // eslint-disable-next-line no-new-func
    const runtimeRequire = Function('return require')() as NodeRequire
    return runtimeRequire('@rnmapbox/maps') as MapboxModule
  } catch {
    return null
  }
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
  region,
  markers = [],
  showsUserLocation = false,
  showsPointsOfInterest = false,
  showsBuildings = false,
  showsIndoors = false,
  customMapStyle,
  scrollEnabled = true,
  zoomEnabled = true,
  rotateEnabled = true,
  pitchEnabled = true,
  onPress,
  onRegionChangeComplete,
}: DynamicMapProps) {
  const executionEnvironment = readExecutionEnvironment()
  const isExpoGo = executionEnvironment === 'storeClient'
  const goongStyleUrl = buildGoongStyleUrl(GOONG_MAPTILES_KEY)
  const mapboxModule = useMemo(() => (isExpoGo ? null : loadMapboxModule()), [isExpoGo])
  const shouldUseNativeMap = !isExpoGo && !!mapboxModule && !!goongStyleUrl

  useEffect(() => {
    if (!shouldUseNativeMap) return
    if (!MAPBOX_PUBLIC_TOKEN || !mapboxModule?.setAccessToken) return
    mapboxModule.setAccessToken(MAPBOX_PUBLIC_TOKEN)
  }, [mapboxModule, shouldUseNativeMap])

  if (!shouldUseNativeMap) {
    return (
      <MapView
        style={style}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        region={region}
        showsUserLocation={showsUserLocation}
        showsPointsOfInterest={showsPointsOfInterest}
        showsBuildings={showsBuildings}
        showsIndoors={showsIndoors}
        customMapStyle={customMapStyle}
        scrollEnabled={scrollEnabled}
        zoomEnabled={zoomEnabled}
        rotateEnabled={rotateEnabled}
        pitchEnabled={pitchEnabled}
        onPress={onPress ? (event: MapPressEvent) => onPress(event.nativeEvent.coordinate) : undefined}
        onRegionChangeComplete={onRegionChangeComplete}
      >
        {markers.map((marker) => (
          <Marker
            key={String(marker.id)}
            coordinate={marker.coordinate}
            title={marker.title}
            description={marker.description}
            pinColor={marker.pinColor}
          />
        ))}
      </MapView>
    )
  }

  const MapboxMapView = mapboxModule.MapView
  const Camera = mapboxModule.Camera
  const PointAnnotation = mapboxModule.PointAnnotation
  const currentRegion = region ?? initialRegion

  return (
    <MapboxMapView
      style={style}
      styleURL={goongStyleUrl}
      logoEnabled={false}
      attributionEnabled={false}
      compassEnabled={false}
      scaleBarEnabled={false}
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
      <Camera
        centerCoordinate={toMapboxCoordinate({
          latitude: currentRegion.latitude,
          longitude: currentRegion.longitude,
        })}
        zoomLevel={regionToZoom(currentRegion)}
      />
      {markers.map((marker) => (
        <PointAnnotation
          key={String(marker.id)}
          id={String(marker.id)}
          coordinate={toMapboxCoordinate(marker.coordinate)}
          title={marker.title}
        />
      ))}
    </MapboxMapView>
  )
}

export default DynamicMap