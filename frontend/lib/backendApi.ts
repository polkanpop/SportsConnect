import { API_BASE_URL } from '@/env'
import { fetchWithCache, getCache, invalidateByPrefix, invalidateCache, setCache } from '@/lib/cache'
import { queryClient } from '@/providers/query-provider'
import { supabase } from './supabase'
import AsyncStorage from '@react-native-async-storage/async-storage'

type Json = Record<string, any>

let refreshTokenPromise: Promise<boolean> | null = null

async function refreshAccessTokenRequest(): Promise<boolean> {
	try {
		const raw = await AsyncStorage.getItem('@backendAuth')
		if (!raw) return false
		let parsed: any
		try { parsed = JSON.parse(raw) } catch { return false }
		const refreshToken: string | undefined = parsed?.refreshToken
		if (!refreshToken) return false
		const resp = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/auth/refresh`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken })
		})
		const text = await resp.text()
		let data: any = null
		try { data = text ? JSON.parse(text) : null } catch {}
		if (!resp.ok) return false
		if (data?.accessToken) {
			parsed.accessToken = data.accessToken
			parsed.accessTokenExpiresAt = data.accessTokenExpiresAt
			await AsyncStorage.setItem('@backendAuth', JSON.stringify(parsed))
			await AsyncStorage.setItem('@localAuthToken', data.accessToken)
			return true
		}
	} catch (e) {
		console.warn('[refreshAccessToken] failed', (e as any)?.message)
	}
	return false
}

async function refreshAccessToken(): Promise<boolean> {
	if (refreshTokenPromise) return refreshTokenPromise
	refreshTokenPromise = refreshAccessTokenRequest().finally(() => {
		refreshTokenPromise = null
	})
	return refreshTokenPromise
}

async function getLocalBackendToken(): Promise<{ token?: string; exp?: number } | null> {
	try {
		const raw = await AsyncStorage.getItem('@backendAuth')
		if (!raw) return null
		const parsed = JSON.parse(raw)
		const token: string | undefined = parsed?.accessToken
		const expIso: string | undefined = parsed?.accessTokenExpiresAt
		let expTs: number | undefined
		if (expIso) {
			try { expTs = Date.parse(expIso) } catch {}
		}
		return { token, exp: expTs }
	} catch { return null }
}

function isProtectedEndpoint(path: string): boolean {
	return /^(?:\/courtbookings|\/servicebookings|\/courts|\/events|\/eventbookings|\/trainingsessions|\/trainingsessioninfo|\/tsbookings|\/blocklist|\/favouritecourts|\/courtavailability|\/courtinfo|\/userinfo|\/cloudinary|\/notifications|\/reviews|\/me|\/venues)/.test(path)
}

function isRefreshEndpoint(path: string): boolean {
	return /^\/auth\/refresh(?:\?|$)/.test(path)
}

async function buildAuthHeader(): Promise<Record<string, string>> {
	const backendTok = await getLocalBackendToken()
	const now = Date.now()
	if (backendTok?.token && backendTok.exp && backendTok.exp > now + 5_000) {
		return { Authorization: `Bearer ${backendTok.token}` }
	}

	try {
		const { data } = await supabase.auth.getSession()
		const token = data?.session?.access_token
		if (token) {
			return { Authorization: `Bearer ${token}` }
		}
	} catch {}

	try {
		const localToken = await AsyncStorage.getItem('@localAuthToken')
		if (localToken) return { Authorization: `Bearer ${localToken}` }
	} catch {}

	return {}
}

async function request(path: string, options: RequestInit & { debugLabel?: string } = {}, attempt: number = 0) {
	const url = `${API_BASE_URL.replace(/\/$/, '')}${path}`
	const t0 = Date.now()
	const debugLabel = options.debugLabel || path
	const protectedEndpoint = isProtectedEndpoint(path)
	if (protectedEndpoint && !isRefreshEndpoint(path)) {
		const bt = await getLocalBackendToken()
		const nowMs = Date.now()
		if (bt?.token && bt.exp && bt.exp <= nowMs + 30_000) { // expires within 30s or already
			await refreshAccessToken()
		}
	}
	const authHeader = await buildAuthHeader()
	const res = await fetch(url, {
		method: options.method || 'GET',
		signal: options.signal,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...authHeader,
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
		const detailRaw = (data && (data.detail || data.error)) || `HTTP ${res.status}`
		const detail = typeof detailRaw === 'string' ? detailRaw : (() => {
			try { return JSON.stringify(detailRaw) } catch { return String(detailRaw) }
		})()
		if (res.status === 401 && attempt === 0 && protectedEndpoint && !isRefreshEndpoint(path)) {
			const refreshed = await refreshAccessToken()
			if (refreshed) {
				return request(path, options, 1)
			}
		}
		throw new Error(detail)
	}
	return data
}

// ---- Notifications ----

export type NotificationCategory = 'court' | 'event' | 'training'
export type NotificationStatus = 'unread' | 'read'

export type NotificationRow = {
	notificationid: number
	status: NotificationStatus | string
	userid: number
	title: string
	message: string
	time: string
	notificationtype: string
	notificationtypeid?: number | null
	category?: NotificationCategory | null
	kind?: string | null
	data?: Record<string, any> | null
	read_at?: string | null
}

export async function listNotifications(params: {
	category?: NotificationCategory
	status?: NotificationStatus
	limit?: number
	offset?: number
} = {}): Promise<NotificationRow[]> {
	const qs = new URLSearchParams()
	if (params.category) qs.set('category', params.category)
	if (params.status) qs.set('status', params.status)
	if (typeof params.limit === 'number') qs.set('limit', String(params.limit))
	if (typeof params.offset === 'number') qs.set('offset', String(params.offset))
	const suffix = qs.toString() ? `?${qs.toString()}` : ''
	const data = await request(`/notifications${suffix}`, { debugLabel: 'listNotifications' })
	return Array.isArray(data) ? (data as NotificationRow[]) : []
}

export async function markNotificationRead(notificationid: number): Promise<NotificationRow> {
	return await request(`/notifications/${notificationid}/read`, {
		method: 'PATCH',
		debugLabel: 'markNotificationRead'
	}) as NotificationRow
}

export async function markAllNotificationsRead(category?: NotificationCategory): Promise<{ ok: boolean }> {
	const suffix = category ? `?category=${encodeURIComponent(category)}` : ''
	return await request(`/notifications/mark_all_read${suffix}`, {
		method: 'PATCH',
		debugLabel: 'markAllNotificationsRead'
	}) as { ok: boolean }
}

// ---- Auto status completion (upcoming -> completed) ----
// Some UIs rely on status enums rather than timestamps.
// This performs best-effort background updates so passed items are not shown.
let autoCompleteLastRunMs = 0
let autoCompleteInFlight: Promise<void> | null = null

function parseTimestampLoose(raw: unknown): Date | null {
	if (typeof raw !== 'string') return null
	const s = raw.trim()
	if (!s) return null
	let d = new Date(s)
	if (!Number.isNaN(d.getTime())) return d
	// Postgres: "YYYY-MM-DD HH:mm:ss" (Hermes can treat as invalid)
	const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/)
	if (m) {
		d = new Date(`${m[1]}T${m[2]}:00`)
		if (!Number.isNaN(d.getTime())) return d
	}
	return null
}

function shouldAutoCompleteStatus(statusRaw: unknown): boolean {
	const st = String(statusRaw ?? '').trim().toLowerCase()
	return st === 'upcoming'
}

function isPastEnd(endRaw: unknown, fallbackStartRaw: unknown): boolean {
	const end = parseTimestampLoose(endRaw)
	const start = parseTimestampLoose(fallbackStartRaw)
	const now = Date.now()
	if (end && !Number.isNaN(end.getTime())) return end.getTime() < now
	if (start && !Number.isNaN(start.getTime())) return start.getTime() < now
	return false
}

async function autoCompletePastStatusesInBackground(payload: {
	events?: CombinedEvent[]
	sessions?: CombinedTrainingSession[]
	bookings?: CourtBookingRow[]
}): Promise<void> {
	const nowMs = Date.now()
	// Throttle to avoid spamming updates across screens.
	if (autoCompleteInFlight) return autoCompleteInFlight
	if (nowMs - autoCompleteLastRunMs < 30_000) return

	autoCompleteInFlight = (async () => {
		autoCompleteLastRunMs = Date.now()
		const eventIdsToComplete: number[] = []
		const sessionIdsToComplete: number[] = []
		const bookingIdsToComplete: number[] = []

		for (const ev of payload.events || []) {
			if (!shouldAutoCompleteStatus((ev as any).status)) continue
			if (isPastEnd((ev as any).end_timestamp, (ev as any).start_timestamp ?? (ev as any).time)) {
				if (typeof (ev as any).eventid === 'number') eventIdsToComplete.push((ev as any).eventid)
			}
		}
		for (const s of payload.sessions || []) {
			if (!shouldAutoCompleteStatus((s as any).status)) continue
			if (isPastEnd((s as any).end_timestamp, (s as any).start_timestamp ?? (s as any).time)) {
				if (typeof (s as any).sessionid === 'number') sessionIdsToComplete.push((s as any).sessionid)
			}
		}
		for (const b of payload.bookings || []) {
			const st = String((b as any).bookingstatus ?? '').trim().toLowerCase()
			if (st !== 'upcoming') continue
			if (isPastEnd((b as any).end_timestamp, (b as any).start_timestamp)) {
				if (typeof (b as any).courtbookingid === 'number') bookingIdsToComplete.push((b as any).courtbookingid)
			}
		}

		if (!eventIdsToComplete.length && !sessionIdsToComplete.length && !bookingIdsToComplete.length) return

		const ops: Promise<any>[] = []
		for (const id of eventIdsToComplete) {
			ops.push(
				request(`/events/${encodeURIComponent(String(id))}`, {
					method: 'PATCH',
					body: JSON.stringify({ status: 'completed' }),
					debugLabel: 'autoCompleteEvent',
				})
			)
		}
		for (const id of sessionIdsToComplete) {
			ops.push(
				request(`/trainingsessions/${encodeURIComponent(String(id))}`, {
					method: 'PATCH',
					body: JSON.stringify({ status: 'completed' }),
					debugLabel: 'autoCompleteTrainingSession',
				})
			)
		}
		for (const id of bookingIdsToComplete) {
			ops.push(
				request(`/courtbookings/${encodeURIComponent(String(id))}`, {
					method: 'PATCH',
					body: JSON.stringify({ bookingstatus: 'completed' }),
					debugLabel: 'autoCompleteCourtBooking',
				})
			)
		}

		await Promise.allSettled(ops)
		// Bust combined caches once so subsequent reads reflect completion.
		try { await invalidateCache('cache:events:combined:v1') } catch {}
		try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
	})()

	try {
		await autoCompleteInFlight
	} finally {
		autoCompleteInFlight = null
	}
}

export type CourtGeocode = {
	formatted_address?: string | null
	latitude: number
	longitude: number
	location_type?: string | null
	place_id?: string | null
	types?: string[]
	city?: string | null
	state?: string | null
	postal_code?: string | null
	accuracy_type?: string | null
	accuracy_score?: number | null
	warnings?: string[]
}

export async function geocodeCourtAddress(address: string): Promise<CourtGeocode> {
	return request(`/courts/geocode?address=${encodeURIComponent(address)}`, {
		method: 'GET',
		debugLabel: 'courts.geocode',
	})
}

export type CourtAddressSuggestion = {
	description: string
	place_id: string
	main_text?: string | null
	secondary_text?: string | null
}

export async function autocompleteCourtAddress(input: string, limit: number = 5): Promise<CourtAddressSuggestion[]> {
	return request(
		`/courts/autocomplete?input=${encodeURIComponent(input)}&limit=${encodeURIComponent(String(limit))}`,
		{ method: 'GET', debugLabel: 'courts.autocomplete' }
	)
}

export async function geocodeCourtPlaceId(placeId: string): Promise<CourtGeocode> {
	return request(`/courts/geocode-place?place_id=${encodeURIComponent(placeId)}`, {
		method: 'GET',
		debugLabel: 'courts.geocodePlace',
	})
}

export type DistanceMatrixResult = {
	distance_meters?: number | null
	duration_seconds?: number | null
	distance_text?: string | null
	duration_text?: string | null
	warnings?: string[]
}

type DistanceMatrixCacheStatus = 'loading' | 'loaded' | 'error'
type DistanceMatrixCacheEntry = {
	status: DistanceMatrixCacheStatus
	result: DistanceMatrixResult
	updatedAt: number
}

const distanceMatrixCache = new Map<string, DistanceMatrixCacheEntry>()
const distanceMatrixInFlight = new Map<string, Promise<DistanceMatrixResult>>()
const distanceMatrixListeners = new Set<() => void>()

function notifyDistanceMatrixListeners() {
	for (const l of distanceMatrixListeners) {
		try { l() } catch {}
	}
}

export function subscribeDistanceMatrixCache(listener: () => void) {
	distanceMatrixListeners.add(listener)
	return () => {
		distanceMatrixListeners.delete(listener)
	}
}

function roundCoord(n: number) {
	// 4 decimals ~= 11m; reduces key churn while staying accurate enough for caching.
	return Math.round(n * 10_000) / 10_000
}

export function makeDistanceMatrixCacheKey(payload: {
	origin_lat: number
	origin_lng: number
	dest_lat: number
	dest_lng: number
}) {
	const oLat = roundCoord(payload.origin_lat)
	const oLng = roundCoord(payload.origin_lng)
	const dLat = roundCoord(payload.dest_lat)
	const dLng = roundCoord(payload.dest_lng)
	return `${oLat},${oLng}|${dLat},${dLng}`
}

export function peekDistanceMatrixCached(payload: {
	origin_lat: number
	origin_lng: number
	dest_lat: number
	dest_lng: number
}): DistanceMatrixCacheEntry | undefined {
	const key = makeDistanceMatrixCacheKey(payload)
	return distanceMatrixCache.get(key)
}

export async function getDistanceMatrix(payload: {
	origin_lat: number
	origin_lng: number
	dest_lat: number
	dest_lng: number
}): Promise<DistanceMatrixResult> {
	const q = new URLSearchParams({
		origin_lat: String(payload.origin_lat),
		origin_lng: String(payload.origin_lng),
		dest_lat: String(payload.dest_lat),
		dest_lng: String(payload.dest_lng),
	})
	return request(`/courts/distance-matrix?${q.toString()}`, {
		method: 'GET',
		debugLabel: 'courts.distanceMatrix',
	})
}

export async function getDistanceMatrixBatch(payload: {
	origin_lat: number
	origin_lng: number
	destinations: { dest_lat: number; dest_lng: number }[]
}): Promise<DistanceMatrixResult[]> {
	const body = {
		origin_lat: payload.origin_lat,
		origin_lng: payload.origin_lng,
		destinations: payload.destinations.map(d => ({ dest_lat: d.dest_lat, dest_lng: d.dest_lng })),
	}
	const data = await request(`/courts/distance-matrix/batch`, {
		method: 'POST',
		body: JSON.stringify(body),
		debugLabel: 'courts.distanceMatrixBatch',
	})
	const results = Array.isArray(data?.results) ? data.results : []
	return results
}

// Cached variant: ensures a given origin/destination pair is fetched only once per app runtime.
// This reduces Goong costs and also allows different screens to reuse already-fetched results.
export async function getDistanceMatrixCached(payload: {
	origin_lat: number
	origin_lng: number
	dest_lat: number
	dest_lng: number
}): Promise<DistanceMatrixResult> {
	const key = makeDistanceMatrixCacheKey(payload)
	const existing = distanceMatrixCache.get(key)
	if (existing && (existing.status === 'loaded' || existing.status === 'error')) {
		return existing.result
	}
	const inflight = distanceMatrixInFlight.get(key)
	if (inflight) return inflight

	const p = (async () => {
		distanceMatrixCache.set(key, {
			status: 'loading',
			result: { distance_meters: null, duration_seconds: null },
			updatedAt: Date.now(),
		})
		notifyDistanceMatrixListeners()
		try {
			const result = await getDistanceMatrix(payload)
			distanceMatrixCache.set(key, {
				status: 'loaded',
				result,
				updatedAt: Date.now(),
			})
			notifyDistanceMatrixListeners()
			return result
		} catch {
			const result: DistanceMatrixResult = { distance_meters: null, duration_seconds: null }
			distanceMatrixCache.set(key, {
				status: 'error',
				result,
				updatedAt: Date.now(),
			})
			notifyDistanceMatrixListeners()
			return result
		} finally {
			distanceMatrixInFlight.delete(key)
		}
	})()

	distanceMatrixInFlight.set(key, p)
	return p
}

// Batch-prefetch variant: fetches up to 25 destinations in one request and populates the same runtime cache
// entries used by getDistanceMatrixCached/peekDistanceMatrixCached.
export async function prefetchDistanceMatrixBatchCached(payload: {
	origin_lat: number
	origin_lng: number
	destinations: { dest_lat: number; dest_lng: number }[]
}): Promise<void> {
	const origin_lat = payload.origin_lat
	const origin_lng = payload.origin_lng
	const destinations = Array.isArray(payload.destinations) ? payload.destinations : []
	if (!destinations.length) return

	const waiters: Promise<any>[] = []

	// De-dupe and keep only destinations that are not already resolved or in-flight.
	const unique: { dest_lat: number; dest_lng: number; key: string }[] = []
	const seen = new Set<string>()
	for (const d of destinations) {
		if (typeof d?.dest_lat !== 'number' || typeof d?.dest_lng !== 'number') continue
		const key = makeDistanceMatrixCacheKey({ origin_lat, origin_lng, dest_lat: d.dest_lat, dest_lng: d.dest_lng })
		if (seen.has(key)) continue
		seen.add(key)
		const existing = distanceMatrixCache.get(key)
		if (existing && (existing.status === 'loaded' || existing.status === 'error')) continue
		const inflight = distanceMatrixInFlight.get(key)
		if (inflight) {
			waiters.push(inflight)
			continue
		}
		unique.push({ dest_lat: d.dest_lat, dest_lng: d.dest_lng, key })
	}
	if (!unique.length) {
		if (waiters.length) await Promise.allSettled(waiters)
		return
	}

	// Chunk to respect provider limits (25 destinations per request).
	for (let i = 0; i < unique.length; i += 25) {
		const chunk = unique.slice(i, i + 25)
		for (const item of chunk) {
			distanceMatrixCache.set(item.key, {
				status: 'loading',
				result: { distance_meters: null, duration_seconds: null },
				updatedAt: Date.now(),
			})
		}
		notifyDistanceMatrixListeners()

		const chunkPromise = (async () => {
			try {
				const results = await getDistanceMatrixBatch({
					origin_lat,
					origin_lng,
					destinations: chunk.map(c => ({ dest_lat: c.dest_lat, dest_lng: c.dest_lng })),
				})
				for (let j = 0; j < chunk.length; j++) {
					const item = chunk[j]
					const result: DistanceMatrixResult = (results && results[j]) ? results[j] : { distance_meters: null, duration_seconds: null }
					distanceMatrixCache.set(item.key, {
						status: 'loaded',
						result,
						updatedAt: Date.now(),
					})
				}
				notifyDistanceMatrixListeners()
			} catch {
				for (const item of chunk) {
					distanceMatrixCache.set(item.key, {
						status: 'error',
						result: { distance_meters: null, duration_seconds: null },
						updatedAt: Date.now(),
					})
				}
				notifyDistanceMatrixListeners()
			} finally {
				for (const item of chunk) {
					distanceMatrixInFlight.delete(item.key)
				}
			}
		})()
		waiters.push(chunkPromise)

		for (const item of chunk) {
			// Per-destination in-flight promise (so other call sites can dedupe).
			distanceMatrixInFlight.set(
				item.key,
				chunkPromise.then(() => distanceMatrixCache.get(item.key)?.result ?? { distance_meters: null, duration_seconds: null })
			)
		}
	}

	if (waiters.length) await Promise.allSettled(waiters)
}

export type CourtRegisterRequest = {
	name: string
	address: string
	ownerid: number
	venue: 'Indoor' | 'Outdoor' | 'Both'
	images: string[]
	allow_half_court?: boolean
	playing_courts?: Array<{
		name: string
		full_price?: number
		allow_half_booking?: boolean
		half_a_name?: string
		half_b_name?: string
		half_a_price?: number
		half_b_price?: number
		description?: string
		images: string[]
		half_a_images?: string[]
		half_b_images?: string[]
		surface?: 'hardwood' | 'concrete' | 'synthetic' | string
	}>
	services?: Array<{
		name: string
		category: 'consumable' | 'rental' | string
		price: number
		stock?: number
		images?: string[]
	}>
	latitude?: number
	longitude?: number
	accuracy_type?: string
	schedule?: {
		booking_date: string[]
		start_time: string
		end_time: string
	}
}

export type CourtRegisterResponse = {
	courtid: number
	courtinfoid: number
	geocode: CourtGeocode
}

export async function registerCourt(payload: CourtRegisterRequest): Promise<CourtRegisterResponse> {
	return request('/courts/register', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'courts.register',
	})
}

// Centralized persistence of backend auth/session related data.
// Accepts any object containing userid/profile fields and token fields.
// Optionally sets remember flag.
export async function persistAuthSession(data: any, opts?: { rememberMe?: boolean }) {
	try {
		if (data?.userid != null) {
			await AsyncStorage.setItem('@backendProfile', JSON.stringify({
				userid: data.userid,
				username: data.username ?? null,
				name: data.name ?? null,
				email: data.email ?? null,
			}))
		}
	} catch {}
	// Prefer access/refresh token bundle; fallback to legacy single token
	try {
		if (data?.accessToken && data?.refreshToken) {
			await AsyncStorage.setItem('@backendAuth', JSON.stringify({
				accessToken: data.accessToken,
				accessTokenExpiresAt: data.accessTokenExpiresAt,
				refreshToken: data.refreshToken,
				refreshTokenExpiresAt: data.refreshTokenExpiresAt,
				userid: data.userid,
			}))
			// Legacy bearer fallback for request()
			await AsyncStorage.setItem('@localAuthToken', data.accessToken)
		} else if (data?.token) {
			await AsyncStorage.setItem('@localAuthToken', data.token)
		}
	} catch {}
	try {
		if (opts?.rememberMe) {
			await AsyncStorage.setItem('@rememberAuth', 'true')
		} else if (opts && opts.rememberMe === false) {
			await AsyncStorage.removeItem('@rememberAuth')
		}
	} catch {}
}

export async function authSignup(payload: { username: string; email: string; password: string; accountName?: string; role?: string }) {
	const data = await request('/auth/signup', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'authSignup'
	})
	// Token intentionally omitted until email verified
	try { if (data?.userid != null) await AsyncStorage.setItem('@backendProfilePending', JSON.stringify(data)) } catch {}
	return data
}

export async function authLogin(payload: { identifier: string; password: string; rememberMe?: boolean }) {
	const data = await request('/auth/login', {
		method: 'POST',
		body: JSON.stringify({ identifier: payload.identifier, password: payload.password, rememberMe: !!payload.rememberMe }),
		debugLabel: 'authLogin'
	})
	await persistAuthSession(data, { rememberMe: !!payload.rememberMe })
	return data
}

// ---- Email Verification Helpers ----
export async function getVerificationStatus(email: string): Promise<{ emailVerified: boolean }> {
	const data = await request(`/auth/verification-status?email=${encodeURIComponent(email)}`, { debugLabel: 'getVerificationStatus' })
	return { emailVerified: !!data?.emailVerified }
}

export async function resendVerification(email: string): Promise<{ resent: boolean }> {
	const data = await request('/auth/resend-verification', {
		method: 'POST',
		body: JSON.stringify({ email }),
		debugLabel: 'resendVerification'
	})
	return { resent: !!data?.resent }
}

// Backend logout using stored refreshToken; returns true if revoked
export async function authLogout(): Promise<boolean> {
	try {
		const raw = await AsyncStorage.getItem('@backendAuth')
		if (!raw) return false
		let refreshToken: string | null = null
		try { refreshToken = JSON.parse(raw)?.refreshToken } catch {}
		if (!refreshToken) return false
		const resp = await request('/auth/logout', {
			method: 'POST',
			body: JSON.stringify({ refreshToken }),
			debugLabel: 'authLogout'
		})
		return !!resp?.revoked
	} catch (e) {
		console.warn('[authLogout] error', (e as any)?.message)
		return false
	}
}

// App closure/background handler: updates last_used_at or revokes depending on remember flag
export async function authSessionClose(rememberMe: boolean): Promise<{ revoked: boolean; touched: boolean } | null> {
	try {
		const raw = await AsyncStorage.getItem('@backendAuth')
		if (!raw) return null
		let refreshToken: string | null = null
		try { refreshToken = JSON.parse(raw)?.refreshToken } catch {}
		if (!refreshToken) return null
		const resp = await request('/auth/session/close', {
			method: 'POST',
			body: JSON.stringify({ refreshToken, rememberMe }),
			debugLabel: 'authSessionClose'
		})
		return { revoked: !!resp?.revoked, touched: !!resp?.touched }
	} catch (e) {
		console.warn('[authSessionClose] error', (e as any)?.message)
		return null
	}
}

// ---- Password Reset Flow ----
export async function requestPasswordReset(identifier: string): Promise<{ status: string }> {
	const data = await request('/userlogin/forgot-password', {
		method: 'POST',
		body: JSON.stringify({ identifier }),
		debugLabel: 'requestPasswordReset'
	})
	return { status: data?.status || 'ok' }
}

export async function resetPassword(token: string, newPassword: string): Promise<{ status: string; reset?: boolean }> {
	const data = await request('/userlogin/reset-password', {
		method: 'POST',
		body: JSON.stringify({ token, newPassword }),
		debugLabel: 'resetPassword'
	})
	return { status: data?.status || 'ok', reset: !!data?.reset }
}

// ---- Favourite Courts API (public) ----
// Table schema: favouritecourts(favouriteid int PK, userid int, courtid int)
// Endpoints implemented server-side (no auth required):
// GET /api/favouritecourts?userid=&ids_only=
// POST /api/favouritecourts { userid, courtid }
// DELETE /api/favouritecourts/{favouriteid}

export type FavouriteCourt = { favouriteid: number; userid: number; courtid: number }

export async function listFavouriteCourts(params?: { userid?: number; idsOnly?: boolean }) {
	const qs: string[] = []
	if (params?.userid !== undefined) qs.push(`userid=${encodeURIComponent(params.userid)}`)
	if (params?.idsOnly) qs.push(`ids_only=true`)
	const path = `/favouritecourts${qs.length ? '?' + qs.join('&') : ''}`
	const data = await request(path, { debugLabel: 'listFavouriteCourts' })
	return data as FavouriteCourt[] | number[]
}

// Cached variant: per-user favourites are moderately volatile; short TTL
export async function listFavouriteCourtsCached(params: { userid: number; idsOnly?: boolean }) {
	const { userid, idsOnly } = params
	const key = `cache:favouritecourts:user:${userid}:v1${idsOnly ? ':ids' : ''}`
	return fetchWithCache<any[]>({
		key,
		ttlMs: 30 * 1000,
		swrMs: 60 * 1000,
		fetcher: () => listFavouriteCourts({ userid, idsOnly })
	})
}

export async function addFavouriteCourt(userid: number, courtid: number) {
	const body = { userid, courtid }
	const data = await request('/favouritecourts', {
		method: 'POST',
		body: JSON.stringify(body),
		debugLabel: 'addFavouriteCourt'
	})
	// Keep AsyncStorage cached favourites in sync for Map/courtList callers
	try { await invalidateByPrefix(`cache:favouritecourts:user:${userid}:v1`) } catch {}
	return data as FavouriteCourt
}

export async function removeFavouriteCourt(favouriteid: number) {
	const data = await request(`/favouritecourts/${favouriteid}`, {
		method: 'DELETE',
		debugLabel: 'removeFavouriteCourt'
	})
	// We don't have userid here; clear all favourites caches (small + safe)
	try { await invalidateByPrefix('cache:favouritecourts:') } catch {}
	return data as { deleted: boolean; count: number }
}

// ---- User Info API ----
// GET /userinfo?userid=123 returns list[ { infoid, userid, name, email, ... } ]
// Helper to fetch first row by userid.
export type UserInfoRow = { infoid: number; userid: number; name?: string | null; email?: string | null; contactnumber?: string | null; time?: string | null; biography?: string | null; pfp?: string | null; contactvisiblestatus?: boolean | null }

export async function getUserInfoByUserId(userid: number) {
	if (userid == null) throw new Error('userid required')
	const path = `/userinfo?userid=${encodeURIComponent(userid)}`
	const rows = await request(path, { debugLabel: 'getUserInfoByUserId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as UserInfoRow
	return null
}

export async function getMyIdentity(): Promise<UserInfoRow | null> {
	const data = await request('/me/identity', { debugLabel: 'getMyIdentity' })
	if (data && typeof data === 'object') return data as UserInfoRow
	return null
}

export async function updateUserInfo(userid: number, data: Partial<UserInfoRow>) {
	const path = `/userinfo/${encodeURIComponent(userid)}`
	const res = await request(path, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateUserInfo'
	})
	// Invalidate AsyncStorage cached userinfo so cached callers (e.g. Settings) refresh immediately
	try { await invalidateCache(`cache:userinfo:user:${userid}:v1`) } catch {}
	// Also invalidate any react-query userinfo instances
	try {
		queryClient.invalidateQueries({
			predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'userinfo' && q.queryKey[1] === userid
		})
	} catch {}
	return res
}

// ---- Cloudinary (signed uploads) ----
export type CloudinarySignResponse = {
	cloudName: string
	apiKey: string
	timestamp: number
	signature: string
	uploadPreset?: string | null
	folder?: string | null
}

export async function cloudinarySignUpload(payload: {
	public_id?: string
	overwrite?: boolean
	invalidate?: boolean
	folder?: string
	upload_preset?: string
} = {}): Promise<CloudinarySignResponse> {
	const data = await request('/cloudinary/sign', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'cloudinarySignUpload'
	})
	return data as CloudinarySignResponse
}

export async function updateUserPfp(userid: number, pfp: string | null) {
	const res = await request(`/userinfo/${encodeURIComponent(userid)}/pfp`, {
		method: 'PATCH',
		body: JSON.stringify({ pfp }),
		debugLabel: 'updateUserPfp'
	})
	// Keep cache/query in sync
	try { await invalidateCache(`cache:userinfo:user:${userid}:v1`) } catch {}
	try {
		queryClient.invalidateQueries({
			predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'userinfo' && q.queryKey[1] === userid
		})
	} catch {}
	return res
}

export async function deleteMyProfilePicture(): Promise<{ cloudinaryResult: string; pfpCleared: boolean }> {
	const res = await request('/cloudinary/pfp/delete', {
		method: 'POST',
		body: JSON.stringify({}),
		debugLabel: 'deleteMyProfilePicture'
	})
	// Invalidate userinfo caches (userid unknown here; caller may also invalidate their specific key)
	try { invalidateByPrefix('userinfo') } catch {}
	try { queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'userinfo' }) } catch {}
	return { cloudinaryResult: String((res as any)?.cloudinaryResult || ''), pfpCleared: !!(res as any)?.pfpCleared }
}

export async function deleteCloudinaryAssetsByUrl(urls: string[]): Promise<{ deleted: Array<{ url: string; public_id?: string | null; result?: string | null; error?: string | null }> }> {
	const res = await request('/cloudinary/assets/delete', {
		method: 'POST',
		body: JSON.stringify({ urls: Array.isArray(urls) ? urls : [] }),
		debugLabel: 'deleteCloudinaryAssetsByUrl',
	})
	return res as any
}

// Cached variant: user info display name rarely changes; short TTL
export async function getUserInfoByUserIdCached(userid: number) {
	return fetchWithCache<UserInfoRow | null>({
		key: `cache:userinfo:user:${userid}:v1`,
		ttlMs: 60 * 1000,
		swrMs: 120 * 1000,
		fetcher: () => getUserInfoByUserId(userid)
	})
}

export async function getMyIdentityCached(userid: number) {
	return fetchWithCache<UserInfoRow | null>({
		key: `cache:me:identity:user:${userid}:v1`,
		ttlMs: 60 * 1000,
		swrMs: 120 * 1000,
		fetcher: () => getMyIdentity(),
	})
}

// ---- Court Info API ----
// Existing backend endpoint: GET /courtinfo returns list of courtinfo rows.
// Shape needed by Map: courtinfoid,courtid,name,address,latitude,longitude,venue,images,availability
export type CourtInfoRow = {
	courtinfoid: number
	courtid: number
	name?: string | null
	address: string
	latitude?: number | null
	longitude?: number | null
	venue?: string[] | string | null
	images?: string[] | null
	availability?: string | null
	accuracy_type?: string | null
	auto_approve?: boolean | null
}

export async function listCourtInfo(): Promise<CourtInfoRow[]> {
	const data = await request('/courtinfo', { debugLabel: 'listCourtInfo' })
	return Array.isArray(data) ? data as CourtInfoRow[] : []
}

export async function getCourtInfoByCourtId(courtid: number): Promise<CourtInfoRow | null> {
	if (courtid == null) throw new Error('courtid required')
	try {
		const row = await request(`/courtinfo/by-courtid/${encodeURIComponent(courtid)}`, { debugLabel: 'getCourtInfoByCourtId' })
		return (row as CourtInfoRow) || null
	} catch {
		return null
	}
}

export async function updateCourtInfoByCourtId(
	courtid: number,
	patch: Partial<Pick<CourtInfoRow, 'name' | 'address' | 'latitude' | 'longitude' | 'venue' | 'images' | 'availability' | 'accuracy_type' | 'auto_approve'>>
): Promise<CourtInfoRow> {
	if (courtid == null) throw new Error('courtid required')
	const res = await request(`/courtinfo/by-courtid/${encodeURIComponent(courtid)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'updateCourtInfoByCourtId'
	})
	try {
		if (res && typeof res === 'object') {
			await upsertCourtInfoIntoCache(res as CourtInfoRow, { ttlMs: 60 * 1000, swrMs: 60 * 1000 })
		}
	} catch {}
	return res as CourtInfoRow
}

