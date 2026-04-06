import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  LayoutAnimation,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import * as AuthSession from 'expo-auth-session'
import { expo } from '@/app.json'
import { supabase } from '@/lib/supabase'
import { ICONS } from '@/constants/icons'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import {
  changePassword,
  getMyAccount,
  getMyProviders,
  unlinkProvider,
  resendVerification,
  requestPasswordReset,
  updateUserInfo,
  addLocalCredentials,
  registerPendingPhone,
  registerPendingEmail,
  linkZaloProvider,
  linkGoogleProvider,
  type MyAccountInfo,
} from '@/lib/backendApi'
import { queryClient } from '@/providers/query-provider'
import { queryKeys } from '@/hooks/query-keys'
import { useTranslation } from '@/constants/translations'
import { API_BASE_URL } from '@/env'
import { useZaloAuthOverlay } from '@/providers/zalo-auth-overlay-provider'
import { useVoicePreference } from '@/hooks/use-voice-preference'

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

// Convert E.164 (+84xxxxxxxxx) back to local format (0xxxxxxxxx) for display/input.
function toLocalPhone(input: string): string {
  const s = (input ?? '').trim()
  if (s.startsWith('+84') && s.length === 12) return '0' + s.slice(3)
  return s
}

const ZALO_APP_ID = '959402498466634174';
const ZALO_AUTH_ENDPOINT = 'https://oauth.zaloapp.com/v4/permission';
const WORKER_ORIGIN = 'https://sportconnects.org';
const REDIRECT_INTERCEPT = 'sportconnect://zalo-code';
const ZALO_REDIRECT_URI = `${WORKER_ORIGIN}/zalo-callback`;

function _toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function _generateCodeVerifier(): string {
  const bytes = Crypto.getRandomBytes(48);
  return _toBase64Url(btoa(String.fromCharCode(...bytes)));
}
async function _generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  return _toBase64Url(hash);
}
function _generateState(): string {
  const bytes = Crypto.getRandomBytes(16);
  return _toBase64Url(btoa(String.fromCharCode(...bytes))).slice(0, 20);
}

// ─── Password strength ────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const zxcvbn = require('zxcvbn')
const STRENGTH_COLORS = ['#dc2626', '#f97316', '#eab308', '#84cc16', '#22c55e']

function getStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; color: string } | null {
  if (!pw) return null
  const result = zxcvbn(pw)
  const score = Math.max(0, Math.min(4, result.score)) as 0 | 1 | 2 | 3 | 4
  return { score, color: STRENGTH_COLORS[score] }
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>
}

function StatusBadge({ verified, labelVerified, labelUnverified }: { verified: boolean; labelVerified: string; labelUnverified: string }) {
  return (
    <View style={[styles.badge, verified ? styles.badgeVerified : styles.badgeUnverified]}>
      <Text style={[styles.badgeText, verified ? styles.badgeTextVerified : styles.badgeTextUnverified]}>
        {verified ? labelVerified : labelUnverified}
      </Text>
    </View>
  )
}

