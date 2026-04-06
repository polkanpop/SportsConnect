import { useState, useEffect, useCallback } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = '@pushNotificationEnabled'

// Module-level shared state so all consumers stay in sync.
let _enabled = true
const _listeners = new Set<(v: boolean) => void>()

function _notify(v: boolean) {
  _enabled = v
  _listeners.forEach(fn => fn(v))
}

/** Read-only getter usable outside React (e.g. in usePushNotifications hook). */
export function getPushNotificationEnabled(): boolean {
  return _enabled
}

export function usePushNotificationPreference() {
  const [enabled, setLocal] = useState(_enabled)

  useEffect(() => {
    // Hydrate from AsyncStorage on first mount.
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw !== null) {
        const v = raw === 'true'
        _enabled = v
        setLocal(v)
      }
    }).catch(() => {})

    const handler = (v: boolean) => setLocal(v)
    _listeners.add(handler)
    return () => { _listeners.delete(handler) }
  }, [])

  const setEnabled = useCallback((v: boolean) => {
    _notify(v)
    AsyncStorage.setItem(STORAGE_KEY, String(v)).catch(() => {})
  }, [])

  return { enabled, setEnabled }
}
