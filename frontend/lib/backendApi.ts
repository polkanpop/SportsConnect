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
export type UserInfoRow = { infoid: number; userid: number; name?: string | null; email?: string | null; contactnumber?: string | null; time?: string | null; sport?: string | null }

export async function getUserInfoByUserId(userid: number) {
	if (userid == null) throw new Error('userid required')
	const path = `/userinfo?userid=${encodeURIComponent(userid)}`
	const rows = await request(path, { debugLabel: 'getUserInfoByUserId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as UserInfoRow
	return null
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

