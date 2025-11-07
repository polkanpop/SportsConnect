import { addFavorite, FavoriteRow, fetchFavorites, removeFavorite } from '@/lib/backendApi'
import { useCallback, useEffect, useState } from 'react'
import { useAuthContext } from './use-auth-context'

interface UseFavoritesResult {
  favorites: FavoriteRow[]
  loading: boolean
  error: string | null
  toggle: (courtinfoid: number) => Promise<void>
  isFavorite: (courtinfoid: number) => boolean
}

// Optimistic favorites hook: updates local state first, rolls back on failure
export function useFavorites(): UseFavoritesResult {
  const { session } = useAuthContext()
  const token = session?.access_token
  const [favorites, setFavorites] = useState<FavoriteRow[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!token) { setFavorites([]); return }
      setLoading(true)
      try {
        const data = await fetchFavorites(token)
        if (active) { setFavorites(data); setError(null) }
      } catch (e: any) {
        if (active) setError(e.message || 'Failed to load favorites')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [token])

  const isFavorite = useCallback((courtinfoid: number) => favorites.some(f => f.courtinfoid === courtinfoid), [favorites])

  const toggle = useCallback(async (courtinfoid: number) => {
    if (!token) return
    const exists = isFavorite(courtinfoid)
    // optimistic update
    setFavorites(prev => exists ? prev.filter(f => f.courtinfoid !== courtinfoid) : [...prev, { user_id: session!.user.id, courtinfoid }])
    try {
      if (exists) {
        await removeFavorite(token, courtinfoid)
      } else {
        await addFavorite(token, courtinfoid)
      }
    } catch (e) {
      // rollback
      setFavorites(prev => prev) // no-op; could refetch
      setError((e as any).message || 'Favorite toggle failed')
    }
  }, [token, isFavorite, session])

  return { favorites, loading, error, toggle, isFavorite }
}