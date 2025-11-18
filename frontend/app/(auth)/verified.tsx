import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
        // Persist profile subset (mirrors authLogin persistence logic)
        if (params.userid) {
          const profile = {
            userid: Number(params.userid),
            username: params.username || null,
            name: params.name || null,
            email: params.email || null,
          };
          await AsyncStorage.setItem('@backendProfile', JSON.stringify(profile));
        }
        // Persist tokens if present
        if (params.accessToken && params.refreshToken) {
          const authPayload = {
            accessToken: params.accessToken,
            accessTokenExpiresAt: params.accessTokenExpiresAt,
            refreshToken: params.refreshToken,
            refreshTokenExpiresAt: params.refreshTokenExpiresAt,
            userid: params.userid ? Number(params.userid) : undefined,
          }
          await AsyncStorage.setItem('@backendAuth', JSON.stringify(authPayload));
          // Provide compatibility for request() fallback bearer usage
            await AsyncStorage.setItem('@localAuthToken', params.accessToken)
        }
        // Clear pending signup profile (if any)
        await AsyncStorage.removeItem('@backendProfilePending');
        // Mark remember flag true so auto-login persists across app restarts
        await AsyncStorage.setItem('@rememberAuth', 'true');
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
        <Text style={styles.title}>Email Verified</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        {!error && !done && <ActivityIndicator size="large" color="#15803d" style={{ marginTop: 20 }} />}
        {!error && done && <Text style={styles.info}>Setting up your session…</Text>}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, backgroundColor: '#f8f8f8' },
  title: { fontSize: 28, fontWeight: '800', color: '#15803d', marginBottom: 12 },
  info: { fontSize: 16, color: '#15803d', marginTop: 8 },
  error: { fontSize: 14, color: '#dc2626', marginTop: 12, textAlign: 'center' },
});
