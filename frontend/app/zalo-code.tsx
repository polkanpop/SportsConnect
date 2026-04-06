/**
 * Deep-link landing route for Zalo OAuth callback.
 *
 * When Zalo OAuth redirects to `sportconnect://zalo-code?code=…`,
 * the actual code is captured by Linking event listeners in
 * accountSettings.tsx and zalo-sign-in-button.tsx.
 *
 * However, Expo Router also processes the deep link as a navigation URL
 * and tries to navigate to /zalo-code.  Without this file, it would land
 * on +not-found.tsx (black screen in dark mode) and get stuck forever.
 *
 * This route renders nothing visible and immediately navigates back so the
 * user returns to their previous screen (accountSettings or auth).
 */
import { useEffect } from 'react'
import { View } from 'react-native'
import { Stack, useRouter } from 'expo-router'

export default function ZaloCodeLanding() {
  const router = useRouter()

  useEffect(() => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }, [router])

  return (
    <>
      <Stack.Screen options={{ headerShown: false, animation: 'none' }} />
      <View style={{ flex: 1, backgroundColor: '#fff' }} />
    </>
  )
}
