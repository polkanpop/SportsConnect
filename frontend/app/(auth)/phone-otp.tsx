import React, { useRef, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authPhoneLogin, persistAuthSession, verifyPhoneAddition } from '@/lib/backendApi';
import { initFavoritesForCurrentUser } from '@/storage/favorites';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';
import { useTranslation } from '@/constants/translations';

const OTP_DRAFT_KEY = '@phoneOtp:draft';

// Vietnam mobile: 10 digits, leading 0, second digit 3–9
const VN_PHONE_RE = /^0[3-9]\d{8}$/;

function normalizeVNPhone(raw: string): string {
  return '+84' + raw.slice(1);
}

// Convert E.164 (+84xxxxxxxxx) back to local format (0xxxxxxxxx) for the input field.
// The backend stores phones in E.164; users see and type local format.
function toLocalPhone(input: string): string {
  const t = input.trim();
  if (t.startsWith('+84') && t.length === 12) return '0' + t.slice(3);
  return t;
}

// ─── Module-level OTP cache ──────────────────────────────────────────────────
// Survives navigation (component unmount/remount) within the same JS process.
// Prevents users having to re-send OTP if they accidentally navigate away.
// Cleared after successful verification or when TTL expires.
const OTP_CACHE_TTL = 3 * 60 * 1000 // 3 min
interface _PendingOtp {
  // confirmation is kept for legacy compatibility but is not used in verifyPhoneNumber flow
  confirmation: FirebaseAuthTypes.ConfirmationResult | null
  e164Phone: string
  sentAt: number
}
let _pendingOtp: _PendingOtp | null = null
function _getCachedOtp(e164Phone: string): _PendingOtp | null {
  if (!_pendingOtp) return null
  if (_pendingOtp.e164Phone !== e164Phone) return null
  if (Date.now() - _pendingOtp.sentAt > OTP_CACHE_TTL) { _pendingOtp = null; return null }
  return _pendingOtp
}

