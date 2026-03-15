import { AuthContext } from '@/hooks/use-auth-context'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'
import { PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react'
import { AUTO_EMAIL_LOGIN } from '@/env'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

export default function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | undefined | null>()
  const [profile, setProfile] = useState<any>()
  const [isLoadingSupabase, setIsLoadingSupabase] = useState<boolean>(true)
  const [isLoadingRemember, setIsLoadingRemember] = useState<boolean>(true)
  const [rememberProfile, setRememberProfile] = useState<any | null>(null)
  const [rememberFlag, setRememberFlag] = useState<boolean>(false)
  const [backendAuthPresent, setBackendAuthPresent] = useState<boolean>(false)

  const backendSnapshotRef = useRef<{
    rememberAuth: string | null
    backendProfile: string | null
    backendAuth: string | null
    localAuthToken: string | null
  }>({
    rememberAuth: null,
    backendProfile: null,
    backendAuth: null,
    localAuthToken: null,
  })

  const didBootstrapRememberRef = useRef<boolean>(false)

  const applyBackendRememberSnapshot = useCallback((snap: {
    rememberAuth: string | null
    backendProfile: string | null
    backendAuth: string | null
    localAuthToken: string | null
  }) => {
    backendSnapshotRef.current = snap
    const nextBackendAuthPresent = !!snap.backendAuth || !!snap.localAuthToken
    setBackendAuthPresent(nextBackendAuthPresent)

    const nextRememberFlag = snap.rememberAuth === 'true'
    setRememberFlag(nextRememberFlag)

    if (nextRememberFlag && snap.backendProfile) {
      try {
        setRememberProfile(JSON.parse(snap.backendProfile))
      } catch {
        setRememberProfile(null)
      }
    } else {
      setRememberProfile(null)
    }
  }, [])

  const refreshBackendRemember = useCallback(async (opts?: { setLoading?: boolean }) => {
    const setLoading = !!opts?.setLoading
    if (setLoading) setIsLoadingRemember(true)
    try {
      const pairs = await AsyncStorage.multiGet(['@rememberAuth', '@backendProfile', '@backendAuth', '@localAuthToken'])
      const nextSnap = {
        rememberAuth: pairs[0]?.[1] ?? null,
        backendProfile: pairs[1]?.[1] ?? null,
        backendAuth: pairs[2]?.[1] ?? null,
        localAuthToken: pairs[3]?.[1] ?? null,
      }
      applyBackendRememberSnapshot(nextSnap)
    } catch (e) {
      console.warn('[AuthProvider] failed loading remember auth', (e as any)?.message)
    } finally {
      if (setLoading) setIsLoadingRemember(false)
    }
  }, [applyBackendRememberSnapshot])

  // --- Supabase session bootstrap & subscription ---
  useEffect(() => {
    const fetchSession = async () => {
      setIsLoadingSupabase(true)
      const { data: { session }, error } = await supabase.auth.getSession()
      if (error) console.error('Error fetching session:', error)
      setSession(session)
      setIsLoadingSupabase(false)
    }
    fetchSession()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      console.log('[AuthProvider] Auth state changed:', { event: _event, session })
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  // --- Backend "remember me" bootstrap & refresh ---
  useEffect(() => {
    refreshBackendRemember({ setLoading: true }).finally(() => {
      didBootstrapRememberRef.current = true
    })
  }, [refreshBackendRemember])

  // Keep backend remember/profile in sync when app comes to foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refreshBackendRemember()
      }
    })
    return () => { sub.remove() }
  }, [refreshBackendRemember])

  // Lightweight polling to avoid cross-account stale profile in long-lived providers.
  useEffect(() => {
    // Only relevant for backend-auth path (no supabase session)
    if (session) return
    if (!didBootstrapRememberRef.current) return

    let cancelled = false
    const tick = async () => {
      try {
        const pairs = await AsyncStorage.multiGet(['@rememberAuth', '@backendProfile', '@backendAuth', '@localAuthToken'])
        const nextSnap = {
          rememberAuth: pairs[0]?.[1] ?? null,
          backendProfile: pairs[1]?.[1] ?? null,
          backendAuth: pairs[2]?.[1] ?? null,
          localAuthToken: pairs[3]?.[1] ?? null,
        }
        const prev = backendSnapshotRef.current
        const changed =
          prev.rememberAuth !== nextSnap.rememberAuth ||
          prev.backendProfile !== nextSnap.backendProfile ||
          prev.backendAuth !== nextSnap.backendAuth ||
          prev.localAuthToken !== nextSnap.localAuthToken
        if (!cancelled && changed) {
          applyBackendRememberSnapshot(nextSnap)
        }
      } catch {
        // ignore polling errors
      }
    }

    // Run once quickly, then poll.
    tick()
    const id = setInterval(tick, 1500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [applyBackendRememberSnapshot, session])

  // --- Supabase profile fetch (only if supabase session present) ---
  useEffect(() => {
    const fetchProfile = async () => {
      // Only show supabase loading spinner portion when supabase path engaged
      if (!session) { setProfile(null); return }
      try {
        const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single()
        setProfile(data)
      } catch (e) {
        console.error('[AuthProvider] profile fetch error', e)
        setProfile(null)
      }
    }
    fetchProfile()
  }, [session])

  // Unified loading & logged-in derivation
  const isLoading = isLoadingSupabase || isLoadingRemember
  // Treat backendAuth presence as logged-in if rememberFlag OR explicit token presence (auto-login)
  const isLoggedIn = (!!session) || rememberFlag || backendAuthPresent
  // Exposed composite profile preference: supabase profile if present else remembered backend profile
  const exposedProfile = session ? profile : rememberProfile

  return (
    <AuthContext.Provider value={{ session, isLoading, profile: exposedProfile, isLoggedIn }}>
      {children}
    </AuthContext.Provider>
  )
}