import { ICONS } from '@/constants/icons'
import { router } from 'expo-router'
import React, { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { signupSchema, SignupFormData, isPhoneInput } from '@/lib/signupSchema'
import zxcvbn from 'zxcvbn'
import { authSignup } from '@/lib/backendApi'
import { AUTO_EMAIL_LOGIN } from '@/env'
import { requestLocationPermissionOnceAfterSignup } from '@/lib/locationOnboarding'

// ─── Local alias for hook-form generic ───────────────────────────────────────
type FormData = SignupFormData

// ─── Strength display config ──────────────────────────────────────────────────
const STRENGTH: { label: string; color: string }[] = [
  { label: 'Very Weak', color: '#dc2626' },
  { label: 'Weak',      color: '#f97316' },
  { label: 'Fair',      color: '#eab308' },
  { label: 'Good',      color: '#84cc16' },
  { label: 'Strong',    color: '#22c55e' },
]

// ─── Component ────────────────────────────────────────────────────────────────
export default function SignUpScreen() {
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [confirmVisible, setConfirmVisible]   = useState(false)
  const [generalError, setGeneralError]       = useState('')
  const [successMessage, setSuccessMessage]   = useState('')

  const {
    control,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      accountName: '',
      username: '',
      emailOrPhone: '',
      password: '',
      confirmPassword: '',
      agree: false,
    },
  })

  const emailOrPhoneValue = watch('emailOrPhone') ?? ''
  const isPhone = isPhoneInput(emailOrPhoneValue)

  const passwordValue  = watch('password') ?? ''
  const strengthResult = useMemo(
    () => (passwordValue && !isPhone ? zxcvbn(passwordValue) : null),
    [passwordValue, isPhone],
  )

  const onSubmit = async (data: FormData) => {
    setGeneralError('')
    setSuccessMessage('')

    // Phone number → navigate to Firebase OTP screen
    if (isPhoneInput(data.emailOrPhone)) {
      router.push(
        `/(auth)/phone-otp?phone=${encodeURIComponent(data.emailOrPhone.trim())}&name=${encodeURIComponent(data.accountName.trim())}&username=${encodeURIComponent(data.username.trim())}` as any
      )
      return
    }

    try {
      const res = await authSignup({
        username: data.username.trim(),
        email:    data.emailOrPhone.trim(),
        password: data.password ?? '',
        accountName: data.accountName.trim(),
      })
      await requestLocationPermissionOnceAfterSignup()
      if (res?.merged) {
        setSuccessMessage('Google account linked! You can now sign in.')
        setTimeout(() => router.replace('/(auth)/login'), 1800)
        return
      }
      setSuccessMessage('Account created. Please verify your email to continue.')
      if (!AUTO_EMAIL_LOGIN) {
        setTimeout(
          () => router.replace(`/(auth)/waiting?email=${encodeURIComponent(data.emailOrPhone.trim())}` as any),
          1200,
        )
      }
    } catch (err: any) {
      setGeneralError(err.message || 'Signup failed')
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLOR.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Header ── */}
          <Text style={styles.screenTitle}>Sign Up</Text>
          <Text style={styles.subtitle}>Create your SportConnect account</Text>

          {generalError   ? <Text style={styles.feedbackError}>{generalError}</Text>   : null}
          {successMessage ? <Text style={styles.feedbackSuccess}>{successMessage}</Text> : null}

          {/* ── Display Name ── */}
          <Text style={styles.label}>Display Name</Text>
          <Controller
            control={control}
            name="accountName"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder="Display Name"
                placeholderTextColor={COLOR.dark300}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                autoCapitalize="words"
                style={[styles.input, !!errors.accountName && styles.inputError]}
              />
            )}
          />
          {errors.accountName && <Text style={styles.fieldError}>{errors.accountName.message}</Text>}

          {/* ── Username ── */}
          <Text style={styles.label}>Username</Text>
          <Controller
            control={control}
            name="username"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder="Username"
                placeholderTextColor={COLOR.dark300}
                value={value}
                onChangeText={(t) => onChange(t.toLowerCase())}
                onBlur={onBlur}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, !!errors.username && styles.inputError]}
              />
            )}
          />
          {errors.username && <Text style={styles.fieldError}>{errors.username.message}</Text>}

          {/* ── Email or Phone Number ── */}
          <Text style={styles.label}>Email or Phone Number</Text>
          <Controller
            control={control}
            name="emailOrPhone"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder="Email or Phone Number"
                placeholderTextColor={COLOR.dark300}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                keyboardType="default"
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, !!errors.emailOrPhone && styles.inputError]}
              />
            )}
          />
          {errors.emailOrPhone && <Text style={styles.fieldError}>{errors.emailOrPhone.message}</Text>}

          {/* Phone mode hint */}
          {isPhone && (
            <Text style={styles.phoneHint}>
              📱 You'll verify your number via SMS — no password needed.
            </Text>
          )}

          {/* ── Password (email mode only) ── */}
          {!isPhone && (
            <>
              <Text style={styles.label}>Password</Text>
              <Controller
                control={control}
                name="password"
                render={({ field: { onChange, onBlur, value } }) => (
                  <View style={[styles.passwordRow, !!errors.password && styles.inputRowError]}>
                    <TextInput
                      placeholder="Password"
                      placeholderTextColor={COLOR.dark300}
                      secureTextEntry={!passwordVisible}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      style={styles.passwordInput}
                    />
                    <Pressable onPress={() => setPasswordVisible((p) => !p)} hitSlop={8}>
                      <Image
                        source={passwordVisible ? ICONS.notEye : ICONS.eye}
                        style={styles.eyeIcon}
                      />
                    </Pressable>
                  </View>
                )}
              />

              {/* Strength bar */}
              {strengthResult != null && (
                <View style={styles.strengthWrapper}>
                  <View style={styles.strengthTrack}>
                    {[0, 1, 2, 3].map((i) => (
                      <View
                        key={i}
                        style={[
                          styles.strengthSegment,
                          i < strengthResult.score
                            ? { backgroundColor: STRENGTH[strengthResult.score].color }
                            : { backgroundColor: COLOR.segmentEmpty },
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.strengthLabel, { color: STRENGTH[strengthResult.score].color }]}>
                    {STRENGTH[strengthResult.score].label}
                  </Text>
                </View>
              )}
              {errors.password && <Text style={styles.fieldError}>{errors.password.message}</Text>}

              {/* ── Confirm Password ── */}
              <Text style={styles.label}>Confirm Password</Text>
              <Controller
                control={control}
                name="confirmPassword"
                render={({ field: { onChange, onBlur, value } }) => (
                  <View style={[styles.passwordRow, !!errors.confirmPassword && styles.inputRowError]}>
                    <TextInput
                      placeholder="Confirm Password"
                      placeholderTextColor={COLOR.dark300}
                      secureTextEntry={!confirmVisible}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      style={styles.passwordInput}
                    />
                    <Pressable onPress={() => setConfirmVisible((p) => !p)} hitSlop={8}>
                      <Image
                        source={confirmVisible ? ICONS.notEye : ICONS.eye}
                        style={styles.eyeIcon}
                      />
                    </Pressable>
                  </View>
                )}
              />
              {errors.confirmPassword && <Text style={styles.fieldError}>{errors.confirmPassword.message}</Text>}
            </>
          )}

          {/* ── Terms checkbox ── */}
          <Controller
            control={control}
            name="agree"
            render={({ field: { onChange, value } }) => (
              <Pressable onPress={() => onChange(!value)} style={styles.checkboxRow}>
                <View style={[styles.checkboxBase, value && styles.checkboxChecked]}>
                  {value && <Image source={ICONS.checkSmall} style={styles.checkboxTick} />}
                </View>
                <Text style={styles.textDark}>
                  I agree with{' '}
                  <Text
                    style={styles.termsLink}
                    onPress={(e) => {
                      e.stopPropagation()
                      Linking.openURL('https://sportconnects.org/terms')
                    }}
                  >
                    Terms of Service
                  </Text>
                </Text>
              </Pressable>
            )}
          />
          {errors.agree && <Text style={styles.fieldError}>{errors.agree.message}</Text>}

          {/* ── Submit ── */}
          <TouchableOpacity
            onPress={handleSubmit(onSubmit)}
            disabled={isSubmitting}
            style={[styles.submitButton, isSubmitting && styles.submitButtonLoading]}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitButtonText}>Sign Up</Text>
            )}
          </TouchableOpacity>

          {/* ── Footer ── */}
          <View style={styles.footerRow}>
            <Text style={styles.textDark}>Already have an account?</Text>
            <Pressable onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.footerLink}> Sign in</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

