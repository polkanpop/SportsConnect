import { useAppBootstrap } from "@/providers/app-bootstrap-provider";
import { queryKeys } from "@/hooks/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ICONS } from "@/constants/icons";
import { COLORS } from "@/constants/colors";
import {
  listEventsCombinedByOrganizerId,
  listTrainingSessionsCombinedByCoachId,
  syncPastUpcomingStatuses,
} from "@/lib/backendApi";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SkeletonBox, SkeletonPulse } from "@/components/ui/skeleton";
import { useTranslation } from '@/constants/translations';
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "@/hooks/use-theme-colors";

// Type definition for Unified Booking
type UnifiedBooking = {
  id: string; // Unique identifier for each booking
  title: string;
  /** Display status from DB values (no client clock-based guessing). */
  status: "Completed" | "Upcoming" | "Cancelled" | "Missed";
  mode: "Booking" | "Hosting";
  activity: "court" | "event" | "session";
  type: keyof typeof ICONS; // The icon type from ICONS object
  courtName?: string | null;
  date: string; // Date of the event or booking
  time: string; // Time of the event or booking
  day: string; // Day of the week (e.g., 'M', 'T', 'W')
  dateTime: Date;
  startTimestamp?: string | null;
  endTimestamp?: string | null;
  /** Entity ID used for review submissions (courtid | eventid | sessionid) */
  targetId?: number;
  /** Raw booking_status from the entity status column (pending/approved/rejected/missed etc.) */
  bookingStatus: string;
  /** Raw session_status from the bookingstatus column (upcoming/completed/cancelled/missed) */
  sessionStatus: string;
};

// Function to get the day of the week from a date string
const getDayOfWeek = (dateString: string) => {
  const date = new Date(dateString);
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return days[date.getDay()];
};

const parseIsoDateLocal = (isoDate: string) => {
  // isoDate: YYYY-MM-DD
  const [y, m, d] = isoDate.split('-').map((v) => Number(v));
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
};

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

const toDateStringLocal = (d: Date) => {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const parseTimestampLoose = (ts?: string | null) => {
  if (!ts || typeof ts !== 'string') return new Date(NaN);
  // Support both "YYYY-MM-DD HH:mm:ss" and ISO formats.
  const normalized = ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts;
  return new Date(normalized);
};

const firstRelatedRow = (rel: any): any | null => {
  if (Array.isArray(rel)) return rel[0] ?? null;
  if (rel && typeof rel === 'object') return rel;
  return null;
};

const firstText = (...values: any[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string') {
      const s = value.trim();
      if (s) return s;
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const s = item.trim();
        if (s) return s;
      }
    }
  }
  return null;
};

const mapStatusFromDb = (raw: any): UnifiedBooking['status'] => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Upcoming';
  if (s.includes('cancel') || s === 'rejected') return 'Cancelled';
  if (s.includes('complete')) return 'Completed';
  if (s.includes('miss')) return 'Missed';
  return 'Upcoming';
};

const pickTitle = (row: any, fallback: string): string => {
  if (!row || typeof row !== 'object') return fallback;
  const info = firstRelatedRow((row as any)?.eventinfo) || firstRelatedRow((row as any)?.trainingsessioninfo);
  return firstText(
    row.title,
    (info as any)?.title,
    row.name,
  ) || fallback;
};

const pickVenueLabel = (row: any): string | null => {
  if (!row || typeof row !== 'object') return null;
  const booking = firstRelatedRow((row as any)?.courtbooking);
  const availability = firstRelatedRow((booking as any)?.courtavailability);
  const courtsRel = firstRelatedRow((availability as any)?.courts);
  const courtInfoRel = firstRelatedRow((courtsRel as any)?.courtinfo) || firstRelatedRow((availability as any)?.courtinfo);
  const relatedInfo = firstRelatedRow((row as any)?.eventinfo) || firstRelatedRow((row as any)?.trainingsessioninfo);
  return firstText(
    (courtInfoRel as any)?.name,
    (courtsRel as any)?.courtinfo,
    row.court_name,
    row.venue,
    row.address,
    (relatedInfo as any)?.venue,
    (relatedInfo as any)?.address,
    (booking as any)?.selected_base_name,
    (booking as any)?.selected_court_name,
  );
};

const VI_WEEKDAY = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7']
const EN_WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const formatDateWeekdayDDMMYYYY = (dt: Date, lang?: string) => {
  if (Number.isNaN(dt.getTime())) return '';
  const dayIndex = dt.getDay(); // 0=Sun
  const wd = lang === 'vi' ? VI_WEEKDAY[dayIndex] : EN_WEEKDAY[dayIndex];
  const dd = pad2(dt.getDate());
  const mm = pad2(dt.getMonth() + 1);
  const yyyy = dt.getFullYear();
  return `${wd} ${dd}-${mm}-${yyyy}`;
};

const formatTimeHHMM = (dt: Date) => {
  if (Number.isNaN(dt.getTime())) return '';
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
};

