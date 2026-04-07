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
import { useTranslation } from '@/constants/translations'
import { useLanguage } from '@/providers/language-provider'
import { useThemeColors } from '@/hooks/use-theme-colors'
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
const STRENGTH_COLORS = ['#dc2626', '#f97316', '#eab308', '#84cc16', '#22c55e']

// ─── Component ────────────────────────────────────────────────────────────────
export default function SignUpScreen() {
  const { t } = useTranslation()
  const { lang } = useLanguage()
  const tc = useThemeColors()
  const STRENGTH = [
    { label: t('AUTH_STRENGTH_VERY_WEAK'), color: STRENGTH_COLORS[0] },
    { label: t('AUTH_STRENGTH_WEAK'),      color: STRENGTH_COLORS[1] },
    { label: t('AUTH_STRENGTH_FAIR'),      color: STRENGTH_COLORS[2] },
    { label: t('AUTH_STRENGTH_GOOD'),      color: STRENGTH_COLORS[3] },
    { label: t('AUTH_STRENGTH_STRONG'),    color: STRENGTH_COLORS[4] },
  ]
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
    mode: 'onBlur',
    reValidateMode: 'onChange',
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
        setSuccessMessage(t('AUTH_SIGNUP_SUCCESS_GOOGLE'))
        setTimeout(() => router.replace('/(auth)/login'), 1800)
        return
      }
      setSuccessMessage(t('AUTH_SIGNUP_SUCCESS_CREATED'))
      if (!AUTO_EMAIL_LOGIN) {
        setTimeout(
          () => router.replace(`/(auth)/waiting?email=${encodeURIComponent(data.emailOrPhone.trim())}` as any),
          1200,
        )
      }
    } catch (err: any) {
      setGeneralError(err.message || t('AUTH_SIGNUP_ERR_FAILED'))
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tc.bgBase }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { backgroundColor: tc.bgBase }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Header ── */}
          <Text style={[styles.screenTitle, { color: tc.brand }]}>{t('AUTH_SIGNUP_TITLE')}</Text>
          <Text style={[styles.subtitle, { color: tc.textSecondary }]}>{t('AUTH_SIGNUP_SUBTITLE')}</Text>

          {generalError   ? <Text style={styles.feedbackError}>{generalError}</Text>   : null}
          {successMessage ? <Text style={styles.feedbackSuccess}>{successMessage}</Text> : null}

          {/* ── Display Name ── */}
          <Text style={[styles.label, { color: tc.textSecondary }]}>{t('AUTH_LABEL_DISPLAY_NAME')}</Text>
          <Controller
            control={control}
            name="accountName"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder={t('AUTH_LABEL_DISPLAY_NAME')}
                placeholderTextColor={tc.placeholder}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                autoCapitalize="words"
                style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.border, color: tc.textPrimary }, !!errors.accountName && styles.inputError]}
              />
            )}
          />
          {errors.accountName && <Text style={styles.fieldError}>{errors.accountName.message}</Text>}

          {/* ── Username ── */}
          <Text style={[styles.label, { color: tc.textSecondary }]}>{t('AUTH_LABEL_USERNAME')}</Text>
          <Controller
            control={control}
            name="username"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder={t('AUTH_LABEL_USERNAME')}
                placeholderTextColor={tc.placeholder}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.border, color: tc.textPrimary }, !!errors.username && styles.inputError]}
              />
            )}
          />
          {errors.username && <Text style={styles.fieldError}>{errors.username.message}</Text>}

          {/* ── Email or Phone Number ── */}
          <Text style={[styles.label, { color: tc.textSecondary }]}>{t('AUTH_LABEL_EMAIL_OR_PHONE')}</Text>
          <Controller
            control={control}
            name="emailOrPhone"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                placeholder={t('AUTH_LABEL_EMAIL_OR_PHONE')}
                placeholderTextColor={tc.placeholder}
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                keyboardType="default"
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.border, color: tc.textPrimary }, !!errors.emailOrPhone && styles.inputError]}
              />
            )}
          />
          {errors.emailOrPhone && <Text style={styles.fieldError}>{errors.emailOrPhone.message}</Text>}

          {/* Phone mode hint */}
          {isPhone && (
            <Text style={styles.phoneHint}>
              {t('AUTH_SIGNUP_PHONE_HINT')}
            </Text>
          )}

          {/* ── Password (email mode only) ── */}
          {!isPhone && (
            <>
              <Text style={[styles.label, { color: tc.textSecondary }]}>{t('AUTH_LABEL_PASSWORD')}</Text>
              <Controller
                control={control}
                name="password"
                render={({ field: { onChange, onBlur, value } }) => (
                  <View style={[styles.passwordRow, { backgroundColor: tc.bgInput, borderColor: tc.border }, !!errors.password && styles.inputRowError]}>
                    <TextInput
                      placeholder={t('AUTH_LABEL_PASSWORD')}
                      placeholderTextColor={tc.placeholder}
                      secureTextEntry={!passwordVisible}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      style={[styles.passwordInput, { color: tc.textPrimary }]}
                    />
                    <Pressable onPress={() => setPasswordVisible((p) => !p)} hitSlop={8}>
                      <Image
                        source={passwordVisible ? ICONS.notEye : ICONS.eye}
                        style={[styles.eyeIcon, { tintColor: tc.textMuted }]}
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
              <Text style={[styles.label, { color: tc.textSecondary }]}>{t('AUTH_LABEL_CONFIRM_PASSWORD')}</Text>
              <Controller
                control={control}
                name="confirmPassword"
                render={({ field: { onChange, onBlur, value } }) => (
                  <View style={[styles.passwordRow, { backgroundColor: tc.bgInput, borderColor: tc.border }, !!errors.confirmPassword && styles.inputRowError]}>
                    <TextInput
                      placeholder={t('AUTH_LABEL_CONFIRM_PASSWORD')}
                      placeholderTextColor={tc.placeholder}
                      secureTextEntry={!confirmVisible}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      style={[styles.passwordInput, { color: tc.textPrimary }]}
                    />
                    <Pressable onPress={() => setConfirmVisible((p) => !p)} hitSlop={8}>
                      <Image
                        source={confirmVisible ? ICONS.notEye : ICONS.eye}
                        style={[styles.eyeIcon, { tintColor: tc.textMuted }]}
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
                <Text style={[styles.textDark, { color: tc.textSecondary }]}>
                  {t('AUTH_SIGNUP_TERMS_AGREE')}{' '}
                  <Text
                    style={styles.termsLink}
                    onPress={(e) => {
                      e.stopPropagation()
                      Linking.openURL(lang === 'vi' ? 'https://sportconnects.org/terms-vi' : 'https://sportconnects.org/terms')
                    }}
                  >
                    {t('AUTH_SIGNUP_TERMS_LINK')}
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
              <Text style={styles.submitButtonText}>{t('AUTH_BTN_SIGN_UP')}</Text>
            )}
          </TouchableOpacity>

          {/* ── Footer ── */}
          <View style={styles.footerRow}>
            <Text style={[styles.textDark, { color: tc.textSecondary }]}>{t('AUTH_LABEL_ALREADY_HAVE_ACCOUNT')}</Text>
            <Pressable onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.footerLink}> {t('AUTH_SIGNUP_LINK_SIGN_IN')}</Text>
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