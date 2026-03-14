import { useQuery } from '@tanstack/react-query'
import { getDashboard, DashboardResponse } from '@/lib/backendApi'

/**
 * Fetches all startup data for the authenticated user in a single request.
 *
 * The backend resolves the userid from the JWT subject, so no param is needed.
 * Pass the numeric userid only to key the cache correctly — the actual fetch
 * does not include it as a query param (the bearer token is authoritative).
 *
 * staleTime: 5 minutes — short enough to stay reasonably fresh, long enough
 * to avoid re-fetching on every tab focus.
 */
export function useDashboard(userid: number | null, options?: { enabled?: boolean }) {
  const key = ['dashboard', userid ?? -1] as const
  const enabledByUser = typeof userid === 'number'
  const enabled = enabledByUser && (options?.enabled ?? true)
  return useQuery<DashboardResponse>({
    queryKey: key,
    queryFn: () => getDashboard(),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
}