export async function upsertCourtInfoIntoCache(row: CourtInfoRow, opts?: { ttlMs?: number; swrMs?: number }) {
	if (!row || typeof row !== 'object') return
	const ttlMs = opts?.ttlMs ?? 60 * 1000
	const swrMs = opts?.swrMs
	try {
		const existing = await getCache<CourtInfoRow[]>('cache:courtinfo:v1')
		// Important: don't create a partial cache with only one row (can prevent Map from ever fetching full list).
		if (!Array.isArray(existing) || existing.length === 0) return
		const list: CourtInfoRow[] = existing.slice()
		const idx = list.findIndex(r => r?.courtid === row.courtid)
		if (idx >= 0) list[idx] = { ...list[idx], ...row }
		else list.push(row)
		await setCache('cache:courtinfo:v1', list, ttlMs, swrMs)
	} catch {}
	// Ensure react-query consumers re-read the (updated) AsyncStorage cache without forcing a network fetch.
	try {
		queryClient.invalidateQueries({
			predicate: q => Array.isArray(q.queryKey) && typeof q.queryKey[0] === 'string' && q.queryKey[0].toLowerCase().includes('courtinfo')
		})
	} catch {}
}
// Cached variant (short TTL; courts/verification status should feel near-realtime)
export async function listCourtInfoCached(): Promise<CourtInfoRow[]> {
	return fetchWithCache<CourtInfoRow[]>({
		key: 'cache:courtinfo:v1',
		ttlMs: 60 * 1000,
		swrMs: 60 * 1000,
		fetcher: () => listCourtInfo()
	})
}

