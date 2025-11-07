// backendApi.ts
// Thin client for the FastAPI backend. Uses Expo public env var EXPO_PUBLIC_BACKEND_URL.
// Falls back to direct Supabase when backend not available (optional strategy).

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL?.replace(/\/$/, "") || "http://localhost:8000"; // default for dev

async function api<T>(path: string, options: RequestInit & { expect?: number[] } = {}): Promise<T> {
  const url = `${BACKEND_URL}${path}`;
  const expect = options.expect || [200];
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!expect.includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${url}: ${text}`);
  }
  // Handle empty body
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// Court Info
export type CourtInfo = {
  courtinfoid: number;
  courtid?: number | string | null;
  name?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  latitudedelta?: number | null;
  longitudedelta?: number | null;
  sport?: string[] | string | null;
  venue?: string[] | string | null;
  images?: string[] | null;
  availability?: string | null;
};

export async function fetchCourts(): Promise<CourtInfo[]> {
  return api<CourtInfo[]>("/api/courtinfo");
}

export async function fetchCourt(id: number): Promise<CourtInfo> {
  return api<CourtInfo>(`/api/courtinfo/${id}`);
}

// Notifications (aligned with backend FastAPI model)
export interface Notification {
  id: number;
  status?: string;
  user_id?: number | null;
  message?: string;
  time?: string; // ISO timestamp
  notificationtype?: string;
  notificationtypeid?: number;
}

export async function fetchNotifications(params?: { user_id?: number; notificationtype?: string; debug?: boolean }): Promise<Notification[]> {
  const qs = new URLSearchParams();
  if (params?.user_id !== undefined) qs.set("user_id", String(params.user_id));
  if (params?.notificationtype) qs.set("notificationtype", params.notificationtype);
  if (params?.debug) qs.set("debug", "true");
  const suffix = qs.toString() ? `?${qs}` : "";
  return api<Notification[]>(`/api/notifications${suffix}`);
}

// Favorites (now require JWT Authorization header bearing Supabase access token)
export interface FavoriteRow { user_id: string; courtinfoid: number; }

function authHeaders(token?: string): Record<string,string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchFavorites(accessToken: string): Promise<FavoriteRow[]> {
  return api<FavoriteRow[]>("/api/favorites", { headers: authHeaders(accessToken) });
}

export async function addFavorite(accessToken: string, courtinfoid: number): Promise<FavoriteRow> {
  return api<FavoriteRow>("/api/favorites", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ courtinfoid }),
  });
}

export async function removeFavorite(accessToken: string, courtinfoid: number): Promise<{ deleted: boolean; count: number; }> {
  return api<{ deleted: boolean; count: number }>(`/api/favorites/${courtinfoid}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
}

// Profiles
export interface ProfileRow { id: string; username?: string; full_name?: string; avatar_url?: string; }
export async function fetchProfile(userId: string): Promise<ProfileRow> {
  return api<ProfileRow>(`/api/profiles/${userId}`);
}

export interface ProfileUpdatePayload { username?: string; full_name?: string; avatar_url?: string; }
export async function updateProfile(accessToken: string, userId: string, payload: ProfileUpdatePayload): Promise<ProfileRow> {
  return api<ProfileRow>(`/api/profiles/${userId}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload),
  });
}

// Court Bookings / Event Bookings / Training Sessions
export interface CourtBooking { courtbookingid: number; userid: number; status?: string; start_timestamp?: string; end_timestamp?: string; sport?: string; court?: string; }
export interface EventBooking { eventbookingid: number; userid: number; status?: string; event?: string; date?: string; time?: string; message?: string; }
export interface TrainingSession { sessionid: number; courtbookingid?: number; time?: string; status?: string; coachid?: number; sessioninfo?: string; }

export async function fetchCourtBookings(params?: { userid?: number; status?: string; limit?: number; offset?: number }): Promise<CourtBooking[]> {
  const qs = new URLSearchParams();
  if (params?.userid !== undefined) qs.set('userid', String(params.userid));
  if (params?.status) qs.set('status', params.status);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return api<CourtBooking[]>(`/api/courtbookings${suffix}`);
}

export async function fetchEventBookings(params?: { userid?: number; status?: string; limit?: number; offset?: number }): Promise<EventBooking[]> {
  const qs = new URLSearchParams();
  if (params?.userid !== undefined) qs.set('userid', String(params.userid));
  if (params?.status) qs.set('status', params.status);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return api<EventBooking[]>(`/api/eventbookings${suffix}`);
}

export async function fetchTrainingSessions(params?: { coachid?: number; status?: string; limit?: number; offset?: number }): Promise<TrainingSession[]> {
  const qs = new URLSearchParams();
  if (params?.coachid !== undefined) qs.set('coachid', String(params.coachid));
  if (params?.status) qs.set('status', params.status);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return api<TrainingSession[]>(`/api/trainingsessions${suffix}`);
}

// Create bookings (auth required)
export async function createCourtBooking(token: string, payload: Partial<CourtBooking>): Promise<CourtBooking> {
  return api<CourtBooking>("/api/courtbookings", { method: 'POST', headers: authHeaders(token), body: JSON.stringify(payload) });
}
export async function createEventBooking(token: string, payload: Partial<EventBooking>): Promise<EventBooking> {
  return api<EventBooking>("/api/eventbookings", { method: 'POST', headers: authHeaders(token), body: JSON.stringify(payload) });
}

export interface HistoryResponse {
  userid: number;
  court_bookings: CourtBooking[];
  event_bookings: EventBooking[];
  training_sessions: TrainingSession[];
}
export async function fetchHistory(userid: number): Promise<HistoryResponse> {
  return api<HistoryResponse>(`/api/history?userid=${userid}`);
}

// Health / Status helpers
export async function backendHealth(): Promise<{ status: string }> {
  return api<{ status: string }>("/health");
}

// Simple connectivity check returning boolean (no throw)
export async function checkBackendReachable(): Promise<boolean> {
  try {
    await backendHealth();
    return true;
  } catch (e) {
    return false;
  }
}

export function isBackendConfigured(): boolean {
  return !!process.env.EXPO_PUBLIC_BACKEND_URL;
}

// Example integration function to merge backend courts with local favorite flags
export async function loadCourtDataWithFavorites(accessToken?: string): Promise<CourtInfo[]> {
  const courts = await fetchCourts();
  if (!accessToken) return courts;
  try {
    const favs = await fetchFavorites(accessToken);
    const favSet = new Set(favs.map(f => f.courtinfoid));
    return courts.map(c => ({ ...c, isFavorite: favSet.has(c.courtinfoid) } as any));
  } catch (e) {
    console.warn("Failed favorites fetch", e);
    return courts;
  }
}

// Minimal hook example (can be moved to hooks/)
// import { useEffect, useState } from 'react';
// export function useCourts(userId?: string) {
//   const [data, setData] = useState<CourtInfo[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);
//   useEffect(() => {
//     (async () => {
//       setLoading(true);
//       try { setData(await loadCourtDataWithFavorites(userId)); setError(null); }
//       catch (e:any) { setError(e.message); }
//       finally { setLoading(false); }
//     })();
//   }, [userId]);
//   return { data, loading, error };
// }
