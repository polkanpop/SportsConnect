const { DarkTheme, DefaultTheme, ThemeProvider } = require('@react-navigation/native')
import { useFonts } from 'expo-font'
import {
  Montserrat_400Regular,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
} from '@expo-google-fonts/montserrat'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import React from 'react'
import { StyleSheet, Text, TextInput } from 'react-native'
import 'react-native-reanimated'
import './global.css'

import { SplashScreenController } from '@/components/splash-controller'
import QueryProvider from '@/providers/query-provider'

import { useAuthContext } from '@/hooks/use-auth-context'
import { useColorScheme } from '@/hooks/use-color-scheme'
import AuthProvider from '@/providers/auth-providers'

let hasAppliedGlobalFont = false

let hasPatchedCreateElement = false
let hasPatchedJsxRuntime = false

function patchGlobalFont() {
  if (hasPatchedCreateElement) return

  const pickFontFamily = (style: any) => {
    const flat = StyleSheet.flatten(style) || {}
    const weightRaw = flat?.fontWeight
    const weight = typeof weightRaw === 'string' ? parseInt(weightRaw, 10) : weightRaw
    if (weight && weight >= 700) return 'MontserratBold'
    if (weight && weight >= 600) return 'MontserratSemiBold'
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
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <QueryProvider>
        <AuthProvider>
          <SplashScreenController />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="+not-found" />
          </Stack>
          <StatusBar style="auto" />
        </AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  )
}