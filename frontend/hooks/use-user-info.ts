import { UserInfoRow } from '@/lib/backendApi'
import { useUserIdentity } from './use-user-identity'

export function useUserInfo(userid: number | null) {
  const q = useUserIdentity(userid)
  return {
    ...q,
    data: (q.data ?? null) as UserInfoRow | null,
  }
}
