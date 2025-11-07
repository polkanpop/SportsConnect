// Consolidated shared backend types for stronger reuse across components.
// These mirror FastAPI response shapes and can be imported instead of redefining inline.

export interface CourtInfo {
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
  isFavorite?: boolean; // added client-side only when merged with favorites
}

export interface Notification {
  id: number;
  status?: string;
  user_id?: number | null;
  message?: string;
  time?: string;
  notificationtype?: string;
  notificationtypeid?: number;
}

export interface FavoriteRow { user_id: string; courtinfoid: number; }

export interface ProfileRow { id: string; username?: string; full_name?: string; avatar_url?: string; }
export interface ProfileUpdatePayload { username?: string; full_name?: string; avatar_url?: string; }

export interface CourtBooking { courtbookingid: number; userid: number; status?: string; start_timestamp?: string; end_timestamp?: string; sport?: string; court?: string; }
export interface EventBooking { eventbookingid: number; userid: number; status?: string; event?: string; date?: string; time?: string; message?: string; }
export interface TrainingSession { sessionid: number; courtbookingid?: number; time?: string; status?: string; coachid?: number; sessioninfo?: string; }

export interface HistoryResponse {
  userid: number;
  court_bookings: CourtBooking[];
  event_bookings: EventBooking[];
  training_sessions: TrainingSession[];
}

// Generic loading state helper shape
export interface LoadState<T> { data: T; loading: boolean; error: string | null; }