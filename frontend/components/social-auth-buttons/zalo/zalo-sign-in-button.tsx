/**
 * Zalo sign-in via custom OAuth 2.0 PKCE — no react-native-zalo-kit SDK.
 *
 * Redirect chain:
 *   Zalo web auth → https://sportconnects.org/zalo-callback?code=...
 *                 → 302 → sportconnect://zalo-code?code=...&state=...
 *                 → Chrome Custom Tab resolves → we exchange code for JWT
 *
 * Chrome Custom Tab (openAuthSessionAsync) is used for all cases — it intercepts
 * the sportconnect:// redirect, whereas Linking.openURL (full browser) does not.
 */
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

      // 3. Open OAuth consent in Chrome Custom Tab — the only approach that can intercept
      //    the sportconnect:// deep-link redirect on Android without a native Zalo SDK.
      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'sportconnect://');
      const returnUrl = result.type === 'success' ? result.url : null;

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
      // One-time prompt for OAuth users to set up local credentials
      const promptKey = `@oauth_cred_prompt_${authJson.userid}`;
      const alreadyPrompted = await AsyncStorage.getItem(promptKey).catch(() => '1');
      if (!alreadyPrompted) {
        await AsyncStorage.setItem(promptKey, '1').catch(() => {});
        Alert.alert(
          'Thiết lập tài khoản',
          'Bạn có thể thêm tên đăng nhập & mật khẩu trong Cài đặt tài khoản để đăng nhập mà không cần Zalo.',
          [
            { text: 'Để sau', onPress: () => router.replace('/(tabs)/Home') },
            { text: 'Thiết lập ngay', onPress: () => router.replace('/event/accountSettings' as any) },
          ],
        );
      } else {
        router.replace('/(tabs)/Home');
      }
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