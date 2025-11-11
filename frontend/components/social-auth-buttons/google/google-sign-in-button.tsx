import 'react-native-url-polyfill/auto'; // Ensure URL & URLSearchParams exist in RN environment
import { supabase } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import { TouchableOpacity, ActivityIndicator } from 'react-native';
import { useState, useCallback } from 'react';
import { expo } from '@/app.json';
const { Text } = require('@react-navigation/elements');
import { Image } from 'expo-image';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Helper: parse the fragment returned from /authorize redirect (#access_token=...)
function parseFragment(url: string) {
  try {
    const u = new URL(url);
    const hash = u.hash.startsWith('#') ? u.hash.substring(1) : u.hash;
    const sp = new URLSearchParams(hash);
    return {
      access_token: sp.get('access_token') || undefined,
      refresh_token: sp.get('refresh_token') || undefined,
      expires_in: sp.get('expires_in') ? parseInt(sp.get('expires_in') || '0', 10) : undefined,
      token_type: sp.get('token_type') || undefined,
      provider_token: sp.get('provider_token') || undefined,
      error: sp.get('error') || undefined,
    };
  } catch (e) {
    console.warn('parseFragment failed', e);
    return {} as any;
  }
}

export default function GoogleSignInButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  WebBrowser.maybeCompleteAuthSession();

  const signIn = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    // Prefer public env; fallback to app.json extras for development convenience
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || (expo?.extra?.SUPABASE_URL as string | undefined);
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!supabaseUrl) {
      console.error('Missing EXPO_PUBLIC_SUPABASE_URL env');
      setLoading(false);
      return;
    }

    // Build redirect using the app scheme so the browser returns directly to Expo Go / the app.
  // Build redirect URI; using module function. (Types may vary by SDK version.)
  const redirectUri = AuthSession.makeRedirectUri({ scheme: expo.scheme });

    // Build Supabase authorize URL manually.
    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectUri,
      // Extra recommended params
      scopes: 'email profile',
      prompt: 'consent',
    });
    const authUrl = `${supabaseUrl}/auth/v1/authorize?${params.toString()}`;
    console.debug('[GoogleSignIn] start', { authUrl, redirectUri });

    let wbResult: WebBrowser.WebBrowserAuthSessionResult;
    try {
      wbResult = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri, { showInRecents: true });
    } catch (e) {
      console.error('[GoogleSignIn] openAuthSessionAsync error', e);
      setLoading(false);
      return;
    }
    console.debug('[GoogleSignIn] webBrowser result', wbResult);

    if (wbResult.type !== 'success') {
      if (wbResult.type === 'dismiss') {
        console.warn('[GoogleSignIn] user dismissed');
      } else {
        console.error('[GoogleSignIn] unexpected result', wbResult.type);
      }
      setLoading(false);
      return;
    }

    const frag = parseFragment(wbResult.url);
    if (frag.error) {
      console.error('[GoogleSignIn] provider returned error', frag.error);
      setLoading(false);
      return;
    }
    // If we didn't get access/refresh tokens, attempt code exchange (PKCE / implicit fallback)
    if ((!frag.access_token || !frag.refresh_token) && (frag as any).code) {
      console.debug('[GoogleSignIn] attempting exchangeCodeForSession');
      try {
        const { data, error } = await supabase.auth.exchangeCodeForSession((frag as any).code as string);
        if (error) {
          console.error('[GoogleSignIn] exchangeCodeForSession error', error);
        } else {
          console.debug('[GoogleSignIn] exchangeCodeForSession success', { user: data.session?.user?.id });
          // Attempt backend sync using access token from established session
          const token = data.session?.access_token;
          if (token && process.env.EXPO_PUBLIC_BACKEND_URL) {
            try {
              const syncResp = await fetch(`${process.env.EXPO_PUBLIC_BACKEND_URL}/api/auth/sync`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
              });
              const syncJson = await syncResp.json().catch(() => ({}));
              console.debug('[GoogleSignIn] backend sync (exchange)', { status: syncResp.status, body: syncJson });
              if (syncResp.ok && syncJson?.userid) {
                await AsyncStorage.setItem('@backendProfile', JSON.stringify({
                  userid: syncJson.userid,
                  username: syncJson.username,
                  email: syncJson.email,
                  name: syncJson.name,
                  logintype: syncJson.logintype || 'Google',
                }));
              }
            } catch (e) {
              console.error('[GoogleSignIn] backend sync (exchange) failed', e);
            }
          }
          setLoading(false);
          router.replace('/(tabs)/Home');
          return;
        }
      } catch (e) {
        console.error('[GoogleSignIn] exchangeCodeForSession exception', e);
      }
    }

    if (!frag.access_token) {
      console.error('[GoogleSignIn] missing access_token in redirect fragment');
      setLoading(false);
      return;
    }
    if (!frag.refresh_token) {
      console.warn('[GoogleSignIn] missing refresh_token; continuing with access_token only');
    }

    // Establish Supabase session locally
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: frag.access_token,
        // If refresh token missing we still pass undefined; Supabase handles short-lived session
        refresh_token: frag.refresh_token,
      });
      if (error) {
        console.error('[GoogleSignIn] setSession error', error);
        setLoading(false);
        return;
      }
      console.debug('[GoogleSignIn] session set', { user: data.session?.user?.id });
    } catch (e) {
      console.error('[GoogleSignIn] setSession exception', e);
      setLoading(false);
      return;
    }

    // Sync / provision user in backend (creates numeric userid) & persist locally
    try {
      if (!backendUrl) {
        console.warn('[GoogleSignIn] EXPO_PUBLIC_BACKEND_URL not set; skipping sync');
      } else {
        const syncResp = await fetch(`${backendUrl}/api/auth/sync`, {
          method: 'POST',
            headers: { Authorization: `Bearer ${frag.access_token}` },
        });
        const syncJson = await syncResp.json().catch(() => ({}));
        console.debug('[GoogleSignIn] backend sync', { status: syncResp.status, body: syncJson });
        if (syncResp.ok && syncJson?.userid) {
          await AsyncStorage.setItem(
            '@backendProfile',
            JSON.stringify({
              userid: syncJson.userid,
              username: syncJson.username,
              email: syncJson.email,
              name: syncJson.name,
              logintype: syncJson.logintype || 'Google',
            }),
          );
        }
      }
    } catch (e) {
      console.error('[GoogleSignIn] backend sync failed', e);
    }

    setLoading(false);
    // Navigate to home tabs after success
    router.replace('/(tabs)/Home');
  }, [loading, router]);

  return (
    <TouchableOpacity
      onPress={signIn}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#ffffff',
        borderWidth: 1,
        borderColor: '#dbdbdb',
        borderRadius: 4,
        paddingVertical: 10,
        paddingHorizontal: 15,
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 2,
        opacity: loading ? 0.6 : 1,
      }}
      activeOpacity={0.8}
      disabled={loading}
    >
      <Image
        source={{ uri: 'https://developers.google.com/identity/images/g-logo.png' }}
        style={{ width: 24, height: 24, marginRight: 10 }}
      />
      {loading ? (
        <ActivityIndicator size="small" color="#555" />
      ) : (
        <Text
          style={{
            fontSize: 16,
            color: '#757575',
            fontFamily: 'Roboto-Regular',
            fontWeight: '500',
          }}
        >
          Sign in with Google
        </Text>
      )}
    </TouchableOpacity>
  );
}