// ---- Courts base table ----
// Schema: courts(courtid int PK, courtinfo text, ownerid int)
export type CourtRow = { courtid: number; courtinfo: string; ownerid: number }

export async function listCourts(): Promise<CourtRow[]> {
	const data = await request('/courts', { debugLabel: 'listCourts' })
	return Array.isArray(data) ? data as CourtRow[] : []
}

export async function getCourt(courtid: number): Promise<CourtRow | null> {
	if (courtid == null) throw new Error('courtid required')
	try {
		const row = await request(`/courts/${encodeURIComponent(courtid)}`, { debugLabel: 'getCourt' })
		return row || null
	} catch (e) {
		return null
	}
}

export async function updateCourt(courtid: number, patch: Partial<Pick<CourtRow, 'courtinfo'>>): Promise<CourtRow> {
	if (courtid == null) throw new Error('courtid required')
	return request(`/courts/${encodeURIComponent(courtid)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'updateCourt'
	}) as Promise<CourtRow>
}

// ---- Playing courts ----
export type PlayingCourtRow = {
	playingcourtid: number
	courtid: number
	base_name?: string | null
	name?: string | null
	part?: string | null
	price?: number | null
	allow_half_booking?: boolean | null
	surface?: string | null
	images?: string[]
}

export type PlayingCourtInfoRow = {
	playingcourtid: number
	images?: string[]
}

export async function listPlayingCourtsByCourtId(courtid: number): Promise<PlayingCourtRow[]> {
	if (courtid == null || !Number.isFinite(courtid)) throw new Error('courtid required')
	const data = await request(`/playingcourts?courtid=${encodeURIComponent(String(courtid))}`, {
		method: 'GET',
		debugLabel: 'listPlayingCourtsByCourtId',
	})
	return Array.isArray(data) ? (data as PlayingCourtRow[]) : []
}

export async function patchPlayingCourt(
	playingcourtid: number,
	patch: Partial<Pick<PlayingCourtRow, 'name' | 'base_name' | 'price'>>
): Promise<PlayingCourtRow> {
	if (playingcourtid == null || !Number.isFinite(playingcourtid)) throw new Error('playingcourtid required')
	return request(`/playingcourts/${encodeURIComponent(String(playingcourtid))}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'patchPlayingCourt',
	}) as Promise<PlayingCourtRow>
}