function VoiceToggleSection(_props: { t: (key: any) => string }) {
  // Moved to Settings.tsx "Feature" section
  return null
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function AccountSettingsScreen() {
  const router = useRouter()
  const { t } = useTranslation()
  const overlay = useZaloAuthOverlay()
  const { userId: userid, userInfo: userInfoQuery } = useAppBootstrap()
  const userInfo = userInfoQuery.data

  const STRENGTH_LABELS = useMemo(() => [
    t('AUTH_STRENGTH_VERY_WEAK'),
    t('AUTH_STRENGTH_WEAK'),
    t('AUTH_STRENGTH_FAIR'),
    t('AUTH_STRENGTH_GOOD'),
    t('AUTH_STRENGTH_STRONG'),
  ], [t])

  // ── Settings search ──────────────────────────────────────────────────────
  // Search is handled in the parent settings.tsx screen. accountSettings shows all sections.

  // ── Identity ─────────────────────────────────────────────────────────────
  const [nameValue, setNameValue] = useState('')
  const [originalName, setOriginalName] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSuccess, setNameSuccess] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  // ── Account meta (username, logintype, verified status) ───────────────────
  const [account, setAccount] = useState<MyAccountInfo | null>(null)
  const [providers, setProviders] = useState<string[]>([])
  const [loadingMeta, setLoadingMeta] = useState(true)

  // ── Contact visibility ────────────────────────────────────────────────────
  const [emailVisible, setEmailVisible] = useState(true)
  const [phoneVisible, setPhoneVisible] = useState(true)

  // ── Email verification ────────────────────────────────────────────────────
  const [sendingVerif, setSendingVerif] = useState(false)
  const [verifSent, setVerifSent] = useState(false)
  const [verifError, setVerifError] = useState<string | null>(null)

  // ── Password change ───────────────────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showCurrentPw, setShowCurrentPw] = useState(false)
  const [showNewPw, setShowNewPw] = useState(false)
  const [showConfirmPw, setShowConfirmPw] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)

  // ── Contact edit ─────────────────────────────────────────────────────────
  const [emailEdit, setEmailEdit] = useState('')
  const [phoneEdit, setPhoneEdit] = useState('')
  const [originalEmail, setOriginalEmail] = useState('')
  const [originalPhone, setOriginalPhone] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [emailSuccess, setEmailSuccess] = useState(false)
  const [phoneSuccess, setPhoneSuccess] = useState(false)
  const [emailEditError, setEmailEditError] = useState<string | null>(null)
  const [phoneEditError, setPhoneEditError] = useState<string | null>(null)

  // ── OAuth add-credentials ────────────────────────────────────────────────
  const [newUsername, setNewUsername] = useState('')
  const [newPwOAuth, setNewPwOAuth] = useState('')
  const [confirmPwOAuth, setConfirmPwOAuth] = useState('')
  const [showNewPwOAuth, setShowNewPwOAuth] = useState(false)
  const [showConfirmPwOAuth, setShowConfirmPwOAuth] = useState(false)
  const [credSaving, setCredSaving] = useState(false)
  const [credSuccess, setCredSuccess] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)

  // ── Reset password ────────────────────────────────────────────────────────
  const [sendingReset, setSendingReset] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  // ── Zalo account linking ───────────────────────────────────────────────────
  const [linkingZalo, setLinkingZalo] = useState(false)

  // ── Google account linking ─────────────────────────────────────────────────
  const [linkingGoogle, setLinkingGoogle] = useState(false)

  // ── Which linked-row is expanded (showing unlink X) ───────────────────────
  const [linkExpandedProvider, setLinkExpandedProvider] = useState<string | null>(null)

  // ── Provider unlinking ────────────────────────────────────────────────────
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null)

  // ── Link confirmation modal ────────────────────────────────────────────────
  const [linkConfirm, setLinkConfirm] = useState<{ provider: string; onConfirm: () => void } | null>(null)

  // ── Unlink confirmation modal ──────────────────────────────────────────────
  const [unlinkConfirm, setUnlinkConfirm] = useState<{ provider: string; onConfirm: () => void } | null>(null)

  // ── Merge email modal (after Google link with a different email) ───────────
  const [mergePrompt, setMergePrompt] = useState<{ provider: string; email: string } | null>(null)

  const handleMergeEmail = async () => {
    if (!mergePrompt) return
    const target = mergePrompt.email
    setMergePrompt(null)
    try {
      await registerPendingEmail(target)
      setOriginalEmail(target)
      setEmailEdit(target)
      setVerifSent(true)
      Alert.alert(t('ACCT_VERIF_SENT'), target)
    } catch (e: any) {
      Alert.alert(t('COMMON_LABEL_ERROR'), e?.message || t('ACCT_ERR_GENERIC'))
    }
  }

  const handleUnlinkProvider = async (provider: string) => {
    setUnlinkingProvider(provider)
    try {
      await unlinkProvider(provider)
      setProviders(prev => prev.filter(p => p !== provider))
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể huỷ liên kết. Vui lòng thử lại.')
    } finally {
      setUnlinkingProvider(null)
    }
  }

  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Sync visibility from bootstrap data ──────────────────────────────────
  useEffect(() => {
    if (userInfo) {
      setNameValue(userInfo.name ?? '')
      setOriginalName(userInfo.name ?? '')
      const em = userInfo.email ?? ''
      const ph = toLocalPhone(userInfo.contactnumber ?? '')
      setEmailEdit(em)
      setOriginalEmail(em)
      setPhoneEdit(ph)
      setOriginalPhone(ph)
      if (typeof userInfo.emailvisiblestatus === 'boolean') setEmailVisible(userInfo.emailvisiblestatus)
      if (typeof userInfo.phonevisiblestatus === 'boolean') setPhoneVisible(userInfo.phonevisiblestatus)
    }
  }, [userInfo])

  // ── Load account meta & providers ────────────────────────────────────────
  const loadMeta = useCallback(async () => {
    setLoadingMeta(true)
    try {
      const [acct, provs] = await Promise.all([getMyAccount(), getMyProviders()])
      setAccount(acct)
      setProviders(provs)
      // Source email/phone from unverified_users — always reflects the pending/current state.
      // unverified_users.email is set on signup and updated by registerPendingEmail.
      // unverified_users.phone is set by registerPendingPhone.
      if (acct?.unverified_email) {
        setOriginalEmail(acct.unverified_email)
        setEmailEdit(acct.unverified_email)
      }
      if (acct?.unverified_phone) {
        const localPhone = toLocalPhone(acct.unverified_phone)
        setOriginalPhone(localPhone)
        setPhoneEdit(localPhone)
      }
    } catch {
      // silent — screen is still usable without this
    } finally {
      setLoadingMeta(false)
    }
  }, [])

  useFocusEffect(useCallback(() => { void loadMeta() }, [loadMeta]))

  // ── Name save ─────────────────────────────────────────────────────────────
  const handleSaveName = async () => {
    if (!userid || !nameValue.trim()) return
    setNameSaving(true)
    setNameError(null)
    setNameSuccess(false)
    try {
      await updateUserInfo(userid, { name: nameValue.trim() })
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
      // Also update the cached @backendProfile so Settings/profile reads the new name immediately
      try {
        const raw = await AsyncStorage.getItem('@backendProfile')
        if (raw) {
          const parsed = JSON.parse(raw)
          parsed.name = nameValue.trim()
          await AsyncStorage.setItem('@backendProfile', JSON.stringify(parsed))
        }
      } catch { /* ignore */ }
      setOriginalName(nameValue.trim())
      setNameSuccess(true)
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setNameSuccess(false), 3000)
    } catch {
      setNameError(t('ACCT_ERR_GENERIC'))
    } finally {
      setNameSaving(false)
    }
  }

  // ── Visibility toggles ────────────────────────────────────────────────────
  const handleToggleEmailVisible = async () => {
    if (!userid) return
    const next = !emailVisible
    setEmailVisible(next)
    try { await updateUserInfo(userid, { emailvisiblestatus: next }) } catch {}
  }

  const handleTogglePhoneVisible = async () => {
    if (!userid) return
    const next = !phoneVisible
    setPhoneVisible(next)
    try { await updateUserInfo(userid, { phonevisiblestatus: next }) } catch {}
  }

  // ── Save contact edits ────────────────────────────────────────────────────
  const handleSaveEmail = async () => {
    if (!userid || !emailEdit.trim()) return
    const trimmed = emailEdit.trim()
    if (!trimmed.includes('@')) {
      setEmailEditError(t('ACCT_ERR_INVALID_EMAIL'))
      return
    }
    setEmailSaving(true); setEmailEditError(null); setEmailSuccess(false)
    try {
      await registerPendingEmail(trimmed)
      // Show the new pending email immediately; badge switches to Unverified.
      // loadMeta will confirm by reading unverified_users on next focus.
      setOriginalEmail(trimmed)
      setEmailEdit(trimmed)
      setVerifSent(true)
      setEmailSuccess(true)
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setEmailSuccess(false), 5000)
    } catch (e: any) {
      setEmailEditError(e?.message || t('ACCT_ERR_GENERIC'))
    } finally {
      setEmailSaving(false)
    }
  }

  const handleSavePhone = async () => {
    if (!userid || !phoneEdit.trim()) return
    const trimmed = phoneEdit.trim()
    const VN_PHONE_RE = /^0[3-9]\d{8}$/
    if (!VN_PHONE_RE.test(trimmed)) {
      setPhoneEditError(t('AUTH_OTP_ERR_INVALID_PHONE'))
      return
    }
    setPhoneSaving(true); setPhoneEditError(null); setPhoneSuccess(false)
    try {
      await registerPendingPhone(trimmed)
      setOriginalPhone(trimmed)
      void loadMeta()
      setPhoneSuccess(true)
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setPhoneSuccess(false), 3000)
    } catch (e: any) {
      setPhoneEditError(e?.message || t('ACCT_ERR_GENERIC'))
    } finally {
      setPhoneSaving(false)
    }
  }

  // ── Add local credentials (OAuth users) ──────────────────────────────────
  const handleAddCredentials = async () => {
    setCredError(null); setCredSuccess(false)
    if (newUsername.trim().length < 3) { setCredError(t('ACCT_ERR_USERNAME_TOO_SHORT')); return }
    if (newPwOAuth.length < 8) { setCredError(t('ACCT_ERR_PW_TOO_SHORT')); return }
    if (newPwOAuth !== confirmPwOAuth) { setCredError(t('ACCT_ERR_PW_MISMATCH')); return }
    setCredSaving(true)
    try {
      await addLocalCredentials(newUsername.trim(), newPwOAuth)
      setCredSuccess(true)
      setNewUsername(''); setNewPwOAuth(''); setConfirmPwOAuth('')
      void loadMeta()
    } catch (e: any) {
      const msg: string = e?.message || ''
      if (msg.includes('USERNAME_TAKEN')) setCredError(t('ACCT_ERR_USERNAME_TAKEN'))
      else setCredError(t('ACCT_ERR_GENERIC'))
    } finally {
      setCredSaving(false)
    }
  }

  // ── Resend email verification ─────────────────────────────────────────────
  const handleSendVerification = async () => {
    // Use the pending email from unverified_users (originalEmail) as the target,
    // not userInfo.email which is only updated after clicking the link.
    const emailToVerify = originalEmail.trim() || userInfo?.email
    if (!emailToVerify) return
    setSendingVerif(true)
    setVerifError(null)
    setVerifSent(false)
    try {
      await resendVerification(emailToVerify)
      setVerifSent(true)
    } catch (e: any) {
      setVerifError(e?.message || t('ACCT_ERR_GENERIC'))
    } finally {
      setSendingVerif(false)
    }
  }

  // ── Change password ───────────────────────────────────────────────────────
  const strengthResult = useMemo(() => getStrength(newPw), [newPw])

  const handleSavePassword = async () => {
    setPwError(null)
    setPwSuccess(false)
    if (newPw.length < 8) { setPwError(t('ACCT_ERR_PW_TOO_SHORT')); return }
    if (newPw !== confirmPw) { setPwError(t('ACCT_ERR_PW_MISMATCH')); return }
    setPwSaving(true)
    try {
      await changePassword(currentPw, newPw)
      setPwSuccess(true)
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setPwSuccess(false), 3000)
    } catch (e: any) {
      const msg: string = e?.message || ''
      if (msg.includes('incorrect')) setPwError(t('ACCT_ERR_CURRENT_PW_WRONG'))
      else setPwError(t('ACCT_ERR_GENERIC'))
    } finally {
      setPwSaving(false)
    }
  }

  // ── Link Zalo account ─────────────────────────────────────────────────────
  // Pre-warm Chrome Custom Tab to reduce black-screen flash on CCT open/close.
  useEffect(() => {
    void WebBrowser.warmUpAsync()
    return () => { void WebBrowser.coolDownAsync() }
  }, [])

  const handleLinkZalo = async () => {
    setLinkingZalo(true)
    overlay.show()
    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '')
    try {
      // 1. PKCE
      const codeVerifier = _generateCodeVerifier()
      const codeChallenge = await _generateCodeChallenge(codeVerifier)
      const state = _generateState()
      const params = new URLSearchParams({
        app_id: ZALO_APP_ID,
        redirect_uri: ZALO_REDIRECT_URI,
        code_challenge: codeChallenge,
        state,
      })
      // 2. Open Chrome Custom Tab with a Linking listener fallback.
      //    On OPPO/ColorOS the CCT may not self-close after the custom-scheme
      //    redirect.  A parallel Linking listener catches the deep link and
      //    force-dismisses the CCT so the user isn't stuck on a black screen.
      await new Promise<void>(r => requestAnimationFrame(() => r()))
      const oauthUrl = `${ZALO_AUTH_ENDPOINT}?${params.toString()}`

      const code: string | null = await new Promise<string | null>((resolve) => {
        let settled = false

        // Linking listener — catches sportconnect://zalo-code on devices where
        // openAuthSessionAsync doesn't intercept the redirect properly.
        const linkingSub = Linking.addEventListener('url', ({ url }) => {
          if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return
          settled = true
          linkingSub.remove()
          try { WebBrowser.dismissAuthSession() } catch {}
          try { resolve(new URL(url).searchParams.get('code')) } catch { resolve(null) }
        })

        // Primary path — openAuthSessionAsync
        WebBrowser.openAuthSessionAsync(oauthUrl, REDIRECT_INTERCEPT)
          .then((result) => {
            if (settled) return
            settled = true
            linkingSub.remove()
            // Force-close the CCT in case it lingers (OPPO/ColorOS)
            try { WebBrowser.dismissAuthSession() } catch {}
            if (result.type === 'success') {
              try { resolve(new URL(result.url).searchParams.get('code')) } catch { resolve(null) }
            } else {
              resolve(null)
            }
          })
          .catch(() => {
            if (settled) return
            settled = true
            linkingSub.remove()
            resolve(null)
          })
      })

      // CCT closed — hide overlay immediately so user sees their app.
      // The ZaloAuthOverlayProvider's 600ms fade-out covers the Android surface rebuild.
      overlay.hide()

      if (!code) {
        // User cancelled or CCT failed — reload meta in case link went through
        void loadMeta()
        return
      }
      // 3. Extract code — already have it
      // 4. Exchange code → access_token
      const tokenResp = await fetch(`${backendUrl}/api/auth/zalo/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      })
      const tokenJson = await tokenResp.json().catch(() => ({}))
      const accessToken: string = tokenJson?.access_token ?? ''
      if (!accessToken) { Alert.alert(t('ACCT_LINK_ZALO_ERR_TITLE'), tokenJson?.detail || 'Không lấy được access token.'); return }
      // 5. Get user_id + name via graph.zalo.me (Social API, works from Vietnam device IPs).
      //    Returns { id, name } — note field is 'id' not 'user_id'.
      let zaloId = String(tokenJson?.user_id ?? '')
      let zaloName = 'Zalo User'
      if (!zaloId) {
        try {
          const tiResp = await fetch('https://graph.zalo.me/v2.0/me?fields=id,name', {
            headers: { 'access_token': accessToken },
          })
          const tiJson = await tiResp.json().catch(() => ({}))
          zaloId = String(tiJson?.id ?? '')
          if (tiJson?.name) zaloName = String(tiJson.name)
        } catch { /* non-fatal */ }
      }
      if (!zaloId) { Alert.alert(t('ACCT_LINK_ZALO_ERR_TITLE'), 'Không lấy được thông tin người dùng Zalo.'); return }
      // 6. Link provider
      await linkZaloProvider({ access_token: accessToken, zalo_id: zaloId, zalo_name: zaloName })
      void loadMeta()
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? ''
      if (!msg.includes('-201') && !msg.toLowerCase().includes('cancel')) {
        Alert.alert(t('ACCT_LINK_ZALO_ERR_TITLE'), msg || t('ACCT_ERR_GENERIC'))
      }
    } finally {
      setLinkingZalo(false)
      overlay.hide() // safety backstop — no-op if already hidden above
    }
  }

  // ── Link Google account ───────────────────────────────────────────────────
  const handleLinkGoogle = async () => {
    setLinkingGoogle(true)
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || (expo?.extra?.SUPABASE_URL as string | undefined)
    const backendUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || API_BASE_URL).replace(/\/api$/, '')
    if (!supabaseUrl) {
      Alert.alert('Lỗi', 'Thiếu cấu hình Supabase URL.')
      setLinkingGoogle(false)
      return
    }
    try {
      const redirectUri = AuthSession.makeRedirectUri({ scheme: (expo as any).scheme })
      const params = new URLSearchParams({
        provider: 'google',
        redirect_to: redirectUri,
        scopes: 'email profile',
      })
      const wbResult = await WebBrowser.openAuthSessionAsync(
        `${supabaseUrl}/auth/v1/authorize?${params.toString()}`,
        redirectUri,
      )
      if (wbResult.type !== 'success') { void loadMeta(); return }

      // Parse fragment for access_token
      const u = new URL(wbResult.url)
      const hash = u.hash.startsWith('#') ? u.hash.substring(1) : u.hash
      const sp = new URLSearchParams(hash)
      let accessToken = sp.get('access_token') || undefined

      // Fallback: exchange code if PKCE flow
      if (!accessToken && sp.get('code')) {
        const { data } = await supabase.auth.exchangeCodeForSession(sp.get('code')!)
        accessToken = data.session?.access_token
      }

      if (!accessToken) {
        Alert.alert('Liên kết Google thất bại', 'Không nhận được token xác thực.')
        return
      }

      // Extract Google email from Supabase JWT payload (safe — just base64 decode)
      let googleEmail: string | null = null
      try {
        const payload = JSON.parse(atob(accessToken.split('.')[1]))
        googleEmail = typeof payload?.email === 'string' ? payload.email : null
      } catch { /* non-fatal */ }

      await linkGoogleProvider(accessToken)
      void loadMeta()

      // Offer to merge if the Google email differs from the user's current registered email
      if (googleEmail && googleEmail.toLowerCase() !== originalEmail.trim().toLowerCase()) {
        setMergePrompt({ provider: 'Google', email: googleEmail })
      }
    } catch (e: any) {
      const msg: string = e?.message ?? String(e) ?? ''
      if (!msg.toLowerCase().includes('cancel')) {
        Alert.alert('Liên kết Google thất bại', msg || 'Vui lòng thử lại.')
      }
    } finally {
      setLinkingGoogle(false)
    }
  }

  // ── Reset password via email ──────────────────────────────────────────────
  const handleRequestReset = async () => {
    if (!userInfo?.email) return
    setSendingReset(true)
    try { await requestPasswordReset(userInfo.email) } catch {}
    setResetSent(true)
    setSendingReset(false)
  }

  const isLocalAccount = account?.logintype?.toLowerCase() === 'local'

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Header */}
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('ACCT_HEADER_TITLE')}</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Search bar removed — now in settings.tsx */}

      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">

        {/* ── Identity ─────────────────────────────────────────────────── */}
        {<>
        <SectionHeader title={t('ACCT_SECTION_IDENTITY')} />
        <View style={styles.card}>
          {/* Display Name */}
          <Text style={styles.fieldLabel}>{t('ACCT_LABEL_DISPLAY_NAME')}</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={nameValue}
              onChangeText={setNameValue}
              placeholder={t('ACCT_PLACEHOLDER_NAME')}
              placeholderTextColor="#aaa"
              returnKeyType="done"
            />
            <TouchableOpacity style={[styles.inlineBtn, (nameValue.trim() === originalName.trim()) && styles.inlineBtnDisabled]} onPress={handleSaveName} disabled={nameSaving || nameValue.trim() === originalName.trim()}>
              {nameSaving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Image source={ICONS.tick} style={{ width: 16, height: 16, tintColor: '#fff' }} />}
            </TouchableOpacity>
          </View>
          {nameSuccess && <Text style={styles.successText}>{t('ACCT_NAME_SAVE_SUCCESS')}</Text>}
          {nameError && <Text style={styles.errorText}>{nameError}</Text>}
        </View>
        </>}

        {/* ── Contact ──────────────────────────────────────────────────── */}
        {<>
        <SectionHeader title={t('ACCT_SECTION_CONTACT')} />
        <View style={styles.card}>

          {/* Email */}
          <View style={styles.contactHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>{t('ACCT_LABEL_EMAIL')}</Text>
              {!loadingMeta && emailEdit.trim() && emailEdit === originalEmail && (
                <StatusBadge
                  verified={account?.email_verified ?? false}
                  labelVerified={t('ACCT_BADGE_VERIFIED')}
                  labelUnverified={t('ACCT_BADGE_UNVERIFIED')}
                />
              )}
            </View>
            {emailEdit.trim() && emailEdit === originalEmail ? (
              <TouchableOpacity onPress={handleToggleEmailVisible} style={styles.eyeBtn}>
                <Image source={emailVisible ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={emailEdit}
              onChangeText={setEmailEdit}
              placeholder={t('ACCT_CONTACT_NOT_SET')}
              placeholderTextColor="#aaa"
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <TouchableOpacity
              style={[styles.inlineBtn, emailEdit.trim() === originalEmail.trim() && styles.inlineBtnDisabled]}
              onPress={handleSaveEmail}
              disabled={emailSaving || emailEdit.trim() === originalEmail.trim()}
            >
              {emailSaving ? <ActivityIndicator size="small" color="#fff" /> : <Image source={ICONS.tick} style={{ width: 16, height: 16, tintColor: '#fff' }} />}
            </TouchableOpacity>
          </View>
          {emailSuccess && <Text style={styles.successText}>{t('ACCT_CONTACT_SAVED')}</Text>}
          {emailEditError && <Text style={styles.errorText}>{emailEditError}</Text>}
          {!loadingMeta && emailEdit.trim() && emailEdit === originalEmail && !(account?.email_verified) && (
            verifSent
              ? <Text style={styles.successText}>{t('ACCT_VERIF_SENT')}</Text>
              : <TouchableOpacity onPress={handleSendVerification} disabled={sendingVerif} style={styles.linkBtn}>
                  {sendingVerif ? <ActivityIndicator size="small" color="#3b82f6" /> : <Text style={styles.linkText}>{t('ACCT_BTN_VERIFY_NOW')}</Text>}
                </TouchableOpacity>
          )}
          {verifError && <Text style={styles.errorText}>{verifError}</Text>}

          <View style={styles.contactDivider} />

          {/* Phone */}
          <View style={styles.contactHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>{t('ACCT_LABEL_PHONE')}</Text>
              {!loadingMeta && phoneEdit.trim() && phoneEdit === originalPhone && (
                <StatusBadge
                  verified={account?.phone_verified ?? false}
                  labelVerified={t('ACCT_BADGE_VERIFIED')}
                  labelUnverified={t('ACCT_BADGE_UNVERIFIED')}
                />
              )}
            </View>
            {phoneEdit.trim() && phoneEdit === originalPhone ? (
              <TouchableOpacity onPress={handleTogglePhoneVisible} style={styles.eyeBtn}>
                <Image source={phoneVisible ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={phoneEdit}
              onChangeText={setPhoneEdit}
              placeholder={t('ACCT_CONTACT_NOT_SET')}
              placeholderTextColor="#aaa"
              keyboardType="phone-pad"
            />
            <TouchableOpacity
              style={[styles.inlineBtn, phoneEdit.trim() === originalPhone.trim() && styles.inlineBtnDisabled]}
              onPress={handleSavePhone}
              disabled={phoneSaving || phoneEdit.trim() === originalPhone.trim()}
            >
              {phoneSaving ? <ActivityIndicator size="small" color="#fff" /> : <Image source={ICONS.tick} style={{ width: 16, height: 16, tintColor: '#fff' }} />}
            </TouchableOpacity>
          </View>
          {phoneSuccess && <Text style={styles.successText}>{t('ACCT_CONTACT_SAVED')}</Text>}
          {phoneEditError && <Text style={styles.errorText}>{phoneEditError}</Text>}
          {!loadingMeta && originalPhone.trim() && !(account?.phone_verified) && (
            <TouchableOpacity
              onPress={() => router.push(`/(auth)/phone-otp?phone=${encodeURIComponent(originalPhone.trim())}&mode=add_phone` as any)}
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>{t('ACCT_BTN_VERIFY_OTP')}</Text>
            </TouchableOpacity>
          )}

        </View>
        </>}

        {/* ── Authentication & Security ─────────────────────────────── */}
        {<>
        <SectionHeader title={t('ACCT_SECTION_AUTH')} />

        {/* Username subsection */}
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>{t('ACCT_LABEL_USERNAME')}</Text>
          {account?.username ? (
            <View style={styles.readonlyRow}>
              <Text style={styles.readonlyText}>{account.username}</Text>
            </View>
          ) : (
            <Text style={styles.mutedText}>{t('ACCT_NO_USERNAME')}</Text>
          )}
        </View>

        {/* Password / Credentials subsection */}
        <View style={[styles.card, { marginTop: 12 }]}>
          {loadingMeta ? (
            <ActivityIndicator size="small" color="#888" style={{ marginVertical: 12 }} />
          ) : isLocalAccount ? (
            <>
              {/* Current password */}
              <Text style={styles.fieldLabel}>{t('ACCT_LABEL_CURRENT_PASSWORD')}</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={styles.pwInput}
                  value={currentPw}
                  onChangeText={setCurrentPw}
                  secureTextEntry={!showCurrentPw}
                  placeholder="••••••••"
                  placeholderTextColor="#aaa"
                />
                <TouchableOpacity onPress={() => setShowCurrentPw(v => !v)} style={styles.eyeBtn}>
                  <Image source={showCurrentPw ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
                </TouchableOpacity>
              </View>

              {/* New password */}
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>{t('ACCT_LABEL_NEW_PASSWORD')}</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={styles.pwInput}
                  value={newPw}
                  onChangeText={setNewPw}
                  secureTextEntry={!showNewPw}
                  placeholder="••••••••"
                  placeholderTextColor="#aaa"
                />
                <TouchableOpacity onPress={() => setShowNewPw(v => !v)} style={styles.eyeBtn}>
                  <Image source={showNewPw ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
                </TouchableOpacity>
              </View>

              {/* Strength bar */}
              {strengthResult !== null && (
                <View style={styles.strengthWrapper}>
                  <View style={styles.strengthTrack}>
                    {[0, 1, 2, 3].map((i) => (
                      <View
                        key={i}
                        style={[
                          styles.strengthSegment,
                          i < strengthResult.score
                            ? { backgroundColor: strengthResult.color }
                            : { backgroundColor: '#e5e7eb' },
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.strengthLabel, { color: strengthResult.color }]}>
                    {STRENGTH_LABELS[strengthResult.score]}
                  </Text>
                </View>
              )}

              {/* Confirm password */}
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>{t('ACCT_LABEL_CONFIRM_PASSWORD')}</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={styles.pwInput}
                  value={confirmPw}
                  onChangeText={setConfirmPw}
                  secureTextEntry={!showConfirmPw}
                  placeholder="••••••••"
                  placeholderTextColor="#aaa"
                />
                <TouchableOpacity onPress={() => setShowConfirmPw(v => !v)} style={styles.eyeBtn}>
                  <Image source={showConfirmPw ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
                </TouchableOpacity>
              </View>

              {pwError && <Text style={styles.errorText}>{pwError}</Text>}
              {pwSuccess && <Text style={styles.successText}>{t('ACCT_PW_SAVE_SUCCESS')}</Text>}

              <TouchableOpacity
                style={[styles.saveBtn, (!currentPw && !newPw && !confirmPw) && styles.saveBtnDisabled]}
                onPress={handleSavePassword}
                disabled={pwSaving || (!currentPw && !newPw && !confirmPw)}
              >
                {pwSaving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.saveBtnText}>{t('ACCT_BTN_SAVE_PASSWORD')}</Text>}
              </TouchableOpacity>

              {/* Reset password link */}
              <TouchableOpacity onPress={handleRequestReset} disabled={sendingReset || resetSent} style={[styles.linkBtn, { marginTop: 10 }]}>
                {sendingReset
                  ? <ActivityIndicator size="small" color="#3b82f6" />
                  : <Text style={styles.linkText}>
                      {resetSent ? t('ACCT_VERIF_SENT') : t('ACCT_LINK_RESET_PASSWORD')}
                    </Text>}
              </TouchableOpacity>
            </>
          ) : (
            <>
              {/* Set username + password for OAuth users */}
              <Text style={styles.fieldLabel}>{t('ACCT_LABEL_NEW_USERNAME')}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={newUsername}
                  onChangeText={setNewUsername}
                  placeholder="username"
                  placeholderTextColor="#aaa"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>{t('ACCT_LABEL_NEW_PASSWORD')}</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={styles.pwInput}
                  value={newPwOAuth}
                  onChangeText={setNewPwOAuth}
                  secureTextEntry={!showNewPwOAuth}
                  placeholder="••••••••"
                  placeholderTextColor="#aaa"
                />
                <TouchableOpacity onPress={() => setShowNewPwOAuth(v => !v)} style={styles.eyeBtn}>
                  <Image source={showNewPwOAuth ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
                </TouchableOpacity>
              </View>

              {/* Strength bar */}
              {(() => {
                const sr = getStrength(newPwOAuth)
                return sr !== null ? (
                  <View style={styles.strengthWrapper}>
                    <View style={styles.strengthTrack}>
                      {[0, 1, 2, 3].map((i) => (
                        <View key={i} style={[styles.strengthSegment, i < sr.score ? { backgroundColor: sr.color } : { backgroundColor: '#e5e7eb' }]} />
                      ))}
                    </View>
                    <Text style={[styles.strengthLabel, { color: sr.color }]}>{STRENGTH_LABELS[sr.score]}</Text>
                  </View>
                ) : null
              })()}

              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>{t('ACCT_LABEL_CONFIRM_PASSWORD')}</Text>
              <View style={styles.pwRow}>
                <TextInput
                  style={styles.pwInput}
                  value={confirmPwOAuth}
                  onChangeText={setConfirmPwOAuth}
                  secureTextEntry={!showConfirmPwOAuth}
                  placeholder="••••••••"
                  placeholderTextColor="#aaa"
                />
                <TouchableOpacity onPress={() => setShowConfirmPwOAuth(v => !v)} style={styles.eyeBtn}>
                  <Image source={showConfirmPwOAuth ? ICONS.eye : ICONS.notEye} style={styles.eyeIcon} />
                </TouchableOpacity>
              </View>

              {credError && <Text style={styles.errorText}>{credError}</Text>}
              {credSuccess && <Text style={styles.successText}>{t('ACCT_SET_CRED_SUCCESS')}</Text>}

              <TouchableOpacity style={styles.saveBtn} onPress={handleAddCredentials} disabled={credSaving}>
                {credSaving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.saveBtnText}>{t('ACCT_BTN_SET_CREDENTIALS')}</Text>}
              </TouchableOpacity>
            </>
          )}
        </View>
        </>}

        {/* ── Linked Accounts ───────────────────────────────────────────── */}
        {<>
        <SectionHeader title={t('ACCT_SECTION_LINKED')} />
        <View style={styles.card}>
          {loadingMeta ? (
            <ActivityIndicator size="small" color="#888" style={{ marginVertical: 12 }} />
          ) : (
            <>
              <LinkedAccountRow
                icon={ICONS.googleIcon}
                label="Google"
                linked={providers.includes('Google')}
                onPress={!providers.includes('Google')
                  ? () => setLinkConfirm({ provider: 'Google', onConfirm: handleLinkGoogle })
                  : () => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                      setLinkExpandedProvider(p => p === 'Google' ? null : 'Google')
                    }}
                linking={linkingGoogle}
                unlinkExpanded={linkExpandedProvider === 'Google'}
                onUnlinkPress={providers.includes('Google') && providers.length > 1
                  ? () => setUnlinkConfirm({ provider: 'Google', onConfirm: () => { setLinkExpandedProvider(null); handleUnlinkProvider('Google') } })
                  : undefined}
                unlinking={unlinkingProvider === 'Google'}
                iconSize={30}
              />
              <View style={styles.contactDivider} />
              <LinkedAccountRow
                icon={ICONS.zaloIcon}
                label="Zalo"
                linked={providers.includes('Zalo')}
                onPress={!providers.includes('Zalo')
                  ? () => setLinkConfirm({ provider: 'Zalo', onConfirm: handleLinkZalo })
                  : () => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                      setLinkExpandedProvider(p => p === 'Zalo' ? null : 'Zalo')
                    }}
                linking={linkingZalo}
                unlinkExpanded={linkExpandedProvider === 'Zalo'}
                onUnlinkPress={providers.includes('Zalo') && providers.length > 1
                  ? () => setUnlinkConfirm({ provider: 'Zalo', onConfirm: () => { setLinkExpandedProvider(null); handleUnlinkProvider('Zalo') } })
                  : undefined}
                unlinking={unlinkingProvider === 'Zalo'}
              />
              {providers.includes('Local') && (
                <>
                  <View style={styles.contactDivider} />
                  <LinkedAccountRow
                    icon={ICONS.user}
                    label="Tài khoản cục bộ"
                    linked
                  />
                </>
              )}
            </>
          )}
        </View>
        </>}

      </ScrollView>

      {/* ── Zalo OAuth loading overlay ── */}
      {/* Use absolute View instead of Modal to prevent Android black-screen after CCT closes */}
      {linkingZalo && (
        <View style={styles.loadingOverlayAbsolute} pointerEvents="box-only">
          <ActivityIndicator size="large" color="#FF6017" />
          <Text style={styles.loadingOverlayText}>Đang kết nối Zalo…</Text>
        </View>
      )}

      {/* ── Google OAuth loading overlay ── */}
      {linkingGoogle && (
        <View style={styles.loadingOverlayAbsolute} pointerEvents="box-only">
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingOverlayText}>Đang kết nối Google…</Text>
        </View>
      )}

      {/* ── Link Confirmation Modal ────────────────────────────────────── */}
      {linkConfirm && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setLinkConfirm(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setLinkConfirm(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setLinkConfirm(null)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Liên kết {linkConfirm.provider}</Text>
              <Text style={styles.modalBody}>
                Bạn sẽ có thể đăng nhập bằng {linkConfirm.provider} sau khi liên kết.{'\n\n'}
                Lưu ý: nếu huỷ liên kết sau này, tài khoản {linkConfirm.provider} sẽ không còn được dùng để đăng nhập vào ứng dụng.
              </Text>
              <View style={styles.modalBtnRow}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => setLinkConfirm(null)}
                >
                  <Text style={styles.modalBtnCancelText}>Huỷ</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnConfirm]}
                  onPress={() => { setLinkConfirm(null); linkConfirm.onConfirm(); }}
                >
                  <Text style={styles.modalBtnConfirmText}>Liên kết</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Unlink Confirmation Modal ──────────────────────────────────── */}
      {unlinkConfirm && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setUnlinkConfirm(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setUnlinkConfirm(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setUnlinkConfirm(null)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Huỷ liên kết {unlinkConfirm.provider}</Text>
              <Text style={styles.modalBody}>
                Bạn sẽ không thể đăng nhập bằng {unlinkConfirm.provider} sau khi huỷ liên kết.
              </Text>
              <View style={styles.modalBtnRow}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => setUnlinkConfirm(null)}
                >
                  <Text style={styles.modalBtnCancelText}>Huỷ</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnDanger]}
                  onPress={() => { setUnlinkConfirm(null); unlinkConfirm.onConfirm(); }}
                >
                  <Text style={styles.modalBtnConfirmText}>Xác nhận</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Merge Email Modal (after Google link) ─────────────────────── */}
      {mergePrompt && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setMergePrompt(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setMergePrompt(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setMergePrompt(null)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>{t('ACCT_MERGE_TITLE')}</Text>
              <Text style={styles.modalBody}>
                {t('ACCT_MERGE_BODY').replace('{provider}', mergePrompt.provider).replace('{email}', mergePrompt.email)}
              </Text>
              <View style={styles.modalBtnRow}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => setMergePrompt(null)}
                >
                  <Text style={styles.modalBtnCancelText}>{t('ACCT_MERGE_BTN_NO')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnConfirm]}
                  onPress={handleMergeEmail}
                >
                  <Text style={styles.modalBtnConfirmText}>{t('ACCT_MERGE_BTN_YES')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

    </SafeAreaView>
  )
}

// ─── Linked account row ───────────────────────────────────────────────────────
function LinkedAccountRow({ icon, label, linked, onPress, linking, onUnlinkPress, unlinking, unlinkExpanded, iconSize }: {
  icon: any
  label: string
  linked: boolean
  onPress?: () => void      // tap whole row: when not linked → link confirm, when linked → toggle Unlink btn
  linking?: boolean
  onUnlinkPress?: () => void   // tap Unlink → open unlink confirmation
  unlinking?: boolean
  unlinkExpanded?: boolean     // whether the Unlink button is currently visible
  iconSize?: number            // override icon size (default 24)
}) {
  const { t } = useTranslation()
  const inner = (
    <View style={[styles.linkedRow, (linking || unlinking) && { opacity: 0.6 }]}>
      <View style={{ position: 'relative', marginRight: 12 }}>
        <Image source={icon} style={[styles.linkedIcon, iconSize ? { width: iconSize, height: iconSize } : undefined]} resizeMode="contain" />
        {linked && (
          <View style={styles.linkedCheckBadge}>
            <Text style={styles.linkedCheckText}>✓</Text>
          </View>
        )}
      </View>
      <Text style={styles.linkedLabel}>{label}</Text>
      {linking ? (
        <ActivityIndicator size="small" color="#FF6017" />
      ) : linked ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={[styles.linkedBadge, styles.linkedBadgeOn]}>
            <Text style={[styles.linkedBadgeText, styles.linkedBadgeTextOn]}>✓ {t('ACCT_LINKED_BADGE')}</Text>
          </View>
          {unlinkExpanded && onUnlinkPress && (
            <TouchableOpacity
              style={styles.unlinkBtn}
              onPress={onUnlinkPress}
              disabled={unlinking}
              hitSlop={8}
            >
              {unlinking
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.unlinkBtnText}>{t('ACCT_BTN_UNLINK')}</Text>}
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={[styles.linkedBadge, styles.linkedBadgeOff]}>
          <Text style={[styles.linkedBadgeText, styles.linkedBadgeTextOff]}>{t('ACCT_UNLINKED_BADGE')}</Text>
        </View>
      )}
    </View>
  )

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={!!(linking || unlinking)}>
        {inner}
      </TouchableOpacity>
    )
  }
  return inner
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f5f5f7' },
  container: { flex: 1 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'flex-start' },
  backIcon: { width: 22, height: 22, tintColor: '#222' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#111' },

  settingsSearchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#fff' },
  settingsSearchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f0f2', borderRadius: 24, paddingHorizontal: 14, paddingVertical: 10 },
  settingsSearchIcon: { width: 18, height: 18, tintColor: '#888', marginRight: 8, resizeMode: 'contain' as const },
  settingsSearchInput: { flex: 1, color: '#111', fontSize: 15, paddingVertical: 0 },

  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 6,
    marginHorizontal: 20,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },

  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },

  inputRow: { flexDirection: 'row', alignItems: 'stretch', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff' },
  input: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#111' },
  inlineBtn: { backgroundColor: '#FF6017', width: 48, justifyContent: 'center', alignItems: 'center', borderTopRightRadius: 9, borderBottomRightRadius: 9 },

  readonlyRow: { backgroundColor: '#f5f5f7', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  readonlyText: { fontSize: 15, color: '#555' },

  contactItemRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  contactHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  contactHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  contactItemLabel: { fontSize: 13, fontWeight: '600', color: '#666', width: 56 },
  contactItemValue: { fontSize: 14, color: '#111', marginBottom: 2 },
  contactDivider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 10 },

  eyeBtn: { padding: 8 },
  eyeIcon: { width: 18, height: 18, tintColor: '#888' },

  badge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeVerified: { backgroundColor: '#dcfce7' },
  badgeUnverified: { backgroundColor: '#fef9c3' },
  badgeText: { fontSize: 11, fontWeight: '600' },
  badgeTextVerified: { color: '#15803d' },
  badgeTextUnverified: { color: '#854d0e' },

  linkBtn: { alignSelf: 'flex-start', paddingVertical: 4 },
  linkText: { fontSize: 13, color: '#3b82f6', fontWeight: '600' },

  pwRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, overflow: 'hidden' },
  pwInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#111' },

  strengthWrapper: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  strengthTrack: { flex: 1, flexDirection: 'row', gap: 4 },
  strengthSegment: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 60 },

  saveBtn: {
    backgroundColor: '#FF6017',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 16,
  },
  saveBtnDisabled: {
    backgroundColor: '#e5e7eb',
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  inputRowLocked: { backgroundColor: '#f5f5f7', borderColor: '#e5e7eb' },
  inputLocked: { color: '#999' },
  inlineBtnDisabled: { backgroundColor: '#e5e7eb' },

  mutedText: { fontSize: 14, color: '#888', fontStyle: 'italic', textAlign: 'center', paddingVertical: 8 },

  linkedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  linkedIcon: { width: 24, height: 24 },
  linkedLabel: { flex: 1, fontSize: 15, color: '#111', fontWeight: '500' },
  linkedBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  linkedBadgeOn: { backgroundColor: '#dcfce7' },
  linkedBadgeOff: { backgroundColor: '#f3f4f6' },
  linkedBadgeText: { fontSize: 12, fontWeight: '600' },
  linkedBadgeTextOn: { color: '#15803d' },
  linkedBadgeTextOff: { color: '#6b7280' },
  linkedCheckBadge: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  linkedCheckText: { color: '#fff', fontSize: 8, fontWeight: '700', lineHeight: 10 },
  linkedChevron: { fontSize: 20, color: '#bbb', marginLeft: 2, lineHeight: 24 },

  unlinkBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  unlinkBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '82%',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 10,
  },
  modalCloseBtn: { position: 'absolute', top: 12, right: 14, padding: 6 },
  modalCloseText: { fontSize: 18, color: '#888', fontWeight: '400', lineHeight: 22 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#111', marginBottom: 12, marginTop: 4 },
  modalBody: { fontSize: 14, color: '#444', lineHeight: 20, marginBottom: 20 },
  modalBtnRow: { flexDirection: 'row', gap: 10 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  modalBtnCancel: { backgroundColor: '#f3f4f6' },
  modalBtnConfirm: { backgroundColor: '#FF6017' },
  modalBtnCancelText: { fontSize: 15, fontWeight: '600', color: '#555' },
  modalBtnConfirmText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  modalBtnDanger: { backgroundColor: '#ef4444' },
  loadingOverlay: { flex: 1, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', gap: 16 },
  loadingOverlayAbsolute: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#fff',
    justifyContent: 'center', alignItems: 'center', gap: 16,
    zIndex: 999,
    elevation: 10,
  },
  loadingOverlayText: { fontSize: 15, color: '#888', fontWeight: '500' },

  successText: { fontSize: 13, color: '#15803d', marginTop: 6, fontWeight: '500' },
  errorText: { fontSize: 13, color: '#dc2626', marginTop: 6 },
})
