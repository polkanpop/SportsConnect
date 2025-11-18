import { AuthContext } from '@/hooks/use-auth-context'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'
import { PropsWithChildren, useEffect, useState, useRef } from 'react'
import { AUTO_EMAIL_LOGIN } from '@/env'
import { AppState } from 'react-native'
import { authSessionClose } from '@/lib/backendApi'
import AsyncStorage from '@react-native-async-storage/async-storage'

export default function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | undefined | null>()
  const [profile, setProfile] = useState<any>()
  const [isLoadingSupabase, setIsLoadingSupabase] = useState<boolean>(true)
  const [isLoadingRemember, setIsLoadingRemember] = useState<boolean>(true)
  const [rememberProfile, setRememberProfile] = useState<any | null>(null)
  const [rememberFlag, setRememberFlag] = useState<boolean>(false)
  const [backendAuthPresent, setBackendAuthPresent] = useState<boolean>(false)

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

  // --- Backend "remember me" bootstrap ---
  useEffect(() => {
    const loadRemember = async () => {
      try {
        const flag = await AsyncStorage.getItem('@rememberAuth')
        const rawProfile = await AsyncStorage.getItem('@backendProfile')
        const rawBackendAuth = await AsyncStorage.getItem('@backendAuth')
        setBackendAuthPresent(!!rawBackendAuth)
        if (flag === 'true' && rawProfile) {
          setRememberFlag(true)
          try { setRememberProfile(JSON.parse(rawProfile)) } catch { setRememberProfile(null) }
        } else {
          setRememberFlag(false)
          setRememberProfile(null)
        }
      } catch (e) {
        console.warn('[AuthProvider] failed loading remember auth', (e as any)?.message)
      } finally {
        setIsLoadingRemember(false)
      }
    }
    loadRemember()
  }, [])

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

  // --- AppState listener to enforce remember-me closure semantics ---
  const mountedAtRef = useRef<number>(Date.now())
  useEffect(() => {
    if (isLoadingRemember) return
    const handler = async (state: string) => {
      if (state === 'background' || state === 'inactive') {
        const elapsed = Date.now() - mountedAtRef.current
        // Debounce very early transitions (e.g., opening mail app during signup) and skip if no auth yet
        try {
          const rawAuth = await AsyncStorage.getItem('@backendAuth')
          if (!rawAuth) return
          if (elapsed < 5000) return // ignore first 5s
          const flag = await AsyncStorage.getItem('@rememberAuth')
          const remember = flag === 'true'
          await authSessionClose(remember)
        } catch (e) {
          console.warn('[AuthProvider] app close handler error', (e as any)?.message)
        }
      }
    }
    const sub = AppState.addEventListener('change', handler)
    return () => { sub.remove() }
  }, [isLoadingRemember])

  return (
    <AuthContext.Provider value={{ session, isLoading, profile: exposedProfile, isLoggedIn }}>
      {children}
    </AuthContext.Provider>
  )
}