// Merge all bookings into a unified list
const mergeBookings = (params: {
  courtBookings: any[]
  eventBookings: any[]
  trainingSessionBookings: any[]
  eventsById: Map<number, any>
  sessionsById: Map<number, any>
}): UnifiedBooking[] => {
  const courtBookings = Array.isArray(params.courtBookings) ? params.courtBookings : [];
  const eventBookings = Array.isArray(params.eventBookings) ? params.eventBookings : [];
  const trainingSessionBookings = Array.isArray(params.trainingSessionBookings) ? params.trainingSessionBookings : [];

  const safeStr = (v: any): string => (typeof v === 'string' ? v : '');

  const safeIsoDate = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '');
  const safeTime = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');

  const allBookings = [
    ...courtBookings.map((item) => {
      const startTs = item.start_timestamp as string | undefined;
      const endTs = item.end_timestamp as string | undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      const selectedBaseName = typeof (item as any)?.selected_base_name === 'string' ? (item as any).selected_base_name : undefined;
      const selectedCourtName = typeof (item as any)?.selected_court_name === 'string' ? (item as any).selected_court_name : undefined;
      const courtName = typeof (item as any)?.court_name === 'string' ? (item as any).court_name : undefined;
      const displayCourtName = courtName || selectedBaseName || selectedCourtName;
      const courtId = typeof (item as any)?.courtid === 'number' ? (item as any).courtid : undefined;
      const rawBookingStatus = safeStr(item.status);       // entity status column (pending/approved/rejected/missed)
      const rawSessionStatus = safeStr(item.bookingstatus); // sessionstatus column (upcoming/completed/cancelled/missed)
      return {
        id: `court_${item.courtbookingid}`,
        title: displayCourtName || `Court Booking #${item.courtbookingid}`,
        status: mapStatusFromDb(rawSessionStatus || rawBookingStatus),
        mode: 'Booking',
        activity: 'court',
        type: 'stadiumCal' as keyof typeof ICONS,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
        targetId: courtId,
        bookingStatus: rawBookingStatus,
        sessionStatus: rawSessionStatus,
      } satisfies UnifiedBooking;
    }),
    ...eventBookings.map((item) => {
      const eventIdRaw = Number(item?.eventid);
      const eventId = Number.isFinite(eventIdRaw) ? eventIdRaw : NaN;
      const byId = Number.isFinite(eventId) ? params.eventsById.get(eventId) : undefined;
      const relatedEvent = firstRelatedRow((item as any)?.events);
      const relatedInfo = firstRelatedRow((relatedEvent as any)?.eventinfo);
      const ev = { ...(relatedEvent || {}), ...(byId || {}) } as any;
      const startTs =
        (ev?.start_timestamp as string | undefined) ??
        (ev?.time as string | undefined) ??
        ((item as any)?.start_timestamp as string | undefined) ??
        undefined;
      const endTs =
        (ev?.end_timestamp as string | undefined) ??
        ((item as any)?.end_timestamp as string | undefined) ??
        undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      const rawBookingStatus = safeStr(item.status);
      const rawSessionStatus = safeStr(item.bookingstatus);
      return {
        id: `event_${item.eventbookingid}`,
        title: pickTitle({ ...ev, eventinfo: relatedInfo }, 'Event'),
        status: mapStatusFromDb(rawSessionStatus || rawBookingStatus),
        mode: 'Booking',
        activity: 'event',
        type: 'starCal' as keyof typeof ICONS,
        courtName: pickVenueLabel(ev) || (relatedInfo as any)?.venue || (relatedInfo as any)?.address || null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
        targetId: typeof item.eventid === 'number' ? item.eventid : undefined,
        bookingStatus: rawBookingStatus,
        sessionStatus: rawSessionStatus,
      } satisfies UnifiedBooking;
    }),
    ...trainingSessionBookings.map((item) => {
      const sessionIdRaw = Number(item?.sessionid);
      const sessionId = Number.isFinite(sessionIdRaw) ? sessionIdRaw : NaN;
      const byId = Number.isFinite(sessionId) ? params.sessionsById.get(sessionId) : undefined;
      const relatedSession = firstRelatedRow((item as any)?.trainingsessions);
      const relatedInfo = firstRelatedRow((relatedSession as any)?.trainingsessioninfo);
      const sess = { ...(relatedSession || {}), ...(byId || {}) } as any;
      const startTs =
        (sess?.start_timestamp as string | undefined) ??
        (sess?.time as string | undefined) ??
        ((item as any)?.start_timestamp as string | undefined) ??
        undefined;
      const endTs =
        (sess?.end_timestamp as string | undefined) ??
        ((item as any)?.end_timestamp as string | undefined) ??
        undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      const rawBookingStatus = safeStr(item.status);
      const rawSessionStatus = safeStr(item.bookingstatus);
      return {
        id: `session_${item.tsbookingid}`,
        title: pickTitle({ ...sess, trainingsessioninfo: relatedInfo }, 'Training Session'),
        status: mapStatusFromDb(rawSessionStatus || rawBookingStatus),
        mode: 'Booking',
        activity: 'session',
        type: 'coachCal' as keyof typeof ICONS,
        courtName: pickVenueLabel(sess) || (relatedInfo as any)?.venue || (relatedInfo as any)?.address || null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
        targetId: typeof item.sessionid === 'number' ? item.sessionid : undefined,
        bookingStatus: rawBookingStatus,
        sessionStatus: rawSessionStatus,
      } satisfies UnifiedBooking;
    }),
  ];

  return allBookings.sort((a, b) => {
    const at = a.dateTime.getTime();
    const bt = b.dateTime.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return at - bt;
  });
};

const mergeHosting = (params: {
  createdEvents: any[]
  createdSessions: any[]
}): UnifiedBooking[] => {
  const createdEvents = Array.isArray(params.createdEvents) ? params.createdEvents : [];
  const createdSessions = Array.isArray(params.createdSessions) ? params.createdSessions : [];

  const safeIsoDate = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '');
  const safeTime = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');

  const all = [
    ...createdEvents.map((ev) => {
      const startTs = (ev?.start_timestamp as string | undefined) ?? (ev?.time as string | undefined) ?? undefined;
      const endTs = (ev?.end_timestamp as string | undefined) ?? undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      return {
        id: `created_event_${ev?.eventid}`,
        title: pickTitle(ev, 'Event'),
        status: mapStatusFromDb(ev?.status),
        mode: 'Hosting',
        activity: 'event',
        type: 'starCal' as keyof typeof ICONS,
        courtName: pickVenueLabel(ev),
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
        bookingStatus: '',
        sessionStatus: '',
      } satisfies UnifiedBooking;
    }),
    ...createdSessions.map((s) => {
      const startTs = (s?.start_timestamp as string | undefined) ?? (s?.time as string | undefined) ?? undefined;
      const endTs = (s?.end_timestamp as string | undefined) ?? undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      return {
        id: `created_session_${s?.sessionid}`,
        title: pickTitle(s, 'Training Session'),
        status: mapStatusFromDb(s?.status),
        mode: 'Hosting',
        activity: 'session',
        type: 'coachCal' as keyof typeof ICONS,
        courtName: pickVenueLabel(s),
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
        bookingStatus: '',
        sessionStatus: '',
      } satisfies UnifiedBooking;
    }),
  ];

  return all.sort((a, b) => {
    const at = a.dateTime.getTime();
    const bt = b.dateTime.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return at - bt;
  });
};

