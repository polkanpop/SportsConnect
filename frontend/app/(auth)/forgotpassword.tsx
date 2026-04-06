import React, { useState } from 'react'
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Image } from 'react-native'
import { Stack, router } from 'expo-router'
import { requestPasswordReset } from '@/lib/backendApi'
import { ICONS } from '@/constants/icons'
import { useTranslation } from '@/constants/translations'
import { useThemeColors } from '@/hooks/use-theme-colors'

type Method = 'choose' | 'email' | 'phone'

const ForgotPasswordScreen = () => {
  const { t } = useTranslation()
  const tc = useThemeColors()
  const [method, setMethod] = useState<Method>('choose')
  const [identifier, setIdentifier] = useState('')
  const [phone, setPhone] = useState('')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleEmailSubmit = async () => {
    setStatusMsg(null)
    const id = identifier.trim()
    if (!id) {
      setStatusMsg(t('AUTH_FORGOT_ERR_ENTER'))
      return
    }
    setSubmitting(true)
    try {
      await requestPasswordReset(id)
      setStatusMsg(t('AUTH_FORGOT_SUCCESS'))
      setIdentifier('')
    } catch (e: any) {
      setStatusMsg(e.message || t('AUTH_FORGOT_ERR_FAILED'))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePhoneSubmit = () => {
    setStatusMsg(null)
    const p = phone.trim().replace(/\s/g, '')
    if (!p || !/^0[3-9]\d{8}$/.test(p)) {
      setStatusMsg(t('AUTH_FORGOT_ERR_ENTER_PHONE'))
      return
    }
    // Normalize to +84 and route to phone-otp for phone login (phone users recover by logging in via OTP)
    const normalized = '+84' + p.slice(1)
    router.push({ pathname: '/(auth)/phone-otp' as any, params: { phone: normalized } })
  }

  // ── Method selection ─────────────────────────────────────────────────
  if (method === 'choose') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.container, { backgroundColor: tc.bgBase }]}>
          <View style={styles.logoWrapper}>
            <Image source={ICONS.app_icon} style={styles.logo} />
            <Text style={styles.title}>{t('AUTH_FORGOT_TITLE')}</Text>
          </View>
          <Text style={[styles.helper, { color: tc.textSecondary }]}>{t('AUTH_FORGOT_CHOOSE_METHOD')}</Text>

          <TouchableOpacity style={[styles.methodCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]} activeOpacity={0.8} onPress={() => setMethod('email')}>
            <Image source={ICONS.gmailButton} style={styles.methodIcon} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.methodTitle, { color: tc.textPrimary }]}>{t('AUTH_FORGOT_METHOD_EMAIL')}</Text>
              <Text style={[styles.methodDesc, { color: tc.textMuted }]}>{t('AUTH_FORGOT_METHOD_EMAIL_DESC')}</Text>
            </View>
            <Image source={ICONS.arrowright} style={{ width: 16, height: 16, tintColor: '#999' }} />
          </TouchableOpacity>

          <TouchableOpacity style={[styles.methodCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]} activeOpacity={0.8} onPress={() => setMethod('phone')}>
            <Image source={ICONS.messageSquare} style={styles.methodIcon} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.methodTitle, { color: tc.textPrimary }]}>{t('AUTH_FORGOT_METHOD_PHONE')}</Text>
              <Text style={[styles.methodDesc, { color: tc.textMuted }]}>{t('AUTH_FORGOT_METHOD_PHONE_DESC')}</Text>
            </View>
            <Image source={ICONS.arrowright} style={{ width: 16, height: 16, tintColor: '#999' }} />
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.back()} style={styles.backLinkWrap}>
            <Text style={styles.backLink}>{t('AUTH_FORGOT_BTN_BACK')}</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  // ── Email / Username form ────────────────────────────────────────────
  if (method === 'email') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.container, { backgroundColor: tc.bgBase }]}>
          <View style={styles.logoWrapper}>
            <Image source={ICONS.app_icon} style={styles.logo} />
            <Text style={styles.title}>{t('AUTH_FORGOT_TITLE')}</Text>
          </View>
          <Text style={[styles.helper, { color: tc.textSecondary }]}>{t('AUTH_FORGOT_HELPER')}</Text>
          <TextInput
            placeholder={t('AUTH_FORGOT_PLACEHOLDER')}
            placeholderTextColor={tc.placeholder}
            value={identifier}
            onChangeText={(v) => { setIdentifier(v); if (statusMsg) setStatusMsg(null); }}
            autoCapitalize="none"
            keyboardType="email-address"
            style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.border, color: tc.textPrimary }]}
          />
          {statusMsg && <Text style={styles.status}>{statusMsg}</Text>}
          <TouchableOpacity disabled={submitting} onPress={handleEmailSubmit} style={[styles.button, submitting && { opacity: 0.7 }]}>
            <Text style={styles.buttonText}>{submitting ? t('AUTH_FORGOT_BTN_SUBMITTING') : t('AUTH_FORGOT_BTN_SEND')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setMethod('choose'); setStatusMsg(null) }} style={styles.backLinkWrap}>
            <Text style={styles.backLink}>{t('AUTH_FORGOT_BTN_CHANGE_METHOD')}</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  // ── Phone form ───────────────────────────────────────────────────────
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { backgroundColor: tc.bgBase }]}>
        <View style={styles.logoWrapper}>
          <Image source={ICONS.app_icon} style={styles.logo} />
          <Text style={styles.title}>{t('AUTH_FORGOT_TITLE')}</Text>
        </View>
        <Text style={[styles.helper, { color: tc.textSecondary }]}>{t('AUTH_FORGOT_PHONE_HELPER')}</Text>
        <TextInput
          placeholder={t('AUTH_FORGOT_PHONE_PLACEHOLDER')}
          placeholderTextColor={tc.placeholder}
          value={phone}
          onChangeText={(v) => { setPhone(v); if (statusMsg) setStatusMsg(null); }}
          keyboardType="phone-pad"
          style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.border, color: tc.textPrimary }]}
        />
        {statusMsg && <Text style={styles.status}>{statusMsg}</Text>}
        <TouchableOpacity onPress={handlePhoneSubmit} style={styles.button}>
          <Text style={styles.buttonText}>{t('AUTH_FORGOT_BTN_SEND_OTP')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setMethod('choose'); setStatusMsg(null) }} style={styles.backLinkWrap}>
          <Text style={styles.backLink}>{t('AUTH_FORGOT_BTN_CHANGE_METHOD')}</Text>
        </TouchableOpacity>
      </View>
    </>
  )
}

