/**
 * Theme provider — persists 'light' | 'dark' choice to AsyncStorage.
 * Wrap the app root with <AppThemeProvider> to enable dark mode.
 * Default theme is 'light'.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = '@theme_mode'

interface ThemeContextValue {
  theme: ThemeMode
  isDark: boolean
  isReady: boolean
  toggleTheme: () => void
  setTheme: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  isDark: false,
  isReady: false,
  toggleTheme: () => {},
  setTheme: () => {},
})

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>('light')
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark') {
          setThemeState(stored)
        }
      })
      .catch(() => {})
      .finally(() => setIsReady(true))
  }, [])

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next)
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light'
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
      return next
    })
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, isDark: theme === 'dark', isReady, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