const getWeekDaysForOffset = (weekOffset: number, language: string) => {
  const VI_DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
  const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const days = [] as {
    dayLetter: string;
    dateNumber: number;
    fullDate: string;
    isToday: boolean;
  }[];

  const today = new Date();
  const dayOfWeek = today.getDay(); // Sunday = 0, Monday = 1, etc.
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Adjust to make Monday the first day

  const monday = new Date(today);
  monday.setDate(today.getDate() - diff + weekOffset * 7);

  for (let i = 0; i < 7; i++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    days.push({
      dayLetter: (language === 'vi' ? VI_DAYS : EN_DAYS)[i],
      dateNumber: date.getDate(),
      fullDate: toDateStringLocal(date),
      isToday: date.toDateString() === today.toDateString(),
    });
  }

  return days;
};

export default function ActivityPage() {
  const { t, language } = useTranslation();
  const tc = useThemeColors();
  const [calendarMode, setCalendarMode] = useState<"Booking" | "Hosting">("Booking");
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedActivity, setSelectedActivity] = useState<UnifiedBooking | null>(null);
  const [statusFilter, setStatusFilter] = useState<"All" | "Upcoming" | "Completed" | "Cancelled" | "Missed">("All");
  const [activityKindFilter, setActivityKindFilter] = useState<"All" | "Court" | "Event" | "TS">("All");
  const [openFilter, setOpenFilter] = useState<null | 'status' | 'activity' | 'type'>(null);
  const [refreshing, setRefreshing] = useState(false);

  const statusLabel =
    statusFilter === 'All' ? t('COMMON_LABEL_STATUS') :
    statusFilter === 'Upcoming' ? t('ACTIVITY_FILTER_UPCOMING') :
    statusFilter === 'Completed' ? t('ACTIVITY_FILTER_COMPLETED') :
    statusFilter === 'Cancelled' ? t('ACTIVITY_FILTER_CANCELLED') :
    t('ACTIVITY_FILTER_MISSED');
  const activityLabel =
    activityKindFilter === 'All' ? t('ACTIVITY_HEADER_TITLE') :
    activityKindFilter === 'Court' ? t('COMMON_FILTER_COURT') :
    activityKindFilter === 'Event' ? t('COMMON_FILTER_EVENT') :
    t('ACTIVITY_FILTER_TS');
  const typeLabel = calendarMode === 'Booking' ? t('ACTIVITY_FILTER_BOOKING') : t('ACTIVITY_FILTER_HOSTING');
  
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId, dashboard, eventsCombined, trainingSessionsCombined } = useAppBootstrap()
  const userIdLoading = dashboard.isLoading && userId == null
  const userIdError = dashboard.error

  const onPullToRefresh = useCallback(async () => {
    if (typeof userId !== 'number') return;
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userId), refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activityHostingEvents(userId), refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activityHostingSessions(userId), refetchType: 'active' }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, userId]);

  // Throttle focus-triggered invalidation to at most once per 60 s to prevent
  // spamming the backend every time the user switches tabs.
  const lastFocusInvalidateRef = useRef<number>(0)

  // Refresh dashboard whenever the user focuses this tab.
  // Throttled to 5 s to avoid spamming the backend on rapid tab switches,
  // but short enough that coming back right after a booking creation gets fresh data.
  useFocusEffect(
    useCallback(() => {
      if (typeof userId !== 'number') return;
      const now = Date.now()
      if (now - lastFocusInvalidateRef.current < 5_000) return
      lastFocusInvalidateRef.current = now
      void queryClient.refetchQueries({ queryKey: queryKeys.dashboard(userId), type: 'active' })
      // Also keep hosting queries fresh so Hosting tab is fast and reflects new events
      void queryClient.refetchQueries({ queryKey: queryKeys.activityHostingEvents(userId), type: 'all' })
      void queryClient.refetchQueries({ queryKey: queryKeys.activityHostingSessions(userId), type: 'all' })
    }, [queryClient, userId])
  );

  const dashboardRaw = dashboard.data
  const dashboardLoading = dashboard.isLoading
  const dashboardError = dashboard.error
  const courtBookingsRaw = dashboardRaw?.court_bookings ?? []
  const eventBookingsRaw = dashboardRaw?.event_bookings ?? []
  const trainingSessionBookingsRaw = dashboardRaw?.training_bookings ?? []

  const courtBookingsData = useMemo(() => (Array.isArray(courtBookingsRaw) ? courtBookingsRaw : []), [courtBookingsRaw]);
  const eventBookingsData = useMemo(() => (Array.isArray(eventBookingsRaw) ? eventBookingsRaw : []), [eventBookingsRaw]);
  const trainingSessionBookingsData = useMemo(
    () => (Array.isArray(trainingSessionBookingsRaw) ? trainingSessionBookingsRaw : []),
    [trainingSessionBookingsRaw]
  );

  const eventsById = useMemo(() => {
    const m = new Map<number, any>();
    if (Array.isArray(eventsCombined)) {
      for (const e of eventsCombined) {
        if (typeof e?.eventid === 'number') m.set(e.eventid, e);
      }
    }
    return m;
  }, [eventsCombined]);

  const sessionsById = useMemo(() => {
    const m = new Map<number, any>();
    if (Array.isArray(trainingSessionsCombined)) {
      for (const s of trainingSessionsCombined) {
        if (typeof s?.sessionid === 'number') m.set(s.sessionid, s);
      }
    }
    return m;
  }, [trainingSessionsCombined]);

  const data = useMemo(
    () =>
      mergeBookings({
        courtBookings: courtBookingsData,
        eventBookings: eventBookingsData,
        trainingSessionBookings: trainingSessionBookingsData,
        eventsById,
        sessionsById,
      }),
    [courtBookingsData, eventBookingsData, trainingSessionBookingsData, eventsById, sessionsById]
  );

  const hostingEventsQuery = useQuery({
    queryKey: queryKeys.activityHostingEvents(userId ?? -1),
    queryFn: () => listEventsCombinedByOrganizerId(userId as number),
    enabled: typeof userId === 'number',  // prefetch eagerly so Hosting tab loads instantly
    staleTime: 60_000,
    refetchOnMount: true,  // always re-check after invalidation, overrides global false default
  })

  const hostingSessionsQuery = useQuery({
    queryKey: queryKeys.activityHostingSessions(userId ?? -1),
    queryFn: () => listTrainingSessionsCombinedByCoachId(userId as number),
    enabled: typeof userId === 'number',  // prefetch eagerly
    staleTime: 60_000,
    refetchOnMount: true,
  })

  const createdEventsCombinedRaw = useMemo(
    () => (Array.isArray(hostingEventsQuery.data)
      ? hostingEventsQuery.data
      : (Array.isArray(eventsCombined) && typeof userId === 'number'
        ? eventsCombined.filter((e: any) => Number(e?.organizerid) === userId)
        : [])),
    [hostingEventsQuery.data, eventsCombined, userId]
  )

  const createdTrainingSessionsCombinedRaw = useMemo(
    () => (Array.isArray(hostingSessionsQuery.data)
      ? hostingSessionsQuery.data
      : (Array.isArray(trainingSessionsCombined) && typeof userId === 'number'
        ? trainingSessionsCombined.filter((s: any) => Number(s?.coachid) === userId)
        : [])),
    [hostingSessionsQuery.data, trainingSessionsCombined, userId]
  )

  const hostingData = useMemo(
    () =>
      mergeHosting({
        createdEvents: createdEventsCombinedRaw as any,
        createdSessions: createdTrainingSessionsCombinedRaw as any,
      }),
    [createdEventsCombinedRaw, createdTrainingSessionsCombinedRaw]
  );

  const eventBookingsForSync = useMemo(() => {
    return eventBookingsData.map((booking: any) => {
      const eventId = Number(booking?.eventid)
      const ev = Number.isFinite(eventId) ? eventsById.get(eventId) : null
      return {
        ...booking,
        start_timestamp: (ev as any)?.start_timestamp ?? (ev as any)?.time ?? null,
        end_timestamp: (ev as any)?.end_timestamp ?? null,
      }
    })
  }, [eventBookingsData, eventsById])

  const sessionBookingsForSync = useMemo(() => {
    return trainingSessionBookingsData.map((booking: any) => {
      const sessionId = Number(booking?.sessionid)
      const sess = Number.isFinite(sessionId) ? sessionsById.get(sessionId) : null
      return {
        ...booking,
        start_timestamp: (sess as any)?.start_timestamp ?? (sess as any)?.time ?? null,
        end_timestamp: (sess as any)?.end_timestamp ?? null,
      }
    })
  }, [trainingSessionBookingsData, sessionsById])

  const activeData = calendarMode === 'Hosting' ? hostingData : data;

  useEffect(() => {
    if (typeof userId !== 'number') return
    const run = async () => {
      const changed = await syncPastUpcomingStatuses({
        events: createdEventsCombinedRaw as any,
        sessions: createdTrainingSessionsCombinedRaw as any,
        bookings: courtBookingsData as any,
        eventBookings: eventBookingsForSync as any,
        sessionBookings: sessionBookingsForSync as any,
      })
      if (!changed) return
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userId), refetchType: 'active' })
      await queryClient.invalidateQueries({ queryKey: queryKeys.activityHostingEvents(userId), refetchType: 'active' })
      await queryClient.invalidateQueries({ queryKey: queryKeys.activityHostingSessions(userId), refetchType: 'active' })
    }
    void run()
  }, [
    userId,
    queryClient,
    createdEventsCombinedRaw,
    createdTrainingSessionsCombinedRaw,
    courtBookingsData,
    eventBookingsForSync,
    sessionBookingsForSync,
  ])
  
  const weekDays = useMemo(() => getWeekDaysForOffset(weekOffset, language), [weekOffset, language]);

  const monthLabel = useMemo(() => {
    if (!weekDays.length) return '';
    const start = parseIsoDateLocal(weekDays[0].fullDate);
    const end = parseIsoDateLocal(weekDays[weekDays.length - 1].fullDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

    const VI_MONTHS = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                       'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12']
    const getMonthName = (d: Date) => language === 'vi'
      ? VI_MONTHS[d.getMonth()]
      : d.toLocaleString('en-US', { month: 'long' })

    const startMonth = getMonthName(start);
    const endMonth = getMonthName(end);
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();

    if (start.getMonth() === end.getMonth() && startYear === endYear) {
      return language === 'vi'
        ? `${VI_MONTHS[start.getMonth()]} ${startYear}`
        : start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }
    if (startYear === endYear) {
      return `${startMonth} - ${endMonth} ${startYear}`;
    }
    return `${startMonth} ${startYear} - ${endMonth} ${endYear}`;
  }, [weekDays, language]);

  const isLoading =
    userIdLoading ||
    dashboardLoading ||
    (calendarMode === 'Hosting' && (hostingEventsQuery.isLoading || hostingSessionsQuery.isLoading));

  const getStatusStyle = (status: UnifiedBooking['status']) => {
    switch (status) {
      case "Completed": return styles.completed;
      case "Upcoming": return styles.upcoming;
      case "Cancelled": return styles.cancelled;
      case "Missed": return styles.missed;
      default: return {};
    }
  };

  const isFadedStatus = (status: UnifiedBooking["status"]) => status === 'Cancelled' || status === 'Completed' || status === 'Missed';

  const translateStatus = (status: UnifiedBooking['status']): string => {
    switch (status) {
      case 'Upcoming': return t('ACTIVITY_FILTER_UPCOMING');
      case 'Completed': return t('ACTIVITY_FILTER_COMPLETED');
      case 'Cancelled': return t('ACTIVITY_FILTER_CANCELLED');
      case 'Missed': return t('ACTIVITY_FILTER_MISSED');
      default: return status;
    }
  };

  const recordTitlePrefix = (activity: UnifiedBooking['activity']): string => {
    if (activity === 'court') return t('ACTIVITY_PREFIX_VENUE');
    if (activity === 'event') return t('ACTIVITY_PREFIX_EVENT');
    return t('ACTIVITY_PREFIX_TRAINING');
  };

  const renderRecord = (item: UnifiedBooking) => {
    const bs = item.bookingStatus.toLowerCase()
    const ss = item.sessionStatus.toLowerCase()

    let badges: Array<{ label: string; bg: string }> = []
    if (item.mode === 'Booking') {
      if (item.activity === 'court') {
        if (bs === 'pending') {
          badges = [{ label: t('ACTIVITY_BADGE_PENDING'), bg: '#EAB308' }]
        } else if (bs === 'rejected') {
          badges = [{ label: t('ACTIVITY_BADGE_REJECTED'), bg: '#EF4444' }]
        } else if (bs === 'approved') {
          if (ss !== 'cancelled') {
            const approvedBadge = { label: t('ACTIVITY_BADGE_APPROVED'), bg: '#22C55E' }
            if (ss === 'completed') badges = [{ label: t('ACTIVITY_BADGE_COMPLETED'), bg: '#22C55E' }]
            else if (ss === 'missed') badges = [approvedBadge, { label: t('ACTIVITY_BADGE_MISSED'), bg: '#374151' }]
            else badges = [approvedBadge, { label: t('ACTIVITY_BADGE_UPCOMING'), bg: '#3B82F6' }]
          }
        }
      } else {
        if (bs === 'pending') {
          badges = [{ label: t('ACTIVITY_BADGE_PENDING'), bg: '#EAB308' }]
        } else if (bs === 'joined') {
          const joinedBadge = { label: t('ACTIVITY_BADGE_JOINED'), bg: '#22C55E' }
          if (ss.includes('completed') || item.status === 'Completed') badges = [{ label: t('ACTIVITY_BADGE_COMPLETED'), bg: '#22C55E' }]
          else if (ss.includes('missed') || item.status === 'Missed') badges = [joinedBadge, { label: t('ACTIVITY_BADGE_MISSED'), bg: '#374151' }]
          else badges = [joinedBadge, { label: t('ACTIVITY_BADGE_UPCOMING'), bg: '#3B82F6' }]
        }
      }
    }

    return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() =>
        router.push({
          pathname: "/event/details",
          params: { id: item.id },
        })
      }
      style={[styles.eventItem, { backgroundColor: tc.bgElevated }]}
    >
      <Image
        source={ICONS[item.type]}
        style={[
          styles.eventImage,
          { tintColor: ICONS[item.type]?.color },
        ]}
      />
      <View style={styles.eventDetails}>
        <Text style={[styles.eventTitle, { color: tc.textPrimary }]} numberOfLines={2}>
          <Text style={[styles.eventTitlePrefix, { color: tc.textPrimary }]}>{recordTitlePrefix(item.activity)}: </Text>
          {item.title}
        </Text>

        <View style={{ marginTop: 8 }}>
          {badges.length > 0 ? (
            <View style={styles.badgeRow}>
              {badges.map(b => (
                <View key={b.label} style={[styles.statusPill, { backgroundColor: b.bg }]}>
                  <Text style={styles.statusText}>{b.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={[styles.statusPill, getStatusStyle(item.status)]}>
              <Text style={styles.statusText}>{translateStatus(item.status)}</Text>
            </View>
          )}
        </View>

        <Text style={[styles.eventMetaLine, { color: tc.textSecondary }]}>
          <Text style={[styles.eventMetaLabel, { color: tc.textPrimary }]}>{t('ACTIVITY_CARD_DATE')}</Text> {formatDateWeekdayDDMMYYYY(item.dateTime, language) || '—'}
        </Text>

        <Text style={[styles.eventMetaLine, { color: tc.textSecondary }]}>
          <Text style={[styles.eventMetaLabel, { color: tc.textPrimary }]}>{t('ACTIVITY_CARD_TIME')}</Text>{" "}
          {(() => {
            const start = parseTimestampLoose(item.startTimestamp ?? null);
            const end = parseTimestampLoose(item.endTimestamp ?? null);
            const startText = formatTimeHHMM(start);
            const endText = formatTimeHHMM(end);
            if (startText && endText) return `${startText} - ${endText}`;
            if (startText) return startText;
            return '—';
          })()}
        </Text>

        {item.activity !== 'court' && !!item.courtName && (
          <Text style={[styles.eventMetaLine, { color: tc.textSecondary }]}>
            <Text style={[styles.eventMetaLabel, { color: tc.textPrimary }]}>{t('ACTIVITY_EVENT_META_VENUE')}</Text> {item.courtName}
          </Text>
        )}
      </View>
    </TouchableOpacity>
    );
  };

  const filteredData = activeData.filter((item) => {
    if (statusFilter !== 'All' && item.status !== statusFilter) return false;

    if (activityKindFilter !== 'All') {
      if (activityKindFilter === 'Court' && item.activity !== 'court') return false;
      if (activityKindFilter === 'Event' && item.activity !== 'event') return false;
      if (activityKindFilter === 'TS' && item.activity !== 'session') return false;
    }

    return true;
  });

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: tc.bgBase }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
          <SkeletonPulse>
            <SkeletonBox width={140} height={24} radius={8} style={{ marginBottom: 16 }} />
            <View style={{ flexDirection: 'row', marginBottom: 16 }}>
              <SkeletonBox width={140} height={38} radius={12} style={{ marginRight: 12 }} />
              <SkeletonBox width={140} height={38} radius={12} />
            </View>
            {Array.from({ length: 6 }).map((_, idx) => (
              <SkeletonBox
                key={idx}
                width={'100%'}
                height={96}
                radius={16}
                style={{ marginBottom: 12 }}
              />
            ))}
          </SkeletonPulse>
        </View>
      </SafeAreaView>
    )
  }

  if (!userIdLoading && typeof userId !== 'number') {
    return (
      <SafeAreaView style={{ flex: 1, padding: 20, backgroundColor: tc.bgBase, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={styles.headerTitle}>{t('ACTIVITY_HEADER_TITLE')}</Text>
        <Text style={{ marginTop: 10, color: COLORS.neutral850, textAlign: 'center' }}>
          Please log in to view your activity.
        </Text>
      </SafeAreaView>
    );
  }

  const loadError = userIdError ||
    dashboardError;
  if (loadError) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 20, backgroundColor: tc.bgBase }}>
        <Text style={styles.headerTitle}>{t('ACTIVITY_HEADER_TITLE')}</Text>
        <Text style={{ marginTop: 10, color: COLORS.danger }}>
          Failed to load activity records. Check Metro logs for request details.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tc.bgBase }}>
      <View style={[styles.header, { backgroundColor: tc.bgBase }]}>
        <View style={styles.headerSideSpacer} />
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>{t('ACTIVITY_HEADER_TITLE')}</Text>
        <View style={styles.headerSideSpacer} />
      </View>

      <View style={[styles.divider, { backgroundColor: tc.divider }]} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullToRefresh} />}
      >
        <View style={[styles.calendarContainer, { backgroundColor: tc.bgSurface }]}>
          <Text style={[styles.monthHeader, { color: tc.textPrimary }]}>{monthLabel || 'Calendar'}</Text>
          <View style={styles.calendarControlsRow}>
            <TouchableOpacity
              disabled={weekOffset <= -2}
              onPress={() => setWeekOffset((w) => (w <= -2 ? w : w - 1))}
              style={[styles.weekNavBtn, { backgroundColor: tc.bgElevated }, weekOffset <= -2 && styles.weekNavBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={[styles.weekNavIcon, { tintColor: tc.textPrimary, transform: [{ rotate: '180deg' }] }]} />
            </TouchableOpacity>

            <View style={[styles.modeSegmentContainer, { borderColor: tc.border, backgroundColor: tc.bgElevated }]}>
              <TouchableOpacity
                onPress={() => {
                  setCalendarMode('Booking');
                  setSelectedActivity(null);
                }}
                style={[styles.modeSegment, calendarMode === 'Booking' && [styles.modeSegmentActive, { backgroundColor: tc.brand }]]}
              >
                <Text
                  style={[styles.modeSegmentText, { color: tc.brand }, calendarMode === 'Booking' && { color: '#fff' }]}
                >
                  {t('ACTIVITY_FILTER_BOOKING')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setCalendarMode('Hosting');
                  setSelectedActivity(null);
                }}
                style={[styles.modeSegment, calendarMode === 'Hosting' && [styles.modeSegmentActive, { backgroundColor: tc.brand }]]}
              >
                <Text
                  style={[styles.modeSegmentText, { color: tc.brand }, calendarMode === 'Hosting' && { color: '#fff' }]}
                >
                  {t('ACTIVITY_FILTER_HOSTING')}
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              disabled={weekOffset >= 2}
              onPress={() => setWeekOffset((w) => (w >= 2 ? w : w + 1))}
              style={[styles.weekNavBtn, { backgroundColor: tc.bgElevated }, weekOffset >= 2 && styles.weekNavBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={[styles.weekNavIcon, { tintColor: tc.textPrimary }]} />
            </TouchableOpacity>
          </View>
          
          <View style={styles.calendar}>
            {weekDays.map((dayInfo, index) => (
              <View key={index} style={[styles.dayContainer, dayInfo.isToday && styles.todayContainer]}>
                <View style={[styles.dayHeader, dayInfo.isToday && styles.todayHeader]}>
                  <Text style={[styles.dateText, { color: dayInfo.isToday ? COLORS.neutral900 : tc.textPrimary }]}>{dayInfo.dateNumber}</Text>
                  <Text style={[styles.dayText, { color: dayInfo.isToday ? COLORS.neutral900 : tc.textPrimary }]}>{dayInfo.dayLetter}</Text>
                </View>
                <View style={styles.calendarDaySeparator} />
                <View style={styles.bookingsContainer}>
                  {activeData
                    .filter(item => item.date === dayInfo.fullDate)
                    .map((booking, idx) => (
                      <TouchableOpacity
                        key={booking.id}
                        onPress={() =>
                          setSelectedActivity((prev) => (prev?.id === booking.id ? null : booking))
                        }
                      >
                        <Image
                          source={ICONS[booking.type]}
                          style={[styles.bookingIcon, isFadedStatus(booking.status) && styles.fadedIcon]}
                        />
                      </TouchableOpacity>
                    ))}
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={[styles.upcomingSection, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}>
          <View style={styles.upcomingHeader}>
            <Text style={[styles.subHeader, { color: tc.textPrimary }]}>{t('ACTIVITY_SUB_SELECTED_RECORD')}</Text>
          </View>
          {selectedActivity ? (
            renderRecord(selectedActivity)
          ) : (
            <View style={{ paddingVertical: 6 }}>
              <Text style={{ color: tc.textSecondary }}>{t('ACTIVITY_LABEL_TAP_ICON')}</Text>
            </View>
          )}
        </View>

        <View style={[styles.activityRecordsContainer, { backgroundColor: tc.bgSurface }]}>
          <Text style={[styles.subHeader, { color: tc.textPrimary }]}>{t('ACTIVITY_SUB_ACTIVITY_RECORDS')}</Text>

          <View style={styles.expandFiltersContainer}>
            <View style={styles.dropdownBarWrapper}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.dropdownBarRow}
              >
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setOpenFilter((v) => (v === 'status' ? null : 'status'))}
                  style={[styles.dropdownTrigger, { backgroundColor: tc.bgElevated, borderColor: tc.border }, openFilter === 'status' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={[styles.dropdownTriggerText, { color: tc.textPrimary }]}>{statusLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'status' && styles.dropdownCaretOpen, { tintColor: tc.textPrimary }]}
                    />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setOpenFilter((v) => (v === 'activity' ? null : 'activity'))}
                  style={[styles.dropdownTrigger, { backgroundColor: tc.bgElevated, borderColor: tc.border }, openFilter === 'activity' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={[styles.dropdownTriggerText, { color: tc.textPrimary }]}>{activityLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'activity' && styles.dropdownCaretOpen, { tintColor: tc.textPrimary }]}
                    />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setOpenFilter((v) => (v === 'type' ? null : 'type'))}
                  style={[styles.dropdownTrigger, { backgroundColor: tc.bgElevated, borderColor: tc.border }, openFilter === 'type' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={[styles.dropdownTriggerText, { color: tc.textPrimary }]}>{typeLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'type' && styles.dropdownCaretOpen, { tintColor: tc.textPrimary }]}
                    />
                  </View>
                </TouchableOpacity>
              </ScrollView>

              {openFilter !== null && (
                <View style={[styles.dropdownMenu, { backgroundColor: tc.bgElevated, borderColor: tc.border }]}>
                  {(openFilter === 'status'
                    ? (['All', 'Upcoming', 'Completed', 'Cancelled', 'Missed'] as const).map((opt) => ({
                        key: opt,
                        label: opt === 'All' ? t('COMMON_FILTER_ALL') :
                               opt === 'Upcoming' ? t('ACTIVITY_FILTER_UPCOMING') :
                               opt === 'Completed' ? t('ACTIVITY_FILTER_COMPLETED') :
                               opt === 'Cancelled' ? t('ACTIVITY_FILTER_CANCELLED') :
                               t('ACTIVITY_FILTER_MISSED'),
                        selected: statusFilter === opt,
                        onPress: () => {
                          setStatusFilter(opt);
                          setOpenFilter(null);
                        },
                      }))
                    : openFilter === 'activity'
                      ? (['All', 'Court', 'Event', 'TS'] as const).map((opt) => ({
                          key: opt,
                          label: opt === 'All' ? t('COMMON_FILTER_ALL') :
                                 opt === 'Court' ? t('COMMON_FILTER_COURT') :
                                 opt === 'Event' ? t('COMMON_FILTER_EVENT') :
                                 t('ACTIVITY_FILTER_TS'),
                          selected: activityKindFilter === opt,
                          onPress: () => {
                            setActivityKindFilter(opt);
                            setOpenFilter(null);
                          },
                        }))
                      : (['Booking', 'Hosting'] as const).map((opt) => ({
                          key: opt,
                          label: opt === 'Booking' ? t('ACTIVITY_FILTER_BOOKING') : t('ACTIVITY_FILTER_HOSTING'),
                          selected: calendarMode === opt,
                          onPress: () => {
                            setCalendarMode(opt);
                            setSelectedActivity(null);
                            setOpenFilter(null);
                          },
                        }))
                  ).map((row) => (
                    <Pressable
                      key={row.key}
                      onPress={row.onPress}
                      style={({ pressed }) => [
                        styles.dropdownItem,
                        row.selected && styles.dropdownItemSelected,
                        pressed && styles.dropdownItemPressed,
                      ]}
                    >
                      <Text style={[styles.dropdownItemText, { color: tc.textPrimary }]}>{row.label}</Text>
                      <View style={styles.tickBox}>
                        {row.selected ? <Text style={styles.tickText}>✓</Text> : null}
                      </View>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {openFilter !== null && (
              <Pressable style={styles.dropdownOverlay} onPress={() => setOpenFilter(null)} />
            )}
          </View>

          {filteredData.length === 0 ? (
            <View style={{ paddingVertical: 20 }}>
              <Text style={{ color: tc.textSecondary }}>{t('ACTIVITY_EMPTY_NO_RECORDS')}</Text>
            </View>
          ) : (
            filteredData.map((item) => <View key={item.id}>{renderRecord(item)}</View>)
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 14,
    backgroundColor: COLORS.neutral0,
  },
  headerSideSpacer: {
    width: 78,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.neutral300,
    marginBottom: 10,
  },
  calendarContainer: {
    padding: 20,
    backgroundColor: COLORS.white,
    marginBottom: 10,
  },
  calendar: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  dayContainer: {
    alignItems: "center",
    flex: 1,
  },
  todayContainer: {
    backgroundColor: COLORS.cyan50,
    borderRadius: 10,
    overflow: 'hidden',
  },
  dayHeader: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 6,
    minWidth: 34,
  },
  todayHeader: {
    backgroundColor: COLORS.cyan50,
  },
  dayText: {
    fontSize: 13,
    color: COLORS.neutral900,
  },
  dateText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.neutral975,
  },
  calendarDaySeparator: {
    height: 1,
    width: '80%',
    backgroundColor: COLORS.neutral425,
    marginVertical: 5,
  },
  bookingsContainer: {
    marginTop: 5,
    minHeight: 50,
  },
  bookingIcon: {
    width: 30,
    height: 30,
    marginVertical: 2,
  },
  fadedIcon: {
    opacity: 0.35,
  },
  activityRecordsContainer: {
    flex: 1,
    padding: 20,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    position: 'relative',
  },
  recordsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  subHeader: {
    fontSize: 15,
    fontWeight: '700',
  },
  monthHeader: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  viewAllText: {
    fontSize: 16,
    color: COLORS.bootstrapBlue,
    textDecorationLine: 'underline',
    fontStyle: 'italic',
  },
  eventItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 15,
    backgroundColor: COLORS.neutral125,
    borderRadius: 10,
    marginBottom: 10,
  },
  eventImage: {
    width: 50,
    height: 50,
    marginRight: 15,
  },
  eventDetails: {
    flex: 1,
  },
  eventTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.neutral975,
    flex: 1,
    flexShrink: 1,
    alignSelf: 'stretch',
  },
  eventTitlePrefix: {
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  eventMetaLine: {
    fontSize: 14,
    color: COLORS.neutral850,
    marginTop: 6,
  },
  eventMetaLabel: {
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  statusPill: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    alignSelf: 'flex-start',
  },
  statusText: {
    fontSize: 12,
    fontWeight: "bold",
    color: COLORS.white,
  },
  completed: {
    backgroundColor: '#22C55E',
  },
  upcoming: {
    backgroundColor: COLORS.bootstrapBlue,
  },
  cancelled: {
    backgroundColor: COLORS.danger,
  },
  missed: {
    backgroundColor: COLORS.neutral700,
  },
  calendarControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 10,
    gap: 10,
  },
  weekNavBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.neutral250,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekNavBtnDisabled: {
    opacity: 0.35,
  },
  weekNavIcon: {
    width: 20,
    height: 20,
    tintColor: COLORS.neutral925,
    resizeMode: 'contain',
  },
  modeSegmentContainer: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.gray200,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
  },
  modeSegment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeSegmentActive: {
    backgroundColor: COLORS.orange200,
  },
  modeSegmentText: {
    color: COLORS.neutral975,
    fontWeight: '700',
  },
  modeSegmentTextActive: {
    color: COLORS.brown900,
  },
  upcomingSection: {
    padding: 20,
    backgroundColor: COLORS.white,
    marginBottom: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.neutral425,
  },
  upcomingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  activityFilterContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 4,
    marginTop: 10,
    marginBottom: 6,
    backgroundColor: COLORS.neutral200,
    borderRadius: 12,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 999,
    marginHorizontal: 4,
  },
  activeFilterTab: {
    backgroundColor: COLORS.bootstrapBlue,
  },
  filterTabText: {
    fontSize: 14,
    color: COLORS.neutral925,
    fontWeight: '600',
  },
  activeFilterTabText: {
    color: COLORS.white,
  },

  expandFiltersContainer: {
    marginTop: 10,
    marginBottom: 10,
  },
  dropdownBarWrapper: {
    position: 'relative',
    zIndex: 50,
  },
  dropdownBarRow: {
    gap: 10,
    paddingVertical: 2,
    paddingRight: 2,
  },
  dropdownTrigger: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.neutral375,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minWidth: 130,
  },
  dropdownTriggerActive: {
    borderColor: COLORS.bootstrapBlue,
  },
  dropdownTriggerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  dropdownTriggerText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.neutral975,
    flexShrink: 1,
  },
  dropdownCaret: {
    width: 16,
    height: 16,
    tintColor: COLORS.neutral900,
    resizeMode: 'contain',
    transform: [{ rotate: '90deg' }],
  },
  dropdownCaretOpen: {
    transform: [{ rotate: '-90deg' }],
  },
  dropdownOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 40,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 52,
    left: 0,
    width: 240,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral375,
    overflow: 'hidden',
    elevation: 6,
    zIndex: 60,
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownItemPressed: {
    backgroundColor: COLORS.neutral150,
  },
  dropdownItemSelected: {
    backgroundColor: COLORS.neutral150,
  },
  dropdownItemText: {
    fontSize: 14,
    color: COLORS.neutral975,
    fontWeight: '700',
  },
  tickBox: {
    width: 18,
    alignItems: 'flex-end',
  },
  tickText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  expandFilterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: COLORS.neutral200,
    borderRadius: 12,
  },
  expandFilterLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  expandFilterRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  expandChevron: {
    width: 16,
    height: 16,
    tintColor: COLORS.neutral925,
    resizeMode: 'contain',
    transform: [{ rotate: '0deg' }],
  },
  selectedChip: {
    backgroundColor: COLORS.neutral340,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  selectedChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.neutral975,
  },
  expandOptionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 4,
    marginTop: 10,
  },
  optionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.neutral200,
  },
  optionChipActive: {
    backgroundColor: COLORS.bootstrapBlue,
  },
  optionChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.neutral925,
  },
  optionChipTextActive: {
    color: COLORS.white,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: COLORS.danger,
  },
  cancelBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  reviewBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: COLORS.bootstrapBlue,
  },
  reviewBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  btnDisabled: {
    opacity: 0.35,
  },
  btnTextDisabled: {
    color: COLORS.white,
  },
  cancelModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  cancelModalBox: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
  },
  cancelModalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.neutral975,
    marginBottom: 8,
  },
  cancelModalBody: {
    fontSize: 14,
    color: COLORS.neutral700,
    marginBottom: 20,
    lineHeight: 20,
  },
  cancelModalBtns: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelModalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelModalKeepBtn: {
    backgroundColor: COLORS.neutral250,
  },
  cancelModalKeepText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.neutral900,
  },
  cancelModalConfirmBtn: {
    backgroundColor: COLORS.danger,
  },
  cancelModalConfirmText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
});
