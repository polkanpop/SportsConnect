/**
 * Zalo sign-in via custom OAuth 2.0 PKCE — no react-native-zalo-kit SDK.
 *
 * Auth routing:
 *   - Zalo installed  → Linking.openURL (system intent, respects Android App Links)
 *                        Android App Links route oauth.zaloapp.com to the Zalo app if Zalo
 *                        has registered that domain (which it does in Vietnam builds).
 *                        The user approves natively inside the Zalo app.
 *   - Zalo NOT installed → WebBrowser.openAuthSessionAsync (Chrome Custom Tab web fallback)
 *
 * NOTE: openAuthSessionAsync was the previous approach but Chrome Custom Tabs bypass Android
 * App Links entirely (they run inside Chrome's context). Linking.openURL uses the normal
 * Android intent system which checks App Links before opening any browser, so the Zalo app
 * intercepts oauth.zaloapp.com and handles auth natively.
 *
 * Redirect chain:
 *   Zalo/web → https://sportconnects.org/zalo-callback?code=...
 *            → 302 → sportconnect://zalo-code?code=...&state=...
 *            → our Linking listener resolves → we exchange code for JWT
 */
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { ICONS } from '@/constants/icons';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { AppState, TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { API_BASE_URL } from '@/env';

const ZALO_APP_ID = '959402498466634174';
const ZALO_REDIRECT_URI = 'https://sportconnects.org/zalo-callback';

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

// ─── System-intent auth opener ───────────────────────────────────────────────
// Used when Zalo is installed. Launches oauth.zaloapp.com via Android's normal
// intent system so App Links can route it to the native Zalo app. Waits for the
// sportconnect://zalo-code deep link to come back, or null on cancel/timeout.

function openWithSystemIntent(url: string, callbackPrefix: string): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let appWentBackground = false;
    let returnTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      urlSub.remove();
      appStateSub.remove();
      clearTimeout(masterTimeout);
      if (returnTimeoutId) clearTimeout(returnTimeoutId);
      resolve(result);
    };

    // Listen for the deep link callback (sportconnect://zalo-code?code=...)
    const urlSub = Linking.addEventListener('url', (event) => {
      if (event.url.startsWith(callbackPrefix)) {
        cleanup(event.url);
      }
    });

    // Detect cancellation: app came back to foreground but no url event fired
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        appWentBackground = true;
        if (returnTimeoutId) clearTimeout(returnTimeoutId);
      } else if (state === 'active' && appWentBackground) {
        // Give Linking 2 s to fire the url event before declaring cancelled
        returnTimeoutId = setTimeout(() => cleanup(null), 2000);
      }
    });

    // Hard safety timeout (2 min)
    const masterTimeout = setTimeout(() => cleanup(null), 120_000);

    Linking.openURL(url).catch(() => cleanup(null));
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ZaloSignInButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const signIn = useCallback(async () => {
    if (loading) return;
    setLoading(true);

    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');

    try {
      // 1. PKCE + CSRF state
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = await randomState();

      // 2. Zalo OAuth consent URL
      const authUrl =
        `https://oauth.zaloapp.com/v4/permission` +
        `?app_id=${ZALO_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(ZALO_REDIRECT_URI)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256` +
        `&state=${state}`;

      // 3. Route based on whether Zalo app is installed
      //    canOpenURL('zalo://') is reliable because <package android:name="com.zing.zalo"/>
      //    is declared in AndroidManifest.xml queries, satisfying Android 11+ visibility rules.
      let returnUrl: string | null;
      const zaloInstalled = await Linking.canOpenURL('zalo://');
      if (zaloInstalled) {
        // System intent: Android App Links may redirect oauth.zaloapp.com to Zalo native app
        returnUrl = await openWithSystemIntent(authUrl, 'sportconnect://zalo-code');
      } else {
        // Web fallback via Chrome Custom Tab
        const result = await WebBrowser.openAuthSessionAsync(authUrl, 'sportconnect://');
        returnUrl = result.type === 'success' ? result.url : null;
      }

      if (!returnUrl) {
        // User cancelled (pressed back, or timed out)
        return;
      }

      // 4. Parse code + validate state
      const params = parseQueryParams(returnUrl);
      if (params.error) {
        Alert.alert('Dong Zalo that bai', `Zalo tra ve loi: ${params.error}`);
        return;
      }
      if (params.state !== state) {
        Alert.alert('Dong Zalo that bai', 'State mismatch — yeu cau khong hop le.');
        return;
      }
      const { code } = params;
      if (!code) {
        Alert.alert('Dong Zalo that bai', 'Khong nhan duoc ma xac thuc tu Zalo.');
        return;
      }

      // 5. Exchange auth code for Zalo access_token via backend (holds app_secret)
      const tokenResp = await fetch(`${backendUrl}/api/auth/zalo/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      });
      const tokenJson = await tokenResp.json().catch(() => ({}));
      if (!tokenResp.ok || !tokenJson?.access_token) {
        const detail = tokenJson?.detail || JSON.stringify(tokenJson);
        Alert.alert('Dong Zalo that bai', `Trao doi token that bai: ${detail}`);
        return;
      }
      const { access_token } = tokenJson;

      // 6. Fetch Zalo user profile from device (Vietnam IP satisfies geo requirement)
      const profileResp = await fetch(
        'https://graph.zalo.me/v2.0/me?fields=id,name,picture',
        { headers: { access_token } },
      );
      const profile = await profileResp.json().catch(() => ({}));
      const zaloId = String(profile?.id ?? '');
      const zaloName = String(profile?.name ?? '');
      if (!zaloId) {
        Alert.alert('Dong Zalo that bai', 'Khong lay duoc thong tin nguoi dung Zalo.');
        return;
      }

      // 7. Sync with our backend → receive JWT
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token, zalo_id: zaloId, zalo_name: zaloName }),
      });
      const authJson = await authResp.json().catch(() => ({}));
      if (!authResp.ok || !authJson?.userid) {
        const detail = authJson?.detail || JSON.stringify(authJson);
        Alert.alert('Dong Zalo that bai', `Xac thuc that bai (${authResp.status}): ${detail}`);
        return;
      }

      // 8. Persist session and navigate home
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? '';
      if (__DEV__) console.error('[ZaloSignIn]', e);
      Alert.alert('Loi', `Khong the dang nhap Zalo: ${msg}`);
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
    width: 30,
    height: 30,
    bottom: 1,
  },
});