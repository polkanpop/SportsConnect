export type MapCoordinate = {
  latitude: number
  longitude: number
}

export type MapRegion = MapCoordinate & {
  latitudeDelta: number
  longitudeDelta: number
}

export function buildGoongStyleUrl(apiKey: string) {
  const key = apiKey.trim()
  if (!key) return ''
  return `https://tiles.goong.io/assets/goong_map_web.json?api_key=${encodeURIComponent(key)}`
}

export function regionToZoom(region: Pick<MapRegion, 'longitudeDelta'>) {
  const lngDelta = Math.max(region.longitudeDelta || 0, 0.0001)
  const zoom = Math.log2(360 / lngDelta)
  return Math.max(0, Math.min(20, zoom))
}

export function zoomToRegion(center: MapCoordinate, zoom: number): MapRegion {
  const clampedZoom = Math.max(0, Math.min(20, zoom))
  const longitudeDelta = 360 / Math.pow(2, clampedZoom)
  const latitudeDelta = longitudeDelta * 0.6
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    latitudeDelta,
    longitudeDelta,
  }
}