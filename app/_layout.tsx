const { DarkTheme, DefaultTheme, ThemeProvider } = require('@react-navigation/native')
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import './global.css'

import { SplashScreenController } from '@/components/splash-controller'
import { backendHealth } from '@/lib/backendApi'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import { useAuthContext } from '@/hooks/use-auth-context'
import { useColorScheme } from '@/hooks/use-color-scheme'
import AuthProvider from '@/providers/auth-providers'

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const { isLoggedIn } = useAuthContext()

  const [loaded] = useFonts({
    SpaceMono: require('../assets/icons/import_icons/SpaceMono-Regular.ttf'),
  })
  // Hooks must not be conditional: declare all before any early return.
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  useEffect(() => {
    let mounted = true
    const check = async () => {
      try {
        const h = await backendHealth()
        if (mounted) setBackendOk(h.status === 'ok')
      } catch {
        if (mounted) setBackendOk(false)
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  if (!loaded) {
    return null
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <SplashScreenController />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="+not-found" />
        </Stack>
        <StatusBar style="auto" />
        {backendOk === false && (
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#dc2626', padding: 8 }}>
            <Text style={{ color: 'white', textAlign: 'center', fontWeight: '600' }}>Backend unreachable. Some features may be limited.</Text>
          </View>
        )}
      </AuthProvider>
    </ThemeProvider>
  )
}