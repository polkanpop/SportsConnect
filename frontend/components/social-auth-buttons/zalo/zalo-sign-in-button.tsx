/**
 * Zalo sign-in using manual PKCE OAuth via expo-web-browser.
 *
 * Opens a Chrome Custom Tab (same "in-app browser" look — X button,
 * no full Chrome) regardless of native build issues with react-native-zalo-kit.
 *
 * Flow:
 *   1. Generate PKCE code_verifier + code_challenge (expo-crypto, SHA256)
 *   2. openAuthSessionAsync → opens CCT at Zalo OAuth page
 *   3. User logs in → Zalo redirects to https://sportconnects.org/zalo-callback
 *   4. Cloudflare worker 302 → sportconnect://zalo-code?code=...
 *   5. expo-web-browser captures URL, extracts code
 *   6. POST /api/auth/zalo/token {code, code_verifier} → access_token
 *   7. POST /zalo-proxy/tokeninfo {access_token} → {id, name}
 *   8. POST /api/auth/zalo {access_token, zalo_id, zalo_name} → JWT
 *   9. Persist session → navigate home
 */
import 'react-native-url-polyfill/auto';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ICONS } from '@/constants/icons';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useRouter } from 'expo-router';
import { useState, useCallback, useRef, useEffect } from 'react';
import { Linking, TouchableOpacity, ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import { useZaloAuthOverlay } from '@/providers/zalo-auth-overlay-provider';
import { Image } from 'expo-image';
import { API_BASE_URL } from '@/env';

const ZALO_APP_ID = '959402498466634174';
const ZALO_AUTH_ENDPOINT = 'https://oauth.zaloapp.com/v4/permission';
const WORKER_ORIGIN = 'https://sportconnects.org';
const REDIRECT_INTERCEPT = 'sportconnect://zalo-code';
const ZALO_REDIRECT_URI = `${WORKER_ORIGIN}/zalo-callback`;

const OAUTH_PROMPT_PREFIX = '@oauth_cred_prompt_';

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateCodeVerifier(): string {
  const bytes = Crypto.getRandomBytes(48);
  const base64 = btoa(String.fromCharCode(...bytes));
  return toBase64Url(base64);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  return toBase64Url(hash);
}

function generateState(): string {
  const bytes = Crypto.getRandomBytes(16);
  return toBase64Url(btoa(String.fromCharCode(...bytes))).slice(0, 20);
}

// ─── Component ────────────────────────────────────────────────────────────────
interface ZaloSignInButtonProps {
  /** Called right before the CCT opens so the parent can show a full-screen guard */
  onAuthStart?: () => void
  /** Called when auth finishes (success or failure) so the parent can hide the guard */
  onAuthDone?: () => void
}

export default function ZaloSignInButton({ onAuthStart, onAuthDone }: ZaloSignInButtonProps = {}) {
  const router = useRouter();
  const overlay = useZaloAuthOverlay();
  const [loading, setLoading] = useState(false);
  const isProcessing = useRef(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Pre-warm the Chrome Custom Tab so it opens instantly (eliminates black loading flash)
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => { void WebBrowser.coolDownAsync(); };
  }, []);

  const signIn = useCallback(async () => {
    if (loading || isProcessing.current) return;
    isProcessing.current = true;
    setLoading(true);
    onAuthStart?.();
    overlay.show();

    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');

    try {
      // 1. Generate PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateState();

      // 2. Build Zalo OAuth URL
      const params = new URLSearchParams({
        app_id: ZALO_APP_ID,
        redirect_uri: ZALO_REDIRECT_URI,
        code_challenge: codeChallenge,
        state,
      });
      const oauthUrl = `${ZALO_AUTH_ENDPOINT}?${params.toString()}`;

      // 3. Open Chrome Custom Tab with Linking listener fallback.
      //    On OPPO/ColorOS the CCT may not self-close after the custom-scheme
      //    redirect.  A parallel Linking listener catches the deep link and
      //    force-dismisses the CCT so the user isn't stuck on a black screen.
      await new Promise<void>(r => requestAnimationFrame(() => r()));

      const authCode: string | null = await new Promise<string | null>((resolve) => {
        let settled = false;

        const linkingSub = Linking.addEventListener('url', ({ url }) => {
          if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return;
          settled = true;
          linkingSub.remove();
          try { WebBrowser.dismissAuthSession(); } catch {}
          try { resolve(new URL(url).searchParams.get('code')); } catch { resolve(null); }
        });

        WebBrowser.openAuthSessionAsync(oauthUrl, REDIRECT_INTERCEPT)
          .then((result) => {
            if (settled) return;
            settled = true;
            linkingSub.remove();
            try { WebBrowser.dismissAuthSession(); } catch {}
            if (result.type === 'success') {
              try { resolve(new URL(result.url).searchParams.get('code')); } catch { resolve(null); }
            } else {
              resolve(null);
            }
          })
          .catch(() => {
            if (settled) return;
            settled = true;
            linkingSub.remove();
            resolve(null);
          });
      });

      if (!authCode) {
        // User cancelled or CCT failed
        overlay.hide();
        return;
      }

      // 4. Extract code from deep link — already have it
      const code = authCode;
      if (!code) {
        overlay.hide();
        Alert.alert('Đăng nhập Zalo thất bại', 'Không nhận được mã xác thực từ Zalo.');
        return;
      }

      // 5. Exchange code for access_token
      const tokenResp = await fetch(`${backendUrl}/api/auth/zalo/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      });
      const tokenJson = await tokenResp.json().catch(() => ({}));
      const accessToken: string = tokenJson?.access_token ?? '';
      if (!accessToken) {
        overlay.hide();
        Alert.alert('Đăng nhập Zalo thất bại', tokenJson?.detail || 'Không lấy được access token.');
        return;
      }

      // 6. Get Zalo user_id + name via graph.zalo.me (Social API, works from Vietnam device IPs).
      //    Returns { id, name } — note field is 'id' not 'user_id'.
      let zaloId = String(tokenJson?.user_id ?? '');
      let zaloName = 'Zalo User';
      if (!zaloId) {
        try {
          const tiResp = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name', {
            headers: { 'access_token': accessToken },
          });
          const tiJson = await tiResp.json().catch(() => ({}));
          zaloId = String(tiJson?.id ?? '');
          if (tiJson?.name) zaloName = String(tiJson.name);
        } catch { /* non-fatal */ }
      }
      if (!zaloId) {
        overlay.hide();
        Alert.alert('Đăng nhập Zalo thất bại', 'Không lấy được thông tin người dùng Zalo.');
        return;
      }

      // 7. Auth with our backend
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, zalo_id: zaloId, zalo_name: zaloName }),
      });
      const authJson = await authResp.json().catch(() => ({}));
      if (!authResp.ok || !authJson?.userid) {
        overlay.hide();
        Alert.alert('Đăng nhập Zalo thất bại', authJson?.detail || 'Xác thực thất bại');
        return;
      }

      // 8. Persist session and navigate home.
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });

      const promptKey = `${OAUTH_PROMPT_PREFIX}${authJson.userid}`;
      const alreadyPrompted = await AsyncStorage.getItem(promptKey).catch(() => '1');
      if (!alreadyPrompted) {
        await AsyncStorage.setItem(promptKey, '1').catch(() => {});
        Alert.alert(
          'Thiết lập tài khoản',
          'Bạn có thể thêm tên đăng nhập & mật khẩu trong Cài đặt tài khoản để đăng nhập mà không cần Zalo.',
          [
            {
              text: 'Để sau',
              onPress: () => {
                if (isMounted.current) router.replace('/(tabs)/Home');
              },
            },
            {
              text: 'Thiết lập ngay',
              onPress: () => {
                if (isMounted.current) router.replace('/event/accountSettings' as any);
              },
            },
          ],
        );
      } else {
        if (isMounted.current) router.replace('/(tabs)/Home');
      }
    } catch (e: any) {
      if (__DEV__) console.error('[ZaloSignIn]', e);
      const msg: string = e?.message ?? String(e) ?? '';
      if (!msg.includes('cancel') && !msg.includes('-201')) {
        Alert.alert('Lỗi đăng nhập Zalo', msg || 'Vui lòng thử lại.');
      }
    } finally {
      setLoading(false);
      // Always hide the overlay in finally. The overlay provider has a built-in
      // auto-hide timeout as a safety net, but we should clean up eagerly.
      // A brief flash during navigation is acceptable; stuck-forever is not.
      overlay.hide();
      onAuthDone?.();
      isProcessing.current = false;
    }
  }, [loading, router, overlay, onAuthStart, onAuthDone]);

  return (
    <>
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
    </>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 30,
    height: 30,
    bottom: 1,
  },
});