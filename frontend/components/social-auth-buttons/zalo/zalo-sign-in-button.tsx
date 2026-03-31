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

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeVerifier(): Promise<string> {
  // 43–128 char unreserved ASCII string
  const bytes = await Crypto.getRandomBytesAsync(32);
  return uint8ArrayToBase64Url(bytes);
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

    // HTTPS URL registered in Zalo Developer Console → Web tab → Callback URL.
    // Zalo only accepts HTTPS here; our Cloudflare worker at sportconnects.org
    // bridges this to the app deep link (sportconnect://auth/zalo-callback).
    const zaloCallbackHttps = 'https://sportconnects.org/zalo-callback';

    // Deep link the app's intent-filter listens on — used as the second arg to
    // openAuthSessionAsync so it knows when to close the browser tab.
    const appDeepLink = Linking.createURL('auth/zalo-callback', { scheme: expo.scheme });

    try {
      // 1. PKCE
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      // 2. Open Zalo auth page — redirect_uri must match Zalo dev console registration
      const authUrl =
        `https://oauth.zaloapp.com/v4/permission?` +
        `app_id=${ZALO_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(zaloCallbackHttps)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&state=sportconnect`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, appDeepLink, {
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
        const detail = syncJson?.detail || JSON.stringify(syncJson);
        Alert.alert('Sign-in error', `Zalo sign-in failed (${syncResp.status}): ${detail}`);
        setLoading(false);
        return;
      }

      await persistAuthSession(syncJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      console.error('[ZaloSignIn] error', e);
      const errMsg = e?.message || String(e) || 'Unknown error';
      Alert.alert('Sign-in error', `Could not complete Zalo sign-in: ${errMsg}`);
    } finally {
      setLoading(false);
    }
  }, [loading, router]);

  return (
    <TouchableOpacity
      onPress={signIn}
      disabled={loading}
      activeOpacity={0.7}
      style={{ opacity: loading ? 0.6 : 1, marginHorizontal: 12 }}
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
  icon: {
    width: 34,
    height: 34,
  },
});