export async function getPlayingCourtInfo(playingcourtid: number): Promise<PlayingCourtInfoRow> {
	if (playingcourtid == null || !Number.isFinite(playingcourtid)) throw new Error('playingcourtid required')
	const row = await request(`/playingcourts/${encodeURIComponent(String(playingcourtid))}/info`, {
		method: 'GET',
		debugLabel: 'getPlayingCourtInfo',
	})
	return (row || { playingcourtid, images: [] }) as PlayingCourtInfoRow
}

// Bulk image fetch: one request returns images for ALL playing courts of a venue.
export async function listPlayingCourtInfoByCourt(
	courtid: number,
	signal?: AbortSignal
): Promise<Record<number, string[]>> {
	if (!Number.isFinite(courtid)) return {}
	const data = await request(`/playingcourts/info?courtid=${encodeURIComponent(String(courtid))}`, {
		debugLabel: 'listPlayingCourtInfoByCourt',
		signal,
	})
	const rows = Array.isArray(data) ? data : []
	const out: Record<number, string[]> = {}
	for (const row of rows) {
		const pid = Number(row?.playingcourtid)
		if (Number.isFinite(pid)) {
			out[pid] = Array.isArray(row?.images) ? (row.images as any[]).filter(Boolean).map(String) : []
		}
	}
	return out
}

export async function patchPlayingCourtInfo(
	playingcourtid: number,
	patch: Partial<Pick<PlayingCourtInfoRow, 'images'>>
): Promise<PlayingCourtInfoRow> {
	if (playingcourtid == null || !Number.isFinite(playingcourtid)) throw new Error('playingcourtid required')
	return request(`/playingcourts/${encodeURIComponent(String(playingcourtid))}/info`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'patchPlayingCourtInfo',
	}) as Promise<PlayingCourtInfoRow>
}

// ---- Venue Booking Bundle ----
export type VenueBookingBundle = {
	courtinfo: CourtInfoRow | null
	playing_courts: (PlayingCourtRow & { images: string[] })[]
	availability: CourtAvailabilityRow[]
	services: ServiceRow[]
}

export async function getVenueBookingData(courtid: number, signal?: AbortSignal): Promise<VenueBookingBundle> {
	if (!Number.isFinite(courtid)) throw new Error('courtid required')
	const data = await request(`/venues/${encodeURIComponent(String(courtid))}/booking-data`, {
		debugLabel: 'getVenueBookingData',
		signal,
	})
	return data as VenueBookingBundle
}


export type ServiceRow = {
	serviceid: number
	courtid: number
	name: string
	category: string
	price: number
	stock: number
	images?: any
	status?: string
}

export async function listServicesByCourtId(courtid: number): Promise<ServiceRow[]> {
	if (courtid == null || !Number.isFinite(courtid)) throw new Error('courtid required')
	const data = await request(`/services?courtid=${encodeURIComponent(String(courtid))}`, {
		method: 'GET',
		debugLabel: 'listServicesByCourtId',
	})
	return Array.isArray(data) ? (data as ServiceRow[]) : []
}

