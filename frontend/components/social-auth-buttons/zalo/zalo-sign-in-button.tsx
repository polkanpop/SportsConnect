import { ICONS } from '@/constants/icons';
import { persistAuthSession } from '@/lib/backendApi';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { TouchableOpacity, ActivityIndicator, Alert, StyleSheet, TurboModuleRegistry } from 'react-native';
import { Image } from 'expo-image';
import { API_BASE_URL } from '@/env';

export default function ZaloSignInButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const signIn = useCallback(async () => {
    if (loading) return;

    // Must check native availability BEFORE any require(). TurboModuleRegistry.get() returns null
    // safely, while the package's internal TurboModuleRegistry.getEnforcing() throws a fatal
    // Invariant Violation that the new RN arch cannot recover from even inside try-catch.
    const isZaloAvailable = TurboModuleRegistry.get('ZaloKit') !== null;
    if (!isZaloAvailable) {
      Alert.alert(
        'Zalo sign-in unavailable',
        'Zalo login requires a full app update. Please update the app from the store.',
      );
      return;
    }

    setLoading(true);
    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '');

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const zaloModule = require('react-native-zalo-kit') as typeof import('react-native-zalo-kit');
      const { login, getUserProfile } = zaloModule;

      // 1. AUTH_VIA_APP deep-links directly into the installed Zalo app — user approves there
      //    and is returned via the zalo-{appId}:// scheme (BrowserLoginActivity handles redirect).
      //    APP_OR_WEB triggered a "version incompatible" version-gate dialog that broke the flow.
      //    AUTH_VIA_WEB opens a browser which is unwanted — APP bypasses both issues.
      const loginResult = await Promise.race([
        login('AUTH_VIA_APP'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Zalo login timed out after 60s')), 60000),
        ),
      ]);
      const { accessToken } = loginResult;
      if (!accessToken) {
        Alert.alert('Sign-in error', 'Zalo did not return an access token.');
        return;
      }

      // 2. Fetch the Zalo user profile from the device (Vietnam IP — geo-requirement met).
      const profile = await getUserProfile();
      const zaloId = String(profile?.id ?? '');
      const zaloName = String(profile?.name ?? '');
      // phoneNumber is available from the Zalo SDK profile — Zalo accounts are phone-tied.
      const zaloPhone = String(profile?.phoneNumber ?? '');
      if (!zaloId) {
        Alert.alert('Sign-in error', 'Could not retrieve Zalo user ID from device.');
        return;
      }

      // 3. Authenticate with our backend — creates / syncs the user record and returns our JWT.
      const authResp = await fetch(`${backendUrl}/api/auth/zalo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, zalo_id: zaloId, zalo_name: zaloName, zalo_phone: zaloPhone }),
      });
      const authJson = await authResp.json().catch(() => ({}));

      if (!authResp.ok || !authJson?.userid) {
        const detail = authJson?.detail || JSON.stringify(authJson);
        Alert.alert('Sign-in error', `Zalo sign-in failed (${authResp.status}): ${detail}`);
        return;
      }

      await persistAuthSession(authJson, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? '';
      // ZaloSDK throws when the user cancels â€” do not show an error in that case.
      const isCancelled = /cancel|dismiss|user_denied/i.test(msg);
      if (!isCancelled) {
        if (__DEV__) console.error('[ZaloSignIn] error', e);
        Alert.alert('Sign-in error', `Could not complete Zalo sign-in: ${msg}`);
      }
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

