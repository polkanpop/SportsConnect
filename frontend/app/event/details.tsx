import React, { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { queryKeys } from '@/hooks/query-keys'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { appendHistory } from '@/storage/history'
import {
  adjustEventParticipants,
  adjustTrainingSessionParticipants,
  getCourtBooking,
  getCourt,
  getCourtAvailabilityById,
  listCourtInfo,
  getEventBooking,
  getEventInfoByEventId,
  getTrainingSession,
  getTrainingSessionBooking,
  getTrainingSessionInfoBySessionId,
  getEvent,
  invalidateEventsCombinedCache,
  invalidateTrainingSessionsCombinedCache,
  updateCourtBooking,
  updateEvent,
  updateEventBooking,
  updateTrainingSession,
  updateTrainingSessionBooking,
} from '@/lib/backendApi'

type ParsedId =
  | { kind: 'court_booking'; id: number; raw: string }
  | { kind: 'event_booking'; id: number; raw: string }
  | { kind: 'session_booking'; id: number; raw: string }
  | { kind: 'created_event'; id: number; raw: string }
  | { kind: 'created_session'; id: number; raw: string }
  | { kind: 'unknown'; id: null; raw: string }

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)

const parseTimestampLoose = (ts?: string | null) => {
  if (!ts || typeof ts !== 'string') return new Date(NaN)
  const normalized = ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts
  return new Date(normalized)
}

const formatDateWeekdayDDMMYYYY = (dt: Date) => {
  if (Number.isNaN(dt.getTime())) return 'Unknown'
  const wd = dt.toLocaleDateString(undefined, { weekday: 'short' })
  const dd = pad2(dt.getDate())
  const mm = pad2(dt.getMonth() + 1)
  const yyyy = dt.getFullYear()
  return `${wd} ${dd}-${mm}-${yyyy}`
}

const formatStatusTitleCase = (raw: any) => {
  if (typeof raw !== 'string') return 'Unknown'
  const s = raw.trim().toLowerCase()
  if (s.includes('cancel')) return 'Cancelled'
  if (s.includes('complete')) return 'Completed'
  if (s.includes('upcoming')) return 'Upcoming'
  // Fallback title-case first letter
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown'
}

