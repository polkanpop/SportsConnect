import { API_BASE_URL } from '@/env'
import { fetchWithCache, invalidateByPrefix, invalidateCache } from '@/lib/cache'
import { queryClient } from '@/providers/query-provider'
import { supabase } from './supabase'
import AsyncStorage from '@react-native-async-storage/async-storage'

type Json = Record<string, any>

async function refreshAccessToken(): Promise<boolean> {
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

async function request(path: string, options: RequestInit & { debugLabel?: string } = {}, attempt: number = 0) {
	const url = `${API_BASE_URL.replace(/\/$/, '')}${path}`
	const t0 = Date.now()
	const debugLabel = options.debugLabel || path
	// Attach Authorization Bearer token when Supabase session present
	let authHeader: Record<string,string> = {}
	// Prefer backend access token if present & not expired (allows Supabase session token to exist without overriding backend auth)
	const backendTok = await getLocalBackendToken()
	const now = Date.now()
	if (backendTok?.token && backendTok.exp && backendTok.exp > now + 5_000) { // 5s skew buffer
		authHeader = { Authorization: `Bearer ${backendTok.token}` }
	} else {
		// Attempt Supabase session token, else legacy local token fallback
		try {
			const { data } = await supabase.auth.getSession()
			const token = data?.session?.access_token
			if (token) {
				authHeader = { Authorization: `Bearer ${token}` }
			} else {
				const localToken = await AsyncStorage.getItem('@localAuthToken')
				if (localToken) authHeader = { Authorization: `Bearer ${localToken}` }
			}
		} catch {
			try {
				const localToken = await AsyncStorage.getItem('@localAuthToken')
				if (localToken) authHeader = { Authorization: `Bearer ${localToken}` }
			} catch {}
		}
	}
	// Preflight: if this endpoint is protected (heuristic) ensure access token fresh
	const isProtectedEndpoint = /^(?:\/courtbookings|\/events|\/trainingsessions|\/favouritecourts|\/courtavailability|\/courtinfo)/.test(path)
	if (isProtectedEndpoint) {
		const bt = await getLocalBackendToken()
		const nowMs = Date.now()
		if (bt?.token && bt.exp && bt.exp <= nowMs + 30_000) { // expires within 30s or already
			await refreshAccessToken()
		}
	}
	const res = await fetch(url, {
		method: options.method || 'GET',
		headers: {
			'Content-Type': 'application/json',
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
		const detail = (data && (data.detail || data.error)) || `HTTP ${res.status}`
		// Broaden automatic refresh: any 401 Invalid token (expired or signature) triggers one retry
		if (res.status === 401 && attempt === 0 && /Invalid token:/i.test(detail)) {
			const refreshed = await refreshAccessToken()
			if (refreshed) {
				return request(path, options, 1)
			}
		}
		throw new Error(detail)
	}
	return data
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
	return data as FavouriteCourt
}

export async function removeFavouriteCourt(favouriteid: number) {
	const data = await request(`/favouritecourts/${favouriteid}`, {
		method: 'DELETE',
		debugLabel: 'removeFavouriteCourt'
	})
	return data as { deleted: boolean; count: number }
}

// ---- User Info API ----
// GET /userinfo?userid=123 returns list[ { infoid, userid, name, email, ... } ]
// Helper to fetch first row by userid.
export type UserInfoRow = { infoid: number; userid: number; name?: string | null; email?: string | null; contactnumber?: string | null; time?: string | null; sport?: string | string[] | null; biography?: string | null }

export async function getUserInfoByUserId(userid: number) {
	if (userid == null) throw new Error('userid required')
	const path = `/userinfo?userid=${encodeURIComponent(userid)}`
	const rows = await request(path, { debugLabel: 'getUserInfoByUserId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as UserInfoRow
	return null
}

export async function updateUserInfo(userid: number, data: Partial<UserInfoRow>) {
	const path = `/userinfo/${encodeURIComponent(userid)}`
	const res = await request(path, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateUserInfo'
	})
	return res
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

// ---- Court Info API ----
// Existing backend endpoint: GET /courtinfo returns list of courtinfo rows.
// Shape needed by Map: courtinfoid,courtid,name,address,latitude,longitude,latitudedelta,longitudedelta,sport,venue,images,availability
export type CourtInfoRow = {
	courtinfoid: number
	courtid: number
	name?: string | null
	address: string
	latitude?: number | null
	longitude?: number | null
	latitudedelta?: number | null
	longitudedelta?: number | null
	sport?: string[] | string | null
	venue?: string[] | string | null
	images?: string[] | null
	availability?: string | null
}

export async function listCourtInfo(): Promise<CourtInfoRow[]> {
	const data = await request('/courtinfo', { debugLabel: 'listCourtInfo' })
	return Array.isArray(data) ? data as CourtInfoRow[] : []
}
// Cached variant (5 min TTL, additional 5 min stale window)
export async function listCourtInfoCached(): Promise<CourtInfoRow[]> {
	return fetchWithCache<CourtInfoRow[]>({
		key: 'cache:courtinfo:v1',
		ttlMs: 5 * 60 * 1000,
		swrMs: 5 * 60 * 1000,
		fetcher: () => listCourtInfo()
	})
}

// ---- Courts base table (includes pricing) ----
// Schema: courts(courtid int PK, courtinfo text, ownerid int, price numeric)
export type CourtRow = { courtid: number; courtinfo: string; ownerid: number; price: number }

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

// ---- Payments & Court Bookings (simplified create helpers) ----
export type PaymentRow = { paymentid: number; status: string; time: string; method: string; amount: number }
export async function createPayment(payload: { status: 'paid'|'pending'|'failed'; method: 'vnpay'|'cash'; amount: number }) {
	return request('/payments', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createPayment' }) as Promise<PaymentRow>
}

export type CourtBookingRow = { courtbookingid: number; availabilityid: number; userid: number; status: string; paymentid?: number|null; start_timestamp: string; end_timestamp: string; bookingdate: string; note?: string | null; bookingstatus?: string }
export async function createCourtBooking(payload: Omit<CourtBookingRow,'courtbookingid'>) {
	return request('/courtbookings', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createCourtBooking' }) as Promise<CourtBookingRow>
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
	return request('/tsbookings', { method: 'POST', body: JSON.stringify(payload), debugLabel: 'createTrainingSessionBooking' }) as Promise<TrainingSessionBookingRow>
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
	return request(`/tsbookings/${encodeURIComponent(tsbookingid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateTrainingSessionBooking'
	}) as Promise<TrainingSessionBookingRow>
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
	return request(path, { debugLabel: 'listCourtBookings' }) as Promise<CourtBookingRow[]>
}

// New functions to fetch bookings by user ID
export async function getCourtBookingsByUserId(userId: number) {
	return request(`/courtbookings?userid=${userId}`, { debugLabel: 'getCourtBookingsByUserId' })
}

export async function getEventBookingsByUserId(userId: number) {
	return request(`/eventbookings?userid=${userId}`, { debugLabel: 'getEventBookingsByUserId' })
}

export async function getTrainingSessionBookingsByUserId(userId: number) {
	return request(`/tsbookings?userid=${userId}`, { debugLabel: 'getTrainingSessionBookingsByUserId' })
}

// --- Debug identity (backend /api/debug/identity) ---
export async function debugIdentity(): Promise<{ token_subject: string; numeric_subject: number | null; userinfo: any } | null> {
	try {
		const data = await request('/debug/identity', { debugLabel: 'debugIdentity' })
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

export type CourtAvailabilityRow = {
	availabilityid: number
	courtid: number
	status: string
	start_time: string
	end_time: string
	booking_date: any
}

export async function listCourtAvailabilityAll(): Promise<CourtAvailabilityRow[]> {
	const data = await request('/courtavailability', { debugLabel: 'listCourtAvailabilityAll' })
	return Array.isArray(data) ? (data as CourtAvailabilityRow[]) : []
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
	numberofpeople?: number | null
	start_timestamp?: string | null
	end_timestamp?: string | null
	entry_fee?: number | null
	support_payment_method?: string | null
	participants_cap?: number | null
	join_status?: boolean | null
	courtid?: number
	address?: string
	court_name?: string | null
	sport?: string[] | string | null
	venue?: string[] | string | null
}

export type TrainingSessionRow = { sessionid: number; time: string; courtbookingid: number; status?: string; coachid: number }

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
	return request(`/events/${encodeURIComponent(eventid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateEvent'
	}) as Promise<EventRow>
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
	return request(`/trainingsessions/${encodeURIComponent(sessionid)}`, {
		method: 'PATCH',
		body: JSON.stringify(data),
		debugLabel: 'updateTrainingSession'
	}) as Promise<TrainingSessionRow>
}

export async function getEventInfoByEventId(eventid: number): Promise<EventInfoMeta | null> {
	if (eventid == null) throw new Error('eventid required')
	const rows = await request(`/eventinfo?eventid=${encodeURIComponent(eventid)}`, { debugLabel: 'getEventInfoByEventId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as EventInfoMeta
	return null
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
	court_name?: string | null
	sport?: string[] | string | null
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

// Aggregate events with related meta, court info and organizer name.
export async function listEventsCombined(): Promise<CombinedEvent[]> {
	const eventsData = await request('/events', { debugLabel: 'listEvents' })
	if (!Array.isArray(eventsData)) return []
	const events: EventRow[] = eventsData as EventRow[]

	// Fetch event info in one call & map
	const infoRowsRaw = await request('/eventinfo', { debugLabel: 'listEventInfoAll' })
	const infoByEventId = new Map<number, EventInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as EventInfoMeta[]) infoByEventId.set(r.eventid, r)

	// Batch fetch courtbookings (single call) then filter needed ids
	const allCourtBookings = await safeGet('/courtbookings', 'listCourtBookingsAll')
	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings))
		for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	// Get availability ids from bookings then batch fetch all availability slots once
	const neededAvailabilityIds = [...new Set(events.map(e => bookingById.get(e.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
	const allAvailability = await safeGet('/courtavailability', 'listCourtAvailabilityAll')
	const availabilityById = new Map<number, any>()
	if (Array.isArray(allAvailability)) for (const av of allAvailability) if (typeof av.availabilityid === 'number') availabilityById.set(av.availabilityid, av)

	// Derive courtids
	const courtIds = [...new Set(neededAvailabilityIds.map(id => availabilityById.get(id)?.courtid).filter(Boolean))] as number[]
	let courtInfoRows: CourtInfoRow[] = []
	if (courtIds.length) {
		const ci = await safeGet(`/courtinfo?courtids=${courtIds.join(',')}`, 'listCourtInfoSubset')
		if (Array.isArray(ci)) courtInfoRows = ci as CourtInfoRow[]
	}
	const courtInfoByCourtId = new Map<number, CourtInfoRow>()
	courtInfoRows.forEach(r => courtInfoByCourtId.set(r.courtid, r))

	// Batch userinfo single call then map by userid
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
			sport: ci?.sport,
			venue: ci?.venue,
		}
	})
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
			sport: ci?.sport,
			venue: ci?.venue,
		}
	})
}
// Cached variant (events moderately volatile: 60s TTL, 2m stale window)
export async function listEventsCombinedCached(): Promise<CombinedEvent[]> {
	return fetchWithCache<CombinedEvent[]>({
		key: 'cache:events:combined:v1',
		ttlMs: 60 * 1000,
		swrMs: 120 * 1000,
		fetcher: () => listEventsCombined()
	})
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
	participants_cap: number
	monetize: boolean
	entry_fee?: number
	payment_methods?: ("cash" | "vnpay" | "both")[] | string
	organizerid?: number
}

export async function createEventWithInfo(payload: CreateEventWithInfoPayload) {
	// Backend expects: courtbookingid,time?,title,description?,participants_cap,monetize,entry_fee?,payment_methods?
	return request('/events/create_with_info', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'createEventWithInfo'
	}) as Promise<{ event: EventRow; eventinfo: EventInfoMeta & { entry_fee?: number | null; support_payment_method?: string | null; participants_cap: number; join_status: boolean } }>
}

export type CreateTrainingSessionWithInfoPayload = {
	courtbookingid: number
	time?: string
	title: string
	description?: string
	participants_cap: number
	monetize: boolean
	entry_fee?: number
	payment_methods?: ("cash"|"vnpay"|"both")[] | string
	coachid?: number
}

export async function createTrainingSessionWithInfo(payload: CreateTrainingSessionWithInfoPayload) {
	return request('/trainingsessions/create_with_info', {
		method: 'POST',
		body: JSON.stringify(payload),
		debugLabel: 'createTrainingSessionWithInfo'
	}) as Promise<{ session: any; sessioninfo: any }>
}

// Aggregate training sessions similarly.
export async function listTrainingSessionsCombined(): Promise<CombinedTrainingSession[]> {
	const tsData = await request('/trainingsessions', { debugLabel: 'listTrainingSessions' })
	if (!Array.isArray(tsData)) return []
	const sessions: TrainingSessionRow[] = tsData as TrainingSessionRow[]

	const infoRowsRaw = await request('/trainingsessioninfo', { debugLabel: 'listTrainingSessionInfoAll' })
	const infoBySessionId = new Map<number, TrainingSessionInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as TrainingSessionInfoMeta[]) infoBySessionId.set(r.sessionid, r)

	const allCourtBookings = await safeGet('/courtbookings', 'listCourtBookingsAll')
	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings)) for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	const neededAvailabilityIds = [...new Set(sessions.map(s => bookingById.get(s.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
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
			court_name: (ci as any)?.name ?? null,
			sport: ci?.sport,
			venue: ci?.venue,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: (meta as any)?.participants_cap ?? null,
			join_status: (meta as any)?.join_status ?? null,
		}
	})
}

// Aggregate training sessions created by a specific coach.
export async function listTrainingSessionsCombinedByCoachId(coachid: number): Promise<CombinedTrainingSession[]> {
	const tsData = await request(`/trainingsessions?coachid=${encodeURIComponent(coachid)}`, { debugLabel: 'listTrainingSessionsByCoachId' })
	if (!Array.isArray(tsData)) return []
	const sessions: TrainingSessionRow[] = tsData as TrainingSessionRow[]

	const infoRowsRaw = await request('/trainingsessioninfo', { debugLabel: 'listTrainingSessionInfoAll' })
	const infoBySessionId = new Map<number, TrainingSessionInfoMeta>()
	if (Array.isArray(infoRowsRaw)) for (const r of infoRowsRaw as TrainingSessionInfoMeta[]) infoBySessionId.set(r.sessionid, r)

	const allCourtBookings = await safeGet('/courtbookings', 'listCourtBookingsAll')
	const bookingById = new Map<number, any>()
	if (Array.isArray(allCourtBookings)) for (const b of allCourtBookings) if (typeof b.courtbookingid === 'number') bookingById.set(b.courtbookingid, b)

	const neededAvailabilityIds = [...new Set(sessions.map(s => bookingById.get(s.courtbookingid)?.availabilityid).filter(Boolean))] as number[]
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
			court_name: (ci as any)?.name ?? null,
			sport: ci?.sport,
			venue: ci?.venue,
			entry_fee: meta?.entry_fee ?? null,
			support_payment_method: meta?.support_payment_method ?? null,
			participants_cap: (meta as any)?.participants_cap ?? null,
			join_status: (meta as any)?.join_status ?? null,
		}
	})
}
// Cached variant (sessions volatile similar to events)
export async function listTrainingSessionsCombinedCached(): Promise<CombinedTrainingSession[]> {
	return fetchWithCache<CombinedTrainingSession[]>({
		key: 'cache:trainingsessions:combined:v1',
		ttlMs: 60 * 1000,
		swrMs: 120 * 1000,
		fetcher: () => listTrainingSessionsCombined()
	})
}

// Force refresh of the cached combined training sessions list.
export async function invalidateTrainingSessionsCombinedCache(): Promise<void> {
	try { await invalidateCache('cache:trainingsessions:combined:v1') } catch {}
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