// ─── Color tokens ─────────────────────────────────────────────────────────────
const COLOR = {
  dark300:      '#6A6B6B',
  brand:        '#FF6017',
  brandLight:   '#FF8147',
  white:        '#ffffff',
  red:          '#dc2626',
  bg:           '#f8f8f8',
  borderBase:   '#D1D5DB',
  segmentEmpty: '#E5E7EB',
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 28,
    paddingTop: 52,
    paddingBottom: 48,
  },
  screenTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: COLOR.brand,
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: COLOR.dark300,
    textAlign: 'center',
    marginBottom: 28,
  },
  feedbackError: {
    color: COLOR.red,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
  feedbackSuccess: {
    color: COLOR.brand,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
  phoneHint: {
    fontSize: 13,
    color: COLOR.brand,
    marginBottom: 16,
    marginTop: 2,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: COLOR.dark300,
    marginBottom: 4,
  },
  input: {
    width: '100%',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLOR.borderBase,
    marginBottom: 4,
    color: '#111',
    fontSize: 15,
  },
  inputError: {
    borderColor: COLOR.red,
  },
  passwordRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLOR.borderBase,
    paddingRight: 12,
    marginBottom: 4,
  },
  inputRowError: {
    borderColor: COLOR.red,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    color: '#111',
    fontSize: 15,
  },
  eyeIcon: {
    width: 22,
    height: 22,
    tintColor: COLOR.dark300,
  },

  // ── Strength bar
  strengthWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    columnGap: 8,
  },
  strengthTrack: {
    flex: 1,
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    columnGap: 4,
  },
  strengthSegment: {
    flex: 1,
    borderRadius: 3,
  },
  strengthLabel: {
    fontSize: 12,
    fontWeight: '600',
    minWidth: 64,
    textAlign: 'right',
  },

  fieldError: {
    color: COLOR.red,
    fontSize: 12,
    marginBottom: 10,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 4,
  },
  checkboxBase: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: COLOR.dark300,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: COLOR.brand,
    borderColor: COLOR.brand,
  },
  checkboxTick: {
    width: 12,
    height: 12,
    tintColor: COLOR.white,
  },
  textDark: {
    color: COLOR.dark300,
    fontSize: 14,
  },
  termsLink: {
    color: COLOR.brand,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  submitButton: {
    backgroundColor: COLOR.brand,
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
  submitButtonLoading: {
    backgroundColor: COLOR.brandLight,
  },
  submitButtonText: {
    color: COLOR.white,
    fontWeight: '700',
    fontSize: 16,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 8,
  },
  footerLink: {
    color: COLOR.brand,
    fontWeight: '700',
    fontSize: 14,
  },
})