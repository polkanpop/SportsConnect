import AppleSignInButton from "@/components/social-auth-buttons/apple/expo-apple-sign-in-button";
import GoogleSignInButton from "@/components/social-auth-buttons/google/google-sign-in-button";
import ZaloSignInButton from "@/components/social-auth-buttons/zalo/zalo-sign-in-button";
import { ICONS } from "@/constants/icons";
import { authLogin } from '@/lib/backendApi';
import { AUTO_EMAIL_LOGIN } from '@/env';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initFavoritesForCurrentUser } from '@/storage/favorites';
import { Image as ExpoImage } from 'expo-image';
import { Link, Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@/constants/translations';
import { useLanguage } from '@/providers/language-provider';

// Vietnam mobile: 10 digits, leading 0, second digit 3–9
const VN_PHONE_RE = /^0[3-9]\d{8}$/;

function normalizeVNPhone(raw: string): string {
  return '+84' + raw.slice(1);
}

type InputMode = 'unknown' | 'email' | 'phone';

function detectMode(v: string): InputMode {
  const trimmed = v.trim();
  if (VN_PHONE_RE.test(trimmed)) return 'phone';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return 'email';
  return 'unknown';
}

export default function LoginScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { lang, toggleLanguage } = useLanguage();

  const [identifier, setIdentifier] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('unknown');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zaloAuthLoading, setZaloAuthLoading] = useState(false);

  // Restore remember-me and auto-redirect if session is cached
  useEffect(() => {
    (async () => {
      try {
        const flag = await AsyncStorage.getItem('@rememberAuth');
        if (flag === 'true') {
          setRememberMe(true);
          const rawProfile = await AsyncStorage.getItem('@backendProfile');
          const rawAuth = await AsyncStorage.getItem('@backendAuth');
          if (rawProfile && rawAuth) {
            router.replace('/(tabs)/Home');
          }
        }
      } catch (e) { console.warn('[login] rememberMe restore failed', (e as any)?.message); }
    })();
  }, []);

  const handleIdentifierChange = (t: string) => {
    setIdentifier(t);
    setInputMode(detectMode(t));
    if (errorMsg) setErrorMsg(null);
  };

  const handleLogin = async () => {
    setErrorMsg(null);
    if (!identifier.trim() || !password) {
      setErrorMsg(t('AUTH_LOGIN_ERR_MISSING_FIELDS'));
      return;
    }
    setLoading(true);
    // Normalize VN phone to E.164 so backend can look it up
    const resolvedIdentifier = inputMode === 'phone'
      ? normalizeVNPhone(identifier.trim())
      : identifier.trim();
    try {
      const res = await authLogin({ identifier: resolvedIdentifier, password, rememberMe });
      console.log('[login] success', res);
      try { await initFavoritesForCurrentUser(); } catch {}
      setPassword('');
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      const msg = e.message || t('AUTH_LOGIN_ERR_FAILED');
      if (msg === 'EMAIL_NOT_VERIFIED') {
        setErrorMsg(t('AUTH_LOGIN_ERR_EMAIL_NOT_VERIFIED'));
        if (!AUTO_EMAIL_LOGIN && inputMode === 'email') {
          setTimeout(() => router.replace(`/(auth)/waiting?email=${encodeURIComponent(identifier.trim())}` as any), 800);
        }
      } else if (msg === 'PHONE_NOT_VERIFIED') {
        setErrorMsg(t('AUTH_LOGIN_ERR_PHONE_NOT_VERIFIED'));
        setTimeout(() => router.replace(`/(auth)/phone-otp?phone=${encodeURIComponent(identifier.trim())}` as any), 800);
      } else {
        setErrorMsg(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg }} edges={['top', 'bottom']}>
        <TouchableOpacity onPress={toggleLanguage} style={[styles.langToggle, { top: insets.top + 8 }]}>
          <Text style={styles.langToggleText}>{lang === 'vi' ? 'Tiếng Việt' : 'English'}</Text>
        </TouchableOpacity>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.container, { paddingBottom: 24 + (insets?.bottom ?? 0) }]}
        >
          <View style={styles.logoWrapper}>
            <ExpoImage source={ICONS.app_icon} style={styles.logo} contentFit="contain" />
            <Text style={styles.appTitle}>{t('AUTH_APP_TITLE')}</Text>
          </View>

          <View style={styles.formWrapper}>
            <Text style={styles.formTitle}>{t('AUTH_LOGIN_TITLE')}</Text>

            <TextInput
              placeholder={t('AUTH_LOGIN_PLACEHOLDER_EMAIL_PHONE')}
              placeholderTextColor={COLORS.dark300}
              value={identifier}
              onChangeText={handleIdentifierChange}
              autoCapitalize="none"
              keyboardType={inputMode === 'phone' ? 'phone-pad' : 'email-address'}
              style={styles.input}
            />

            <View style={styles.passwordRow}>
              <TextInput
                placeholder={t('AUTH_PLACEHOLDER_PASSWORD')}
                placeholderTextColor="#6A6B6B"
                secureTextEntry={!passwordVisible}
                value={password}
                onChangeText={setPassword}
                style={styles.passwordInput}
              />
              <Pressable onPress={() => setPasswordVisible(!passwordVisible)}>
                <ExpoImage source={passwordVisible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
              </Pressable>
            </View>

            <View style={styles.optionsRow}>
              <Pressable onPress={() => setRememberMe(!rememberMe)} style={styles.rememberMePressable}>
                <View style={[styles.checkboxBase, rememberMe && styles.checkboxChecked]}>
                  {rememberMe && (<ExpoImage source={ICONS.checkSmall} style={styles.checkboxTick} />)}
                </View>
                <Text style={styles.textDark}>{t('AUTH_LABEL_REMEMBER_ME')}</Text>
              </Pressable>
              <Link href="/(auth)/forgotpassword">
                <Text style={styles.forgotPassword}>{t('AUTH_LINK_FORGOT_PASSWORD')}</Text>
              </Link>
            </View>

            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

            <TouchableOpacity
              disabled={loading}
              onPress={handleLogin}
              style={[styles.loginButton, loading && { opacity: 0.7 }]}
            >
              <Text style={styles.loginButtonText}>{loading ? t('AUTH_LOGIN_BTN_SIGNING_IN') : t('AUTH_LOGIN_BTN_LOGIN')}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, styles.mr3]} />
            <Text style={styles.dividerText}>{t('AUTH_DIVIDER_OR_LOGIN_WITH')}</Text>
            <View style={[styles.dividerLine, styles.ml3]} />
          </View>

          <View style={styles.socialRow}>
            <GoogleSignInButton />
            <ZaloSignInButton
              onAuthStart={() => setZaloAuthLoading(true)}
              onAuthDone={() => setZaloAuthLoading(false)}
            />
            <AppleSignInButton />
          </View>

          <View style={styles.signupRow}>
            <Text style={styles.textDark}>{t('AUTH_LOGIN_LINK_NO_ACCOUNT')}</Text>
            <Link href="/(auth)/signup"><Text style={styles.signUpLink}>{t('AUTH_LINK_SIGN_UP')}</Text></Link>
          </View>
        </ScrollView>

        {/* Full-screen Zalo auth guard — rendered OUTSIDE the ScrollView so it
            covers the entire screen without creating a separate Android window
            (using <Modal> causes the black-screen flash on OPPO/ColorOS when
            the Chrome Custom Tab closes and the surface briefly goes invalid). */}
        {zaloAuthLoading && (
          <View
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: '#fff',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 999,
              elevation: 10,
            }}
            pointerEvents="box-only"
          >
            <ActivityIndicator size="large" color="#0068FF" />
          </View>
        )}
      </SafeAreaView>
    </>
  );
}

