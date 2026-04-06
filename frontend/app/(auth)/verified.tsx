import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persistAuthSession } from '@/lib/backendApi';
import { requestLocationPermissionOnceAfterSignup } from '@/lib/locationOnboarding';
import { useThemeColors } from '@/hooks/use-theme-colors';

// This screen is reached via deep link after email verification redirect.
// It receives query params with tokens if auto-login was enabled.
export default function EmailVerifiedAutoLoginScreen() {
  const params = useLocalSearchParams<{
    status?: string;
    verified?: string;
    alreadyVerified?: string;
    email?: string;
    accessToken?: string;
    accessTokenExpiresAt?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
    userid?: string;
    username?: string;
    name?: string;
  }>();

  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tc = useThemeColors();

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      // --- Cold-start / killed-app guard ---
      // Linking.getInitialURL() returns the URL that launched the app IF it was killed
      // (cold start). If the app was already running in the background, it returns null.
      // We intentionally do NOT process the deep link in killed state: the user must
      // open the app normally and click the link while it is alive.
      const initialUrl = await Linking.getInitialURL();
      if (cancelled) return;
      if (initialUrl) {
        // App was opened from a killed state via this deep link — silently redirect to login.
        router.replace('/(auth)/login');
        return;
      }

      // App was already running (foreground/background) — proceed with auto-login.
      const bootstrap = async () => {
        try {
          if (params.status !== 'ok') {
            setError('Invalid verification response');
            return;
          }
          const authData = {
            userid: params.userid ? Number(params.userid) : undefined,
            username: params.username,
            name: params.name,
            email: params.email,
            accessToken: params.accessToken,
            accessTokenExpiresAt: params.accessTokenExpiresAt,
            refreshToken: params.refreshToken,
            refreshTokenExpiresAt: params.refreshTokenExpiresAt,
          }
          await persistAuthSession(authData, { rememberMe: true })
          await requestLocationPermissionOnceAfterSignup()
          await AsyncStorage.removeItem('@backendProfilePending');
          if (!cancelled) {
            setDone(true);
            setTimeout(() => router.replace('/(tabs)/Home'), 600);
          }
        } catch (e: any) {
          if (!cancelled) setError(e.message || 'Auto login failed');
        }
      };
      bootstrap();
    };

    run();
    return () => { cancelled = true; };
  }, [params]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { backgroundColor: tc.bgBase }]}>
        <Text style={[styles.title, { color: tc.brand }]}>Account verified!</Text>
        {error && <Text style={[styles.error, { color: tc.error }]}>{error}</Text>}
        {!error && !done && <ActivityIndicator size="large" color={tc.brand} style={{ marginTop: 20 }} />}
        {!error && done && <Text style={[styles.info, { color: tc.brand }]}>Logging you in…</Text>}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, backgroundColor: '#f8f8f8' },
  title: { fontSize: 24, fontWeight: '800', color: '#15803d', marginBottom: 12 },
  info: { fontSize: 16, color: '#15803d', marginTop: 8 },
  error: { fontSize: 14, color: '#dc2626', marginTop: 12, textAlign: 'center' },
});
