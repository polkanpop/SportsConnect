/**
 * usePushNotifications
 *
 * Handles the full push-notification lifecycle:
 *   1. Requests OS-level notification permission on first use.
 *   2. Retrieves the Expo Push Token (routes through Expo → FCM/APNs).
 *   3. Syncs the token to the backend /api/devices/register-token endpoint
 *      so the server can target this device when sending notifications.
 *   4. Sets up a foreground listener (notification arrives while app is open).
 *   5. Sets up a response listener (user taps a notification from any app state).
 *
 * Usage:
 *   Call with `enabled = true` only after the user is authenticated.
 *   Place it inside the AuthProvider tree so useAuthContext() is available.
 */

import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { registerDeviceToken } from '@/lib/backendApi'
import { getPushNotificationEnabled } from '@/hooks/use-push-notification-preference'

// ─── Global foreground handler ─────────────────────────────────────────────────
// Must be configured at module level (outside any component) for Expo to pick it up.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is deprecated in SDK 54+; use shouldShowBanner + shouldShowList instead.
    shouldShowBanner: true,   // shows the notification banner at the top of the screen
    shouldShowList:   true,   // adds the notification to the notification centre list
    shouldPlaySound:  true,
    shouldSetBadge:   false,
  }),
})

// ─── Android notification channel ─────────────────────────────────────────────
// Android 8+ requires at least one channel; create it once per app launch.
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('default', {
    name: 'SportConnect',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF6017',
    showBadge: true,
  })
}

// ─── Core token acquisition ───────────────────────────────────────────────────
async function acquireExpoPushToken(): Promise<string | null> {
  // Expo Push Tokens only work on physical hardware.
  if (!Device.isDevice) {
    console.warn('[PushNotifications] Requires a physical device.')
    return null
  }

  await ensureAndroidChannel()

  // Check current permission state before prompting.
  const { status: currentStatus } = await Notifications.getPermissionsAsync()
  const { status: finalStatus } =
    currentStatus === 'granted'
      ? { status: currentStatus }
      : await Notifications.requestPermissionsAsync()

  if (finalStatus !== 'granted') {
    console.warn('[PushNotifications] Permission not granted — status:', finalStatus)
    return null
  }

  // projectId is required in bare/EAS workflow (SDK 50+).
  // Value comes from app.json > extra.eas.projectId (set via eas.json or eas build).
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId

  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  )

  return token // e.g. "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PushState {
  /** The Expo Push Token for this device, or null if unavailable / permission denied. */
  expoPushToken: string | null
  /** The most recently received notification (foreground only). */
  lastNotification: Notifications.Notification | null
  /** OS-level permission status ('granted' | 'denied' | 'undetermined'). */
  permissionStatus: Notifications.PermissionStatus | null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function usePushNotifications(
  /**
   * Pass `true` only when the user is authenticated.
   * Token registration is a no-op while false, preventing anonymous token saves.
   */
  enabled: boolean = false,
): PushState {
  const [expoPushToken, setExpoPushToken]       = useState<string | null>(null)
  const [lastNotification, setLastNotification] = useState<Notifications.Notification | null>(null)
  const [permissionStatus, setPermissionStatus] = useState<Notifications.PermissionStatus | null>(null)

  const foregroundSub = useRef<Notifications.EventSubscription | null>(null)
  const responseSub   = useRef<Notifications.EventSubscription | null>(null)

  // ── Step 1: acquire token and sync to backend (runs only when enabled=true) ──
  const syncToken = useCallback(async () => {
    let cancelled = false

    try {
      // Respect user preference — skip registration when push notifications are off.
      if (!getPushNotificationEnabled()) return

      const { status } = await Notifications.getPermissionsAsync()
      setPermissionStatus(status)

      const token = await acquireExpoPushToken()
      if (cancelled || !token) return

      setExpoPushToken(token)

      // Persist to backend → user_devices table
      await registerDeviceToken({
        push_token: token,
        platform: Platform.OS as 'android' | 'ios',
        token_type: 'expo',
      })
    } catch (err) {
      console.warn('[PushNotifications] Setup error:', err)
    }

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const cleanup = syncToken()
    return () => { cleanup?.then((fn) => fn?.()) }
  }, [enabled, syncToken])

  // ── Step 2: foreground notification listener ─────────────────────────────────
  // Fires whenever a push arrives while the app is in the foreground.
  useEffect(() => {
    foregroundSub.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log(
        '[PushNotifications] Foreground:',
        notification.request.content.title,
        notification.request.content.data,
      )
      setLastNotification(notification)
    })

    // ── Step 3: notification tap / response listener ──────────────────────────
    // Fires when the user taps a notification from the system tray
    // (background) OR from a foreground alert banner.
    responseSub.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const { title, data } = response.notification.request.content
      console.log('[PushNotifications] Tapped:', title, data)

      // ─── Deep-link routing ────────────────────────────────────────────────
      // Uncomment and expand as you add notification types on the backend:
      //
      // import { router } from 'expo-router'
      // const type = data?.type as string | undefined
      // if (type === 'courtbooking') router.push(`/bookings/${data.id}`)
      // else if (type === 'event')   router.push(`/event/${data.id}`)
      // ─────────────────────────────────────────────────────────────────────
    })

    return () => {
      foregroundSub.current?.remove()
      responseSub.current?.remove()
    }
  }, [])

  return { expoPushToken, lastNotification, permissionStatus }
}
