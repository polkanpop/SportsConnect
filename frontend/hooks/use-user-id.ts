import { useAuthContext } from '@/hooks/use-auth-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'

async function resolveUserId(profile: any): Promise<number | null> {
  if (profile && typeof profile.userid === 'number') return profile.userid
  try {
    const raw = await AsyncStorage.getItem('@backendProfile')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.userid === 'number') return parsed.userid
    }
  } catch {}
  return null
}

export function useUserId() {
  const { profile } = useAuthContext()
  // Include profile.userid in key so switching accounts triggers immediate fresh resolution
  const profileIdKeyPart = typeof profile?.userid === 'number' ? profile.userid : null
  return useQuery({
    queryKey: [...queryKeys.userId, profileIdKeyPart],
    queryFn: () => resolveUserId(profile),
    staleTime: 0, // force immediate re-evaluation on key change
  })
}
