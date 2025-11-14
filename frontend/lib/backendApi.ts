import { API_BASE_URL } from '@/env'
import { fetchWithCache } from '@/lib/cache'

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
export type UserInfoRow = { infoid: number; userid: number; name?: string | null; email?: string | null; contactnumber?: string | null; time?: string | null; sport?: string | null }

export async function getUserInfoByUserId(userid: number) {
	if (userid == null) throw new Error('userid required')
	const path = `/userinfo?userid=${encodeURIComponent(userid)}`
	const rows = await request(path, { debugLabel: 'getUserInfoByUserId' })
	if (Array.isArray(rows) && rows.length) return rows[0] as UserInfoRow
	return null
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

// ---- Event & Training Session Aggregation Helpers ----
// These compose multiple REST endpoints into richer objects for UI screens.

export type EventRow = { eventid: number; time: string; courtbookingid: number; status?: string; organizerid: number }
export type EventInfoMeta = { eventinfoid: number; eventid: number; numberofpeople?: number | null; description?: string | null; title: string }
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
	courtid?: number
	address?: string
	sport?: string[] | string | null
	venue?: string[] | string | null
}

export type TrainingSessionRow = { sessionid: number; time: string; courtbookingid: number; status?: string; coachid: number }
export type TrainingSessionInfoMeta = { sessioninfoid: number; sessionid: number; numberofpeople: number; description: string; title: string }
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
	courtid?: number
	address?: string
	sport?: string[] | string | null
	venue?: string[] | string | null
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
			courtid,
			address: ci?.address,
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
			courtid,
			address: ci?.address,
			sport: ci?.sport,
			venue: ci?.venue,
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

