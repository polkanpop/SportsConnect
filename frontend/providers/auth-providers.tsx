import { AuthContext } from '@/hooks/use-auth-context'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'
import { PropsWithChildren, useEffect, useState } from 'react'
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
  const isLoggedIn = (!!session) || rememberFlag
  // Exposed composite profile preference: supabase profile if present else remembered backend profile
  const exposedProfile = session ? profile : rememberProfile

  // --- AppState listener to enforce remember-me closure semantics ---
  useEffect(() => {
    // Only attach if we have finished loading remember flag
    if (isLoadingRemember) return
    const handler = async (state: string) => {
      if (state === 'background' || state === 'inactive') {
        try {
          // Determine remember flag dynamically (storage may have changed)
          const flag = await AsyncStorage.getItem('@rememberAuth')
          const remember = flag === 'true'
          // Call backend to update last_used_at or revoke token
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