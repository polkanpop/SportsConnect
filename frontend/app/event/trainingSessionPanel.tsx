import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import {
  approveTrainingSessionBooking,
  type CombinedTrainingSession,
  createBlock,
  getPayment,
  getTrainingSessionInfoBySessionId,
  getTrainingSessionBookingsBySessionId,
  getUserInfoByUserIdCached,
  listBlockList,
  listTrainingSessionsCombinedByCoachId,
  removeBlock,
  rejectTrainingSessionBooking,
  type BlockListRow,
  type TrainingSessionBookingRow,
  type TrainingSessionInfoMeta,
  updateTrainingSessionInfo,
} from '@/lib/backendApi'

type Props = {
  coachId: number | null
}

function selectedSessionStorageKey(coachId: number) {
  return `@home:trainingSessionPanel:selectedSessionId:v1:${coachId}`
}

function safeNumberOrNull(v: string): number | null {
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

function formatSessionDateLabel(session: { time?: string | null }) {
  const candidate = String(session.time || '').trim()
  const d = candidate ? new Date(candidate) : null
  if (!d || Number.isNaN(d.getTime())) return 'Date: -'
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = String(d.getFullYear())
  return `Date: ${weekday}, ${mm}-${dd}-${yyyy}`
}

function asStringArray(v: unknown): string[] {
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

const BASKETBALL_SILHOUETTES = [
  ICONS.sillBasketball,
  ICONS.sillBasketball1,
  ICONS.sillBasketball2,
  ICONS.sillBasketball3,
  ICONS.sillBasketball4,
]

function fallbackSilhouetteBySessionId(sessionid: number) {
  const idx = Math.abs(Number(sessionid) || 0) % BASKETBALL_SILHOUETTES.length
  return BASKETBALL_SILHOUETTES[idx]
}

type EnrichedBooking = {
  booking: TrainingSessionBookingRow
  name: string
  pfp?: string | null
  paymentLabel: string
}

function formatPaymentLabel(opts: { isFree: boolean; payment: Awaited<ReturnType<typeof getPayment>> | null }) {
  if (opts.isFree) return 'Free'
  if (!opts.payment) return 'Unpaid'
  const method = String(opts.payment.method || '').toUpperCase()
  const status = String(opts.payment.status || '').toUpperCase()
  return `${method || 'PAYMENT'} • ${status || 'UNKNOWN'}`
}

function FreeBadge() {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        marginTop: 6,
        backgroundColor: '#16a34a',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        shadowColor: '#000',
        shadowOpacity: 0.12,
        shadowRadius: 6,
        elevation: 2,
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: 11, letterSpacing: 0.8 }}>FREE</Text>
    </View>
  )
}

