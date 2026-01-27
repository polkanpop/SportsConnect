import { useAuthContext } from '@/hooks/use-auth-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import { debugIdentity } from '@/lib/backendApi'

async function resolveUserId(profile: any): Promise<number | null> {
  let local: number | null = null
  if (profile && typeof profile.userid === 'number') local = profile.userid
  if (local == null) {
    try {
      const raw = await AsyncStorage.getItem('@backendProfile')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.userid === 'number') local = parsed.userid
      }
    } catch {}
  }

  // If we already have a backend userid locally, avoid network calls.
  if (local != null) return local

  // Last resort: ask backend who we are (may fail/hang; backendApi adds a timeout).
  try {
    const dbg = await debugIdentity()
    const numericSubject = dbg?.numeric_subject ?? null
    if (numericSubject != null) return numericSubject
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
    staleTime: 0,
  })
}
