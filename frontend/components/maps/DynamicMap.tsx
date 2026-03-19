import Constants from 'expo-constants'
import React, { useEffect, useMemo, useRef } from 'react'
import { Image, StyleProp, ViewStyle } from 'react-native'
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

type MapStyleElement = unknown

export type DynamicMapMarker = {
  id: string | number
  coordinate: Coordinate
  title?: string
  description?: string
  pinColor?: string
  courtId?: number
}

export type DynamicMapProps = {
  style?: StyleProp<ViewStyle>
  initialRegion?: Region
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
  initialCenter?: Coordinate
  initialZoom?: number
  animateOnLoad?: boolean
  selectedCourtId?: string | number | null
  favoriteCourtIds?: number[]
  userLocation?: Coordinate | null
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
  initialCenter,
  initialZoom = 15,
  animateOnLoad = true,
  selectedCourtId,
  favoriteCourtIds = [],
  userLocation,
  onMarkerPress,
  onPress,
  onRegionChangeComplete,
}: DynamicMapProps) {
  const cameraRef = useRef<any>(null)
  const executionEnvironment = readExecutionEnvironment()
  const isExpoGo = executionEnvironment === 'storeClient'
  const goongStyleUrl = buildGoongStyleUrl(GOONG_MAPTILES_KEY)
  const styleUrl = goongStyleUrl ?? 'mapbox://styles/mapbox/streets-v12'
  const favoriteIdSet = useMemo(() => new Set(favoriteCourtIds), [favoriteCourtIds])

  useEffect(() => {
    if (isExpoGo) return
    if (!MAPBOX_PUBLIC_TOKEN) return
    Mapbox.setAccessToken(MAPBOX_PUBLIC_TOKEN)
  }, [isExpoGo])

  const fallbackRegion: Region = {
    latitude: initialCenter?.latitude ?? userLocation?.latitude ?? 10.762622,
    longitude: initialCenter?.longitude ?? userLocation?.longitude ?? 106.660172,
    latitudeDelta: animateOnLoad ? 10 : 0.08,
    longitudeDelta: animateOnLoad ? 10 : 0.08,
  }
  const currentRegion = region ?? initialRegion ?? fallbackRegion

  const flyToMarker = (coordinate: Coordinate) => {
    cameraRef.current?.setCamera({
      centerCoordinate: toMapboxCoordinate(coordinate),
      zoomLevel: 16,
      animationMode: 'flyTo',
      animationDuration: 500,
    })
  }

  return (
    <Mapbox.MapView
      style={style}
      styleURL={styleUrl}
      logoEnabled={false}
      attributionEnabled={false}
      compassEnabled={false}
      scaleBarEnabled={false}
      zoomEnabled={true}
      scrollEnabled={true}
      rotateEnabled={false}
      pitchEnabled={false}
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
        centerCoordinate={toMapboxCoordinate({
          latitude: currentRegion.latitude,
          longitude: currentRegion.longitude,
        })}
        zoomLevel={initialRegion || region ? regionToZoom(currentRegion) : initialZoom}
      />
      {markers.map((marker) => (
        (() => {
          const isSelected = selectedCourtId != null && String(selectedCourtId) === String(marker.id)
          const isFavorite = marker.courtId != null && favoriteIdSet.has(marker.courtId)
          const tintColor = isSelected ? '#00FF00' : isFavorite ? '#FFD700' : '#FF6B00'

          return (
            <Mapbox.PointAnnotation
              key={String(marker.id)}
              id={String(marker.id)}
              coordinate={toMapboxCoordinate(marker.coordinate)}
              title={marker.title}
              onSelected={() => {
                flyToMarker(marker.coordinate)
                onMarkerPress?.(marker.id)
              }}
            >
              <Image
                source={require('../../assets/icons/map_markers.png')}
                style={{ width: 36, height: 36, resizeMode: 'contain', tintColor }}
              />
            </Mapbox.PointAnnotation>
          )
        })()
      ))}
    </Mapbox.MapView>
  )
}

export default DynamicMap