import AppleSignInButton from "@/components/social-auth-buttons/apple/expo-apple-sign-in-button";
import GoogleSignInButton from "@/components/social-auth-buttons/google/google-sign-in-button";
import { ICONS } from "@/constants/icons";
import { supabase } from "@/lib/supabase"; // retained for social/anonymous flows
import { authLogin } from '@/lib/backendApi';
import { AUTO_EMAIL_LOGIN } from '@/env';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initFavoritesForCurrentUser } from '@/storage/favorites';
import { Link, Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

// Restored unified login: identifier can be email OR username, resolves to email then authenticates.
export default function LoginScreen() {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [identifier, setIdentifier] = useState(""); // email or username
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const looksLikeEmail = (v: string) => /^[^@]+@[^@]+\.[^@]+$/.test(v);

  // On mount, restore rememberMe preference & auto redirect if already remembered
  useEffect(() => {
    (async () => {
      try {
        const flag = await AsyncStorage.getItem('@rememberAuth')
        if (flag === 'true') {
          setRememberMe(true)
          // Only auto-redirect when both a remembered profile AND active backend auth tokens exist.
          // This prevents redirect loops caused by stale profiles without valid tokens.
          const rawProfile = await AsyncStorage.getItem('@backendProfile')
          const rawAuth = await AsyncStorage.getItem('@backendAuth')
          if (rawProfile && rawAuth) {
            console.log('[login] auto-redirect via remember me (validated tokens)')
            router.replace('/(tabs)/Home')
          }
        }
      } catch (e) { console.warn('[login] rememberMe restore failed', (e as any)?.message) }
    })()
  }, [])

  const handleLogin = async () => {
    setErrorMsg(null)
    if (!identifier.trim() || !password) {
      setErrorMsg('Enter identifier and password.')
      return
    }
    setLoading(true)
    try {
  const res = await authLogin({ identifier: identifier.trim(), password, rememberMe })
      console.log('[login] success', res)
      try { await initFavoritesForCurrentUser() } catch (e) { console.log('[login] initFavorites error', e) }
      setPassword('')
      router.replace('/(tabs)/Home')
    } catch (e: any) {
      console.log('[login] error', e)
      const msg = e.message || 'Login failed'
      if (msg === 'EMAIL_NOT_VERIFIED') {
        setErrorMsg('Email not verified. Please check your inbox or resend.');
        // Navigate to waiting screen only if auto email login not enabled
        if (!AUTO_EMAIL_LOGIN && looksLikeEmail(identifier)) {
          setTimeout(() => router.replace(`/(auth)/waiting?email=${encodeURIComponent(identifier.trim())}` as any), 800)
        }
      } else {
        setErrorMsg(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.logoWrapper}>
          <Image source={ICONS.app_icon} style={styles.logo} />
          <Text style={styles.appTitle}>SportConnect</Text>
        </View>

        <View style={styles.formWrapper}>
          <Text style={styles.formTitle}>Login</Text>

          <TextInput
            placeholder="Email or Username"
            placeholderTextColor={COLORS.dark300}
            value={identifier}
            onChangeText={(t) => { setIdentifier(t); if (errorMsg) setErrorMsg(null); }}
            autoCapitalize="none"
            style={styles.input}
          />

          <View style={styles.passwordRow}>
            <TextInput
              placeholder="Password"
              placeholderTextColor="#6A6B6B"
              secureTextEntry={!passwordVisible}
              value={password}
              onChangeText={setPassword}
              style={styles.passwordInput}
            />
            <Pressable onPress={() => setPasswordVisible(!passwordVisible)}>
              <Image source={passwordVisible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
            </Pressable>
          </View>

          <View style={styles.optionsRow}>
            <Pressable onPress={() => setRememberMe(!rememberMe)} style={styles.rememberMePressable}>
              <View style={[styles.checkboxBase, rememberMe && styles.checkboxChecked]}>
                {rememberMe && (<Image source={ICONS.checkSmall} style={styles.checkboxTick} />)}
              </View>
              <Text style={styles.textDark}>Remember me</Text>
            </Pressable>
            <Link href="/(auth)/forgotpassword">
              <Text style={styles.forgotPassword}>Forgot Password ?</Text>
            </Link>
          </View>

          {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

          <TouchableOpacity disabled={loading} onPress={handleLogin} style={[styles.loginButton, loading && { opacity: 0.7 }]}>
            <Text style={styles.loginButtonText}>{loading ? 'Signing in...' : 'Login'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, styles.mr3]} />
          <Text style={styles.dividerText}>Or Login with</Text>
          <View style={[styles.dividerLine, styles.ml3]} />
        </View>

        <View style={styles.socialRow}>
          <GoogleSignInButton />
          <AppleSignInButton />
        </View>

        <TouchableOpacity onPress={async () => {
          const { error } = await supabase.auth.signInAnonymously();
          if (!error) router.replace('/(tabs)/Home');
        }}>
          <Text style={styles.quickAccessText}>Quick Access to Home</Text>
        </TouchableOpacity>

        <View style={styles.signupRow}>
          <Text style={styles.textDark}>Don&apos;t have an account?</Text>
          <Link href="/(auth)/signup"><Text style={styles.signUpLink}>Sign up</Text></Link>
        </View>
      </View>
    </>
  );
}

// Color tokens derived from Tailwind + custom config
const COLORS = {
  dark300: '#6A6B6B',
  green700: '#15803d',
  green800: '#166534',
  white: '#ffffff',
  blue600: '#2563eb',
  red600: '#dc2626',
  bg: '#f8f8f8'
};

// Spacing scale: Tailwind unit *4 => px
// shadow-md approximation for RN
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 28, // px-7
    paddingTop: 80, // pt-20
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 32, // mb-8
  },
  logo: { width: 80, height: 80 }, // w-20 h-20
  appTitle: {
    fontSize: 36, // text-4xl
    fontWeight: '800', // font-extrabold
    color: COLORS.green700, // text-green-700
    marginTop: 8, // mt-2
    letterSpacing: 0.5, // tracking-wide (approx)
  },
  formWrapper: {},
  formTitle: {
    fontSize: 30, // text-3xl (~30)
    fontWeight: '700', // font-bold
    color: COLORS.dark300,
    marginBottom: 24, // mb-6
    textAlign: 'center',
  },
  input: {
    width: '100%',
    backgroundColor: COLORS.white,
    borderRadius: 12, // rounded-xl
    paddingVertical: 12, // py-3
    paddingHorizontal: 16, // px-4
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginBottom: 16, // mb-4
    color: COLORS.dark300,
  },
  passwordRow: {
    width: '100%',
    marginBottom: 20, // mb-5
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.dark300,
    paddingRight: 12, // pr-3
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12, // py-3
    paddingHorizontal: 16, // px-4
    color: COLORS.dark300,
  },
  eyeIcon: { width: 24, height: 24, tintColor: COLORS.dark300 }, // w-6 h-6 tint-dark-300
  optionsRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32, // mb-8
  },
  rememberMePressable: { flexDirection: 'row', alignItems: 'center' },
  checkboxBase: {
    width: 20,
    height: 20,
    borderRadius: 6, // rounded-md
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginRight: 8, // mr-2
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: COLORS.green700,
    borderColor: COLORS.green700,
  },
  checkboxTick: { width: 20, height: 20, tintColor: COLORS.white }, // w-5 h-5 tint-white
  textDark: { color: COLORS.dark300 },
  forgotPassword: { color: COLORS.green700, fontWeight: '600' }, // font-semibold
  loginButton: {
    backgroundColor: COLORS.green700,
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    // shadow-md approximation
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 4,
  },
  loginButtonText: {
    color: COLORS.white,
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 18, // text-lg
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginTop: 32, // mt-8
    marginBottom: 12, // mb-3
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.dark300, opacity: 0.3 },
  dividerText: { color: COLORS.dark300, fontSize: 14 }, // text-sm
  mr3: { marginRight: 12 },
  ml3: { marginLeft: 12 },
  socialRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    marginBottom: 32, // mb-8
  },
  quickAccessText: {
    textDecorationLine: 'underline',
    color: COLORS.blue600,
    fontSize: 16, // text-base
    marginBottom: 20, // mb-5
    textAlign: 'center',
  },
  signupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 4, 
    marginBottom: 40, // mb-10
  },
  signUpLink: {
    color: COLORS.green700,
    fontWeight: '700', // font-bold
  },
  errorText: {
    color: COLORS.red600,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
});

