import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import { listFavouriteCourts, addFavouriteCourt, removeFavouriteCourt, FavouriteCourt } from '@/lib/backendApi'

// Fetch favourite courts (full objects or ids only)
export function useFavouriteCourts(userid: number | null, idsOnly?: boolean) {
  return useQuery({
    queryKey: queryKeys.favouriteCourts(userid, !!idsOnly),
    queryFn: () => {
      if (userid == null) return idsOnly ? [] : []
      return listFavouriteCourts({ userid, idsOnly })
    },
    enabled: userid != null,
    staleTime: 30 * 1000,
  })
}

// Optimistic add favourite court
export function useAddFavouriteCourt(userid: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (courtid: number) => {
      if (userid == null) throw new Error('userid required')
      return addFavouriteCourt(userid, courtid)
    },
    onMutate: async (courtid: number) => {
      if (userid == null) return
      // Cancel both queries (ids and full) for this user
      await qc.cancelQueries({ queryKey: queryKeys.favouriteCourts(userid, false) })
      await qc.cancelQueries({ queryKey: queryKeys.favouriteCourts(userid, true) })
      const fullKey = queryKeys.favouriteCourts(userid, false)
      const idsKey = queryKeys.favouriteCourts(userid, true)
      const prevFull = qc.getQueryData<FavouriteCourt[]>(fullKey) || []
      const prevIds = qc.getQueryData<number[]>(idsKey) || []
      const optimisticFav: FavouriteCourt = { favouriteid: -Date.now(), userid, courtid }
      qc.setQueryData(fullKey, [...prevFull, optimisticFav])
      qc.setQueryData(idsKey, [...prevIds, courtid])
      return { prevFull, prevIds }
    },
    onError: (_err, _courtid, ctx) => {
      if (userid == null || !ctx) return
      qc.setQueryData(queryKeys.favouriteCourts(userid, false), ctx.prevFull)
      qc.setQueryData(queryKeys.favouriteCourts(userid, true), ctx.prevIds)
    },
    onSuccess: (created, courtid) => {
      if (userid == null) return
      // Replace optimistic entry with real one in full list
      const fullKey = queryKeys.favouriteCourts(userid, false)
      qc.setQueryData<FavouriteCourt[]>(fullKey, (current = []) => {
        return current.map(f => f.favouriteid < 0 && f.courtid === courtid ? created : f)
      })
      // Ensure ids list has the courtid
      qc.setQueryData<number[]>(queryKeys.favouriteCourts(userid, true), (ids = []) => {
        return ids.includes(courtid) ? ids : [...ids, courtid]
      })
    },
    onSettled: () => {
      if (userid == null) return
      qc.invalidateQueries({ queryKey: queryKeys.favouriteCourts(userid, false) })
      qc.invalidateQueries({ queryKey: queryKeys.favouriteCourts(userid, true) })
    },
  })
}

// Optimistic remove favourite court by favouriteid
export function useRemoveFavouriteCourt(userid: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (fav: { favouriteid: number; courtid: number }) => {
      return removeFavouriteCourt(fav.favouriteid)
    },
    onMutate: async (fav) => {
      if (userid == null) return
      await qc.cancelQueries({ queryKey: queryKeys.favouriteCourts(userid, false) })
      await qc.cancelQueries({ queryKey: queryKeys.favouriteCourts(userid, true) })
      const fullKey = queryKeys.favouriteCourts(userid, false)
      const idsKey = queryKeys.favouriteCourts(userid, true)
      const prevFull = qc.getQueryData<FavouriteCourt[]>(fullKey) || []
      const prevIds = qc.getQueryData<number[]>(idsKey) || []
      qc.setQueryData(fullKey, prevFull.filter(f => f.favouriteid !== fav.favouriteid))
      qc.setQueryData(idsKey, prevIds.filter(id => id !== fav.courtid))
      return { prevFull, prevIds }
    },
    onError: (_err, fav, ctx) => {
      if (userid == null || !ctx) return
      qc.setQueryData(queryKeys.favouriteCourts(userid, false), ctx.prevFull)
      qc.setQueryData(queryKeys.favouriteCourts(userid, true), ctx.prevIds)
    },
    onSettled: () => {
      if (userid == null) return
      qc.invalidateQueries({ queryKey: queryKeys.favouriteCourts(userid, false) })
      qc.invalidateQueries({ queryKey: queryKeys.favouriteCourts(userid, true) })
    },
  })
}
