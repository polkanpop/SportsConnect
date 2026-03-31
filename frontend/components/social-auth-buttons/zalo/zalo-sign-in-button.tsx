import { ICONS } from '@/constants/icons';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { expo } from '@/app.json';
import { API_BASE_URL } from '@/env';

// ── PKCE helpers ─────────────────────────────────────────────────────────────

async function generateCodeVerifier(): Promise<string> {
  // 43–128 char unreserved ASCII string
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  return digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ──────────────────────────────────────────────────────────────────────────────

const ZALO_APP_ID = process.env.EXPO_PUBLIC_ZALO_APP_ID ?? '959402498466634174';

export default function ZaloSignInButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  WebBrowser.maybeCompleteAuthSession();

  const signIn = useCallback(async () => {
    if (loading) return;
    setLoading(true);

    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');
    const redirectUri = Linking.createURL('auth/zalo-callback', { scheme: expo.scheme });

    try {
      // 1. PKCE
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      // 2. Open Zalo auth page
      const authUrl =
        `https://oauth.zaloapp.com/v4/permission?` +
        `app_id=${ZALO_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&state=sportconnect`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri, {
        showInRecents: true,
      });

      if (result.type !== 'success') {
        if (result.type === 'dismiss') {
          console.warn('[ZaloSignIn] user dismissed');
        } else {
          console.error('[ZaloSignIn] unexpected result', result.type);
        }
        setLoading(false);
        return;
      }

      // 3. Parse authorization code from redirect URL
      const parsed = Linking.parse(result.url);
      const code = (parsed.queryParams?.code as string | undefined) ?? '';
      if (!code) {
        console.error('[ZaloSignIn] missing code in redirect', result.url);
        Alert.alert('Sign-in error', 'Zalo did not return an authorization code.');
        setLoading(false);
        return;
      }

      // 4. Exchange code at our backend (which holds the app_secret securely)
      const syncResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      });
      const syncJson = await syncResp.json().catch(() => ({}));
      console.debug('[ZaloSignIn] backend sync', { status: syncResp.status, body: syncJson });

      if (!syncResp.ok || !syncJson?.userid) {
        console.error('[ZaloSignIn] backend sync failed', syncResp.status, syncJson);
        Alert.alert('Sign-in error', `Zalo sign-in failed (${syncResp.status}): ${syncJson?.detail || JSON.stringify(syncJson)}`);
        setLoading(false);
        return;
      }

      await persistAuthSession(syncJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      router.replace('/(tabs)/Home');
    } catch (e) {
      console.error('[ZaloSignIn] error', e);
      Alert.alert('Sign-in error', 'Could not complete Zalo sign-in. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [loading, router]);

  return (
    <TouchableOpacity
      onPress={signIn}
      disabled={loading}
      activeOpacity={0.8}
      style={[styles.btn, loading && { opacity: 0.6 }]}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#0068FF" />
      ) : (
        <Image source={ICONS.zaloIcon} style={styles.icon} contentFit="contain" />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
    marginHorizontal: 8,
  },
  icon: {
    width: 32,
    height: 32,
  },
});
