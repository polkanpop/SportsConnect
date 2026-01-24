import React, { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
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
import { queryKeys } from '@/hooks/query-keys'
import {
  adjustEventParticipants,
  adjustTrainingSessionParticipants,
  getCourtBooking,
  getEventBooking,
  getEventInfoByEventId,
  getTrainingSession,
  getTrainingSessionBooking,
  getTrainingSessionInfoBySessionId,
  getEvent,
  listCourtAvailabilityAll,
  listCourtInfoCached,
  invalidateEventsCombinedCache,
  invalidateTrainingSessionsCombinedCache,
  listEventsCombinedCached,
  listTrainingSessionsCombinedCached,
  updateCourtBooking,
  updateEvent,
  updateEventBooking,
  updateTrainingSession,
  updateTrainingSessionBooking,
} from '@/lib/backendApi'

type ParsedId =
  | { kind: 'court_booking'; id: number }
  | { kind: 'event_booking'; id: number }
  | { kind: 'session_booking'; id: number }
  | { kind: 'created_event'; id: number }
  | { kind: 'created_session'; id: number }
  | { kind: 'unknown'; raw: string }

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

function parseUnifiedId(rawId: string | undefined | null): ParsedId {
  const raw = String(rawId ?? '')
  const asNum = (v: string) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  if (raw.startsWith('court_')) {
    const id = asNum(raw.slice('court_'.length))
    return Number.isFinite(id) ? { kind: 'court_booking', id } : { kind: 'unknown', raw }
  }
  if (raw.startsWith('event_')) {
    const id = asNum(raw.slice('event_'.length))
    return Number.isFinite(id) ? { kind: 'event_booking', id } : { kind: 'unknown', raw }
  }
  if (raw.startsWith('session_')) {
    const id = asNum(raw.slice('session_'.length))
    return Number.isFinite(id) ? { kind: 'session_booking', id } : { kind: 'unknown', raw }
  }
  if (raw.startsWith('created_event_')) {
    const id = asNum(raw.slice('created_event_'.length))
    return Number.isFinite(id) ? { kind: 'created_event', id } : { kind: 'unknown', raw }
  }
  if (raw.startsWith('created_session_')) {
    const id = asNum(raw.slice('created_session_'.length))
    return Number.isFinite(id) ? { kind: 'created_session', id } : { kind: 'unknown', raw }
  }
  return { kind: 'unknown', raw }
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
  const [busy, setBusy] = useState(false)
  const [showCancelModal, setShowCancelModal] = useState(false)

  const needsEventsCombined =
    parsed.kind === 'event_booking' || parsed.kind === 'court_booking' || parsed.kind === 'created_event'
  const needsSessionsCombined =
    parsed.kind === 'session_booking' || parsed.kind === 'court_booking' || parsed.kind === 'created_session'

  const eventsCombinedQuery = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    enabled: needsEventsCombined,
    staleTime: 60_000,
  })
  const sessionsCombinedQuery = useQuery({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombinedCached(),
    enabled: needsSessionsCombined,
    staleTime: 60_000,
  })

  const courtAvailabilityQuery = useQuery({
    queryKey: ['courtAvailabilityAll'],
    queryFn: () => listCourtAvailabilityAll(),
    enabled: parsed.kind === 'court_booking',
    staleTime: 5 * 60_000,
  })

  const courtInfoQuery = useQuery({
    queryKey: ['courtInfoAll'],
    queryFn: () => listCourtInfoCached(),
    enabled: parsed.kind === 'court_booking',
    staleTime: 5 * 60_000,
  })

  const courtBookingQuery = useQuery({
    queryKey: ['details', 'courtBooking', parsed.kind === 'court_booking' ? parsed.id : null],
    queryFn: () => getCourtBooking((parsed as any).id),
    enabled: parsed.kind === 'court_booking',
  })
  const eventBookingQuery = useQuery({
    queryKey: ['details', 'eventBooking', parsed.kind === 'event_booking' ? parsed.id : null],
    queryFn: () => getEventBooking((parsed as any).id),
    enabled: parsed.kind === 'event_booking',
  })
  const sessionBookingQuery = useQuery({
    queryKey: ['details', 'sessionBooking', parsed.kind === 'session_booking' ? parsed.id : null],
    queryFn: () => getTrainingSessionBooking((parsed as any).id),
    enabled: parsed.kind === 'session_booking',
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
		const out = await updateEventBooking(parsed.id, { bookingstatus: 'cancelled' } as any)
		if (typeof evId === 'number') {
			try { await adjustEventParticipants(evId, -1) } catch {}
		}
		return out
      }
      if (parsed.kind === 'session_booking') {
		const sessionId = sessionBookingQuery.data?.sessionid
		const out = await updateTrainingSessionBooking(parsed.id, { bookingstatus: 'cancelled' } as any)
		if (typeof sessionId === 'number') {
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
          void invalidateEventsCombinedCache()
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
          void invalidateTrainingSessionsCombinedCache()
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
        void invalidateEventsCombinedCache()

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
        void invalidateTrainingSessionsCombinedCache()

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

      Alert.alert('Cancelled', 'This record has been cancelled.')
      router.back()
    },
    onError: (_err, _vars, ctx) => {
      const undo = (ctx as any)?.undo as Array<{ key: readonly unknown[]; prev: any }> | undefined
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

    const now = Date.now()
    const isUpcoming = (status: any, time: any) => {
      const s = typeof status === 'string' ? status.toLowerCase() : ''
      if (s.includes('cancel') || s.includes('complete')) return false
      if (s.includes('upcoming')) return true
      const dt = parseTimestampLoose(time as any)
      return Number.isFinite(dt.getTime()) ? dt.getTime() > now : false
    }

    const evs = Array.isArray(eventsCombinedQuery.data) ? eventsCombinedQuery.data : []
    const ses = Array.isArray(sessionsCombinedQuery.data) ? sessionsCombinedQuery.data : []

    const hasEvent = evs.some((e: any) => e?.courtbookingid === cbid && isUpcoming(e?.status, e?.time ?? e?.start_timestamp))
    if (hasEvent) return 'You must cancel the event first.'

    const hasSession = ses.some((s: any) => s?.courtbookingid === cbid && isUpcoming(s?.status, s?.time ?? s?.start_timestamp))
    if (hasSession) return 'You must cancel the training session first.'

    return null
  }, [parsed.kind, courtBookingQuery.data, eventsCombinedQuery.data, sessionsCombinedQuery.data])

  const canCancel = useMemo(() => {
    const lower = (v: any) => (typeof v === 'string' ? v.toLowerCase() : '')
    if (parsed.kind === 'court_booking') {
      if (courtCancelBlockedReason) return false
      return lower(courtBookingQuery.data?.bookingstatus) === 'upcoming'
    }
    if (parsed.kind === 'event_booking') return lower(eventBookingQuery.data?.bookingstatus) === 'upcoming'
    if (parsed.kind === 'session_booking') return lower(sessionBookingQuery.data?.bookingstatus) === 'upcoming'
    if (parsed.kind === 'created_event') return lower(createdEventQuery.data?.status) === 'upcoming'
    if (parsed.kind === 'created_session') return lower(createdSessionQuery.data?.status) === 'upcoming'
    return false
  }, [
    parsed.kind,
    courtCancelBlockedReason,
    courtBookingQuery.data?.bookingstatus,
    eventBookingQuery.data?.bookingstatus,
    sessionBookingQuery.data?.bookingstatus,
    createdEventQuery.data?.status,
    createdSessionQuery.data?.status,
  ])

  const isLoading =
    courtBookingQuery.isLoading ||
    eventBookingQuery.isLoading ||
    sessionBookingQuery.isLoading ||
    createdEventQuery.isLoading ||
    createdEventInfoQuery.isLoading ||
    createdSessionQuery.isLoading ||
    createdSessionInfoQuery.isLoading ||
    courtAvailabilityQuery.isLoading ||
    courtInfoQuery.isLoading ||
    (needsEventsCombined && eventsCombinedQuery.isLoading) ||
    (needsSessionsCombined && sessionsCombinedQuery.isLoading)

  const loadError =
    courtBookingQuery.error ||
    eventBookingQuery.error ||
    sessionBookingQuery.error ||
    createdEventQuery.error ||
    createdEventInfoQuery.error ||
    createdSessionQuery.error ||
    createdSessionInfoQuery.error ||
    courtAvailabilityQuery.error ||
    courtInfoQuery.error ||
    (needsEventsCombined ? eventsCombinedQuery.error : null) ||
    (needsSessionsCombined ? sessionsCombinedQuery.error : null)

  const courtBookingCourt = useMemo(() => {
    if (parsed.kind !== 'court_booking') return null
    const b = courtBookingQuery.data
    if (!b) return null
    const availabilityid = b.availabilityid
    const availabilityList = courtAvailabilityQuery.data
    const courtInfoList = courtInfoQuery.data
    if (!Array.isArray(availabilityList) || !Array.isArray(courtInfoList)) return null
    const availability = availabilityList.find((a: any) => a?.availabilityid === availabilityid)
    const courtid = availability?.courtid
    if (typeof courtid !== 'number') return null
    const ci = courtInfoList.find((x) => x?.courtid === courtid)
    return {
      courtid,
      name: (ci as any)?.name ?? null,
      address: (ci as any)?.address ?? null,
    }
  }, [parsed.kind, courtBookingQuery.data, courtAvailabilityQuery.data, courtInfoQuery.data])

  const openCancelModal = () => setShowCancelModal(true)
  const closeCancelModal = () => setShowCancelModal(false)

  const confirmCancel = async () => {
    try {
      closeCancelModal()
      setBusy(true)
      await cancelMutation.mutateAsync()
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not cancel this record')
    } finally {
      setBusy(false)
    }
  }

  const eventCourtName = useMemo(() => {
    if (parsed.kind !== 'event_booking') return null
    const booking = eventBookingQuery.data
    const eventid = booking?.eventid
    if (typeof eventid !== 'number') return null
    const list = eventsCombinedQuery.data
    if (!Array.isArray(list)) return null
    return list.find((e) => e.eventid === eventid)?.court_name ?? null
  }, [parsed.kind, eventBookingQuery.data, eventsCombinedQuery.data])

  const sessionCourtName = useMemo(() => {
    if (parsed.kind !== 'session_booking') return null
    const booking = sessionBookingQuery.data
    const sessionid = booking?.sessionid
    if (typeof sessionid !== 'number') return null
    const list = sessionsCombinedQuery.data
    if (!Array.isArray(list)) return null
    return list.find((s) => s.sessionid === sessionid)?.court_name ?? null
  }, [parsed.kind, sessionBookingQuery.data, sessionsCombinedQuery.data])

  const createdEventCourtName = useMemo(() => {
    if (parsed.kind !== 'created_event') return null
    const list = eventsCombinedQuery.data
    if (!Array.isArray(list)) return null
    return list.find((e) => e.eventid === parsed.id)?.court_name ?? null
  }, [parsed.kind, eventsCombinedQuery.data, parsed.kind === 'created_event' ? parsed.id : null])

  const createdSessionCourtName = useMemo(() => {
    if (parsed.kind !== 'created_session') return null
    const list = sessionsCombinedQuery.data
    if (!Array.isArray(list)) return null
    return list.find((s) => s.sessionid === parsed.id)?.court_name ?? null
  }, [parsed.kind, sessionsCombinedQuery.data, parsed.kind === 'created_session' ? parsed.id : null])

  // Enable combined lists for created records too (court name/title/description convenience)
  React.useEffect(() => {
    if (parsed.kind === 'created_event') void queryClient.prefetchQuery({ queryKey: queryKeys.eventsCombined, queryFn: () => listEventsCombinedCached(), staleTime: 60_000 })
    if (parsed.kind === 'created_session') void queryClient.prefetchQuery({ queryKey: queryKeys.trainingSessionsCombined, queryFn: () => listTrainingSessionsCombinedCached(), staleTime: 60_000 })
  }, [parsed.kind, queryClient])

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
            <Row label="Record ID" value={typeof id === 'string' ? id : 'Unknown'} />
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
                  <Row label="Court" value={courtBookingCourt?.name || 'Unknown'} />
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
            const ev = Array.isArray(eventsCombinedQuery.data) ? eventsCombinedQuery.data.find((x) => x.eventid === eventid) : null
            const start = parseTimestampLoose(ev?.start_timestamp ?? ev?.time ?? null)
            const end = parseTimestampLoose(ev?.end_timestamp ?? null)
            return (
              <>
                <Section title="Event">
                  <Row label="Title" value={ev?.title || `Event #${eventid}`} />
                  <Row label="Status" value={formatStatusTitleCase(b.bookingstatus || b.status)} />
                  <Row label="Court" value={eventCourtName || ev?.court_name || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={`${formatTimeHHMM(start) || 'Unknown'}${formatTimeHHMM(end) ? ` - ${formatTimeHHMM(end)}` : ''}`} />
                  <Row label="Description" value={ev?.description || '—'} />
                </Section>
              </>
            )
          })()}

          {parsed.kind === 'session_booking' && sessionBookingQuery.data && (() => {
            const b = sessionBookingQuery.data
            const sessionid = b.sessionid
            const s = Array.isArray(sessionsCombinedQuery.data) ? sessionsCombinedQuery.data.find((x) => x.sessionid === sessionid) : null
            const start = parseTimestampLoose(s?.start_timestamp ?? s?.time ?? null)
            const end = parseTimestampLoose(s?.end_timestamp ?? null)
            return (
              <>
                <Section title="Training Session">
                  <Row label="Title" value={s?.title || `Session #${sessionid}`} />
                  <Row label="Status" value={formatStatusTitleCase(b.bookingstatus || b.status)} />
                  <Row label="Court" value={sessionCourtName || s?.court_name || 'Unknown'} />
                  <Row label="Date" value={formatDateWeekdayDDMMYYYY(start)} />
                  <Row label="Time" value={`${formatTimeHHMM(start) || 'Unknown'}${formatTimeHHMM(end) ? ` - ${formatTimeHHMM(end)}` : ''}`} />
                  <Row label="Description" value={s?.description || '—'} />
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
                  <Row label="Status" value={formatStatusTitleCase(ev.status)} />
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
                  <Row label="Status" value={formatStatusTitleCase(s.status)} />
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
          {parsed.kind === 'court_booking' && !!courtCancelBlockedReason && (
            <Text style={styles.cancelNote}>{courtCancelBlockedReason}</Text>
          )}
          <Pressable
            disabled={!canCancel || busy || cancelMutation.isPending}
            onPress={openCancelModal}
            style={({ pressed }) => [
              styles.cancelBtn,
              (!canCancel || busy || cancelMutation.isPending) && styles.cancelBtnDisabled,
              pressed && canCancel && !busy && !cancelMutation.isPending && styles.cancelBtnPressed,
            ]}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
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
    color: '#666',
    textAlign: 'center',
    marginBottom: 10,
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