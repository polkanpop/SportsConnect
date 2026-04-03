/**
 * Zalo sign-in via custom OAuth 2.0 PKCE — no react-native-zalo-kit SDK.
 *
 * Redirect chain:
 *   Zalo web auth → https://sportconnects.org/zalo-callback?code=...
 *                 → HTTP 302 → sportconnect://zalo-code?code=...&state=...
 *                 → Android Intent via full browser → onNewIntent
 *                 → expo-router navigates to app/(auth)/zalo-code.tsx
 *                 → that screen exchanges code for JWT and logs user in
 *
 * WHY Linking.openURL instead of openAuthSessionAsync:
 *   Chrome Custom Tab (used by openAuthSessionAsync polyfill on Android) blocks
 *   intent dispatch for custom-scheme redirects on Android 12+ / Chrome 88+.
 *   The system browser launched via Linking.openURL fires the Android Intent
 *   at the OS level when it follows the HTTP 302 → sportconnect:// redirect,
 *   which is reliably delivered via onNewIntent → expo-router deep-link handling.
 */
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ICONS } from '@/constants/icons';
import { useState, useCallback } from 'react';
import { TouchableOpacity, ActivityIndicator, Alert, Linking, StyleSheet } from 'react-native';
import { Image } from 'expo-image';

const ZALO_APP_ID = '959402498466634174';
const ZALO_REDIRECT_URI = 'https://sportconnects.org/zalo-callback';
const ZALO_AUTH_STATE_KEY = '@zaloAuth:state';
const ZALO_AUTH_VERIFIER_KEY = '@zaloAuth:codeVerifier';

// ─── PKCE helpers (pure JS) ──────────────────────────────────────────────────

async function generateCodeVerifier(): Promise<string> {
  const raw = await Crypto.getRandomBytesAsync(32);
  return btoa(String.fromCharCode(...Array.from(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function randomState(): Promise<string> {
  const raw = await Crypto.getRandomBytesAsync(16);
  return Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseQueryParams(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(
    url.slice(idx + 1).split('&').flatMap(kv => {
      const eq = kv.indexOf('=');
      if (eq === -1) return [];
      return [[decodeURIComponent(kv.slice(0, eq)), decodeURIComponent(kv.slice(eq + 1))]];
    }),
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ZaloSignInButton() {
  const [loading, setLoading] = useState(false);

  const signIn = useCallback(async () => {
    if (loading) return;
    setLoading(true);

    try {
      // 1. PKCE + CSRF state
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = await randomState();

      // 2. Persist PKCE tokens so zalo-code.tsx can validate after returning from browser
      await AsyncStorage.multiSet([
        [ZALO_AUTH_STATE_KEY, state],
        [ZALO_AUTH_VERIFIER_KEY, codeVerifier],
      ]);

      // 3. Build Zalo OAuth consent URL
      const authUrl =
        `https://oauth.zaloapp.com/v4/permission` +
        `?app_id=${ZALO_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(ZALO_REDIRECT_URI)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256` +
        `&state=${state}`;

      // 4. Open in system browser (NOT Chrome Custom Tab).
      //    The system browser fires an Android Intent at OS level when it follows
      //    the HTTP 302 redirect from sportconnects.org/zalo-callback to
      //    sportconnect://zalo-code?... — expo-router then navigates to
      //    app/(auth)/zalo-code.tsx which handles the code exchange.
      await Linking.openURL(authUrl);

      // Loading is cleared immediately — the user is now in the browser.
      // When they return via deep link, expo-router navigates away from login
      // so this component will unmount anyway.
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? '';
      if (__DEV__) console.error('[ZaloSignIn]', e);
      Alert.alert('Lỗi', `Không thể mở đăng nhập Zalo: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [loading]);

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
    width: 30,
    height: 30,
    bottom: 1,
  },
});

