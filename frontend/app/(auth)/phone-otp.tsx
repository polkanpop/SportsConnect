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

// ─── Module-level OTP cache ──────────────────────────────────────────────────
// Survives navigation (component unmount/remount) within the same JS process.
// Prevents users having to re-send OTP if they accidentally navigate away.
// Cleared after successful verification or when TTL expires.
const OTP_CACHE_TTL = 5 * 60 * 1000 // 5 min — Firebase SMS code lifetime
interface _PendingOtp {
  confirmation: FirebaseAuthTypes.ConfirmationResult
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

  // Pre-fill from params (signup flow) OR let user type a fresh number
  const [phone, setPhone]           = useState(params.phone ?? '');

  // Restore persisted draft phone number when navigating back without params
  useEffect(() => {
    if (params.phone) {
      AsyncStorage.setItem(OTP_DRAFT_KEY, params.phone).catch(() => {});
      // Restore cached confirmation so user can resume without re-sending OTP
      const rawPhone = params.phone.trim();
      if (VN_PHONE_RE.test(rawPhone)) {
        const e164 = normalizeVNPhone(rawPhone);
        const cached = _getCachedOtp(e164);
        if (cached) {
          confirmRef.current = cached.confirmation;
          setOtpSent(true);
          const elapsed = Math.floor((Date.now() - cached.sentAt) / 1000);
          const remaining = Math.max(0, 60 - elapsed);
          if (remaining > 0) startResendTimer(remaining);
        }
      }
    } else {
      AsyncStorage.getItem(OTP_DRAFT_KEY)
        .then(val => { if (val) setPhone(val); })
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

  const confirmRef = useRef<FirebaseAuthTypes.ConfirmationResult | null>(null);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);

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
    try {
      const e164 = normalizeVNPhone(trimmed);
      const confirmation = await auth().signInWithPhoneNumber(e164);
      confirmRef.current = confirmation;
      _pendingOtp = { confirmation, e164Phone: e164, sentAt: Date.now() };
      setOtpSent(true);
      startResendTimer();
    } catch (e: any) {
      console.error('[PhoneOtp] sendOtp error', e);
      const msg: string = e?.message ?? '';
      if (/BILLING_NOT_ENABLED|billing[\-_]not/i.test(msg)) {
        setError('Dịch vụ xác thực SMS chưa sẵn sàng. Vui lòng đăng nhập bằng mật khẩu hoặc Zalo.');
      } else {
        setError(msg || t('AUTH_OTP_ERR_SEND_FAILED'));
      }
    } finally {
      setSending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length < 6) {
      setError(t('AUTH_OTP_ERR_ENTER_CODE'));
      return;
    }
    if (!confirmRef.current) {
      setError(t('AUTH_OTP_ERR_SESSION_EXPIRED'));
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      const credential = await confirmRef.current.confirm(otp);
      if (!credential?.user) throw new Error(t('AUTH_OTP_ERR_NO_USER'));

      const firebaseIdToken = await credential.user.getIdToken();

      if (params.mode === 'add_phone') {
        // Authenticated user adding/verifying their phone — do NOT re-login
        await verifyPhoneAddition(firebaseIdToken);
        queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
        AsyncStorage.removeItem(OTP_DRAFT_KEY).catch(() => {});
        _pendingOtp = null;
        router.back();
      } else {
        // Login flow: exchange Firebase ID token for our backend session
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
      if (e?.code === 'auth/invalid-verification-code') {
        setError(t('AUTH_OTP_ERR_WRONG_CODE'));
      } else if (e?.code === 'auth/code-expired' || e?.code === 'auth/session-expired') {
        // Session expired — clear the stale cache and let user resend immediately
        _pendingOtp = null;
        confirmRef.current = null;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setResendTimer(0);
        setOtpSent(false);
        setOtp('');
        setError('Mã xác thực đã hết hạn. Vui lòng gửi lại mã mới.');
      } else {
        setError(e?.message ?? t('AUTH_OTP_ERR_FAILED'));
      }
    } finally {
      setVerifying(false);
    }
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
