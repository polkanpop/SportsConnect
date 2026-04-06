/**
 * Voice preference hook — persists voice automation on/off toggle to AsyncStorage.
 * OFF by default (Beta feature).
 *
 * Multiple hook instances share state via module-level listeners,
 * so toggling in Settings immediately updates the provider + button.
 */

import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = '@voice_automation_enabled'

// Module-level shared state — keeps all hook instances in sync.
let _currentValue = false
const _listeners = new Set<(v: boolean) => void>()

function _broadcast(value: boolean) {
  _currentValue = value
  _listeners.forEach(fn => fn(value))
}

export function useVoicePreference() {
  const [enabled, setEnabledState] = useState(_currentValue)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    // Subscribe to cross-instance changes
    const listener = (v: boolean) => setEnabledState(v)
    _listeners.add(listener)

    // Read from storage on first mount (only the first instance actually triggers this)
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        const val = stored === 'true'
        _broadcast(val)
      })
      .catch(() => {})
      .finally(() => setIsReady(true))

    return () => { _listeners.delete(listener) }
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    _broadcast(next)
    AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(() => {})
  }, [])

  const toggle = useCallback(() => {
    const next = !_currentValue
    _broadcast(next)
    AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(() => {})
  }, [])

  return { enabled, setEnabled, toggle, isReady }
}