// ─── Colors ──────────────────────────────────────────────────────────────────
const COLOR = {
  brand:    '#FF6017',
  dark300:  '#6A6B6B',
  white:    '#ffffff',
  red:      '#dc2626',
  bg:       '#f8f8f8',
  border:   '#D1D5DB',
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function PhoneOtpScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ phone?: string; name?: string; username?: string; mode?: string }>();

  // Pre-fill from params (signup flow) OR let user type a fresh number.
  // toLocalPhone converts +84xxx → 0xxx so the regex validator works correctly.
  const [phone, setPhone]           = useState(toLocalPhone(params.phone ?? ''));

  // Restore persisted draft phone number when navigating back without params
  useEffect(() => {
    if (params.phone) {
      const localPhone = toLocalPhone(params.phone);
      AsyncStorage.setItem(OTP_DRAFT_KEY, localPhone).catch(() => {});
      // Restore cached confirmation so user can resume without re-sending OTP
      if (VN_PHONE_RE.test(localPhone)) {
        const e164 = normalizeVNPhone(localPhone);
        const cached = _getCachedOtp(e164);
        if (cached) {
          setOtpSent(true);
          const elapsed = Math.floor((Date.now() - cached.sentAt) / 1000);
          const remaining = Math.max(0, 60 - elapsed);
          if (remaining > 0) startResendTimer(remaining);
        }
      }
    } else {
      AsyncStorage.getItem(OTP_DRAFT_KEY)
        .then(val => { if (val) setPhone(toLocalPhone(val)); })
        .catch(() => {});
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [displayName]               = useState(params.name ?? '');
  const [otpSent, setOtpSent]       = useState(false);
  const [otp, setOtp]               = useState('');
  const [sending, setSending]       = useState(false);
  const [verifying, setVerifying]   = useState(false);
  const [resendTimer, setResendTimer] = useState(0);
  const [error, setError]           = useState<string | null>(null);

  const confirmRef       = useRef<FirebaseAuthTypes.ConfirmationResult | null>(null);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const credentialRef    = useRef<FirebaseAuthTypes.AuthCredential | null>(null);
  const verificationIdRef = useRef<string | null>(null);
  const [autoVerified, setAutoVerified] = useState(false);

  // Countdown for resend
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startResendTimer = (startAt = 60) => {
    setResendTimer(startAt);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  };

  const handleSendOtp = async () => {
    const trimmed = phone.trim();
    if (!VN_PHONE_RE.test(trimmed)) {
      setError(t('AUTH_OTP_ERR_INVALID_PHONE'));
      return;
    }
    setError(null);
    setSending(true);
    // Reset any prior session state
    credentialRef.current = null;
    verificationIdRef.current = null;
    setAutoVerified(false);

    const e164 = normalizeVNPhone(trimmed);

    try {
      auth().verifyPhoneNumber(e164).on(
        'state_changed',
        (phoneAuthSnapshot) => {
          switch (phoneAuthSnapshot.state) {
            case auth.PhoneAuthState.CODE_SENT:
              // SMS sent — show OTP input for manual entry
              confirmRef.current = null;
              credentialRef.current = null;
              verificationIdRef.current = phoneAuthSnapshot.verificationId;
              _pendingOtp = { confirmation: null, e164Phone: e164, sentAt: Date.now() };
              setSending(false);
              setOtpSent(true);
              startResendTimer();
              break;

            case auth.PhoneAuthState.AUTO_VERIFIED:
              // Android SMS Retriever auto-read the code — Firebase already signed the user in
              // internally. Do NOT call signInWithCredential again (credential is consumed).
              // Instead useCurrentUser=true path reads auth().currentUser directly.
              verificationIdRef.current = phoneAuthSnapshot.verificationId;
              setSending(false);
              setOtpSent(true);
              setAutoVerified(true);
              handleVerifyWithCredential(null, true);
              break;

            case auth.PhoneAuthState.ERROR:
              setSending(false);
              const errMsg: string = (phoneAuthSnapshot as any).error?.message ?? '';
              if (/BILLING_NOT_ENABLED|billing[\-_]not/i.test(errMsg)) {
                setError('Dịch vụ xác thực SMS chưa sẵn sàng. Vui lòng đăng nhập bằng mật khẩu hoặc Zalo.');
              } else {
                setError(errMsg || t('AUTH_OTP_ERR_SEND_FAILED'));
              }
              break;
          }
        },
        (error: any) => {
          setSending(false);
          const errMsg: string = error?.message ?? '';
          if (/BILLING_NOT_ENABLED|billing[\-_]not/i.test(errMsg)) {
            setError('Dịch vụ xác thực SMS chưa sẵn sàng. Vui lòng đăng nhập bằng mật khẩu hoặc Zalo.');
          } else {
            setError(errMsg || t('AUTH_OTP_ERR_SEND_FAILED'));
          }
        }
      );
    } catch (e: any) {
      console.error('[PhoneOtp] sendOtp error', e);
      setSending(false);
      const msg: string = e?.message ?? '';
      if (/BILLING_NOT_ENABLED|billing[\-_]not/i.test(msg)) {
        setError('Dịch vụ xác thực SMS chưa sẵn sàng. Vui lòng đăng nhập bằng mật khẩu hoặc Zalo.');
      } else {
        setError(msg || t('AUTH_OTP_ERR_SEND_FAILED'));
      }
    }
  };

  // Shared verification logic — used by both auto-verified and manual entry paths.
  // useCurrentUser=true: Firebase already signed in via AUTO_VERIFIED — read auth().currentUser.
  // useCurrentUser=false (default): manual entry — call signInWithCredential.
  const handleVerifyWithCredential = async (
    credential: FirebaseAuthTypes.AuthCredential | null,
    useCurrentUser = false
  ) => {
    setError(null);
    setVerifying(true);
    try {
      let firebaseUser: FirebaseAuthTypes.User | null;

      if (useCurrentUser) {
        // AUTO_VERIFIED: Firebase signs the user in internally before the callback fires,
        // but there is a race condition — currentUser may be null for a few hundred ms.
        // Poll up to 10 × 500ms (5s total) before giving up.
        let attempts = 0;
        while (attempts < 10) {
          firebaseUser = auth().currentUser;
          if (firebaseUser) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          attempts++;
        }
        console.log(`[PhoneOtp] AUTO_VERIFIED poll done: attempts=${attempts}, user=${firebaseUser?.uid ?? 'null'}`);
      } else {
        const result = await auth().signInWithCredential(credential!);
        firebaseUser = result?.user ?? null;
      }

      if (!firebaseUser) throw new Error(t('AUTH_OTP_ERR_NO_USER'));

      const firebaseIdToken = await firebaseUser.getIdToken();
      if (!firebaseIdToken) throw new Error('Failed to get Firebase ID token');

      if (params.mode === 'add_phone') {
        await verifyPhoneAddition(firebaseIdToken);
        queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
        AsyncStorage.removeItem(OTP_DRAFT_KEY).catch(() => {});
        _pendingOtp = null;
        router.back();
      } else {
        const res = await authPhoneLogin({
          firebase_id_token: firebaseIdToken,
          display_name: displayName || undefined,
        });
        await persistAuthSession(res, { rememberMe: true });
        queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
        try { await initFavoritesForCurrentUser(); } catch {}
        AsyncStorage.removeItem(OTP_DRAFT_KEY).catch(() => {});
        _pendingOtp = null;
        router.replace('/(tabs)/Home');
      }
    } catch (e: any) {
      console.error('[PhoneOtp] verify error', e);
      const errCode: string = e?.code ?? e?.userInfo?.code ?? '';
      const errMsg: string = e?.message ?? '';
      const isExpired =
        errCode === 'auth/code-expired' ||
        errCode === 'auth/session-expired' ||
        errMsg.includes('session-expired') ||
        errMsg.includes('code-expired');
      const isWrongCode =
        errCode === 'auth/invalid-verification-code' ||
        errMsg.includes('invalid-verification-code');
      if (isWrongCode) {
        setError(t('AUTH_OTP_ERR_WRONG_CODE'));
      } else if (isExpired) {
        _pendingOtp = null;
        confirmRef.current = null;
        credentialRef.current = null;
        verificationIdRef.current = null;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setResendTimer(0);
        setOtp('');
        setAutoVerified(false);
        setError('Mã xác thực đã hết hạn. Nhấn Gửi lại để nhận mã mới.');
      } else {
        setError(e?.message ?? t('AUTH_OTP_ERR_FAILED'));
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length < 6) {
      setError(t('AUTH_OTP_ERR_ENTER_CODE'));
      return;
    }
    // Manual entry: build credential from verificationId + user-entered OTP
    if (!verificationIdRef.current) {
      setError(t('AUTH_OTP_ERR_SESSION_EXPIRED'));
      return;
    }
    const credential = auth.PhoneAuthProvider.credential(
      verificationIdRef.current,
      otp
    );
    await handleVerifyWithCredential(credential);
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: COLOR.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Back */}
            <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
              <Text style={styles.backText}>{t('AUTH_OTP_BACK')}</Text>
            </Pressable>

            <Text style={styles.title}>{t('AUTH_OTP_TITLE')}</Text>
            <Text style={styles.subtitle}>
              {otpSent
                ? `${t('AUTH_OTP_SUBTITLE_SENT_PREFIX')}${phone}`
                : t('AUTH_OTP_SUBTITLE_PRE')}
            </Text>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {/* ── Phone input ── */}
            {!otpSent ? (
              <>
                <Text style={styles.label}>{t('AUTH_OTP_LABEL_PHONE')}</Text>
                <TextInput
                  placeholder={t('AUTH_OTP_PLACEHOLDER_PHONE')}
                  placeholderTextColor={COLOR.dark300}
                  value={phone}
                  onChangeText={(text) => { setPhone(text); setError(null); AsyncStorage.setItem(OTP_DRAFT_KEY, text).catch(() => {}); }}
                  keyboardType="phone-pad"
                  style={styles.input}
                  maxLength={10}
                  editable={!sending}
                />
                <TouchableOpacity
                  onPress={handleSendOtp}
                  disabled={sending}
                  style={[styles.primaryBtn, sending && { opacity: 0.7 }]}
                  activeOpacity={0.85}
                >
                  {sending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryBtnText}>{t('AUTH_OTP_BTN_SEND')}</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                {/* ── OTP input ── */}
                <Text style={styles.label}>{t('AUTH_OTP_LABEL_CODE')}</Text>
                <TextInput
                  placeholder={t('AUTH_OTP_PLACEHOLDER_CODE')}
                  placeholderTextColor={COLOR.dark300}
                  value={otp}
                  onChangeText={(t) => { setOtp(t.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                  keyboardType="number-pad"
                  style={[styles.input, styles.otpInput]}
                  maxLength={6}
                  editable={!verifying}
                />

                <TouchableOpacity
                  onPress={handleVerifyOtp}
                  disabled={verifying || otp.length < 6}
                  style={[styles.primaryBtn, (verifying || otp.length < 6) && { opacity: 0.7 }]}
                  activeOpacity={0.85}
                >
                  {verifying ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryBtnText}>{t('AUTH_OTP_BTN_VERIFY')}</Text>
                  )}
                </TouchableOpacity>

                {/* Resend */}
                <View style={styles.resendRow}>
                  {resendTimer > 0 ? (
                    <Text style={styles.resendTimer}>{`${t('AUTH_OTP_RESEND_TIMER_PREFIX')}${resendTimer}${t('AUTH_OTP_RESEND_TIMER_SUFFIX')}`}</Text>
                  ) : (
                    <Pressable onPress={handleSendOtp} disabled={sending}>
                      <Text style={styles.resendLink}>
                        {sending ? t('AUTH_OTP_BTN_SENDING') : t('AUTH_OTP_BTN_RESEND')}
                      </Text>
                    </Pressable>
                  )}
                  <Text style={styles.separatorDot}> · </Text>
                  <Pressable onPress={() => { setOtpSent(false); setOtp(''); setError(null); }}>
                    <Text style={styles.resendLink}>{t('AUTH_OTP_CHANGE_NUMBER')}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 28,
    paddingTop: 24,
    paddingBottom: 48,
  },
  backBtn: {
    marginBottom: 20,
  },
  backText: {
    color: COLOR.brand,
    fontWeight: '600',
    fontSize: 15,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: COLOR.brand,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: COLOR.dark300,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 20,
  },
  errorText: {
    color: COLOR.red,
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: COLOR.dark300,
    marginBottom: 6,
  },
  input: {
    width: '100%',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLOR.border,
    marginBottom: 20,
    color: '#111',
    fontSize: 16,
  },
  otpInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: COLOR.brand,
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
    marginBottom: 16,
  },
  primaryBtnText: {
    color: COLOR.white,
    fontWeight: '700',
    fontSize: 17,
  },
  resendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  resendTimer: {
    color: COLOR.dark300,
    fontSize: 14,
  },
  resendLink: {
    color: COLOR.brand,
    fontWeight: '600',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  separatorDot: {
    color: COLOR.dark300,
    fontSize: 14,
  },
});
