import { useQuery } from '@tanstack/react-query'
import { getUserInfoByUserId, UserInfoRow } from '@/lib/backendApi'
import { queryKeys } from './query-keys'

export function useUserInfo(userid: number | null) {
  return useQuery<UserInfoRow | null>({
    queryKey: queryKeys.userInfo(userid),
    queryFn: () => {
      if (userid == null) return null
      return getUserInfoByUserId(userid)
    },
    enabled: userid != null,
    staleTime: 2 * 60 * 1000,
  })
}
