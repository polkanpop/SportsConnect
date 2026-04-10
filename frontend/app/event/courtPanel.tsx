import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Dimensions, Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useFocusEffect } from '@react-navigation/native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Image as ExpoImage } from 'expo-image'
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
// MaterialIcons import removed – text labels used instead of icon glyphs

import { useThemeColors } from '@/hooks/use-theme-colors'
import { useTheme } from '@/providers/theme-provider'
import { useTranslation } from '@/constants/translations'
import { COLORS } from '@/constants/colors'
import { ICONS } from '@/constants/icons'
import { optimizeRemoteImageUrl } from '@/lib/imageOptimize'
import { getCache, invalidateCache } from '@/lib/cache'
import { SkeletonBox, SkeletonPulse } from '@/components/ui/skeleton'
import {
  autocompleteCourtAddress,
  cloudinarySignUpload,
  createService,
  deleteCloudinaryAssetsByUrl,
  deleteService,
  geocodeCourtAddress,
  geocodeCourtPlaceId,
  getPlayingCourtInfo,
  getUserInfoByUserIdCached,
  listCourtBookingsByCourtId,
  listPlayingCourtsByCourtId,
  listCourtAvailabilityCached,
  listCourtInfoCached,
  listCourts,
  listServicesByCourtId,
  patchPlayingCourt,
  patchPlayingCourtInfo,
  patchService,
  updateCourtBooking,
  type CourtAddressSuggestion,
  type CourtAvailabilityRow,
  type CourtBookingRow,
  type CourtInfoRow,
  type CourtRow,
  type PlayingCourtInfoRow,
  type PlayingCourtRow,
  type ServiceRow,
  updateCourt,
  updateCourtAvailabilityByPlayingCourtId,
  updateCourtInfoByCourtId,
} from '@/lib/backendApi'

const COURT_REGISTER_VERIFY_STORAGE_KEY = '@courtRegisterVerifiedLocation'

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
type WeekDayKey = typeof WEEK_DAYS[number]

type Venue = 'Indoor' | 'Outdoor' | 'Both'

type EditMode = 'main' | 'sub' | 'booking'

type PlayingCourtPart = 'full' | 'half_a' | 'half_b'

type ServiceEditDraft = {
  localId: string
  serviceid?: number
  name: string
  category: 'consumable' | 'rental'
  price: string
  stock: string
  status: 'active' | 'inactive'
  images: string[]
  deleted?: boolean
}

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
const IMAGE_TILE_HEIGHT = 120

const CLOUDINARY_DELIVERY_WIDTH = 1280
const CLOUDINARY_DELIVERY_HEIGHT = Math.max(
  1,
  Math.round((CLOUDINARY_DELIVERY_WIDTH * IMAGE_TILE_HEIGHT) / Math.max(1, IMAGE_TILE_WIDTH))
)

const canonicalizeAddress = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase()

const digitsOnly = (s: string) => String(s || '').replace(/\D+/g, '')

const clamp = (value: number, min: number, max: number) => {
  'worklet'
  return Math.min(max, Math.max(min, value))
}