export default function TrainingSessionPanel({ coachId }: Props) {
  const router = useRouter()
  const mountedRef = useRef(true)
  const sessionsLoadIdRef = useRef(0)
  const bookingsLoadIdRef = useRef(0)
  const preferredSelectedSessionIdRef = useRef<number | null>(null)

  const [sessions, setSessions] = useState<CombinedTrainingSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState<string | null>(null)

  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const selectedSession = useMemo(
    () => (selectedSessionId != null ? sessions.find((s) => s.sessionid === selectedSessionId) : undefined),
    [sessions, selectedSessionId],
  )

  const isFree = useMemo(() => ((selectedSession?.entry_fee ?? 0) <= 0), [selectedSession?.entry_fee])

  const [applicants, setApplicants] = useState<EnrichedBooking[]>([])
  const [participants, setParticipants] = useState<EnrichedBooking[]>([])
  const [bookingsLoading, setBookingsLoading] = useState(false)
  const [bookingsError, setBookingsError] = useState<string | null>(null)
  const [mutatingBookingIds, setMutatingBookingIds] = useState<Record<number, 'approve' | 'reject'>>({})

  const [hosts, setHosts] = useState<Array<{ userid: number; name: string; pfp: string | null }>>([])
  const [hostsLoading, setHostsLoading] = useState(false)
  const [hostsError, setHostsError] = useState<string | null>(null)

  const [blocked, setBlocked] = useState<BlockListRow[]>([])
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [blockedError, setBlockedError] = useState<string | null>(null)
  const [blockedNameByUserId, setBlockedNameByUserId] = useState<Record<number, string>>({})

  const [actionMenuVisible, setActionMenuVisible] = useState(false)
  const [actionUser, setActionUser] = useState<{ userid: number; name: string } | null>(null)
  const [actionMenuPos, setActionMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [confirmBlockVisible, setConfirmBlockVisible] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [confirmRemoveVisible, setConfirmRemoveVisible] = useState(false)
  const [removeCandidate, setRemoveCandidate] = useState<{ userid: number; name: string } | null>(null)

  const [infoMeta, setInfoMeta] = useState<TrainingSessionInfoMeta | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)

  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCap, setEditCap] = useState('')

  const [saving, setSaving] = useState(false)

  const loadSessions = useCallback(
    async (preferredSessionId?: number | null) => {
      const loadId = ++sessionsLoadIdRef.current
      if (coachId == null) {
        setSessions([])
        setSelectedSessionId(null)
        return
      }

      setSessionsLoading(true)
      setSessionsError(null)
      try {
        const rows = await listTrainingSessionsCombinedByCoachId(coachId)
        if (!mountedRef.current || loadId !== sessionsLoadIdRef.current) return
        const normalized = Array.isArray(rows) ? rows : []
        setSessions(normalized)
        if (normalized.length === 0) {
          setSelectedSessionId(null)
          return
        }

        const preferred =
          typeof preferredSessionId === 'number'
            ? preferredSessionId
            : typeof preferredSelectedSessionIdRef.current === 'number'
              ? preferredSelectedSessionIdRef.current
              : null

        setSelectedSessionId((prev) => {
          const has = (id: number | null) => id != null && normalized.some((s) => s.sessionid === id)
          if (preferred != null && has(preferred)) return preferred
          if (has(prev)) return prev
          return normalized[0].sessionid
        })
      } catch (e: any) {
        if (!mountedRef.current || loadId !== sessionsLoadIdRef.current) return
        setSessionsError(e?.message || String(e))
      } finally {
        if (!mountedRef.current || loadId !== sessionsLoadIdRef.current) return
        setSessionsLoading(false)
      }
    },
    [coachId],
  )

  const enrichBookings = useCallback(
    async (rows: TrainingSessionBookingRow[]) => {
      const userInfos = await Promise.all(
        rows.map(async (b) => {
          try {
            const ui = await getUserInfoByUserIdCached(b.userid)
            return {
              userid: b.userid,
              name: (ui?.name as string) || `User ${b.userid}`,
              pfp: (ui?.pfp as string) || null,
            }
          } catch {
            return { userid: b.userid, name: `User ${b.userid}`, pfp: null }
          }
        }),
      )
      const infoByUserId = new Map<number, { name: string; pfp: string | null }>()
      userInfos.forEach((u) => infoByUserId.set(u.userid, { name: u.name, pfp: u.pfp }))

      const payments = await Promise.all(
        rows.map(async (b) => {
          if (!b.paymentid) return { bookingId: b.tsbookingid, payment: null }
          const p = await getPayment(b.paymentid)
          return { bookingId: b.tsbookingid, payment: p }
        }),
      )
      const paymentByBookingId = new Map<number, Awaited<ReturnType<typeof getPayment>> | null>()
      payments.forEach((p) => paymentByBookingId.set(p.bookingId, p.payment))

      return rows.map((b) => {
        const ui = infoByUserId.get(b.userid)
        const payment = paymentByBookingId.get(b.tsbookingid) ?? null
        return {
          booking: b,
          name: ui?.name || `User ${b.userid}`,
          pfp: ui?.pfp || null,
          paymentLabel: formatPaymentLabel({ isFree, payment }),
        }
      })
    },
    [isFree],
  )

  const loadBookingsForSession = useCallback(
    async (sessionId: number) => {
      const loadId = ++bookingsLoadIdRef.current
      setBookingsLoading(true)
      setBookingsError(null)
      try {
        const [pendingRows, joinedRows] = await Promise.all([
          getTrainingSessionBookingsBySessionId(sessionId, { status: 'pending' }),
          getTrainingSessionBookingsBySessionId(sessionId, { status: 'joined' }),
        ])
        if (!mountedRef.current || loadId !== bookingsLoadIdRef.current) return
        const [pending, joined] = await Promise.all([enrichBookings(pendingRows || []), enrichBookings(joinedRows || [])])
        if (!mountedRef.current || loadId !== bookingsLoadIdRef.current) return
        setApplicants(pending)
        setParticipants(joined)
        // Keep the participants count feeling "live" for the selected session.
        setSessions((prev) =>
          prev.map((s) => (s.sessionid === sessionId ? { ...s, numberofpeople: joined.length } : s)),
        )
      } catch (e: any) {
        if (!mountedRef.current || loadId !== bookingsLoadIdRef.current) return
        setApplicants([])
        setParticipants([])
        setBookingsError(e?.message || String(e))
      } finally {
        if (!mountedRef.current || loadId !== bookingsLoadIdRef.current) return
        setBookingsLoading(false)
      }
    },
    [enrichBookings],
  )

  const loadBlockedForTarget = useCallback(
    async (sessionId: number) => {
      setBlockedLoading(true)
      setBlockedError(null)
      try {
        const rows = await listBlockList({ targettype: 'trainingsession', targetid: sessionId })
        const normalized = Array.isArray(rows) ? rows : []
        setBlocked(normalized)
      } catch (e: any) {
        setBlocked([])
        setBlockedError(e?.message || String(e))
      } finally {
        setBlockedLoading(false)
      }
    },
    [],
  )

  const onApproveApplicant = useCallback(
    async (sessionId: number, booking: TrainingSessionBookingRow) => {
      setMutatingBookingIds((m) => ({ ...m, [booking.tsbookingid]: 'approve' }))
      try {
        await approveTrainingSessionBooking(booking.tsbookingid)
        await Promise.all([loadSessions(sessionId), loadBookingsForSession(sessionId)])
      } catch (e: any) {
        setBookingsError(e?.message || String(e))
      } finally {
        setMutatingBookingIds((m) => {
          const next = { ...m }
          delete next[booking.tsbookingid]
          return next
        })
      }
    },
    [loadBookingsForSession, loadSessions],
  )

  const onRejectApplicant = useCallback(
    async (sessionId: number, booking: TrainingSessionBookingRow) => {
      setMutatingBookingIds((m) => ({ ...m, [booking.tsbookingid]: 'reject' }))
      try {
        await rejectTrainingSessionBooking(booking.tsbookingid)
        await loadBookingsForSession(sessionId)
      } catch (e: any) {
        setBookingsError(e?.message || String(e))
      } finally {
        setMutatingBookingIds((m) => {
          const next = { ...m }
          delete next[booking.tsbookingid]
          return next
        })
      }
    },
    [loadBookingsForSession],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (coachId == null) return

    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(selectedSessionStorageKey(coachId))
        const parsed = stored ? Number(stored) : NaN
        const preferred = Number.isFinite(parsed) ? parsed : null
        if (preferred != null) preferredSelectedSessionIdRef.current = preferred
        await loadSessions(preferred)
      } catch {
        await loadSessions(null)
      }
    })()
  }, [coachId, loadSessions])

  useEffect(() => {
    if (coachId == null) return
    if (selectedSessionId == null) return

    preferredSelectedSessionIdRef.current = selectedSessionId
    void AsyncStorage.setItem(selectedSessionStorageKey(coachId), String(selectedSessionId))

    setInfoLoading(true)
    setInfoError(null)
    void (async () => {
      try {
        const meta = await getTrainingSessionInfoBySessionId(selectedSessionId)
        setInfoMeta(meta)
        setEditTitle(String(meta?.title || selectedSession?.title || ''))
        setEditDescription(String(meta?.description || selectedSession?.description || ''))
        setEditCap(meta?.participants_cap != null ? String(meta.participants_cap) : '')
      } catch (e: any) {
        setInfoMeta(null)
        setInfoError(e?.message || String(e))
      } finally {
        setInfoLoading(false)
      }
    })()
  }, [coachId, selectedSessionId, selectedSession?.title, selectedSession?.description])

  useEffect(() => {
    if (coachId == null) return
    if (selectedSessionId == null) return
    void loadBookingsForSession(selectedSessionId)
  }, [coachId, loadBookingsForSession, selectedSessionId])

  useEffect(() => {
    if (coachId == null) return
    if (selectedSessionId == null) return
    void loadBlockedForTarget(selectedSessionId)
  }, [coachId, loadBlockedForTarget, selectedSessionId])

  useEffect(() => {
    if (coachId == null) return
    if (!selectedSession) return
    let cancelled = false

    setHosts([])
    setHostsError(null)
    setHostsLoading(true)
    void (async () => {
      try {
        const hostUserId = selectedSession.coachid
        const ui = await getUserInfoByUserIdCached(hostUserId)
        if (cancelled) return
        setHosts([
          {
            userid: hostUserId,
            name: (ui?.name as string) || `User ${hostUserId}`,
            pfp: (ui?.pfp as string) || null,
          },
        ])
      } catch (e: any) {
        if (cancelled) return
        setHostsError(e?.message || String(e))
      } finally {
        if (cancelled) return
        setHostsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [coachId, selectedSession])

  const onSave = async () => {
    if (!infoMeta?.sessioninfoid) return

    const cap = safeNumberOrNull(editCap)

    setSaving(true)
    setInfoError(null)
    try {
      await updateTrainingSessionInfo(infoMeta.sessioninfoid, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        participants_cap: cap,
      })

      // Refresh after save so the list reflects changes
      await loadSessions(selectedSessionId)
      const meta2 = await getTrainingSessionInfoBySessionId(selectedSessionId as number)
      setInfoMeta(meta2)
    } catch (e: any) {
      setInfoError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const onRefresh = useCallback(() => {
    if (selectedSessionId != null) {
      void Promise.all([loadSessions(selectedSessionId), loadBookingsForSession(selectedSessionId), loadBlockedForTarget(selectedSessionId)])
      return
    }
    void loadSessions(null)
  }, [loadBlockedForTarget, loadBookingsForSession, loadSessions, selectedSessionId])

  const openActionMenuForUser = useCallback((userid: number, name: string, pos?: { x: number; y: number } | null) => {
    setActionUser({ userid, name })
    setActionMenuPos(pos || null)
    setActionMenuVisible(true)
  }, [])

  const onConfirmBlock = useCallback(async () => {
    if (selectedSessionId == null || !actionUser) return
    setBlocking(true)
    setBlockedError(null)
    try {
      await createBlock({ targettype: 'trainingsession', targetid: selectedSessionId, blocked_userid: actionUser.userid })
      setConfirmBlockVisible(false)
      setActionMenuVisible(false)
      await loadBlockedForTarget(selectedSessionId)
    } catch (e: any) {
      setBlockedError(e?.message || String(e))
    } finally {
      setBlocking(false)
    }
  }, [actionUser, loadBlockedForTarget, selectedSessionId])

  const onRequestRemoveBlockedUser = useCallback(
    (userid: number) => {
      const name = blockedNameByUserId[userid] || `User ${userid}`
      setRemoveCandidate({ userid, name })
      setConfirmRemoveVisible(true)
    },
    [blockedNameByUserId],
  )

  const onConfirmRemoveBlockedUser = useCallback(async () => {
    if (selectedSessionId == null || !removeCandidate) return
    setBlockedError(null)
    try {
      await removeBlock({ targettype: 'trainingsession', targetid: selectedSessionId, blocked_userid: removeCandidate.userid })
      setConfirmRemoveVisible(false)
      setRemoveCandidate(null)
      await loadBlockedForTarget(selectedSessionId)
    } catch (e: any) {
      setBlockedError(e?.message || String(e))
    }
  }, [loadBlockedForTarget, removeCandidate, selectedSessionId])

  useEffect(() => {
    if (!blocked.length) return
    let cancelled = false

    const missing = blocked
      .map((b) => b.blocked_userid)
      .filter((id) => id != null)
      .filter((id) => blockedNameByUserId[id] == null)
      .slice(0, 25)

    if (!missing.length) return

    ;(async () => {
      const entries = await Promise.all(
        missing.map(async (id) => {
          try {
            const ui = await getUserInfoByUserIdCached(id)
            const nm = (ui?.name as string) || null
            return { id, name: nm || `User ${id}` }
          } catch {
            return { id, name: `User ${id}` }
          }
        }),
      )
      if (cancelled) return
      setBlockedNameByUserId((prev) => {
        const next = { ...prev }
        for (const e of entries) next[e.id] = e.name
        return next
      })
    })()

    return () => {
      cancelled = true
    }
  }, [blocked, blockedNameByUserId])

  const disabled = coachId == null

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#F0F0F0' }}
        contentContainerStyle={{ padding: 12, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={sessionsLoading || bookingsLoading} onRefresh={onRefresh} />}
      >
      <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 10, marginBottom: 8 }}>My Training Session</Text>

      {disabled && (
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, marginBottom: 4 }}>Sign in required</Text>
          <Text style={{ color: '#555' }}>Log in to see training sessions you created.</Text>
        </View>
      )}

      {!!sessionsError && (
        <View style={{ padding: 14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#FECACA', marginBottom: 12 }}>
          <Text style={{ color: '#B91C1C', fontWeight: '700' }}>Failed loading sessions</Text>
          <Text style={{ color: '#991B1B', marginTop: 6 }}>{sessionsError}</Text>
        </View>
      )}

      {sessionsLoading ? (
        <View style={{ paddingVertical: 18 }}>
          <ActivityIndicator />
        </View>
      ) : sessions.length === 0 ? (
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, marginBottom: 4 }}>No training sessions yet</Text>
          <Text style={{ color: '#555' }}>Create a training session to manage participants here.</Text>
          <TouchableOpacity
            style={{ marginTop: 10, backgroundColor: '#16a34a', paddingVertical: 10, borderRadius: 10, alignItems: 'center' }}
            onPress={() => router.push('/event/tsCreate' as any)}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Create Training Session</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          removeClippedSubviews={false}
          style={{ overflow: 'visible' }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 18, paddingBottom: 12 }}
        >
          {sessions.map((s) => {
            const selected = s.sessionid === selectedSessionId
            const accent = '#16a34a'
            const silhouette = fallbackSilhouetteBySessionId(s.sessionid)
            return (
              <View key={s.sessionid} style={{ width: 288, marginRight: 18, overflow: 'visible' }}>
                {selected && (
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      top: -3,
                      left: -3,
                      right: -3,
                      bottom: -3,
                      borderRadius: 17,
                      backgroundColor: 'rgba(255,255,255,0.92)',
                      opacity: 1,
                    }}
                  />
                )}
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    borderRadius: 14,
                    backgroundColor: '#ffffff',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: selected ? 0.22 : 0.12,
                    shadowRadius: selected ? 14 : 8,
                    elevation: selected ? 12 : 6,
                  }}
                />
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => setSelectedSessionId(s.sessionid)}
                  style={{
                    width: '100%',
                    borderRadius: 14,
                    backgroundColor: selected ? accent : '#ffffff',
                    borderWidth: 1,
                    borderColor: selected ? 'rgba(255,255,255,0.55)' : '#e5e7eb',
                    borderLeftWidth: 5,
                    borderLeftColor: accent,
                    padding: 14,
                    minHeight: 118,
                    overflow: 'hidden',
                  }}
                >
                  <Image
                    source={silhouette}
                    resizeMode="contain"
                    style={{
                      position: 'absolute',
                      top: -14,
                      right: -18,
                      width: 128,
                      height: 128,
                      opacity: selected ? 0.26 : 0.14,
                      tintColor: selected ? '#ffffff' : accent,
                      zIndex: 0,
                    }}
                  />
                  <Text numberOfLines={1} style={{ fontWeight: '900', fontSize: 16, color: selected ? '#fff' : '#111' }}>
                    {s.title || `Session #${s.sessionid}`}
                  </Text>
                  <Text style={{ marginTop: 6, color: selected ? 'rgba(255,255,255,0.92)' : '#555', fontWeight: '700', fontSize: 12 }}>
                    {formatSessionDateLabel(s)}
                  </Text>
                  <Text
                    style={{
                      color: selected ? '#ecfdf5' : '#374151',
                      marginTop: 'auto',
                      paddingBottom: 2,
                      fontSize: 12,
                      fontWeight: '900',
                      letterSpacing: 0.6,
                    }}
                  >
                    PARTICIPANTS: {s.numberofpeople ?? 0}/{s.participants_cap ?? '-'}
                  </Text>
                </TouchableOpacity>

                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: -24,
                    right: -24,
                    width: 56,
                    height: 56,
                    zIndex: 200,
                    elevation: 24,
                    opacity: selected ? 0.95 : 0.9,
                  }}
                >
                  <Image source={ICONS.eventDeco} resizeMode="contain" style={{ width: 48, height: 48, bottom: -13, right: -8 }} />
                </View>
              </View>
            )
          })}
        </ScrollView>
      )}

      {sessions.length > 0 && selectedSessionId != null && (
        <>
          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 10, marginBottom: 8 }}>Applicant List</Text>
          {bookingsError && <Text style={{ color: 'red', marginBottom: 8 }}>Failed to load applicants: {bookingsError}</Text>}

          {bookingsLoading ? (
            <View style={{ paddingVertical: 18 }}>
              <ActivityIndicator />
            </View>
          ) : applicants.length === 0 ? (
            <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
              <Text style={{ color: '#555' }}>No pending requests.</Text>
            </View>
          ) : (
            <View>
              {applicants.map((a) => (
                <View
                  key={a.booking.tsbookingid}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 12,
                    padding: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 10,
                  }}
                >
                  <TouchableOpacity
                    activeOpacity={0.75}
                    onPress={() =>
                      router.push({ pathname: '/event/profileSpectate', params: { userid: String(a.booking.userid) } } as any)
                    }
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                  >
                    {a.pfp ? (
                      <Image source={{ uri: a.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5E7EB' }} />
                    ) : (
                      <Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />
                    )}

                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={{ fontWeight: '800', fontSize: 14 }} numberOfLines={1}>
                        {a.name}
                      </Text>
                      {!isFree && (
                        <Text style={{ color: '#555', marginTop: 2 }} numberOfLines={1}>
                          {a.paymentLabel}
                        </Text>
                      )}
                      {isFree && <FreeBadge />}
                    </View>
                  </TouchableOpacity>

                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <TouchableOpacity
                      disabled={!!mutatingBookingIds[a.booking.tsbookingid]}
                      onPress={() => onApproveApplicant(selectedSessionId, a.booking)}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: '#dcfce7',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 10,
                        opacity: mutatingBookingIds[a.booking.tsbookingid] ? 0.6 : 1,
                      }}
                    >
                      {mutatingBookingIds[a.booking.tsbookingid] === 'approve' ? (
                        <ActivityIndicator size={14} />
                      ) : (
                        <Image source={ICONS.approve} style={{ width: 18, height: 18 }} resizeMode="contain" />
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      disabled={!!mutatingBookingIds[a.booking.tsbookingid]}
                      onPress={() => onRejectApplicant(selectedSessionId, a.booking)}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: '#fee2e2',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: mutatingBookingIds[a.booking.tsbookingid] ? 0.6 : 1,
                      }}
                    >
                      {mutatingBookingIds[a.booking.tsbookingid] === 'reject' ? (
                        <ActivityIndicator size={14} />
                      ) : (
                        <Image source={ICONS.reject} style={{ width: 18, height: 18 }} resizeMode="contain" />
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={(e) => {
                        openActionMenuForUser(a.booking.userid, a.name, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
                      }}
                      style={{
                        padding: 6,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginLeft: 8,
                      }}
                    >
                      <Image source={ICONS.dotdotdot} style={{ width: 18, height: 18, tintColor: '#111827' }} resizeMode="contain" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Participant List</Text>
          {bookingsLoading ? (
            <View style={{ paddingVertical: 18 }}>
              <ActivityIndicator />
            </View>
          ) : participants.length === 0 ? (
            <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
              <Text style={{ color: '#555' }}>No participants yet.</Text>
            </View>
          ) : (
            <View>
              {participants.map((p) => (
                <View
                  key={p.booking.tsbookingid}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 12,
                    padding: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 10,
                  }}
                >
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={(e) => {
                      openActionMenuForUser(p.booking.userid, p.name, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
                    }}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                  >
                    {p.pfp ? (
                      <Image source={{ uri: p.pfp }} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#E5E7EB' }} />
                    ) : (
                      <Image source={ICONS.accountCircle} style={{ width: 40, height: 40 }} resizeMode="contain" />
                    )}
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={{ fontWeight: '800', fontSize: 14 }} numberOfLines={1}>
                        {p.name}
                      </Text>
                      {!isFree ? (
                        <Text style={{ color: '#555', marginTop: 2 }} numberOfLines={1}>
                          {p.paymentLabel}
                        </Text>
                      ) : (
                        <FreeBadge />
                      )}
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={(e) => {
                      openActionMenuForUser(p.booking.userid, p.name, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })
                    }}
                    style={{
                      padding: 6,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Image source={ICONS.dotdotdot} style={{ width: 18, height: 18, tintColor: '#111827' }} resizeMode="contain" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Host List</Text>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
            {hostsError ? (
              <Text style={{ color: '#B91C1C', fontWeight: '700' }}>{hostsError}</Text>
            ) : hostsLoading ? (
              <View style={{ paddingVertical: 12 }}>
                <ActivityIndicator />
              </View>
            ) : hosts.length === 0 ? (
              <Text style={{ color: '#555' }}>No hosts yet.</Text>
            ) : (
              <View>
                {hosts.map((h) => (
                  <TouchableOpacity
                    key={h.userid}
                    activeOpacity={0.75}
                    onPress={() => router.push({ pathname: '/event/profileSpectate', params: { userid: String(h.userid) } } as any)}
                    style={{ flexDirection: 'row', alignItems: 'center' }}
                  >
                    {h.pfp ? (
                      <Image source={{ uri: h.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5E7EB' }} />
                    ) : (
                      <Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />
                    )}
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text style={{ fontWeight: '800', fontSize: 14 }} numberOfLines={1}>
                        {h.name}
                      </Text>
                      <Text style={{ color: '#555', marginTop: 2 }} numberOfLines={1}>
                        Host
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Staff List</Text>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
            <Text style={{ color: '#555' }}>No staff yet.</Text>
          </View>

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Block List</Text>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
            <View style={{ flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' }}>
              <Text style={{ flex: 1.2, fontWeight: '800', color: '#111827' }}>User</Text>
              <Text style={{ flex: 1.4, fontWeight: '800', color: '#111827' }}>Blocked At</Text>
              <Text style={{ flex: 1.0, fontWeight: '800', color: '#111827', textAlign: 'right' }} />
            </View>

            {!!blockedError && <Text style={{ color: '#B91C1C', fontWeight: '700', marginTop: 10 }}>{blockedError}</Text>}

            {blockedLoading ? (
              <View style={{ paddingVertical: 12 }}>
                <ActivityIndicator />
              </View>
            ) : blocked.length === 0 ? (
              <Text style={{ color: '#555', marginTop: 10 }}>No blocked users.</Text>
            ) : (
              <View style={{ marginTop: 8 }}>
                {blocked.map((b) => (
                  <View key={b.blockid} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }}>
                    <TouchableOpacity
                      activeOpacity={0.75}
                      onPress={() => router.push({ pathname: '/event/profileSpectate', params: { userid: String(b.blocked_userid) } } as any)}
                      style={{ flex: 1.2 }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }} numberOfLines={1}>
                        {blockedNameByUserId[b.blocked_userid] || `User ${b.blocked_userid}`}
                      </Text>
                    </TouchableOpacity>
                    <Text style={{ flex: 1.4, fontSize: 14, fontWeight: '800', color: '#111827' }} numberOfLines={1}>
                      {b.blocked_at ? String(b.blocked_at).slice(0, 10) : '-'}
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={() => onRequestRemoveBlockedUser(b.blocked_userid)}
                      style={{ flex: 1.0, alignItems: 'flex-end' }}
                    >
                      <Text style={{ color: '#2563eb', fontWeight: '900', textDecorationLine: 'underline' }}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Modify */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 14,
              marginBottom: 8,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '700' }}>Event Modify</Text>
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={() => router.push((`/event/details?id=created_session_${selectedSessionId}` as any) as any)}
              style={{ paddingHorizontal: 6, paddingVertical: 4 }}
            >
              <Text style={{ color: '#2563eb', fontWeight: '800', textDecorationLine: 'underline' }}>Details</Text>
            </TouchableOpacity>
          </View>

          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12 }}>
            {infoLoading ? (
              <View style={{ paddingVertical: 18 }}>
                <ActivityIndicator />
              </View>
            ) : infoError ? (
              <Text style={{ color: '#B91C1C', fontWeight: '700' }}>{infoError}</Text>
            ) : (
              <>
                <Text style={{ fontWeight: '700', marginBottom: 6 }}>Title</Text>
                <TextInput
                  value={editTitle}
                  onChangeText={setEditTitle}
                  placeholder="Event title"
                  style={{ backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 }}
                />

                <Text style={{ fontWeight: '700', marginBottom: 6 }}>Description</Text>
                <TextInput
                  value={editDescription}
                  onChangeText={setEditDescription}
                  placeholder="Description"
                  multiline
                  style={{
                    backgroundColor: '#f3f4f6',
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    minHeight: 70,
                    marginBottom: 10,
                  }}
                />

                <Text style={{ fontWeight: '700', marginBottom: 6 }}>Participants cap</Text>
                <TextInput
                  value={editCap}
                  onChangeText={setEditCap}
                  placeholder="e.g. 20"
                  keyboardType="numeric"
                  style={{ backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 }}
                />

                <TouchableOpacity
                  disabled={saving}
                  onPress={onSave}
                  style={{
                    backgroundColor: saving ? '#9ca3af' : '#16a34a',
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{saving ? 'Saving...' : 'Save changes'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </>
      )}
      </ScrollView>

    <Modal transparent visible={actionMenuVisible} animationType="fade" onRequestClose={() => setActionMenuVisible(false)}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.01)' }} onPress={() => setActionMenuVisible(false)}>
        {(() => {
          const { width, height } = Dimensions.get('window')
          const MENU_W = 170
          const MENU_H = 92
          const x = actionMenuPos?.x ?? 16
          const y = actionMenuPos?.y ?? 120
          const left = Math.min(Math.max(x - MENU_W + 18, 12), Math.max(12, width - MENU_W - 12))
          const top = Math.min(y + 10, Math.max(12, height - MENU_H - 12))
          return (
            <Pressable
              style={{
                position: 'absolute',
                left,
                top,
                width: MENU_W,
                backgroundColor: '#fff',
                borderRadius: 12,
                paddingVertical: 6,
                shadowColor: '#000',
                shadowOpacity: 0.15,
                shadowRadius: 12,
                elevation: 6,
              }}
              onPress={() => {}}
            >
              <TouchableOpacity activeOpacity={0.75} onPress={() => setActionMenuVisible(false)} style={{ paddingVertical: 10, paddingHorizontal: 12 }}>
                <Text style={{ fontWeight: '800', color: '#111827' }}>Report</Text>
              </TouchableOpacity>
              <View style={{ height: 1, backgroundColor: '#e5e7eb' }} />
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={() => {
                  setActionMenuVisible(false)
                  setConfirmBlockVisible(true)
                }}
                style={{ paddingVertical: 10, paddingHorizontal: 12 }}
              >
                <Text style={{ fontWeight: '900', color: '#B91C1C' }}>Block</Text>
              </TouchableOpacity>
            </Pressable>
          )
        })()}
      </Pressable>
    </Modal>

    <Modal transparent visible={confirmRemoveVisible} animationType="fade" onRequestClose={() => setConfirmRemoveVisible(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 18 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>Confirm Remove</Text>
          <Text style={{ marginTop: 8, color: '#374151' }}>Remove this user from block list ?</Text>
          <View style={{ flexDirection: 'row', marginTop: 14 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                setConfirmRemoveVisible(false)
                setRemoveCandidate(null)
              }}
              style={{ flex: 1, backgroundColor: '#f3f4f6', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginRight: 10 }}
            >
              <Text style={{ fontWeight: '800', color: '#111827' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={onConfirmRemoveBlockedUser}
              style={{ flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 12, alignItems: 'center' }}
              disabled={removeCandidate == null}
            >
              <Text style={{ fontWeight: '900', color: '#fff' }}>Remove</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    <Modal transparent visible={confirmBlockVisible} animationType="fade" onRequestClose={() => setConfirmBlockVisible(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 18 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>Confirm Block</Text>
          <Text style={{ marginTop: 8, color: '#374151' }}>Are you sure you want to block this user ?</Text>
          <View style={{ flexDirection: 'row', marginTop: 14 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setConfirmBlockVisible(false)}
              style={{ flex: 1, backgroundColor: '#f3f4f6', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginRight: 10 }}
              disabled={blocking}
            >
              <Text style={{ fontWeight: '800', color: '#111827' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={onConfirmBlock}
              style={{ flex: 1, backgroundColor: blocking ? '#9ca3af' : '#B91C1C', paddingVertical: 12, borderRadius: 12, alignItems: 'center' }}
              disabled={blocking}
            >
              <Text style={{ fontWeight: '900', color: '#fff' }}>{blocking ? 'Blocking...' : 'Block'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </View>
  )
}
