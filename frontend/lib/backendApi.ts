import { API_BASE_URL } from '@/env'

type Json = Record<string, any>

async function request(path: string, options: RequestInit & { debugLabel?: string } = {}) {
	const url = `${API_BASE_URL.replace(/\/$/, '')}${path}`
	const t0 = Date.now()
	const debugLabel = options.debugLabel || path
	const res = await fetch(url, {
		method: options.method || 'GET',
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {})
		},
		body: options.body,
	})
	const text = await res.text()
	let data: any = null
	try { data = text ? JSON.parse(text) : null } catch (e) { /* non-json */ }
	const elapsed = Date.now() - t0
	// Extremely detailed debug logs as requested
	console.log('[backendApi]', debugLabel, { url, status: res.status, elapsedMs: elapsed, raw: text?.slice(0,500) })
	if (!res.ok) {
		const detail = (data && (data.detail || data.error)) || `HTTP ${res.status}`
		throw new Error(detail)
	}
	return data
}

export async function authSignup(payload: { username: string; email: string; password: string; accountName?: string; role?: string }) {
	return request('/auth/signup', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'authSignup'
	})
}

export async function authLogin(payload: { identifier: string; password: string }) {
	return request('/auth/login', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'authLogin'
	})
}