const toIntSafe = (value: string) => {
  const d = digitsOnly(value)
  if (!d) return 0
  const n = Number(d)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

const normalizeTimeInput = (v: string) => {
  const raw = String(v || '').replace(/[^0-9]/g, '')
  if (raw.length <= 2) return raw
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`
}

const HHMM_24H_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const hhmmToMinutes = (hhmm: string) => {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/)
  if (!m) return NaN
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return NaN
  return h * 60 + min
}

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

const applyCloudinaryDeliveryOptimizations = (secureUrl: string, shape: 'tile' | 'square' = 'tile') => {
  try {
    const marker = '/upload/'
    const idx = secureUrl.indexOf(marker)
    if (idx < 0) return secureUrl
    const before = secureUrl.slice(0, idx + marker.length)
    const after = secureUrl.slice(idx + marker.length)
    const h = shape === 'square' ? CLOUDINARY_DELIVERY_WIDTH : CLOUDINARY_DELIVERY_HEIGHT
    const transform = `c_fill,w_${CLOUDINARY_DELIVERY_WIDTH},h_${h},q_auto,f_auto`
    return `${before}${transform}/${after}`
  } catch {
    return secureUrl
  }
}

function normalizeVenueToChoice(v: CourtInfoRow['venue']): Venue {
  if (!v) return 'Indoor'
  const raw = Array.isArray(v) ? v : [v]
  const set = new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))
  const hasIn = set.has('Indoor')
  const hasOut = set.has('Outdoor')
  if (hasIn && hasOut) return 'Both'
  if (hasOut) return 'Outdoor'
  return 'Indoor'
}

function parseScheduleDays(value: any): WeekDayKey[] {
  if (!Array.isArray(value)) return [...WEEK_DAYS]
  const filtered = value.filter((d) => typeof d === 'string' && (WEEK_DAYS as readonly string[]).includes(d)) as WeekDayKey[]
  return filtered.length ? filtered : [...WEEK_DAYS]
}

function hhmmFromDbTime(value: any): string {
  const s = String(value || '')
  const m = s.match(/^(\d{2}):(\d{2})/)
  if (!m) return ''
  return `${m[1]}:${m[2]}`
}

function formatYmdToDmy(value: string | null | undefined): string {
  const s = String(value || '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return s
  return `${m[3]}-${m[2]}-${m[1]}`
}

function formatBookingTimeOnly(startRaw: string | null | undefined, endRaw: string | null | undefined, fallback = 'Unknown time'): string {
  const start = String(startRaw || '')
  const end = String(endRaw || '')
  const sm = start.match(/(?:T|\s)(\d{2}:\d{2})/)
  const em = end.match(/(?:T|\s)(\d{2}:\d{2})/)
  const startHm = sm?.[1] || ''
  const endHm = em?.[1] || ''
  if (startHm && endHm) return `${startHm} - ${endHm}`
  if (startHm) return startHm
  if (endHm) return endHm
  return fallback
}

// Builds the main baseline snapshot from raw loaded values (NOT from React state).
// Must stay in exact sync with the currentMainSnapshot useMemo.
function buildMainSnapshotFromRaw(args: {
  name: string
  address: string
  venue: Venue
  autoApprove: boolean
  images: string[]
  serviceDrafts: ServiceEditDraft[]
  venueBaseName?: string
}): string {
  const imagesCanonical = dedupeStrings(args.images).slice().sort()
  const normalizedServices = args.serviceDrafts.map((d) => ({
    key: typeof d.serviceid === 'number' ? `id:${d.serviceid}` : `local:${d.localId}`,
    serviceid: typeof d.serviceid === 'number' ? d.serviceid : null,
    name: String(d.name || '').trim(),
    category: d.category,
    price: toIntSafe(d.price),
    stock: toIntSafe(d.stock),
    status: d.status,
    images: dedupeStrings(Array.isArray(d.images) ? d.images : []).slice().sort(),
    deleted: !!d.deleted,
  }))
  normalizedServices.sort((a, b) => a.key.localeCompare(b.key))
  const baseName = String(args.venueBaseName || '').trim()
  return JSON.stringify({
    name: args.name.trim(),
    address: args.address.trim(),
    venue: args.venue,
    autoApprove: !!args.autoApprove,
    images: imagesCanonical,
    venueBaseFrom: baseName,
    venueBaseTo: baseName,
    verified: null,
    services: normalizedServices,
  })
}

export default function CourtPanel(props: { ownerId: number | null; deeplinkCourtId?: number | null; deeplinkCourtBookingId?: number | null; deeplinkToken?: string | null }) {
  const { ownerId, deeplinkCourtId, deeplinkCourtBookingId, deeplinkToken } = props
  const router = useRouter()
  const { t } = useTranslation()
  const tc = useThemeColors()
  const { isDark } = useTheme()

  const [rows, setRows] = useState<Array<{ court: CourtRow; info: CourtInfoRow | null }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pullRefreshing, setPullRefreshing] = useState(false)

  const [selectedCourtId, setSelectedCourtId] = useState<number | null>(
    typeof deeplinkCourtId === 'number' ? deeplinkCourtId : null
  )

  const selected = useMemo(() => {
    if (selectedCourtId == null) return null
    return rows.find((r) => r.court.courtid === selectedCourtId) || null
  }, [rows, selectedCourtId])

  const [availability, setAvailability] = useState<CourtAvailabilityRow[] | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)

  const [playingCourts, setPlayingCourts] = useState<PlayingCourtRow[]>([])
  const [playingCourtsLoading, setPlayingCourtsLoading] = useState(false)
  const [servicesLoading, setServicesLoading] = useState(false)
  const [serviceDrafts, setServiceDrafts] = useState<ServiceEditDraft[]>([])
  const originalServicesRef = useRef<Map<number, string>>(new Map())

  const [editName, setEditName] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editVenue, setEditVenue] = useState<Venue>('Indoor')
  const [editAutoApprove, setEditAutoApprove] = useState(false)
  const [editImages, setEditImages] = useState<string[]>([])

  const [scheduleDays, setScheduleDays] = useState<WeekDayKey[]>([...WEEK_DAYS])
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('22:00')
  const [availabilityStatus, setAvailabilityStatus] = useState<'available' | 'unavailable'>('available')

  const [editMode, setEditMode] = useState<EditMode>('main')
  const [selectedSubBaseName, setSelectedSubBaseName] = useState<string | null>(null)

  // Booking tab state
  const [courtBookings, setCourtBookings] = useState<CourtBookingRow[]>([])
  const [bookingLoading, setBookingLoading] = useState(false)
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [bookingUserNames, setBookingUserNames] = useState<Record<number, string>>({})
  const [bookingUserPfps, setBookingUserPfps] = useState<Record<number, string | null>>({})
  const [bookingOwner, setBookingOwner] = useState<{ userid: number; name: string; pfp: string | null } | null>(null)
  const [mutatingBookingIds, setMutatingBookingIds] = useState<Record<number, string>>({})
  const [mutatingAttendanceIds, setMutatingAttendanceIds] = useState<Record<number, string>>({})
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<number>>(new Set())
  const [bookingSelectedBaseName, setBookingSelectedBaseName] = useState<string | null>(null)
  const [bookingSelectedPcId, setBookingSelectedPcId] = useState<number | null>(null)
  const [bookingSelectedDate, setBookingSelectedDate] = useState<string | null>(null)
  const [bookingWeekOffset, setBookingWeekOffset] = useState(0)
  const [bookingSelectedSlot, setBookingSelectedSlot] = useState<string | null>(null)

  const [selectedSubPart, setSelectedSubPart] = useState<PlayingCourtPart>('full')
  const [subEditName, setSubEditName] = useState('')
  const [subEditImages, setSubEditImages] = useState<string[]>([])
  const [subInfoLoading, setSubInfoLoading] = useState(false)

  const [selectedVenueCourtBaseName, setSelectedVenueCourtBaseName] = useState<string | null>(null)
  const [venueCourtBaseEditName, setVenueCourtBaseEditName] = useState('')

  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [addressSuggestions, setAddressSuggestions] = useState<CourtAddressSuggestion[]>([])
  const [addressLoading, setAddressLoading] = useState(false)

  const [lastGeocode, setLastGeocode] = useState<{
    address: string
    placeId: string | null
    formatted_address?: string | null
    latitude: number
    longitude: number
    warnings?: string[]
  } | null>(null)

  const [verifiedCoord, setVerifiedCoord] = useState<{ latitude: number; longitude: number; formatted_address?: string | null } | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const [imageUploading, setImageUploading] = useState(false)
  const [removeImageConfirmVisible, setRemoveImageConfirmVisible] = useState(false)
  const [removeImageCandidateUri, setRemoveImageCandidateUri] = useState<string | null>(null)
  const [removeImageContext, setRemoveImageContext] = useState<'main' | 'sub'>('main')

  const [zoomImageUri, setZoomImageUri] = useState<string | null>(null)

  const window = useWindowDimensions()
  const zoomFrameWidth = Math.max(260, Math.min(Math.round(window.width * 0.92), 560))
  const zoomFrameHeight = Math.max(260, Math.min(Math.round(window.height * 0.72), 640))

  const zoomScale = useSharedValue(1)
  const zoomTranslateX = useSharedValue(0)
  const zoomTranslateY = useSharedValue(0)
  const zoomBaseScale = useSharedValue(1)
  const zoomBaseX = useSharedValue(0)
  const zoomBaseY = useSharedValue(0)

  const [serviceExpanded, setServiceExpanded] = useState<Record<string, boolean>>({})

  const [saving, setSaving] = useState(false)

  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null)
  const saveSuccessTimerRef = useRef<any>(null)

  const [pendingCloudinaryDeletesMain, setPendingCloudinaryDeletesMain] = useState<string[]>([])
  const [pendingCloudinaryDeletesSub, setPendingCloudinaryDeletesSub] = useState<string[]>([])

  const [mainBaselineSnapshot, setMainBaselineSnapshot] = useState<string>('')
  const [subBaselineSnapshot, setSubBaselineSnapshot] = useState<string>('')
  const mainDirtyRef = useRef<boolean>(false)
  const subDirtyRef = useRef<boolean>(false)

  const [confirmServiceDeleteVisible, setConfirmServiceDeleteVisible] = useState(false)
  const [serviceDeleteCandidateLocalId, setServiceDeleteCandidateLocalId] = useState<string | null>(null)

  const originalAddressRef = useRef<string>('')
  const venueBaseInitRef = useRef(false)
  // Set to true immediately after sub-save stamps the baseline so the
  // loadSubCourtInfo effect (triggered by playingCourts changing after
  // loadMyCourts) does not overwrite the freshly-stamped baseline.
  const justSavedSubRef = useRef(false)
  const [dataVersion, setDataVersion] = useState(0)

  const loadMyCourts = useCallback(async () => {
    if (typeof ownerId !== 'number') {
      setRows([])
      setSelectedCourtId(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const [courtsAll, infosAll] = await Promise.all([listCourts(), listCourtInfoCached()])
      const mine = (Array.isArray(courtsAll) ? courtsAll : []).filter((c) => {
        const raw = (c as any)?.ownerid
        const oid = typeof raw === 'number' ? raw : Number(raw)
        const cid = (c as any)?.courtid
        return Number.isFinite(oid) && oid === ownerId && typeof cid === 'number' && Number.isFinite(cid)
      })
      const infoById = new Map<number, CourtInfoRow>()
      for (const i of Array.isArray(infosAll) ? infosAll : []) {
        if (i && typeof i.courtid === 'number') infoById.set(i.courtid, i)
      }
      const combined = mine.map((c) => ({ court: c, info: infoById.get(c.courtid) || null }))
      setRows(combined)
      if (combined.length === 0) {
        setSelectedCourtId(null)
      } else {
        setSelectedCourtId((prev) => {
          if (typeof prev === 'number' && combined.some((r) => r.court.courtid === prev)) return prev
          return combined[0].court.courtid
        })
      }
    } catch (e: any) {
      setError(e?.message || String(e))
      setRows([])
      setSelectedCourtId(null)
    } finally {
      setLoading(false)
    }
  }, [ownerId])

  const loadAvailability = useCallback(async (courtid: number) => {
    setAvailabilityLoading(true)
    try {
      const slots = await listCourtAvailabilityCached(courtid)
      setAvailability(Array.isArray(slots) ? (slots as CourtAvailabilityRow[]) : [])
    } catch {
      setAvailability([])
    } finally {
      setAvailabilityLoading(false)
    }
  }, [])

  // Loads ALL court detail data in one async shot, then sets the baseline
  // snapshot from LOCAL variables â€” identical pattern to Event Panel.
  // This avoids the cascading-effect race where schedule state updates one
  // render after the (old) baseline was captured.
  const loadCourtData = useCallback(async (courtRecord: { court: CourtRow; info: CourtInfoRow | null }) => {
    const courtid = courtRecord.court.courtid
    if (typeof courtid !== 'number') return

    setMainBaselineSnapshot('')
    venueBaseInitRef.current = false
    setAvailabilityLoading(true)
    setPlayingCourtsLoading(true)
    setServicesLoading(true)

    try {
      const [availSlots, pcsRaw, svcsRaw] = await Promise.all([
        listCourtAvailabilityCached(courtid),
        listPlayingCourtsByCourtId(courtid),
        listServicesByCourtId(courtid),
      ])

      // ---- Playing courts ----
      const pcsArr = Array.isArray(pcsRaw) ? (pcsRaw as PlayingCourtRow[]) : []
      setPlayingCourts(pcsArr)
      const firstFull = pcsArr.find((p) => String((p as any).part || '').toLowerCase() === 'full')
      const nextBase = firstFull ? String((firstFull as any).base_name || (firstFull as any).name || '').trim() : ''
      setSelectedSubBaseName((prev) => (prev && prev.trim() ? prev : nextBase || null))

      // ---- Availability ----
      const availArr = Array.isArray(availSlots) ? (availSlots as CourtAvailabilityRow[]) : []
      setAvailability(availArr)

      // ---- Schedule (derived here, not in a downstream effect) ----
      const mainPc = pcsArr.find((pc) => String((pc as any).part || '').toLowerCase() === 'full') ?? pcsArr[0] ?? null
      const mainPcId = mainPc ? (mainPc as any).playingcourtid : null
      const mainSlot: any = mainPcId != null
        ? (availArr as any[]).find((s: any) => Number(s?.playingcourtid) === Number(mainPcId))
        : null

      let schedDays: WeekDayKey[]
      let schedStart: string
      let schedEnd: string
      let schedStatus: 'available' | 'unavailable'
      if (mainSlot) {
        schedDays = parseScheduleDays(mainSlot.booking_date)
        schedStart = hhmmFromDbTime(mainSlot.start_time) || '08:00'
        schedEnd = hhmmFromDbTime(mainSlot.end_time) || '22:00'
        schedStatus = String(mainSlot.status || '').toLowerCase() === 'unavailable' ? 'unavailable' : 'available'
      } else {
        schedDays = [...WEEK_DAYS]
        schedStart = '08:00'
        schedEnd = '22:00'
        schedStatus = 'available'
      }
      setScheduleDays(schedDays)
      setStartTime(schedStart)
      setEndTime(schedEnd)
      setAvailabilityStatus(schedStatus)

      // ---- Services ----
      const svcRows = Array.isArray(svcsRaw) ? (svcsRaw as ServiceRow[]) : []
      const nextOriginal = new Map<number, string>()
      const drafts: ServiceEditDraft[] = svcRows.map((s) => {
        const imgs = dedupeStrings(
          Array.isArray((s as any).images)
            ? ((s as any).images as any[]).filter((x) => typeof x === 'string') as string[]
            : []
        )
        const status: 'active' | 'inactive' =
          String((s as any).status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active'
        const categoryRaw = String((s as any).category || 'consumable').toLowerCase()
        const category = (categoryRaw === 'rental' ? 'rental' : 'consumable') as 'consumable' | 'rental'
        const priceNum = Number((s as any).price)
        const stockNum = Number((s as any).stock)
        const norm = {
          name: String((s as any).name || '').trim(),
          category,
          price: Number.isFinite(priceNum) ? Math.max(0, Math.round(priceNum)) : 0,
          stock: Number.isFinite(stockNum) ? Math.max(0, Math.round(stockNum)) : 0,
          status,
          images: imgs,
        }
        if (typeof (s as any).serviceid === 'number') nextOriginal.set((s as any).serviceid, JSON.stringify(norm))
        return {
          localId: `id:${String((s as any).serviceid)}`,
          serviceid: (s as any).serviceid,
          name: norm.name,
          category: norm.category,
          price: String(norm.price),
          stock: String(norm.stock),
          status: norm.status,
          images: norm.images,
        }
      })
      originalServicesRef.current = nextOriginal
      setServiceDrafts(drafts)

      // ---- Basic court info (sync from courtRecord) ----
      const info = courtRecord.info
      const name = String(info?.name || '')
      const address = String(info?.address || courtRecord.court.courtinfo || '')
      originalAddressRef.current = address.trim()
      const venue = normalizeVenueToChoice(info?.venue)
      const images = dedupeStrings(
        Array.isArray(info?.images)
          ? (info!.images!.filter((x: any) => typeof x === 'string') as string[])
          : []
      ).slice(0, 3)
      setEditName(name)
      setEditAddress(address)
      setEditVenue(venue)
      setEditAutoApprove(Boolean((info as any)?.auto_approve))
      setEditImages(images)
      setSelectedPlaceId(null)
      setAddressSuggestions([])
      setAddressLoading(false)
      setLastGeocode(null)
      setVerifiedCoord(null)
      setVerifyError(null)
      setWarnings([])

      // ---- Set baseline from local vars (NOT from React state) ----
      // Computed from the same raw values we just set into state, so the
      // baseline is guaranteed to match the form on first render.
      const baseline = buildMainSnapshotFromRaw({
        name, address, venue, autoApprove: Boolean((info as any)?.auto_approve), images,
        serviceDrafts: drafts,
      })
      setMainBaselineSnapshot(baseline)
    } catch {
      setPlayingCourts([])
      setServiceDrafts([])
      originalServicesRef.current = new Map()
      setSelectedSubBaseName(null)
      setAvailability([])
      // Do NOT set baseline on error: keeps Save disabled
    } finally {
      setAvailabilityLoading(false)
      setPlayingCourtsLoading(false)
      setServicesLoading(false)
    }
  }, []) // no external deps: only calls setters and module-level helpers

  useEffect(() => {
    loadMyCourts()
  }, [loadMyCourts])

  useEffect(() => {
    if (!selected) return
    setSubBaselineSnapshot('')
    setPendingCloudinaryDeletesMain([])
    setPendingCloudinaryDeletesSub([])
    setSaveSuccessMessage(null)
    loadCourtData(selected)
  }, [selected?.court?.courtid, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!saveSuccessMessage) return
    if (saveSuccessTimerRef.current) clearTimeout(saveSuccessTimerRef.current)
    saveSuccessTimerRef.current = setTimeout(() => {
      setSaveSuccessMessage(null)
    }, 5000)
    return () => {
      if (saveSuccessTimerRef.current) clearTimeout(saveSuccessTimerRef.current)
    }
  }, [saveSuccessMessage])

  useFocusEffect(
    useCallback(() => {
      return () => {
        setSaveSuccessMessage(null)
      }
    }, [])
  )

  const loadCourtBookings = useCallback(async (courtid: number) => {
    setBookingLoading(true)
    setBookingError(null)
    try {
      const bookings = await listCourtBookingsByCourtId(courtid)
      setCourtBookings(bookings)
      // Enrich user info
      const uniqueUserIds = [...new Set(bookings.map(b => b.userid).filter(Boolean))]
      const names: Record<number, string> = {}
      const pfps: Record<number, string | null> = {}
      await Promise.all(uniqueUserIds.map(async (uid) => {
        try {
          const info = await getUserInfoByUserIdCached(uid)
          names[uid] = info?.name || `User ${uid}`
          pfps[uid] = info?.pfp || null
        } catch {
          names[uid] = `User ${uid}`
          pfps[uid] = null
        }
      }))
      setBookingUserNames(names)
      setBookingUserPfps(pfps)
    } catch (err: any) {
      setBookingError(err?.message || t('COURT_PANEL_LOAD_ERROR'))
    } finally {
      setBookingLoading(false)
    }
  }, [])

  const bookingsLoadedForCourtRef = useRef<number | null>(null)
  const deeplinkHandledForRef = useRef<string | null>(null)
  const deeplinkFetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!selected || editMode !== 'booking') return
    if (bookingsLoadedForCourtRef.current === selected.court.courtid) return
    bookingsLoadedForCourtRef.current = selected.court.courtid
    loadCourtBookings(selected.court.courtid)
  }, [editMode, selected?.court?.courtid]) // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link: court owner taps "View booking" in Notification â†’ auto-select court â†’ booking tab â†’ date + playing court
  useEffect(() => {
    if (!deeplinkCourtId || !deeplinkCourtBookingId) return
    const handledKey = deeplinkToken || String(deeplinkCourtBookingId)
    if (deeplinkHandledForRef.current === handledKey) return
    if (loading) return
    if (!rows.some(r => r.court.courtid === deeplinkCourtId)) return
    if (selectedCourtId !== deeplinkCourtId) { setSelectedCourtId(deeplinkCourtId); return }
    if (editMode !== 'booking') { setEditMode('booking'); return }
    // Force fresh booking data on each new deeplink click
    if (deeplinkFetchedForRef.current !== handledKey) {
      deeplinkFetchedForRef.current = handledKey
      bookingsLoadedForCourtRef.current = deeplinkCourtId
      loadCourtBookings(deeplinkCourtId)
      return
    }
    if (bookingsLoadedForCourtRef.current !== deeplinkCourtId || bookingLoading) return
    const booking = courtBookings.find(b => b.courtbookingid === deeplinkCourtBookingId)
    if (!booking) { deeplinkHandledForRef.current = handledKey; return }
    const avail = (availability || []).find(a => a.availabilityid === booking.availabilityid)
    const pcId: number | null = avail ? (Number((avail as any).playingcourtid) || null) : null
    const pc = pcId != null ? playingCourts.find(p => Number((p as any).playingcourtid) === pcId) : null
    const baseName = pc ? String((pc as any).base_name || (pc as any).name || '').trim() || null : null
    const bookingDate = typeof booking.bookingdate === 'string' ? booking.bookingdate.slice(0, 10) : null
    let weekOffset = 0
    if (bookingDate) {
      const todayOnly = new Date(); todayOnly.setHours(0, 0, 0, 0)
      const bDate = new Date(`${bookingDate}T00:00:00`)
      weekOffset = Math.max(0, Math.min(4, Math.floor((bDate.getTime() - todayOnly.getTime()) / (7 * 24 * 60 * 60 * 1000))))
    }
    if (baseName) setBookingSelectedBaseName(baseName)
    if (pcId != null) setBookingSelectedPcId(pcId)
    if (bookingDate) setBookingSelectedDate(bookingDate)
    setBookingWeekOffset(weekOffset)
    deeplinkHandledForRef.current = handledKey
  }, [deeplinkCourtId, deeplinkCourtBookingId, deeplinkToken, loading, rows, selectedCourtId, editMode, bookingLoading, courtBookings, availability, playingCourts]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    if (editMode !== 'booking' || !selected) {
      setBookingOwner(null)
      return
    }
    const ownerRaw = (selected.court as any)?.ownerid
    const ownerid = typeof ownerRaw === 'number' ? ownerRaw : Number(ownerRaw)
    if (!Number.isFinite(ownerid)) {
      setBookingOwner(null)
      return
    }

    ;(async () => {
      try {
        const info = await getUserInfoByUserIdCached(ownerid)
        if (cancelled) return
        setBookingOwner({ userid: ownerid, name: String(info?.name || `User ${ownerid}`), pfp: info?.pfp || null })
      } catch {
        if (!cancelled) setBookingOwner({ userid: ownerid, name: `User ${ownerid}`, pfp: null })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [editMode, selected?.court?.courtid])

  // Reset booking cache when court changes
  useEffect(() => {
    bookingsLoadedForCourtRef.current = null
    setBookingSelectedBaseName(null)
    setBookingSelectedPcId(null)
    setBookingSelectedDate(null)
    setBookingWeekOffset(0)
    setBookingSelectedSlot(null)
  }, [selectedCourtId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selected slot when selected date changes
  useEffect(() => {
    setBookingSelectedSlot(null)
  }, [bookingSelectedDate])

  useEffect(() => {
    if (!selected) return
    if (editMode !== 'main') return
    if (saving) return
    if (mainDirtyRef.current) return

    const info = selected.info
    if (!info) return

    setEditName(String(info?.name || ''))
    setEditAddress(String(info?.address || selected.court.courtinfo || ''))
    originalAddressRef.current = String(info?.address || selected.court.courtinfo || '').trim()
    setEditVenue(normalizeVenueToChoice(info?.venue))
    setEditAutoApprove(Boolean((info as any)?.auto_approve))
    setEditImages(
      dedupeStrings(Array.isArray(info?.images) ? (info!.images!.filter((x: any) => typeof x === 'string') as string[]) : []).slice(0, 3)
    )
    setSelectedPlaceId(null)
    setAddressSuggestions([])
    setAddressLoading(false)
    setLastGeocode(null)
    setVerifiedCoord(null)
    setVerifyError(null)
    setWarnings([])
  }, [editMode, saving, selected])



  const subCourtOptions = useMemo(() => {
    // Unique base_name list based on FULL rows.
    const out: string[] = []
    const seen = new Set<string>()
    for (const pc of playingCourts) {
      const part = String((pc as any).part || '').toLowerCase()
      if (part !== 'full') continue
      const base = String((pc as any).base_name || (pc as any).name || '').trim()
      if (!base) continue
      const key = base.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(base)
    }
    return out
  }, [playingCourts])

  useEffect(() => {
    if (editMode !== 'main') return
    if (subCourtOptions.length === 0) {
      setSelectedVenueCourtBaseName(null)
      setVenueCourtBaseEditName('')
      return
    }
    const current = String(selectedVenueCourtBaseName || '').trim().toLowerCase()
    const exists = subCourtOptions.some((name) => name.toLowerCase() === current)
    const nextBase = exists
      ? (subCourtOptions.find((name) => name.toLowerCase() === current) || subCourtOptions[0])
      : subCourtOptions[0]
    setSelectedVenueCourtBaseName(nextBase)
  }, [editMode, selectedVenueCourtBaseName, subCourtOptions])

  useEffect(() => {
    if (editMode !== 'main') return
    const selectedBase = String(selectedVenueCourtBaseName || '').trim().toLowerCase()
    if (!selectedBase) {
      setVenueCourtBaseEditName('')
      return
    }
    const matched = subCourtOptions.find((name) => name.toLowerCase() === selectedBase) || ''
    setVenueCourtBaseEditName(matched)
  }, [editMode, selectedVenueCourtBaseName, subCourtOptions])

  const bookingBaseNames = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const pc of playingCourts) {
      const base = String(pc.base_name || '').trim()
      if (base && !seen.has(base)) { seen.add(base); result.push(base) }
    }
    return result
  }, [playingCourts])

  const bookingWeekDays = useMemo(() => {
    const today = new Date()
    const dayIdx = today.getDay()
    const offsetToMonday = (dayIdx + 6) % 7
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday + bookingWeekOffset * 7)
    return [t('MAP_DAY_MON'), t('MAP_DAY_TUE'), t('MAP_DAY_WED'), t('MAP_DAY_THU'), t('MAP_DAY_FRI'), t('MAP_DAY_SAT'), t('MAP_DAY_SUN')].map((label, i) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return { label, d, dateStr: ds }
    })
  }, [bookingWeekOffset])

  // Auto-select first base and full court when owner enters booking tab
  useEffect(() => {
    if (editMode !== 'booking') return
    if (bookingBaseNames.length === 0) return
    if (bookingSelectedBaseName) return // already selected
    const firstBase = bookingBaseNames[0]
    setBookingSelectedBaseName(firstBase)
    const firstFullPc = playingCourts.find((pc) => pc.base_name === firstBase && String((pc as any).part || '').toLowerCase() === 'full')
    if (firstFullPc) setBookingSelectedPcId((firstFullPc as any).playingcourtid)
  }, [editMode, bookingBaseNames, playingCourts]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedSubPlayingCourtIds = useMemo(() => {
    const base = String(selectedSubBaseName || '').trim().toLowerCase()
    if (!base) return [] as number[]
    const ids: number[] = []
    for (const pc of playingCourts) {
      const pcBase = String((pc as any).base_name || '').trim().toLowerCase()
      if (!pcBase || pcBase !== base) continue
      const id = (pc as any).playingcourtid
      if (typeof id === 'number' && Number.isFinite(id)) ids.push(id)
    }
    return ids
  }, [playingCourts, selectedSubBaseName])

  const selectedSubFullPlayingCourtId = useMemo(() => {
    const base = String(selectedSubBaseName || '').trim().toLowerCase()
    if (!base) return null
    const full = playingCourts.find((pc) => {
      const pcBase = String((pc as any).base_name || '').trim().toLowerCase()
      const part = String((pc as any).part || '').toLowerCase()
      return pcBase === base && part === 'full'
    })
    const id = full ? (full as any).playingcourtid : null
    return typeof id === 'number' && Number.isFinite(id) ? id : null
  }, [playingCourts, selectedSubBaseName])

  const selectedSubPlayingCourtId = useMemo(() => {
    const base = String(selectedSubBaseName || '').trim().toLowerCase()
    if (!base) return null
    const row = playingCourts.find((pc) => {
      const pcBase = String((pc as any).base_name || '').trim().toLowerCase()
      const part = String((pc as any).part || '').toLowerCase()
      return pcBase === base && part === selectedSubPart
    })
    const id = row ? (row as any).playingcourtid : null
    return typeof id === 'number' && Number.isFinite(id) ? id : null
  }, [playingCourts, selectedSubBaseName, selectedSubPart])

  const selectedSubPlayingCourtRow = useMemo(() => {
    const base = String(selectedSubBaseName || '').trim().toLowerCase()
    if (!base) return null
    return (
      playingCourts.find((pc) => {
        const pcBase = String((pc as any).base_name || '').trim().toLowerCase()
        const part = String((pc as any).part || '').toLowerCase()
        return pcBase === base && part === selectedSubPart
      }) || null
    )
  }, [playingCourts, selectedSubBaseName, selectedSubPart])

  const mainSchedulePlayingCourtId = useMemo(() => {
    const full = playingCourts.find((pc) => String((pc as any).part || '').toLowerCase() === 'full')
    const id = (full as any)?.playingcourtid
    if (typeof id === 'number' && Number.isFinite(id)) return id
    const first = playingCourts[0] as any
    const fid = first?.playingcourtid
    return typeof fid === 'number' && Number.isFinite(fid) ? fid : null
  }, [playingCourts])

  const normalizedServicesSnapshot = useMemo(() => {
    const arr = Array.isArray(serviceDrafts) ? serviceDrafts : []
    const normalized = arr.map((d) => ({
      key: typeof d.serviceid === 'number' ? `id:${d.serviceid}` : `local:${d.localId}`,
      serviceid: typeof d.serviceid === 'number' ? d.serviceid : null,
      name: String(d.name || '').trim(),
      category: d.category,
      price: toIntSafe(d.price),
      stock: toIntSafe(d.stock),
      status: d.status,
      images: dedupeStrings(Array.isArray(d.images) ? d.images : []).slice().sort(),
      deleted: !!d.deleted,
    }))
    normalized.sort((a, b) => a.key.localeCompare(b.key))
    return normalized
  }, [serviceDrafts])

  const currentMainSnapshot = useMemo(() => {
    const name = String(editName || '').trim()
    const address = String(editAddress || '').trim()
    const originalAddr = String(originalAddressRef.current || '').trim()
    const addressChangedFromOriginal = canonicalizeAddress(address) !== canonicalizeAddress(originalAddr)

    // Canonicalize arrays so order-only differences don't keep Save enabled.
    const imagesCanonical = dedupeStrings(editImages).slice().sort()

    // Coords only matter when the address is changed (verification requirement).
    const verified = addressChangedFromOriginal && verifiedCoord
      ? { latitude: verifiedCoord.latitude, longitude: verifiedCoord.longitude }
      : null
    return JSON.stringify({
      name,
      address,
      venue: editVenue,
      autoApprove: !!editAutoApprove,
      images: imagesCanonical,
      venueBaseFrom: String(selectedVenueCourtBaseName || '').trim(),
      venueBaseTo: String(venueCourtBaseEditName || '').trim(),
      verified,
      services: normalizedServicesSnapshot,
    })
  }, [editAddress, editAutoApprove, editImages, editName, editVenue, normalizedServicesSnapshot, selectedVenueCourtBaseName, venueCourtBaseEditName, verifiedCoord])

  const mainIsDirty = useMemo(() => {
    if (!mainBaselineSnapshot) return false
    return currentMainSnapshot !== mainBaselineSnapshot
  }, [currentMainSnapshot, mainBaselineSnapshot])

  // Re-stamp baseline once the venue base name AND its edit twin both initialize
  // (async from subCourtOptions). Without this, the baseline is always mismatched
  // and Save stays enabled on fresh load.
  useEffect(() => {
    if (venueBaseInitRef.current) return
    if (!mainBaselineSnapshot) return
    if (!selectedVenueCourtBaseName) return
    // Wait for venueCourtBaseEditName to also update (it mirrors selectedVenueCourtBaseName)
    const baseFrom = String(selectedVenueCourtBaseName || '').trim()
    const baseTo = String(venueCourtBaseEditName || '').trim()
    if (baseFrom && !baseTo) return  // edit name hasn't synced yet; wait for next render
    venueBaseInitRef.current = true
    setMainBaselineSnapshot(currentMainSnapshot)
  }, [selectedVenueCourtBaseName, venueCourtBaseEditName, mainBaselineSnapshot, currentMainSnapshot])

  useEffect(() => {
    mainDirtyRef.current = mainIsDirty
  }, [mainIsDirty])

  const currentSubSnapshot = useMemo(() => {
    const base: any = {
      playingcourtid: selectedSubPlayingCourtId ?? null,
      name: String(subEditName || '').trim(),
      images: dedupeStrings(subEditImages || []).slice().sort(),
    }
    if (selectedSubPart === 'full') {
      base.scheduleDays = (WEEK_DAYS as readonly WeekDayKey[]).filter((d) => scheduleDays.includes(d))
      base.startTime = String(startTime || '').trim()
      base.endTime = String(endTime || '').trim()
      base.availabilityStatus = availabilityStatus
    }
    return JSON.stringify(base)
  }, [selectedSubPlayingCourtId, subEditImages, subEditName, selectedSubPart, scheduleDays, startTime, endTime, availabilityStatus])

  const subIsDirty = useMemo(() => {
    if (!subBaselineSnapshot) return false
    return currentSubSnapshot !== subBaselineSnapshot
  }, [currentSubSnapshot, subBaselineSnapshot])

  useEffect(() => {
    subDirtyRef.current = subIsDirty
  }, [subIsDirty])

  useEffect(() => {
    // Schedule editing is in Court (sub) mode, full part only.
    if (editMode !== 'sub' || selectedSubPart !== 'full') return
    const pid = selectedSubFullPlayingCourtId
    if (!pid) return
    const slot = (availability || []).find((s: any) => Number(s?.playingcourtid) === Number(pid)) as any
    if (!slot) {
      setScheduleDays([...WEEK_DAYS])
      setStartTime('08:00')
      setEndTime('22:00')
      setAvailabilityStatus('available')
      return
    }
    setScheduleDays(parseScheduleDays(slot.booking_date))
    setStartTime(hhmmFromDbTime(slot.start_time) || '08:00')
    setEndTime(hhmmFromDbTime(slot.end_time) || '22:00')
    setAvailabilityStatus(String(slot.status || '').toLowerCase() === 'unavailable' ? 'unavailable' : 'available')
  }, [availability, editMode, selectedSubPart, selectedSubFullPlayingCourtId])

  useEffect(() => {
    if (editMode !== 'sub') return
    const pid = selectedSubPlayingCourtId
    const row = selectedSubPlayingCourtRow
    if (!pid || !row) {
      setSubEditName('')
      setSubEditImages([])
      return
    }

    setSubEditName(String((row as any).name || '').trim())

    // Pre-load schedule/time from availability for full court baseline
    let baseSchedDays: WeekDayKey[] = [...WEEK_DAYS]
    let baseStart = '08:00'
    let baseEnd = '22:00'
    let baseAvailStat: 'available' | 'unavailable' = 'available'
    if (selectedSubPart === 'full') {
      const slot = (availability || []).find((s: any) => Number(s?.playingcourtid) === Number(pid)) as any
      if (slot) {
        baseSchedDays = parseScheduleDays(slot.booking_date)
        baseStart = hhmmFromDbTime(slot.start_time) || '08:00'
        baseEnd = hhmmFromDbTime(slot.end_time) || '22:00'
        baseAvailStat = String(slot.status || '').toLowerCase() === 'unavailable' ? 'unavailable' : 'available'
      }
    }

    // After a sub-save, the baseline is already correct — skip the async
    // fetch that would overwrite it. Clear the guard immediately so the
    // next real court selection triggers a fresh load.
    if (justSavedSubRef.current) {
      justSavedSubRef.current = false
      return
    }

    let cancelled = false
    ;(async () => {
      setSubInfoLoading(true)
      try {
        const info = (await getPlayingCourtInfo(pid)) as PlayingCourtInfoRow
        if (cancelled) return
        const imgs = Array.isArray((info as any)?.images) ? ((info as any).images as any[]).filter((x) => typeof x === 'string') as string[] : []
        const subImgs = dedupeStrings(imgs).slice(0, 1)
        setSubEditImages(subImgs)
        const baselineObj: any = {
          playingcourtid: pid,
          name: String((row as any).name || '').trim(),
          images: dedupeStrings(subImgs).slice().sort(),
        }
        if (selectedSubPart === 'full') {
          baselineObj.scheduleDays = (WEEK_DAYS as readonly WeekDayKey[]).filter((d) => baseSchedDays.includes(d))
          baselineObj.startTime = baseStart
          baselineObj.endTime = baseEnd
          baselineObj.availabilityStatus = baseAvailStat
        }
        setSubBaselineSnapshot(JSON.stringify(baselineObj))
      } catch {
        if (cancelled) return
        setSubEditImages([])
        const baselineObjFallback: any = { playingcourtid: pid, name: String((row as any).name || '').trim(), images: [] }
        if (selectedSubPart === 'full') {
          baselineObjFallback.scheduleDays = (WEEK_DAYS as readonly WeekDayKey[]).filter((d) => baseSchedDays.includes(d))
          baselineObjFallback.startTime = baseStart
          baselineObjFallback.endTime = baseEnd
          baselineObjFallback.availabilityStatus = baseAvailStat
        }
        setSubBaselineSnapshot(JSON.stringify(baselineObjFallback))
      } finally {
        if (cancelled) return
        setSubInfoLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editMode, selectedSubPlayingCourtId, selectedSubPlayingCourtRow, selectedSubPart]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Switching which sub-court half is selected should not be treated as an edit.
    // Reset baseline/hydration so Save only enables after actual changes.
    // Use selected?.court?.courtid (stable number) instead of selected (object ref)
    // so that loadMyCourts() after save doesn't clear the freshly-stamped baseline.
    if (editMode !== 'sub') return
    if (!selected) return
    setSubBaselineSnapshot('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, selected?.court?.courtid, selectedSubPlayingCourtId])

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      ;(async () => {
        try {
          // MapVerify persists via TTL cache; consume once.
          const parsed: any = await getCache<any>(COURT_REGISTER_VERIFY_STORAGE_KEY)
          if (!parsed) return
          try { await invalidateCache(COURT_REGISTER_VERIFY_STORAGE_KEY) } catch {}
          if (cancelled) return

          const latitude = Number(parsed?.latitude)
          const longitude = Number(parsed?.longitude)
          const formatted_address = parsed?.formatted_address
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
          setVerifiedCoord({ latitude, longitude, formatted_address: typeof formatted_address === 'string' ? formatted_address : null })
          setVerifyError(null)
        } catch {}
      })()
      return () => {
        cancelled = true
      }
    }, [])
  )

  const debouncedFetchRef = useRef<any>(null)
  useEffect(() => {
    if (!editAddress.trim()) {
      setAddressSuggestions([])
      setSelectedPlaceId(null)
      return
    }

    // If user hasn't actually changed the address yet (only tapped the pen icon),
    // don't fetch suggestions.
    if (canonicalizeAddress(editAddress) === canonicalizeAddress(originalAddressRef.current)) {
      setAddressSuggestions([])
      setAddressLoading(false)
      if (debouncedFetchRef.current) clearTimeout(debouncedFetchRef.current)
      return
    }

    // If user edits away from selected suggestion, clear selection and verification.
    if (selectedPlaceId && canonicalizeAddress(editAddress) !== canonicalizeAddress(originalAddressRef.current)) {
      // keep selectedPlaceId until user explicitly changes? simplest: clear when typing.
      setSelectedPlaceId(null)
    }

    setVerifyError(null)
    if (verifiedCoord && canonicalizeAddress(editAddress) !== canonicalizeAddress(originalAddressRef.current)) {
      setVerifiedCoord(null)
    }

    if (debouncedFetchRef.current) clearTimeout(debouncedFetchRef.current)
    debouncedFetchRef.current = setTimeout(async () => {
      const input = editAddress.trim()
      if (input.length < 3) {
        setAddressSuggestions([])
        return
      }
      setAddressLoading(true)
      try {
        const list = await autocompleteCourtAddress(input, 5)
        setAddressSuggestions(Array.isArray(list) ? list : [])
      } catch {
        setAddressSuggestions([])
      } finally {
        setAddressLoading(false)
      }
    }, 250)

    return () => {
      if (debouncedFetchRef.current) clearTimeout(debouncedFetchRef.current)
    }
  }, [editAddress, selectedPlaceId, verifiedCoord])

  const handleVerifyLocation = useCallback(async () => {
    const a = editAddress.trim()
    if (!a) {
      setVerifyError(t('COURT_PANEL_ERR_FILL_ADDRESS'))
      return
    }

    if (verifiedCoord) {
      router.push({
        pathname: '/event/mapVerify',
        params: {
          address: a,
          formatted: verifiedCoord?.formatted_address || a,
          lat: String(verifiedCoord.latitude),
          lng: String(verifiedCoord.longitude),
        },
      })
      return
    }

    if (lastGeocode && lastGeocode.address === a && lastGeocode.placeId === selectedPlaceId) {
      setWarnings((lastGeocode.warnings || []).filter(Boolean as any))
      router.push({
        pathname: '/event/mapVerify',
        params: {
          address: a,
          formatted: lastGeocode.formatted_address || a,
          lat: String(lastGeocode.latitude),
          lng: String(lastGeocode.longitude),
        },
      })
      return
    }

    setWarnings([])
    setVerifiedCoord(null)
    setVerifyError(null)
    try {
      const geo = selectedPlaceId ? await geocodeCourtPlaceId(selectedPlaceId) : await geocodeCourtAddress(a)
      const w = (geo?.warnings || []).filter(Boolean)
      setWarnings(w)
      const lg = {
        address: a,
        placeId: selectedPlaceId,
        formatted_address: geo?.formatted_address || null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        warnings: w,
      }
      setLastGeocode(lg)
      router.push({
        pathname: '/event/mapVerify',
        params: {
          address: a,
          formatted: geo?.formatted_address || a,
          lat: String(geo.latitude),
          lng: String(geo.longitude),
        },
      })
    } catch (e: any) {
      Alert.alert(t('COURT_PANEL_ERR_GEOCODE'), e?.message || t('COMMON_ERR_TRY_AGAIN'))
    }
  }, [editAddress, lastGeocode, router, selectedPlaceId, verifiedCoord])

  const uploadOneToCloudinary = useCallback(
    async (localUri: string, idx: number, opts?: { deliveryShape?: 'tile' | 'square' }) => {
      if (typeof ownerId !== 'number') throw new Error('Not signed in')

      const resized = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 800 } }],
        { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG }
      )

      const publicId = `court_${ownerId}_${Date.now()}_${idx}`
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
      return applyCloudinaryDeliveryOptimizations(secureUrl, opts?.deliveryShape || 'tile')
    },
    [ownerId]
  )

  const pickImage = useCallback(async () => {
    if (imageUploading) return
    if (typeof ownerId !== 'number') {
      Alert.alert(t('COMMON_ERR_NOT_SIGNED_IN'), t('COMMON_ERR_SIGN_IN_FIRST'))
      return
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(t('COMMON_ERR_PERMISSION'), t('COMMON_ERR_PHOTO_ACCESS'))
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
      setEditImages((prev) => dedupeStrings([...prev, uploadedUrl]).slice(0, 3))
    } catch (e: any) {
      Alert.alert(t('COMMON_ERR_UPLOAD'), e?.message || String(e))
    } finally {
      setImageUploading(false)
    }
  }, [editImages.length, imageUploading, ownerId, uploadOneToCloudinary])

  const pickSubCourtImage = useCallback(async () => {
    if (imageUploading) return
    if (typeof ownerId !== 'number') {
      Alert.alert(t('COMMON_ERR_NOT_SIGNED_IN'), t('COMMON_ERR_SIGN_IN_FIRST'))
      return
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(t('COMMON_ERR_PERMISSION'), t('COMMON_ERR_PHOTO_ACCESS'))
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
      const uploadedUrl = await uploadOneToCloudinary(picked[0], subEditImages.length)
      setSubEditImages((prev) => dedupeStrings([...(prev || []), uploadedUrl]).slice(0, 1))
    } catch (e: any) {
      Alert.alert(t('COMMON_ERR_UPLOAD'), e?.message || String(e))
    } finally {
      setImageUploading(false)
    }
  }, [imageUploading, ownerId, subEditImages.length, uploadOneToCloudinary])

  const requestRemoveImage = useCallback((uri: string, ctx: 'main' | 'sub' = 'main') => {
    setRemoveImageContext(ctx)
    setRemoveImageCandidateUri(uri)
    setRemoveImageConfirmVisible(true)
  }, [])

  const onConfirmRemoveImage = useCallback(() => {
    if (removeImageCandidateUri) {
      if (removeImageContext === 'sub') {
        if (/^https?:\/\//i.test(removeImageCandidateUri)) {
          setPendingCloudinaryDeletesSub((prev) => dedupeStrings([...(prev || []), removeImageCandidateUri]))
        }
        setSubEditImages((prev) => (prev || []).filter((u) => u !== removeImageCandidateUri))
      } else {
        if (/^https?:\/\//i.test(removeImageCandidateUri)) {
          setPendingCloudinaryDeletesMain((prev) => dedupeStrings([...(prev || []), removeImageCandidateUri]))
        }
        setEditImages((prev) => prev.filter((u) => u !== removeImageCandidateUri))
      }
    }
    setRemoveImageConfirmVisible(false)
    setRemoveImageCandidateUri(null)
  }, [removeImageCandidateUri, removeImageContext])

  const addServiceDraft = useCallback(() => {
    const id = `new:${Date.now()}:${Math.floor(Math.random() * 1e9)}`
    setServiceDrafts((prev) => [
      ...prev,
      {
        localId: id,
        name: '',
        category: 'consumable',
        price: '0',
        stock: '0',
        status: 'active',
        images: [],
      },
    ])
    setServiceExpanded((prev) => ({ ...prev, [id]: false }))
  }, [])

  const updateServiceDraft = useCallback((localId: string, patch: Partial<ServiceEditDraft>) => {
    setServiceDrafts((prev) => prev.map((x) => (x.localId === localId ? { ...x, ...patch } : x)))
  }, [])

  const markDeleteServiceDraft = useCallback((localId: string) => {
    setServiceDrafts((prev) => {
      const item = prev.find((x) => x.localId === localId)
      if (!item) return prev
      if (!item.serviceid) return prev.filter((x) => x.localId !== localId)
      return prev.map((x) => (x.localId === localId ? { ...x, deleted: true } : x))
    })
  }, [])

  const pickServiceImage = useCallback(
    async (localId: string) => {
      if (imageUploading) return
      if (typeof ownerId !== 'number') {
        Alert.alert(t('COMMON_ERR_NOT_SIGNED_IN'), t('COMMON_ERR_SIGN_IN_FIRST'))
        return
      }
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) {
        Alert.alert(t('COMMON_ERR_PERMISSION'), t('COMMON_ERR_PHOTO_ACCESS'))
        return
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      } as any)

      if (result.canceled) return
      const picked = (result.assets || []).map((a) => a.uri).filter(Boolean)
      if (picked.length === 0) return

      setImageUploading(true)
      try {
        const uploadedUrl = await uploadOneToCloudinary(picked[0], Date.now() % 1000, { deliveryShape: 'square' })
        setServiceDrafts((prev) =>
          prev.map((x) =>
            x.localId === localId
              ? { ...x, images: dedupeStrings([...(x.images || []), uploadedUrl]).slice(0, 6) }
              : x
          )
        )
      } catch (e: any) {
        Alert.alert(t('COMMON_ERR_UPLOAD'), e?.message || String(e))
      } finally {
        setImageUploading(false)
      }
    },
    [imageUploading, ownerId, uploadOneToCloudinary]
  )

  const removeServiceImage = useCallback((localId: string, uri: string) => {
    setServiceDrafts((prev) => prev.map((x) => (x.localId === localId ? { ...x, images: (x.images || []).filter((u) => u !== uri) } : x)))
  }, [])

  const onSave = useCallback(async () => {
    if (saving) return
    if (!selected) return

    if (editMode === 'main' && (loading || availabilityLoading || servicesLoading || playingCourtsLoading)) {
      Alert.alert(t('COMMON_ERR_PLEASE_WAIT'), t('COURT_PANEL_ERR_COURT_LOADING'))
      return
    }
    if (editMode === 'sub' && subInfoLoading) {
      Alert.alert(t('COMMON_ERR_PLEASE_WAIT'), t('COURT_PANEL_ERR_INFO_LOADING'))
      return
    }

    const hasBaseline = editMode === 'main' ? !!mainBaselineSnapshot : !!subBaselineSnapshot
    const isDirtyNow = editMode === 'main' ? mainDirtyRef.current : subDirtyRef.current
    if (!hasBaseline) return
    if (!isDirtyNow) return

    const courtid = selected.court.courtid
    if (typeof courtid !== 'number') return

    setSaveSuccessMessage(null)
    setSaving(true)
    try {
      if (editMode === 'main') {
        const nm = editName.trim()
        const addr = editAddress.trim()

        if (!nm || !addr) {
          Alert.alert(t('COMMON_ERR_MISSING_INFO'), t('COURT_PANEL_ERR_FILL_NAME_ADDR'))
          return
        }

        const originalAddr = originalAddressRef.current
        const addressChanged = canonicalizeAddress(addr) !== canonicalizeAddress(originalAddr)
        if (addressChanged && !verifiedCoord) {
          Alert.alert(t('COURT_PANEL_ERR_VERIFY_LOC_TITLE'), t('COURT_PANEL_ERR_VERIFY_LOC_MSG'))
          return
        }

        const venuePayload = editVenue
        const venueNormalized = venuePayload === 'Both' ? ['Indoor', 'Outdoor'] : [venuePayload]

        if (addressChanged) {
          await updateCourt(courtid, { courtinfo: addr })
        }

        await updateCourtInfoByCourtId(courtid, {
          name: nm,
          address: addr,
          venue: venueNormalized,
          auto_approve: !!editAutoApprove,
          images: editImages,
          ...(addressChanged && verifiedCoord
            ? {
                latitude: verifiedCoord.latitude,
                longitude: verifiedCoord.longitude,
                accuracy_type: 'user_selected',
              }
            : {}),
        })

        const baseFrom = String(selectedVenueCourtBaseName || '').trim()
        const baseTo = String(venueCourtBaseEditName || '').trim()
        if (baseFrom && baseTo && baseFrom.toLowerCase() !== baseTo.toLowerCase()) {
          const renameTargets = (playingCourts || []).filter(
            (pc) => String((pc as any).base_name || '').trim().toLowerCase() === baseFrom.toLowerCase()
          )
          if (renameTargets.length > 0) {
            await Promise.all(renameTargets.map((pc) => patchPlayingCourt(Number((pc as any).playingcourtid), { base_name: baseTo } as any)))
            setPlayingCourtsLoading(true)
            try {
              const pcs = await listPlayingCourtsByCourtId(courtid)
              setPlayingCourts(Array.isArray(pcs) ? (pcs as PlayingCourtRow[]) : [])
            } finally {
              setPlayingCourtsLoading(false)
            }
            setSelectedVenueCourtBaseName(baseTo)
            if (String(selectedSubBaseName || '').trim().toLowerCase() === baseFrom.toLowerCase()) {
              setSelectedSubBaseName(baseTo)
            }
          }
        }

        // ---- Services (persist only changes) ----
        const originalMap = originalServicesRef.current || new Map()
        const toDelete = serviceDrafts
          .filter((d) => d.deleted && typeof d.serviceid === 'number')
          .map((d) => d.serviceid!)
        const toCreate = serviceDrafts.filter((d) => !d.deleted && !d.serviceid && String(d.name || '').trim())
        const toPatch = serviceDrafts.filter((d) => !d.deleted && typeof d.serviceid === 'number')

        const serviceOps: Promise<any>[] = []

        for (const id of toDelete) {
          serviceOps.push(deleteService(id))
        }

        for (const d of toCreate) {
          serviceOps.push(
            createService({
              courtid,
              name: String(d.name || '').trim(),
              category: d.category,
              price: toIntSafe(d.price),
              stock: toIntSafe(d.stock),
              status: d.status,
              images: dedupeStrings(d.images || []),
            } as any)
          )
        }

        for (const d of toPatch) {
          const serviceid = d.serviceid!
          const norm = {
            name: String(d.name || '').trim(),
            category: d.category,
            price: toIntSafe(d.price),
            stock: toIntSafe(d.stock),
            status: d.status,
            images: dedupeStrings(d.images || []),
          }
          const orig = originalMap.get(serviceid)
          if (orig && orig === JSON.stringify(norm)) continue
          serviceOps.push(patchService(serviceid, norm as any))
        }

        if (serviceOps.length) {
          const results = await Promise.allSettled(serviceOps)
          const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
          if (rejected) throw rejected.reason

          // Refresh services editor after successful writes.
          try {
            setServicesLoading(true)
            const svcs = await listServicesByCourtId(courtid)
            const rows = Array.isArray(svcs) ? (svcs as ServiceRow[]) : []
            const nextOriginal = new Map<number, string>()
            const drafts: ServiceEditDraft[] = rows.map((s) => {
              const images = dedupeStrings(
                Array.isArray((s as any).images)
                  ? ((s as any).images as any[]).filter((x) => typeof x === 'string') as string[]
                  : []
              )
              const status: 'active' | 'inactive' =
                String((s as any).status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active'
              const categoryRaw = String((s as any).category || 'consumable').toLowerCase()
              const category = (categoryRaw === 'rental' ? 'rental' : 'consumable') as 'consumable' | 'rental'
              const priceNum = Number((s as any).price)
              const stockNum = Number((s as any).stock)
              const norm = {
                name: String((s as any).name || '').trim(),
                category,
                price: Number.isFinite(priceNum) ? Math.max(0, Math.round(priceNum)) : 0,
                stock: Number.isFinite(stockNum) ? Math.max(0, Math.round(stockNum)) : 0,
                status,
                images,
              }
              if (typeof (s as any).serviceid === 'number') nextOriginal.set((s as any).serviceid, JSON.stringify(norm))
              return {
                localId: `id:${String((s as any).serviceid)}`,
                serviceid: (s as any).serviceid,
                name: norm.name,
                category: norm.category,
                price: String(norm.price),
                stock: String(norm.stock),
                status: norm.status,
                images: norm.images,
              }
            })
            originalServicesRef.current = nextOriginal
            setServiceDrafts(drafts)
          } finally {
            setServicesLoading(false)
          }
        }
      } else {
        if (!selectedSubBaseName || selectedSubPlayingCourtIds.length === 0) {
          Alert.alert(t('COURT_PANEL_ERR_SELECT_COURT_TITLE'), t('COURT_PANEL_ERR_SELECT_COURT_MSG'))
          return
        }
        if (!selectedSubPlayingCourtId) {
          Alert.alert(t('COURT_PANEL_ERR_SELECT_HALF_TITLE'), t('COURT_PANEL_ERR_SELECT_HALF_MSG'))
          return
        }
        if (!subEditName.trim()) {
          Alert.alert(t('COMMON_ERR_MISSING_INFO'), t('COURT_PANEL_ERR_ENTER_NAME'))
          return
        }

        await patchPlayingCourt(selectedSubPlayingCourtId, { name: subEditName.trim() } as any)
        await patchPlayingCourtInfo(selectedSubPlayingCourtId, {
          images: dedupeStrings(subEditImages || []),
        } as any)

        // Refresh local data so the UI reflects new names/images immediately.
        try {
          setPlayingCourtsLoading(true)
          const pcs = await listPlayingCourtsByCourtId(courtid)
          setPlayingCourts(Array.isArray(pcs) ? (pcs as PlayingCourtRow[]) : [])
        } finally {
          setPlayingCourtsLoading(false)
        }

        // ---- Availability / schedule (full court â†’ all parts of this base) ----
        if (selectedSubPart === 'full' && selectedSubPlayingCourtIds.length > 0) {
          const schedStart = startTime.trim()
          const schedEnd = endTime.trim()
          if (HHMM_24H_RE.test(schedStart) && HHMM_24H_RE.test(schedEnd) && scheduleDays.length > 0 && hhmmToMinutes(schedStart) < hhmmToMinutes(schedEnd)) {
            const patch = {
              status: availabilityStatus,
              booking_date: scheduleDays,
              start_time: `${schedStart}:00`,
              end_time: `${schedEnd}:00`,
            }
            const ops = selectedSubPlayingCourtIds.map((pid2) => updateCourtAvailabilityByPlayingCourtId(pid2, patch as any, { courtid }))
            await Promise.allSettled(ops)
          }
        }
        // Do NOT call loadAvailability here: the schedule effect re-runs from
        // freshly-fetched availability and would overwrite scheduleDays/startTime/endTime
        // AFTER the baseline is stamped, making the form look dirty again.
        // The availability cache is invalidated below; a pull-to-refresh fetches fresh data.
      }

      // Invalidate caches so loadMyCourts and loadCourtData fetch fresh data
      await invalidateCache('cache:courtinfo:v1')
      await invalidateCache('cache:courtinfo:compact:v1')
      await invalidateCache(`@courtAvailability:${courtid}`)

      await loadMyCourts()

      // Deferred Cloudinary deletions (only after successful save for that mode)
      if (editMode === 'main') {
        const urls = dedupeStrings(pendingCloudinaryDeletesMain || [])
        if (urls.length) {
          try {
            await deleteCloudinaryAssetsByUrl(urls)
          } catch {
            // best-effort cleanup
          }
        }
        setPendingCloudinaryDeletesMain([])
      } else {
        const urls = dedupeStrings(pendingCloudinaryDeletesSub || [])
        if (urls.length) {
          try {
            await deleteCloudinaryAssetsByUrl(urls)
          } catch {
            // best-effort cleanup
          }
        }
        setPendingCloudinaryDeletesSub([])
      }

      if (editMode === 'main') {
        // Bump dataVersion so loadCourtData re-runs and refreshes all detail
        // data (playing courts, services, availability) from the server.
        setDataVersion((v) => v + 1)
      } else {
        // Sub mode: re-stamp the baseline from the current edit state so the
        // form becomes clean without triggering a full re-fetch. A full
        // re-fetch would hit the backend availability SWR cache before the
        // background invalidation finishes, causing the schedule to revert.
        const savedSubSnapshot = JSON.stringify({
          playingcourtid: selectedSubPlayingCourtId ?? null,
          name: String(subEditName || '').trim(),
          images: dedupeStrings(subEditImages || []).slice().sort(),
          ...(selectedSubPart === 'full' ? {
            scheduleDays: (WEEK_DAYS as readonly WeekDayKey[]).filter((d) => scheduleDays.includes(d)),
            startTime: String(startTime || '').trim(),
            endTime: String(endTime || '').trim(),
            availabilityStatus,
          } : {}),
        })
        justSavedSubRef.current = true
        setSubBaselineSnapshot(savedSubSnapshot)
      }

      setSaveSuccessMessage(t('COURT_PANEL_SAVE_SUCCESS'))
    } catch (e: any) {
      setSaveSuccessMessage(null)
      Alert.alert(t('COURT_PANEL_ERR_SAVE'), e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }, [
    editAddress,
    editAutoApprove,
    editImages,
    editName,
    editVenue,
    loadMyCourts,
    saving,
    availabilityStatus,
    scheduleDays,
    selected,
    startTime,
    endTime,
    editMode,
    playingCourts,
    pendingCloudinaryDeletesMain,
    pendingCloudinaryDeletesSub,
    mainBaselineSnapshot,
    subBaselineSnapshot,
    selectedSubBaseName,
    selectedSubPlayingCourtIds,
    selectedSubPlayingCourtId,
    serviceDrafts,
    verifiedCoord,
    subEditName,
    subEditImages,
    loadAvailability,
    selectedSubPart,
    setSubBaselineSnapshot,
  ])

  const zoomAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: zoomTranslateX.value },
        { translateY: zoomTranslateY.value },
        { scale: zoomScale.value },
      ],
    }
  })

  const zoomGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onUpdate((e) => {
        zoomScale.value = clamp(zoomBaseScale.value * e.scale, 1, 4)
      })
      .onEnd(() => {
        zoomBaseScale.value = zoomScale.value
        if (zoomScale.value <= 1) {
          zoomScale.value = withTiming(1)
          zoomTranslateX.value = withTiming(0)
          zoomTranslateY.value = withTiming(0)
          zoomBaseScale.value = 1
          zoomBaseX.value = 0
          zoomBaseY.value = 0
        }
      })

    const pan = Gesture.Pan()
      .onUpdate((e) => {
        if (zoomScale.value <= 1) return
        zoomTranslateX.value = zoomBaseX.value + e.translationX
        zoomTranslateY.value = zoomBaseY.value + e.translationY
      })
      .onEnd(() => {
        zoomBaseX.value = zoomTranslateX.value
        zoomBaseY.value = zoomTranslateY.value
      })

    return Gesture.Simultaneous(pinch, pan)
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomScale, zoomTranslateX, zoomTranslateY])

  useEffect(() => {
    if (!zoomImageUri) return
    zoomScale.value = 1
    zoomTranslateX.value = 0
    zoomTranslateY.value = 0
    zoomBaseScale.value = 1
    zoomBaseX.value = 0
    zoomBaseY.value = 0
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomImageUri, zoomScale, zoomTranslateX, zoomTranslateY])

  const onRefresh = useCallback(async () => {
    setPullRefreshing(true)
    try {
      await loadMyCourts()
      if (selectedCourtId != null) await loadAvailability(selectedCourtId)
    } finally {
      setPullRefreshing(false)
    }
  }, [loadAvailability, loadMyCourts, selectedCourtId])

  const courtsCards = useMemo(() => {
    return rows.map((r) => {
      const courtid = r.court.courtid
      const selectedCard = selectedCourtId === courtid
      const name = String(r.info?.name || '').trim() || t('COURT_PANEL_UNNAMED_COURT')
      const images = Array.isArray(r.info?.images) ? (r.info!.images as string[]) : []
      const imageUri = images.find((u) => typeof u === 'string' && u.trim()) || null

      return (
        <TouchableOpacity
          key={courtid}
          activeOpacity={0.9}
          onPress={() => setSelectedCourtId(courtid)}
          style={[styles.card, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, selectedCard && [styles.cardSelected, { borderColor: tc.brand }]]}
        >
          <View style={[styles.cardImageWrap, { backgroundColor: tc.bgElevated }]}>
            {imageUri ? (
              <ExpoImage
                source={{ uri: optimizeRemoteImageUrl(imageUri) }}
                style={styles.cardImage}
                contentFit="cover"
                cachePolicy="disk"
              />
            ) : (
              <View style={[styles.cardImageFallback, { backgroundColor: tc.bgElevated }]}>
                <Image source={ICONS.court} style={{ width: 44, height: 44, tintColor: tc.iconMuted }} resizeMode="contain" />
              </View>
            )}
          </View>
          <View style={styles.cardBody}>
            <Text style={[styles.cardTitle, { color: tc.textPrimary }]} numberOfLines={2}>
              {name}
            </Text>
          </View>
        </TouchableOpacity>
      )
    })
  }, [rows, selectedCourtId])

  const saveBaselineReady = editMode === 'main' ? !!mainBaselineSnapshot : !!subBaselineSnapshot
  const saveDirty = editMode === 'main' ? mainIsDirty : subIsDirty
  const saveDisabled = saving || !saveBaselineReady || !saveDirty

  if (typeof ownerId !== 'number') {
    return (
      <View style={[styles.screen, { backgroundColor: tc.bgBase }]}>
        <Text style={[styles.emptyText, { color: tc.textSecondary }]}>{t('COURT_PANEL_SIGN_IN_MSG')}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: tc.bgBase }]}
      contentContainerStyle={{ paddingBottom: 160, flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={onRefresh} />}
    >
      <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
        <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('COURT_PANEL_MY_VENUE')}</Text>
      </View>

      {loading ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
          <SkeletonPulse>
            <SkeletonBox width={140} height={22} radius={8} style={{ marginBottom: 12 }} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <SkeletonBox width={180} height={96} radius={12} />
              <SkeletonBox width={180} height={96} radius={12} />
            </View>
          </SkeletonPulse>
        </View>
      ) : error ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
          <Text style={{ color: tc.error, fontWeight: '700' }}>{error}</Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
          <Text style={styles.emptyText}>{t('COURT_PANEL_EMPTY')}</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}>
          {courtsCards}
        </ScrollView>
      )}

      {!!selected && (
        <View style={{ paddingHorizontal: 12, paddingTop: 6 }}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('COURT_PANEL_MANAGEMENT')}</Text>

          <View style={[styles.segmented, { marginTop: 10, borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
            {([
              { key: 'main', label: t('COURT_PANEL_TAB_VENUE') },
              { key: 'sub', label: t('COURT_PANEL_TAB_COURT') },
              { key: 'booking', label: t('COURT_PANEL_TAB_BOOKING') },
            ] as const).map((opt) => {
              const active = editMode === opt.key
              return (
                <TouchableOpacity
                  key={opt.key}
                  onPress={() => setEditMode(opt.key)}
                  style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{opt.label}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {editMode === 'booking' ? (
            (() => {
              const pcAvailIds = (availability || []).filter((a) => a.playingcourtid === bookingSelectedPcId).map((a) => a.availabilityid)
              const pcBookings = courtBookings.filter((b) => pcAvailIds.includes(b.availabilityid))
              // Parse booking_date weekday array for selected playing court
              const pcAvailRow = (availability || []).find((a) => a.playingcourtid === bookingSelectedPcId) || null
              const availableWeekdays: string[] = (() => {
                if (!pcAvailRow) return []
                const bd = (pcAvailRow as any).booking_date
                if (typeof bd === 'string') { try { const p = JSON.parse(bd); return Array.isArray(p) ? p : [] } catch { return [] } }
                return Array.isArray(bd) ? bd : []
              })()
              const bookedDates = new Set(pcBookings.map((b) => typeof b.bookingdate === 'string' ? b.bookingdate.slice(0, 10) : null).filter(Boolean) as string[])
              const bookingApplicants = pcBookings.filter((b) => {
                const s = String(b.status ?? '').toLowerCase()
                return !s || s === 'pending' || s === 'waiting'
              })
              const bookingParticipants = pcBookings.filter((b) => {
                const s = String(b.status ?? '').toLowerCase()
                return s === 'approved' || s === 'joined'
              })
              const mergedParticipants = (() => {
                // Group all approved bookings by userid
                const byUser = new Map<number, CourtBookingRow[]>()
                for (const row of bookingParticipants) {
                  const uid = Number(row.userid)
                  if (!Number.isFinite(uid)) continue
                  const arr = byUser.get(uid) ?? []
                  arr.push(row)
                  byUser.set(uid, arr)
                }
                const toMin = (raw: string | null | undefined): number | null => {
                  const m = String(raw ?? '').match(/(?:T|\s)(\d{2}):(\d{2})/)
                  return m ? Number(m[1]) * 60 + Number(m[2]) : null
                }
                const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
                const result: { userid: number; row: CourtBookingRow; timeDisplay: string }[] = []
                for (const [uid, bookings] of byUser.entries()) {
                  const sorted = [...bookings].sort((a, b) => (toMin(a.start_timestamp) ?? 0) - (toMin(b.start_timestamp) ?? 0))
                  // Build [startMin, endMin] intervals
                  const intervals: [number, number][] = []
                  for (const b of sorted) {
                    const s = toMin(b.start_timestamp)
                    const e = toMin(b.end_timestamp)
                    if (s != null && e != null && e > s) intervals.push([s, e])
                  }
                  // Merge consecutive / overlapping intervals
                  const merged: [number, number][] = []
                  for (const [s, e] of intervals) {
                    if (merged.length && s <= merged[merged.length - 1][1]) {
                      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e)
                    } else {
                      merged.push([s, e])
                    }
                  }
                  const timeDisplay = merged.length
                    ? merged.map(([s, e]) => `${fmt(s)} - ${fmt(e)}`).join(' ; ')
                    : 'Unknown time'
                  result.push({ userid: uid, row: sorted[sorted.length - 1], timeDisplay })
                }
                return result
              })()
              const dateBookings = bookingSelectedDate ? pcBookings.filter((b) => {
                if ((typeof b.bookingdate === 'string' ? b.bookingdate.slice(0, 10) : null) !== bookingSelectedDate) return false
                const s = String(b.status ?? '').toLowerCase()
                const bs = String(b.bookingstatus ?? '').toLowerCase()
                return !s.includes('reject') && !bs.includes('cancel') && s !== 'pending' && s !== 'waiting'
              }) : []

              // ---- Time slot visualization for selected date ----
              const slotToMin = (raw: string | null | undefined): number | null => {
                const m = String(raw ?? '').match(/(?:T|\s)(\d{2}):(\d{2})/)
                return m ? Number(m[1]) * 60 + Number(m[2]) : null
              }
              const pcTimeSlotsList: string[] = (() => {
                if (!pcAvailRow) return []
                const [sh, sm] = String(pcAvailRow.start_time || '08:00').split(':').map(Number)
                const [eh, em] = String(pcAvailRow.end_time || '22:00').split(':').map(Number)
                if (!Number.isFinite(sh) || !Number.isFinite(eh)) return []
                const slots: string[] = []
                for (let mm = sh * 60 + sm; mm + 30 <= eh * 60 + em; mm += 30) {
                  slots.push(`${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`)
                }
                return slots
              })()
              const slotToBookingMap = new Map<string, CourtBookingRow>()
              for (const b of dateBookings) {
                const bStartMin = slotToMin(b.start_timestamp)
                const bEndMin = slotToMin(b.end_timestamp)
                if (bStartMin == null || bEndMin == null) continue
                for (const slot of pcTimeSlotsList) {
                  const [sh, sm] = slot.split(':').map(Number)
                  const slotStart = sh * 60 + sm
                  if (slotStart >= bStartMin && slotStart + 30 <= bEndMin) slotToBookingMap.set(slot, b)
                }
              }
              const slotSelectedBooking = bookingSelectedSlot ? (slotToBookingMap.get(bookingSelectedSlot) ?? null) : null

              const translateBookingStatus = (s: string) => {
                const lower = s.toLowerCase()
                if (lower === 'pending') return t('COURT_PANEL_STATUS_PENDING')
                if (lower === 'approved') return t('COURT_PANEL_STATUS_APPROVED')
                if (lower === 'rejected') return t('COURT_PANEL_STATUS_REJECTED')
                if (lower === 'upcoming') return t('COURT_PANEL_STATUS_UPCOMING')
                if (lower === 'cancelled' || lower === 'canceled') return t('COURT_PANEL_STATUS_CANCELLED')
                return s
              }

              const renderBookingRow = (b: CourtBookingRow, showActions: boolean, overrideTime?: string, showAttendance?: boolean) => {
                const uid = b.userid
                const displayName = bookingUserNames[uid] || `User ${uid}`
                const pfpUri = bookingUserPfps[uid] || null
                const noteExp = expandedNoteIds.has(b.courtbookingid)
                const statusRaw = String(b.status ?? b.bookingstatus ?? '')
                // Attendance window computation
                const now = new Date()
                const parseTs = (raw: string | null | undefined): Date | null => {
                  if (!raw) return null
                  const s = String(raw)
                  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'))
                  return Number.isFinite(d.getTime()) ? d : null
                }
                const startDt = parseTs(b.start_timestamp)
                const endDt = parseTs(b.end_timestamp)
                const endPlus1h = endDt ? new Date(endDt.getTime() + 60 * 60 * 1000) : null
                const isInWindow = startDt != null && endPlus1h != null && now >= startDt && now <= endPlus1h
                const bookingDayEnd = startDt ? new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate() + 1) : null
                const isWithinBookingDay = startDt != null && bookingDayEnd != null && now >= startDt && now < bookingDayEnd
                const isAlreadyMarked = ['completed', 'missed', 'cancelled'].some(s => statusRaw.toLowerCase().includes(s))
                const isAttendedEnabled = isWithinBookingDay && !isAlreadyMarked
                const isNotAttendedEnabled = isWithinBookingDay && !isAlreadyMarked
                const showAttendanceBtns = showAttendance && isWithinBookingDay && !isAlreadyMarked
                return (
                  <View key={`${b.courtbookingid}-${overrideTime ?? ''}`} style={{ backgroundColor: tc.bgSurface, borderRadius: 12, padding: 12, marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <TouchableOpacity activeOpacity={0.75} onPress={() => router.push({ pathname: '/event/profileSpectate', params: { userid: String(uid) } } as any)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                        {pfpUri ? <ExpoImage source={{ uri: pfpUri }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: tc.divider }} contentFit="cover" cachePolicy="disk" /> : <Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />}
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text style={{ fontWeight: '700', fontSize: 13, color: tc.textPrimary }} numberOfLines={1}>{displayName}</Text>
                          <Text style={{ color: tc.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>{overrideTime ?? formatBookingTimeOnly(b.start_timestamp, b.end_timestamp, t('COURT_PANEL_UNKNOWN_TIME'))}</Text>
                          <Text style={{ color: tc.textSecondary, fontSize: 12, marginTop: 1 }}>
                            <Text style={{ fontWeight: '700', color: tc.textSecondary }}>{t('COURT_PANEL_STATUS_PREFIX')}</Text>
                            <Text>{translateBookingStatus(statusRaw) || t('COURT_PANEL_STATUS_PENDING')}</Text>
                          </Text>
                        </View>
                      </TouchableOpacity>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {showActions && (
                          <>
                            <TouchableOpacity disabled={!!mutatingBookingIds[b.courtbookingid]} onPress={async () => { setMutatingBookingIds(prev => ({ ...prev, [b.courtbookingid]: 'approve' })); try { await updateCourtBooking(b.courtbookingid, { status: 'approved', bookingstatus: 'upcoming' }); setCourtBookings(prev => prev.map(x => x.courtbookingid === b.courtbookingid ? { ...x, status: 'approved', bookingstatus: 'upcoming' } : x)) } catch (e: any) { Alert.alert('Error', e?.message || t('COURT_PANEL_ERR_APPROVE')) } finally { setMutatingBookingIds(prev => { const n = { ...prev }; delete n[b.courtbookingid]; return n }) } }} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tc.brandMuted, alignItems: 'center', justifyContent: 'center', marginRight: 10, opacity: mutatingBookingIds[b.courtbookingid] ? 0.6 : 1 }}>
                              {mutatingBookingIds[b.courtbookingid] === 'approve' ? <ActivityIndicator size={14} /> : <Image source={ICONS.approve} style={{ width: 18, height: 18 }} resizeMode="contain" />}
                            </TouchableOpacity>
                            <TouchableOpacity disabled={!!mutatingBookingIds[b.courtbookingid]} onPress={async () => { setMutatingBookingIds(prev => ({ ...prev, [b.courtbookingid]: 'reject' })); try { await updateCourtBooking(b.courtbookingid, { status: 'rejected', bookingstatus: 'cancelled' }); setCourtBookings(prev => prev.map(x => x.courtbookingid === b.courtbookingid ? { ...x, status: 'rejected', bookingstatus: 'cancelled' } : x)) } catch (e: any) { Alert.alert('Error', e?.message || t('COURT_PANEL_ERR_REJECT')) } finally { setMutatingBookingIds(prev => { const n = { ...prev }; delete n[b.courtbookingid]; return n }) } }} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(239,68,68,0.18)', alignItems: 'center', justifyContent: 'center', opacity: mutatingBookingIds[b.courtbookingid] ? 0.6 : 1, marginRight: 8 }}>
                              {mutatingBookingIds[b.courtbookingid] === 'reject' ? <ActivityIndicator size={14} /> : <Image source={ICONS.reject} style={{ width: 18, height: 18 }} resizeMode="contain" />}
                            </TouchableOpacity>
                          </>
                        )}
                        {showAttendanceBtns && (
                          <>
                            <TouchableOpacity
                              disabled={!isAttendedEnabled || !!mutatingAttendanceIds[b.courtbookingid]}
                              onPress={async () => {
                                setMutatingAttendanceIds(prev => ({ ...prev, [b.courtbookingid]: 'attended' }))
                                try {
                                  // 'completed' is not a valid courtbookingstatus enum value; keep bookingstatus as 'approved'
                                  await updateCourtBooking(b.courtbookingid, { status: 'completed', bookingstatus: 'approved' })
                                  setCourtBookings(prev => prev.map(x => x.courtbookingid === b.courtbookingid ? { ...x, status: 'completed', bookingstatus: 'approved' } : x))
                                } catch (e: any) { Alert.alert('Error', e?.message || t('COMMON_LABEL_ERROR')) }
                                finally { setMutatingAttendanceIds(prev => { const n = { ...prev }; delete n[b.courtbookingid]; return n }) }
                              }}
                              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(34,197,94,0.18)', alignItems: 'center', justifyContent: 'center', marginRight: 6, opacity: (!isAttendedEnabled || !!mutatingAttendanceIds[b.courtbookingid]) ? 0.4 : 1 }}
                            >
                              {mutatingAttendanceIds[b.courtbookingid] === 'attended' ? <ActivityIndicator size={14} /> : <Image source={ICONS.attended} style={{ width: 18, height: 18 }} resizeMode="contain" />}
                            </TouchableOpacity>
                            <TouchableOpacity
                              disabled={!isNotAttendedEnabled || !!mutatingAttendanceIds[b.courtbookingid]}
                              onPress={async () => {
                                setMutatingAttendanceIds(prev => ({ ...prev, [b.courtbookingid]: 'missed' }))
                                try {
                                  await updateCourtBooking(b.courtbookingid, { status: 'missed', bookingstatus: 'missed' })
                                  setCourtBookings(prev => prev.map(x => x.courtbookingid === b.courtbookingid ? { ...x, status: 'missed', bookingstatus: 'missed' } : x))
                                } catch (e: any) { Alert.alert('Error', e?.message || t('COMMON_LABEL_ERROR')) }
                                finally { setMutatingAttendanceIds(prev => { const n = { ...prev }; delete n[b.courtbookingid]; return n }) }
                              }}
                              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(239,68,68,0.18)', alignItems: 'center', justifyContent: 'center', marginRight: 6, opacity: (!isNotAttendedEnabled || !!mutatingAttendanceIds[b.courtbookingid]) ? 0.4 : 1 }}
                            >
                              {mutatingAttendanceIds[b.courtbookingid] === 'missed' ? <ActivityIndicator size={14} /> : <Image source={ICONS.notAttended} style={{ width: 18, height: 18 }} resizeMode="contain" />}
                            </TouchableOpacity>
                          </>
                        )}
                        <TouchableOpacity activeOpacity={0.75} onPress={() => setExpandedNoteIds(prev => { const n = new Set(prev); if (n.has(b.courtbookingid)) n.delete(b.courtbookingid); else n.add(b.courtbookingid); return n })} style={{ padding: 6 }}>
                          <Image source={ICONS.userNote} style={{ width: 16, height: 16, tintColor: tc.iconMuted }} resizeMode="contain" />
                        </TouchableOpacity>
                      </View>
                    </View>
                    {noteExp && (
                      <View style={{ marginTop: 8, backgroundColor: tc.bgSurface, borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: tc.divider }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, marginBottom: 4 }}>{t('COMMON_LABEL_NOTE')}</Text>
                        <Text style={{ fontSize: 13, color: tc.textSecondary }}>{b.note?.trim() ? b.note : t('COMMON_EMPTY_NOTE')}</Text>
                      </View>
                    )}
                  </View>
                )
              }

              return (
                <>
                  {/* Court selector pills */}
                  {bookingBaseNames.length > 0 && (
                    <>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 4, gap: 8, paddingTop: 10 }}>
                        {bookingBaseNames.map((bn) => {
                          const active = bookingSelectedBaseName === bn
                          return (
                            <TouchableOpacity key={bn} onPress={() => { setBookingSelectedBaseName(bn); setBookingSelectedPcId(null); setBookingSelectedDate(null) }} style={[styles.subCourtPill, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, active && [styles.subCourtPillActive, { backgroundColor: tc.brand, borderColor: tc.brand }]]} activeOpacity={0.85}>
                              <Text style={[styles.subCourtPillText, { color: tc.textPrimary }, active && [styles.subCourtPillTextActive, { color: tc.btnPrimaryText }]]} numberOfLines={1}>{bn}</Text>
                            </TouchableOpacity>
                          )
                        })}
                      </ScrollView>
                      {/* Part tabs */}
                      {bookingSelectedBaseName && (
                        <View style={[styles.segmented, { marginTop: 8, borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                          {playingCourts.filter((pc) => pc.base_name === bookingSelectedBaseName).map((pc) => {
                            const partLabel = String(pc.name || pc.base_name || `Court ${pc.playingcourtid}`)
                            const active = bookingSelectedPcId === pc.playingcourtid
                            return (
                              <TouchableOpacity key={pc.playingcourtid} onPress={() => { setBookingSelectedPcId(pc.playingcourtid); setBookingSelectedDate(null) }} style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]} activeOpacity={0.8}>
                                <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{partLabel}</Text>
                              </TouchableOpacity>
                            )
                          })}
                        </View>
                      )}
                    </>
                  )}

                  {/* Schedule calendar for selected pc */}
                  {bookingSelectedPcId != null && (
                    <View style={{ marginTop: 14 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>{t('COURT_PANEL_SCHEDULE')}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <TouchableOpacity disabled={bookingWeekOffset === 0} onPress={() => setBookingWeekOffset((w) => w - 1)} style={{ padding: 6, borderRadius: 8, backgroundColor: tc.bgSurface, opacity: bookingWeekOffset === 0 ? 0.35 : 1 }}>
                            <Image source={ICONS.arrowright} style={{ width: 18, height: 18, tintColor: tc.textPrimary, transform: [{ rotate: '180deg' }] }} resizeMode="contain" />
                          </TouchableOpacity>
                          <TouchableOpacity disabled={bookingWeekOffset === 4} onPress={() => setBookingWeekOffset((w) => w + 1)} style={{ padding: 6, borderRadius: 8, backgroundColor: tc.bgSurface, opacity: bookingWeekOffset === 4 ? 0.35 : 1 }}>
                            <Image source={ICONS.arrowright} style={{ width: 18, height: 18, tintColor: tc.textPrimary }} resizeMode="contain" />
                          </TouchableOpacity>
                        </View>
                      </View>
                      <View style={styles.weekRow}>
                        {bookingWeekDays.map((d) => {
                          const hasBookings = bookedDates.has(d.dateStr)
                          const isSelected = bookingSelectedDate === d.dateStr
                          const isAvailable = availableWeekdays.length === 0 || availableWeekdays.includes(d.label)
                          const today = new Date()
                          const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate())
                          const isPast = bookingWeekOffset === 0 && d.d < todayOnly
                          return (
                            <TouchableOpacity
                              key={d.dateStr}
                              onPress={() => {
                                if (isPast) return
                                setBookingSelectedDate((prev) => prev === d.dateStr ? null : d.dateStr)
                              }}
                              style={[
                                styles.dayCell,
                                { backgroundColor: tc.bgSurface, borderColor: tc.divider },
                                isSelected && { backgroundColor: tc.brand, borderColor: tc.brand },
                                hasBookings && !isSelected && { backgroundColor: isDark ? '#7C3AED' : '#FB923C', borderColor: isDark ? '#9B6DFF' : '#F59E0B' },
                                !hasBookings && !isSelected && !isPast && { backgroundColor: isDark ? '#F0F2FF' : '#E5E7EB', borderColor: isDark ? '#C0C4D0' : '#D1D5DB' },
                                isPast && { backgroundColor: isDark ? '#1C2040' : '#F3F4F6', borderColor: tc.divider },
                              ]}
                              activeOpacity={0.8}
                              disabled={isPast}
                            >
                              <Text style={[styles.dayLabel, { color: tc.textPrimary }, isSelected && { color: tc.btnPrimaryText }, hasBookings && !isSelected && { color: '#FFFFFF' }, !hasBookings && !isSelected && !isPast && isDark && { color: '#1A1A2E' }, isPast && { color: tc.textMuted }]} numberOfLines={1}>{d.label}</Text>
                              <Text style={{ fontSize: 14, fontWeight: '700', color: isSelected ? tc.btnPrimaryText : isPast ? tc.textMuted : hasBookings ? '#FFFFFF' : (!isPast && isDark) ? '#1A1A2E' : tc.textPrimary, marginTop: 4 }}>{d.d.getDate()}</Text>
                            </TouchableOpacity>
                          )
                        })}
                      </View>
                      {/* Time slot visualization for selected date */}
                      {bookingSelectedDate && pcAvailRow && (
                        <View style={{ marginTop: 12, backgroundColor: tc.brandSoft, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: tc.brandMuted }}>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.brand, marginBottom: 8 }}>
                            {slotSelectedBooking
                              ? `${t('COURT_PANEL_BOOKING_PREFIX')}${formatBookingTimeOnly(slotSelectedBooking.start_timestamp, slotSelectedBooking.end_timestamp, t('COURT_PANEL_UNKNOWN_TIME'))}`
                              : `${t('COURT_PANEL_OPEN_PREFIX')}${String(pcAvailRow.start_time || '').slice(0, 5)} \u2013 ${String(pcAvailRow.end_time || '').slice(0, 5)}`}
                          </Text>
                          {pcTimeSlotsList.length === 0 ? (
                            <Text style={{ color: tc.textSecondary, fontSize: 13 }}>{t('COURT_PANEL_NO_TIME_SLOTS')}</Text>
                          ) : (
                            <View>
                              {pcTimeSlotsList.map((slot, idx) => {
                                const booking = slotToBookingMap.get(slot)
                                const isBooked = !!booking
                                const isInSelectedGroup = isBooked && !!slotSelectedBooking && booking.courtbookingid === slotSelectedBooking.courtbookingid
                                const prevSlot = idx > 0 ? pcTimeSlotsList[idx - 1] : null
                                const nextSlot = idx < pcTimeSlotsList.length - 1 ? pcTimeSlotsList[idx + 1] : null
                                const prevBooking = prevSlot ? slotToBookingMap.get(prevSlot) : undefined
                                const nextBooking = nextSlot ? slotToBookingMap.get(nextSlot) : undefined
                                const connToPrev = isBooked && prevBooking?.courtbookingid === booking.courtbookingid
                                const connToNext = isBooked && nextBooking?.courtbookingid === booking.courtbookingid
                                const slotBg = isInSelectedGroup ? tc.brand : (isBooked ? tc.brand : tc.brandSoft)
                                const slotTextColor = isBooked ? tc.btnPrimaryText : tc.brand
                                const slotBorderColor = isInSelectedGroup ? tc.brand : (isBooked ? tc.brand : tc.brandMuted)
                                return (
                                  <View key={slot} style={{ height: 40, marginBottom: connToNext ? 0 : 4, flexDirection: 'row', alignItems: 'center' }}>
                                    {/* Left connector track with dot */}
                                    <View style={{ width: 22, alignSelf: 'stretch', position: 'relative' }}>
                                      {isBooked && (
                                        <>
                                          <View style={{ position: 'absolute', left: 8, top: 16, width: 8, height: 8, borderRadius: 4, backgroundColor: tc.brand, zIndex: 2 }} />
                                          {connToPrev && <View style={{ position: 'absolute', left: 11, top: 0, width: 2, height: 16, backgroundColor: tc.brand }} />}
                                          {connToNext && <View style={{ position: 'absolute', left: 11, top: 24, width: 2, height: 16, backgroundColor: tc.brand }} />}
                                        </>
                                      )}
                                    </View>
                                    {/* Slot box */}
                                    <View style={{ flex: 1, height: 40 }}>
                                    <TouchableOpacity
                                      onPress={() => {
                                        if (!isBooked) { setBookingSelectedSlot(null); return }
                                        setBookingSelectedSlot(prev => prev === slot ? null : slot)
                                      }}
                                      disabled={!isBooked}
                                      activeOpacity={isBooked ? 0.8 : 1}
                                      style={{
                                        flex: 1, height: 40, backgroundColor: slotBg,
                                        borderTopLeftRadius: connToPrev ? 0 : 8, borderTopRightRadius: connToPrev ? 0 : 8,
                                        borderBottomLeftRadius: connToNext ? 0 : 8, borderBottomRightRadius: connToNext ? 0 : 8,
                                        paddingHorizontal: 10, justifyContent: 'center',
                                        borderWidth: 0.5, borderColor: slotBorderColor,
                                        borderTopWidth: connToPrev ? 0 : 0.5,
                                      }}
                                    >
                                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text style={{ fontSize: 12, fontWeight: '700', color: slotTextColor }}>
                                          {slot}{pcTimeSlotsList[idx + 1] ? ` \u2013 ${pcTimeSlotsList[idx + 1]}` : ` \u2013 ${String(pcAvailRow.end_time || '').slice(0, 5)}`}
                                        </Text>
                                        {isBooked && booking && (
                                          <Text style={{ fontSize: 11, color: tc.btnPrimaryText, opacity: 0.85, flexShrink: 1, marginLeft: 6 }} numberOfLines={1}>
                                            {bookingUserNames[booking.userid] || `User ${booking.userid}`}
                                          </Text>
                                        )}
                                      </View>
                                    </TouchableOpacity>
                                    </View>
                                  </View>
                                )
                              })}
                            </View>
                          )}
                          {/* Expand card: booking details when a slot is selected â€“ uses renderBookingRow for full attendance support */}
                          {slotSelectedBooking && (
                            <View style={{ marginTop: 4 }}>
                              {renderBookingRow(slotSelectedBooking, false, undefined, true)}
                            </View>
                          )}
                        </View>
                      )}
                      {bookingSelectedDate && !pcAvailRow && dateBookings.length === 0 && (
                        <View style={{ marginTop: 12, backgroundColor: tc.brandSoft, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: tc.brandMuted }}>
                          <Text style={{ color: tc.textSecondary, fontSize: 13 }}>{t('COURT_PANEL_NO_BOOKINGS_DATE')}</Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Booking error / loading */}
                  {bookingError && <Text style={{ color: tc.error, marginBottom: 8, marginTop: 10 }}>{t('COURT_PANEL_LOAD_ERROR_PREFIX')}{bookingError}</Text>}
                  {bookingLoading && <View style={{ paddingVertical: 16, alignItems: 'center' }}><ActivityIndicator size="small" color={COLORS.neutral800} /></View>}

                  {/* Applicant List */}
                  <Text style={{ fontSize: 13, fontWeight: '700', marginTop: 16, marginBottom: 6, color: tc.textPrimary }}>{t('COURT_PANEL_APPLICANT_LIST')}</Text>
                  {bookingApplicants.length === 0 ? (
                    <View style={{ backgroundColor: tc.bgSurface, borderRadius: 10, padding: 12, marginBottom: 8 }}><Text style={{ color: tc.textMuted }}>{t('COURT_PANEL_NO_APPLICANTS')}</Text></View>
                  ) : bookingApplicants.map((b) => renderBookingRow(b, true))}

                  {/* Owner List */}
                  <Text style={{ fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6, color: tc.textPrimary }}>{t('COURT_PANEL_PARTICIPANT_LIST')}</Text>
                  {mergedParticipants.length === 0 ? (
                    <View style={{ backgroundColor: tc.bgSurface, borderRadius: 10, padding: 12, marginBottom: 8 }}><Text style={{ color: tc.textMuted }}>{t('COURT_PANEL_NO_PARTICIPANTS')}</Text></View>
                  ) : mergedParticipants.map(({ row, timeDisplay }) => renderBookingRow(row, false, timeDisplay, false))}

                  {/* Owner List */}
                  <Text style={{ fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6, color: tc.textPrimary }}>{t('COURT_PANEL_OWNER_LIST')}</Text>
                  {!bookingOwner ? (
                    <View style={{ backgroundColor: tc.bgSurface, borderRadius: 10, padding: 12, marginBottom: 8 }}><Text style={{ color: tc.textMuted }}>{t('COURT_PANEL_NO_OWNER')}</Text></View>
                  ) : (
                    <View style={{ backgroundColor: tc.bgSurface, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        onPress={() => router.push({ pathname: '/event/profileSpectate', params: { userid: String(bookingOwner.userid) } } as any)}
                        style={{ flexDirection: 'row', alignItems: 'center' }}
                      >
                        {bookingOwner.pfp ? (
                          <ExpoImage source={{ uri: bookingOwner.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: tc.divider }} contentFit="cover" cachePolicy="disk" />
                        ) : (
                          <Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />
                        )}
                        <View style={{ marginLeft: 10, flex: 1 }}>
                          <Text style={{ fontWeight: '700', fontSize: 13, color: tc.textPrimary }} numberOfLines={1}>{bookingOwner.name}</Text>
                          <Text style={{ color: tc.textSecondary, marginTop: 2 }} numberOfLines={1}>{t('COURT_PANEL_ROLE_OWNER')}</Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Administrator List */}
                  <Text style={{ fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6, color: tc.textPrimary }}>{t('COURT_PANEL_ADMIN_LIST')}</Text>
                  <View style={{ backgroundColor: tc.bgSurface, borderRadius: 10, padding: 12, marginBottom: 8 }}><Text style={{ color: tc.textMuted }}>{t('COURT_PANEL_NO_ADMINS')}</Text></View>


                </>
              )
            })()
          ) : editMode === 'main' ? (
            <>
              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_VENUE_NAME')}</Text>
              <TextInput value={editName} onChangeText={setEditName} placeholder={t('COURT_PANEL_PLACEHOLDER_VENUE_NAME')} placeholderTextColor={tc.placeholder} style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]} />

              {playingCourtsLoading ? (
                <SkeletonPulse>
                  <View style={styles.subCourtRow}>
                    <SkeletonBox width={108} height={36} radius={18} />
                    <SkeletonBox width={118} height={36} radius={18} />
                    <SkeletonBox width={96} height={36} radius={18} />
                  </View>
                </SkeletonPulse>
              ) : subCourtOptions.length === 0 ? (
                <Text style={[styles.helperText, { color: tc.textSecondary }]}>{t('COURT_PANEL_NO_COURTS_FOUND')}</Text>
              ) : (
                <View style={{ marginBottom: 6 }}>
                  {subCourtOptions.map((base, idx) => {
                    const active = String(selectedVenueCourtBaseName || '').trim().toLowerCase() === base.toLowerCase()
                    return (
                      <View key={`main-${base}`} style={{ marginBottom: 10 }}>
                        <Text style={[styles.label, { color: tc.textPrimary }]}>{`${t('COURT_PANEL_TAB_COURT')} ${idx + 1}:`}</Text>
                        {active ? (
                          <TextInput
                            value={venueCourtBaseEditName}
                            onChangeText={setVenueCourtBaseEditName}
                            placeholder={`${t('COURT_PANEL_TAB_COURT')} ${idx + 1} ${t('COURT_REGISTER_LABEL_NAME')}`}
                            placeholderTextColor={tc.placeholder}
                            style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                          />
                        ) : (
                          <TouchableOpacity
                            activeOpacity={0.85}
                            onPress={() => {
                              setSelectedVenueCourtBaseName(base)
                              setVenueCourtBaseEditName(base)
                            }}
                            style={[styles.input, { justifyContent: 'center', backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
                          >
                            <Text style={{ fontSize: 14, color: tc.textPrimary }} numberOfLines={1}>{base}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )
                  })}
                </View>
              )}

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_ADDRESS')}</Text>
              <View style={[styles.addressRow, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}>
                <TextInput
                  value={editAddress}
                  onChangeText={(v) => {
                    setEditAddress(v)
                    setVerifyError(null)
                  }}
                  placeholder={t('COURT_PANEL_PLACEHOLDER_ADDRESS')}
                  placeholderTextColor={tc.placeholder}
                  style={[styles.addressInput, { color: tc.textPrimary, paddingRight: verifiedCoord ? 36 : 12 }]}
                />
                {verifiedCoord ? (
                  <Image source={ICONS.tick} style={{ position: 'absolute', right: 12, top: '50%', marginTop: -8, width: 16, height: 16, tintColor: COLORS.green }} resizeMode="contain" />
                ) : addressLoading ? (
                  <ActivityIndicator size="small" color={tc.textMuted} style={{ position: 'absolute', right: 12, top: '50%', marginTop: -8 }} />
                ) : null}
              </View>

              {addressLoading ? <Text style={{ color: tc.textMuted, marginTop: 6 }}>{t('COURT_PANEL_SEARCHING')}</Text> : null}

              {addressSuggestions.length > 0 ? (
                <View style={[styles.suggestBox, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}>
                  <ScrollView style={styles.suggestScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {addressSuggestions.map((s) => (
                      <TouchableOpacity
                        key={s.place_id}
                        activeOpacity={0.85}
                        style={[styles.suggestRow, { borderBottomColor: tc.divider }]}
                        onPress={() => {
                          setSelectedPlaceId(s.place_id)
                          setEditAddress(s.description)
                          setAddressSuggestions([])
                          setVerifyError(null)
                          setVerifiedCoord(null)
                          setLastGeocode(null)
                        }}
                      >
                        <Text style={[styles.suggestText, { color: tc.textPrimary }]} numberOfLines={2}>
                          {s.description}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {!!verifyError && <Text style={styles.verifyErrorText}>{verifyError}</Text>}

              <View style={styles.verifyRow}>
                {(() => {
                  const addressUnchanged = canonicalizeAddress(editAddress) === canonicalizeAddress(originalAddressRef.current ?? '')
                  const verifyDisabled = addressUnchanged || addressLoading
                  return (
                    <TouchableOpacity
                      onPress={handleVerifyLocation}
                      disabled={verifyDisabled}
                      style={[styles.smallBtn, styles.smallBtnRed, styles.verifyBtnFull, { backgroundColor: tc.brand, opacity: verifyDisabled ? 0.45 : 1 }]}
                      activeOpacity={0.85}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={[styles.smallBtnText, { color: tc.btnPrimaryText }]}>{t('COURT_PANEL_BTN_VERIFY')}</Text>
                        {verifiedCoord ? (
                          <Image source={ICONS.tick} style={{ width: 18, height: 18, marginLeft: 8, tintColor: tc.btnPrimaryText }} resizeMode="contain" />
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  )
                })()}
              </View>

              {warnings.length ? (
                <View style={{ marginTop: 6 }}>
                  {warnings.map((w, idx) => (
                    <Text key={idx} style={{ color: tc.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {w}
                    </Text>
                  ))}
                </View>
              ) : null}

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_VENUE')}</Text>
              <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                {(['Indoor', 'Outdoor', 'Both'] as const).map((v) => {
                  const active = editVenue === v
                  const label = v === 'Indoor' ? t('MAP_LABEL_INDOOR') : v === 'Outdoor' ? t('MAP_LABEL_OUTDOOR') : t('COURT_PANEL_VENUE_BOTH')
                  return (
                    <TouchableOpacity key={v} onPress={() => setEditVenue(v)} style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]} activeOpacity={0.8}>
                      <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_SERVICES')}</Text>
            </>
          ) : (
            <>
              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_SELECT_COURT')}</Text>
              {playingCourtsLoading ? (
                <SkeletonPulse>
                  <View style={styles.subCourtRow}>
                    <SkeletonBox width={108} height={36} radius={18} />
                    <SkeletonBox width={118} height={36} radius={18} />
                    <SkeletonBox width={96} height={36} radius={18} />
                  </View>
                </SkeletonPulse>
              ) : subCourtOptions.length === 0 ? (
                <Text style={[styles.helperText, { color: tc.textSecondary }]}>{t('COURT_PANEL_NO_COURTS_FOUND')}</Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subCourtRow}>
                  {subCourtOptions.map((base) => {
                    const active = String(selectedSubBaseName || '').trim().toLowerCase() === base.toLowerCase()
                    return (
                      <TouchableOpacity
                        key={base}
                        onPress={() => {
                          setSelectedSubBaseName(base)
                          setSelectedSubPart('full')
                        }}
                        activeOpacity={0.85}
                        style={[styles.subCourtPill, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, active && [styles.subCourtPillActive, { backgroundColor: tc.brand, borderColor: tc.brand }]]}
                      >
                        <Text style={[styles.subCourtPillText, { color: tc.textPrimary }, active && [styles.subCourtPillTextActive, { color: tc.btnPrimaryText }]]} numberOfLines={1}>
                          {base}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                </ScrollView>
              )}

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_SELECT_HALF')}</Text>
              <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                {([
                  { key: 'full', label: t('COURT_PANEL_HALF_FULL') },
                  { key: 'half_a', label: t('COURT_PANEL_HALF_A') },
                  { key: 'half_b', label: t('COURT_PANEL_HALF_B') },
                ] as const).map((opt) => {
                  const active = selectedSubPart === opt.key
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      onPress={() => setSelectedSubPart(opt.key)}
                      style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{opt.label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_COURT_NAME')}</Text>
              <TextInput value={subEditName} onChangeText={setSubEditName} placeholder={t('COURT_PANEL_PLACEHOLDER_COURT_NAME')} placeholderTextColor={tc.placeholder} style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]} />

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_IMAGES')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                {(subEditImages || []).map((uri) => (
                  <View key={uri} style={[styles.coverFrame, { backgroundColor: tc.bgElevated, borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                    <TouchableOpacity style={styles.coverPressable} activeOpacity={0.9} onPress={() => setZoomImageUri(uri)}>
                      <ExpoImage source={{ uri: optimizeRemoteImageUrl(uri) }} style={styles.coverImage} contentFit="cover" cachePolicy="disk" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => requestRemoveImage(uri, 'sub')} style={styles.removeXBtn} activeOpacity={0.85}>
                      <Text style={styles.removeXText}>×</Text>
                    </TouchableOpacity>
                  </View>
                ))}

                {(subEditImages || []).length < 1 && (
                  <View style={[styles.coverFrame, { backgroundColor: tc.bgElevated, borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                    <TouchableOpacity
                      onPress={pickSubCourtImage}
                      disabled={imageUploading}
                      activeOpacity={0.85}
                      style={styles.coverPressable}
                    >
                      {imageUploading ? <ActivityIndicator size="small" color={COLORS.neutral800} /> : <Text style={[styles.addPlus, { color: tc.textMuted }]}>+</Text>}
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>

              {selectedSubPart === 'full' && (
                <>
                  <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_AVAILABILITY')}</Text>
                  <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                    {(['available', 'unavailable'] as const).map((v) => {
                      const active = availabilityStatus === v
                      const label = v === 'available' ? t('COURT_PANEL_STATUS_AVAILABLE') : t('COURT_PANEL_STATUS_UNAVAILABLE')
                      return (
                        <TouchableOpacity key={v} onPress={() => setAvailabilityStatus(v)} style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]} activeOpacity={0.8}>
                          <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{label}</Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                  <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_SCHEDULE')}</Text>
                  <View style={styles.weekRow}>
                    {WEEK_DAYS.map((label) => {
                      const active = scheduleDays.includes(label)
                      const dayDisplayKey = `MAP_DAY_${label.toUpperCase()}` as any
                      return (
                        <TouchableOpacity
                          key={label}
                          onPress={() => setScheduleDays((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]))}
                          style={[styles.dayCell, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, active && [styles.dayCellSelected, { backgroundColor: tc.brandSoft, borderColor: tc.brandSoft }]]}
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.dayLabel, { color: tc.textPrimary }, active && [styles.dayLabelSelected, { color: tc.brand }]]}>{t(dayDisplayKey)}</Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                  <View style={styles.timeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_START_TIME')}</Text>
                      <TextInput
                        value={startTime}
                        onChangeText={(v) => setStartTime(normalizeTimeInput(v))}
                        placeholder="08:00"
                        placeholderTextColor={tc.placeholder}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        maxLength={5}
                        style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_END_TIME')}</Text>
                      <TextInput
                        value={endTime}
                        onChangeText={(v) => setEndTime(normalizeTimeInput(v))}
                        placeholder="22:00"
                        placeholderTextColor={tc.placeholder}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        maxLength={5}
                        style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                      />
                    </View>
                  </View>
                </>
              )}
            </>
          )}

          {editMode === 'main' ? (
            <>
          {servicesLoading ? (
            <SkeletonPulse>
              <View style={{ marginTop: 8, gap: 10 }}>
                <SkeletonBox width={'100%'} height={116} radius={12} />
                <SkeletonBox width={'100%'} height={116} radius={12} />
              </View>
            </SkeletonPulse>
          ) : serviceDrafts.filter((d) => !d.deleted).length === 0 ? (
            <Text style={[styles.helperText, { color: tc.textSecondary }]}>No services yet.</Text>
          ) : (
            <View style={{ marginTop: 8, gap: 10 }}>
              {serviceDrafts
                .filter((d) => !d.deleted)
                .map((d) => (
                  <View key={d.localId} style={[styles.serviceCard, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}>
                    <View style={styles.serviceCardHeader}>
                      <Text style={[styles.serviceCardTitle, { color: tc.textPrimary }]} numberOfLines={1}>
                        {d.name.trim() ? d.name.trim() : t('COURT_PANEL_SERVICE_NEW')}
                      </Text>
                      <View style={styles.serviceHeaderActions}>
                        <TouchableOpacity
                          onPress={() => {
                            setServiceDeleteCandidateLocalId(d.localId)
                            setConfirmServiceDeleteVisible(true)
                          }}
                          activeOpacity={0.85}
                          style={[styles.serviceHeaderDeleteCircle, { backgroundColor: tc.error }]}
                          hitSlop={8}
                        >
                          <Text style={styles.serviceHeaderDeleteCircleText}>{t('COMMON_BTN_DELETE')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => setServiceExpanded((prev) => ({ ...prev, [d.localId]: !(prev[d.localId] ?? false) }))}
                          activeOpacity={0.85}
                          hitSlop={8}
                        >
                          <Image
                            source={ICONS.arrowdown}
                            style={[
                              styles.serviceChevron,
                              { tintColor: tc.textSecondary },
                              !(serviceExpanded[d.localId] ?? false) && { transform: [{ rotate: '-90deg' }] },
                            ]}
                            resizeMode="contain"
                          />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {(serviceExpanded[d.localId] ?? false) ? (
                      <>

                    <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_NAME')}</Text>
                    <TextInput
                      value={d.name}
                      onChangeText={(v) => updateServiceDraft(d.localId, { name: v })}
                      placeholder="Service name"
                      placeholderTextColor={tc.placeholder}
                      style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                    />

                    <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_CATEGORY')}</Text>
                    <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                      {(['consumable', 'rental'] as const).map((v) => {
                        const active = d.category === v
                        const catLabel = v === 'consumable' ? t('COURT_PANEL_CATEGORY_CONSUMABLE') : t('COURT_PANEL_CATEGORY_RENTAL')
                        return (
                          <TouchableOpacity
                            key={v}
                            onPress={() => updateServiceDraft(d.localId, { category: v })}
                            style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
                            activeOpacity={0.8}
                          >
                            <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>
                              {catLabel}
                            </Text>
                          </TouchableOpacity>
                        )
                      })}
                    </View>

                    <View style={styles.timeRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_PRICE')}</Text>
                        <TextInput
                          value={d.price}
                          onChangeText={(v) => updateServiceDraft(d.localId, { price: digitsOnly(v) })}
                          placeholder="0"
                          placeholderTextColor={tc.placeholder}
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_STOCK')}</Text>
                        <TextInput
                          value={d.stock}
                          onChangeText={(v) => updateServiceDraft(d.localId, { stock: digitsOnly(v) })}
                          placeholder="0"
                          placeholderTextColor={tc.placeholder}
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
                        />
                      </View>
                    </View>

                    <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_STATUS')}</Text>
                    <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                      {(['active', 'inactive'] as const).map((v) => {
                        const active = d.status === v
                        const statusLabel = v === 'active' ? t('COURT_PANEL_STATUS_ACTIVE') : t('COURT_PANEL_STATUS_INACTIVE')
                        return (
                          <TouchableOpacity
                            key={v}
                            onPress={() => updateServiceDraft(d.localId, { status: v })}
                            style={[styles.segment, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
                            activeOpacity={0.8}
                          >
                            <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>
                              {statusLabel}
                            </Text>
                          </TouchableOpacity>
                        )
                      })}
                    </View>

                    <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_IMAGES')}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                      {(d.images || []).map((uri) => (
                        <View key={uri} style={[styles.serviceCoverFrame, { borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                          <TouchableOpacity style={styles.coverPressable} activeOpacity={0.9} onPress={() => setZoomImageUri(uri)}>
                            <ExpoImage source={{ uri: optimizeRemoteImageUrl(uri) }} style={styles.serviceCoverImage} contentFit="cover" cachePolicy="disk" />
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => removeServiceImage(d.localId, uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                            <Text style={styles.removeXText}>×</Text>
                          </TouchableOpacity>
                        </View>
                      ))}

                      {(d.images || []).length < 1 && (
                        <View style={[styles.serviceCoverFrame, { backgroundColor: tc.bgElevated, borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                          <TouchableOpacity
                            onPress={() => pickServiceImage(d.localId)}
                            disabled={imageUploading}
                            activeOpacity={0.85}
                            style={styles.coverPressable}
                          >
                            {imageUploading ? (
                              <ActivityIndicator size="small" color={COLORS.neutral800} />
                            ) : (
                              <Text style={[styles.addPlus, { color: tc.textMuted }]}>+</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      )}
                    </ScrollView>

                      </>
                    ) : null}
                  </View>
                ))}
            </View>
          )}

          <TouchableOpacity
            onPress={addServiceDraft}
            activeOpacity={0.85}
            style={[styles.smallBtn, styles.smallBtnRed, { marginTop: 10, backgroundColor: tc.brand }]}
          >
            <Text style={[styles.smallBtnText, { color: tc.btnPrimaryText }]}>{t('COURT_PANEL_BTN_ADD_SERVICE')}</Text>
          </TouchableOpacity>

            <View style={styles.rowBetween}>
              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COMMON_LABEL_IMAGES')}</Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
              {editImages.map((uri) => (
                <View key={uri} style={[styles.coverFrame, { backgroundColor: tc.bgElevated, borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                  <TouchableOpacity style={styles.coverPressable} activeOpacity={0.9} onPress={() => setZoomImageUri(uri)}>
                    <ExpoImage source={{ uri: optimizeRemoteImageUrl(uri) }} style={styles.coverImage} contentFit="cover" cachePolicy="disk" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => requestRemoveImage(uri, 'main')} style={styles.removeXBtn} activeOpacity={0.85}>
                    <Text style={styles.removeXText}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}

              {editImages.length < 3 && (
                <View style={[styles.coverFrame, { backgroundColor: tc.bgElevated, borderColor: tc.border }, imageUploading && styles.btnDisabled]}>
                  <TouchableOpacity onPress={pickImage} disabled={imageUploading} activeOpacity={0.85} style={styles.coverPressable}>
                    {imageUploading ? <ActivityIndicator size="small" color={COLORS.neutral800} /> : <Text style={[styles.addPlus, { color: tc.textMuted }]}>+</Text>}
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>

            <TouchableOpacity
              onPress={() => setEditAutoApprove((v) => !v)}
              activeOpacity={0.85}
              style={[styles.autoApproveRow, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
            >
              <View style={[styles.autoApproveBox, { backgroundColor: tc.bgInput, borderColor: tc.divider }, editAutoApprove && [styles.autoApproveBoxActive, { backgroundColor: tc.brand, borderColor: tc.brand }]]}>
                {editAutoApprove ? <Image source={ICONS.tick} style={[styles.autoApproveTick, { tintColor: tc.btnPrimaryText }]} resizeMode="contain" /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.autoApproveTitle, { color: tc.textPrimary }]}>{t('COURT_PANEL_AUTO_APPROVE_TITLE')}</Text>
                <Text style={[styles.autoApproveHint, { color: tc.textSecondary }]}>{t('COURT_PANEL_AUTO_APPROVE_HINT')}</Text>
              </View>
            </TouchableOpacity>
          </>
          ) : null}

          {editMode !== 'booking' && (
            <>
          <TouchableOpacity
            onPress={onSave}
            disabled={saveDisabled}
            style={[
              styles.saveBtn,
              { backgroundColor: tc.brand },
              saveDisabled && [styles.saveBtnDisabled, { backgroundColor: tc.brandMuted }],
            ]}
            activeOpacity={0.85}
          >
            <Text style={[styles.saveBtnText, { color: tc.btnPrimaryText }]}>{saving ? t('COURT_PANEL_BTN_SAVING') : t('COURT_PANEL_BTN_SAVE_CHANGES')}</Text>
          </TouchableOpacity>

          {saveSuccessMessage ? <Text style={[styles.saveSuccessText, { color: tc.success }]}>{saveSuccessMessage}</Text> : null}

          {availabilityLoading ? <Text style={{ marginTop: 8, color: tc.textMuted }}>{t('COURT_PANEL_LOADING_SCHEDULE')}</Text> : null}
            </>
          )}
        </View>
      )}

      <Modal visible={removeImageConfirmVisible} transparent animationType="fade" onRequestClose={() => setRemoveImageConfirmVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('COURT_PANEL_MODAL_REMOVE_IMAGE')}</Text>
            <Text style={[styles.modalText, { color: tc.textSecondary }]}>
              {removeImageContext === 'sub' ? t('COURT_PANEL_MODAL_REMOVE_IMAGE_COURT') : t('COURT_PANEL_MODAL_REMOVE_IMAGE_VENUE')}
            </Text>
            <View style={styles.modalRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
                activeOpacity={0.85}
                onPress={() => {
                  setRemoveImageConfirmVisible(false)
                  setRemoveImageCandidateUri(null)
                }}
              >
                <Text style={[styles.modalBtnGhostText, { color: tc.textPrimary }]}>{t('COMMON_BTN_CANCEL')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnDanger]} activeOpacity={0.85} onPress={onConfirmRemoveImage}>
                <Text style={styles.modalBtnDangerText}>{t('COMMON_BTN_REMOVE')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={confirmServiceDeleteVisible} transparent animationType="fade" onRequestClose={() => setConfirmServiceDeleteVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('COURT_PANEL_MODAL_DELETE_SERVICE_TITLE')}</Text>
            <Text style={[styles.modalText, { color: tc.textSecondary }]}>{t('COURT_PANEL_MODAL_DELETE_SERVICE_BODY')}</Text>
            <View style={styles.modalRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
                activeOpacity={0.85}
                onPress={() => {
                  setConfirmServiceDeleteVisible(false)
                  setServiceDeleteCandidateLocalId(null)
                }}
              >
                <Text style={[styles.modalBtnGhostText, { color: tc.textPrimary }]}>{t('COMMON_BTN_CANCEL')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnDanger]}
                activeOpacity={0.85}
                onPress={() => {
                  if (serviceDeleteCandidateLocalId) markDeleteServiceDraft(serviceDeleteCandidateLocalId)
                  setConfirmServiceDeleteVisible(false)
                  setServiceDeleteCandidateLocalId(null)
                }}
              >
                <Text style={styles.modalBtnDangerText}>{t('COMMON_BTN_DELETE')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!zoomImageUri} transparent animationType="fade" onRequestClose={() => setZoomImageUri(null)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={styles.zoomModalRoot}>
            <Pressable style={styles.zoomBackdrop} onPressIn={() => setZoomImageUri(null)} />
            <View style={styles.zoomImageWrap} pointerEvents="box-none" collapsable={false}>
              {!!zoomImageUri && (
                <GestureDetector gesture={zoomGesture}>
                  <Animated.Image
                    source={{ uri: optimizeRemoteImageUrl(zoomImageUri) }}
                    style={[
                      {
                        width: zoomFrameWidth,
                        height: zoomFrameHeight,
                      },
                      zoomAnimatedStyle,
                    ]}
                    resizeMode="contain"
                  />
                </GestureDetector>
              )}
            </View>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F0F0F0',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
  },
  emptyText: {
    color: '#666',
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  card: {
    width: 288,
    borderRadius: 14,
    backgroundColor: '#fff',
    marginRight: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignSelf: 'flex-start',
  },
  cardSelected: {
    borderColor: COLORS.brandOrangeDeep,
  },
  cardImageWrap: {
    width: '100%',
    height: 96,
    backgroundColor: '#F3F4F6',
  },
  cardImage: {
    width: '100%',
    height: '100%',
  },
  cardImageFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111',
    lineHeight: 20,
  },
  cardSub: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '400',
    color: COLORS.neutral700,
  },
  label: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: '700',
    color: '#111',
  },
  input: {
    marginTop: 6,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    fontSize: 14,
    fontWeight: '400',
    color: '#111',
  },
  addressRow: {
    marginTop: 6,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  addressInput: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 12,
    fontSize: 14,
    fontWeight: '400',
    color: '#111',
  },
  addressEditBtn: {
    width: 44,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressEditIcon: {
    width: 16,
    height: 16,
    tintColor: COLORS.neutral700,
  },
  segmented: {
    flexDirection: 'row',
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: COLORS.orange200,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.slate900,
  },
  segmentTextActive: {
    color: COLORS.brown900,
  },
  weekRow: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 6,
  },

  subCourtRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 6,
    paddingBottom: 2,
    gap: 10,
  },
  subCourtPill: {
    maxWidth: 240,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
  },
  subCourtPillActive: {
    backgroundColor: COLORS.brandOrangeDeep,
    borderColor: COLORS.brandOrangeDeep,
  },
  subCourtPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.slate900,
  },
  subCourtPillTextActive: {
    color: '#fff',
  },
  dayCell: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  dayCellSelected: {
    backgroundColor: COLORS.orange200,
    borderColor: COLORS.orange200,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111',
  },
  dayLabelSelected: {
    color: '#fff',
  },

  helperText: {
    color: COLORS.neutral700,
    fontWeight: '700',
    fontSize: 13,
  },

  serviceCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 14,
    backgroundColor: '#fff',
    padding: 12,
  },
  serviceCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  serviceCardTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#111',
    paddingRight: 10,
  },
  serviceDeleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.neutral200,
  },
  serviceDeleteText: {
    color: COLORS.danger500,
    fontWeight: '700',
    fontSize: 12,
  },
  serviceHeaderBtnText: {
    color: COLORS.neutral700,
    fontWeight: '700',
    fontSize: 12,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  rowBetween: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  verifyRow: {
    marginTop: 10,
  },
  smallBtn: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  smallBtnRed: {
    backgroundColor: COLORS.brandOrangeDeep,
  },
  verifyBtnFull: {
    width: '100%',
  },
  smallBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  verifyErrorText: {
    marginTop: 6,
    color: COLORS.danger500,
    fontWeight: '800',
  },
  suggestBox: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#fff',
    marginTop: 8,
    maxHeight: 220,
  },
  suggestScroll: {
    maxHeight: 220,
  },
  suggestRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  suggestText: {
    color: '#111',
    fontWeight: '700',
    fontSize: 13,
  },
  imageTileWrap: {
    width: IMAGE_TILE_WIDTH,
    height: IMAGE_TILE_HEIGHT,
    borderRadius: 14,
    overflow: 'hidden',
    marginRight: 12,
    backgroundColor: '#F3F4F6',
  },
  imageTile: {
    width: '100%',
    height: '100%',
  },
  imageTileOverlay: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageTileX: {
    width: 14,
    height: 14,
    tintColor: '#fff',
  },
  coverFrame: {
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
    marginRight: 12,
  },
  imagesRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 6,
    paddingBottom: 6,
  },
  coverPressable: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  addPlus: {
    fontSize: 22,
    fontWeight: '600',
    color: COLORS.neutral600,
    marginTop: 2,
  },
  addPlusIcon: {
    width: 24,
    height: 24,
    tintColor: COLORS.neutral500,
    marginBottom: 2,
  },
  removeXBtn: {
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
  },
  removeXText: {
    fontSize: 20,
    lineHeight: 20,
    fontWeight: '900',
    color: COLORS.neutral925,
    marginTop: -1,
  },
  saveBtn: {
    marginTop: 14,
    height: 48,
    borderRadius: 14,
    backgroundColor: COLORS.brandOrangeDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  saveBtnDisabled: {
    backgroundColor: '#F4C9A6',
    opacity: 1,
  },
  saveSuccessText: {
    marginTop: 8,
    color: COLORS.darkgreen,
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },
  autoApproveRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  autoApproveBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoApproveBoxActive: {
    backgroundColor: COLORS.brandOrangeDeep,
    borderColor: COLORS.brandOrangeDeep,
  },
  autoApproveTick: {
    width: 14,
    height: 14,
    tintColor: '#fff',
  },
  autoApproveTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111',
  },
  autoApproveHint: {
    marginTop: 2,
    fontSize: 12,
    color: COLORS.neutral700,
    fontWeight: '600',
  },
  serviceHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  serviceHeaderDeleteCircle: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  serviceHeaderDeleteCircleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  serviceChevron: {
    width: 18,
    height: 18,
    tintColor: '#555',
  },
  serviceCoverFrame: {
    width: 92,
    height: 92,
    alignSelf: 'flex-start',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderStyle: 'dashed',
    backgroundColor: COLORS.neutral0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginRight: 12,
  },
  serviceCoverImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  zoomModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
  },
  zoomBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  zoomImageWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  zoomImage: {
    width: '100%',
    height: '100%',
  },
  btnDisabled: {
    opacity: 0.55,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  modalCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111',
  },
  modalText: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.neutral700,
  },
  modalRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  modalBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
  },
  modalBtnDanger: {
    backgroundColor: COLORS.danger500,
  },
  modalBtnGhostText: {
    color: '#111',
    fontWeight: '900',
  },
  modalBtnDangerText: {
    color: '#fff',
    fontWeight: '900',
  },
})
