/**
 * Zalo sign-in using the official Zalo SDK V4 via react-native-zalo-kit.
 *
 * Uses AUTH_VIA_WEB (LoginVia.WEB) — opens id.zalo.me in a WebView.
 * The page shows "Đăng nhập qua ứng dụng Zalo" so users can still tap into
 * the Zalo app from within the web screen, without us needing the hash key.
 *
 * AUTH_VIA_APP requires the app signing hash to be registered in Zalo Dev Console.
 * Hash key for current EAS build: WSjJhOo3HdMyjuHH7La+W3L4HVY=
 * Register at: developers.zalo.me → Configure → Mobile app → Android → Hash Key
 *
 * Flow:
 *   1. login("AUTH_VIA_WEB") opens Zalo OAuth page in a WebView
 *   2. Native SDK exchanges OAuth code via PKCE → returns {accessToken, refreshToken}
 *   3. getUserProfile() fetches Zalo user info (id, name) using cached access token
 *   4. POST to our backend /api/auth/zalo → receives JWT
 *   5. Persist session → navigate home
 */
import { login, getUserProfile } from 'react-native-zalo-kit';
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

const OAUTH_PROMPT_PREFIX = '@oauth_cred_prompt_';

export default function ZaloSignInButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const signIn = useCallback(async () => {
    if (loading) return;
    setLoading(true);

    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');

    try {
      // 1. Authenticate via Zalo WebView (LoginVia.WEB).
      //    Opens id.zalo.me in a webview — user can tap "Đăng nhập qua ứng dụng Zalo"
      //    from within the page to avoid password entry.
      //    AUTH_VIA_APP is blocked by Zalo's hash key check until properly registered.
      const authResult = await login('AUTH_VIA_WEB');
      const { accessToken } = authResult;

      if (!accessToken) {
        Alert.alert('Đăng nhập Zalo thất bại', 'Không nhận được access token từ Zalo.');
        return;
      }

      // 2. Fetch Zalo user profile (uses the token cached by the native SDK)
      const profile = await getUserProfile();
      const zaloId = String(profile?.id ?? '');
      const zaloName = String(profile?.name ?? '');

      if (!zaloId) {
        Alert.alert('Đăng nhập Zalo thất bại', 'Không lấy được thông tin người dùng Zalo.');
        return;
      }

      // 3. Sync with our backend → receive JWT
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, zalo_id: zaloId, zalo_name: zaloName }),
      });
      const authJson = await authResp.json().catch(() => ({}));
      if (!authResp.ok || !authJson?.userid) {
        const detail = authJson?.detail || JSON.stringify(authJson);
        Alert.alert('Đăng nhập Zalo thất bại', `Xác thực thất bại (${authResp.status}): ${detail}`);
        return;
      }

      // 4. Persist session and navigate home
      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });

      // One-time prompt for OAuth users to set up local credentials
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
      // User cancelled (pressed back on Zalo screen) - don't show error
      if (msg.includes('cancel') || msg.includes('Cancel') || msg.includes('-201')) {
        return;
      }
      if (__DEV__) console.error('[ZaloSignIn]', e);
      Alert.alert('Lỗi', `Không thể đăng nhập Zalo: ${msg}`);
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

