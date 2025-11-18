import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, router, Stack } from 'expo-router';
import { getVerificationStatus, resendVerification } from '@/lib/backendApi';

export default function WaitingForVerificationScreen() {
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
				// redirect to login so user can authenticate now
				setTimeout(() => router.replace('/(auth)/login'), 1000);
			}
		} catch (e: any) {
			setError(e.message || 'Failed checking status');
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
			if (!r.resent) setError('Resend failed or limit reached');
		} catch (e: any) {
			setError(e.message || 'Resend error');
		} finally {
			setResendLoading(false);
		}
	};

	return (
		<>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.container}>
				<Text style={styles.title}>Verify Your Email</Text>
				<Text style={styles.subtitle}>We sent a verification link to:</Text>
				<Text style={styles.email}>{email}</Text>
				{verified ? <Text style={styles.verified}>Email verified! Redirecting…</Text> : null}
				{!verified && (
					<>
						<Text style={styles.info}>Please open the link in your inbox. This page will auto-update.</Text>
						<TouchableOpacity onPress={handleResend} disabled={resendLoading} style={[styles.resendBtn, resendLoading && { opacity: 0.7 }]}> 
							{resendLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.resendText}>Resend Email</Text>}
						</TouchableOpacity>
						<TouchableOpacity onPress={poll} style={styles.manualCheck}><Text style={styles.manualCheckText}>I have verified – Check now</Text></TouchableOpacity>
					</>
				)}
				{!statusChecked && !error && <ActivityIndicator style={{ marginTop: 20 }} />}
				{error && <Text style={styles.error}>{error}</Text>}
				<TouchableOpacity onPress={() => router.replace('/(auth)/login')} style={styles.backLogin}><Text style={styles.backLoginText}>Back to Login</Text></TouchableOpacity>
			</View>
		</>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, paddingHorizontal: 28, paddingTop: 80, backgroundColor: '#f8f8f8' },
	title: { fontSize: 30, fontWeight: '800', color: '#15803d', textAlign: 'center', marginBottom: 16 },
	subtitle: { textAlign: 'center', fontSize: 14, color: '#15803d' },
	email: { textAlign: 'center', fontSize: 16, fontWeight: '600', marginTop: 4, marginBottom: 24, color: '#6A6B6B' },
	info: { textAlign: 'center', fontSize: 14, color: '#6A6B6B', marginBottom: 24 },
	resendBtn: { backgroundColor: '#15803d', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 12 },
	resendText: { color: '#fff', fontWeight: '600', fontSize: 18 },
	manualCheck: { alignItems: 'center', marginBottom: 24 },
	manualCheckText: { color: '#15803d', fontWeight: '600', textDecorationLine: 'underline' },
	error: { color: '#dc2626', textAlign: 'center', marginTop: 12 },
	verified: { color: '#15803d', textAlign: 'center', fontWeight: '700', marginBottom: 20 },
	backLogin: { alignItems: 'center', marginTop: 'auto', marginBottom: 40 },
	backLoginText: { color: '#15803d', fontWeight: '700' }
});