export async function createService(payload: Omit<Partial<ServiceRow>, 'serviceid'> & { courtid: number; name: string; category: string; price: number }): Promise<ServiceRow> {
	return request('/services', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'createService',
	}) as Promise<ServiceRow>
}

export async function patchService(serviceid: number, patch: Partial<Omit<ServiceRow, 'serviceid' | 'courtid'>>): Promise<ServiceRow> {
	if (serviceid == null || !Number.isFinite(serviceid)) throw new Error('serviceid required')
	return request(`/services/${encodeURIComponent(String(serviceid))}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'patchService',
	}) as Promise<ServiceRow>
}

export async function deleteService(serviceid: number): Promise<{ deleted: boolean; row?: ServiceRow }>{
	if (serviceid == null || !Number.isFinite(serviceid)) throw new Error('serviceid required')
	return request(`/services/${encodeURIComponent(String(serviceid))}`, {
		method: 'DELETE',
		debugLabel: 'deleteService',
	}) as Promise<{ deleted: boolean; row?: ServiceRow }>
}

// ---- Payments & Court Bookings (simplified create helpers) ----
export type PaymentRow = { paymentid: number; status: string; time: string; method: string; amount: number }
export async function createPayment(payload: { status: 'paid'|'pending'|'failed'; method: 'vnpay'|'cash'; amount: number }) {
	return request('/payments', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createPayment' }) as Promise<PaymentRow>
}

export async function getPayment(paymentid: number): Promise<PaymentRow | null> {
	if (paymentid == null) throw new Error('paymentid required')
	try {
		const row = await request(`/payments/${encodeURIComponent(paymentid)}`, { debugLabel: 'getPayment' })
		return (row as PaymentRow) || null
	} catch {
		return null
	}
}

export type CourtBookingRow = {
	courtbookingid: number
	availabilityid: number
	userid: number
	status: string
	paymentid?: number | null
	start_timestamp: string
	end_timestamp: string
	bookingdate: string
	note?: string | null
	bookingstatus?: string
	playingcourtid?: number | null
	selected_court_name?: string | null
	selected_base_name?: string | null
	selected_part?: 'full' | 'half_a' | 'half_b' | null
	selected_surface?: string | null
	court_price_at_booking?: number | null
	duration_minutes?: number | null
	total_amount?: number | null
	courtid?: number | null
	court_name?: string | null
	linked_events?: any[]
	linked_trainingsessions?: any[]
}
export async function createCourtBooking(payload: Omit<CourtBookingRow,'courtbookingid'>) {
	return request('/courtbookings', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createCourtBooking' }) as Promise<CourtBookingRow>
}

// ---- Service booking line items ----
export type ServiceBookingCreateRow = { courtbookingid: number; serviceid: number; quantity: number; unit_price: number; paymentid?: number | null }
export async function createServiceBookings(rows: ServiceBookingCreateRow[]): Promise<any[]> {
	if (!Array.isArray(rows) || rows.length === 0) return []
	const data = await request('/servicebookings', {
		method: 'POST',
		body: JSON.stringify(rows),
		debugLabel: 'createServiceBookings',
	})
	return Array.isArray(data) ? data : []
}

export async function getCourtBooking(courtbookingid: number): Promise<CourtBookingRow | null> {
	if (courtbookingid == null) throw new Error('courtbookingid required')
	try {
		const row = await request(`/courtbookings/${encodeURIComponent(courtbookingid)}`, { debugLabel: 'getCourtBooking' })
		return (row as CourtBookingRow) || null
	} catch {
		return null
	}
}

export async function updateCourtBooking(courtbookingid: number, data: Partial<CourtBookingRow>) {
	if (courtbookingid == null) throw new Error('courtbookingid required')
	return request(`/courtbookings/${encodeURIComponent(courtbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateCourtBooking'
	}) as Promise<CourtBookingRow>
}

// ---- Event & Training Session Bookings (mirror court booking create pattern) ----
export type EventBookingRow = { eventbookingid: number; eventid: number; userid: number; status: string; paymentid?: number | null; note?: string | null; bookingstatus?: string }
export async function createEventBooking(payload: Omit<EventBookingRow, 'eventbookingid'>) {
	return request('/eventbookings', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createEventBooking' }) as Promise<EventBookingRow>
}

export async function getEventBooking(eventbookingid: number): Promise<EventBookingRow | null> {
	if (eventbookingid == null) throw new Error('eventbookingid required')
	try {
		const row = await request(`/eventbookings/${encodeURIComponent(eventbookingid)}`, { debugLabel: 'getEventBooking' })
		return (row as EventBookingRow) || null
	} catch {
		return null
	}
}

export async function updateEventBooking(eventbookingid: number, data: Partial<EventBookingRow>) {
	if (eventbookingid == null) throw new Error('eventbookingid required')
	return request(`/eventbookings/${encodeURIComponent(eventbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateEventBooking'
	}) as Promise<EventBookingRow>
}

export type TrainingSessionBookingRow = { tsbookingid: number; sessionid: number; userid: number; status: string; paymentid?: number | null; note?: string | null; bookingstatus?: string }
export async function createTrainingSessionBooking(payload: Omit<TrainingSessionBookingRow, 'tsbookingid'>) {
	const res = await request('/tsbookings', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createTrainingSessionBooking' }) as Promise<TrainingSessionBookingRow>
	// Training session lists are rendered via listTrainingSessionsCombinedCached() (fetchWithCache),
	// so bust that cache whenever bookings change to avoid stale UI.
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
	return res
}

export async function getTrainingSessionBooking(tsbookingid: number): Promise<TrainingSessionBookingRow | null> {
	if (tsbookingid == null) throw new Error('tsbookingid required')
	try {
		const row = await request(`/tsbookings/${encodeURIComponent(tsbookingid)}`, { debugLabel: 'getTrainingSessionBooking' })
		return (row as TrainingSessionBookingRow) || null
	} catch {
		return null
	}
}

export async function updateTrainingSessionBooking(tsbookingid: number, data: Partial<TrainingSessionBookingRow>) {
	if (tsbookingid == null) throw new Error('tsbookingid required')
	const res = await request(`/tsbookings/${encodeURIComponent(tsbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateTrainingSessionBooking'
	}) as Promise<TrainingSessionBookingRow>
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
	return res
}

// Prepare delete endpoint for future UI integration (optimistic removal supported in hook)
export async function deleteCourtBooking(courtbookingid: number) {
	if (courtbookingid == null) throw new Error('courtbookingid required')
	return request(`/courtbookings/${courtbookingid}` , { method: 'DELETE', debugLabel: 'deleteCourtBooking' }) as Promise<{ deleted: boolean; count?: number }>
}

export async function listCourtBookings(params?: { userid?: number }) {
	const qs: string[] = []
	if (params?.userid !== undefined) qs.push(`userid=${encodeURIComponent(params.userid)}`)
	const path = `/courtbookings${qs.length ? '?' + qs.join('&') : ''}`
	const rows = (await request(path, { debugLabel: 'listCourtBookings' })) as CourtBookingRow[]
	void autoCompletePastStatusesInBackground({ bookings: Array.isArray(rows) ? rows : [] })
	return Array.isArray(rows) ? rows : []
}

// New functions to fetch bookings by user ID
export async function getCourtBookingsByUserId(userId: number) {
	return request(`/courtbookings?userid=${userId}`, { debugLabel: 'getCourtBookingsByUserId' })
}

export async function listCourtBookingsByCourtId(courtid: number): Promise<CourtBookingRow[]> {
	if (courtid == null || !Number.isFinite(courtid)) throw new Error('courtid required')
	const rows = await request(`/courtbookings?courtid=${encodeURIComponent(courtid)}`, { debugLabel: 'listCourtBookingsByCourtId' })
	return Array.isArray(rows) ? (rows as CourtBookingRow[]) : []
}

export async function getEventBookingsByUserId(userId: number) {
	return request(`/eventbookings?userid=${userId}`, { debugLabel: 'getEventBookingsByUserId' })
}

export async function getEventBookingsByEventId(eventid: number, params?: { status?: string }) {
	if (eventid == null) throw new Error('eventid required')
	const qs: string[] = [`eventid=${encodeURIComponent(eventid)}`]
	if (params?.status) qs.push(`status=${encodeURIComponent(params.status)}`)
	return request(`/eventbookings?${qs.join('&')}`, { debugLabel: 'getEventBookingsByEventId' }) as Promise<EventBookingRow[]>
}

export async function approveEventBooking(eventbookingid: number) {
	return updateEventBooking(eventbookingid, { status: 'joined' })
}

export async function rejectEventBooking(eventbookingid: number) {
	// Keep bookingstatus in sync so user UIs that read bookingstatus still behave.
	return updateEventBooking(eventbookingid, { status: 'rejected', bookingstatus: 'cancelled' })
}

export async function getTrainingSessionBookingsByUserId(userId: number) {
	return request(`/tsbookings?userid=${userId}`, { debugLabel: 'getTrainingSessionBookingsByUserId' })
}

export async function getTrainingSessionBookingsBySessionId(sessionid: number, params?: { status?: string }) {
	if (sessionid == null) throw new Error('sessionid required')
	const qs: string[] = [`sessionid=${encodeURIComponent(sessionid)}`]
	if (params?.status) qs.push(`status=${encodeURIComponent(params.status)}`)
	return request(`/tsbookings?${qs.join('&')}`, { debugLabel: 'getTrainingSessionBookingsBySessionId' }) as Promise<TrainingSessionBookingRow[]>
}

export async function approveTrainingSessionBooking(tsbookingid: number) {
	return updateTrainingSessionBooking(tsbookingid, { status: 'joined' })
}

export async function rejectTrainingSessionBooking(tsbookingid: number) {
	return updateTrainingSessionBooking(tsbookingid, { status: 'rejected', bookingstatus: 'cancelled' })
}

export type BlockTargetType = 'event' | 'trainingsession'

export type BlockListRow = {
	blockid: number
	targettype: BlockTargetType
	targetid: number
	blocked_userid: number
	blocked_by_userid: number
	blocked_at?: string | null
}

export async function listBlockList(params: { targettype: BlockTargetType; targetid: number }) {
	const qs = `targettype=${encodeURIComponent(params.targettype)}&targetid=${encodeURIComponent(params.targetid)}`
	return request(`/blocklist?${qs}`, { debugLabel: 'listBlockList' }) as Promise<BlockListRow[]>
}

export async function createBlock(params: { targettype: BlockTargetType; targetid: number; blocked_userid: number }) {
	return request('/blocklist', {
		method: 'POST',
		body: JSON.stringify(params),
		debugLabel: 'createBlock',
	}) as Promise<BlockListRow>
}

export async function removeBlock(params: { targettype: BlockTargetType; targetid: number; blocked_userid: number }) {
	const qs = `targettype=${encodeURIComponent(params.targettype)}&targetid=${encodeURIComponent(params.targetid)}&blocked_userid=${encodeURIComponent(params.blocked_userid)}`
	return request(`/blocklist?${qs}`, { method: 'DELETE', debugLabel: 'removeBlock' }) as Promise<{ deleted: boolean; rows?: any[] }>
}

// --- Debug identity (backend /api/debug/identity) ---
export async function debugIdentity(): Promise<{ token_subject: string; numeric_subject: number | null; userinfo: any } | null> {
	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 2500)
		const data = await request('/debug/identity', { debugLabel: 'debugIdentity', signal: controller.signal })
		clearTimeout(timeout)
		return data || null
	} catch (e) {
		console.warn('[debugIdentity] failed', (e as any)?.message)
		return null
	}
}

export async function listCourtAvailability(courtid: number) {
	const path = `/courtavailability?courtid=${encodeURIComponent(courtid)}`
	return request(path, { debugLabel: 'listCourtAvailability' }) as Promise<any[]>
}

export async function updateCourtAvailabilityByCourtId(
	courtid: number,
	patch: Partial<Pick<CourtAvailabilityRow, 'booking_date' | 'start_time' | 'end_time' | 'status'>>
): Promise<any> {
	if (courtid == null) throw new Error('courtid required')
	const res = await request(`/courtavailability/by-courtid/${encodeURIComponent(courtid)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'updateCourtAvailabilityByCourtId',
	})
	try { await invalidateCache(`@courtAvailability:${courtid}`) } catch {}
	return res
}

export async function updateCourtAvailabilityByPlayingCourtId(
	playingcourtid: number,
	patch: Partial<Pick<CourtAvailabilityRow, 'booking_date' | 'start_time' | 'end_time' | 'status'>>,
	opts?: { courtid?: number }
): Promise<any> {
	if (playingcourtid == null) throw new Error('playingcourtid required')
	const res = await request(`/courtavailability/by-playingcourtid/${encodeURIComponent(playingcourtid)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch),
		debugLabel: 'updateCourtAvailabilityByPlayingCourtId',
	})
	if (opts?.courtid != null) {
		try { await invalidateCache(`@courtAvailability:${opts.courtid}`) } catch {}
	}
	return res
}

