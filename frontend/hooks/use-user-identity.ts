import { useQuery } from '@tanstack/react-query'
import { getMyIdentityCached, UserInfoRow } from '@/lib/backendApi'
import { queryKeys } from '@/hooks/query-keys'

export function useUserIdentity(userid: number | null) {
  return useQuery<UserInfoRow | null>({
    queryKey: queryKeys.userInfo(userid),
    queryFn: () => getMyIdentityCached(userid as number),
    enabled: typeof userid === 'number',
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
}