const formatTimeHHMM = (dt: Date) => {
  if (Number.isNaN(dt.getTime())) return ''
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`
}

const formatEntryFee = (fee: any) => {
  const n = typeof fee === 'number' ? fee : (fee == null ? null : Number(fee))
  if (n == null || !Number.isFinite(n) || n <= 0) return 'Free'
  // Keep it simple: display as a number (existing app often uses raw numeric fee)
  return String(n)
}

const deriveBookingActionState = (
  bookingStatusRaw: any,
  sessionStatusRaw: any,
  dateTime?: Date,
): { reviewEnabled: boolean; cancelEnabled: boolean } => {
  const bs = String(bookingStatusRaw ?? '').trim().toLowerCase()
  const ss = String(sessionStatusRaw ?? '').trim().toLowerCase()
  const isPast = !!(dateTime && !Number.isNaN(dateTime.getTime()) && dateTime.getTime() < Date.now())
  const isApprovedOrJoined = bs === 'approved' || bs === 'joined'

  // C: rejected/cancelled -> both disabled
  if (bs === 'rejected' || bs.includes('cancel') || ss.includes('cancel')) {
    return { reviewEnabled: false, cancelEnabled: false }
  }

  // E: approved/joined and already in the past should behave like completed.
  if (isPast && isApprovedOrJoined) {
    return { reviewEnabled: true, cancelEnabled: false }
  }

  // Missed (D or F) -> both disabled
  if (ss === 'missed') {
    return { reviewEnabled: false, cancelEnabled: false }
  }

  // D: past + host ignored (pending) -> both disabled
  if (isPast && bs === 'pending') {
    return { reviewEnabled: false, cancelEnabled: false }
  }

  // E: completed -> review enabled, cancel disabled
  if (ss === 'completed' || ss === 'complete') {
    return { reviewEnabled: true, cancelEnabled: false }
  }

  // A/B: future + upcoming -> review disabled, cancel enabled
  if (!isPast) {
    return { reviewEnabled: false, cancelEnabled: true }
  }

  return { reviewEnabled: false, cancelEnabled: false }
}

const resolveVenueLabel = (row: any): string | null => {
  if (!row || typeof row !== 'object') return null
  return row.court_name || row.venue || row.address || null
}

const resolveVenueNameOnly = (row: any): string | null => {
  if (!row || typeof row !== 'object') return null
  const booking = (row as any)?.courtbooking
  const firstBooking = Array.isArray(booking) ? booking[0] : booking
  const availability = (firstBooking as any)?.courtavailability
  const firstAvailability = Array.isArray(availability) ? availability[0] : availability
  const courtsRel = (firstAvailability as any)?.courts
  const firstCourt = Array.isArray(courtsRel) ? courtsRel[0] : courtsRel
  const courtinfoRel = (firstCourt as any)?.courtinfo
  const firstCourtInfo = Array.isArray(courtinfoRel) ? courtinfoRel[0] : courtinfoRel
  return (
    (row as any)?.venue ||
    (firstCourtInfo as any)?.name ||
    (firstAvailability as any)?.venue ||
    (firstBooking as any)?.venue ||
    null
  )
}

const pickCourtid = (row: any): number | null => {
  if (!row || typeof row !== 'object') return null
  const direct = Number((row as any)?.courtid)
  if (Number.isFinite(direct)) return direct

  const availability = (row as any)?.courtavailability
  const firstAvailability = Array.isArray(availability) ? availability[0] : availability
  const availabilityCourtid = Number((firstAvailability as any)?.courtid)
  if (Number.isFinite(availabilityCourtid)) return availabilityCourtid

  const courtsRel = (firstAvailability as any)?.courts
  const firstCourt = Array.isArray(courtsRel) ? courtsRel[0] : courtsRel
  const courtCourtid = Number((firstCourt as any)?.courtid)
  if (Number.isFinite(courtCourtid)) return courtCourtid

  return null
}

function parseUnifiedId(rawId: string | undefined | null): ParsedId {
  const raw = String(rawId ?? '')
  const asNum = (v: string) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  if (raw.startsWith('court_')) {
    const id = asNum(raw.slice('court_'.length))
    return Number.isFinite(id) ? { kind: 'court_booking', id, raw } : { kind: 'unknown', id: null, raw }
  }
  if (raw.startsWith('event_')) {
    const id = asNum(raw.slice('event_'.length))
    return Number.isFinite(id) ? { kind: 'event_booking', id, raw } : { kind: 'unknown', id: null, raw }
  }
  if (raw.startsWith('session_')) {
    const id = asNum(raw.slice('session_'.length))
    return Number.isFinite(id) ? { kind: 'session_booking', id, raw } : { kind: 'unknown', id: null, raw }
  }
  if (raw.startsWith('created_event_')) {
    const id = asNum(raw.slice('created_event_'.length))
    return Number.isFinite(id) ? { kind: 'created_event', id, raw } : { kind: 'unknown', id: null, raw }
  }
  if (raw.startsWith('created_session_')) {
    const id = asNum(raw.slice('created_session_'.length))
    return Number.isFinite(id) ? { kind: 'created_session', id, raw } : { kind: 'unknown', id: null, raw }
  }
  return { kind: 'unknown', id: null, raw }
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionBody}>{children}</View>
  </View>
)

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <View style={styles.rowValueWrap}>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={styles.rowValueText}>{String(value)}</Text>
      ) : (
        value
      )}
    </View>
  </View>
)

export default function DetailsPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const parsed = useMemo(() => parseUnifiedId(id), [id])
  const {
    userId,
    dashboard,
    eventsCombined: bootstrapEventsCombined,
    trainingSessionsCombined: bootstrapSessionsCombined,
  } = useAppBootstrap()
  const [busy, setBusy] = useState(false)
  const [showCancelModal, setShowCancelModal] = useState(false)

  const [showResultModal, setShowResultModal] = useState(false)
  const [resultModalTitle, setResultModalTitle] = useState('')
  const [resultModalMessage, setResultModalMessage] = useState<string | null>(null)
  const [resultModalOnClose, setResultModalOnClose] = useState<(() => void) | null>(null)

  const closeResultModal = () => {
    setShowResultModal(false)
    const cb = resultModalOnClose
    setResultModalOnClose(null)
    if (cb) cb()
  }

  const openResultModal = (title: string, message?: string | null, onClose?: () => void) => {
    setResultModalTitle(title)
    setResultModalMessage(typeof message === 'string' ? message : null)
    setResultModalOnClose(typeof onClose === 'function' ? onClose : null)
    setShowResultModal(true)
  }

  const eventsCombinedList = useMemo(
    () => (Array.isArray(bootstrapEventsCombined) ? bootstrapEventsCombined : []),
    [bootstrapEventsCombined]
  )
  const sessionsCombinedList = useMemo(
    () => (Array.isArray(bootstrapSessionsCombined) ? bootstrapSessionsCombined : []),
    [bootstrapSessionsCombined]
  )
  const dashboardCourtBookings = useMemo(
    () => (Array.isArray(dashboard.data?.court_bookings) ? (dashboard.data?.court_bookings as any[]) : []),
    [dashboard.data?.court_bookings]
  )
  const dashboardEventBookings = useMemo(
    () => (Array.isArray(dashboard.data?.event_bookings) ? (dashboard.data?.event_bookings as any[]) : []),
    [dashboard.data?.event_bookings]
  )
  const dashboardSessionBookings = useMemo(
    () => (Array.isArray(dashboard.data?.training_bookings) ? (dashboard.data?.training_bookings as any[]) : []),
    [dashboard.data?.training_bookings]
  )

  const bootstrapCourtBooking = useMemo(() => {
    if (parsed.kind !== 'court_booking') return null
    return dashboardCourtBookings.find((x: any) => Number(x?.courtbookingid) === parsed.id) ?? null
  }, [parsed.kind, parsed.id, dashboardCourtBookings])

  const bootstrapEventBooking = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    return dashboardEventBookings.find((x: any) => Number(x?.eventbookingid) === parsed.id) ?? null
  }, [parsed.kind, parsed.id, dashboardEventBookings])

  const bootstrapSessionBooking = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    return dashboardSessionBookings.find((x: any) => Number(x?.tsbookingid) === parsed.id) ?? null
  }, [parsed.kind, parsed.id, dashboardSessionBookings])

  const courtBookingQuery = useQuery({
    queryKey: ['details', 'courtBooking', parsed.kind === 'court_booking' ? parsed.id : null],
    queryFn: () => getCourtBooking((parsed as any).id),
    enabled: parsed.kind === 'court_booking',
    initialData: parsed.kind === 'court_booking' ? (bootstrapCourtBooking as any) : undefined,
    staleTime: 60_000,
  })

  // Targeted 2-step lookup: availability → courtinfo (avoids bulk-list type-matching issues)
  const availabilityIdForCourt = useMemo(() => {
    if (parsed.kind !== 'court_booking') return null
    const raw = courtBookingQuery.data?.availabilityid
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }, [parsed.kind, courtBookingQuery.data?.availabilityid])

  const singleAvailQuery = useQuery({
    queryKey: ['courtavailability', 'single', availabilityIdForCourt],
    queryFn: () => getCourtAvailabilityById(availabilityIdForCourt!),
    enabled: availabilityIdForCourt != null,
    staleTime: 10 * 60_000,
  })

  const courtCourtId = useMemo(() => {
    const raw = singleAvailQuery.data?.courtid
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }, [singleAvailQuery.data?.courtid])

  const singleCourtQuery = useQuery({
    queryKey: ['courts', courtCourtId],
    queryFn: () => getCourt(courtCourtId!),
    enabled: courtCourtId != null,
    staleTime: 10 * 60_000,
  })

  const linkedEventsByCourtBookingQuery = {
    data: Array.isArray((courtBookingQuery.data as any)?.linked_events) ? (courtBookingQuery.data as any).linked_events : [],
    isLoading: false,
    isFetching: false,
    error: null,
  }
  const linkedSessionsByCourtBookingQuery = {
    data: Array.isArray((courtBookingQuery.data as any)?.linked_trainingsessions) ? (courtBookingQuery.data as any).linked_trainingsessions : [],
    isLoading: false,
    isFetching: false,
    error: null,
  }
  const eventBookingQuery = useQuery({
    queryKey: ['details', 'eventBooking', parsed.kind === 'event_booking' ? parsed.id : null],
    queryFn: () => getEventBooking((parsed as any).id),
    enabled: parsed.kind === 'event_booking',
    initialData: parsed.kind === 'event_booking' ? (bootstrapEventBooking as any) : undefined,
    staleTime: 60_000,
  })
  const sessionBookingQuery = useQuery({
    queryKey: ['details', 'sessionBooking', parsed.kind === 'session_booking' ? parsed.id : null],
    queryFn: () => getTrainingSessionBooking((parsed as any).id),
    enabled: parsed.kind === 'session_booking',
    initialData: parsed.kind === 'session_booking' ? (bootstrapSessionBooking as any) : undefined,
    staleTime: 60_000,
  })

  const eventIdForBooking = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    const raw = Number(eventBookingQuery.data?.eventid)
    return Number.isFinite(raw) ? raw : null
  }, [parsed.kind, eventBookingQuery.data?.eventid])

  const sessionIdForBooking = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    const raw = Number(sessionBookingQuery.data?.sessionid)
    return Number.isFinite(raw) ? raw : null
  }, [parsed.kind, sessionBookingQuery.data?.sessionid])

  const eventBookingEventQuery = useQuery({
    queryKey: ['details', 'eventBookingEvent', eventIdForBooking],
    queryFn: () => getEvent(eventIdForBooking!),
    enabled: eventIdForBooking != null,
    staleTime: 5 * 60_000,
  })

  const eventBookingInfoQuery = useQuery({
    queryKey: ['details', 'eventBookingInfo', eventIdForBooking],
    queryFn: () => getEventInfoByEventId(eventIdForBooking!),
    enabled: eventIdForBooking != null,
    staleTime: 5 * 60_000,
  })

  const sessionBookingSessionQuery = useQuery({
    queryKey: ['details', 'sessionBookingSession', sessionIdForBooking],
    queryFn: () => getTrainingSession(sessionIdForBooking!),
    enabled: sessionIdForBooking != null,
    staleTime: 5 * 60_000,
  })

  const sessionBookingInfoQuery = useQuery({
    queryKey: ['details', 'sessionBookingInfo', sessionIdForBooking],
    queryFn: () => getTrainingSessionInfoBySessionId(sessionIdForBooking!),
    enabled: sessionIdForBooking != null,
    staleTime: 5 * 60_000,
  })

  const eventRelatedCourtBookingId = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    const eventid = eventIdForBooking
    if (eventid == null) return null
    const ev = eventsCombinedList.find((x) => x.eventid === eventid) || eventBookingEventQuery.data
    const raw = (ev as any)?.courtbookingid
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }, [parsed.kind, eventIdForBooking, eventsCombinedList, eventBookingEventQuery.data])

  const eventCourtBookingQuery = useQuery({
    queryKey: ['details', 'eventBookingCourtBooking', eventRelatedCourtBookingId],
    queryFn: () => getCourtBooking(eventRelatedCourtBookingId!),
    enabled:
      eventRelatedCourtBookingId != null &&
      !dashboardCourtBookings.some((x: any) => Number(x?.courtbookingid) === Number(eventRelatedCourtBookingId)),
    staleTime: 60_000,
  })

  const eventCourtBooking = useMemo(() => {
    if (eventRelatedCourtBookingId == null) return null
    return (
      dashboardCourtBookings.find((x: any) => Number(x?.courtbookingid) === Number(eventRelatedCourtBookingId)) ||
      eventCourtBookingQuery.data ||
      null
    )
  }, [eventRelatedCourtBookingId, dashboardCourtBookings, eventCourtBookingQuery.data])

  const sessionRelatedCourtBookingId = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    const sessionid = sessionIdForBooking
    if (sessionid == null) return null
    const s = sessionsCombinedList.find((x) => x.sessionid === sessionid) || sessionBookingSessionQuery.data
    const raw = (s as any)?.courtbookingid
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }, [parsed.kind, sessionIdForBooking, sessionsCombinedList, sessionBookingSessionQuery.data])

  const sessionCourtBookingQuery = useQuery({
    queryKey: ['details', 'sessionBookingCourtBooking', sessionRelatedCourtBookingId],
    queryFn: () => getCourtBooking(sessionRelatedCourtBookingId!),
    enabled:
      sessionRelatedCourtBookingId != null &&
      !dashboardCourtBookings.some((x: any) => Number(x?.courtbookingid) === Number(sessionRelatedCourtBookingId)),
    staleTime: 60_000,
  })

  const sessionCourtBooking = useMemo(() => {
    if (sessionRelatedCourtBookingId == null) return null
    return (
      dashboardCourtBookings.find((x: any) => Number(x?.courtbookingid) === Number(sessionRelatedCourtBookingId)) ||
      sessionCourtBookingQuery.data ||
      null
    )
  }, [sessionRelatedCourtBookingId, dashboardCourtBookings, sessionCourtBookingQuery.data])

  const eventSummaryCourtid = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    const eventid = Number(eventBookingQuery.data?.eventid)
    const evCombined = Number.isFinite(eventid) ? eventsCombinedList.find((x) => x.eventid === eventid) : null
    const ev = evCombined || eventBookingEventQuery.data
    return pickCourtid(ev) ?? pickCourtid(eventCourtBooking)
  }, [parsed.kind, eventBookingQuery.data?.eventid, eventsCombinedList, eventBookingEventQuery.data, eventCourtBooking])

  const eventSummaryVenueInfoQuery = useQuery({
    queryKey: ['details', 'eventSummaryVenue', eventSummaryCourtid],
    queryFn: async () => {
      const rows = await listCourtInfo({ courtids: [eventSummaryCourtid!] })
      return Array.isArray(rows) && rows.length ? rows[0] : null
    },
    enabled: eventSummaryCourtid != null,
    staleTime: 10 * 60_000,
  })

  const sessionSummaryCourtid = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    const sessionid = Number(sessionBookingQuery.data?.sessionid)
    const sCombined = Number.isFinite(sessionid) ? sessionsCombinedList.find((x) => x.sessionid === sessionid) : null
    const s = sCombined || sessionBookingSessionQuery.data
    return pickCourtid(s) ?? pickCourtid(sessionCourtBooking)
  }, [parsed.kind, sessionBookingQuery.data?.sessionid, sessionsCombinedList, sessionBookingSessionQuery.data, sessionCourtBooking])

  const sessionSummaryVenueInfoQuery = useQuery({
    queryKey: ['details', 'sessionSummaryVenue', sessionSummaryCourtid],
    queryFn: async () => {
      const rows = await listCourtInfo({ courtids: [sessionSummaryCourtid!] })
      return Array.isArray(rows) && rows.length ? rows[0] : null
    },
    enabled: sessionSummaryCourtid != null,
    staleTime: 10 * 60_000,
  })

  const createdEventQuery = useQuery({
    queryKey: ['details', 'createdEvent', parsed.kind === 'created_event' ? parsed.id : null],
    queryFn: () => getEvent((parsed as any).id),
    enabled: parsed.kind === 'created_event',
  })
  const createdEventInfoQuery = useQuery({
    queryKey: ['details', 'createdEventInfo', parsed.kind === 'created_event' ? parsed.id : null],
    queryFn: () => getEventInfoByEventId((parsed as any).id),
    enabled: parsed.kind === 'created_event',
  })
  const createdSessionQuery = useQuery({
    queryKey: ['details', 'createdSession', parsed.kind === 'created_session' ? parsed.id : null],
    queryFn: () => getTrainingSession((parsed as any).id),
    enabled: parsed.kind === 'created_session',
  })
  const createdSessionInfoQuery = useQuery({
    queryKey: ['details', 'createdSessionInfo', parsed.kind === 'created_session' ? parsed.id : null],
    queryFn: () => getTrainingSessionInfoBySessionId((parsed as any).id),
    enabled: parsed.kind === 'created_session',
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (parsed.kind === 'court_booking') {
        return updateCourtBooking(parsed.id, { bookingstatus: 'cancelled' } as any)
      }
      if (parsed.kind === 'event_booking') {
    const evId = eventBookingQuery.data?.eventid
    const approveStatus = String((eventBookingQuery.data as any)?.status ?? '').toLowerCase()
    const wasApprovedJoin = approveStatus.includes('join') || approveStatus.includes('approve')
    const out = await updateEventBooking(parsed.id, { bookingstatus: 'cancelled' } as any)
    if (wasApprovedJoin && typeof evId === 'number') {
      try { await adjustEventParticipants(evId, -1) } catch {}
    }
    return out
      }
      if (parsed.kind === 'session_booking') {
    const sessionId = sessionBookingQuery.data?.sessionid
    const approveStatus = String((sessionBookingQuery.data as any)?.status ?? '').toLowerCase()
    const wasApprovedJoin = approveStatus.includes('join') || approveStatus.includes('approve')
    const out = await updateTrainingSessionBooking(parsed.id, { bookingstatus: 'cancelled' } as any)
    if (wasApprovedJoin && typeof sessionId === 'number') {
      try { await adjustTrainingSessionParticipants(sessionId, -1) } catch {}
    }
    return out
      }
      if (parsed.kind === 'created_event') {
        return updateEvent(parsed.id, { status: 'cancelled' } as any)
      }
      if (parsed.kind === 'created_session') {
        return updateTrainingSession(parsed.id, { status: 'cancelled' } as any)
      }
      throw new Error('Unsupported record type')
    },
    onMutate: async () => {
      type UndoItem = { key: readonly unknown[]; prev: any }
      const undo: UndoItem[] = []

      const save = (key: readonly unknown[]) => {
        undo.push({ key, prev: queryClient.getQueryData(key) })
      }

      const patchObject = (key: readonly unknown[], patch: any) => {
        queryClient.setQueryData(key, (prev: any) => ({ ...(prev || {}), ...patch }))
      }

      const patchList = <T extends { [k: string]: any }>(
        key: readonly unknown[],
        match: (row: T) => boolean,
        patch: Partial<T>
      ) => {
        queryClient.setQueryData(key, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (match(row) ? { ...row, ...patch } : row))
        })
      }

      if (parsed.kind === 'court_booking') {
        const detailKey = ['details', 'courtBooking', parsed.id] as const
        save(detailKey)
        patchObject(detailKey, { bookingstatus: 'cancelled' })

        const b: any = courtBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        if (typeof userid === 'number') {
          const k1 = ['courtBookings', userid] as const
          const k2 = ['courtbookings', 'user', userid] as const
          save(k1)
          save(k2)
          patchList(k1, (row: any) => row?.courtbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          patchList(k2, (row: any) => row?.courtbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
        }
      }

      // Best-effort local history log
      if (typeof userId === 'number') {
        const lower = (v: any) => String(v ?? '').trim().toLowerCase()

        const courtBooking: any = courtBookingQuery.data
        const eventBooking: any = eventBookingQuery.data
        const sessionBooking: any = sessionBookingQuery.data
        const createdEvent: any = createdEventQuery.data
        const createdSession: any = createdSessionQuery.data

        const title =
          parsed.kind === 'court_booking' ? 'Cancelled court booking' :
          parsed.kind === 'event_booking' ? 'Cancelled event booking' :
          parsed.kind === 'session_booking' ? 'Cancelled session booking' :
          parsed.kind === 'created_event' ? 'Cancelled your event' :
          parsed.kind === 'created_session' ? 'Cancelled your session' :
          'Cancelled'

        const kind =
          parsed.kind === 'court_booking' ? 'court_booking' :
          parsed.kind === 'event_booking' ? 'event_booking' :
          parsed.kind === 'session_booking' ? 'session_booking' :
          parsed.kind === 'created_event' ? 'created_event' :
          parsed.kind === 'created_session' ? 'created_session' :
          'status_change'

        const meta: any = { detailsId: id }
        if (parsed.kind === 'court_booking') {
          meta.courtbookingid = parsed.id
          meta.start_timestamp = courtBooking?.start_timestamp ?? null
          meta.end_timestamp = courtBooking?.end_timestamp ?? null
          meta.availabilityid = courtBooking?.availabilityid ?? null

          const courtName =
            courtBooking?.selected_court_name ??
            courtBooking?.selected_base_name ??
            courtBooking?.court_name ??
            courtBookingCourt?.name ??
            null
          if (courtName) meta.court_name = courtName
        }
        if (parsed.kind === 'event_booking') {
          meta.eventbookingid = parsed.id
          meta.eventid = eventBooking?.eventid ?? null
          meta.start_timestamp = eventBooking?.start_timestamp ?? null
          meta.end_timestamp = eventBooking?.end_timestamp ?? null
        }
        if (parsed.kind === 'session_booking') {
          meta.tsbookingid = parsed.id
          meta.sessionid = sessionBooking?.sessionid ?? null
          meta.start_timestamp = sessionBooking?.start_timestamp ?? null
          meta.end_timestamp = sessionBooking?.end_timestamp ?? null
        }
        if (parsed.kind === 'created_event') {
          meta.eventid = parsed.id
          meta.courtbookingid = createdEvent?.courtbookingid ?? null
          meta.start_timestamp = createdEvent?.start_timestamp ?? createdEvent?.time ?? null
          meta.end_timestamp = createdEvent?.end_timestamp ?? null
        }
        if (parsed.kind === 'created_session') {
          meta.sessionid = parsed.id
          meta.courtbookingid = createdSession?.courtbookingid ?? null
          meta.start_timestamp = createdSession?.start_timestamp ?? createdSession?.time ?? null
          meta.end_timestamp = createdSession?.end_timestamp ?? null
        }

        const fromStatus = (() => {
          if (parsed.kind === 'court_booking') return courtBooking?.bookingstatus ?? courtBooking?.status ?? 'upcoming'
          if (parsed.kind === 'event_booking') return eventBooking?.bookingstatus ?? eventBooking?.status ?? 'upcoming'
          if (parsed.kind === 'session_booking') return sessionBooking?.bookingstatus ?? sessionBooking?.status ?? 'upcoming'
          if (parsed.kind === 'created_event') return createdEvent?.status ?? 'upcoming'
          if (parsed.kind === 'created_session') return createdSession?.status ?? 'upcoming'
          return 'upcoming'
        })()

        const toStatus = 'cancelled'

        void appendHistory(userId, {
          kind: kind as any,
          title,
          subtitle: null,
          fromStatus: lower(fromStatus) || 'upcoming',
          toStatus,
          meta,
        })
      }

      if (parsed.kind === 'event_booking') {
        const detailKey = ['details', 'eventBooking', parsed.id] as const
        save(detailKey)
        patchObject(detailKey, { bookingstatus: 'cancelled' })

        const b: any = eventBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        const evId = typeof b?.eventid === 'number' ? b.eventid : null
        if (typeof userid === 'number') {
          const k1 = ['eventBookings', userid] as const
          const k2 = ['eventBookingsByUserId', userid] as const
          save(k1)
          save(k2)
          patchList(k1, (row: any) => row?.eventbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          patchList(k2, (row: any) => row?.eventbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
        }

        if (typeof evId === 'number') {
          save(queryKeys.eventsCombined)
          queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.eventid !== evId) return row
              const cur = Number(row?.numberofpeople)
              const curN = Number.isFinite(cur) ? cur : 0
              return { ...row, numberofpeople: Math.max(0, curN - 1) }
            })
          })
        }
      }

      if (parsed.kind === 'session_booking') {
        const detailKey = ['details', 'sessionBooking', parsed.id] as const
        save(detailKey)
        patchObject(detailKey, { bookingstatus: 'cancelled' })

        const b: any = sessionBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        const sessionId = typeof b?.sessionid === 'number' ? b.sessionid : null
        if (typeof userid === 'number') {
          const k1 = ['trainingSessionBookings', userid] as const
          const k2 = ['trainingSessionBookingsByUserId', userid] as const
          save(k1)
          save(k2)
          patchList(k1, (row: any) => row?.tsbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          patchList(k2, (row: any) => row?.tsbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
        }

        if (typeof sessionId === 'number') {
          save(queryKeys.trainingSessionsCombined)
          queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.sessionid !== sessionId) return row
              const cur = Number(row?.numberofpeople)
              const curN = Number.isFinite(cur) ? cur : 0
              return { ...row, numberofpeople: Math.max(0, curN - 1) }
            })
          })
        }
      }

      if (parsed.kind === 'created_event') {
        const detailKey = ['details', 'createdEvent', parsed.id] as const
        save(detailKey)
        const cancelledAt = Date.now()
        patchObject(detailKey, { status: 'cancelled', _cancelledAt: cancelledAt } as any)

        save(queryKeys.eventsCombined)
        queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (row?.eventid === parsed.id ? { ...row, status: 'cancelled', _cancelledAt: cancelledAt } : row))
        })

        const ev: any = createdEventQuery.data
        const organizerid = typeof ev?.organizerid === 'number' ? ev.organizerid : null
        if (typeof organizerid === 'number') {
          const k1 = ['createdEventsCombined', organizerid] as const
          save(k1)
          patchList(k1, (row: any) => row?.eventid === parsed.id, { status: 'cancelled', _cancelledAt: cancelledAt } as any)
        }
      }

      if (parsed.kind === 'created_session') {
        const detailKey = ['details', 'createdSession', parsed.id] as const
        save(detailKey)
        const cancelledAt = Date.now()
        patchObject(detailKey, { status: 'cancelled', _cancelledAt: cancelledAt } as any)

        save(queryKeys.trainingSessionsCombined)
        queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (row?.sessionid === parsed.id ? { ...row, status: 'cancelled', _cancelledAt: cancelledAt } : row))
        })

        const s: any = createdSessionQuery.data
        const coachid = typeof s?.coachid === 'number' ? s.coachid : null
        if (typeof coachid === 'number') {
          const k1 = ['createdTrainingSessionsCombined', coachid] as const
          save(k1)
          patchList(k1, (row: any) => row?.sessionid === parsed.id, { status: 'cancelled', _cancelledAt: cancelledAt } as any)
        }
      }

      return { undo }
    },
    onSuccess: async () => {
      const setInList = <T extends { [k: string]: any }>(
        key: readonly unknown[],
        match: (row: T) => boolean,
        patch: Partial<T>
      ) => {
        queryClient.setQueryData(key, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (match(row) ? { ...row, ...patch } : row))
        })
      }

      if (parsed.kind === 'court_booking') {
        const b: any = courtBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        // Detail cache
        queryClient.setQueryData(['details', 'courtBooking', parsed.id], (prev: any) => ({ ...(prev || {}), bookingstatus: 'cancelled' }))
        // List caches used across the app
        if (typeof userid === 'number') {
          setInList(['courtBookings', userid], (row: any) => row?.courtbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          setInList(['courtbookings', 'user', userid], (row: any) => row?.courtbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)

          // Refetch from server so other screens (e.g. courtBooking) clear "already booked" immediately.
          try {
            await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userid) as any })
          } catch {
            // ignore
          }
        }

        // Availability lists may depend on bookings state.
        try {
          await queryClient.invalidateQueries({
            predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability',
          })
        } catch {
          // ignore
        }
      }

      if (parsed.kind === 'event_booking') {
        const b: any = eventBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        const evId = typeof b?.eventid === 'number' ? b.eventid : null
        queryClient.setQueryData(['details', 'eventBooking', parsed.id], (prev: any) => ({ ...(prev || {}), bookingstatus: 'cancelled' }))
        if (typeof userid === 'number') {
          setInList(['eventBookings', userid], (row: any) => row?.eventbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          setInList(['eventBookingsByUserId', userid], (row: any) => row?.eventbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
        }

        if (typeof evId === 'number') {
          queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.eventid !== evId) return row
              const cur = Number(row?.numberofpeople)
              const curN = Number.isFinite(cur) ? cur : 0
              return { ...row, numberofpeople: Math.max(0, curN - 1) }
            })
          })
          await invalidateEventsCombinedCache()
        }
      }

      if (parsed.kind === 'session_booking') {
        const b: any = sessionBookingQuery.data
        const userid = typeof b?.userid === 'number' ? b.userid : null
        const sessionId = typeof b?.sessionid === 'number' ? b.sessionid : null
        queryClient.setQueryData(['details', 'sessionBooking', parsed.id], (prev: any) => ({ ...(prev || {}), bookingstatus: 'cancelled' }))
        if (typeof userid === 'number') {
          setInList(['trainingSessionBookings', userid], (row: any) => row?.tsbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
          setInList(['trainingSessionBookingsByUserId', userid], (row: any) => row?.tsbookingid === parsed.id, { bookingstatus: 'cancelled' } as any)
        }

        if (typeof sessionId === 'number') {
          queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.sessionid !== sessionId) return row
              const cur = Number(row?.numberofpeople)
              const curN = Number.isFinite(cur) ? cur : 0
              return { ...row, numberofpeople: Math.max(0, curN - 1) }
            })
          })
          await invalidateTrainingSessionsCombinedCache()
        }
      }

      if (parsed.kind === 'created_event') {
        const ev: any = createdEventQuery.data
        const organizerid = typeof ev?.organizerid === 'number' ? ev.organizerid : null
        const cancelledAt = Date.now()
        queryClient.setQueryData(['details', 'createdEvent', parsed.id], (prev: any) => ({ ...(prev || {}), status: 'cancelled', _cancelledAt: cancelledAt }))
        // Update combined cache immediately so the court cancel dependency check unlocks.
        queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (row?.eventid === parsed.id ? { ...row, status: 'cancelled', _cancelledAt: cancelledAt } : row))
        })
        if (typeof organizerid === 'number') {
          setInList(['createdEventsCombined', organizerid], (row: any) => row?.eventid === parsed.id, { status: 'cancelled', _cancelledAt: cancelledAt } as any)
        }
        await invalidateEventsCombinedCache()

        // After a short grace period, hide cancelled events from list caches.
        setTimeout(() => {
          queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.filter((row: any) => {
              if (row?.eventid !== parsed.id) return true
              const s = String(row?.status ?? '').toLowerCase()
              const ts = typeof row?._cancelledAt === 'number' ? row._cancelledAt : 0
              return !(s.includes('cancel') && ts && Date.now() - ts >= 15_000)
            })
          })
          if (typeof organizerid === 'number') {
            queryClient.setQueryData(['createdEventsCombined', organizerid], (prev: any) => {
              if (!Array.isArray(prev)) return prev
              return prev.filter((row: any) => {
                if (row?.eventid !== parsed.id) return true
                const s = String(row?.status ?? '').toLowerCase()
                const ts = typeof row?._cancelledAt === 'number' ? row._cancelledAt : 0
                return !(s.includes('cancel') && ts && Date.now() - ts >= 15_000)
              })
            })
          }
        }, 15_000)
      }

      if (parsed.kind === 'created_session') {
        const s: any = createdSessionQuery.data
        const coachid = typeof s?.coachid === 'number' ? s.coachid : null
        const cancelledAt = Date.now()
        queryClient.setQueryData(['details', 'createdSession', parsed.id], (prev: any) => ({ ...(prev || {}), status: 'cancelled', _cancelledAt: cancelledAt }))
        queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => (row?.sessionid === parsed.id ? { ...row, status: 'cancelled', _cancelledAt: cancelledAt } : row))
        })
        if (typeof coachid === 'number') {
          setInList(['createdTrainingSessionsCombined', coachid], (row: any) => row?.sessionid === parsed.id, { status: 'cancelled', _cancelledAt: cancelledAt } as any)
        }
        await invalidateTrainingSessionsCombinedCache()

        setTimeout(() => {
          queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.filter((row: any) => {
              if (row?.sessionid !== parsed.id) return true
              const st = String(row?.status ?? '').toLowerCase()
              const ts = typeof row?._cancelledAt === 'number' ? row._cancelledAt : 0
              return !(st.includes('cancel') && ts && Date.now() - ts >= 15_000)
            })
          })
          if (typeof coachid === 'number') {
            queryClient.setQueryData(['createdTrainingSessionsCombined', coachid], (prev: any) => {
              if (!Array.isArray(prev)) return prev
              return prev.filter((row: any) => {
                if (row?.sessionid !== parsed.id) return true
                const st = String(row?.status ?? '').toLowerCase()
                const ts = typeof row?._cancelledAt === 'number' ? row._cancelledAt : 0
                return !(st.includes('cancel') && ts && Date.now() - ts >= 15_000)
              })
            })
          }
        }, 15_000)
      }

      // Show cancellation notification page.
      const anim = parsed.kind === 'created_event' || parsed.kind === 'created_session' ? 'cancel' : 'booking_cancel'
      const detailsId = parsed.raw
      router.replace({ pathname: '/event/statusTransition', params: { anim, detailsId } } as any)
    },
    onError: (_err, _vars, ctx) => {
      const undo = (ctx as any)?.undo as { key: readonly unknown[]; prev: any }[] | undefined
      if (Array.isArray(undo)) {
        for (const item of undo) queryClient.setQueryData(item.key, item.prev)
      }
    },
  })

  const headerTitle = useMemo(() => {
    switch (parsed.kind) {
      case 'court_booking':
        return 'Court Booking'
      case 'event_booking':
        return 'Event Booking'
      case 'session_booking':
        return 'Training Booking'
      case 'created_event':
        return 'Created Event'
      case 'created_session':
        return 'Created Training Session'
      default:
        return 'Details'
    }
  }, [parsed.kind])

  const courtCancelBlockedReason = useMemo(() => {
    if (parsed.kind !== 'court_booking') return null
    const booking = courtBookingQuery.data
    if (!booking) return null
    const cbid = booking.courtbookingid
    const cbidNum = Number(cbid)
    if (!Number.isFinite(cbidNum)) return 'Unable to verify linked events/sessions. Please try again.'

    const depsLoading =
      linkedEventsByCourtBookingQuery.isLoading ||
      linkedEventsByCourtBookingQuery.isFetching ||
      linkedSessionsByCourtBookingQuery.isLoading ||
      linkedSessionsByCourtBookingQuery.isFetching

    // Prevent cancelling the court booking before we know whether an event/session depends on it.
    if (depsLoading) return 'Checking linked events/sessions…'

    if (linkedEventsByCourtBookingQuery.error || linkedSessionsByCourtBookingQuery.error) {
      return 'Unable to verify linked events/sessions. Please try again.'
    }

    const now = Date.now()
    const isUpcoming = (status: any, time: any) => {
      const s = typeof status === 'string' ? status.toLowerCase() : ''
      if (s.includes('cancel') || s.includes('complete')) return false
      if (s.includes('upcoming')) return true
      const dt = parseTimestampLoose(time as any)
      return Number.isFinite(dt.getTime()) ? dt.getTime() > now : false
    }

    const evs = Array.isArray(linkedEventsByCourtBookingQuery.data) ? linkedEventsByCourtBookingQuery.data : []
    const ses = Array.isArray(linkedSessionsByCourtBookingQuery.data) ? linkedSessionsByCourtBookingQuery.data : []

    const hasEvent = evs.some((e: any) => {
      if (Number(e?.courtbookingid) !== cbidNum) return false
      return isUpcoming(e?.status, e?.time ?? e?.start_timestamp)
    })
    if (hasEvent) return 'You must cancel the event first.'

    const hasSession = ses.some((s: any) => {
      if (Number(s?.courtbookingid) !== cbidNum) return false
      return isUpcoming(s?.status, s?.time ?? s?.start_timestamp)
    })
    if (hasSession) return 'You must cancel the training session first.'

    return null
  }, [
    parsed.kind,
    courtBookingQuery.data,
    linkedEventsByCourtBookingQuery.data,
    linkedEventsByCourtBookingQuery.isLoading,
    linkedEventsByCourtBookingQuery.isFetching,
    linkedEventsByCourtBookingQuery.error,
    linkedSessionsByCourtBookingQuery.data,
    linkedSessionsByCourtBookingQuery.isLoading,
    linkedSessionsByCourtBookingQuery.isFetching,
    linkedSessionsByCourtBookingQuery.error,
  ])

  const bookingActionState = useMemo(() => {
    if (parsed.kind === 'court_booking') {
      const b: any = courtBookingQuery.data
      return deriveBookingActionState(b?.status, b?.bookingstatus, parseTimestampLoose(b?.start_timestamp))
    }
    if (parsed.kind === 'event_booking') {
      const b: any = eventBookingQuery.data
      const eventid = Number(b?.eventid)
      const evCombined = Number.isFinite(eventid) ? eventsCombinedList.find((x) => x.eventid === eventid) : null
      const ev: any = evCombined || eventBookingEventQuery.data
      const start = parseTimestampLoose(ev?.start_timestamp ?? ev?.time ?? b?.start_timestamp ?? null)
      return deriveBookingActionState(b?.status, b?.bookingstatus, start)
    }
    if (parsed.kind === 'session_booking') {
      const b: any = sessionBookingQuery.data
      const sessionid = Number(b?.sessionid)
      const sCombined = Number.isFinite(sessionid) ? sessionsCombinedList.find((x) => x.sessionid === sessionid) : null
      const s: any = sCombined || sessionBookingSessionQuery.data
      const start = parseTimestampLoose(s?.start_timestamp ?? s?.time ?? b?.start_timestamp ?? null)
      return deriveBookingActionState(b?.status, b?.bookingstatus, start)
    }
    return null
  }, [
    parsed.kind,
    courtBookingQuery.data,
    eventBookingQuery.data,
    sessionBookingQuery.data,
    eventBookingEventQuery.data,
    sessionBookingSessionQuery.data,
    eventsCombinedList,
    sessionsCombinedList,
  ])

  const canCancel = useMemo(() => {
    const lower = (v: any) => (typeof v === 'string' ? v.toLowerCase() : '')
    if (parsed.kind === 'court_booking') {
      const depsLoading =
        linkedEventsByCourtBookingQuery.isLoading ||
        linkedEventsByCourtBookingQuery.isFetching ||
        linkedSessionsByCourtBookingQuery.isLoading ||
        linkedSessionsByCourtBookingQuery.isFetching
      if (depsLoading) return false
      if (courtCancelBlockedReason) return false
      return !!bookingActionState?.cancelEnabled
    }
    if (parsed.kind === 'event_booking' || parsed.kind === 'session_booking') {
      return !!bookingActionState?.cancelEnabled
    }
    if (parsed.kind === 'created_event') return lower(createdEventQuery.data?.status) === 'upcoming'
    if (parsed.kind === 'created_session') return lower(createdSessionQuery.data?.status) === 'upcoming'
    return false
  }, [
    parsed.kind,
    bookingActionState,
    courtCancelBlockedReason,
    linkedEventsByCourtBookingQuery.isFetching,
    linkedEventsByCourtBookingQuery.isLoading,
    linkedSessionsByCourtBookingQuery.isFetching,
    linkedSessionsByCourtBookingQuery.isLoading,
    createdEventQuery.data?.status,
    createdSessionQuery.data?.status,
  ])

  const isRecordCancelled = useMemo(() => {
    const normalize = (v: any) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
    const isCancelled = (v: any) => normalize(v).includes('cancel')

    if (parsed.kind === 'court_booking') {
      return isCancelled((courtBookingQuery.data as any)?.bookingstatus ?? (courtBookingQuery.data as any)?.status)
    }
    if (parsed.kind === 'event_booking') {
      return isCancelled((eventBookingQuery.data as any)?.bookingstatus ?? (eventBookingQuery.data as any)?.status)
    }
    if (parsed.kind === 'session_booking') {
      return isCancelled((sessionBookingQuery.data as any)?.bookingstatus ?? (sessionBookingQuery.data as any)?.status)
    }
    if (parsed.kind === 'created_event') return isCancelled((createdEventQuery.data as any)?.status)
    if (parsed.kind === 'created_session') return isCancelled((createdSessionQuery.data as any)?.status)
    return false
  }, [
    parsed.kind,
    courtBookingQuery.data,
    eventBookingQuery.data,
    sessionBookingQuery.data,
    createdEventQuery.data,
    createdSessionQuery.data,
  ])

  const canReview = useMemo(() => {
    if (parsed.kind === 'court_booking') {
      const owneridRaw = Number((singleCourtQuery.data as any)?.ownerid)
      const isOwner = Number.isFinite(owneridRaw) && Number.isFinite(userId) && owneridRaw === Number(userId)
      return !!bookingActionState?.reviewEnabled && !isOwner && !isRecordCancelled
    }
    if (parsed.kind === 'event_booking' || parsed.kind === 'session_booking') {
      return !!bookingActionState?.reviewEnabled && !isRecordCancelled
    }
    return false
  }, [parsed.kind, bookingActionState, singleCourtQuery.data, userId, isRecordCancelled])

  const isBookingKind = parsed.kind === 'court_booking' || parsed.kind === 'event_booking' || parsed.kind === 'session_booking'

  const reviewNavParams = useMemo(() => {
    if (parsed.kind === 'court_booking') {
      const courtid = courtCourtId ?? (courtBookingQuery.data as any)?.courtid
      if (!Number.isFinite(courtid) || courtid == null) return null
      const avail = singleAvailQuery.data as any
      const courtsRel = Array.isArray(avail?.courts) ? avail.courts[0] : (avail?.courts ?? null)
      const courtInfoRel = Array.isArray(courtsRel?.courtinfo) ? courtsRel.courtinfo[0] : (courtsRel?.courtinfo ?? null)
      const reviewTitle =
        (courtInfoRel as any)?.name ||
        (courtBookingQuery.data as any)?.selected_base_name ||
        (courtBookingQuery.data as any)?.selected_court_name ||
        `Court #${courtid}`
      return { targettype: 'court', targetid: String(courtid), title: encodeURIComponent(String(reviewTitle)) }
    }
    if (parsed.kind === 'event_booking') {
      const eventid = (eventBookingQuery.data as any)?.eventid
      if (typeof eventid !== 'number') return null
      const ev = eventsCombinedList.find((x) => x.eventid === eventid)
      return { targettype: 'event', targetid: String(eventid), title: encodeURIComponent(ev?.title ?? `Event #${eventid}`) }
    }
    if (parsed.kind === 'session_booking') {
      const sessionid = (sessionBookingQuery.data as any)?.sessionid
      if (typeof sessionid !== 'number') return null
      const s = sessionsCombinedList.find((x) => x.sessionid === sessionid)
      return { targettype: 'trainingsession', targetid: String(sessionid), title: encodeURIComponent((s as any)?.title ?? `Session #${sessionid}`) }
    }
    return null
  }, [parsed.kind, courtCourtId, courtBookingQuery.data, singleAvailQuery.data, eventBookingQuery.data, eventsCombinedList, sessionBookingQuery.data, sessionsCombinedList])

  const isLoading =
    courtBookingQuery.isLoading ||
    singleAvailQuery.isLoading ||
    eventBookingQuery.isLoading ||
    sessionBookingQuery.isLoading ||
    createdEventQuery.isLoading ||
    createdEventInfoQuery.isLoading ||
    createdSessionQuery.isLoading ||
    createdSessionInfoQuery.isLoading

  const loadError =
    courtBookingQuery.error ||
    eventBookingQuery.error ||
    sessionBookingQuery.error ||
    createdEventQuery.error ||
    createdEventInfoQuery.error ||
    createdSessionQuery.error ||
    createdSessionInfoQuery.error

  const courtBookingCourt = useMemo(() => {
    if (parsed.kind !== 'court_booking') return null
    if (!courtBookingQuery.data) return null
    const avail: any = singleAvailQuery.data
    const courtsRel = Array.isArray(avail?.courts) ? avail.courts[0] : (avail?.courts ?? null)
    const courtinfoRel = Array.isArray(courtsRel?.courtinfo)
      ? courtsRel.courtinfo[0]
      : (courtsRel?.courtinfo ?? (Array.isArray(avail?.courtinfo) ? avail.courtinfo[0] : (avail?.courtinfo ?? null)))
    const courtBase = singleCourtQuery.data
    if (courtCourtId == null && !courtinfoRel && !courtBase) return null
    return {
      courtid: courtCourtId,
      name: (courtinfoRel as any)?.name ?? (courtBase as any)?.courtinfo ?? null,
      address: (courtinfoRel as any)?.address ?? null,
    }
  }, [parsed.kind, courtBookingQuery.data, singleAvailQuery.data, singleCourtQuery.data, courtCourtId])

  const openCancelModal = () => setShowCancelModal(true)
  const closeCancelModal = () => setShowCancelModal(false)

  const confirmCancel = async () => {
    try {
      closeCancelModal()
      setBusy(true)
      await cancelMutation.mutateAsync()
    } catch (e: any) {
      openResultModal('Failed', e?.message || 'Could not cancel this record')
    } finally {
      setBusy(false)
    }
  }

  const eventCourtName = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    const booking = eventBookingQuery.data
    const eventid = booking?.eventid
    if (typeof eventid !== 'number') return null
    const row = eventsCombinedList.find((e) => e.eventid === eventid)
    return resolveVenueLabel(row)
  }, [parsed.kind, eventBookingQuery.data, eventsCombinedList])

  const sessionCourtName = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    const booking = sessionBookingQuery.data
    const sessionid = booking?.sessionid
    if (typeof sessionid !== 'number') return null
    const row = sessionsCombinedList.find((s) => s.sessionid === sessionid)
    return resolveVenueLabel(row)
  }, [parsed.kind, sessionBookingQuery.data, sessionsCombinedList])

  const createdEventId = parsed.kind === 'created_event' ? parsed.id : null
  const createdEventCourtName = useMemo(() => {
    if (createdEventId == null) return null
    const row = eventsCombinedList.find((e) => e.eventid === createdEventId)
    return resolveVenueLabel(row)
  }, [createdEventId, eventsCombinedList])

  const createdSessionId = parsed.kind === 'created_session' ? parsed.id : null
  const createdSessionCourtName = useMemo(() => {
    if (createdSessionId == null) return null
    const row = sessionsCombinedList.find((s) => s.sessionid === createdSessionId)
    return resolveVenueLabel(row)
  }, [createdSessionId, sessionsCombinedList])

  const summaryVenueName = useMemo(() => {
    if (parsed.kind === 'court_booking') return courtBookingCourt?.name || null

    if (parsed.kind === 'event_booking') {
      const eventid = Number(eventBookingQuery.data?.eventid)
      const evCombined = Number.isFinite(eventid) ? eventsCombinedList.find((x) => x.eventid === eventid) : null
      const ev = evCombined || eventBookingEventQuery.data
      return (
        eventSummaryVenueInfoQuery.data?.name ||
        resolveVenueNameOnly(ev) ||
        resolveVenueNameOnly(eventBookingInfoQuery.data) ||
        resolveVenueNameOnly(eventCourtBooking) ||
        null
      )
    }

    if (parsed.kind === 'session_booking') {
      const sessionid = Number(sessionBookingQuery.data?.sessionid)
      const sCombined = Number.isFinite(sessionid) ? sessionsCombinedList.find((x) => x.sessionid === sessionid) : null
      const s = sCombined || sessionBookingSessionQuery.data
      return (
        sessionSummaryVenueInfoQuery.data?.name ||
        resolveVenueNameOnly(s) ||
        resolveVenueNameOnly(sessionBookingInfoQuery.data) ||
        resolveVenueNameOnly(sessionCourtBooking) ||
        null
      )
    }

    if (parsed.kind === 'created_event') {
      return resolveVenueNameOnly(createdEventInfoQuery.data) || resolveVenueNameOnly(createdEventQuery.data) || null
    }

    if (parsed.kind === 'created_session') {
      return resolveVenueNameOnly(createdSessionInfoQuery.data) || resolveVenueNameOnly(createdSessionQuery.data) || null
    }

    return null
  }, [
    parsed.kind,
    courtBookingCourt?.name,
    eventBookingQuery.data?.eventid,
    eventsCombinedList,
    eventBookingEventQuery.data,
    eventBookingInfoQuery.data,
    eventCourtBooking,
    eventSummaryVenueInfoQuery.data?.name,
    sessionBookingQuery.data?.sessionid,
    sessionsCombinedList,
    sessionBookingSessionQuery.data,
    sessionBookingInfoQuery.data,
    sessionCourtBooking,
    sessionSummaryVenueInfoQuery.data?.name,
    createdEventInfoQuery.data,
    createdEventQuery.data,
    createdSessionInfoQuery.data,
    createdSessionQuery.data,
  ])

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.8}>
            <Image source={ICONS.arrowLeft} style={styles.backIcon} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>{headerTitle}</Text>
        <View style={styles.headerSide} />
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={showCancelModal}
        onRequestClose={closeCancelModal}
      >
        <TouchableWithoutFeedback onPress={closeCancelModal}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.modalCenteredWrapper} pointerEvents="box-none">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Are you sure you want to cancel ?</Text>
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={closeCancelModal}
                activeOpacity={0.8}
                disabled={busy || cancelMutation.isPending}
              >
                <Text style={styles.modalButtonCancelText}>Return</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm, (busy || cancelMutation.isPending) && styles.modalButtonDisabled]}
                onPress={confirmCancel}
                activeOpacity={0.8}
                disabled={busy || cancelMutation.isPending}
              >
                <Text style={styles.modalButtonConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={showResultModal}
        onRequestClose={closeResultModal}
      >
        <TouchableWithoutFeedback onPress={closeResultModal}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.modalCenteredWrapper} pointerEvents="box-none">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{resultModalTitle}</Text>
            {!!resultModalMessage && <Text style={styles.modalMessage}>{resultModalMessage}</Text>}
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={closeResultModal}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonCancelText}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text style={styles.muted}>Loading details…</Text>
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Failed to load</Text>
          <Text style={styles.muted}>{(loadError as any)?.message || 'Unknown error'}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Section title="Summary">
            <Row
              label="Venue Name"
              value={summaryVenueName || 'Unknown'}
            />
            <Row label="Type" value={headerTitle} />
          </Section>

          {parsed.kind === 'court_booking' && courtBookingQuery.data && (() => {
            const b = courtBookingQuery.data
            const start = parseTimestampLoose(b.start_timestamp)
            const end = parseTimestampLoose(b.end_timestamp)
            return (
              <>
                <Section title="Booking">
                  <Row label="Status" value={formatStatusTitleCase(b.bookingstatus || b.status)} />
                  <Row label="Court Name" value={(b as any)?.selected_court_name || (b as any)?.selected_base_name || (b as any)?.court_name || courtBookingCourt?.name || 'Unknown'} />
                  <Row label="Address" value={courtBookingCourt?.address || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={`${formatTimeHHMM(start) || 'Unknown'}${formatTimeHHMM(end) ? ` - ${formatTimeHHMM(end)}` : ''}`} />
                  <Row label="Note" value={b.note || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'event_booking' && eventBookingQuery.data && (() => {
            const b = eventBookingQuery.data
            const eventid = b.eventid
            const evCombined = eventsCombinedList.find((x) => x.eventid === eventid)
            const ev: any = evCombined || eventBookingEventQuery.data
            const evMeta = eventBookingInfoQuery.data
            const start = parseTimestampLoose(ev?.start_timestamp ?? ev?.time ?? null)
            const end = parseTimestampLoose(ev?.end_timestamp ?? null)
            return (
              <>
                <Section title="Event">
                  <Row label="Title" value={ev?.title || evMeta?.title || `Event #${eventid}`} />
                  <Row label="Approve Status" value={formatStatusTitleCase((b as any)?.status ?? 'pending')} />
                  <Row label="Event Status" value={formatStatusTitleCase(ev?.status ?? 'upcoming')} />
                  <Row label="Court Name" value={(eventCourtBooking as any)?.selected_court_name || (eventCourtBooking as any)?.selected_base_name || eventCourtName || resolveVenueLabel(ev) || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={`${formatTimeHHMM(start) || 'Unknown'}${formatTimeHHMM(end) ? ` - ${formatTimeHHMM(end)}` : ''}`} />
                  <Row label="Description" value={ev?.description || evMeta?.description || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'session_booking' && sessionBookingQuery.data && (() => {
            const b = sessionBookingQuery.data
            const sessionid = b.sessionid
            const sCombined = sessionsCombinedList.find((x) => x.sessionid === sessionid)
            const s: any = sCombined || sessionBookingSessionQuery.data
            const sMeta = sessionBookingInfoQuery.data
            const start = parseTimestampLoose(s?.start_timestamp ?? s?.time ?? null)
            const end = parseTimestampLoose(s?.end_timestamp ?? null)
            return (
              <>
                <Section title="Training Session">
                  <Row label="Title" value={s?.title || sMeta?.title || `Session #${sessionid}`} />
                  <Row label="Approve Status" value={formatStatusTitleCase((b as any)?.status ?? 'pending')} />
                  <Row label="Training Session Status" value={formatStatusTitleCase(s?.status ?? 'upcoming')} />
                  <Row label="Court Name" value={(sessionCourtBooking as any)?.selected_court_name || (sessionCourtBooking as any)?.selected_base_name || sessionCourtName || resolveVenueLabel(s) || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={`${formatTimeHHMM(start) || 'Unknown'}${formatTimeHHMM(end) ? ` - ${formatTimeHHMM(end)}` : ''}`} />
                  <Row label="Description" value={s?.description || sMeta?.description || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'created_event' && createdEventQuery.data && (() => {
            const ev = createdEventQuery.data
            const meta = createdEventInfoQuery.data
            const start = parseTimestampLoose(ev.time)
            return (
              <>
                <Section title="Event">
                  <Row label="Title" value={meta?.title || `Event #${ev.eventid}`} />
                  <Row label="Event Status" value={formatStatusTitleCase(ev.status)} />
                  <Row label="Court" value={createdEventCourtName || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={formatTimeHHMM(start) || 'Unknown'} />
                  <Row label="Participants cap" value={(meta as any)?.participants_cap ?? '—'} />
                  <Row label="Entry fee" value={formatEntryFee(meta?.entry_fee)} />
                  <Row label="Description" value={meta?.description || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'created_session' && createdSessionQuery.data && (() => {
            const s = createdSessionQuery.data
            const meta = createdSessionInfoQuery.data
            const start = parseTimestampLoose(s.time)
            return (
              <>
                <Section title="Training Session">
                  <Row label="Title" value={meta?.title || `Session #${s.sessionid}`} />
                  <Row label="Training Session Status" value={formatStatusTitleCase(s.status)} />
                  <Row label="Court" value={createdSessionCourtName || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={formatTimeHHMM(start) || 'Unknown'} />
                  <Row label="Participants cap" value={(meta as any)?.participants_cap ?? '—'} />
                  <Row label="Entry fee" value={formatEntryFee(meta?.entry_fee)} />
                  <Row label="Description" value={meta?.description || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'unknown' && (
            <View style={styles.center}>
              <Text style={styles.errorTitle}>Unknown record</Text>
              <Text style={styles.muted}>Could not parse id: {parsed.raw}</Text>
            </View>
          )}

          <View style={{ height: 12 }} />
          <Pressable
            disabled={!canCancel || busy || cancelMutation.isPending}
            onPress={openCancelModal}
            style={({ pressed }) => [
              styles.cancelBtn,
              (!canCancel || busy || cancelMutation.isPending) && styles.cancelBtnDisabled,
              pressed && canCancel && !busy && !cancelMutation.isPending && styles.cancelBtnPressed,
            ]}
          >
            <Text style={styles.cancelBtnText}>{isRecordCancelled ? 'Cancelled' : 'Cancel'}</Text>
          </Pressable>
          {parsed.kind === 'court_booking' && !!courtCancelBlockedReason && (
            <Text style={styles.cancelNote}>{courtCancelBlockedReason}</Text>
          )}
          {isBookingKind && (
            <Pressable
              disabled={!canReview || !reviewNavParams}
              style={({ pressed }) => [
                styles.reviewBtn,
                (!canReview || !reviewNavParams) && styles.reviewBtnDisabled,
                pressed && canReview && !!reviewNavParams && { opacity: 0.85 },
              ]}
              onPress={() => {
                if (!canReview || !reviewNavParams) return
                router.push({ pathname: '/event/reviewForm', params: reviewNavParams } as any)
              }}
            >
              <Text style={styles.reviewBtnText}>Write a Review</Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9F9F9',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#EAEAEA',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111',
  },
  headerSide: {
    width: 52,
    alignItems: 'flex-start',
  },
  backBtn: {
    padding: 12,
    borderRadius: 28,
    backgroundColor: '#f2f2f2',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backIcon: {
    width: 20,
    height: 20,
    tintColor: '#333',
    marginTop: 2,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 30,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 10,
  },
  muted: {
    color: '#666',
    textAlign: 'center',
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#DC3545',
  },
  section: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#EAEAEA',
    padding: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: '#111',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionBody: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  rowLabel: {
    flexShrink: 0,
    color: '#444',
    fontWeight: '800',
    maxWidth: '45%',
  },
  rowValueWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
  rowValueText: {
    color: '#333',
    fontWeight: '600',
    textAlign: 'right',
  },
  cancelBtn: {
    backgroundColor: '#DC3545',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelBtnPressed: {
    opacity: 0.9,
  },
  cancelBtnDisabled: {
    opacity: 0.4,
  },
  cancelBtnText: {
    color: '#FFF',
    fontWeight: '900',
    fontSize: 15,
  },
  cancelNote: {
    color: COLORS.danger,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 4,
    fontSize: 12,
    fontWeight: '600',
  },
  reviewBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  reviewBtnDisabled: {
    opacity: 0.4,
  },
  reviewBtnText: {
    color: '#FFF',
    fontWeight: '900',
    fontSize: 15,
  },

  // Modal (synced with Settings sign-out modal)
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalCenteredWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
    marginBottom: 18,
  },
  modalMessage: {
    fontSize: 14,
    color: '#374151',
    textAlign: 'center',
    marginBottom: 18,
  },
  modalButtonsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonCancel: {
    backgroundColor: '#EFEFEF',
  },
  modalButtonConfirm: {
    backgroundColor: '#DC3545',
  },
  modalButtonDisabled: {
    opacity: 0.6,
  },
  modalButtonCancelText: {
    fontWeight: '800',
    color: '#111',
  },
  modalButtonConfirmText: {
    fontWeight: '800',
    color: '#fff',
  },
})