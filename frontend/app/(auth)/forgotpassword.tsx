import React, { useState } from 'react'
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Image } from 'react-native'
import { Stack, router } from 'expo-router'
import { requestPasswordReset } from '@/lib/backendApi'
import { ICONS } from '@/constants/icons'

const ForgotPasswordScreen = () => {
  const [identifier, setIdentifier] = useState('') // email or username
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setStatusMsg(null)
    const id = identifier.trim()
    if (!id) {
      setStatusMsg('Enter email or username.')
      return
    }
    setSubmitting(true)
    try {
      await requestPasswordReset(id)
      setStatusMsg('If the account exists, a reset link was sent.')
      setIdentifier('')
    } catch (e: any) {
      // Backend always returns ok, but handle unexpected transport errors
      setStatusMsg(e.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.logoWrapper}>
          <Image source={ICONS.app_icon} style={styles.logo} />
          <Text style={styles.title}>Forgot Password</Text>
        </View>
        <Text style={styles.helper}>Enter your email or username and we&apos;ll send a reset link.</Text>
        <TextInput
          placeholder="Email or Username"
          placeholderTextColor={COLORS.dark300}
          value={identifier}
          onChangeText={(t) => { setIdentifier(t); if (statusMsg) setStatusMsg(null); }}
          autoCapitalize="none"
          style={styles.input}
        />
        {statusMsg && <Text style={styles.status}>{statusMsg}</Text>}
        <TouchableOpacity disabled={submitting} onPress={handleSubmit} style={[styles.button, submitting && { opacity: 0.7 }]}>
          <Text style={styles.buttonText}>{submitting ? 'Submitting...' : 'Send Reset Link'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={styles.backLinkWrap}>
          <Text style={styles.backLink}>Back to Login</Text>
        </TouchableOpacity>
      </View>
    </>
  )
}

export default ForgotPasswordScreen

const COLORS = {
  dark300: '#6A6B6B',
  green700: '#15803d',
  white: '#ffffff',
  bg: '#f8f8f8',
  red600: '#dc2626'
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 28, paddingTop: 80 },
  logoWrapper: { alignItems: 'center', marginBottom: 32 },
  logo: { width: 80, height: 80 },
  title: { fontSize: 30, fontWeight: '700', color: COLORS.green700, marginTop: 8 },
  helper: { color: COLORS.dark300, marginBottom: 20, textAlign: 'center' },
  input: { width: '100%', backgroundColor: COLORS.white, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: COLORS.dark300, marginBottom: 16, color: COLORS.dark300 },
  button: { backgroundColor: COLORS.green700, width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  buttonText: { color: COLORS.white, fontWeight: '600', fontSize: 16 },
  status: { textAlign: 'center', marginBottom: 12, color: COLORS.dark300 },
  backLinkWrap: { alignItems: 'center', marginTop: 8 },
  backLink: { color: COLORS.green700, fontWeight: '600' }
})