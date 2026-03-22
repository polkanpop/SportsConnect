import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
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
import { Image as ExpoImage } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { queryKeys } from '@/hooks/query-keys'
import { SkeletonBox, SkeletonPulse } from '@/components/ui/skeleton'
import { useQueryClient } from '@tanstack/react-query'
import {
  approveTrainingSessionBooking,
  type CombinedTrainingSession,
  cloudinarySignUpload,
  createBlock,
  deleteCloudinaryAssetsByUrl,
  getPayment,
  getTrainingSessionInfoBySessionId,
  getTrainingSessionBookingsBySessionId,
  invalidateEventsCombinedCache,
  invalidateTrainingSessionsCombinedCache,
  getUserInfoByUserIdCached,
  listBlockList,
  listTrainingSessionsCombinedByCoachId,
  removeBlock,
  rejectTrainingSessionBooking,
  type BlockListRow,
  type TrainingSessionBookingRow,
  type TrainingSessionInfoMeta,
  updateTrainingSession,
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

function parseTimestampLoose(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  let d = new Date(s)
  if (!Number.isNaN(d.getTime())) return d
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/)
  if (m) {
    d = new Date(`${m[1]}T${m[2]}:00`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function isHiddenSessionStatus(statusRaw: unknown): boolean {
  const st = String(statusRaw ?? '').trim().toLowerCase()
  return st === 'completed' || st === 'cancelled'
}

function isPastSessionLoose(s: any): boolean {
  const end = parseTimestampLoose(s?.end_timestamp ?? null)
  const start = parseTimestampLoose(s?.time ?? s?.start_timestamp ?? null)
  const now = Date.now()
  if (end) return end.getTime() < now
  if (start) return start.getTime() < now
  return false
}

function formatSessionDateLabel(session: { time?: string | null }) {
  const candidate = String(session.time || '').trim()
  const d = candidate ? parseTimestampLoose(candidate) : null
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

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
const IMAGE_TILE_HEIGHT = 120

const CLOUDINARY_DELIVERY_WIDTH = 1280
const CLOUDINARY_DELIVERY_HEIGHT = Math.max(
  1,
  Math.round((CLOUDINARY_DELIVERY_WIDTH * IMAGE_TILE_HEIGHT) / Math.max(1, IMAGE_TILE_WIDTH)),
)

const dedupeStrings = (arr: string[]) => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    const v = String(s || '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const applyCloudinaryDeliveryOptimizations = (secureUrl: string) => {
  try {
    const marker = '/upload/'
    const idx = secureUrl.indexOf(marker)
    if (idx < 0) return secureUrl
    const before = secureUrl.slice(0, idx + marker.length)
    const after = secureUrl.slice(idx + marker.length)
    const transform = `c_fill,w_${CLOUDINARY_DELIVERY_WIDTH},h_${CLOUDINARY_DELIVERY_HEIGHT},q_auto,f_auto`
    return `${before}${transform}/${after}`
  } catch {
    return secureUrl
  }
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
  const queryClient = useQueryClient()
  const mountedRef = useRef(true)
  const sessionsLoadIdRef = useRef(0)
  const bookingsLoadIdRef = useRef(0)
  const preferredSelectedSessionIdRef = useRef<number | null>(null)

  const [sessions, setSessions] = useState<CombinedTrainingSession[]>([])
  // Stable ref — avoids recreating loadBookingsForSession on every count bump
  const sessionsRef = useRef<CombinedTrainingSession[]>([])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
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

  const [pullRefreshing, setPullRefreshing] = useState(false)

  const [actionMenuVisible, setActionMenuVisible] = useState(false)
  const [actionUser, setActionUser] = useState<{ userid: number; name: string } | null>(null)
  const [actionMenuPos, setActionMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [confirmBlockVisible, setConfirmBlockVisible] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [confirmRemoveVisible, setConfirmRemoveVisible] = useState(false)
  const [removeCandidate, setRemoveCandidate] = useState<{ userid: number; name: string } | null>(null)
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<number>>(new Set())

  const [infoMeta, setInfoMeta] = useState<TrainingSessionInfoMeta | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)

  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCap, setEditCap] = useState('')
  const [editImages, setEditImages] = useState<string[]>([])
  const [imageUploading, setImageUploading] = useState(false)

  const [removeImageConfirmVisible, setRemoveImageConfirmVisible] = useState(false)
  const [removeImageCandidateUri, setRemoveImageCandidateUri] = useState<string | null>(null)

  const [pendingCloudinaryDeletes, setPendingCloudinaryDeletes] = useState<string[]>([])

  const lastHydratedSessionIdRef = useRef<number | null>(null)
  const initialEditSnapshotRef = useRef<string>('')
  const isDirtyRef = useRef<boolean>(false)
  const [editBaselineSnapshot, setEditBaselineSnapshot] = useState<string>('')

  const makeEditSnapshot = useCallback((payload: { title: string; description: string; cap: string; images: string[] }) => {
    const title = String(payload.title || '').trim()
    const description = String(payload.description || '')
    const cap = String(payload.cap || '').trim()
    const images = dedupeStrings(Array.isArray(payload.images) ? payload.images : [])
    return JSON.stringify({ title, description, cap, images })
  }, [])

  const currentEditSnapshot = useMemo(() => {
    return makeEditSnapshot({ title: editTitle, description: editDescription, cap: editCap, images: editImages })
  }, [editCap, editDescription, editImages, editTitle, makeEditSnapshot])

  const isDirty = useMemo(() => {
    if (!editBaselineSnapshot) return false
    return currentEditSnapshot !== editBaselineSnapshot
  }, [currentEditSnapshot, editBaselineSnapshot])

  useEffect(() => {
    isDirtyRef.current = isDirty
  }, [isDirty])

  const [saving, setSaving] = useState(false)
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null)
  const saveSuccessTimerRef = useRef<any>(null)

  useEffect(() => {
    if (!saveSuccessMessage) return
    if (saveSuccessTimerRef.current) clearTimeout(saveSuccessTimerRef.current)
    saveSuccessTimerRef.current = setTimeout(() => {
      setSaveSuccessMessage(null)
    }, 2200)
    return () => {
      if (saveSuccessTimerRef.current) clearTimeout(saveSuccessTimerRef.current)
    }
  }, [saveSuccessMessage])

  const invalidateMutationCaches = useCallback(async () => {
    await Promise.allSettled([
      invalidateEventsCombinedCache(),
      invalidateTrainingSessionsCombinedCache(),
    ])
    // NOTE: Do NOT invalidateQueries(dashboard) — triggers stale Redis re-fetch that can wipe new data
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'details' })
  }, [queryClient])

  const [confirmCancelVisible, setConfirmCancelVisible] = useState(false)
  const [cancellingSession, setCancellingSession] = useState(false)

  const uploadOneToCloudinary = useCallback(
    async (localUri: string, idx: number) => {
      if (typeof coachId !== 'number') throw new Error('Not signed in')

      const resized = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 800 } }],
        { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG },
      )

      const publicId = `session_${coachId}_${Date.now()}_${idx}`
      const sign = await cloudinarySignUpload({ public_id: publicId, overwrite: true } as any)
      const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(sign.cloudName)}/image/upload`

      const form = new FormData()
      form.append('file', {
        uri: resized.uri,
        name: `${publicId}.jpg`,
        type: 'image/jpeg',
      } as any)
      form.append('api_key', sign.apiKey)
      form.append('timestamp', String(sign.timestamp))
      form.append('signature', sign.signature)
      if (sign.uploadPreset) form.append('upload_preset', String(sign.uploadPreset))
      if (sign.folder) form.append('folder', String(sign.folder))
      form.append('public_id', publicId)
      form.append('overwrite', 'true')

      const resp = await fetch(endpoint, { method: 'POST', body: form })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) {
        const msg = json?.error?.message || `Upload failed (HTTP ${resp.status})`
        throw new Error(msg)
      }
      const secureUrl: string | undefined = json?.secure_url
      if (!secureUrl) throw new Error('Upload succeeded but missing secure_url')
      return applyCloudinaryDeliveryOptimizations(secureUrl)
    },
    [coachId],
  )

  const pickImage = useCallback(async () => {
    if (imageUploading) return
    if (typeof coachId !== 'number') {
      Alert.alert('Not signed in', 'Please sign in first.')
      return
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Please allow photo library access to select images.')
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      allowsEditing: true,
      aspect: [IMAGE_TILE_WIDTH, IMAGE_TILE_HEIGHT],
      quality: 0.9,
    } as any)

    if (result.canceled) return
    const picked = (result.assets || []).map((a) => a.uri).filter(Boolean)
    if (picked.length === 0) return

    setImageUploading(true)
    try {
      const uploadedUrl = await uploadOneToCloudinary(picked[0], editImages.length)
      setEditImages((prev) => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
      setPendingCloudinaryDeletes((prev) => prev.filter((u) => u !== uploadedUrl))
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || String(e))
    } finally {
      setImageUploading(false)
    }
  }, [coachId, editImages.length, imageUploading, uploadOneToCloudinary])

  const requestRemoveImage = useCallback((uri: string) => {
    setRemoveImageCandidateUri(uri)
    setRemoveImageConfirmVisible(true)
  }, [])

  const onConfirmRemoveImage = useCallback(() => {
    if (removeImageCandidateUri) {
      setPendingCloudinaryDeletes((prev) => (prev.includes(removeImageCandidateUri) ? prev : [...prev, removeImageCandidateUri]))
      setEditImages((prev) => prev.filter((u) => u !== removeImageCandidateUri))
    }
    setRemoveImageConfirmVisible(false)
    setRemoveImageCandidateUri(null)
  }, [removeImageCandidateUri])

  const canCancelSelectedSession = useMemo(() => {
    const s = String((selectedSession as any)?.status ?? '').toLowerCase()
    if (!s) return true
    if (s.includes('cancel') || s.includes('complete')) return false
    return s.includes('upcoming') || s.includes('active') || s.includes('scheduled')
  }, [selectedSession])

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
        const filtered = normalized.filter((s) => {
          if (isHiddenSessionStatus((s as any)?.status)) return false
          if (isPastSessionLoose(s)) return false
          return true
        })
        setSessions(filtered)
        if (filtered.length === 0) {
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
          const has = (id: number | null) => id != null && filtered.some((s) => s.sessionid === id)
          if (preferred != null && has(preferred)) return preferred
          if (has(prev)) return prev
          return filtered[0].sessionid
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
        const toMillis = (v: any): number | null => {
          if (typeof v !== 'string') return null
          const s = v.trim()
          if (!s) return null
          const d = new Date(s)
          return Number.isFinite(d.getTime()) ? d.getTime() : null
        }
        const meta = sessionsRef.current.find((s) => s.sessionid === sessionId)
        const scopeStart = toMillis((meta as any)?.time ?? (meta as any)?.start_timestamp ?? null)
        const scopeEnd = toMillis((meta as any)?.end_timestamp ?? null)
        const inScope = (row: TrainingSessionBookingRow) => {
          if (Number((row as any)?.sessionid) !== Number(sessionId)) return false
          const rowStart = toMillis((row as any)?.time ?? (row as any)?.start_timestamp ?? null)
          const rowEnd = toMillis((row as any)?.end_timestamp ?? null)
          if (scopeStart != null && rowStart != null && rowStart !== scopeStart) return false
          if (scopeEnd != null && rowEnd != null && rowEnd !== scopeEnd) return false
          return true
        }
        const dedupeByUser = (rows: TrainingSessionBookingRow[]) => {
          const scoped = rows.filter(inScope)
          const sorted = [...scoped].sort((a, b) => Number(b.tsbookingid || 0) - Number(a.tsbookingid || 0))
          const seen = new Set<number>()
          const out: TrainingSessionBookingRow[] = []
          for (const row of sorted) {
            const uid = Number(row.userid)
            if (!Number.isFinite(uid) || seen.has(uid)) continue
            seen.add(uid)
            out.push(row)
          }
          return out
        }
        if (!mountedRef.current || loadId !== bookingsLoadIdRef.current) return
        const [pending, joined] = await Promise.all([
          enrichBookings(dedupeByUser(Array.isArray(pendingRows) ? pendingRows : [])),
          enrichBookings(dedupeByUser(Array.isArray(joinedRows) ? joinedRows : [])),
        ])
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
      const bookingId = booking.tsbookingid
      if (mutatingBookingIds[bookingId]) return
      if (String(booking.status || '').toLowerCase() !== 'pending') return
      const approvedApplicant = applicants.find((x) => x.booking.tsbookingid === bookingId) || null
      setMutatingBookingIds((m) => ({ ...m, [booking.tsbookingid]: 'approve' }))
      try {
        await approveTrainingSessionBooking(booking.tsbookingid)
        setApplicants((prev) => prev.filter((x) => x.booking.tsbookingid !== bookingId))
        if (approvedApplicant) {
          setParticipants((prev) => {
            if (prev.some((x) => x.booking.tsbookingid === bookingId)) return prev
            return [{ ...approvedApplicant, booking: { ...approvedApplicant.booking, status: 'joined' } as any }, ...prev]
          })
        }
        setSessions((prev) => prev.map((s) => {
          if (s.sessionid !== sessionId) return s
          const cur = Number((s as any)?.numberofpeople)
          const next = Number.isFinite(cur) ? cur + 1 : 1
          return { ...s, numberofpeople: next }
        }))
        queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => {
            if (row?.sessionid !== sessionId) return row
            const cur = Number(row?.numberofpeople)
            const next = Number.isFinite(cur) ? cur + 1 : 1
            return { ...row, numberofpeople: next }
          })
        })
        await invalidateMutationCaches()
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
    [applicants, invalidateMutationCaches, queryClient],
  )

  const onRejectApplicant = useCallback(
    async (sessionId: number, booking: TrainingSessionBookingRow) => {
      if (mutatingBookingIds[booking.tsbookingid]) return
      if (String(booking.status || '').toLowerCase() !== 'pending') return
      setMutatingBookingIds((m) => ({ ...m, [booking.tsbookingid]: 'reject' }))
      try {
        await rejectTrainingSessionBooking(booking.tsbookingid)
        setApplicants((prev) => prev.filter((x) => x.booking.tsbookingid !== booking.tsbookingid))
        await invalidateMutationCaches()
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
    [invalidateMutationCaches],
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

    const isNewSelection = lastHydratedSessionIdRef.current !== selectedSessionId
    if (!isNewSelection && isDirtyRef.current) return
    lastHydratedSessionIdRef.current = selectedSessionId
    setPendingCloudinaryDeletes([])

    preferredSelectedSessionIdRef.current = selectedSessionId
    void AsyncStorage.setItem(selectedSessionStorageKey(coachId), String(selectedSessionId))

    setInfoLoading(true)
    setInfoError(null)
    void (async () => {
      try {
        const meta = await getTrainingSessionInfoBySessionId(selectedSessionId)
        setInfoMeta(meta)
        const nextTitle = String(meta?.title || selectedSession?.title || '')
        const nextDesc = String(meta?.description || selectedSession?.description || '')
        const nextCap = meta?.participants_cap != null ? String(meta.participants_cap) : ''
        const nextImages = asStringArray((meta as any)?.images)
        setEditTitle(nextTitle)
        setEditDescription(nextDesc)
        setEditCap(nextCap)
        setEditImages(nextImages)

        const snap = makeEditSnapshot({ title: nextTitle, description: nextDesc, cap: nextCap, images: nextImages })
        initialEditSnapshotRef.current = snap
        setEditBaselineSnapshot(snap)
      } catch (e: any) {
        setInfoMeta(null)
        setInfoError(e?.message || String(e))
      } finally {
        setInfoLoading(false)
      }
    })()
  }, [coachId, makeEditSnapshot, selectedSessionId, selectedSession?.description, selectedSession?.title])

  useEffect(() => {
    if (coachId == null) return
    if (selectedSessionId == null) return
    void loadBookingsForSession(selectedSessionId)
  // NOTE: loadBookingsForSession is stable (sessions read via ref), intentionally omitted from deps
  // to prevent: setSessions (count bump) → recreate callback → fire this effect → reload applicants → buttons reappear
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachId, selectedSessionId])

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
    if (!isDirty) return

    const cap = safeNumberOrNull(editCap)

    setSaving(true)
    setInfoError(null)
    setSaveSuccessMessage(null)
    try {
      const nextTitle = editTitle.trim()
      const nextDescription = editDescription.trim()
      const nextImages = dedupeStrings(editImages)
      await updateTrainingSessionInfo(infoMeta.sessioninfoid, {
        title: nextTitle,
        description: nextDescription,
        participants_cap: cap,
        images: nextImages,
      })

      setSessions((prev) => prev.map((s) =>
        s.sessionid === selectedSessionId
          ? { ...s, title: nextTitle, description: nextDescription, participants_cap: cap, images: nextImages }
          : s,
      ))
      queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
        if (!Array.isArray(prev)) return prev
        return prev.map((row: any) =>
          row?.sessionid === selectedSessionId
            ? { ...row, title: nextTitle, description: nextDescription, participants_cap: cap, images: nextImages }
            : row,
        )
      })
      if (typeof coachId === 'number') {
        queryClient.setQueryData(queryKeys.activityHostingSessions(coachId), (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) =>
            row?.sessionid === selectedSessionId
              ? { ...row, title: nextTitle, description: nextDescription, participants_cap: cap, images: nextImages }
              : row,
          )
        })
      }

			const urlsToDelete = pendingCloudinaryDeletes.filter((u) => !editImages.includes(u))
			if (urlsToDelete.length) {
				try {
					await deleteCloudinaryAssetsByUrl(urlsToDelete)
				} catch (e: any) {
					console.warn('[trainingSessionPanel] cloudinary delete failed', e?.message || String(e))
				}
			}

      // Refresh after save so the list reflects changes
      await invalidateMutationCaches()
      setInfoMeta((prev) => prev ? { ...prev, title: nextTitle, description: nextDescription, participants_cap: cap ?? prev.participants_cap ?? null, images: nextImages } : prev)
      initialEditSnapshotRef.current = currentEditSnapshot
      setEditBaselineSnapshot(currentEditSnapshot)
      setPendingCloudinaryDeletes([])
      setSaveSuccessMessage('Training session updated successfully.')
    } catch (e: any) {
      setInfoError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const onConfirmCancelSession = useCallback(async () => {
    if (selectedSessionId == null) return
    if (!canCancelSelectedSession) return

    setCancellingSession(true)
    setSessionsError(null)
    try {
      await updateTrainingSession(selectedSessionId, { status: 'cancelled' } as any)
      setSessions((prev) => prev.map((s) => s.sessionid === selectedSessionId ? { ...s, status: 'cancelled' } : s))
      queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
        if (!Array.isArray(prev)) return prev
        return prev.map((row: any) => row?.sessionid === selectedSessionId ? { ...row, status: 'cancelled' } : row)
      })
      if (typeof coachId === 'number') {
        queryClient.setQueryData(queryKeys.activityHostingSessions(coachId), (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => row?.sessionid === selectedSessionId ? { ...row, status: 'cancelled' } : row)
        })
      }
      setConfirmCancelVisible(false)
      await loadSessions(selectedSessionId)
      await invalidateMutationCaches()
      const detailsId = `created_session_${selectedSessionId}`
      router.replace({ pathname: '/event/statusTransition', params: { anim: 'cancel', detailsId } } as any)
    } catch (e: any) {
      setSessionsError(e?.message || String(e))
    } finally {
      setCancellingSession(false)
    }
  }, [canCancelSelectedSession, coachId, invalidateMutationCaches, loadSessions, queryClient, router, selectedSessionId])

  const onRefresh = useCallback(async () => {
    setPullRefreshing(true)
    try {
      if (selectedSessionId != null) {
        await Promise.all([
          loadSessions(selectedSessionId),
          loadBookingsForSession(selectedSessionId),
          loadBlockedForTarget(selectedSessionId),
        ])
        return
      }
      await loadSessions(null)
    } finally {
      setPullRefreshing(false)
    }
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

  const sessionsPad = 0

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#F0F0F0' }}
        contentContainerStyle={{ padding: 12, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={onRefresh} />}
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
        <SkeletonPulse>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            removeClippedSubviews={false}
            style={{ overflow: 'visible' }}
            contentContainerStyle={{ paddingHorizontal: sessionsPad, paddingTop: 18, paddingBottom: 12 }}
          >
            {Array.from({ length: 2 }).map((_, idx) => (
              <SkeletonBox key={idx} width={288} height={148} radius={14} style={{ marginRight: idx < 1 ? 18 : 0 }} />
            ))}
          </ScrollView>
        </SkeletonPulse>
      ) : sessions.length === 0 ? (
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, marginBottom: 4 }}>No training sessions yet</Text>
          <Text style={{ color: '#555' }}>Create a training session to manage participants here.</Text>
          <TouchableOpacity
            style={{ marginTop: 10, backgroundColor: COLORS.brandOrangeDeep, paddingVertical: 10, borderRadius: 10, alignItems: 'center' }}
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
          contentContainerStyle={{ paddingHorizontal: sessionsPad, paddingTop: 18, paddingBottom: 12 }}
        >
          {sessions.map((s, idx) => {
            const selected = s.sessionid === selectedSessionId
            const accent = '#16a34a'
            const silhouette = fallbackSilhouetteBySessionId(s.sessionid)
            return (
              <View key={s.sessionid} style={{ width: 288, marginRight: idx < sessions.length - 1 ? 18 : 0, overflow: 'visible' }}>
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

                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      top: -14,
                      right: -18,
                      width: 120,
                      height: 120,
                      zIndex: 0,
                    }}
                  >
                    <Image
                      source={silhouette}
                      resizeMode="contain"
                      style={{
                        width: '100%',
                        height: '100%',
                        opacity: selected ? 0.26 : 0.14,
                        tintColor: selected ? '#ffffff' : accent,
                      }}
                    />
                  </View>

                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 46,
                      height: 46,
                      opacity: selected ? 0.95 : 0.9,
                      zIndex: 2,
                    }}
                  >
                    <Image source={ICONS.eventDeco} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
                  </View>

                    <View style={{ flex: 1, minWidth: 0, paddingRight: 56 }}>
                      <Text numberOfLines={2} style={{ fontWeight: '900', fontSize: 16, lineHeight: 18, color: selected ? '#fff' : '#111' }}>
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
                    </View>
                </TouchableOpacity>
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
            <SkeletonPulse>
              <View style={{ paddingVertical: 12 }}>
                {Array.from({ length: 4 }).map((_, idx) => (
                  <SkeletonBox key={idx} width={'100%'} height={72} radius={12} style={{ marginBottom: 10 }} />
                ))}
              </View>
            </SkeletonPulse>
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
                    marginBottom: 10,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity
                    activeOpacity={0.75}
                    onPress={() =>
                      router.push({ pathname: '/event/profileSpectate', params: { userid: String(a.booking.userid) } } as any)
                    }
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                  >
                    {a.pfp ? (
                      <ExpoImage source={{ uri: a.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5E7EB' }} contentFit="cover" />
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

                  {String((a.booking as any)?.status ?? '').toLowerCase() === 'pending' ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {!mutatingBookingIds[a.booking.tsbookingid] && (
                      <>
                        <TouchableOpacity
                          onPress={() => onApproveApplicant(selectedSessionId, a.booking)}
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: '#dcfce7',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 10,
                          }}
                        >
                          <Image source={ICONS.approve} style={{ width: 18, height: 18 }} resizeMode="contain" />
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => onRejectApplicant(selectedSessionId, a.booking)}
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: '#fee2e2',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Image source={ICONS.reject} style={{ width: 18, height: 18 }} resizeMode="contain" />
                        </TouchableOpacity>
                      </>
                    )}

                    <TouchableOpacity
                      activeOpacity={0.75}
                      onPress={() => setExpandedNoteIds(prev => {
                        const n = new Set(prev);
                        if (n.has(a.booking.tsbookingid)) n.delete(a.booking.tsbookingid);
                        else n.add(a.booking.tsbookingid);
                        return n;
                      })}
                      style={{ padding: 6, alignItems: 'center', justifyContent: 'center', marginLeft: 2 }}
                    >
                        <Image source={ICONS.noteIcon} style={{ width: 16, height: 16 }} resizeMode="contain" />
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
                  ) : (
                    <Text style={{ color: '#374151', fontWeight: '700' }}>{String((a.booking as any)?.status || 'updated')}</Text>
                  )}
                  </View>
                  {expandedNoteIds.has(a.booking.tsbookingid) && (
                    <View style={{ marginTop: 8, backgroundColor: '#f9fafb', borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: '#d1d5db' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#374151', marginBottom: 4 }}>Note</Text>
                      <Text style={{ fontSize: 13, color: '#555' }}>{(a.booking as any).note?.trim() ? (a.booking as any).note : 'No note provided.'}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Participant List</Text>
          {bookingsLoading ? (
            <SkeletonPulse>
              <View style={{ paddingVertical: 12 }}>
                {Array.from({ length: 4 }).map((_, idx) => (
                  <SkeletonBox key={idx} width={'100%'} height={72} radius={12} style={{ marginBottom: 10 }} />
                ))}
              </View>
            </SkeletonPulse>
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
                    activeOpacity={0.75}
                    onPress={() => router.push({ pathname: '/event/profileSpectate', params: { userid: String(p.booking.userid) } } as any)}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                  >
                    {p.pfp ? (
                      <ExpoImage source={{ uri: p.pfp }} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#E5E7EB' }} contentFit="cover" />
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
              <SkeletonPulse>
                <View>
                  {Array.from({ length: 3 }).map((_, idx) => (
                    <SkeletonBox
                      key={idx}
                      width={'100%'}
                      height={56}
                      radius={12}
                      style={{ marginBottom: idx < 2 ? 10 : 0 }}
                    />
                  ))}
                </View>
              </SkeletonPulse>
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
                      <ExpoImage source={{ uri: h.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5E7EB' }} contentFit="cover" />
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

          <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 14, marginBottom: 8 }}>Administrator List</Text>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
            <Text style={{ color: '#555' }}>No administrators yet.</Text>
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
              <SkeletonPulse>
                <View style={{ paddingTop: 10 }}>
                  {Array.from({ length: 3 }).map((_, idx) => (
                    <SkeletonBox
                      key={idx}
                      width={'100%'}
                      height={44}
                      radius={10}
                      style={{ marginBottom: idx < 2 ? 10 : 0 }}
                    />
                  ))}
                </View>
              </SkeletonPulse>
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
              onPress={() => router.push({ pathname: '/event/details', params: { id: `created_session_${selectedSessionId}` } } as any)}
              style={{ paddingHorizontal: 6, paddingVertical: 4 }}
            >
              <Text style={{ color: '#2563eb', fontWeight: '800', textDecorationLine: 'underline' }}>Details</Text>
            </TouchableOpacity>
          </View>

          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12 }}>
            {infoLoading ? (
              <SkeletonPulse>
                <View style={{ paddingVertical: 6 }}>
                  <SkeletonBox width={120} height={16} radius={8} style={{ marginBottom: 10 }} />
                  <SkeletonBox width={'100%'} height={44} radius={10} style={{ marginBottom: 14 }} />
                  <SkeletonBox width={140} height={16} radius={8} style={{ marginBottom: 10 }} />
                  <SkeletonBox width={'100%'} height={76} radius={10} style={{ marginBottom: 14 }} />
                  <SkeletonBox width={160} height={16} radius={8} style={{ marginBottom: 10 }} />
                  <SkeletonBox width={120} height={44} radius={10} />
                </View>
              </SkeletonPulse>
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

                <Text style={{ fontWeight: '700', marginBottom: 6 }}>Images</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 6, paddingBottom: 6 }}
                  style={{ marginBottom: 10 }}
                >
                  {editImages.map((uri) => (
                    <View
                      key={uri}
                      style={{
                        width: IMAGE_TILE_WIDTH,
                        height: IMAGE_TILE_HEIGHT,
                        alignSelf: 'flex-start',
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: COLORS.neutral350,
                        borderStyle: 'dashed',
                        backgroundColor: COLORS.neutral0,
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                        <ExpoImage source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                      </View>
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => requestRemoveImage(uri)}
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          backgroundColor: COLORS.neutral0,
                          borderWidth: 1,
                          borderColor: COLORS.neutral200,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 20, lineHeight: 20, fontWeight: '900', color: COLORS.neutral925, marginTop: -1 }}>×</Text>
                      </TouchableOpacity>
                    </View>
                  ))}

                  {editImages.length < 6 && (
                    <View
                      style={{
                        width: IMAGE_TILE_WIDTH,
                        height: IMAGE_TILE_HEIGHT,
                        alignSelf: 'flex-start',
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: COLORS.neutral350,
                        borderStyle: 'dashed',
                        backgroundColor: COLORS.neutral0,
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      <TouchableOpacity
                        activeOpacity={0.85}
                        disabled={imageUploading}
                        onPress={pickImage}
                        style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
                      >
                        {imageUploading ? (
                          <ActivityIndicator size="small" color={COLORS.neutral800} />
                        ) : (
                          <Text style={{ fontSize: 28, fontWeight: '700', color: COLORS.neutral800, marginTop: -1 }}>+</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  )}
                </ScrollView>

                <Modal
                  visible={removeImageConfirmVisible}
                  transparent
                  animationType="fade"
                  onRequestClose={() => {
                    setRemoveImageConfirmVisible(false)
                    setRemoveImageCandidateUri(null)
                  }}
                >
                  <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 18 }}>
                    <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16 }}>
                      <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>Remove image</Text>
                      <Text style={{ marginTop: 8, color: '#374151' }}>Do you want to remove this image?</Text>
                      <View style={{ flexDirection: 'row', marginTop: 14 }}>
                        <TouchableOpacity
                          activeOpacity={0.8}
                          onPress={() => {
                            setRemoveImageConfirmVisible(false)
                            setRemoveImageCandidateUri(null)
                          }}
                          style={{ flex: 1, backgroundColor: '#f3f4f6', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginRight: 10 }}
                        >
                          <Text style={{ fontWeight: '800', color: '#111827' }}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          activeOpacity={0.8}
                          onPress={onConfirmRemoveImage}
                          style={{ flex: 1, backgroundColor: removeImageCandidateUri ? '#2563eb' : '#9ca3af', paddingVertical: 12, borderRadius: 12, alignItems: 'center' }}
                          disabled={!removeImageCandidateUri}
                        >
                          <Text style={{ fontWeight: '900', color: '#fff' }}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                </Modal>

                <Text style={{ fontWeight: '700', marginBottom: 6 }}>Participants cap</Text>
                <TextInput
                  value={editCap}
                  onChangeText={setEditCap}
                  placeholder="e.g. 20"
                  keyboardType="numeric"
                  style={{ backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 }}
                />

                <TouchableOpacity
                  disabled={saving || !isDirty}
                  onPress={onSave}
                  style={{
                    backgroundColor: saving || !isDirty ? '#F4C9A6' : '#16a34a',
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{saving ? 'Saving...' : 'Save changes'}</Text>
                </TouchableOpacity>

                {saveSuccessMessage ? <Text style={{ marginTop: 8, color: '#15803d', fontWeight: '700', textAlign: 'center' }}>{saveSuccessMessage}</Text> : null}

                <TouchableOpacity
                  disabled={cancellingSession || !canCancelSelectedSession}
                  onPress={() => setConfirmCancelVisible(true)}
                  style={{
                    marginTop: 10,
                    backgroundColor: cancellingSession || !canCancelSelectedSession ? '#9ca3af' : '#B91C1C',
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '900' }}>{cancellingSession ? 'Cancelling...' : 'Cancel Session'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </>
      )}
      </ScrollView>

    <Modal transparent visible={confirmCancelVisible} animationType="fade" onRequestClose={() => setConfirmCancelVisible(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 18 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#111827' }}>Confirm Cancel</Text>
          <Text style={{ marginTop: 8, color: '#374151' }}>Are you sure you want to cancel this training session?</Text>
          <View style={{ flexDirection: 'row', marginTop: 14 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setConfirmCancelVisible(false)}
              style={{ flex: 1, backgroundColor: '#f3f4f6', paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginRight: 10 }}
              disabled={cancellingSession}
            >
              <Text style={{ fontWeight: '800', color: '#111827' }}>No</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={onConfirmCancelSession}
              style={{ flex: 1, backgroundColor: cancellingSession ? '#9ca3af' : '#B91C1C', paddingVertical: 12, borderRadius: 12, alignItems: 'center' }}
              disabled={cancellingSession || !canCancelSelectedSession}
            >
              <Text style={{ fontWeight: '900', color: '#fff' }}>{cancellingSession ? 'Cancelling...' : 'Yes'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

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
