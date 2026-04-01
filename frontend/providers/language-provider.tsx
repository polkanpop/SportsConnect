/**
 * Language provider — persists 'en' | 'vi' choice to AsyncStorage.
 * Wrap the app root with <LanguageProvider> to enable i18n.
 * Default language is Vietnamese ('vi').
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type Language = 'en' | 'vi'

const STORAGE_KEY = 'language'

interface LanguageContextValue {
  language: Language
  /** @deprecated use language instead of lang */
  lang: Language
  isReady: boolean
  toggleLanguage: () => void
  setLanguage: (lang: Language) => void
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'vi',
  lang: 'vi',
  isReady: false,
  toggleLanguage: () => {},
  setLanguage: () => {},
})

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLangState] = useState<Language>('vi')
  const [isReady, setIsReady] = useState(false)

  // Load persisted preference once on mount, then mark ready
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'en' || stored === 'vi') {
          setLangState(stored)
        }
      })
      .catch(() => {/* ignore read errors, fall back to 'vi' */})
      .finally(() => setIsReady(true))
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
    <LanguageContext.Provider value={{ language, lang: language, isReady, toggleLanguage, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext)
}
