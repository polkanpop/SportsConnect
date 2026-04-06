/**
 * Voice preference hook — persists voice automation on/off toggle to AsyncStorage.
 * OFF by default (Beta feature).
 */

import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = '@voice_automation_enabled'

export function useVoicePreference() {
  const [enabled, setEnabledState] = useState(false)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'true') setEnabledState(true)
      })
      .catch(() => {})
      .finally(() => setIsReady(true))
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next)
    AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(() => {})
  }, [])

  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev
      AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(() => {})
      return next
    })
  }, [])

  return { enabled, setEnabled, toggle, isReady }
}