export async function listCourtAvailabilityCached(courtid: number) {
	const key = `@courtAvailability:${courtid}`
	return fetchWithCache({
		key,
		ttlMs: 60_000,
		swrMs: 5 * 60_000,
		fetcher: () => listCourtAvailability(courtid),
		onBackgroundRefreshError: (err) => {
			console.warn('[listCourtAvailabilityCached] background refresh failed', (err as any)?.message)
		}
	})
}

export type CourtAvailabilityRow = {
	availabilityid: number
	courtid?: number
	playingcourtid?: number
	status?: string
	start_time?: string
	end_time?: string
	booking_date?: any
}

export async function listCourtAvailabilityAll(): Promise<CourtAvailabilityRow[]> {
	const data = await request('/courtavailability', { debugLabel: 'listCourtAvailabilityAll' })
	return Array.isArray(data) ? (data as CourtAvailabilityRow[]) : []
}

export async function getCourtAvailabilityById(availabilityid: number): Promise<CourtAvailabilityRow | null> {
	if (!Number.isFinite(availabilityid)) throw new Error('availabilityid required')
	try {
		const row = await request(`/courtavailability/${encodeURIComponent(String(availabilityid))}`, {
			debugLabel: 'getCourtAvailabilityById',
		})
		return (row as CourtAvailabilityRow) || null
	} catch {
		return null
	}
}

// ---- Event & Training Session Aggregation Helpers ----
// These compose multiple REST endpoints into richer objects for UI screens.

export type EventRow = { eventid: number; time: string; courtbookingid: number; status?: string; organizerid: number }
// Extend meta to include monetization fields present in schema (entry_fee, support_payment_method, participants_cap, join_status)
export type EventInfoMeta = {
	eventinfoid: number
	eventid: number
	numberofpeople?: number | null
	description?: string | null
	title: string
	// New schema field: images ARRAY
	images?: string[] | string | null
	entry_fee?: number | null
	support_payment_method?: string | null
	participants_cap?: number | null
	join_status?: boolean | null
}
export type CombinedEvent = {
	eventid: number
	time?: string
	status?: string
	courtbookingid: number
	organizerid: number
	organizerName?: string | null
	title?: string
	description?: string | null
	images?: string[]
	numberofpeople?: number | null
	start_timestamp?: string | null
	end_timestamp?: string | null
	entry_fee?: number | null
	support_payment_method?: string | null
	participants_cap?: number | null
	join_status?: boolean | null
	courtid?: number
	address?: string
	latitude?: number | null
	longitude?: number | null
	court_name?: string | null
	venue?: string[] | string | null
}

export type TrainingSessionRow = { sessionid: number; time: string; courtbookingid: number; status?: string; coachid: number }

export async function listEventsByCourtBookingId(courtbookingid: number): Promise<EventRow[]> {
	if (courtbookingid == null) throw new Error('courtbookingid required')
	const data = await request(`/events?courtbookingid=${encodeURIComponent(courtbookingid)}`, {
		debugLabel: 'listEventsByCourtBookingId',
	})
	return Array.isArray(data) ? (data as EventRow[]) : []
}

export async function listTrainingSessionsByCourtBookingId(courtbookingid: number): Promise<TrainingSessionRow[]> {
	if (courtbookingid == null) throw new Error('courtbookingid required')
	const data = await request(`/trainingsessions?courtbookingid=${encodeURIComponent(courtbookingid)}`, {
		debugLabel: 'listTrainingSessionsByCourtBookingId',
	})
	return Array.isArray(data) ? (data as TrainingSessionRow[]) : []
}

export async function getEvent(eventid: number): Promise<EventRow | null> {
	if (eventid == null) throw new Error('eventid required')
	try {
		const row = await request(`/events/${encodeURIComponent(eventid)}`, { debugLabel: 'getEvent' })
		return (row as EventRow) || null
	} catch {
		return null
	}
}

