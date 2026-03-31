/**
 * Language provider — persists 'en' | 'vi' choice to AsyncStorage.
 * Wrap the app root with <LanguageProvider> to enable i18n.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type Language = 'en' | 'vi'

const STORAGE_KEY = '@lang'

interface LanguageContextValue {
  lang: Language
  toggleLanguage: () => void
  setLanguage: (lang: Language) => void
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'en',
  toggleLanguage: () => {},
  setLanguage: () => {},
})

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>('en')

  // Load persisted preference once on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'en' || stored === 'vi') {
          setLangState(stored)
        }
      })
      .catch(() => {/* ignore read errors, fall back to 'en' */})
  }, [])

  const setLanguage = useCallback((next: Language) => {
    setLangState(next)
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
  }, [])

  const toggleLanguage = useCallback(() => {
    setLangState((prev) => {
      const next: Language = prev === 'en' ? 'vi' : 'en'
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
      return next
    })
  }, [])

  return (
    <LanguageContext.Provider value={{ lang, toggleLanguage, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext)
}
