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
import { InteractionManager, TouchableOpacity, ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
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
    // Track whether we navigated away — if not (cancel/error) we hide the overlay here.
    // If we DO navigate, the destination screen hides it after its first render commits.
    let willNavigate = false;

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

      // 3. Open Chrome Custom Tab — expo-web-browser always uses CCT (no full Chrome)
      // Yield one JS frame so the overlay paints before CCT opens
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const result = await WebBrowser.openAuthSessionAsync(oauthUrl, REDIRECT_INTERCEPT);
      // Explicitly dismiss so the CCT cannot fire more redirect events
      WebBrowser.dismissBrowser();
      // DO NOT clear the overlay here. The global ZaloAuthOverlayProvider overlay
      // (rendered at root level, outside the Stack navigator) keeps covering the screen
      // throughout the ~300 ms surface-reconstruction window on OPPO/ColorOS.
      // hide() is called by the destination screen's useEffect after its first render.
      if (result.type !== 'success') {
        // User cancelled or CCT failed — we're staying on this screen, safe to hide now.
        overlay.hide();
        return;
      }

      // 4. Extract code from deep link sportconnect://zalo-code?code=...
      const urlObj = new URL(result.url);
      const code = urlObj.searchParams.get('code');
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
      // Mark willNavigate=true BEFORE navigation so the finally block knows NOT to
      // hide the overlay — the destination screen (Home / accountSettings) hides it
      // inside its useEffect after the first render commits to the native layer.
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });

      willNavigate = true;
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
                InteractionManager.runAfterInteractions(() => overlay.hide());
              },
            },
            {
              text: 'Thiết lập ngay',
              onPress: () => {
                if (isMounted.current) router.replace('/event/accountSettings' as any);
                InteractionManager.runAfterInteractions(() => overlay.hide());
              },
            },
          ],
        );
      } else {
        if (isMounted.current) router.replace('/(tabs)/Home');
        InteractionManager.runAfterInteractions(() => overlay.hide());
      }
    } catch (e: any) {
      if (__DEV__) console.error('[ZaloSignIn]', e);
      const msg: string = e?.message ?? String(e) ?? '';
      if (!msg.includes('cancel') && !msg.includes('-201')) {
        Alert.alert('Lỗi đăng nhập Zalo', msg || 'Vui lòng thử lại.');
      }
    } finally {
      setLoading(false);
      // Only hide the overlay if we are NOT navigating away.
      // If willNavigate=true, the destination screen calls overlay.hide() after its
      // first render, guaranteeing the surface is fully reconstructed before dismiss.
      if (!willNavigate) {
        overlay.hide();
        onAuthDone?.();
      }
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