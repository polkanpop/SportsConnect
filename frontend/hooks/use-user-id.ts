import { useAuthContext } from '@/hooks/use-auth-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import { debugIdentity } from '@/lib/backendApi'

async function resolveUserId(profile: any): Promise<number | null> {
  let local: number | null = null
  if (profile) {
    if (typeof profile.userid === 'number') {
      local = profile.userid
    } else if (typeof profile.userid === 'string' && profile.userid.trim()) {
      const parsed = Number(profile.userid)
      if (Number.isFinite(parsed)) local = parsed
    }
  }
  if (local == null) {
    try {
      const raw = await AsyncStorage.getItem('@backendProfile')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed) {
          if (typeof parsed.userid === 'number') {
            local = parsed.userid
          } else if (typeof parsed.userid === 'string' && parsed.userid.trim()) {
            const parsedId = Number(parsed.userid)
            if (Number.isFinite(parsedId)) local = parsedId
          }
        }
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
  const { profile, isLoggedIn, session } = useAuthContext()
  // Include auth-derived identity in key so login/logout transitions always trigger re-resolution.
  const profileIdKeyPart =
    typeof profile?.userid === 'number'
      ? profile.userid
      : (typeof profile?.userid === 'string' && profile.userid.trim() ? profile.userid.trim() : null)
  const authIdentityKeyPart = isLoggedIn
    ? (profileIdKeyPart ?? session?.user?.id ?? 'backend-auth')
    : 'logged-out'
  return useQuery({
    queryKey: [...queryKeys.userId, authIdentityKeyPart],
    queryFn: () => resolveUserId(profile),
    // Query key includes authIdentityKeyPart, so login/logout/account switches refetch immediately
    // while still avoiding continuous background traffic.
    staleTime: Infinity,
  })
}
