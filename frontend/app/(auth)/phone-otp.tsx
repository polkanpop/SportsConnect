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
import { authPhoneLogin, persistAuthSession } from '@/lib/backendApi';
import { initFavoritesForCurrentUser } from '@/storage/favorites';
import { queryClient } from '@/providers/query-provider';
import { queryKeys } from '@/hooks/query-keys';

// Vietnam mobile: 10 digits, leading 0, second digit 3–9
const VN_PHONE_RE = /^0[3-9]\d{8}$/;

function normalizeVNPhone(raw: string): string {
  return '+84' + raw.slice(1);
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
  const params = useLocalSearchParams<{ phone?: string; name?: string; username?: string }>();

  // Pre-fill from params (signup flow) OR let user type a fresh number
  const [phone, setPhone]           = useState(params.phone ?? '');
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

  const startResendTimer = () => {
    setResendTimer(60);
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
      setError('Enter a valid Vietnamese phone number (e.g. 0912345678).');
      return;
    }
    setError(null);
    setSending(true);
    try {
      const e164 = normalizeVNPhone(trimmed);
      const confirmation = await auth().signInWithPhoneNumber(e164);
      confirmRef.current = confirmation;
      setOtpSent(true);
      startResendTimer();
    } catch (e: any) {
      console.error('[PhoneOtp] sendOtp error', e);
      setError(e?.message ?? 'Failed to send OTP. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.length < 6) {
      setError('Enter the 6-digit code from your SMS.');
      return;
    }
    if (!confirmRef.current) {
      setError('Session expired. Please resend the code.');
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      const credential = await confirmRef.current.confirm(otp);
      if (!credential?.user) throw new Error('Firebase verification returned no user.');

      const firebaseIdToken = await credential.user.getIdToken();

      // Exchange Firebase ID token for our backend session
      const res = await authPhoneLogin({
        firebase_id_token: firebaseIdToken,
        display_name: displayName || undefined,
      });

      await persistAuthSession(res, { rememberMe: true });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.userId] });
      try { await initFavoritesForCurrentUser(); } catch {}

      router.replace('/(tabs)/Home');
    } catch (e: any) {
      console.error('[PhoneOtp] verify error', e);
      // Firebase invalid-verification-code
      if (e?.code === 'auth/invalid-verification-code') {
        setError('Incorrect code. Please check your SMS and try again.');
      } else if (e?.code === 'auth/code-expired') {
        setError('Code expired. Please request a new one.');
      } else {
        setError(e?.message ?? 'Verification failed. Please try again.');
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
              <Text style={styles.backText}>← Back</Text>
            </Pressable>

            <Text style={styles.title}>Phone Verification</Text>
            <Text style={styles.subtitle}>
              {otpSent
                ? `Enter the 6-digit code sent to ${phone}`
                : 'Enter your phone number to receive a verification code'}
            </Text>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {/* ── Phone input ── */}
            {!otpSent ? (
              <>
                <Text style={styles.label}>Phone Number</Text>
                <TextInput
                  placeholder="e.g. 0912345678"
                  placeholderTextColor={COLOR.dark300}
                  value={phone}
                  onChangeText={(t) => { setPhone(t); setError(null); }}
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
                    <Text style={styles.primaryBtnText}>Send OTP</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                {/* ── OTP input ── */}
                <Text style={styles.label}>Verification Code</Text>
                <TextInput
                  placeholder="6-digit code"
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
                    <Text style={styles.primaryBtnText}>Verify & Continue</Text>
                  )}
                </TouchableOpacity>

                {/* Resend */}
                <View style={styles.resendRow}>
                  {resendTimer > 0 ? (
                    <Text style={styles.resendTimer}>Resend in {resendTimer}s</Text>
                  ) : (
                    <Pressable onPress={handleSendOtp} disabled={sending}>
                      <Text style={styles.resendLink}>
                        {sending ? 'Sending…' : 'Resend code'}
                      </Text>
                    </Pressable>
                  )}
                  <Text style={styles.separatorDot}> · </Text>
                  <Pressable onPress={() => { setOtpSent(false); setOtp(''); setError(null); }}>
                    <Text style={styles.resendLink}>Change number</Text>
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