export async function updateEvent(eventid: number, data: Partial<EventRow>) {
	if (eventid == null) throw new Error('eventid required')
	const res = await request(`/events/${encodeURIComponent(eventid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateEvent'
	}) as Promise<EventRow>
	// Ensure combined list cache cannot stay stale after status changes
	try { await invalidateCache('cache:events:combined:v1') } catch {}
	return res
}

export async function getTrainingSession(sessionid: number): Promise<TrainingSessionRow | null> {
	if (sessionid == null) throw new Error('sessionid required')
	try {
		const row = await request(`/trainingsessions/${encodeURIComponent(sessionid)}`, { debugLabel: 'getTrainingSession' })
		return (row as TrainingSessionRow) || null
	} catch {
		return null
	}
}

export async function updateTrainingSession(sessionid: number, data: Partial<TrainingSessionRow>) {
	if (sessionid == null) throw new Error('sessionid required')
	const res = await request(`/trainingsessions/${encodeURIComponent(sessionid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateTrainingSession'
	}) as Promise<TrainingSessionRow>
	// Ensure combined list cache cannot stay stale after status changes
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
	return res
}

export async function getEventInfoByEventId(eventid: number): Promise<EventInfoMeta | null> {
	if (eventid == null) throw new Error('eventid required')
	const rows = await request(`/eventinfo?eventid=${encodeURIComponent(eventid)}`, { debugLabel: 'getEventInfoByEventId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as EventInfoMeta
	return null
}

export async function updateEventInfo(eventinfoid: number, data: Partial<EventInfoMeta>) {
	if (eventinfoid == null) throw new Error('eventinfoid required')
	return request(`/eventinfo/${encodeURIComponent(eventinfoid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateEventInfo'
	}) as Promise<EventInfoMeta>
}

export async function adjustEventParticipants(eventid: number, delta: number): Promise<EventInfoMeta> {
	if (eventid == null) throw new Error('eventid required')
	if (!Number.isFinite(delta)) throw new Error('delta must be a number')
	return request(`/eventinfo/adjust/${encodeURIComponent(eventid)}?delta=${encodeURIComponent(delta)}`, {
		method: 'POST',
		debugLabel: 'adjustEventParticipants'
	}) as Promise<EventInfoMeta>
}

export async function getTrainingSessionInfoBySessionId(sessionid: number): Promise<TrainingSessionInfoMeta | null> {
	if (sessionid == null) throw new Error('sessionid required')
	const rows = await request(`/trainingsessioninfo?sessionid=${encodeURIComponent(sessionid)}`, { debugLabel: 'getTrainingSessionInfoBySessionId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as TrainingSessionInfoMeta
	return null
}

export async function updateTrainingSessionInfo(sessioninfoid: number, data: Partial<TrainingSessionInfoMeta>) {
	if (sessioninfoid == null) throw new Error('sessioninfoid required')
	return request(`/trainingsessioninfo/${encodeURIComponent(sessioninfoid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateTrainingSessionInfo'
	}) as Promise<TrainingSessionInfoMeta>
}

export async function adjustTrainingSessionParticipants(sessionid: number, delta: number): Promise<TrainingSessionInfoMeta> {
	if (sessionid == null) throw new Error('sessionid required')
	if (!Number.isFinite(delta)) throw new Error('delta must be a number')
	return request(`/trainingsessioninfo/adjust/${encodeURIComponent(sessionid)}?delta=${encodeURIComponent(delta)}`, {
		method: 'POST',
		debugLabel: 'adjustTrainingSessionParticipants'
	}) as Promise<TrainingSessionInfoMeta>
}
export type TrainingSessionInfoMeta = {
	sessioninfoid: number
	sessionid: number
	numberofpeople: number
	description: string
	title: string
	// New schema field: images ARRAY
	images?: string[] | string | null
	entry_fee?: number | null
	support_payment_method?: string | null
	participants_cap?: number | null
	join_status?: boolean | null
}
export type CombinedTrainingSession = {
	sessionid: number
	time?: string
	status?: string
	courtbookingid: number
	coachid: number
	coachName?: string | null
	title?: string
	description?: string | null
	numberofpeople?: number | null
	start_timestamp?: string | null
	end_timestamp?: string | null
	courtid?: number
	address?: string
	latitude?: number | null
	longitude?: number | null
	court_name?: string | null
	venue?: string[] | string | null
	entry_fee?: number | null
	support_payment_method?: string | null
	participants_cap?: number | null
	join_status?: boolean | null
}

// Utility to safely fetch a single resource and swallow errors (returns null)
async function safeGet(path: string, label: string) {
	try { return await request(path, { debugLabel: label }) } catch { return null }
}

function normalizeStringArrayLoose(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
	if (typeof v !== 'string') return []
	const s = v.trim()
	if (!s) return []
	if (s.startsWith('[') && s.endsWith(']')) {
		try {
			const parsed = JSON.parse(s)
			if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean)
		} catch {
			// ignore
		}
	}
	if (s.startsWith('{') && s.endsWith('}')) {
		return s
			.slice(1, -1)
			.split(',')
			.map((x) => x.replace(/^"|"$/g, '').trim())
			.filter(Boolean)
	}
	if (s.includes(',')) return s.split(',').map((x) => x.trim()).filter(Boolean)
	return [s]
}

// Aggregate events with related meta, court info and organizer name.
export async function listEventsCombined(): Promise<CombinedEvent[]> {
	// All five sources are independent — fetch in parallel to eliminate the sequential waterfall.
	const [eventsData, infoRowsRaw, allCourtBookings, allAvailability, allUserInfo] = await Promise.all([
		request('/events', { debugLabel: 'listEvents' }),
		request('/eventinfo', { debugLabel: 'listEventInfoAll' }),
		safeGet('/courtbookings', 'listCourtBookingsAll'),
		safeGet('/courtavailability', 'listCourtAvailabilityAll'),
		safeGet('/userinfo', 'listUserInfoAll'),
	])

	if (!Array.isArray(eventsData)) return []
	const events: EventRow[] = eventsData as EventRow[]

	// Map event info by event id
	const infoByEventId = new Map<number, EventInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as EventInfoMeta[]) infoByEventId.set(r.eventid, r)

	// Map court bookings by id
	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings))
		for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	// Map availability slots by id
	const availabilityById = new Map<number, any>()
	if (Array.isArray(allAvailability)) for (const av of allAvailability) if (typeof av.availabilityid === 'number') availabilityById.set(av.availabilityid, av)

	// Derive courtids from the already-resolved maps
	const neededAvailabilityIds = [...new Set(events.map(e => bookingById.get(e.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
	const courtIds = [...new Set(neededAvailabilityIds.map(id => availabilityById.get(id)?.courtid).filter(Boolean))] as number[]
	let courtInfoRows: CourtInfoRow[] = []
	if (courtIds.length) {
		const ci = await safeGet(`/courtinfo?courtids=${courtIds.join(',')}`, 'listCourtInfoSubset')
		if (Array.isArray(ci)) courtInfoRows = ci as CourtInfoRow[]
	}
	const courtInfoByCourtId = new Map<number, CourtInfoRow>()
	courtInfoRows.forEach(r => courtInfoByCourtId.set(r.courtid, r))

	// Map userinfo by userid
	const nameByUserId = new Map<number, string | null>()
	if (Array.isArray(allUserInfo)) for (const row of allUserInfo) if (typeof row.userid === 'number') nameByUserId.set(row.userid, (row.name as string) || null)

	const combined = events.map(e => {
		const booking = bookingById.get(e.courtbookingid)
		const availability = booking ? availabilityById.get(booking.availabilityid) : null
		const courtid = availability?.courtid
		const ci = courtid != null ? courtInfoByCourtId.get(courtid) : undefined
		const meta = infoByEventId.get(e.eventid)
		return {
			eventid: e.eventid,
			time: e.time,
			status: e.status,
			courtbookingid: e.courtbookingid,
			organizerid: e.organizerid,
			organizerName: nameByUserId.get(e.organizerid) || null,
			title: meta?.title,
			description: meta?.description,
			images: normalizeStringArrayLoose(meta?.images),
			numberofpeople: meta?.numberofpeople ?? null,
			start_timestamp: booking?.start_timestamp ?? null,
			end_timestamp: booking?.end_timestamp ?? null,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: meta?.participants_cap ?? null,
			join_status: meta?.join_status ?? null,
			courtid,
			address: ci?.address,
			latitude: (ci as any)?.latitude ?? null,
			longitude: (ci as any)?.longitude ?? null,
			court_name: (ci as any)?.name ?? null,
			venue: ci?.venue,
		}
	})
	void autoCompletePastStatusesInBackground({ events: combined })
	return combined
}

// Aggregate events created by a specific organizer.
export async function listEventsCombinedByOrganizerId(organizerid: number): Promise<CombinedEvent[]> {
	const eventsData = await request(`/events?organizerid=${encodeURIComponent(organizerid)}`, { debugLabel: 'listEventsByOrganizerId' })
	if (!Array.isArray(eventsData)) return []
	const events: EventRow[] = eventsData as EventRow[]

	// Fetch event info in one call & map
	const infoRowsRaw = await request('/eventinfo', { debugLabel: 'listEventInfoAll' })
	const infoByEventId = new Map<number, EventInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as EventInfoMeta[]) infoByEventId.set(r.eventid, r)

	const allCourtBookings = await safeGet('/courtbookings', 'listCourtBookingsAll')
	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings))
		for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	const neededAvailabilityIds = [...new Set(events.map(e => bookingById.get(e.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
	const allAvailability = await safeGet('/courtavailability', 'listCourtAvailabilityAll')
	const availabilityById = new Map<number, any>()
	if (Array.isArray(allAvailability)) for (const av of allAvailability) if (typeof av.availabilityid === 'number') availabilityById.set(av.availabilityid, av)

	const courtIds = [...new Set(neededAvailabilityIds.map(id => availabilityById.get(id)?.courtid).filter(Boolean))] as number[]
	let courtInfoRows: CourtInfoRow[] = []
	if (courtIds.length) {
		const ci = await safeGet(`/courtinfo?courtids=${courtIds.join(',')}`, 'listCourtInfoSubset')
		if (Array.isArray(ci)) courtInfoRows = ci as CourtInfoRow[]
	}
	const courtInfoByCourtId = new Map<number, CourtInfoRow>()
	courtInfoRows.forEach(r => courtInfoByCourtId.set(r.courtid, r))

	const allUserInfo = await safeGet('/userinfo', 'listUserInfoAll')
	const nameByUserId = new Map<number, string | null>()
	if (Array.isArray(allUserInfo)) for (const row of allUserInfo) if (typeof row.userid === 'number') nameByUserId.set(row.userid, (row.name as string) || null)

	return events.map(e => {
		const booking = bookingById.get(e.courtbookingid)
		const availability = booking ? availabilityById.get(booking.availabilityid) : null
		const courtid = availability?.courtid
		const ci = courtid != null ? courtInfoByCourtId.get(courtid) : undefined
		const meta = infoByEventId.get(e.eventid)
		return {
			eventid: e.eventid,
			time: e.time,
			status: e.status,
			courtbookingid: e.courtbookingid,
			organizerid: e.organizerid,
			organizerName: nameByUserId.get(e.organizerid) || null,
			title: meta?.title,
			description: meta?.description,
			numberofpeople: meta?.numberofpeople ?? null,
			start_timestamp: booking?.start_timestamp ?? null,
			end_timestamp: booking?.end_timestamp ?? null,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: meta?.participants_cap ?? null,
			join_status: meta?.join_status ?? null,
			courtid,
			address: ci?.address,
			court_name: (ci as any)?.name ?? null,
			venue: ci?.venue,
		}
	})
}
// Cached variant (events volatile): TTL-only so React Query refetches can break through.
export async function listEventsCombinedCached(): Promise<CombinedEvent[]> {
	const list = await fetchWithCache<CombinedEvent[]>({
		key: 'cache:events:combined:v1',
		ttlMs: 60 * 1000,
		fetcher: () => listEventsCombined()
	})
	// Best-effort background completion.
	void autoCompletePastStatusesInBackground({ events: list })
	return list
}

// Force refresh of the cached combined events list.
// Useful after mutations (create/cancel) so the app doesn't wait for TTL.
export async function invalidateEventsCombinedCache(): Promise<void> {
	try { await invalidateCache('cache:events:combined:v1') } catch {}
}

// ---- Event Creation Helpers ----
export type CreateEventWithInfoPayload = {
	courtbookingid: number
	time?: string
	title: string
	description?: string
	images?: string[]
	participants_cap: number
	auto_approve?: boolean
	monetize: boolean
	entry_fee?: number
	payment_methods?: ("cash" | "vnpay" | "both")[] | string
	organizerid?: number
}

export async function createEventWithInfo(payload: CreateEventWithInfoPayload) {
	// Backend expects: courtbookingid,time?,title,description?,participants_cap,monetize,entry_fee?,payment_methods?
	const res = await request('/events/create_with_info', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'createEventWithInfo'
	}) as Promise<{ event: EventRow; eventinfo: EventInfoMeta & { entry_fee?: number | null; support_payment_method?: string | null; participants_cap: number; join_status: boolean } }>
	try { await invalidateCache('cache:events:combined:v1') } catch {}
	return res
}

export type CreateTrainingSessionWithInfoPayload = {
	courtbookingid: number
	time?: string
	title: string
	description?: string
	images?: string[]
	participants_cap: number
	auto_approve?: boolean
	monetize: boolean
	entry_fee?: number
	payment_methods?: ("cash"|"vnpay"|"both")[] | string
	coachid?: number
}

export async function createTrainingSessionWithInfo(payload: CreateTrainingSessionWithInfoPayload) {
	const res = await request('/trainingsessions/create_with_info', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'createTrainingSessionWithInfo'
	}) as Promise<{ session: any; sessioninfo: any }>
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
	return res
}

// Aggregate training sessions similarly.
export async function listTrainingSessionsCombined(): Promise<CombinedTrainingSession[]> {
	// All five sources are independent — fetch in parallel to eliminate the sequential waterfall.
	const [tsData, infoRowsRaw, allCourtBookings, allAvailability, allUserInfo] = await Promise.all([
		request('/trainingsessions', { debugLabel: 'listTrainingSessions' }),
		request('/trainingsessioninfo', { debugLabel: 'listTrainingSessionInfoAll' }),
		safeGet('/courtbookings', 'listCourtBookingsAll'),
		safeGet('/courtavailability', 'listCourtAvailabilityAll'),
		safeGet('/userinfo', 'listUserInfoAll'),
	])

	if (!Array.isArray(tsData)) return []
	const sessions: TrainingSessionRow[] = tsData as TrainingSessionRow[]

	const infoBySessionId = new Map<number, TrainingSessionInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as TrainingSessionInfoMeta[]) infoBySessionId.set(r.sessionid, r)

	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings)) for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	const availabilityById = new Map<number, any>()
	if (Array.isArray(allAvailability)) for (const av of allAvailability) if (typeof av.availabilityid === 'number') availabilityById.set(av.availabilityid, av)

	// Derive court IDs from the already-resolved maps
	const neededAvailabilityIds = [...new Set(sessions.map(s => bookingById.get(s.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
	const courtIds = [...new Set(neededAvailabilityIds.map(id => availabilityById.get(id)?.courtid).filter(Boolean))] as number[]
	let courtInfoRows: CourtInfoRow[] = []
	if (courtIds.length) {
		const ci = await safeGet(`/courtinfo?courtids=${courtIds.join(',')}`, 'listCourtInfoSubset')
		if (Array.isArray(ci)) courtInfoRows = ci as CourtInfoRow[]
	}
	const courtInfoByCourtId = new Map<number, CourtInfoRow>()
	courtInfoRows.forEach(r => courtInfoByCourtId.set(r.courtid, r))

	const nameByUserId = new Map<number, string | null>()
	if (Array.isArray(allUserInfo)) for (const row of allUserInfo) if (typeof row.userid === 'number') nameByUserId.set(row.userid, (row.name as string) || null)

	const combined = sessions.map(s => {
		const booking = bookingById.get(s.courtbookingid)
		const availability = booking ? availabilityById.get(booking.availabilityid) : null
		const courtid = availability?.courtid
		const ci = courtid != null ? courtInfoByCourtId.get(courtid) : undefined
		const meta = infoBySessionId.get(s.sessionid)
		return {
			sessionid: s.sessionid,
			time: s.time,
			status: s.status,
			courtbookingid: s.courtbookingid,
			coachid: s.coachid,
			coachName: nameByUserId.get(s.coachid) || null,
			title: meta?.title,
			description: meta?.description,
			numberofpeople: meta?.numberofpeople ?? null,
			start_timestamp: booking?.start_timestamp ?? null,
			end_timestamp: booking?.end_timestamp ?? null,
			courtid,
			address: ci?.address,
			latitude: (ci as any)?.latitude ?? null,
			longitude: (ci as any)?.longitude ?? null,
			court_name: (ci as any)?.name ?? null,
			venue: ci?.venue,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: (meta as any)?.participants_cap ?? null,
			join_status: (meta as any)?.join_status ?? null,
		}
	})
	void autoCompletePastStatusesInBackground({ sessions: combined })
	return combined
}

// Aggregate training sessions created by a specific coach.
export async function listTrainingSessionsCombinedByCoachId(coachid: number): Promise<CombinedTrainingSession[]> {
	// Fetch coach's sessions and all independent lookup tables in parallel.
	const [tsData, infoRowsRaw, allCourtBookings, allAvailability, allUserInfo] = await Promise.all([
		request(`/trainingsessions?coachid=${encodeURIComponent(coachid)}`, { debugLabel: 'listTrainingSessionsByCoachId' }),
		request('/trainingsessioninfo', { debugLabel: 'listTrainingSessionInfoAll' }),
		safeGet('/courtbookings', 'listCourtBookingsAll'),
		safeGet('/courtavailability', 'listCourtAvailabilityAll'),
		safeGet('/userinfo', 'listUserInfoAll'),
	])

	if (!Array.isArray(tsData)) return []
	const sessions: TrainingSessionRow[] = tsData as TrainingSessionRow[]

	const infoBySessionId = new Map<number, TrainingSessionInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as TrainingSessionInfoMeta[]) infoBySessionId.set(r.sessionid, r)

	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings)) for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	const availabilityById = new Map<number, any>()
	if (Array.isArray(allAvailability)) for (const av of allAvailability) if (typeof av.availabilityid === 'number') availabilityById.set(av.availabilityid, av)

	// Derive court IDs from the already-resolved maps
	const neededAvailabilityIds = [...new Set(sessions.map(s => bookingById.get(s.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
	const courtIds = [...new Set(neededAvailabilityIds.map(id => availabilityById.get(id)?.courtid).filter(Boolean))] as number[]
	let courtInfoRows: CourtInfoRow[] = []
	if (courtIds.length) {
		const ci = await safeGet(`/courtinfo?courtids=${courtIds.join(',')}`, 'listCourtInfoSubset')
		if (Array.isArray(ci)) courtInfoRows = ci as CourtInfoRow[]
	}
	const courtInfoByCourtId = new Map<number, CourtInfoRow>()
	courtInfoRows.forEach(r => courtInfoByCourtId.set(r.courtid, r))

	const nameByUserId = new Map<number, string | null>()
	if (Array.isArray(allUserInfo)) for (const row of allUserInfo) if (typeof row.userid === 'number') nameByUserId.set(row.userid, (row.name as string) || null)

	return sessions.map(s => {
		const booking = bookingById.get(s.courtbookingid)
		const availability = booking ? availabilityById.get(booking.availabilityid) : null
		const courtid = availability?.courtid
		const ci = courtid != null ? courtInfoByCourtId.get(courtid) : undefined
		const meta = infoBySessionId.get(s.sessionid)
		return {
			sessionid: s.sessionid,
			time: s.time,
			status: s.status,
			courtbookingid: s.courtbookingid,
			coachid: s.coachid,
			coachName: nameByUserId.get(s.coachid) || null,
			title: meta?.title,
			description: meta?.description,
			numberofpeople: meta?.numberofpeople ?? null,
			start_timestamp: booking?.start_timestamp ?? null,
			end_timestamp: booking?.end_timestamp ?? null,
			courtid,
			address: ci?.address,
			latitude: (ci as any)?.latitude ?? null,
			longitude: (ci as any)?.longitude ?? null,
			court_name: (ci as any)?.name ?? null,
			venue: ci?.venue,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: (meta as any)?.participants_cap ?? null,
			join_status: (meta as any)?.join_status ?? null,
		}
	})
}
// Cached variant (sessions volatile): TTL-only so React Query refetches can break through.
export async function listTrainingSessionsCombinedCached(): Promise<CombinedTrainingSession[]> {
	const list = await fetchWithCache<CombinedTrainingSession[]>({
		key: 'cache:trainingsessions:combined:v1',
		ttlMs: 60 * 1000,
		fetcher: () => listTrainingSessionsCombined()
	})
	void autoCompletePastStatusesInBackground({ sessions: list })
	return list
}

// Force refresh of the cached combined training sessions list.
export async function invalidateTrainingSessionsCombinedCache(): Promise<void> {
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
}

// ---- Dashboard ----
// GET /api/me/dashboard — single bootstrap call that returns userinfo + bookings + favourites.
export type DashboardResponse = {
	userinfo: UserInfoRow | null
	favourite_courts: FavouriteCourt[]
	court_bookings: CourtBookingRow[]
	event_bookings: EventBookingRow[]
	training_bookings: TrainingSessionBookingRow[]
	notifications?: NotificationRow[]
	events_combined?: CombinedEvent[]
	training_sessions_combined?: CombinedTrainingSession[]
}

export async function getDashboard(): Promise<DashboardResponse> {
	const data = await request('/me/dashboard', { debugLabel: 'getDashboard' })
	return data as DashboardResponse
}

// ---- Cancel Bookings ----

export async function cancelCourtBooking(courtbookingid: number): Promise<any> {
	if (!courtbookingid) throw new Error('courtbookingid required')
	return request(`/courtbookings/${encodeURIComponent(courtbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify({ bookingstatus: 'cancelled', status: 'cancelled' }),
		debugLabel: 'cancelCourtBooking',
	})
}

export async function cancelEventBooking(eventbookingid: number): Promise<any> {
	if (!eventbookingid) throw new Error('eventbookingid required')
	return request(`/eventbookings/${encodeURIComponent(eventbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify({ bookingstatus: 'cancelled', status: 'cancelled' }),
		debugLabel: 'cancelEventBooking',
	})
}

export async function cancelTsBooking(tsbookingid: number): Promise<any> {
	if (!tsbookingid) throw new Error('tsbookingid required')
	return request(`/tsbookings/${encodeURIComponent(tsbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify({ bookingstatus: 'cancelled', status: 'cancelled' }),
		debugLabel: 'cancelTsBooking',
	})
}

// ---- Reviews ----

export type ReviewIn = {
	targettype: string   // 'court' | 'event' | 'trainingsession'
	targetid: number
	rating: number       // 1-5
	comment: string
}

export async function postReview(payload: ReviewIn): Promise<{ reviewid: number }> {
	return request('/reviews', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'postReview',
	}) as Promise<{ reviewid: number }>
}

// ---- Session / Cache Purge ----
// Clears all app-level cached data that could contain user-linked information.
// Invoked after sign-out to prevent data leakage between accounts.
export async function purgeSessionCaches(): Promise<void> {
	// Invalidate custom fetchWithCache entries (all keys prefixed with 'cache:')
	try { await invalidateByPrefix('cache:') } catch (e) { console.warn('[purgeSessionCaches] invalidateByPrefix failed', (e as any)?.message) }
	// Clear React Query in-memory cache
	try { queryClient.clear() } catch (e) { console.warn('[purgeSessionCaches] queryClient.clear failed', (e as any)?.message) }
	// Remove persisted React Query storage
	try { await AsyncStorage.removeItem('tanstack-cache-v1') } catch (e) { console.warn('[purgeSessionCaches] removeItem tanstack-cache-v1 failed', (e as any)?.message) }
	// Remove any pending profile artifacts
	try { await AsyncStorage.removeItem('@backendProfilePending') } catch {}
}

