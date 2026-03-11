import {
  getCourtBookingsByUserId,
  getEventBookingsByUserId,
  getTrainingSessionBookingsByUserId,
  invalidateEventsCombinedCache,
  invalidateTrainingSessionsCombinedCache,
  listCourtAvailabilityAll,
  listCourtInfoCached,
  listEventsCombinedCached,
  listEventsCombinedByOrganizerId,
  listTrainingSessionsCombinedCached,
  listTrainingSessionsCombinedByCoachId,
} from "@/lib/backendApi";
import { useUserId } from "@/hooks/use-user-id";
import { queryKeys } from "@/hooks/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ICONS } from "@/constants/icons";
import { COLORS } from "@/constants/colors";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { SkeletonBox, SkeletonPulse } from "@/components/ui/skeleton";
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Type definition for Unified Booking
type UnifiedBooking = {
  id: string; // Unique identifier for each booking
  title: string;
  status: "Completed" | "Upcoming" | "Cancelled"; // Status of the booking
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

const formatDateWeekdayDDMMYYYY = (dt: Date) => {
  if (Number.isNaN(dt.getTime())) return '';
  const wd = dt.toLocaleDateString(undefined, { weekday: 'short' });
  const dd = pad2(dt.getDate());
  const mm = pad2(dt.getMonth() + 1);
  const yyyy = dt.getFullYear();
  return `${wd} ${dd}-${mm}-${yyyy}`;
};

const formatTimeHHMM = (dt: Date) => {
  if (Number.isNaN(dt.getTime())) return '';
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
};

const normalizeStatusLoose = (statusRaw: any, dateTime?: Date): UnifiedBooking["status"] => {
  const pick = (raw: any): UnifiedBooking["status"] | null => {
    if (typeof raw !== 'string') return null;
    const s = raw.toLowerCase();
    if (s.includes('cancel')) return 'Cancelled';
    if (s.includes('complete')) return 'Completed';
    if (s.includes('upcoming')) return 'Upcoming';
    return null;
  };

  const picked = pick(statusRaw);
  const isPast = !!(dateTime && !Number.isNaN(dateTime.getTime()) && dateTime.getTime() < Date.now());

  // Authoritative rule: past => Completed (unless Cancelled)
  if (isPast) return picked === 'Cancelled' ? 'Cancelled' : 'Completed';

  if (picked) return picked;
  return 'Upcoming';
};

// Merge all bookings into a unified list
const mergeBookings = (params: {
  courtBookings: any[]
  eventBookings: any[]
  trainingSessionBookings: any[]
  eventsById: Map<number, any>
  sessionsById: Map<number, any>
  courtNameByAvailabilityId: Map<number, string>
}): UnifiedBooking[] => {
  const courtBookings = Array.isArray(params.courtBookings) ? params.courtBookings : [];
  const eventBookings = Array.isArray(params.eventBookings) ? params.eventBookings : [];
  const trainingSessionBookings = Array.isArray(params.trainingSessionBookings) ? params.trainingSessionBookings : [];

  const normalizeStatus = (bookingStatusRaw: any, statusRaw?: any, dateTime?: Date): UnifiedBooking["status"] => {
    const pick = (raw: any): UnifiedBooking["status"] | null => {
      if (typeof raw !== 'string') return null;
      const s = raw.toLowerCase();
      if (s.includes('cancel')) return 'Cancelled';
      if (s.includes('complete')) return 'Completed';
      if (s.includes('upcoming')) return 'Upcoming';
      return null;
    };

    const fromBookingStatus = pick(bookingStatusRaw);
    const fromStatus = pick(statusRaw);
    const isPast = !!(dateTime && !Number.isNaN(dateTime.getTime()) && dateTime.getTime() < Date.now());
    const isCancelled = fromBookingStatus === 'Cancelled' || fromStatus === 'Cancelled';

    // Authoritative rule: past => Completed (unless Cancelled)
    if (isPast) return isCancelled ? 'Cancelled' : 'Completed';

    if (isCancelled) return 'Cancelled';

    // Source of truth: bookingstatus column (upcoming/completed/cancelled)
    if (fromBookingStatus) return fromBookingStatus;

    // Backward-compatible fallback
    if (fromStatus) return fromStatus;

    return 'Upcoming';
  };

  const safeIsoDate = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '');
  const safeTime = (ts?: string | null) => (typeof ts === 'string' && ts.length >= 16 ? ts.slice(11, 16) : '');

  const allBookings = [
    ...courtBookings.map((item) => {
      const startTs = item.start_timestamp as string | undefined;
      const endTs = item.end_timestamp as string | undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      const availabilityId = typeof item.availabilityid === 'number' ? item.availabilityid : NaN;
      const courtName = Number.isFinite(availabilityId)
        ? params.courtNameByAvailabilityId.get(availabilityId)
        : undefined;
      return {
        id: `court_${item.courtbookingid}`,
        title: courtName || `Court Booking #${item.courtbookingid}`,
        status: normalizeStatus(item.bookingstatus, item.status, dateTime),
        mode: 'Booking',
        activity: 'court',
        type: 'stadiumCal' as keyof typeof ICONS,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
      } satisfies UnifiedBooking;
    }),
    ...eventBookings.map((item) => {
      const eventId = typeof item.eventid === 'number' ? item.eventid : NaN;
      const ev = Number.isFinite(eventId) ? params.eventsById.get(eventId) : undefined;
      const startTs = (ev?.start_timestamp as string | undefined) ?? (ev?.time as string | undefined) ?? undefined;
      const endTs = (ev?.end_timestamp as string | undefined) ?? undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      return {
        id: `event_${item.eventbookingid}`,
        title: (ev?.title as string | undefined) || `Event #${item.eventid}`,
        status: normalizeStatus(item.bookingstatus, item.status, dateTime),
        mode: 'Booking',
        activity: 'event',
        type: 'starCal' as keyof typeof ICONS,
        courtName: (ev as any)?.court_name ?? null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
      } satisfies UnifiedBooking;
    }),
    ...trainingSessionBookings.map((item) => {
      const sessionId = typeof item.sessionid === 'number' ? item.sessionid : NaN;
      const sess = Number.isFinite(sessionId) ? params.sessionsById.get(sessionId) : undefined;
      const startTs = (sess?.start_timestamp as string | undefined) ?? (sess?.time as string | undefined) ?? undefined;
      const endTs = (sess?.end_timestamp as string | undefined) ?? undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      return {
        id: `session_${item.tsbookingid}`,
        title: (sess?.title as string | undefined) || `Training Session #${item.sessionid}`,
        status: normalizeStatus(item.bookingstatus, item.status, dateTime),
        mode: 'Booking',
        activity: 'session',
        type: 'coachCal' as keyof typeof ICONS,
        courtName: (sess as any)?.court_name ?? null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime: dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
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
        title: (ev?.title as string | undefined) || `Event #${ev?.eventid}`,
        status: normalizeStatusLoose(ev?.status, dateTime),
        mode: 'Hosting',
        activity: 'event',
        type: 'starCal' as keyof typeof ICONS,
        courtName: (ev as any)?.court_name ?? null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
      } satisfies UnifiedBooking;
    }),
    ...createdSessions.map((s) => {
      const startTs = (s?.start_timestamp as string | undefined) ?? (s?.time as string | undefined) ?? undefined;
      const endTs = (s?.end_timestamp as string | undefined) ?? undefined;
      const dateTime = parseTimestampLoose(startTs ?? null);
      return {
        id: `created_session_${s?.sessionid}`,
        title: (s?.title as string | undefined) || `Training Session #${s?.sessionid}`,
        status: normalizeStatusLoose(s?.status, dateTime),
        mode: 'Hosting',
        activity: 'session',
        type: 'coachCal' as keyof typeof ICONS,
        courtName: (s as any)?.court_name ?? null,
        date: safeIsoDate(startTs),
        time: safeTime(startTs),
        day: startTs ? getDayOfWeek(startTs) : '',
        dateTime,
        startTimestamp: startTs ?? null,
        endTimestamp: endTs ?? null,
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

const getWeekDaysForOffset = (weekOffset: number) => {
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
      dayLetter: ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i],
      dateNumber: date.getDate(),
      fullDate: toDateStringLocal(date),
      isToday: date.toDateString() === today.toDateString(),
    });
  }

  return days;
};

export default function ActivityPage() {
  const [calendarMode, setCalendarMode] = useState<"Booking" | "Hosting">("Booking");
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedActivity, setSelectedActivity] = useState<UnifiedBooking | null>(null);
  const [statusFilter, setStatusFilter] = useState<"All" | "Upcoming" | "Completed" | "Cancelled">("All");
  const [activityKindFilter, setActivityKindFilter] = useState<"All" | "Court" | "Event" | "TS">("All");
  const [openFilter, setOpenFilter] = useState<null | 'status' | 'activity' | 'type'>(null);
  const [refreshing, setRefreshing] = useState(false);

  const statusLabel = statusFilter === 'All' ? 'Status' : statusFilter;
  const activityLabel = activityKindFilter === 'All' ? 'Activity' : activityKindFilter;
  const typeLabel = calendarMode;
  
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: userId, isLoading: userIdLoading, error: userIdError } = useUserId();

  const onPullToRefresh = useCallback(async () => {
    if (typeof userId !== 'number') return;
    setRefreshing(true);
    try {
      // Bust combined-list caches so refetch returns fresh.
      await Promise.all([
        invalidateEventsCombinedCache(),
        invalidateTrainingSessionsCombinedCache(),
      ]);

      // Refetch booking + enrichment queries.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['courtBookings', userId] }),
        queryClient.refetchQueries({ queryKey: ['eventBookings', userId] }),
        queryClient.refetchQueries({ queryKey: ['trainingSessionBookings', userId] }),
        queryClient.refetchQueries({ queryKey: queryKeys.eventsCombined }),
        queryClient.refetchQueries({ queryKey: queryKeys.trainingSessionsCombined }),
        queryClient.refetchQueries({ queryKey: ['courtAvailabilityAll'] }),
        queryClient.refetchQueries({ queryKey: ['courtInfoAll'] }),
        // Hosting-mode queries (safe to call; refetches only if query exists)
        queryClient.refetchQueries({ queryKey: ['createdEventsCombined', userId] }),
        queryClient.refetchQueries({ queryKey: ['createdTrainingSessionsCombined', userId] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, userId]);

  // Ensure bookings refresh when returning to this tab after creating a booking.
  useFocusEffect(
    useCallback(() => {
      if (typeof userId !== 'number') return;
      queryClient.invalidateQueries({ queryKey: ['courtBookings', userId] });
      queryClient.invalidateQueries({ queryKey: ['eventBookings', userId] });
      queryClient.invalidateQueries({ queryKey: ['trainingSessionBookings', userId] });

      // Make Activity feel "sensitive": bust combined-list AsyncStorage caches and refetch
      // so status/participant changes show up immediately when coming back.
      void invalidateEventsCombinedCache();
      void invalidateTrainingSessionsCombinedCache();
      queryClient.invalidateQueries({ queryKey: queryKeys.eventsCombined });
      queryClient.invalidateQueries({ queryKey: queryKeys.trainingSessionsCombined });

      // Refresh Hosting mode data as well.
	  queryClient.invalidateQueries({ queryKey: ['createdEventsCombined', userId] });
	  queryClient.invalidateQueries({ queryKey: ['createdTrainingSessionsCombined', userId] });
    }, [queryClient, userId])
  );

  const { data: courtBookingsRaw, isLoading: courtLoading, error: courtError } = useQuery({
    queryKey: ["courtBookings", userId],
    queryFn: () => getCourtBookingsByUserId(userId as number),
    enabled: typeof userId === 'number',
  });

  const { data: eventBookingsRaw, isLoading: eventLoading, error: eventError } = useQuery({
    queryKey: ["eventBookings", userId],
    queryFn: () => getEventBookingsByUserId(userId as number),
    enabled: typeof userId === 'number',
  });

  const { data: trainingSessionBookingsRaw, isLoading: trainingLoading, error: trainingError } = useQuery({
    queryKey: ["trainingSessionBookings", userId],
    queryFn: () => getTrainingSessionBookingsByUserId(userId as number),
    enabled: typeof userId === 'number',
  });

  const { data: createdEventsCombinedRaw, isLoading: createdEventsLoading, error: createdEventsError } = useQuery({
    queryKey: ["createdEventsCombined", userId],
    queryFn: () => listEventsCombinedByOrganizerId(userId as number),
    enabled: calendarMode === 'Hosting' && typeof userId === 'number',
    staleTime: 0,
  });

  const { data: createdTrainingSessionsCombinedRaw, isLoading: createdSessionsLoading, error: createdSessionsError } = useQuery({
    queryKey: ["createdTrainingSessionsCombined", userId],
    queryFn: () => listTrainingSessionsCombinedByCoachId(userId as number),
    enabled: calendarMode === 'Hosting' && typeof userId === 'number',
    staleTime: 0,
  });

  const courtBookingsData = useMemo(() => (Array.isArray(courtBookingsRaw) ? courtBookingsRaw : []), [courtBookingsRaw]);
  const eventBookingsData = useMemo(() => (Array.isArray(eventBookingsRaw) ? eventBookingsRaw : []), [eventBookingsRaw]);
  const trainingSessionBookingsData = useMemo(
    () => (Array.isArray(trainingSessionBookingsRaw) ? trainingSessionBookingsRaw : []),
    [trainingSessionBookingsRaw]
  );

  const { data: eventsCombinedRaw } = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    enabled: eventBookingsData.length > 0,
    staleTime: 0,
  });

  const { data: sessionsCombinedRaw } = useQuery({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombinedCached(),
    enabled: trainingSessionBookingsData.length > 0,
    staleTime: 0,
  });

  const { data: courtAvailabilityRaw } = useQuery({
    queryKey: ["courtAvailabilityAll"],
    queryFn: () => listCourtAvailabilityAll(),
    enabled: courtBookingsData.length > 0,
    staleTime: 5 * 60_000,
  });

  const { data: courtInfoRaw } = useQuery({
    queryKey: ["courtInfoAll"],
    queryFn: () => listCourtInfoCached(),
    enabled: courtBookingsData.length > 0,
    staleTime: 5 * 60_000,
  });

  const eventsById = useMemo(() => {
    const m = new Map<number, any>();
    if (Array.isArray(eventsCombinedRaw)) {
      for (const e of eventsCombinedRaw) {
        if (typeof e?.eventid === 'number') m.set(e.eventid, e);
      }
    }
    return m;
  }, [eventsCombinedRaw]);

  const sessionsById = useMemo(() => {
    const m = new Map<number, any>();
    if (Array.isArray(sessionsCombinedRaw)) {
      for (const s of sessionsCombinedRaw) {
        if (typeof s?.sessionid === 'number') m.set(s.sessionid, s);
      }
    }
    return m;
  }, [sessionsCombinedRaw]);

  const courtNameByAvailabilityId = useMemo(() => {
    const availabilityById = new Map<number, any>();
    if (Array.isArray(courtAvailabilityRaw)) {
      for (const a of courtAvailabilityRaw) {
        if (typeof a?.availabilityid === 'number') availabilityById.set(a.availabilityid, a);
      }
    }
    const courtInfoByCourtId = new Map<number, any>();
    if (Array.isArray(courtInfoRaw)) {
      for (const ci of courtInfoRaw) {
        if (typeof ci?.courtid === 'number') courtInfoByCourtId.set(ci.courtid, ci);
      }
    }
    const out = new Map<number, string>();
    for (const booking of courtBookingsData) {
      const availabilityId = booking?.availabilityid;
      if (typeof availabilityId !== 'number') continue;
      const av = availabilityById.get(availabilityId);
      const courtid = av?.courtid;
      const name = typeof courtid === 'number' ? (courtInfoByCourtId.get(courtid)?.name as string | undefined) : undefined;
      if (name) out.set(availabilityId, name);
    }
    return out;
  }, [courtAvailabilityRaw, courtInfoRaw, courtBookingsData]);

  const data = useMemo(
    () =>
      mergeBookings({
        courtBookings: courtBookingsData,
        eventBookings: eventBookingsData,
        trainingSessionBookings: trainingSessionBookingsData,
        eventsById,
        sessionsById,
        courtNameByAvailabilityId,
      }),
    [courtBookingsData, eventBookingsData, trainingSessionBookingsData, eventsById, sessionsById, courtNameByAvailabilityId]
  );

  const hostingData = useMemo(
    () =>
      mergeHosting({
        createdEvents: createdEventsCombinedRaw as any,
        createdSessions: createdTrainingSessionsCombinedRaw as any,
      }),
    [createdEventsCombinedRaw, createdTrainingSessionsCombinedRaw]
  );

  const activeData = calendarMode === 'Hosting' ? hostingData : data;
  
  const weekDays = useMemo(() => getWeekDaysForOffset(weekOffset), [weekOffset]);

  const monthLabel = useMemo(() => {
    if (!weekDays.length) return '';
    const start = parseIsoDateLocal(weekDays[0].fullDate);
    const end = parseIsoDateLocal(weekDays[weekDays.length - 1].fullDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

    const startMonth = start.toLocaleString(undefined, { month: 'long' });
    const endMonth = end.toLocaleString(undefined, { month: 'long' });
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();

    if (start.getMonth() === end.getMonth() && startYear === endYear) {
      return start.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    }
    if (startYear === endYear) {
      return `${startMonth} - ${endMonth} ${startYear}`;
    }
    return `${startMonth} ${startYear} - ${endMonth} ${endYear}`;
  }, [weekDays]);

  const isLoading =
    userIdLoading ||
    (calendarMode === 'Hosting'
      ? (createdEventsLoading || createdSessionsLoading)
      : (courtLoading || eventLoading || trainingLoading));

  const getStatusStyle = (status: "Completed" | "Upcoming" | "Cancelled") => {
    switch (status) {
      case "Completed": return styles.completed;
      case "Upcoming": return styles.upcoming;
      case "Cancelled": return styles.cancelled;
      default: return {};
    }
  };

  const isFadedStatus = (status: UnifiedBooking["status"]) => status === 'Cancelled' || status === 'Completed';

  const recordTitlePrefix = (activity: UnifiedBooking['activity']): string => {
    if (activity === 'court') return 'Court';
    if (activity === 'event') return 'Event';
    return 'Training';
  };

  const renderRecord = (item: UnifiedBooking) => (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() =>
        router.push({
          pathname: "/event/details",
          params: { id: item.id },
        })
      }
      style={styles.eventItem}
    >
      <Image
        source={ICONS[item.type]}
        style={[
          styles.eventImage,
          { tintColor: ICONS[item.type]?.color },
        ]}
      />
      <View style={styles.eventDetails}>
        <Text style={styles.eventTitle} numberOfLines={2}>
          <Text style={styles.eventTitlePrefix}>{recordTitlePrefix(item.activity)}: </Text>
          {item.title}
        </Text>

        <View style={{ marginTop: 8 }}>
          <View style={[styles.statusPill, getStatusStyle(item.status)]}>
            <Text style={styles.statusText}>{item.status}</Text>
          </View>
        </View>

        <Text style={styles.eventMetaLine}>
          <Text style={styles.eventMetaLabel}>Date:</Text> {formatDateWeekdayDDMMYYYY(item.dateTime) || 'Unknown'}
        </Text>

        <Text style={styles.eventMetaLine}>
          <Text style={styles.eventMetaLabel}>Time:</Text>{" "}
          {(() => {
            const start = parseTimestampLoose(item.startTimestamp ?? null);
            const end = parseTimestampLoose(item.endTimestamp ?? null);
            const startText = formatTimeHHMM(start);
            const endText = formatTimeHHMM(end);
            if (startText && endText) return `${startText} - ${endText}`;
            if (startText) return startText;
            return 'Unknown';
          })()}
        </Text>

        {item.activity !== 'court' && (
          <Text style={styles.eventMetaLine}>
            <Text style={styles.eventMetaLabel}>Court:</Text> {item.courtName || 'Unknown'}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );

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
      <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.neutral75 }}>
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
      <SafeAreaView style={{ flex: 1, padding: 20, backgroundColor: COLORS.neutral75, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={styles.headerTitle}>Activity</Text>
        <Text style={{ marginTop: 10, color: COLORS.neutral850, textAlign: 'center' }}>
          Please log in to view your activity.
        </Text>
      </SafeAreaView>
    );
  }

  const loadError = userIdError ||
    (calendarMode === 'Hosting'
      ? (createdEventsError || createdSessionsError)
      : (courtError || eventError || trainingError));
  if (loadError) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 20, backgroundColor: COLORS.neutral75 }}>
        <Text style={styles.headerTitle}>Activity</Text>
        <Text style={{ marginTop: 10, color: COLORS.danger }}>
          Failed to load activity records. Check Metro logs for request details.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.neutral75 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Activity</Text>
        <TouchableOpacity style={styles.historyButton} onPress={() => router.push("/event/history")}>
          <View style={styles.historyButtonContainer}>
            <Image source={ICONS.clock} style={styles.historyIcon} />
            <Text style={styles.historyText}>History</Text>
          </View>
        </TouchableOpacity>
      </View>

      <View style={styles.divider} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullToRefresh} />}
      >
        <View style={styles.calendarContainer}>
          <Text style={styles.monthHeader}>{monthLabel || 'Calendar'}</Text>
          <View style={styles.calendarControlsRow}>
            <TouchableOpacity
              disabled={weekOffset <= -2}
              onPress={() => setWeekOffset((w) => (w <= -2 ? w : w - 1))}
              style={[styles.weekNavBtn, weekOffset <= -2 && styles.weekNavBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={[styles.weekNavIcon, { transform: [{ rotate: '180deg' }] }]} />
            </TouchableOpacity>

            <View style={styles.modeSegmentContainer}>
              <TouchableOpacity
                onPress={() => {
                  setCalendarMode('Booking');
                  setSelectedActivity(null);
                }}
                style={[styles.modeSegment, calendarMode === 'Booking' && styles.modeSegmentActive]}
              >
                <Text
                  style={[styles.modeSegmentText, calendarMode === 'Booking' && styles.modeSegmentTextActive]}
                >
                  Booking
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setCalendarMode('Hosting');
                  setSelectedActivity(null);
                }}
                style={[styles.modeSegment, calendarMode === 'Hosting' && styles.modeSegmentActive]}
              >
                <Text
                  style={[styles.modeSegmentText, calendarMode === 'Hosting' && styles.modeSegmentTextActive]}
                >
                  Hosting
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              disabled={weekOffset >= 2}
              onPress={() => setWeekOffset((w) => (w >= 2 ? w : w + 1))}
              style={[styles.weekNavBtn, weekOffset >= 2 && styles.weekNavBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={styles.weekNavIcon} />
            </TouchableOpacity>
          </View>
          
          <View style={styles.calendar}>
            {weekDays.map((dayInfo, index) => (
              <View key={index} style={[styles.dayContainer, dayInfo.isToday && styles.todayContainer]}>
                <View style={[styles.dayHeader, dayInfo.isToday && styles.todayHeader]}>
                  <Text style={styles.dateText}>{dayInfo.dateNumber}</Text>
                  <Text style={styles.dayText}>{dayInfo.dayLetter}</Text>
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

        <View style={styles.upcomingSection}>
          <View style={styles.upcomingHeader}>
            <Text style={styles.subHeader}>Selected Record</Text>
          </View>
          {selectedActivity ? (
            renderRecord(selectedActivity)
          ) : (
            <View style={{ paddingVertical: 6 }}>
              <Text style={{ color: COLORS.neutral850 }}>Tap an icon to preview.</Text>
            </View>
          )}
        </View>

        <View style={styles.activityRecordsContainer}>
          <Text style={styles.subHeader}>Activity Records</Text>

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
                  style={[styles.dropdownTrigger, openFilter === 'status' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={styles.dropdownTriggerText}>{statusLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'status' && styles.dropdownCaretOpen]}
                    />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setOpenFilter((v) => (v === 'activity' ? null : 'activity'))}
                  style={[styles.dropdownTrigger, openFilter === 'activity' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={styles.dropdownTriggerText}>{activityLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'activity' && styles.dropdownCaretOpen]}
                    />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setOpenFilter((v) => (v === 'type' ? null : 'type'))}
                  style={[styles.dropdownTrigger, openFilter === 'type' && styles.dropdownTriggerActive]}
                >
                  <View style={styles.dropdownTriggerContent}>
                    <Text style={styles.dropdownTriggerText}>{typeLabel}</Text>
                    <Image
                      source={ICONS.arrowright}
                      style={[styles.dropdownCaret, openFilter === 'type' && styles.dropdownCaretOpen]}
                    />
                  </View>
                </TouchableOpacity>
              </ScrollView>

              {openFilter !== null && (
                <View style={styles.dropdownMenu}>
                  {(openFilter === 'status'
                    ? (['All', 'Upcoming', 'Completed', 'Cancelled'] as const).map((opt) => ({
                        key: opt,
                        label: opt,
                        selected: statusFilter === opt,
                        onPress: () => {
                          setStatusFilter(opt);
                          setOpenFilter(null);
                        },
                      }))
                    : openFilter === 'activity'
                      ? (['All', 'Court', 'Event', 'TS'] as const).map((opt) => ({
                          key: opt,
                          label: opt,
                          selected: activityKindFilter === opt,
                          onPress: () => {
                            setActivityKindFilter(opt);
                            setOpenFilter(null);
                          },
                        }))
                      : (['Booking', 'Hosting'] as const).map((opt) => ({
                          key: opt,
                          label: opt,
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
                      <Text style={styles.dropdownItemText}>{row.label}</Text>
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
              <Text style={{ color: COLORS.neutral850 }}>No activity records found.</Text>
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
    padding: 20,
    backgroundColor: COLORS.neutral200,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
  },
  historyButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,
  },
  historyButtonContainer: {
    backgroundColor: COLORS.darkGray,
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 30,
    flexDirection: "row",
    alignItems: "center",
  },
  historyIcon: {
    width: 18,
    height: 18,
    marginRight: 5,
    tintColor: COLORS.white,
  },
  historyText: {
    fontSize: 16,
    color: COLORS.white,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.neutral425,
    marginVertical: 10,
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
    fontSize: 18,
    fontWeight: "bold",
  },
  monthHeader: {
    fontSize: 22,
    fontWeight: '800',
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
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.neutral975,
    flex: 1,
    flexShrink: 1,
    alignSelf: 'stretch',
  },
  eventTitlePrefix: {
    fontWeight: '900',
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
    fontWeight: '900',
    color: COLORS.neutral975,
  },
  statusPill: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "bold",
    color: COLORS.white,
  },
  completed: {
    backgroundColor: COLORS.success,
  },
  upcoming: {
    backgroundColor: COLORS.bootstrapBlue,
  },
  cancelled: {
    backgroundColor: COLORS.danger,
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
    fontSize: 16,
    fontWeight: '900',
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
    fontWeight: '800',
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
});
