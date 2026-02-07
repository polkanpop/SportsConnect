import { getCache, setCache } from '@/lib/cache'

export type Coord = { latitude: number; longitude: number }

const USER_COORD_KEY = 'cache:userCoord:v1'
const USER_COORD_TTL_MS = 10 * 60 * 1000
const USER_COORD_SWR_MS = 10 * 60 * 1000

function isFiniteNumber(v: any): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function isValidCoord(v: any): v is Coord {
  return v && isFiniteNumber(v.latitude) && isFiniteNumber(v.longitude)
}

export async function getCachedUserCoord(): Promise<Coord | null> {
  const v = await getCache<Coord>(USER_COORD_KEY)
  return isValidCoord(v) ? v : null
}

export async function setCachedUserCoord(coord: Coord): Promise<void> {
  if (!isValidCoord(coord)) return
  await setCache(USER_COORD_KEY, coord, USER_COORD_TTL_MS, USER_COORD_SWR_MS)
}
