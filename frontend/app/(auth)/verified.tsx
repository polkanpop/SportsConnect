import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persistAuthSession } from '@/lib/backendApi';
import { requestLocationPermissionOnceAfterSignup } from '@/lib/locationOnboarding';

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

  useEffect(() => {
    const bootstrap = async () => {
      try {
        if (params.status !== 'ok') {
          setError('Invalid verification response');
          return;
        }
        // Consolidated persistence helper (sets profile, tokens, remember flag)
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
        // Clear pending signup profile (if any)
        await AsyncStorage.removeItem('@backendProfilePending');
        setDone(true);
        // Route into main app (tabs) after short delay
        setTimeout(() => router.replace('/(tabs)/Home'), 600);
      } catch (e: any) {
        setError(e.message || 'Auto login failed');
      }
    };
    bootstrap();
  }, [params]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <Text style={styles.title}>Account verified!</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        {!error && !done && <ActivityIndicator size="large" color="#15803d" style={{ marginTop: 20 }} />}
        {!error && done && <Text style={styles.info}>Logging you in…</Text>}
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
