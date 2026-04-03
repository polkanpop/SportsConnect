/**
 * Zalo sign-in via custom OAuth 2.0 PKCE — no react-native-zalo-kit SDK.
 *
 * Why the SDK is NOT used:
 *   me.zalo:sdk-auth (last updated Nov 2024) is permanently abandoned.
 *   AUTH_VIA_APP → "Bản Zalo không tương thích" dialog baked into the SDK AAR.
 *   AUTH_VIA_WEB → now requires QR code scan from a different physical device.
 *   No rebuild can fix this; Zalo stopped maintaining the library.
 *
 * This implementation:
 *   1. Generates a PKCE pair (expo-crypto, pure JS — no native SDK).
 *   2. Opens Zalo's standard developer OAuth consent URL in a Chrome Custom Tab
 *      via expo-web-browser.openAuthSessionAsync.
 *      → If Zalo is installed, Android App Links may route oauth.zaloapp.com to
 *        the Zalo app directly so the user approves natively (no web form).
 *      → If Zalo is NOT installed, the web consent page is shown instead.
 *   3. Zalo redirects to https://sportconnects.org/zalo-callback (registered in
 *      Zalo console → Web tab → Callback URL).
 *   4. The backend /zalo-callback endpoint issues a 302 to sportconnect://zalo-code
 *      so openAuthSessionAsync catches the custom-scheme redirect and closes the tab.
 *   5. Frontend exchanges code + verifier via existing POST /api/auth/zalo/token.
 *   6. Frontend fetches Zalo user profile (device has Vietnam IP) via graph.zalo.me.
 *   7. Frontend authenticates with our backend via existing POST /api/auth/zalo.
 */
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { ICONS } from '@/constants/icons';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { API_BASE_URL } from '@/env';

const ZALO_APP_ID = '959402498466634174';
// Registered in Zalo console → Web tab → Callback URL
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

/** Parse key=value pairs from a URL query string (works with custom schemes). */
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

      // 3. Open consent in Chrome Custom Tab; watch for sportconnect:// redirect
      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'sportconnect://');

      if (result.type !== 'success') {
        // User cancelled or dismissed the browser — not an error
        return;
      }

      // 4. Parse the code from sportconnect://zalo-code?code=...&state=...
      const params = parseQueryParams(result.url);
      if (params.error) {
        Alert.alert('Đăng nhập lỗi', `Zalo không xác thực: ${params.error}`);
        return;
      }
      if (params.state !== state) {
        Alert.alert('Đăng nhập lỗi', 'State mismatch — yêu cầu không hợp lệ.');
        return;
      }
      const { code } = params;
      if (!code) {
        Alert.alert('Đăng nhập lỗi', 'Không nhận được mã xác thực từ Zalo.');
        return;
      }

      // 5. Exchange auth code for Zalo access_token (backend uses app_secret)
      const tokenResp = await fetch(`${backendUrl}/api/auth/zalo/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      });
      const tokenJson = await tokenResp.json().catch(() => ({}));
      if (!tokenResp.ok || !tokenJson?.access_token) {
        const detail = tokenJson?.detail || JSON.stringify(tokenJson);
        Alert.alert('Đăng nhập lỗi', `Trao đổi token thất bại: ${detail}`);
        return;
      }
      const { access_token } = tokenJson;

      // 6. Fetch Zalo user profile from device (Vietnam IP satisfies Zalo's geo requirement)
      const profileResp = await fetch(
        'https://graph.zalo.me/v2.0/me?fields=id,name,picture',
        { headers: { access_token } },
      );
      const profile = await profileResp.json().catch(() => ({}));
      const zaloId = String(profile?.id ?? '');
      const zaloName = String(profile?.name ?? '');
      if (!zaloId) {
        Alert.alert('Đăng nhập lỗi', 'Không lấy được thông tin người dùng Zalo.');
        return;
      }

      // 7. Sync with our backend and receive JWT
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token, zalo_id: zaloId, zalo_name: zaloName }),
      });
      const authJson = await authResp.json().catch(() => ({}));
      if (!authResp.ok || !authJson?.userid) {
        const detail = authJson?.detail || JSON.stringify(authJson);
        Alert.alert('Đăng nhập lỗi', `Xác thực thất bại (${authResp.status}): ${detail}`);
        return;
      }

      // 8. Persist session and navigate home
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? '';
      if (__DEV__) console.error('[ZaloSignIn]', e);
      Alert.alert('Đăng nhập lỗi', `Không thể đăng nhập Zalo: ${msg}`);
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