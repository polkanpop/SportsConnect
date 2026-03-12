import React, { useState } from 'react'
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Image } from 'react-native'
import { Stack, useLocalSearchParams, router } from 'expo-router'
import { resetPassword } from '@/lib/backendApi'
import { ICONS } from '@/constants/icons'

const NewPasswordScreen = () => {
	const { token } = useLocalSearchParams<{ token?: string }>()
	const [pw1, setPw1] = useState('')
	const [pw2, setPw2] = useState('')
	const [visible, setVisible] = useState(false)
	const [visible2, setVisible2] = useState(false)
	const [msg, setMsg] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)

	const doReset = async () => {
		setMsg(null)
		if (!token) { setMsg('Missing token'); return }
		if (!pw1 || !pw2) { setMsg('Enter both password fields'); return }
		if (pw1 !== pw2) { setMsg('Passwords do not match'); return }
		if (pw1.length < 8) { setMsg('Minimum 8 characters'); return }
		setSubmitting(true)
		try {
			const resp = await resetPassword(String(token), pw1)
			if (resp.reset) {
				setMsg('Password updated. You can now log in.')
				setPw1(''); setPw2('')
				// Optional redirect after short delay
				setTimeout(() => router.replace('/(auth)/login'), 1200)
			} else {
				setMsg('Unexpected response')
			}
		} catch (e: any) {
			setMsg(e.message || 'Reset failed')
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
					<Text style={styles.title}>Set New Password</Text>
				</View>
				<Text style={styles.helper}>Create a new password for your account.</Text>
				<View style={styles.passwordRow}>
					<TextInput
						placeholder="New Password"
						placeholderTextColor={COLORS.dark300}
						secureTextEntry={!visible}
						value={pw1}
						onChangeText={(t) => { setPw1(t); if (msg) setMsg(null) }}
						style={styles.passwordInput}
					/>
					<TouchableOpacity onPress={() => setVisible(!visible)}>
						<Image source={visible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
					</TouchableOpacity>
				</View>
				<View style={styles.passwordRow}>
					<TextInput
						placeholder="Confirm Password"
						placeholderTextColor={COLORS.dark300}
						secureTextEntry={!visible2}
						value={pw2}
						onChangeText={(t) => { setPw2(t); if (msg) setMsg(null) }}
						style={styles.passwordInput}
					/>
					<TouchableOpacity onPress={() => setVisible2(!visible2)}>
						<Image source={visible2 ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
					</TouchableOpacity>
				</View>
				{msg && <Text style={styles.status}>{msg}</Text>}
				<TouchableOpacity disabled={submitting} onPress={doReset} style={[styles.button, submitting && { opacity: 0.7 }]}>
					<Text style={styles.buttonText}>{submitting ? 'Updating...' : 'Update Password'}</Text>
				</TouchableOpacity>
				<TouchableOpacity onPress={() => router.replace('/(auth)/login')} style={styles.backLinkWrap}>
					<Text style={styles.backLink}>Back to Login</Text>
				</TouchableOpacity>
			</View>
		</>
	)
}

export default NewPasswordScreen

const COLORS = { dark300: '#6A6B6B', green700: '#15803d', white: '#ffffff', bg: '#f8f8f8' }

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 28, paddingTop: 80 },
	logoWrapper: { alignItems: 'center', marginBottom: 32 },
	logo: { width: 80, height: 80 },
	title: { fontSize: 24, fontWeight: '700', color: COLORS.green700, marginTop: 8 },
	helper: { color: COLORS.dark300, marginBottom: 20, textAlign: 'center' },
	passwordRow: { width: '100%', marginBottom: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.white, borderRadius: 12, borderWidth: 1, borderColor: COLORS.dark300, paddingRight: 12 },
	passwordInput: { flex: 1, paddingVertical: 12, paddingHorizontal: 16, color: COLORS.dark300 },
	eyeIcon: { width: 24, height: 24, tintColor: COLORS.dark300 },
	button: { backgroundColor: COLORS.green700, width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginTop: 8 },
	buttonText: { color: COLORS.white, fontWeight: '600', fontSize: 16 },
	status: { textAlign: 'center', marginBottom: 12, color: COLORS.dark300 },
	backLinkWrap: { alignItems: 'center', marginTop: 10 },
	backLink: { color: COLORS.green700, fontWeight: '600' }
})
