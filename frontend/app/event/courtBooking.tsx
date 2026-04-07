import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, ScrollView, TextInput, Modal, Dimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { Image as ExpoImage } from 'expo-image'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { useTranslation } from '@/constants/translations'
import { CourtBookingRow, createServiceBookings, getVenueBookingData, listCourtAvailabilityCached, listCourtBookingsByCourtId, type PlayingCourtRow, type ServiceBookingCreateRow, type ServiceRow } from '@/lib/backendApi'
import { optimizeRemoteImageUrl } from '@/lib/imageOptimize'
import { useQuery } from '@tanstack/react-query'
import { useAuthContext } from '@/hooks/use-auth-context'
import { useCreateBookingWithPayment, useUserCourtBookings } from '@/hooks/use-court-data'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { appendHistory } from '@/storage/history'
import { SkeletonBox, SkeletonPulse } from '@/components/ui/skeleton'
import { useThemeColors } from '@/hooks/use-theme-colors'


type AvailabilityRow = {
  availabilityid: number
  courtid: number
  playingcourtid?: number | null
  status: string
  start_time: string
  end_time: string
  booking_date: string[]
}

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
const IMAGE_TILE_HEIGHT = 120

// Format helpers
function pad(n: number) { return n < 10 ? `0${n}` : `${n}` }
function toDateString(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
function toUtcDateString(d: Date) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}` }
function isStrictYmd(v: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function toStrictYmd(v: unknown): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  if (isStrictYmd(raw)) return raw

  // Preserve original date token to avoid timezone shifts (for ISO/UTC timestamps).
  const ymdPrefix = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/)
  if (ymdPrefix) {
    return `${ymdPrefix[1]}-${ymdPrefix[2]}-${ymdPrefix[3]}`
  }

  const dateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      return `${y}-${pad(m)}-${pad(d)}`
    }
  }

  const dt = new Date(raw)
  if (Number.isNaN(dt.getTime())) return null
  return toUtcDateString(dt)
}

const DAY_KEYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
function formatHm(v: unknown) {
  const s = String(v ?? '').trim()
  const m = s.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return s
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

function timeMinutesFromTimestamp(raw: unknown): number | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const m = s.match(/(?:T|\s)(\d{2}):(\d{2})/)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return hh * 60 + mm
}

// Format a start/end timestamp into same style used by event list: "Thu, Nov 20, 09:00 - 10:30"
function formatRange(start?: string | null, end?: string | null) {
  if (!start) return 'Unknown date'
  try {
    const s = new Date(start)
    const e = end ? new Date(end) : null
    const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const startTime = s.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const endTime = e ? e.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
    return `${day}, ${startTime}${endTime ? ` - ${endTime}` : ''}`
  } catch {
    return `${start}${end ? ` → ${end}` : ''}`
  }
}

// Helper to normalise venue value to array of strings (matches courtList.tsx)
function asArray(v: any): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

const WEEK_DAYS: { key: string; label: string }[] = [
  { key: 'Mon', label: 'Mon' },
  { key: 'Tue', label: 'Tue' },
  { key: 'Wed', label: 'Wed' },
  { key: 'Thu', label: 'Thu' },
  { key: 'Fri', label: 'Fri' },
  { key: 'Sat', label: 'Sat' },
  { key: 'Sun', label: 'Sun' },
]

export default function CourtBooking() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const { t } = useTranslation()
  const courtid = params.courtid ? parseInt(String(params.courtid), 10) : NaN
  useAuthContext()
  const tc = useThemeColors()

  const { data: bundle, isLoading: bundleLoading, error: bundleError } = useQuery({
    queryKey: ['venueBookingBundle', courtid],
    queryFn: ({ signal }) => getVenueBookingData(courtid, signal),
    enabled: Number.isFinite(courtid),
    staleTime: 2 * 60_000,
    retry: 1,
  })

  const { data: directAvailabilityRowsRaw, isLoading: directAvailabilityLoading, error: directAvailabilityError } = useQuery({
    queryKey: ['courtavailabilityDirect', courtid],
    queryFn: () => listCourtAvailabilityCached(courtid),
    enabled: Number.isFinite(courtid),
    staleTime: 60_000,
    retry: 1,
  })

  const courtInfo = bundle?.courtinfo ?? null
  const bundleAvailabilityRows = Array.isArray(bundle?.availability) ? bundle.availability : []
  const directAvailabilityRows = Array.isArray(directAvailabilityRowsRaw) ? directAvailabilityRowsRaw : []
  const availabilityRows = directAvailabilityRows.length > 0 ? directAvailabilityRows : bundleAvailabilityRows
  const loading = bundleLoading || (directAvailabilityLoading && bundleAvailabilityRows.length === 0)
  const error = ((bundleError as any)?.message ?? null) || ((availabilityRows.length === 0 ? (directAvailabilityError as any)?.message : null) ?? null)

  useEffect(() => {
    if (!bundle) return
    const sampleAvailability = Array.isArray(bundle.availability) ? bundle.availability[0] : null
    console.log('[courtBooking] booking-data payload', {
      courtid,
      hasCourtInfo: !!bundle.courtinfo,
      playingCourts: Array.isArray(bundle.playing_courts) ? bundle.playing_courts.length : 0,
      availabilityCount: Array.isArray(bundle.availability) ? bundle.availability.length : 0,
      servicesCount: Array.isArray(bundle.services) ? bundle.services.length : 0,
      sampleBookingDate: sampleAvailability ? (sampleAvailability as any).booking_date : null,
    })
  }, [bundle, courtid])

  useEffect(() => {
    if (!Number.isFinite(courtid)) return
    const sampleDirectAvailability = directAvailabilityRows[0] ?? null
    console.log('[courtBooking] direct courtavailability payload', {
      courtid,
      count: directAvailabilityRows.length,
      sampleBookingDate: sampleDirectAvailability ? (sampleDirectAvailability as any).booking_date : null,
      sourceSelected: directAvailabilityRows.length > 0 ? 'direct' : 'bundle',
      bundleAvailabilityCount: bundleAvailabilityRows.length,
    })
  }, [courtid, directAvailabilityRows, bundleAvailabilityRows.length])

  // selectedDateStr holds the absolute date string (YYYY-MM-DD) for the selected day
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null)
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [startSlot, setStartSlot] = useState<string | null>(null)
  const [endSlot, setEndSlot] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<CourtBookingRow | null>(null)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [servicesExpanded, setServicesExpanded] = useState(true)
  const [serviceQtyById, setServiceQtyById] = useState<Record<number, number>>({})
  const [serviceTouchedById, setServiceTouchedById] = useState<Record<number, boolean>>({})
  // Playing court selector
  const [selectedPlayingCourtId, setSelectedPlayingCourtId] = useState<number | null>(null)
  const [selectedBaseName, setSelectedBaseName] = useState<string | null>(null)
  // Week navigation (0 = current week, can move forward to +2)
  const [weekOffset, setWeekOffset] = useState(0)
  // Derived duration (minutes) of selected booking window
  const durationMinutes = useMemo(() => {
    if (!startSlot || !endSlot) return 0
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = endSlot.split(':').map(Number)
    return (eh*60+em) - (sh*60+sm)
  }, [startSlot, endSlot])
  const durationInvalid = !!(startSlot && endSlot && durationMinutes < 60)

  // Resolve numeric userid similar to other screens via query
  const { userId } = useAppBootstrap()
  const { data: existingBookings, refetch: refetchUserBookings } = useUserCourtBookings(userId)
  const bookings = Array.isArray(existingBookings) ? existingBookings : []
  const { data: allCourtBookingsRaw, refetch: refetchCourtBookingsByCourtId } = useQuery({
    queryKey: ['courtBookingsByCourtId', courtid],
    queryFn: () => listCourtBookingsByCourtId(courtid),
    enabled: Number.isFinite(courtid),
    staleTime: 30_000,
  })
  const allCourtBookings = Array.isArray(allCourtBookingsRaw) ? allCourtBookingsRaw : []

  // Ensure we see fresh bookings after navigating back from Details/cancel.
  useFocusEffect(
    useCallback(() => {
      if (userId == null) return
      void refetchUserBookings()
      if (Number.isFinite(courtid)) void refetchCourtBookingsByCourtId()
    }, [courtid, refetchCourtBookingsByCourtId, refetchUserBookings, userId])
  )

  // Derive week dates (Mon -> Sun) with offset (future weeks only)
  const weekDaysDetailed = useMemo(() => {
    const today = new Date()
    const dayIdx = today.getDay() // Sun=0
    const offsetToMonday = ((dayIdx + 6) % 7)
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday + weekOffset * 7)
    const dayKeys: Array<[string, string]> = [
      ['Mon', 'MAP_DAY_MON'],
      ['Tue', 'MAP_DAY_TUE'],
      ['Wed', 'MAP_DAY_WED'],
      ['Thu', 'MAP_DAY_THU'],
      ['Fri', 'MAP_DAY_FRI'],
      ['Sat', 'MAP_DAY_SAT'],
      ['Sun', 'MAP_DAY_SUN'],
    ]
    return dayKeys.map(([key, transKey], i) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      return { key, label: t(transKey as any), date: d, dateStr: toDateString(d), isToday: weekOffset === 0 && toDateString(d) === toDateString(today) }
    })
  }, [weekOffset, t])

  const servicesData: ServiceRow[] = Array.isArray(bundle?.services) ? bundle!.services : []
  const servicesLoading = bundleLoading

  // Playing courts for this venue (images embedded by bundle endpoint)
  const playingCourts: PlayingCourtRow[] = Array.isArray(bundle?.playing_courts) ? bundle!.playing_courts : []
  const playingCourtsLoading = bundleLoading

  const baseNames = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const pc of playingCourts) {
      const base = String(pc.base_name || '').trim()
      if (base && !seen.has(base)) { seen.add(base); result.push(base) }
    }
    return result
  }, [playingCourts])

  const baseGroupCourts = useMemo(() => playingCourts.filter((pc) => pc.base_name === selectedBaseName), [playingCourts, selectedBaseName])
  const basePlayingCourtIdSet = useMemo(() => new Set(baseGroupCourts.map((pc) => Number(pc.playingcourtid))), [baseGroupCourts])

  const baseMetaByName = useMemo(() => {
    const map = new Map<string, { surfaceText: string; priceText: string }>()
    for (const base of baseNames) {
      const rows = playingCourts.filter((pc) => pc.base_name === base)
      const full = rows.find((pc) => String((pc as any).part || '').toLowerCase() === 'full') || rows[0]
      const priceValue = Number((full as any)?.price || 0)
      const priceText = Number.isFinite(priceValue)
        ? `${new Intl.NumberFormat('vi-VN').format(Math.max(0, priceValue))}đ`
        : '0đ'
      const surfaceText = String((full as any)?.surface || '').trim()
      map.set(base, { surfaceText, priceText })
    }
    return map
  }, [baseNames, playingCourts])

  const selectedPc = useMemo(() => playingCourts.find((pc) => pc.playingcourtid === selectedPlayingCourtId) || null, [playingCourts, selectedPlayingCourtId])

  const courtAmount = useMemo(() => (selectedPc?.price ? Number(selectedPc.price) : 0), [selectedPc])

  // Full court of selected base (for showing schedule before part selection)
  const fullPcForBase = useMemo(() =>
    playingCourts.find((pc) => pc.base_name === selectedBaseName && String((pc as any).part || '').toLowerCase() === 'full') || null,
  [playingCourts, selectedBaseName])

  // Normalize courtavailability rows.
  // Important: in many setups `courtavailability.playingcourtid` is NULL (court-level schedule).
  // When playingcourtid is missing, we still want to show the schedule + allow booking.
  const normalizedAvailRows: AvailabilityRow[] = useMemo(() => {
    const rows = Array.isArray(availabilityRows) ? availabilityRows : []
    return rows.map((r: any) => {
      let bd: any = r?.booking_date
      if (typeof bd === 'string') {
        try { bd = JSON.parse(bd) } catch { bd = bd }
      }
      if (bd && typeof bd === 'object' && !Array.isArray(bd)) {
        // Handle shapes like { days: [...] } or { Mon: true, Tue: false }
        if (Array.isArray((bd as any).days)) bd = (bd as any).days
        else bd = Object.entries(bd).filter(([, v]) => !!v).map(([k]) => k)
      }

      const normalizedBookingDate = Array.isArray(bd)
        ? bd
          .map((entry) => String(entry ?? '').trim())
          .map((entry) => {
            if (DAY_KEYS.has(entry)) return entry
            return toStrictYmd(entry) ?? entry
          })
          .filter(Boolean)
        : []

      const playingcourtidRaw = (r as any)?.playingcourtid
      const playingcourtid = playingcourtidRaw == null ? null : (Number.isFinite(Number(playingcourtidRaw)) ? Number(playingcourtidRaw) : null)
      return {
        ...r,
        playingcourtid,
        booking_date: normalizedBookingDate,
      } as AvailabilityRow
    })
  }, [availabilityRows])

  const { scheduleAvailability, availability } = useMemo(() => {
    const first = normalizedAvailRows[0] ?? null
    const nullPid = normalizedAvailRows.find((r) => r.playingcourtid == null) ?? null
    const findByPid = (pid: number | null | undefined) => {
      if (pid == null) return null
      return normalizedAvailRows.find((r) => Number(r.playingcourtid) === Number(pid)) ?? null
    }

    let schedule: AvailabilityRow | null = null

    if (playingCourts.length === 0) {
      schedule = first
    } else {
      // Prefer selected base FULL-court; else any availability within base.
      if (selectedBaseName != null) {
        if (fullPcForBase) schedule = findByPid(Number(fullPcForBase.playingcourtid))
        if (!schedule && basePlayingCourtIdSet.size > 0) {
          schedule = normalizedAvailRows.find((r) => r.playingcourtid != null && basePlayingCourtIdSet.has(Number(r.playingcourtid))) ?? null
        }
      }
      // Fallback: if availability rows are court-level (playingcourtid NULL), use that.
      if (!schedule) schedule = nullPid ?? first
    }

    let booking: AvailabilityRow | null = null
    if (selectedPlayingCourtId != null) booking = findByPid(selectedPlayingCourtId)
    if (!booking) booking = schedule ?? nullPid ?? first

    return { scheduleAvailability: schedule, availability: booking }
  }, [
    normalizedAvailRows,
    playingCourts.length,
    selectedBaseName,
    selectedPlayingCourtId,
    fullPcForBase,
    basePlayingCourtIdSet,
  ])

  // Only block duplicates for the same availability when the existing booking is still active.

  const scheduleDisplayAvailability = useMemo(
    () => scheduleAvailability ?? availability ?? normalizedAvailRows[0] ?? null,
    [scheduleAvailability, availability, normalizedAvailRows]
  )

  const availableDayKeys = scheduleDisplayAvailability?.booking_date || []
  const availableDateSet = useMemo(() => {
    const set = new Set<string>()
    for (const token of availableDayKeys) {
      const date = toStrictYmd(token)
      if (date) set.add(date)
    }
    return set
  }, [availableDayKeys])

  const availableWeekdaySet = useMemo(() => {
    const set = new Set<string>()
    for (const token of availableDayKeys) {
      const key = String(token).trim()
      if (DAY_KEYS.has(key)) set.add(key)
    }
    return set
  }, [availableDayKeys])

  // Slots: generate 30-min increments between start_time & end_time
  const timeSlots = useMemo(() => {
    if (!scheduleDisplayAvailability) return []
    const start = scheduleDisplayAvailability.start_time // '08:00'
    const end = scheduleDisplayAvailability.end_time
    const [sh, sm] = String(start).split(':').map(Number)
    const [eh, em] = String(end).split(':').map(Number)
    const startMinutes = sh * 60 + sm
    const endMinutes = eh * 60 + em
    const slots: string[] = []
    for (let m = startMinutes; m + 30 <= endMinutes; m += 30) {
      const hh = pad(Math.floor(m / 60)); const mm = pad(m % 60)
      slots.push(`${hh}:${mm}`)
    }
    return slots
  }, [scheduleDisplayAvailability])

  // For today's date, never show past start slots.
  const visibleTimeSlots = useMemo(() => {
    if (!selectedDateStr) return timeSlots
    const todayStr = toDateString(new Date())
    if (selectedDateStr !== todayStr) return timeSlots

    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    return timeSlots.filter((slot) => {
      const [hh, mm] = slot.split(':').map(Number)
      const slotMinutes = hh * 60 + mm
      return slotMinutes > nowMinutes
    })
  }, [selectedDateStr, timeSlots])

  // For start time, only expose slots where at least 1 hour of booking time remains before closing.
  const startVisibleSlots = useMemo(() => {
    if (!scheduleDisplayAvailability) return visibleTimeSlots
    const [eh, em] = String(scheduleDisplayAvailability.end_time).split(':').map(Number)
    const courtEndMinutes = eh * 60 + em
    return visibleTimeSlots.filter((slot) => {
      const [hh, mm] = slot.split(':').map(Number)
      return (hh * 60 + mm) + 60 <= courtEndMinutes
    })
  }, [visibleTimeSlots, scheduleDisplayAvailability])

  // If a previously selected slot becomes invalid as time moves on, clear it.
  useEffect(() => {
    if (!startSlot) return
    if (!startVisibleSlots.includes(startSlot)) {
      setStartSlot(null)
      setEndSlot(null)
      return
    }
    if (endSlot && !visibleTimeSlots.includes(endSlot)) {
      setEndSlot(null)
    }
  }, [startVisibleSlots, visibleTimeSlots, startSlot, endSlot])

  const isStartInPast = useMemo(() => {
    if (!selectedDateStr || !startSlot) return false
    const dt = new Date(`${selectedDateStr}T${startSlot}:00`)
    if (Number.isNaN(dt.getTime())) return false
    return dt.getTime() <= Date.now()
  }, [selectedDateStr, startSlot])

  // Derived validity and button enable state
  const isDaySelectable = useCallback(
    (dayKey: string, dateStr: string) => {
      if (availableDateSet.size > 0) return availableDateSet.has(dateStr)
      if (availableWeekdaySet.size > 0) return availableWeekdaySet.has(dayKey)
      return true
    },
    [availableDateSet, availableWeekdaySet]
  )

  // Reset schedule and part selection when base court changes
  useEffect(() => {
    setSelectedPlayingCourtId(null)
    setSelectedDateStr(null)
    setShowTimePicker(false)
    setStartSlot(null)
    setEndSlot(null)
  }, [selectedBaseName]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select first base to avoid empty schedule state when courts are present.
  useEffect(() => {
    if (selectedBaseName != null) return
    if (!baseNames.length) return
    setSelectedBaseName(baseNames[0])
  }, [baseNames, selectedBaseName])

  // Reset schedule when playing court part changes
  // Keep selected day/time when choosing full/half to avoid forcing users to restart.

  const servicesTotal = useMemo(() => {
    const rows: ServiceRow[] = Array.isArray(servicesData) ? servicesData : []
    let sum = 0
    for (const s of rows) {
      const qty = serviceQtyById[s.serviceid] || 0
      if (qty > 0) sum += qty * (Number(s.price) || 0)
    }
    return sum
  }, [servicesData, serviceQtyById])

  const totalAmount = useMemo(() => {
    return Math.max(0, Number(courtAmount) || 0) + Math.max(0, Number(servicesTotal) || 0)
  }, [courtAmount, servicesTotal])
  const formattedAmount = totalAmount > 0
    ? `${t('BOOKING_COURT_CONFIRM_BTN')} — ${Math.round(totalAmount).toLocaleString('en-US')}đ`
    : t('BOOKING_COURT_CONFIRM_BTN')
  const selectedPart = useMemo(() => {
    const p = String((selectedPc as any)?.part || '').toLowerCase()
    if (p === 'full' || p === 'half_a' || p === 'half_b') return p as 'full' | 'half_a' | 'half_b'
    return null
  }, [selectedPc])

  const fullHalfOverlapError = useMemo(() => {
    if (!selectedDateStr || !startSlot || !endSlot) return null
    if (!selectedPart) return null

    const activeBaseName = String(selectedPc?.base_name ?? selectedBaseName ?? '').trim().toLowerCase()
    if (!activeBaseName) return null

    const baseNameByPlayingCourtId = new Map<number, string>()
    for (const pc of playingCourts) {
      const pid = Number((pc as any)?.playingcourtid)
      const bn = String((pc as any)?.base_name ?? '').trim().toLowerCase()
      if (!Number.isFinite(pid) || !bn) continue
      baseNameByPlayingCourtId.set(pid, bn)
    }

    const [startH, startM] = startSlot.split(':').map(Number)
    const [endH, endM] = endSlot.split(':').map(Number)
    const reqStart = startH * 60 + startM
    const reqEnd = endH * 60 + endM
    if (!Number.isFinite(reqStart) || !Number.isFinite(reqEnd) || reqEnd <= reqStart) return null

    const rows = Array.isArray(allCourtBookings) ? allCourtBookings : []
    for (const b of rows) {
      const approval = String((b as any)?.status ?? '').toLowerCase()
      const bookingStatus = String((b as any)?.bookingstatus ?? '').toLowerCase()
      if (approval.includes('reject') || bookingStatus.includes('cancel') || bookingStatus.includes('complete') || bookingStatus.includes('missed')) continue

      const bookingDate = String((b as any)?.bookingdate ?? '').slice(0, 10)
      if (bookingDate !== selectedDateStr) continue

      const existingPid = Number((b as any)?.playingcourtid)
      const derivedBase = Number.isFinite(existingPid) ? (baseNameByPlayingCourtId.get(existingPid) ?? '') : ''
      const existingBase = String((b as any)?.selected_base_name ?? derivedBase).trim().toLowerCase()
      if (!existingBase || existingBase !== activeBaseName) continue

      const existingStart = timeMinutesFromTimestamp((b as any)?.start_timestamp)
      const existingEnd = timeMinutesFromTimestamp((b as any)?.end_timestamp)
      if (existingStart == null || existingEnd == null || existingEnd <= existingStart) continue
      const overlaps = reqStart < existingEnd && existingStart < reqEnd
      if (!overlaps) continue

      const existingPart = String((b as any)?.selected_part ?? '').toLowerCase()
      const existingIsHalf = existingPart === 'half_a' || existingPart === 'half_b'
      if (selectedPart === 'full' && (existingPart === 'full' || existingIsHalf)) {
        return 'This time slot overlaps with an existing booking for this court area.'
      }
      if ((selectedPart === 'half_a' || selectedPart === 'half_b') && existingPart === 'full') {
        return 'A full-court booking already exists for this time slot.'
      }
    }

    return null
  }, [selectedDateStr, startSlot, endSlot, selectedPart, allCourtBookings, selectedPc?.base_name, selectedBaseName, playingCourts])

  // Require part selection when playing courts exist.
  const canConfirm = !!(selectedDateStr && startSlot && endSlot && paymentMethod && userId && availability && !durationInvalid && !isStartInPast && !fullHalfOverlapError && (playingCourts.length === 0 || selectedPlayingCourtId != null))
  const courtBookingStatus = Boolean((courtInfo as any)?.auto_approve) ? 'approved' : 'pending'

  // Blocked time slots: intervals from active bookings on selected date & base
  const bookedIntervalsForDate = useMemo(() => {
    if (!selectedDateStr || !selectedBaseName) return [] as Array<[number, number]>
    const baseNameByPid = new Map<number, string>()
    for (const pc of playingCourts) {
      const pid = Number((pc as any).playingcourtid)
      const bn = String((pc as any).base_name ?? '').trim().toLowerCase()
      if (Number.isFinite(pid) && bn) baseNameByPid.set(pid, bn)
    }
    const activeBaseLower = selectedBaseName.trim().toLowerCase()
    const result: Array<[number, number]> = []
    for (const b of allCourtBookings) {
      const approval = String((b as any)?.status ?? '').toLowerCase()
      const bStatus = String((b as any)?.bookingstatus ?? '').toLowerCase()
      if (approval.includes('reject') || bStatus.includes('cancel') || bStatus.includes('complete') || bStatus.includes('missed')) continue
      const bDate = String((b as any)?.bookingdate ?? '').slice(0, 10)
      if (bDate !== selectedDateStr) continue
      const bPid = Number((b as any)?.playingcourtid)
      const derivedBase = Number.isFinite(bPid) ? (baseNameByPid.get(bPid) ?? '') : ''
      const bookingBase = String((b as any)?.selected_base_name ?? derivedBase).trim().toLowerCase()
      if (!bookingBase || bookingBase !== activeBaseLower) continue
      const bStart = timeMinutesFromTimestamp((b as any)?.start_timestamp)
      const bEnd = timeMinutesFromTimestamp((b as any)?.end_timestamp)
      if (bStart == null || bEnd == null || bEnd <= bStart) continue
      // Only full-court (or legacy unknown-part) bookings block time slots.
      // Half-court bookings only disable specific court cards (handled in Step 3).
      const bPart = String((b as any)?.selected_part ?? '').toLowerCase()
      if (bPart === 'half_a' || bPart === 'half_b') continue
      result.push([bStart, bEnd])
    }
    return result
  }, [selectedDateStr, selectedBaseName, allCourtBookings, playingCourts])

  // Which parts have conflicting bookings for the currently selected time window.
  // Used to disable specific court cards in Step 3 selection.
  const conflictingPartSet = useMemo(() => {
    if (!selectedDateStr || !startSlot || !endSlot) return new Set<string>()
    const activeBaseLower = String(selectedBaseName ?? '').trim().toLowerCase()
    if (!activeBaseLower) return new Set<string>()
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = endSlot.split(':').map(Number)
    const reqStart = sh * 60 + sm
    const reqEnd = eh * 60 + em
    const baseNameByPid = new Map<number, string>()
    for (const pc of playingCourts) {
      const pid = Number((pc as any).playingcourtid)
      const bn = String((pc as any).base_name ?? '').trim().toLowerCase()
      if (Number.isFinite(pid) && bn) baseNameByPid.set(pid, bn)
    }
    const conflicting = new Set<string>()
    for (const b of allCourtBookings) {
      const approval = String((b as any)?.status ?? '').toLowerCase()
      const bStatus = String((b as any)?.bookingstatus ?? '').toLowerCase()
      if (approval.includes('reject') || bStatus.includes('cancel') || bStatus.includes('complete') || bStatus.includes('missed')) continue
      const bDate = String((b as any)?.bookingdate ?? '').slice(0, 10)
      if (bDate !== selectedDateStr) continue
      const bPid = Number((b as any)?.playingcourtid)
      const derivedBase = Number.isFinite(bPid) ? (baseNameByPid.get(bPid) ?? '') : ''
      const bookingBase = String((b as any)?.selected_base_name ?? derivedBase).trim().toLowerCase()
      if (!bookingBase || bookingBase !== activeBaseLower) continue
      const bStart = timeMinutesFromTimestamp((b as any)?.start_timestamp)
      const bEnd = timeMinutesFromTimestamp((b as any)?.end_timestamp)
      if (bStart == null || bEnd == null || bEnd <= bStart) continue
      if (reqStart < bEnd && bStart < reqEnd) {
        const part = String((b as any)?.selected_part ?? '').toLowerCase()
        conflicting.add(part || 'full')
      }
    }
    return conflicting
  }, [selectedDateStr, startSlot, endSlot, selectedBaseName, allCourtBookings, playingCourts])

  // A start slot is blocked if it falls within any existing booking interval
  const blockedStartSlotSet = useMemo(() => {
    const blocked = new Set<string>()
    for (const slot of timeSlots) {
      const [hh, mm] = slot.split(':').map(Number)
      const slotMin = hh * 60 + mm
      for (const [bStart, bEnd] of bookedIntervalsForDate) {
        if (slotMin >= bStart && slotMin < bEnd) { blocked.add(slot); break }
      }
    }
    return blocked
  }, [timeSlots, bookedIntervalsForDate])

  const isStartSlotBlocked = useCallback((slot: string) => {
    return blockedStartSlotSet.has(slot)
  }, [blockedStartSlotSet])

  // Given a picked startSlot, the maximum permitted end = earliest booking start after startSlot
  const maxEndMinutes = useMemo(() => {
    if (!startSlot) return Infinity
    const [sh, sm] = startSlot.split(':').map(Number)
    const startM = sh * 60 + sm
    let cutoff = Infinity
    for (const [bStart] of bookedIntervalsForDate) {
      if (bStart > startM && bStart < cutoff) cutoff = bStart
    }
    return cutoff
  }, [startSlot, bookedIntervalsForDate])

  const isEndSlotBlocked = useCallback((slot: string) => {
    if (!startSlot) return true
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = slot.split(':').map(Number)
    const startM = sh * 60 + sm
    const endM = eh * 60 + em
    if (!Number.isFinite(startM) || !Number.isFinite(endM) || endM <= startM) return true
    if (endM > maxEndMinutes) return true
    for (const [bookedStart, bookedEnd] of bookedIntervalsForDate) {
      if (startM < bookedEnd && bookedStart < endM) return true
    }
    return false
  }, [startSlot, maxEndMinutes, bookedIntervalsForDate])

  useEffect(() => {
    if (startSlot && isStartSlotBlocked(startSlot)) {
      setStartSlot(null)
      setEndSlot(null)
      return
    }
    if (endSlot && isEndSlotBlocked(endSlot)) {
      setEndSlot(null)
    }
  }, [startSlot, endSlot, isStartSlotBlocked, isEndSlotBlocked])

  const onSelectDay = (dateStr: string, dayKey: string) => {
    if (!isDaySelectable(dayKey, dateStr)) return
    if (selectedDateStr === dateStr) {
      setSelectedDateStr(null)
      setShowTimePicker(false)
      setStartSlot(null); setEndSlot(null)
      return
    }
    setSelectedDateStr(dateStr)
    setShowTimePicker(true)
    setStartSlot(null); setEndSlot(null)
  }
  const onSelectStart = (slot: string) => {
    if (startSlot === slot) { setStartSlot(null); setEndSlot(null); return }
    setStartSlot(slot)
    setEndSlot(null)
  }
  const onSelectEnd = (slot: string) => {
    if (!startSlot) return
    if (endSlot === slot) { setEndSlot(null); return }
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = slot.split(':').map(Number)
    const startM = sh*60+sm
    const endM = eh*60+em
    if (endM <= startM) return
    setEndSlot(slot)
  }

  const bookingMutation = useCreateBookingWithPayment()
  const confirmBooking = async () => {
    if (!canConfirm || !availability || !userId || !startSlot || !endSlot || !paymentMethod) return
    if (fullHalfOverlapError) { setSubmitError(fullHalfOverlapError); return }
    setSubmitError(null); setConfirmation(null)
    setSubmitting(true)
    const bookingDateStr = selectedDateStr
    if (!bookingDateStr) { setSubmitError('Selected date missing'); setSubmitting(false); return }
    const startTs = `${bookingDateStr} ${startSlot}:00`
    const endTs = `${bookingDateStr} ${endSlot}:00`
    bookingMutation.mutate({
      availabilityid: availability.availabilityid,
      userid: userId,
      status: courtBookingStatus,
      paymentMethod: paymentMethod,
      start_timestamp: startTs,
      end_timestamp: endTs,
      bookingdate: bookingDateStr,
      amount: totalAmount || 0,
      note: noteText.trim() ? noteText.trim() : null,
      playingcourtid: selectedPc?.playingcourtid ?? availability.playingcourtid ?? null,
      selected_court_name: selectedPc?.name ?? null,
      selected_base_name: selectedPc?.base_name ?? selectedBaseName ?? null,
      selected_part: selectedPart,
      selected_surface: selectedPc?.surface ?? null,
      court_price_at_booking: Number.isFinite(Number(courtAmount)) ? Number(courtAmount) : null,
      duration_minutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : null,
      total_amount: Number.isFinite(Number(totalAmount)) ? Number(totalAmount) : null,
    }, {
      onSuccess: async (data) => {
        // Persist selected service line items (servicebooking table) if any were chosen.
        try {
          const courtbookingid = Number((data as any)?.booking?.courtbookingid)
          const paymentidRaw = (data as any)?.payment?.paymentid ?? (data as any)?.booking?.paymentid
          const paymentid = Number(paymentidRaw)
          const paymentidSafe = Number.isFinite(paymentid) && paymentid > 0 ? paymentid : null
          if (Number.isFinite(courtbookingid) && courtbookingid > 0) {
            const rows: ServiceRow[] = Array.isArray(servicesData) ? servicesData : []
            const items: ServiceBookingCreateRow[] = rows
              .map((s) => ({
                courtbookingid,
                serviceid: Number(s.serviceid),
                quantity: Number(serviceQtyById[s.serviceid] || 0),
                unit_price: Number(s.price),
                paymentid: paymentidSafe,
              }))
              .filter((r) =>
                Number.isFinite(r.serviceid) && r.serviceid > 0 &&
                Number.isFinite(r.quantity) && r.quantity > 0 &&
                Number.isFinite(r.unit_price) && r.unit_price >= 0
              )

            if (items.length > 0) {
              console.log('[courtBooking] creating servicebookings', { count: items.length, sample: items[0] })
              await createServiceBookings(items)
            }
          }
        } catch (e) {
          // Best-effort only; booking + payment should still succeed even if servicebooking insert fails.
          console.warn('[courtBooking] createServiceBookings failed', e)
        }

        if (typeof userId === 'number') {
          const courtTitle = courtInfo?.name || 'Court Booking'
          void appendHistory(userId, {
            kind: 'payment',
            title: `Payment for ${courtTitle}`,
            subtitle: `Method: ${paymentMethod}`,
            fromStatus: 'unpaid',
            toStatus: String(data.payment?.status ?? 'pending'),
            amount: typeof totalAmount === 'number' ? totalAmount : (totalAmount == null ? null : Number(totalAmount)),
            meta: {
              paymentid: data.payment?.paymentid,
              type: 'court',
              availabilityid: availability.availabilityid,
              courtbookingid: data.booking?.courtbookingid,
              start_timestamp: startTs,
              end_timestamp: endTs,
            },
          })

          void appendHistory(userId, {
            kind: 'court_booking',
            title: `Booked venue: ${courtTitle}`,
            subtitle: null,
            fromStatus: null,
            toStatus: 'pending',
            meta: {
              courtbookingid: data.booking?.courtbookingid,
              availabilityid: availability.availabilityid,
              start_timestamp: startTs,
              end_timestamp: endTs,
              venue_name: courtInfo?.name ?? null,
            },
          })
        }

        // Redirect to Invoice (Invoice header plays the success animation)
        router.replace({
          pathname: '/event/invoice',
          params: {
            title: courtInfo?.name || 'Court Booking',
            subtitle: '',
            date: selectedDateStr,
            time: `${startSlot} - ${endSlot}`,
            location: courtInfo?.address,
            price: totalAmount,
            paymentMethod: paymentMethod,
            paymentStatus: data.payment?.status,
            bookingId: data.booking?.courtbookingid,
            note: noteText.trim(),
            type: 'court',
          },
        })
      },
      onError: (err: any) => {
        setSubmitError(err?.message || 'Booking failed')
      },
      onSettled: () => setSubmitting(false)
    })
  }

  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

  const onPressConfirm = () => {
    if (!canConfirm || submitting) return
    setConfirmModalVisible(true)
  }

  // Force refetch when screen gains focus to reflect external deletions (manual DB changes)
  // Use simple interval-less refetch on mount + when userId changes (manual DB deletes reflected)
  // Refetch bookings whenever screen gains focus (captures manual DB deletions/insertions)
  useFocusEffect(useCallback(() => {
    if (userId != null) refetchUserBookings()
  }, [userId, refetchUserBookings]))



  return (
    <View style={[styles.screen, { backgroundColor: tc.bgBase }]}>
    <ScrollView style={[styles.container, { backgroundColor: tc.bgBase }]} contentContainerStyle={{ paddingBottom: 220 }}>
      {/* Header / Back inside SafeArea */}
      <SafeAreaView edges={['top']} style={[styles.headerSafeArea, { backgroundColor: tc.bgBase }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={[styles.backBtn, { backgroundColor: tc.bgElevated }]} onPress={() => router.back()}>
            <Image source={ICONS.arrowLeft} style={[styles.backIcon, { tintColor: tc.textPrimary }]} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { flex: 1, textAlign: 'center', color: tc.textPrimary }]}>{t('BOOKING_COURT_HEADER')}</Text>
          <View style={styles.backBtn} />
        </View>
      </SafeAreaView>

      {/* Section 1: Court details (title removed) */}
      <View style={[styles.sectionCard, { backgroundColor: tc.bgSurface }]}>
        {loading && (
          <SkeletonPulse>
            <SkeletonBox width={'55%'} height={22} radius={8} style={{ marginBottom: 12 }} />
            <SkeletonBox width={'100%'} height={14} radius={7} style={{ marginBottom: 8 }} />
            <SkeletonBox width={'70%'} height={14} radius={7} />
          </SkeletonPulse>
        )}
        {error && <Text style={styles.errorText}>{error}</Text>}
        {!loading && !error && (
          <View>
            <View style={styles.courtHeaderRow}>
              {(() => {
                const venueRaw = courtInfo?.venue
                const venueTokens = asArray(venueRaw).map(v => v.toLowerCase())
                const hasIndoor = venueTokens.some(t => t.includes('indoor'))
                const hasOutdoor = venueTokens.some(t => t.includes('outdoor'))
                let iconSrc = null
                if (hasIndoor && hasOutdoor) iconSrc = ICONS.bothVenue
                else if (hasIndoor) iconSrc = ICONS.indoorIcon
                else if (hasOutdoor) iconSrc = ICONS.outdoorIcon
                return iconSrc ? <Image source={iconSrc} style={styles.venueIcon} /> : null
              })()}
              <Text style={[styles.courtName, { color: tc.textPrimary }]}>{courtInfo?.name || `Court ${courtid}`}</Text>
            </View>
            {(() => {
              return null
            })()}
            <View style={styles.metaRow}>
              <Image source={ICONS.mapPin} style={[styles.metaIcon, { tintColor: tc.textSecondary }]} />
              <Text style={[styles.courtAddress, { color: tc.textSecondary }]}>{courtInfo?.address || ''}</Text>
            </View>
            {availability && (
              <View style={styles.metaRow}>
                <Image source={ICONS.clock} style={[styles.metaIcon, { tintColor: tc.textSecondary }]} />
                <Text style={[styles.availabilityMeta, { color: tc.textMuted }]}>{t('MAP_OPENING_TIME')} {formatHm(scheduleAvailability?.start_time ?? availability.start_time)} - {formatHm(scheduleAvailability?.end_time ?? availability.end_time)}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Court selector: Step 1 pills → Step 2 schedule → Step 3 image cards */}
      {(playingCourtsLoading || playingCourts.length > 0) && (
        <View style={[styles.sectionCard, { backgroundColor: tc.bgSurface }]}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SECTION_COURT')}</Text>
          {playingCourtsLoading ? (
            <SkeletonPulse>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <SkeletonBox width={96} height={34} radius={18} />
                <SkeletonBox width={110} height={34} radius={18} />
                <SkeletonBox width={88} height={34} radius={18} />
              </View>
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}>
                <SkeletonBox width={150} height={170} radius={14} />
                <SkeletonBox width={150} height={170} radius={14} />
              </View>
            </SkeletonPulse>
          ) : (
            <>
              {/* Step 1: Base court pills */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {baseNames.map((bn) => {
                  const active = selectedBaseName === bn
                  const meta = baseMetaByName.get(bn)
                  return (
                    <TouchableOpacity
                      key={bn}
                      onPress={() => setSelectedBaseName(bn)}
                      style={{ minWidth: 116, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: active ? tc.brand : tc.border, backgroundColor: active ? tc.brand : tc.cardBg }}
                      activeOpacity={0.8}
                    >
                      <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : tc.textPrimary }}>{bn}</Text>
                      {!!meta?.surfaceText && (
                        <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontWeight: '700', color: active ? '#ffe7d1' : tc.textMuted, textTransform: 'capitalize' }}>{(() => { const s = meta.surfaceText.toLowerCase(); if (s === 'concrete') return t('COURT_SURFACE_CONCRETE'); if (s === 'hardwood') return t('COURT_SURFACE_HARDWOOD'); if (s === 'synthetic') return t('COURT_SURFACE_SYNTHETIC'); if (s === 'grass') return t('COURT_SURFACE_GRASS'); return meta.surfaceText; })()}</Text>
                      )}
                      <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, fontWeight: '700', color: active ? '#fff' : tc.textPrimary }}>{meta?.priceText || '0đ'}</Text>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>

              {/* Step 2: Schedule (shown when base court selected) */}
              {selectedBaseName != null && (
                <>
                  <View style={[styles.scheduleHeaderRow, { marginTop: 16 }]}>
                    <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SECTION_SCHEDULE')}</Text>
                    <View style={styles.weekNavInline}>
                      <TouchableOpacity disabled={weekOffset === 0} onPress={() => { if (weekOffset > 0) setWeekOffset((w) => w - 1) }} style={[styles.navBtn, weekOffset === 0 && styles.navBtnDisabled, { backgroundColor: tc.bgElevated }]}>
                        <Image source={ICONS.arrowright} style={[styles.navIcon, { transform: [{ rotate: '180deg' }], tintColor: tc.textPrimary }]} />
                      </TouchableOpacity>
                      <TouchableOpacity disabled={weekOffset === 2} onPress={() => { if (weekOffset < 2) setWeekOffset((w) => w + 1) }} style={[styles.navBtn, weekOffset === 2 && styles.navBtnDisabled, { backgroundColor: tc.bgElevated }]}>
                        <Image source={ICONS.arrowright} style={[styles.navIcon, { tintColor: tc.textPrimary }]} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  {scheduleDisplayAvailability && (
                    <Text style={[styles.availabilityMeta, { color: tc.textMuted }]}>
                      {t('MAP_OPENING_TIME')} {formatHm(scheduleDisplayAvailability.start_time)} - {formatHm(scheduleDisplayAvailability.end_time)}
                    </Text>
                  )}
                  <View style={styles.weekRow}>
                    {weekDaysDetailed.map((d) => {
                      const today = new Date()
                      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate())
                      const isPast = weekOffset === 0 && d.date < todayOnly
                      const isAvailable = isDaySelectable(d.key, d.dateStr)
                      const selected = selectedDateStr === d.dateStr
                      return (
                        <TouchableOpacity
                          key={d.key}
                          onPress={() => { if (!isAvailable || isPast) return; onSelectDay(d.dateStr, d.key) }}
                          style={[styles.dayCell, selected && styles.dayCellSelected, isAvailable && !selected && !isPast && styles.dayCellAvailable, (!isAvailable || isPast) && styles.dayCellDisabled, { backgroundColor: selected ? tc.brand : tc.bgElevated }]}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.dayLabel, d.isToday && styles.todayUnderline, { color: tc.textPrimary }]}>{d.label}</Text>
                          <Text style={[styles.dayDate, selected && styles.dayCellSelectedText, { color: selected ? '#fff' : tc.textPrimary }]}>{d.date.getDate()}</Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                  {!loading && !error && !scheduleDisplayAvailability && (
                    <Text style={[styles.statusText, { color: tc.textMuted }]}>{t('BOOKING_COURT_NO_SCHEDULE')}</Text>
                  )}
                  {showTimePicker && scheduleDisplayAvailability && (
                    <View style={{ marginTop: 16 }}>
                      <Text style={[styles.subHeading, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SELECT_TIME')}</Text>
                      <Text style={[styles.smallText, { color: tc.textSecondary }]}>{t('BOOKING_COURT_LABEL_START')}</Text>
                      <View style={styles.slotRow}>
                        {startVisibleSlots.map((ts) => {
                          const disabled = isStartSlotBlocked(ts)
                          return (
                            <TouchableOpacity key={ts} disabled={disabled} onPress={() => onSelectStart(ts)} style={[styles.slotBtn, startSlot === ts && styles.slotBtnActive, disabled && styles.slotBtnDisabled, startSlot === ts && { backgroundColor: tc.brand }]}>
                              <Text style={[styles.slotText, disabled && styles.slotTextDisabled]}>{ts}</Text>
                            </TouchableOpacity>
                          )
                        })}
                      </View>
                      {startVisibleSlots.length === 0 && (
                        <Text style={styles.durationWarning}>{t('BOOKING_COURT_NO_FUTURE_SLOTS')}</Text>
                      )}
                      {startSlot && (
                        <>
                          <Text style={[styles.smallText, { marginTop: 12, color: tc.textSecondary }]}>{t('BOOKING_COURT_LABEL_END')}</Text>
                          <View style={styles.slotRow}>
                            {visibleTimeSlots.filter((ts) => ts > startSlot!).map((ts) => {
                              const disabled = isEndSlotBlocked(ts)
                              return (
                                <TouchableOpacity key={ts} disabled={disabled} onPress={() => onSelectEnd(ts)} style={[styles.slotBtn, endSlot === ts && styles.slotBtnActive, disabled && styles.slotBtnDisabled, endSlot === ts && { backgroundColor: tc.brand }]}>
                                  <Text style={[styles.slotText, disabled && styles.slotTextDisabled]}>{ts}</Text>
                                </TouchableOpacity>
                              )
                            })}
                          </View>
                          {endSlot && durationInvalid && <Text style={styles.durationWarning}>{t('BOOKING_COURT_ERR_MIN_DURATION')}</Text>}
                          {isStartInPast && <Text style={styles.durationWarning}>{t('BOOKING_COURT_ERR_START_PASSED')}</Text>}
                        </>
                      )}
                    </View>
                  )}
                </>
              )}

              {/* Step 3: Part image cards (shown after time span selected) */}
              {selectedDateStr && startSlot && endSlot && !durationInvalid && (
                <View style={{ marginTop: 16 }}>
                  <Text style={[styles.subHeading, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SELECT_COURT')}</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 8 }}>
                    {baseGroupCourts.map((pc) => {
                      const courtLabel = String(pc.name || pc.base_name || `Court ${pc.playingcourtid}`)
                      const active = selectedPlayingCourtId === pc.playingcourtid
                      const pcPart = String((pc as any).part || '').toLowerCase()
                      const isCourtDisabled = (() => {
                        if (!conflictingPartSet.size) return false
                        if (pcPart === 'half_a' || pcPart === 'half_b') {
                          return conflictingPartSet.has(pcPart) || conflictingPartSet.has('full')
                        }
                        // Full court is blocked if any booking overlaps (any part taken)
                        return conflictingPartSet.size > 0
                      })()
                      const imgs: string[] = (pc as any).images || []
                      const rawImg = imgs[0]
                      const imageUri = typeof rawImg === 'string' && rawImg.trim()
                        ? optimizeRemoteImageUrl(rawImg, { width: 800, height: 400, quality: 80, resize: 'cover' })
                        : null
                      const priceValue = Number(pc.price || 0)
                      const priceText = Number.isFinite(priceValue)
                        ? `${new Intl.NumberFormat('vi-VN').format(Math.max(0, priceValue))}đ`
                        : '0đ'
                      return (
                        <TouchableOpacity
                          key={pc.playingcourtid}
                          disabled={isCourtDisabled}
                          onPress={() => setSelectedPlayingCourtId(pc.playingcourtid)}
                          style={[styles.selectCourtCard, active && styles.selectCourtCardActive, isCourtDisabled && styles.selectCourtCardDisabled, { backgroundColor: tc.cardBg, borderColor: active ? tc.brand : tc.border }]}
                          activeOpacity={0.8}
                        >
                          <View style={styles.selectCourtImageWrap}>
                            {imageUri ? (
                              <ExpoImage source={{ uri: imageUri }} style={styles.selectCourtImage} contentFit="cover" />
                            ) : (
                              <View style={[styles.selectCourtImagePlaceholder, { backgroundColor: tc.bgElevated }]}>
                                <Text style={{ color: tc.textMuted, fontSize: 12 }}>{t('BOOKING_COURT_NO_IMAGE')}</Text>
                              </View>
                            )}
                          </View>
                          <View style={styles.selectCourtInfoRow}>
                            <Text numberOfLines={1} style={[styles.selectCourtName, { color: active ? tc.brand : tc.textPrimary }]}>{courtLabel}</Text>
                            <Text numberOfLines={1} style={[styles.selectCourtPriceInline, { color: active ? tc.brand : tc.textPrimary }]}>{priceText}</Text>
                          </View>
                        </TouchableOpacity>
                      )
                    })}
                  </ScrollView>
                </View>
              )}
            </>
          )}
        </View>
      )}

      {/* Schedule for courts without playing court sub-division */}
      {playingCourts.length === 0 && (
        <View style={[styles.sectionCard, { backgroundColor: tc.bgSurface }]}>
          <View style={styles.scheduleHeaderRow}>
            <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SECTION_SCHEDULE')}</Text>
            <View style={styles.weekNavInline}>
              <TouchableOpacity disabled={weekOffset === 0} onPress={() => { if (weekOffset > 0) setWeekOffset((w) => w - 1) }} style={[styles.navBtn, weekOffset === 0 && styles.navBtnDisabled, { backgroundColor: tc.bgElevated }]}>
                <Image source={ICONS.arrowright} style={[styles.navIcon, { transform: [{ rotate: '180deg' }], tintColor: tc.textPrimary }]} />
              </TouchableOpacity>
              <TouchableOpacity disabled={weekOffset === 2} onPress={() => { if (weekOffset < 2) setWeekOffset((w) => w + 1) }} style={[styles.navBtn, weekOffset === 2 && styles.navBtnDisabled, { backgroundColor: tc.bgElevated }]}>
                <Image source={ICONS.arrowright} style={[styles.navIcon, { tintColor: tc.textPrimary }]} />
              </TouchableOpacity>
            </View>
          </View>
          {scheduleDisplayAvailability && (
            <Text style={[styles.availabilityMeta, { color: tc.textMuted }]}>
              {t('MAP_OPENING_TIME')} {formatHm(scheduleDisplayAvailability.start_time)} - {formatHm(scheduleDisplayAvailability.end_time)}
            </Text>
          )}
          <View style={styles.weekRow}>
            {weekDaysDetailed.map((d) => {
              const today = new Date()
              const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate())
              const isPast = weekOffset === 0 && d.date < todayOnly
              const isAvailable = isDaySelectable(d.key, d.dateStr)
              const selected = selectedDateStr === d.dateStr
              return (
                <TouchableOpacity key={d.key} onPress={() => { if (!isAvailable || isPast) return; onSelectDay(d.dateStr, d.key) }} style={[styles.dayCell, selected && styles.dayCellSelected, isAvailable && !selected && !isPast && styles.dayCellAvailable, (!isAvailable || isPast) && styles.dayCellDisabled, { backgroundColor: selected ? tc.brand : tc.bgElevated }]}>
                  <Text style={[styles.dayLabel, d.isToday && styles.todayUnderline, { color: tc.textPrimary }]}>{d.label}</Text>
                  <Text style={[styles.dayDate, selected && styles.dayCellSelectedText, { color: selected ? '#fff' : tc.textPrimary }]}>{d.date.getDate()}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
          {!loading && !error && !availability && (
            <Text style={[styles.statusText, { color: tc.textMuted }]}>{t('BOOKING_COURT_NO_SCHEDULE')}</Text>
          )}
          {showTimePicker && scheduleDisplayAvailability && (
            <View style={{ marginTop: 16 }}>
              <Text style={[styles.subHeading, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SELECT_TIME')}</Text>
              <Text style={[styles.smallText, { color: tc.textSecondary }]}>{t('BOOKING_COURT_LABEL_START')}</Text>
              <View style={styles.slotRow}>
                {startVisibleSlots.map((ts) => {
                  const disabled = isStartSlotBlocked(ts)
                  return (
                    <TouchableOpacity key={ts} disabled={disabled} onPress={() => onSelectStart(ts)} style={[styles.slotBtn, startSlot === ts && styles.slotBtnActive, disabled && styles.slotBtnDisabled, startSlot === ts && { backgroundColor: tc.brand }]}>
                      <Text style={[styles.slotText, disabled && styles.slotTextDisabled]}>{ts}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
              {startSlot && (
                <>
                  <Text style={[styles.smallText, { marginTop: 12, color: tc.textSecondary }]}>{t('BOOKING_COURT_LABEL_END')}</Text>
                  <View style={styles.slotRow}>
                    {visibleTimeSlots.filter((ts) => ts > startSlot!).map((ts) => {
                      const disabled = isEndSlotBlocked(ts)
                      return (
                        <TouchableOpacity key={ts} disabled={disabled} onPress={() => onSelectEnd(ts)} style={[styles.slotBtn, endSlot === ts && styles.slotBtnActive, disabled && styles.slotBtnDisabled, endSlot === ts && { backgroundColor: tc.brand }]}>
                          <Text style={[styles.slotText, disabled && styles.slotTextDisabled]}>{ts}</Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                  {endSlot && durationInvalid && <Text style={styles.durationWarning}>Booking duration must be at least 1 hour.</Text>}
                </>
              )}
            </View>
          )}
        </View>
      )}

      {/* Payment/Services/Note — always shown */}
      <View style={[styles.sectionCard, { backgroundColor: tc.bgSurface }]}>
        <View style={{ marginTop: 0 }}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SECTION_PAYMENT')}</Text>
          <View style={styles.paymentRow}>
            <TouchableOpacity
              onPress={() => setPaymentMethod(paymentMethod === 'cash' ? null : 'cash')}
              style={[styles.payMethodBtn, { backgroundColor: tc.bgElevated }, paymentMethod === 'cash' && styles.payMethodActive]}
            >
              <Image source={ICONS.cashIcon} style={styles.payIcon} />
              <Text style={[styles.payText, { color: tc.textPrimary }]}>{t('BOOKING_COURT_PAYMENT_CASH')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setPaymentMethod(paymentMethod === 'vnpay' ? null : 'vnpay')}
              style={[styles.payMethodBtn, { backgroundColor: tc.bgElevated }, paymentMethod === 'vnpay' && styles.payMethodActive]}
            >
              <Image source={ICONS.vnpayIcon} style={styles.payIcon} />
              <Text style={[styles.payText, { color: tc.textPrimary }]}>{t('BOOKING_COURT_PAYMENT_VNPAY')}</Text>
            </TouchableOpacity>
          </View>

          {/* Services (expandable, closed by default) */}
          <TouchableOpacity style={styles.servicesHeaderRow} activeOpacity={0.8} onPress={() => setServicesExpanded(p => !p)}>
            <Text style={[styles.servicesHeaderText, { color: tc.textPrimary }]}>{t('BOOKING_COURT_SECTION_SERVICES')}</Text>
            <Image source={ICONS.arrowdown} style={[styles.servicesArrow, servicesExpanded && styles.servicesArrowOpen, { tintColor: tc.textMuted }]} />
          </TouchableOpacity>
          {servicesExpanded && (
            <View style={styles.servicesWrapper}>
              {servicesLoading ? (
                <SkeletonPulse>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <SkeletonBox width={138} height={188} radius={14} />
                    <SkeletonBox width={138} height={188} radius={14} />
                    <SkeletonBox width={138} height={188} radius={14} />
                  </View>
                </SkeletonPulse>
              ) : (
                (Array.isArray(servicesData) ? servicesData : []).length === 0 ? (
                  <Text style={[styles.statusText, { color: tc.textMuted }]}>{t('BOOKING_COURT_NO_SERVICES')}</Text>
                ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.servicesScrollContent}>
                  {(Array.isArray(servicesData) ? servicesData : []).map((s: ServiceRow) => {
                    const qty = serviceQtyById[s.serviceid] || 0
                    const touched = !!serviceTouchedById[s.serviceid]
                    const rawImageUri = Array.isArray(s.images) && s.images.length ? s.images[0] : null
                    const imageUri = typeof rawImageUri === 'string' && rawImageUri.trim()
                      ? optimizeRemoteImageUrl(rawImageUri, { width: 600, height: 300, quality: 75, resize: 'contain' })
                      : null
                    return (
                      <View key={s.serviceid} style={styles.serviceCard}>
                        {imageUri ? (
                          <View style={[styles.serviceImageWrap, { backgroundColor: tc.bgElevated }]}>
                            <ExpoImage
                              source={{ uri: imageUri }}
                              style={styles.serviceImage}
                              contentFit="contain"
                              cachePolicy="disk"
                              transition={0}
                              recyclingKey={`${s.serviceid}:${imageUri}`}
                            />
                          </View>
                        ) : (
                          <View style={[styles.serviceImagePlaceholder, { backgroundColor: tc.bgElevated }]} />
                        )}
                        <Text style={[styles.serviceName, { color: tc.textPrimary }]} numberOfLines={2}>{s.name}</Text>
                        <Text style={[styles.servicePrice, { color: tc.textPrimary }]}>{new Intl.NumberFormat('vi-VN').format(Number(s.price) || 0)}₫</Text>

                        <View style={styles.qtyRow}>
                          <TouchableOpacity
                            onPress={() => {
                              setServiceTouchedById(prev => ({ ...prev, [s.serviceid]: true }))
                              setServiceQtyById(prev => {
                                const cur = prev[s.serviceid] || 0
                                const next = Math.max(0, cur - 1)
                                return { ...prev, [s.serviceid]: next }
                              })
                            }}
                            style={[styles.qtyBox, { borderColor: tc.border }]}
                            activeOpacity={0.8}
                          >
                            <Text style={[styles.qtyBoxText, { color: tc.textPrimary }]}>-</Text>
                          </TouchableOpacity>
                          <View style={[styles.qtyBoxMid, { borderColor: tc.border }]}>
                            <Text style={[styles.qtyMidText, { color: tc.textPrimary }]}>{touched ? String(qty) : ''}</Text>
                          </View>
                          <TouchableOpacity
                            onPress={() => {
                              setServiceTouchedById(prev => ({ ...prev, [s.serviceid]: true }))
                              setServiceQtyById(prev => {
                                const cur = prev[s.serviceid] || 0
                                const next = cur + 1
                                return { ...prev, [s.serviceid]: next }
                              })
                            }}
                            style={[styles.qtyBox, { borderColor: tc.border }]}
                            activeOpacity={0.8}
                          >
                            <Text style={[styles.qtyBoxText, { color: tc.textPrimary }]}>+</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )
                  })}
                </ScrollView>
                )
              )}
            </View>
          )}

          {/* Note Section */}
          <TouchableOpacity style={[styles.noteRow, { backgroundColor: tc.bgElevated }]} activeOpacity={0.8} onPress={() => setNoteExpanded(p => !p)}>
            <Image source={ICONS.noteIcon} style={styles.noteIcon} />
            <Text style={[styles.noteTextLabel, { color: tc.textPrimary }]}>{t('BOOKING_COURT_LABEL_NOTE')}</Text>
            <Image source={ICONS.arrowright} style={[styles.noteArrow, noteExpanded && styles.noteArrowExpanded, { tintColor: tc.textMuted }]} />
          </TouchableOpacity>
          {noteExpanded && (
            <View style={[styles.noteInputWrapper, { backgroundColor: tc.bgInput, borderColor: tc.border }]}>
              <TextInput
                style={[styles.noteInput, { color: tc.textPrimary, backgroundColor: tc.bgInput }]}
                placeholder={t('BOOKING_COURT_NOTE_PLACEHOLDER')}
                placeholderTextColor={tc.textMuted}
                multiline
                value={noteText}
                onChangeText={setNoteText}
              />
            </View>
          )}
          {/* Promotion moved under payment methods */}
          <View style={[styles.promoWrapper,{marginTop:16}]}>
            <TouchableOpacity style={[styles.promoBox, { backgroundColor: tc.bgElevated }]} activeOpacity={0.75}>
              <Text style={[styles.promoText, { color: tc.brand }]}>{t('BOOKING_COURT_APPLY_PROMO')}</Text>
            </TouchableOpacity>
          </View>
          {(fullHalfOverlapError || submitError) && <Text style={styles.errorText}>{fullHalfOverlapError || submitError}</Text>}
          {confirmation && (
            <View style={styles.successBox}>
              <Text style={styles.successTitle}>Booked!</Text>
              <Text style={styles.successLine}>ID: {confirmation.courtbookingid}</Text>
              <Text style={styles.successLine}>{formatRange(confirmation.start_timestamp, confirmation.end_timestamp)}</Text>
              <Text style={styles.successLine}>Payment #{confirmation.paymentid}</Text>
            </View>
          )}
          {bookingMutation.isError && !submitError && (
            <Text style={styles.errorText}>Mutation error occurred.</Text>
          )}
        </View>
      </View>
    </ScrollView>
    {/* Fixed Bottom Booking Bar inside SafeArea */}
    <SafeAreaView edges={['bottom']} style={[styles.bottomSafeArea, { backgroundColor: tc.bgBase }]}>
      <View style={[styles.bottomBar, { backgroundColor: tc.bgBase, borderTopColor: tc.divider }]}>
        <TouchableOpacity
          disabled={!canConfirm || submitting}
          onPress={onPressConfirm}
          style={[styles.confirmUnifiedBtn, (!canConfirm || submitting) && styles.confirmBtnDisabled, { backgroundColor: (!canConfirm || submitting) ? undefined : tc.brand }]}
        >
          <Text style={styles.confirmUnifiedText}>{submitting ? 'Processing...' : formattedAmount}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>

    <Modal
      transparent={true}
      visible={confirmModalVisible}
      animationType="fade"
      onRequestClose={() => setConfirmModalVisible(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: tc.bgSurface }]}>
          <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('BOOKING_COURT_MODAL_TITLE')}</Text>
          <Text style={[styles.modalBody, { color: tc.textSecondary }]}>{t('BOOKING_COURT_MODAL_BODY')}</Text>
          <View style={styles.modalActions}>
            <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmModalVisible(false)}>
              <Text style={styles.modalBtnText}>{t('BOOKING_COURT_MODAL_BTN_CANCEL')}</Text>
            </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm, { backgroundColor: tc.brand }]} onPress={() => {
              setConfirmModalVisible(false)
              confirmBooking()
            }}>
              <Text style={[styles.modalBtnText, {color: '#fff'}]}>{t('BOOKING_COURT_MODAL_BTN_CONFIRM')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1 },
  headerSafeArea: { backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  backBtn: { padding: 12, borderRadius: 28, backgroundColor: '#f2f2f2', justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 20, height: 20, tintColor: '#333', marginTop: 2 },
  headerTitle: { fontSize: 18, fontWeight: '600', marginLeft: 12 },
  sectionCard: { backgroundColor: '#fafafa', marginHorizontal: 16, marginBottom: 20, padding: 16, borderRadius: 14, elevation: 2 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  courtName: { fontSize: 16, fontWeight: '700', color: '#222', flexShrink: 1 },
  courtAddress: { flex: 1, fontSize: 14, color: '#555', marginTop: 6, lineHeight: 20, flexWrap: 'wrap' },
  availabilityMeta: { flex: 1, fontSize: 12, color: '#777', marginTop: 10, lineHeight: 18, flexWrap: 'wrap' },
  statusText: { fontSize: 13, color: '#666' },
  errorText: { color: '#c00', marginTop: 8, fontSize: 13 },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  dayCell: { flex: 1, marginHorizontal: 2, paddingVertical: 10, borderRadius: 10, backgroundColor: '#e9e9e9', alignItems: 'center' },
  dayCellSelected: { backgroundColor: '#f97316' },
  dayCellAvailable: { backgroundColor: '#fff3e0' },
  dayCellSelectedText: { color: '#fff' },
  dayCellDisabled: { opacity: 0.35 },
  dayLabel: { fontSize: 12, fontWeight: '600', color: '#222' },
  todayUnderline: { textDecorationLine: 'underline' },
  dayDate: { fontSize: 14, fontWeight: '700', color: '#111', marginTop: 4 },
  subHeading: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  smallText: { fontSize: 12, fontWeight: '600', color: '#333', marginBottom: 4 },
  slotRow: { flexDirection: 'row', flexWrap: 'wrap' },
  slotBtn: { width: '18%', marginRight: '2%', height: 38, backgroundColor: '#1e1e1e', borderRadius: 8, marginBottom: 8, alignItems: 'center', justifyContent: 'center' },
  slotBtnActive: { backgroundColor: COLORS.brandOrangeDeep },
  slotBtnDisabled: { backgroundColor: '#D1D5DB', borderWidth: 1, borderColor: '#D1D5DB' },
  slotText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  slotTextDisabled: { color: '#6B7280' },
  paymentRow: { flexDirection: 'row', marginTop: 20 },
  payMethodBtn: { flex: 1, paddingVertical: 14, paddingHorizontal: 12, backgroundColor: '#eaeaea', marginRight: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center' },
  servicesHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  servicesHeaderText: { fontSize: 14, fontWeight: '700', color: '#222' },
  servicesWrapper: { marginTop: 10 },
  servicesScrollContent: { paddingVertical: 8, paddingRight: 8 },
  serviceCard: { width: 130, marginRight: 14 },
  serviceImageWrap: { width: '100%', height: 62, borderRadius: 10, backgroundColor: '#f2f2f2', overflow: 'hidden' },
  serviceImage: { width: '100%', height: '100%' },
  serviceImagePlaceholder: { width: '100%', height: 62, borderRadius: 10, backgroundColor: '#f2f2f2' },
  serviceName: { marginTop: 8, fontSize: 13, fontWeight: '700', color: '#222', minHeight: 34 },
  servicePrice: { marginTop: 2, fontSize: 12, fontWeight: '700', color: '#111' },
  qtyRow: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyBox: { width: 36, height: 32, borderRadius: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#d9d9d9', alignItems: 'center', justifyContent: 'center' },
  qtyBoxMid: { flex: 1, height: 32, marginHorizontal: 8, borderRadius: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#e2e2e2', alignItems: 'center', justifyContent: 'center' },
  qtyBoxText: { fontSize: 16, fontWeight: '700', color: '#111', lineHeight: 18 },
  qtyMidText: { fontSize: 14, fontWeight: '700', color: '#111' },
  payMethodActive: { backgroundColor: COLORS.brandOrangeLight },
  payIcon: { width: 28, height: 28, marginRight: 10, resizeMode: 'contain' },
  payText: { fontSize: 15, fontWeight: '700', color: '#222' },
  confirmBtnDisabled: { backgroundColor: '#ccc' },
  confirmText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  bottomSafeArea: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
  bottomBar: { paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'center' },
  confirmUnifiedBtn: { width: '90%', backgroundColor: COLORS.brandOrangeDeep, paddingVertical: 18, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  confirmUnifiedText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  successBox: { marginTop: 16, backgroundColor: '#e9ffe9', padding: 12, borderRadius: 10 },
  successTitle: { fontSize: 14, fontWeight: '700', color: '#0a7a0a' },
  successLine: { fontSize: 12, color: '#0a7a0a', marginTop: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  metaIcon: { width: 18, height: 18, tintColor: '#555', marginRight: 8, resizeMode: 'contain', top: 4},
  promoWrapper: { marginTop: 24 },
  promoBox: { backgroundColor: '#ffe9d6', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12 },
  promoText: { fontSize: 14, fontWeight: '600', color: '#b34700' },
  noteRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, marginTop: 16 },
  noteIcon: { width: 22, height: 22, marginRight: 10, resizeMode: 'contain' },
  noteTextLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: '#222' },
  noteArrow: { width: 18, height: 18, resizeMode: 'contain' },
  noteArrowExpanded: { transform: [{ rotate: '90deg' }] },
  servicesArrow: { width: 16, height: 16, resizeMode: 'contain', transform: [{ rotate: '0deg' }], marginTop: 2 },
  servicesArrowOpen: { transform: [{ rotate: '180deg' }] },
  noteInputWrapper: { marginTop: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 10 },
  noteInput: { minHeight: 80, padding: 10, fontSize: 14, color: '#222', textAlignVertical: 'top' },
  durationWarning: { marginTop: 8, color: '#c00', fontSize: 12, fontWeight: '600' },
  courtHeaderRow: { flexDirection:'row', alignItems:'center', marginBottom:4 },
  venueIcon: { width:28, height:28, resizeMode:'contain', marginRight:8 },
  tagsRow: { flexDirection:'row', flexWrap:'wrap', marginTop:8 },
  tag: { backgroundColor:'#eee', paddingHorizontal:10, paddingVertical:6, borderRadius:16, marginRight:6, marginBottom:6 },
  tagFallback: { backgroundColor:'#eee' },
  tagText: { fontSize:12, fontWeight:'600', color:'#333' },
  // New schedule header + navigation styles
  scheduleHeaderRow: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:4 },
  weekNavInline: { flexDirection:'row', alignItems:'center' },
  navBtn: { padding:8, borderRadius:10, backgroundColor:'#e0e0e0', marginHorizontal:4 },
  navBtnDisabled: { opacity:0.35 },
  navIcon: { width:20, height:20, tintColor:'#333', resizeMode:'contain' },
  modalOverlay: { position: 'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.35)', justifyContent:'center', alignItems:'center' },
  modalCard: { width:'85%', backgroundColor:'#fff', padding:20, borderRadius:14, elevation:6 },
  modalTitle: { fontSize:16, fontWeight:'700', marginBottom:8, color:'#222' },
  modalBody: { fontSize:14, color:'#444', lineHeight:20 },
  modalActions: { flexDirection:'row', justifyContent:'flex-end', marginTop:18 },
  modalBtn: { paddingVertical:10, paddingHorizontal:18, borderRadius:10, marginLeft:10 },
  modalCancel: { backgroundColor: COLORS.orange200 },
  modalConfirm: { backgroundColor: COLORS.brandOrangeDeep },
  modalBtnText: { fontSize:14, fontWeight:'600', color: COLORS.brown900 },
  selectCourtCard: { width: IMAGE_TILE_WIDTH, borderRadius: 14, overflow: 'hidden', borderWidth: 2, borderColor: '#E5E7EB', backgroundColor: '#fff' },
  selectCourtCardActive: { borderColor: COLORS.brandOrangeDeep },
  selectCourtCardDisabled: { opacity: 0.38 },
  selectCourtImageWrap: { width: '100%', height: IMAGE_TILE_HEIGHT },
  selectCourtImage: { width: '100%', height: '100%' },
  selectCourtImagePlaceholder: { width: '100%', height: '100%', backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
  selectCourtInfoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 9, columnGap: 8 },
  selectCourtName: { flex: 1, fontSize: 13, fontWeight: '700', color: '#111' },
  selectCourtPriceInline: { fontSize: 13, fontWeight: '700', color: '#111' },
  // Playing court selector
  pcCard: { width: 110, borderRadius: 12, overflow: 'hidden', backgroundColor: '#f2f2f2', borderWidth: 2, borderColor: 'transparent', marginRight: 4 },
  pcCardSelected: { borderColor: COLORS.brandOrangeYellow },
  pcCardImage: { width: '100%', height: 70 },
  pcCardImagePlaceholder: { width: '100%', height: 70, backgroundColor: '#e0e0e0' },
  pcCardName: { fontSize: 12, fontWeight: '700', color: '#222', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
  pcCardPrice: { fontSize: 12, color: '#555', paddingHorizontal: 8, paddingBottom: 4 },
  pcCardHalf: { fontSize: 12, color: '#b34700', paddingHorizontal: 8, paddingBottom: 6 },
})
