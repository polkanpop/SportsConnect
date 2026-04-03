/**
 * Zalo OAuth callback screen.
 *
 * Navigated to automatically by expo-router when the deep link
 * sportconnect://zalo-code?code=...&state=... arrives (via onNewIntent).
 *
 * This screen reads the code/state from URL params, validates the PKCE state
 * that was stored in AsyncStorage by ZaloSignInButton, then exchanges the code
 * for a JWT and logs the user in.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { API_BASE_URL } from '@/env';

const ZALO_AUTH_STATE_KEY = '@zaloAuth:state';
const ZALO_AUTH_VERIFIER_KEY = '@zaloAuth:codeVerifier';
const OAUTH_PROMPT_PREFIX = '@oauth_cred_prompt_';

export default function ZaloCodeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const handled = useRef(false);

  useEffect(() => {
    // Guard against double invocation (StrictMode / re-renders)
    if (handled.current) return;
    handled.current = true;
    handleCallback();
  }, []);

  async function handleCallback() {
    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');

    try {
      // --- Error from Zalo ---
      if (params.error) {
        Alert.alert('Đăng nhập Zalo thất bại', `Zalo trả về lỗi: ${params.error}`);
        router.replace('/(auth)/login');
        return;
      }

      const { code, state } = params;
      if (!code || !state) {
        Alert.alert('Đăng nhập Zalo thất bại', 'Không nhận được mã xác thực từ Zalo.');
        router.replace('/(auth)/login');
        return;
      }

      // --- Validate PKCE state ---
      const [savedState, savedVerifier] = await AsyncStorage.multiGet([
        ZALO_AUTH_STATE_KEY,
        ZALO_AUTH_VERIFIER_KEY,
      ]).then(pairs => pairs.map(p => p[1]));

      if (!savedState || state !== savedState || !savedVerifier) {
        Alert.alert('Đăng nhập Zalo thất bại', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
        router.replace('/(auth)/login');
        return;
      }

      // --- Exchange auth code → access_token (backend holds app_secret) ---
      const tokenResp = await fetch(`${backendUrl}/api/auth/zalo/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: savedVerifier }),
      });
      const tokenJson = await tokenResp.json().catch(() => ({}));
      if (!tokenResp.ok || !tokenJson?.access_token) {
        const detail = tokenJson?.detail || JSON.stringify(tokenJson);
        Alert.alert('Đăng nhập Zalo thất bại', `Trao đổi token thất bại: ${detail}`);
        router.replace('/(auth)/login');
        return;
      }
      const { access_token } = tokenJson;

      // --- Fetch Zalo user profile from device (Vietnam IP satisfies geo requirement) ---
      const profileResp = await fetch(
        'https://graph.zalo.me/v2.0/me?fields=id,name,picture',
        { headers: { access_token } },
      );
      const profile = await profileResp.json().catch(() => ({}));
      const zaloId = String(profile?.id ?? '');
      const zaloName = String(profile?.name ?? '');
      if (!zaloId) {
        Alert.alert('Đăng nhập Zalo thất bại', 'Không lấy được thông tin người dùng Zalo.');
        router.replace('/(auth)/login');
        return;
      }

      // --- Sync with backend → receive JWT ---
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token, zalo_id: zaloId, zalo_name: zaloName }),
      });
      const authJson = await authResp.json().catch(() => ({}));
      if (!authResp.ok || !authJson?.userid) {
        const detail = authJson?.detail || JSON.stringify(authJson);
        Alert.alert('Đăng nhập Zalo thất bại', `Xác thực thất bại (${authResp.status}): ${detail}`);
        router.replace('/(auth)/login');
        return;
      }

      // --- Persist session ---
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });

      // --- One-time prompt to set up local credentials ---
      const promptKey = `${OAUTH_PROMPT_PREFIX}${authJson.userid}`;
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
      Alert.alert('Lỗi', `Không thể đăng nhập Zalo: ${msg}`);
      router.replace('/(auth)/login');
    } finally {
      // Clean up PKCE tokens regardless of outcome
      await AsyncStorage.multiRemove([ZALO_AUTH_STATE_KEY, ZALO_AUTH_VERIFIER_KEY]).catch(() => {});
    }
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#FF6017" />
      <Text style={styles.text}>Đang xử lý đăng nhập Zalo...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    color: '#6A6B6B',
  },
});
