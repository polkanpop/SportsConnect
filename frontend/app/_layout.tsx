const { DarkTheme, DefaultTheme, ThemeProvider } = require('@react-navigation/native')
import { useFonts } from 'expo-font'
import {
  Montserrat_400Regular,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
} from '@expo-google-fonts/montserrat'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Updates from 'expo-updates'
import * as Location from 'expo-location'
import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { useEffect } from 'react'
import { StyleSheet, Text, TextInput } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import 'react-native-reanimated'
import './global.css'

import { SplashScreenController } from '@/components/splash-controller'
import QueryProvider from '@/providers/query-provider'
import { AppBootstrapProvider } from '@/providers/app-bootstrap-provider'
import { LanguageProvider } from '@/providers/language-provider'

import { useAuthContext } from '@/hooks/use-auth-context'
import { useColorScheme } from '@/hooks/use-color-scheme'
import { usePushNotifications } from '@/hooks/use-push-notifications'
import AuthProvider from '@/providers/auth-providers'

/**
 * Registers the device push token after the user logs in.
 * Must sit inside AuthProvider so useAuthContext() resolves correctly.
 */
function PushRegistrar() {
  const { isLoggedIn } = useAuthContext()
  usePushNotifications(isLoggedIn)
  // Request location permission on first render so map loads without a blackout
  useEffect(() => {
    Location.requestForegroundPermissionsAsync().catch(() => {})
  }, [])
  return null
}

let hasAppliedGlobalFont = false

let hasPatchedCreateElement = false
let hasPatchedJsxRuntime = false

function patchGlobalFont() {
  if (hasPatchedCreateElement) return

  const pickFontFamily = (style: any) => {
    const flat = StyleSheet.flatten(style) || {}
    const weightRaw = flat?.fontWeight

    let weight: number | null = null
    if (typeof weightRaw === 'number' && Number.isFinite(weightRaw)) {
      weight = weightRaw
    } else if (typeof weightRaw === 'string') {
      const normalized = weightRaw.trim().toLowerCase()
      if (normalized === 'bold') weight = 700
      else if (normalized === 'normal') weight = 400
      else if (/^\d+$/.test(normalized)) {
        const parsed = parseInt(normalized, 10)
        weight = Number.isFinite(parsed) ? parsed : null
      }
    }

    if (weight != null && weight >= 700) return 'MontserratBold'
    if (weight != null && weight >= 600) return 'MontserratSemiBold'
    return 'MontserratRegular'
  }

  const injectStyle = (props: any) => {
    const originStyle = props?.style
    const fontFamily = pickFontFamily(originStyle)
    return {
      ...props,
      style: [originStyle, { fontFamily, fontWeight: 'normal' }],
    }
  }

  // Patch the automatic JSX runtime (most Expo/RN projects).
  // JSX compiles to jsx/jsxs calls, not React.createElement.
  if (!hasPatchedJsxRuntime) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jsxRuntime = require('react/jsx-runtime')
      if (jsxRuntime?.jsx && !jsxRuntime.__MontserratPatched) {
        const origJsx = jsxRuntime.jsx
        const origJsxs = jsxRuntime.jsxs

        jsxRuntime.jsx = (type: any, props: any, key: any) => {
          if (type === Text || type === TextInput) return origJsx(type, injectStyle(props), key)
          return origJsx(type, props, key)
        }

        if (typeof origJsxs === 'function') {
          jsxRuntime.jsxs = (type: any, props: any, key: any) => {
            if (type === Text || type === TextInput) return origJsxs(type, injectStyle(props), key)
            return origJsxs(type, props, key)
          }
        }

        jsxRuntime.__MontserratPatched = true
      }
    } catch {
      // ignore
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jsxDevRuntime = require('react/jsx-dev-runtime')
      if (jsxDevRuntime?.jsxDEV && !jsxDevRuntime.__MontserratPatched) {
        const origJsxDEV = jsxDevRuntime.jsxDEV
        jsxDevRuntime.jsxDEV = (type: any, props: any, key: any, isStatic: any, source: any, self: any) => {
          if (type === Text || type === TextInput) return origJsxDEV(type, injectStyle(props), key, isStatic, source, self)
          return origJsxDEV(type, props, key, isStatic, source, self)
        }
        jsxDevRuntime.__MontserratPatched = true
      }
    } catch {
      // ignore
    }

    hasPatchedJsxRuntime = true
  }

  const originalCreateElement = React.createElement

  ;(React as any).createElement = function patchedCreateElement(type: any, props: any, ...children: any[]) {
    if (type === Text || type === TextInput) {
      return originalCreateElement(type, injectStyle(props), ...children)
    }
    return originalCreateElement(type, props, ...children)
  }

  hasPatchedCreateElement = true
}

export default function RootLayout() {
  const colorScheme = useColorScheme()
  useAuthContext()

  // Check for OTA updates on every cold start.
  // Guard: track the last update group ID we tried. If it fails (incompatible fingerprint),
  // we skip re-downloading it so we don't loop forever.
  useEffect(() => {
    if (__DEV__) return
    ;(async () => {
      try {
        const update = await Updates.checkForUpdateAsync()
        if (!update.isAvailable) return
        // Read the last failed update group to avoid infinite incompatibility loop
        const lastFailed = await AsyncStorage.getItem('@ota:lastFailed').catch(() => null)
        const updateId: string = (update as any)?.manifest?.id ?? (update as any)?.updateId ?? ''
        if (updateId && updateId === lastFailed) {
          console.warn('[OTA] Skipping previously incompatible update:', updateId)
          return
        }
        try {
          await Updates.fetchUpdateAsync()
          await Updates.reloadAsync()
        } catch (applyErr: any) {
          // Mark this update as failed to prevent the incompatibility loop
          if (updateId) {
            await AsyncStorage.setItem('@ota:lastFailed', updateId).catch(() => {})
          }
          console.warn('[OTA] Apply failed (possibly incompatible fingerprint):', applyErr)
        }
      } catch (e) {
        console.warn('[OTA] Update check failed:', e)
      }
    })()
  }, [])

  const [loaded] = useFonts({
    SpaceMono: require('../assets/icons/import_icons/SpaceMono-Regular.ttf'),
    MontserratRegular: Montserrat_400Regular,
    MontserratSemiBold: Montserrat_600SemiBold,
    MontserratBold: Montserrat_700Bold,
  })

  if (!loaded) {
    // Async font loading only occurs in development.
    return null
  }

  if (!hasAppliedGlobalFont) {
    patchGlobalFont()

    hasAppliedGlobalFont = true
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <LanguageProvider>
          <QueryProvider>
            <AuthProvider>
              <PushRegistrar />
              <AppBootstrapProvider>
                <SplashScreenController />
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="+not-found" />
                </Stack>
                <StatusBar style="auto" />
              </AppBootstrapProvider>
            </AuthProvider>
          </QueryProvider>
        </LanguageProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  )
}