export default ForgotPasswordScreen

const COLORS = {
  dark300: '#6A6B6B',
  green700: '#FF6017',
  white: '#ffffff',
  bg: '#f8f8f8',
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 28, paddingTop: 80 },
  logoWrapper: { alignItems: 'center', marginBottom: 32 },
  logo: { width: 80, height: 80 },
  title: { fontSize: 24, fontWeight: '700', color: COLORS.green700, marginTop: 8 },
  helper: { color: COLORS.dark300, marginBottom: 20, textAlign: 'center' },
  input: { width: '100%', backgroundColor: COLORS.white, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: '#D1D5DB', marginBottom: 16, color: '#111' },
  button: { backgroundColor: COLORS.green700, width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  buttonText: { color: COLORS.white, fontWeight: '600', fontSize: 16 },
  status: { textAlign: 'center', marginBottom: 12, color: COLORS.dark300 },
  backLinkWrap: { alignItems: 'center', marginTop: 8 },
  backLink: { color: COLORS.green700, fontWeight: '600' },
  methodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  methodIcon: { width: 28, height: 28, tintColor: COLORS.green700, marginRight: 14 },
  methodTitle: { fontSize: 16, fontWeight: '600', color: '#111' },
  methodDesc: { fontSize: 13, color: COLORS.dark300, marginTop: 2 },
})