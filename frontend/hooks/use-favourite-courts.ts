import { useQuery } from '@tanstack/react-query'
import { FavouriteCourt, listFavouriteCourtsCached } from '@/lib/backendApi'
import { queryKeys } from '@/hooks/query-keys'

export function useFavouriteCourts(userid: number | null) {
  return useQuery<FavouriteCourt[]>({
    queryKey: queryKeys.favouriteCourts(userid, false),
    queryFn: async () => {
      const rows = await listFavouriteCourtsCached({ userid: userid as number })
      return Array.isArray(rows)
        ? (rows as any[]).filter((r) => typeof r === 'object' && r != null && 'courtid' in r) as FavouriteCourt[]
        : []
    },
    enabled: typeof userid === 'number',
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
}