const COLORS = {
  dark300: '#6A6B6B',
  green700: '#FF6017',
  green800: '#FF8147',
  white: '#ffffff',
  blue600: '#2563eb',
  red600: '#dc2626',
  bg: '#f8f8f8',
};

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 28,
    paddingTop: 80,
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: { width: 80, height: 80, borderRadius: 20, overflow: 'hidden' },
  appTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.green700,
    marginTop: 8,
    letterSpacing: 0.5,
  },
  formWrapper: {},
  formTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.dark300,
    marginBottom: 24,
    textAlign: 'center',
  },
  input: {
    width: '100%',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginBottom: 16,
    color: COLORS.dark300,
  },
  passwordRow: {
    width: '100%',
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.dark300,
    paddingRight: 12,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    color: COLORS.dark300,
  },
  eyeIcon: { width: 24, height: 24, tintColor: COLORS.dark300 },
  optionsRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  rememberMePressable: { flexDirection: 'row', alignItems: 'center' },
  checkboxBase: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: COLORS.green700,
    borderColor: COLORS.green700,
  },
  checkboxTick: { width: 20, height: 20, tintColor: COLORS.white },
  textDark: { color: COLORS.dark300 },
  forgotPassword: { color: COLORS.green700, fontWeight: '600' },
  loginButton: {
    backgroundColor: COLORS.green700,
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
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
    fontSize: 18,
  },
  errorText: {
    color: COLORS.red600,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginTop: 32,
    marginBottom: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.dark300, opacity: 0.3 },
  dividerText: { color: COLORS.dark300, fontSize: 14 },
  mr3: { marginRight: 12 },
  ml3: { marginLeft: 12 },
  socialRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    marginBottom: 32,
  },
  signupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 4,
    marginBottom: 40,
  },
  signUpLink: {
    color: COLORS.green700,
    fontWeight: '700',
  },
  langToggle: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    backgroundColor: COLORS.white,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.dark300,
  },
  langToggleText: {
    color: COLORS.dark300,
    fontWeight: '600',
    fontSize: 13,
  },
});

