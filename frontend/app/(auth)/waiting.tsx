import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getVerificationStatus, resendVerification } from '@/lib/backendApi';
import { useTranslation } from '@/constants/translations';
import { useThemeColors } from '@/hooks/use-theme-colors';

export default function WaitingForVerificationScreen() {
	const { t } = useTranslation();
	const tc = useThemeColors();
	const { email } = useLocalSearchParams<{ email?: string }>();
	const [statusChecked, setStatusChecked] = useState(false);
	const [verified, setVerified] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [resendLoading, setResendLoading] = useState(false);
	const pollRef = useRef<number | null>(null); // React Native setInterval returns number

	const poll = async () => {
		if (!email || verified) return;
		try {
			const res = await getVerificationStatus(email as string);
			setStatusChecked(true);
			if (res.emailVerified) {
				setVerified(true);
				// If backend auth tokens already exist (deep link verified screen handled persistence), skip login redirect.
				try {
					const rawAuth = await AsyncStorage.getItem('@backendAuth');
					if (rawAuth) {
						console.log('[waiting] email verified; tokens present -> skip login redirect');
						return; // Verified screen will navigate to Home.
					}
				} catch {}
				// No tokens yet: user must login manually now.
				setTimeout(() => router.replace('/(auth)/login'), 900);
			}
		} catch (e: any) {
			setError(e.message || t('AUTH_WAITING_ERR_CHECK_FAILED'));
		}
	};

	useEffect(() => {
		poll();
		pollRef.current = setInterval(poll, 5000); // every 5s
		return () => { if (pollRef.current) clearInterval(pollRef.current); };
	}, [email]);

	const handleResend = async () => {
		if (!email) return;
		setResendLoading(true);
		setError(null);
		try {
			const r = await resendVerification(email as string);
			if (!r.resent) setError(t('AUTH_WAITING_ERR_RESEND_FAILED'));
		} catch (e: any) {
			setError(e.message || t('AUTH_WAITING_ERR_RESEND_ERROR'));
		} finally {
			setResendLoading(false);
		}
	};

	return (
		<>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={[styles.container, { backgroundColor: tc.bgBase }]}>
			<Text style={[styles.title, { color: tc.brand }]}>{t('AUTH_WAITING_TITLE')}</Text>
			<Text style={[styles.subtitle, { color: tc.brand }]}>{t('AUTH_WAITING_SUBTITLE')}</Text>
				<Text style={[styles.email, { color: tc.textSecondary }]}>{email}</Text>
				{verified ? <Text style={[styles.verified, { color: tc.brand }]}>{t('AUTH_WAITING_VERIFIED')}</Text> : null}
				{!verified && (
					<>
					<Text style={[styles.info, { color: tc.textSecondary }]}>{t('AUTH_WAITING_INFO')}</Text>
					<TouchableOpacity onPress={handleResend} disabled={resendLoading} style={[styles.resendBtn, { backgroundColor: tc.brand }, resendLoading && { opacity: 0.7 }]}> 
						{resendLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.resendText}>{t('AUTH_WAITING_BTN_RESEND')}</Text>}
					</TouchableOpacity>
					<TouchableOpacity onPress={poll} style={styles.manualCheck}><Text style={[styles.manualCheckText, { color: tc.brand }]}>{t('AUTH_WAITING_BTN_CHECK')}</Text></TouchableOpacity>
					</>
				)}
				{!statusChecked && !error && <ActivityIndicator style={{ marginTop: 20 }} />}
				{error && <Text style={styles.error}>{error}</Text>}
				<TouchableOpacity onPress={() => router.replace('/(auth)/login')} style={styles.backLogin}><Text style={[styles.backLoginText, { color: tc.brand }]}>{t('AUTH_WAITING_BTN_BACK')}</Text></TouchableOpacity>
			</View>
		</>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, paddingHorizontal: 28, paddingTop: 80, backgroundColor: '#f8f8f8' },
	title: { fontSize: 24, fontWeight: '800', color: '#FF6017', textAlign: 'center', marginBottom: 16 },
	subtitle: { textAlign: 'center', fontSize: 14, color: '#FF6017' },
	email: { textAlign: 'center', fontSize: 16, fontWeight: '600', marginTop: 4, marginBottom: 24, color: '#6A6B6B' },
	info: { textAlign: 'center', fontSize: 14, color: '#6A6B6B', marginBottom: 24 },
	resendBtn: { backgroundColor: '#FF6017', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 12 },
	resendText: { color: '#fff', fontWeight: '600', fontSize: 16 },
	manualCheck: { alignItems: 'center', marginBottom: 24 },
	manualCheckText: { color: '#FF6017', fontWeight: '600', textDecorationLine: 'underline' },
	error: { color: '#dc2626', textAlign: 'center', marginTop: 12 },
	verified: { color: '#FF6017', textAlign: 'center', fontWeight: '700', marginBottom: 20 },
	backLogin: { alignItems: 'center', marginTop: 'auto', marginBottom: 40 },
	backLoginText: { color: '#FF6017', fontWeight: '700' }
});
