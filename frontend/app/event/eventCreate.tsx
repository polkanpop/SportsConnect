import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { View, Text, TouchableOpacity, Image, StyleSheet, TextInput, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Alert, Dimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Image as ExpoImage } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  adjustEventParticipants,
  createEventBooking,
  createEventWithInfo,
  CreateEventWithInfoPayload,
  cloudinarySignUpload,
  invalidateEventsCombinedCache,
  getEvent,
  getEventInfoByEventId,
  CourtBookingRow,
  listCourtBookings,
  listCourtInfoCached,
  CourtInfoRow,
  listEventsCombinedCached,
  listTrainingSessionsCombined,
  CombinedEvent,
  CombinedTrainingSession,
} from '@/lib/backendApi'
import { queryKeys } from '@/hooks/query-keys'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { useFocusEffect } from 'expo-router'
import { appendHistory } from '@/storage/history'

// Lightweight enrichment mapping booking -> court info
interface EnrichedBooking extends CourtBookingRow { courtName?: string; address?: string; courtid?: number }

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
const IMAGE_TILE_HEIGHT = 120

const CLOUDINARY_DELIVERY_WIDTH = 1280
const CLOUDINARY_DELIVERY_HEIGHT = Math.max(
  1,
  Math.round((CLOUDINARY_DELIVERY_WIDTH * IMAGE_TILE_HEIGHT) / Math.max(1, IMAGE_TILE_WIDTH))
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

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default function EventCreateScreen() {
  const router = useRouter()
  const { userId, dashboard } = useAppBootstrap()
  const qc = useQueryClient()

  const dashboardRaw = dashboard.data
  const bookingsLoading = dashboard.isLoading
  const bookingsError = dashboard.error
  const bookingsRaw = dashboardRaw?.court_bookings ?? []
  // Fallback query: fetches directly from /courtbookings when the dashboard cache is stale
  // (e.g. immediately after creating a booking before the Redis cache is busted).
  const { data: bookingsAllRaw = [] } = useQuery<CourtBookingRow[]>({
    queryKey: queryKeys.courtBookingsUser(typeof userId === 'number' ? userId : null),
    queryFn: () => listCourtBookings({ userid: userId as number }),
    enabled: typeof userId === 'number' && (!Array.isArray(bookingsRaw) || bookingsRaw.length === 0),
    staleTime: 60_000,
  })

  // Effective bookings list combining filtered result or client-side filtered fallback
  const effectiveBookings: CourtBookingRow[] = useMemo(() => {
    let base: CourtBookingRow[] = []
    if (Array.isArray(bookingsRaw) && bookingsRaw.length) {
      base = bookingsRaw
    } else if (Array.isArray(bookingsAllRaw) && typeof userId === 'number') {
      base = bookingsAllRaw.filter(b => String(b.userid) === String(userId))
    }
    // Show usable (upcoming) bookings + pending bookings (auto_approve=false courts awaiting approval).
    const isUsable = (b: CourtBookingRow) => {
      const s = String((b as any)?.bookingstatus ?? (b as any)?.status ?? '').toLowerCase()
      if (s.includes('cancel') || s.includes('complete') || s.includes('reject')) return false
      return s.includes('upcoming') || s.includes('active') || s.includes('scheduled') || s.includes('pending') || !s
    }
    const active = base.filter(isUsable)

    // Ensure uniqueness for Venue & Court list by exact booking identity + slot signature.
    const map = new Map<string, CourtBookingRow>()
    for (const b of active) {
      const cbid = Number((b as any)?.courtbookingid)
      const availabilityid = Number((b as any)?.availabilityid)
      if (!Number.isFinite(cbid)) continue
      const normalized = { ...(b as any), courtbookingid: cbid, availabilityid } as CourtBookingRow
      const start = String((b as any)?.start_timestamp ?? '').trim()
      const end = String((b as any)?.end_timestamp ?? '').trim()
      const date = String((b as any)?.bookingdate ?? '').trim()
      const court = String((b as any)?.courtid ?? '').trim()
      const slotKey = `${court}|${date}|${start}|${end}`
      const key = Number.isFinite(cbid)
        ? `cb:${cbid}`
        : (Number.isFinite(availabilityid) ? `av:${availabilityid}|${slotKey}` : `slot:${slotKey}`)
      map.set(key, normalized)
    }
    return Array.from(map.values())
  }, [bookingsRaw, bookingsAllRaw, userId])

  useEffect(() => {
    if (typeof userId === 'number') {
      console.log('[EventCreate] userId', userId, 'filteredCount', bookingsRaw?.length || 0, 'fallbackAllCount', bookingsAllRaw?.length || 0, 'effectiveCount', effectiveBookings.length)
    }
  }, [userId, bookingsRaw, bookingsAllRaw, effectiveBookings])

  // Load all courtinfo (cached helper) once (could be narrowed later)
  const { data: allCourtInfo } = useQuery({
    queryKey: queryKeys.courtInfo,
    queryFn: () => listCourtInfoCached(),
    staleTime: 5*60*1000,
  })

  const [expandedCourts, setExpandedCourts] = useState(false)
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [participantsCap, setParticipantsCap] = useState<string>('')
  const [participantsCapError, setParticipantsCapError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [remoteImageUrls, setRemoteImageUrls] = useState<string[]>([])
  const [imageUploading, setImageUploading] = useState(false)
  const [removeImageConfirmVisible, setRemoveImageConfirmVisible] = useState(false)
  const [removeImageCandidateUri, setRemoveImageCandidateUri] = useState<string | null>(null)
  const [addMeToParticipants, setAddMeToParticipants] = useState(true)
  const [autoApprove, setAutoApprove] = useState<boolean>(false)
  const [monetize, setMonetize] = useState<boolean>(false)
  const [entryFee, setEntryFee] = useState<string>('')
  const [entryFeeError, setEntryFeeError] = useState<string | null>(null)
  const [payCash, setPayCash] = useState(false)
  const [payVnPay, setPayVnPay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successData, setSuccessData] = useState<any | null>(null)
  const [previewOpen, setPreviewOpen] = useState<boolean>(true)
  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

  const uploadOneToCloudinary = useCallback(
    async (localUri: string, idx: number) => {
      if (typeof userId !== 'number') throw new Error('Not signed in')

      const resized = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 1280 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      )

      const publicId = `event_${userId}_${Date.now()}_${idx}`
      const sign = await cloudinarySignUpload({ public_id: publicId, overwrite: true })
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
    [userId],
  )

  const pickImages = useCallback(async () => {
    if (imageUploading) return
    if (typeof userId !== 'number') {
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
      const uploadedUrl = await uploadOneToCloudinary(picked[0], remoteImageUrls.length)
      setRemoteImageUrls((prev) => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Please try again')
    } finally {
      setImageUploading(false)
    }
  }, [imageUploading, remoteImageUrls.length, uploadOneToCloudinary, userId])

  const requestRemoveImage = useCallback((uri: string) => {
    setRemoveImageCandidateUri(uri)
    setRemoveImageConfirmVisible(true)
  }, [])

  const onConfirmRemoveImage = useCallback(() => {
    if (removeImageCandidateUri) setRemoteImageUrls((prev) => prev.filter((u) => u !== removeImageCandidateUri))
    setRemoveImageConfirmVisible(false)
    setRemoveImageCandidateUri(null)
  }, [removeImageCandidateUri])
  
  // Shared time formatter (weekday, month day, start - end) matching eventList
  const formatRange = useCallback((start?: string | null, end?: string | null) => {
    if (!start) return 'Unknown date'
    try {
      const s = new Date(start)
      const e = end ? new Date(end) : null
      const day = s.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })
      const st = s.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })
      const et = e ? e.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : ''
      return `${day}, ${st}${et?` - ${et}`:''}`
    } catch { return 'Unknown date' }
  }, [])

  // Enrich bookings with court name/address by fetching availability -> courtid (simple sequential fetch)
  const { data: enrichedBookings, isLoading: enriching } = useQuery({
    queryKey: ['enrichedBookings', userId, (effectiveBookings as CourtBookingRow[]).map(b => b.courtbookingid).join(',')],
    enabled: Array.isArray(effectiveBookings) && effectiveBookings.length > 0,
    queryFn: async () => {
      const result: EnrichedBooking[] = []
      const cacheAvail = new Map<number, any>()
      for (const b of effectiveBookings as CourtBookingRow[]) {
        let availability = cacheAvail.get(b.availabilityid)
        if (!availability) {
          try { availability = await fetchAvailability(b.availabilityid) } catch { availability = null }
          cacheAvail.set(b.availabilityid, availability)
        }
        const courtid = availability?.courtid
        let ci: CourtInfoRow | undefined
        if (courtid && Array.isArray(allCourtInfo)) ci = allCourtInfo.find(c => c.courtid === courtid)
        result.push({ ...b, courtName: ci?.name ?? undefined, address: ci?.address ?? undefined, courtid })
      }
      return result
    }
  })

  // Fetch events and training sessions to mark used bookings
  const { data: eventsCombined, isLoading: eventsCombinedLoading, refetch: refetchEventsCombined } = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    staleTime: 60_000,
  })
  const { data: sessionsCombined, isLoading: sessionsCombinedLoading, refetch: refetchSessionsCombined } = useQuery({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombined(),
    staleTime: 60_000,
  })
  const usedEventBookingIds = useMemo(() => new Set<number>((eventsCombined||[]).map((e:CombinedEvent)=>Number((e as any)?.courtbookingid)).filter((n:any)=>Number.isFinite(n))), [eventsCombined])
  const usedSessionBookingIds = useMemo(() => new Set<number>((sessionsCombined||[]).map((s:CombinedTrainingSession)=>Number((s as any)?.courtbookingid)).filter((n:any)=>Number.isFinite(n))), [sessionsCombined])
  const bookingSelectionLoading = bookingsLoading || enriching || eventsCombinedLoading || sessionsCombinedLoading

  // Derived list of enriched bookings that are not already used by events/training
  const availableEnrichedBookings = useMemo(() => {
    if (!enrichedBookings) return [] as EnrichedBooking[]
    return enrichedBookings.filter(b => !usedEventBookingIds.has(b.courtbookingid) && !usedSessionBookingIds.has(b.courtbookingid))
  }, [enrichedBookings, usedEventBookingIds, usedSessionBookingIds])

  // Availability fetch: directly hit single row endpoint by availability id for accuracy
  async function fetchAvailability(id: number) {
    try { return await fetchSingleAvailability(id) } catch { return null }
  }
  async function fetchSingleAvailability(id: number) {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || ''
    const url = `${base.replace(/\/$/, '')}/courtavailability/${id}`
    const r = await fetch(url)
    if (!r.ok) throw new Error('availability fetch failed')
    return await r.json()
  }

  const selectedBooking = useMemo(() => enrichedBookings?.find(b => b.courtbookingid === selectedBookingId) || null, [enrichedBookings, selectedBookingId])

  // Derived payment methods array or null
  const paymentMethodsValue = useMemo<('cash'|'vnpay'|'both')[] | null>(() => {
    if (!monetize) return null
    const arr: ('cash'|'vnpay'|'both')[] = []
    if (payCash) arr.push('cash')
    if (payVnPay) arr.push('vnpay')
    return arr
  }, [monetize, payCash, payVnPay])

  const participantsCapNum = useMemo(() => {
    const n = parseInt(participantsCap, 10)
    return Number.isFinite(n) ? n : 0
  }, [participantsCap])

  const entryFeeNum = useMemo(() => {
    const n = parseInt(entryFee, 10)
    return Number.isFinite(n) ? n : 0
  }, [entryFee])

  const formValid = useMemo(() => {
    if (!selectedBookingId) return false
    if (!title.trim()) return false
    if (participantsCapNum <= 0) return false
    if (participantsCapError) return false
    if (monetize) {
      if (entryFeeNum <= 0) return false
      if (entryFeeError) return false
      if (!paymentMethodsValue || paymentMethodsValue.length === 0) return false
    }
    return true
  }, [selectedBookingId, title, participantsCapNum, participantsCapError, monetize, entryFeeNum, entryFeeError, paymentMethodsValue])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!formValid || !selectedBookingId) throw new Error('Invalid form')
      setSubmitError(null); setSuccessData(null)
      const payload: CreateEventWithInfoPayload = {
        courtbookingid: selectedBookingId,
        title: title.trim(),
        description: description.trim() || undefined,
        images: remoteImageUrls.length ? remoteImageUrls : undefined,
        participants_cap: participantsCapNum,
        auto_approve: autoApprove,
        monetize,
        organizerid: typeof userId === 'number' ? userId : undefined,
      }
      if (monetize) {
        payload.entry_fee = entryFeeNum
        payload.payment_methods = paymentMethodsValue!
      }
      const resp = await createEventWithInfo(payload)
      return resp
    },
    onSuccess: async (data) => {
      setSuccessData(data)

      const createdEventId = typeof data?.event?.eventid === 'number' ? data.event.eventid : null

      if (typeof userId === 'number' && typeof createdEventId === 'number') {
        const nameFromInfo = String(data?.eventinfo?.title ?? '').trim()
        const nameFromForm = String(title ?? '').trim()
        const name = nameFromInfo || nameFromForm || `Event ${createdEventId}`
        void appendHistory(userId, {
          kind: 'created_event',
          title: `Event created: ${name}`,
          subtitle: selectedBooking ? formatRange((selectedBooking as any)?.start_timestamp, (selectedBooking as any)?.end_timestamp) : null,
          fromStatus: null,
          toStatus: null,
          meta: {
            eventid: createdEventId,
            courtbookingid: data?.event?.courtbookingid,
            start_timestamp: (selectedBooking as any)?.start_timestamp ?? null,
            end_timestamp: (selectedBooking as any)?.end_timestamp ?? null,
            monetize,
            court_name: (selectedBooking as any)?.courtName ?? (selectedBooking as any)?.court_name ?? null,
          },
        })
      }

      // Only add to lists when the DB returns a complete event + eventinfo row.
      if (typeof createdEventId === 'number') {
        let evRow: any = null
        let infoRow: any = null
        for (let i = 0; i < 4; i++) {
          try {
            const [ev, info] = await Promise.all([
              getEvent(createdEventId),
              getEventInfoByEventId(createdEventId),
            ])
            const titleText = String((info as any)?.title ?? '').trim()
            if (ev && info && titleText) {
              evRow = ev
              infoRow = info
              break
            }
          } catch {}
          await waitFor(350)
        }

        if (evRow && infoRow) {
          const combinedRow: any = {
            eventid: createdEventId,
            time: evRow?.time,
            status: evRow?.status ?? 'upcoming',
            courtbookingid: evRow?.courtbookingid,
            organizerid: evRow?.organizerid ?? (typeof userId === 'number' ? userId : undefined),
            organizerName: null,
            title: infoRow?.title,
            description: infoRow?.description ?? null,
            images: (infoRow as any)?.images ?? null,
            numberofpeople: infoRow?.numberofpeople ?? 0,
            participants_cap: infoRow?.participants_cap ?? 0,
            entry_fee: infoRow?.entry_fee ?? null,
            support_payment_method: infoRow?.support_payment_method ?? null,
            join_status: infoRow?.join_status ?? null,
            start_timestamp: selectedBooking?.start_timestamp ?? null,
            end_timestamp: selectedBooking?.end_timestamp ?? null,
            address: selectedBooking?.address ?? undefined,
            court_name: selectedBooking?.courtName ?? null,
          }

          qc.setQueryData(queryKeys.eventsCombined, (prev: any) => {
            const arr = Array.isArray(prev) ? prev : []
            if (arr.some((r: any) => r?.eventid === createdEventId)) return arr
            return [combinedRow, ...arr]
          })
          if (typeof userId === 'number') {
            qc.setQueryData(queryKeys.createdEventsCombined(userId), (prev: any) => {
              const arr = Array.isArray(prev) ? prev : []
              if (arr.some((r: any) => r?.eventid === createdEventId)) return arr
              return [combinedRow, ...arr]
            })
            // Inject into the Hosting tab cache so it appears immediately without waiting for a refetch
            qc.setQueryData(queryKeys.activityHostingEvents(userId), (prev: any) => {
              const arr = Array.isArray(prev) ? prev : []
              if (arr.some((r: any) => r?.eventid === createdEventId)) return arr
              return [combinedRow, ...arr]
            })
          }

          qc.setQueryData(['details', 'createdEvent', createdEventId], evRow)
          qc.setQueryData(['details', 'createdEventInfo', createdEventId], infoRow)
        }
      }

      const bumpParticipantsInEventsCombined = (eventId: number, delta: number) => {
        qc.setQueryData(queryKeys.eventsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => {
            if (row?.eventid !== eventId) return row
            const cur = Number(row?.numberofpeople)
            const curN = Number.isFinite(cur) ? cur : 0
            return { ...row, numberofpeople: Math.max(0, curN + delta) }
          })
        })
      }

      const upsertUserBookingCache = (booking: any) => {
        if (typeof userId !== 'number') return
        const upsert = (key: readonly unknown[]) => {
          qc.setQueryData(key, (prev: any) => {
            const arr = Array.isArray(prev) ? prev : []
            const exists = arr.some((b: any) => {
              if (typeof b?.eventid !== 'number') return false
              if (b.eventid !== booking?.eventid) return false
              const s = String(b?.bookingstatus ?? b?.status ?? '').toLowerCase()
              return !s.includes('cancel')
            })
            return exists ? arr : [booking, ...arr]
          })
        }
        upsert(queryKeys.eventBookingsUser(userId))
      }

      const bumpParticipantsInCreatedEventsCombined = (eventId: number, delta: number) => {
        if (typeof userId !== 'number') return
        qc.setQueryData(queryKeys.createdEventsCombined(userId), (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => {
            if (row?.eventid !== eventId) return row
            const cur = Number(row?.numberofpeople)
            const curN = Number.isFinite(cur) ? cur : 0
            return { ...row, numberofpeople: Math.max(0, curN + delta) }
          })
        })
      }

      // Optional: automatically join as a participant so the creator doesn't need to book again.
      if (addMeToParticipants && typeof userId === 'number' && typeof createdEventId === 'number') {
        const eventId = createdEventId
        void (async () => {
          try {
            const booking = await createEventBooking({
              eventid: eventId,
              userid: userId,
              status: autoApprove ? 'joined' : 'pending',
              bookingstatus: 'upcoming',
              note: null,
            } as any)

            void appendHistory(userId, {
              kind: 'event_booking',
              title: `Joined your event: ${title.trim() || `Event ${eventId}`}`,
              subtitle: null,
              fromStatus: 'pending',
              toStatus: String(booking?.status ?? 'pending'),
              meta: {
                eventid: eventId,
                eventbookingid: booking?.eventbookingid,
                payment_method: 'free',
                start_timestamp: (selectedBooking as any)?.start_timestamp ?? null,
                end_timestamp: (selectedBooking as any)?.end_timestamp ?? null,
              },
            })

            upsertUserBookingCache(booking)
            bumpParticipantsInEventsCombined(eventId, +1)
            bumpParticipantsInCreatedEventsCombined(eventId, +1)

            // Best-effort participant increment
            try { await adjustEventParticipants(eventId, +1) } catch {}

            // Ensure AsyncStorage cached combined list doesn't stick at 0
            void invalidateEventsCombinedCache()
            // Delay so the backend background-task cache bust completes before we refetch,
            // otherwise the immediate refetch races with the backend and returns stale data.
            setTimeout(() => qc.invalidateQueries({ queryKey: queryKeys.eventsCombined }), 2000)
          } catch {}

          setTimeout(() => qc.invalidateQueries({ queryKey: queryKeys.dashboard(userId) }), 2000)
        })()
      }

      // Invalidate events list cache so new event appears.
      // Delayed 2 s so the backend background-task cache bust completes first;
      // setQueryData above already makes the event visible immediately.
      void invalidateEventsCombinedCache()
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: queryKeys.eventsCombined })
        if (typeof userId === 'number') {
          qc.invalidateQueries({ queryKey: queryKeys.dashboard(userId) })
          qc.invalidateQueries({ queryKey: queryKeys.createdEventsCombined(userId) })
          qc.invalidateQueries({ queryKey: queryKeys.activityHostingEvents(userId) })
        }
        qc.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'details' })
      }, 2000)
      // clear draft on success
      try { AsyncStorage.removeItem('@eventCreate:draft') } catch {}

      const detailsId = typeof createdEventId === 'number' ? `created_event_${createdEventId}` : undefined
      setTimeout(() => {
        router.replace({ pathname: '/event/CreationInfo', params: { type: 'event', detailsId } });
      }, 900)
    },
    onError: (err: any) => {
      setSubmitError(err?.message || 'Create failed')
    },
    onSettled: () => setSubmitting(false)
  })

  // Draft persistence: load on mount
  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem('@eventCreate:draft')
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (!mounted || !parsed) return
        if (typeof parsed.title === 'string') setTitle(parsed.title)
        if (typeof parsed.participantsCap === 'string') setParticipantsCap(parsed.participantsCap)
        if (typeof parsed.description === 'string') setDescription(parsed.description)
        if (typeof parsed.addMeToParticipants === 'boolean') setAddMeToParticipants(parsed.addMeToParticipants)
        if (typeof parsed.autoApprove === 'boolean') setAutoApprove(parsed.autoApprove)
        if (typeof parsed.monetize === 'boolean') setMonetize(parsed.monetize)
        if (typeof parsed.entryFee === 'string') setEntryFee(parsed.entryFee)
        if (typeof parsed.payCash === 'boolean') setPayCash(parsed.payCash)
        if (typeof parsed.payVnPay === 'boolean') setPayVnPay(parsed.payVnPay)
        if (typeof parsed.selectedBookingId === 'number') setSelectedBookingId(parsed.selectedBookingId)
      } catch (e) {}
    }
    load()
    return () => { mounted = false }
  }, [])

  // Save draft on change (simple throttle)
  useEffect(() => {
    const t = setTimeout(() => {
      const payload = {
        title, participantsCap, description, addMeToParticipants, autoApprove, monetize, entryFee, payCash, payVnPay, selectedBookingId
      }
      try { AsyncStorage.setItem('@eventCreate:draft', JSON.stringify(payload)) } catch (e) {}
    }, 400)
    return () => clearTimeout(t)
  }, [title, participantsCap, description, addMeToParticipants, autoApprove, monetize, entryFee, payCash, payVnPay, selectedBookingId])

  const onSubmit = () => {
    if (submitting) return
    // Ensure we have an available booking to create the event on.
    let bookingToUseId = selectedBookingId
    const isSelectedAvailable = bookingToUseId != null && availableEnrichedBookings.some(b => b.courtbookingid === bookingToUseId)
    if (!isSelectedAvailable) {
      // fallback to first available
      if (availableEnrichedBookings.length > 0) {
        bookingToUseId = availableEnrichedBookings[0].courtbookingid
        setSelectedBookingId(bookingToUseId)
      } else {
        setSubmitError('No available bookings to create an event.')
        return
      }
    }

    // Now validate other form fields using the booking we will use
    if (!title.trim()) { setSubmitError('Please enter a title'); return }
    if (participantsCapNum <= 0) { setSubmitError('Please set max participants'); return }
    if (monetize) {
      if (entryFeeNum <= 0) { setSubmitError('Please set a valid entry fee'); return }
      if (!paymentMethodsValue || paymentMethodsValue.length === 0) { setSubmitError('Please select a payment method'); return }
    }

    setSubmitError(null); setSuccessData(null); setSubmitting(true)
    // Mutate using the chosen booking id
    mutation.mutate({ _bookingFallbackId: bookingToUseId } as any)
  }

  const renderBookingItem = ({ item }: { item: EnrichedBooking }) => {
    const isEvent = usedEventBookingIds.has(item.courtbookingid)
    const isTraining = usedSessionBookingIds.has(item.courtbookingid)
    const bStatus = String((item as any)?.bookingstatus ?? (item as any)?.status ?? '').toLowerCase()
    const isPending = bStatus.includes('pending') && !bStatus.includes('upcoming') && !bStatus.includes('active')
    const disabled = isEvent || isTraining || isPending
    const tag = isEvent ? 'Event' : (isTraining ? 'Training' : (isPending ? 'Not verified' : null))
    return (
      <TouchableOpacity
        style={[styles.bookingItem, selectedBookingId === item.courtbookingid && !disabled && styles.bookingItemSelected, disabled && styles.bookingItemDisabled]}
        onPress={() => { if (!disabled) setSelectedBookingId(item.courtbookingid) }}
        disabled={disabled}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.bookingTitleRow}>
            <Text style={styles.bookingTitle} numberOfLines={1}>{item.courtName || `Booking ${item.courtbookingid}`}</Text>
            {tag && <View style={[styles.bookingTag, isEvent ? styles.bookingTagEvent : (isTraining ? styles.bookingTagTraining : styles.bookingTagPending)]}><Text style={styles.bookingTagText}>{tag}</Text></View>}
          </View>
          {item.address && <Text style={styles.bookingMeta} numberOfLines={1}>{item.address}</Text>}
          <Text style={styles.bookingMeta}>{formatRange(item.start_timestamp as any, item.end_timestamp as any)}</Text>
        </View>
        <Image source={ICONS.arrowright} style={styles.bookingArrow} />
      </TouchableOpacity>
    )
  }

  // Auto-select first AVAILABLE booking when list loads
  useEffect(() => {
    if (!bookingsLoading && Array.isArray(availableEnrichedBookings) && availableEnrichedBookings.length && selectedBookingId == null) {
      setSelectedBookingId(availableEnrichedBookings[0].courtbookingid)
    }
  }, [bookingsLoading, availableEnrichedBookings, selectedBookingId])

  // If current selection becomes unavailable (booked by event/training after refresh), switch to first available or clear.
  useEffect(() => {
    if (selectedBookingId != null) {
      const stillAvailable = availableEnrichedBookings.some(b => b.courtbookingid === selectedBookingId)
      if (!stillAvailable) {
        if (availableEnrichedBookings.length) setSelectedBookingId(availableEnrichedBookings[0].courtbookingid)
        else setSelectedBookingId(null)
      }
    }
  }, [availableEnrichedBookings, selectedBookingId])

  // Refresh combined feeds on focus so booking usage tags stay current.
  useFocusEffect(
    useCallback(() => {
      if (typeof userId === 'number') {
        try { refetchEventsCombined() } catch {}
        try { refetchSessionsCombined() } catch {}
      }
    }, [userId, refetchEventsCombined, refetchSessionsCombined])
  )

  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 220 }}>
          {/* Header */}
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Image source={ICONS.arrowLeft} style={styles.backIcon} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Create Event</Text>
          </View>

          {/* Court Selection */}
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Court Booking</Text>
              <TouchableOpacity onPress={() => setExpandedCourts(e => !e)} style={styles.expandBtn}>
                <Image source={ICONS.arrowdown} style={[styles.expandIcon, expandedCourts && { transform:[{ rotate: '180deg'}] }]} />
              </TouchableOpacity>
            </View>
            {bookingSelectionLoading && <ActivityIndicator size="small" color="#555" />}
            {bookingsError && <Text style={styles.errorText}>{(bookingsError as any)?.message || 'Failed loading bookings'}</Text>}
            {!bookingSelectionLoading && !bookingsError && (!enrichedBookings || enrichedBookings.length===0) && <Text style={styles.smallText}>You have no court bookings yet.</Text>}
            {!bookingSelectionLoading && !bookingsError && enrichedBookings && enrichedBookings.length>0 && availableEnrichedBookings.length===0 && (
              <Text style={styles.smallText}>No available courts for event booking.</Text>
            )}
            {selectedBooking && (
              <View style={styles.selectedBookingBox}>
                <View style={styles.bookingTitleRow}>
                  <Text style={styles.selectedBookingTitle}>{selectedBooking.courtName || 'Selected Booking'}</Text>
                  {usedEventBookingIds.has(selectedBooking.courtbookingid) && <View style={[styles.bookingTag, styles.bookingTagEvent]}><Text style={styles.bookingTagText}>Event</Text></View>}
                  {usedSessionBookingIds.has(selectedBooking.courtbookingid) && <View style={[styles.bookingTag, styles.bookingTagTraining]}><Text style={styles.bookingTagText}>Training</Text></View>}
                </View>
                {selectedBooking.address && <Text style={styles.selectedBookingMeta}>{selectedBooking.address}</Text>}
                <Text style={styles.selectedBookingMeta}>{formatRange(selectedBooking.start_timestamp as any, selectedBooking.end_timestamp as any)}</Text>
              </View>
            )}
            {expandedCourts && enrichedBookings && (
              <View style={styles.bookingList}>
                <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom:4 }}>
                  {enrichedBookings.map(b => (
                    <React.Fragment key={b.courtbookingid}>{renderBookingItem({ item: b })}</React.Fragment>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>

          {/* Event Details */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Details</Text>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Event title" placeholderTextColor="#777" style={styles.input} />
            <Text style={styles.fieldLabel}>Max participants</Text>
            <TextInput
              value={participantsCap}
              onChangeText={(raw) => {
                if (!raw) {
                  setParticipantsCap('')
                  setParticipantsCapError(null)
                  return
                }
                const digits = raw.replace(/[^\d]/g, '')
                setParticipantsCap(digits)
                const hasLetters = /[A-Za-z]/.test(raw)
                setParticipantsCapError(hasLetters ? 'Please type in number' : null)
              }}
              keyboardType="number-pad"
              placeholder="e.g. 10"
              placeholderTextColor="#777"
              style={[styles.input, participantsCapError && styles.inputError]}
            />
            {!!participantsCapError && <Text style={styles.inlineErrorText}>{participantsCapError}</Text>}
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput value={description} onChangeText={setDescription} placeholder="Describe the event details..." placeholderTextColor="#777" multiline style={[styles.input, styles.inputMultiline]} />

            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Images</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
              {remoteImageUrls.map((uri) => (
                <View key={uri} style={styles.coverFrame}>
                  <View style={styles.coverPressable}>
                    <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                  </View>
                  <TouchableOpacity onPress={() => requestRemoveImage(uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                    <Text style={styles.removeXText}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}

              {remoteImageUrls.length < 6 && (
                <View style={styles.coverFrame}>
                  <TouchableOpacity
                    onPress={pickImages}
                    disabled={imageUploading}
                    activeOpacity={0.85}
                    style={styles.coverPressable}
                  >
                    {imageUploading ? (
                      <ActivityIndicator size="small" color={COLORS.neutral800} />
                    ) : (
                      <Text style={styles.addPlus}>+</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>

            <TouchableOpacity
              style={styles.checkboxRow}
              activeOpacity={0.85}
              onPress={() => setAddMeToParticipants(v => !v)}
            >
              <View style={[styles.checkboxBox, addMeToParticipants && styles.checkboxBoxChecked]}>
                {addMeToParticipants && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={styles.checkboxLabel}>Add me to participants list</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.checkboxRow}
              activeOpacity={0.85}
              onPress={() => setAutoApprove(v => !v)}
            >
              <View style={[styles.checkboxBox, autoApprove && styles.checkboxBoxChecked]}>
                {autoApprove && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={styles.checkboxLabel}>Auto-approved (event participants will be automatically accepted)</Text>
            </TouchableOpacity>
          </View>

          {/* Monetization */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Monetization</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity onPress={() => setMonetize(false)} style={[styles.toggleBtn, !monetize && styles.toggleBtnActive]}>
                <Image source={ICONS.free} style={styles.toggleIcon} />
                <Text style={[styles.toggleText, !monetize && styles.toggleTextActive]}>Free</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMonetize(true)} style={[styles.toggleBtn, monetize && styles.toggleBtnActive]}>
                <Image source={ICONS.charge} style={styles.toggleIcon} />
                <Text style={[styles.toggleText, monetize && styles.toggleTextActive]}>Charge</Text>
              </TouchableOpacity>
            </View>
            {/* Monetization note */}
            <Text style={styles.monetizeNote}>{monetize ? 'Note: Each player entering the event will be charged the amount below; please select the price and payment methods carefully.' : 'Note: All players enter the event at no cost!'}</Text>
            {monetize && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.fieldLabel}>Entry Fee (VND)</Text>
                <TextInput
                  value={entryFee}
                  onChangeText={(raw) => {
                    if (!raw) {
                      setEntryFee('')
                      setEntryFeeError(null)
                      return
                    }
                    const digits = raw.replace(/[^\d]/g, '')
                    setEntryFee(digits)
                    const hasLetters = /[A-Za-z]/.test(raw)
                    setEntryFeeError(hasLetters ? 'Please type in number' : null)
                  }}
                  keyboardType="number-pad"
                  placeholder="e.g. 30000"
                  placeholderTextColor="#777"
                  style={[styles.input, entryFeeError && styles.inputError]}
                />
                {!!entryFeeError && <Text style={styles.inlineErrorText}>{entryFeeError}</Text>}
                <Text style={[styles.fieldLabel,{marginTop:12}]}>Payment Methods</Text>
                <View style={styles.paymentRow}>
                  <TouchableOpacity onPress={() => setPayCash(c => !c)} style={[styles.payMethodBtn, payCash && styles.payMethodActive]}>
                    <Image source={ICONS.cashIcon} style={styles.payIcon} />
                    <Text style={styles.payText}>Cash</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setPayVnPay(v => !v)} style={[styles.payMethodBtn, payVnPay && styles.payMethodActive]}>
                    <Image source={ICONS.vnpayIcon} style={styles.payIcon} />
                    <Text style={styles.payText}>VNPay</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          {/* Status / Preview */}
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Preview</Text>
              <TouchableOpacity onPress={() => setPreviewOpen(p => !p)} style={styles.expandBtn}>
                <Image source={ICONS.arrowdown} style={[styles.expandIcon, previewOpen && { transform: [{ rotate: '180deg' }] }]} />
              </TouchableOpacity>
            </View>
            {previewOpen && (
              <>
                <Text style={styles.previewLine}>Status: upcoming</Text>
                <Text style={styles.previewLine}>Location: {selectedBooking ? (selectedBooking.courtName || selectedBooking.courtbookingid) : 'None'}</Text>
                <Text style={styles.previewLine}>Time: {selectedBooking ? formatRange(selectedBooking.start_timestamp as any, selectedBooking.end_timestamp as any) : 'N/A'}</Text>
                <Text style={styles.previewLine}>Max participants: {participantsCapNum || 'N/A'}</Text>
                {monetize ? (
                  <Text style={styles.previewLine}>Entry Fee: {entryFeeNum > 0 ? entryFeeNum.toLocaleString() + ' VND' : 'N/A'} | Methods: {paymentMethodsValue?.join(', ') || 'None'}</Text>
                ) : (
                  <Text style={styles.previewLine}>Entry Fee: Free</Text>
                )}
                {submitError && <Text style={styles.errorText}>{submitError}</Text>}
                {successData && (
                  <View style={styles.successBox}>
                    <Text style={styles.successTitle}>Event Created!</Text>
                    <Text style={styles.successLine}>ID: {successData.event.eventid}</Text>
                    <Text style={styles.successLine}>Title: {successData.eventinfo.title}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </ScrollView>

        {/* Bottom Create Button */}
        <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
          <View style={styles.bottomBar}>
            <TouchableOpacity
              disabled={!formValid || submitting}
              onPress={() => setConfirmModalVisible(true)}
              style={[styles.confirmUnifiedBtn, (!formValid || submitting) && styles.confirmBtnDisabled]}
            >
              <Text style={styles.confirmUnifiedText}>{submitting ? 'Creating...' : 'Create Event'}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>

      <Modal
        transparent={true}
        visible={confirmModalVisible}
        animationType="fade"
        onRequestClose={() => setConfirmModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Creation</Text>
            <Text style={styles.modalBody}>Are you sure you want to create this event?</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmModalVisible(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm]} onPress={() => {
                setConfirmModalVisible(false)
                onSubmit()
              }}>
                <Text style={[styles.modalBtnText, {color: '#fff'}]}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent={true}
        visible={removeImageConfirmVisible}
        animationType="fade"
        onRequestClose={() => {
          setRemoveImageConfirmVisible(false)
          setRemoveImageCandidateUri(null)
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove image</Text>
            <Text style={styles.modalBody}>Do you want to remove this image?</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalCancel]}
                onPress={() => {
                  setRemoveImageConfirmVisible(false)
                  setRemoveImageCandidateUri(null)
                }}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm]} onPress={onConfirmRemoveImage}>
                <Text style={[styles.modalBtnText, { color: '#fff' }]}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

// Legacy helper removed; replaced by formatRange above

const styles = StyleSheet.create({
  screen: { flex:1, backgroundColor:'#fff' },
  scroll: { flex:1 },
  headerRow: { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:12 },
  backBtn: { padding:10, borderRadius:28, backgroundColor:'#f2f2f2', justifyContent:'center', alignItems:'center' },
  backIcon: { width:22, height:22, tintColor:'#333' },
  headerTitle: { fontSize:18, fontWeight:'700', marginLeft:12, color:'#222' },
  sectionCard: { backgroundColor:'#fafafa', marginHorizontal:16, marginBottom:20, padding:16, borderRadius:14, elevation:2 },
  sectionHeaderRow: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:8 },
  sectionTitle: { fontSize:16, fontWeight:'700', color:'#222', marginBottom:8 },
  expandBtn: { padding:6 },
  expandIcon: { width:18, height:18, tintColor:'#555', resizeMode:'contain' },
  smallText: { fontSize:12, fontWeight:'600', color:'#555', marginTop:4 },
  errorText: { color:'#c00', fontSize:12, marginTop:8 },
  inputError: { borderColor: '#c00' },
  inlineErrorText: { color:'#c00', fontSize:12, marginTop:-8, marginBottom:10 },
  bookingList: { marginTop:12, maxHeight:260 },
  bookingItem: { flexDirection:'row', alignItems:'center', backgroundColor:'#eee', padding:12, borderRadius:12, marginBottom:10 },
  bookingItemSelected: { backgroundColor:'#FFD700' },
  bookingItemDisabled: { opacity:0.5 },
  bookingTitleRow: { flexDirection:'row', alignItems:'center' },
  bookingTag: { marginLeft:6, backgroundColor:'#444', paddingHorizontal:6, paddingVertical:2, borderRadius:8 },
  bookingTagEvent: { backgroundColor:'#ff6b3b' },
  bookingTagTraining: { backgroundColor:'#6a5acd' },
  bookingTagPending: { backgroundColor:'#b45309' },
  bookingTagText: { color:'#fff', fontSize:12, fontWeight:'700' },
  bookingTitle: { fontSize:14, fontWeight:'700', color:'#222' },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  checkboxBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: '#bbb', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  checkboxBoxChecked: { backgroundColor: '#FF5733', borderColor: '#FF5733' },
  checkboxTick: { color: '#fff', fontWeight: '900', fontSize: 14, marginTop: -1 },
  checkboxLabel: { marginLeft: 10, color: '#222', fontWeight: '700' },
  bookingMeta: { fontSize:12, color:'#555', marginTop:2 },
  bookingArrow: { width:16, height:16, tintColor:'#333' },
  selectedBookingBox: { backgroundColor:'#e9e9e9', padding:12, borderRadius:12, marginTop:6 },
  selectedBookingTitle: { fontSize:14, fontWeight:'700', color:'#222' },
  selectedBookingMeta: { fontSize:12, color:'#444', marginTop:4 },
  fieldLabel: { fontSize:13, fontWeight:'600', color:'#333', marginBottom:6, marginTop:4 },
  input: { backgroundColor:'#fff', borderWidth:1, borderColor:'#ddd', borderRadius:10, paddingHorizontal:12, paddingVertical:10, fontSize:14, color:'#222', marginBottom:12 },
  inputMultiline: { minHeight:100, textAlignVertical:'top' },
  imagesRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 6, paddingBottom: 6 },
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
  },
  coverPressable: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  coverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  addPlus: { fontSize: 28, fontWeight: '700', color: COLORS.neutral800, marginTop: -1 },
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
  removeXText: { fontSize: 20, lineHeight: 20, fontWeight: '900', color: COLORS.neutral925, marginTop: -1 },
  toggleRow: { flexDirection:'row', marginTop:4 },
  toggleBtn: { flex:1, paddingVertical:12, backgroundColor:'#e0e0e0', marginRight:8, borderRadius:12, alignItems:'center', justifyContent:'center', flexDirection:'row' },
  toggleBtnActive: { backgroundColor:'#FFAA33' },
  toggleText: { fontSize:14, fontWeight:'700', color:'#444' },
  toggleTextActive: { color:'#222' },
  toggleIcon: { width:20, height:20, marginRight:6, resizeMode:'contain' },
  paymentRow: { flexDirection:'row', marginTop:12 },
  payMethodBtn: { flex:1, paddingVertical:14, paddingHorizontal:12, backgroundColor:'#eaeaea', marginRight:10, borderRadius:12, flexDirection:'row', alignItems:'center' },
  payMethodActive: { backgroundColor:'#FFA500' },
  payIcon: { width:28, height:28, marginRight:10, resizeMode:'contain' },
  payText: { fontSize:15, fontWeight:'700', color:'#222' },
  previewLine: { fontSize:12, color:'#555', marginTop:4 },
  monetizeNote: { fontSize:12, color:'#666', marginTop:8},
  successBox: { marginTop:12, backgroundColor:'#e9ffe9', padding:12, borderRadius:10 },
  successTitle: { fontSize:14, fontWeight:'700', color:'#0a7a0a' },
  successLine: { fontSize:12, color:'#0a7a0a', marginTop:4 },
  bottomSafeArea: { position:'absolute', left:0, right:0, bottom:0, backgroundColor:'#ffffff' },
  bottomBar: { paddingHorizontal:16, paddingVertical:16, backgroundColor:'#ffffff', borderTopWidth:1, borderTopColor:'#eee', alignItems:'center' },
  confirmUnifiedBtn: { width:'90%', backgroundColor:'#FF5733', paddingVertical:18, borderRadius:32, justifyContent:'center', alignItems:'center' },
  confirmUnifiedText: { color:'#fff', fontWeight:'700', fontSize:16 },
  confirmBtnDisabled: { opacity:0.55 },
  modalOverlay: { position: 'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.35)', justifyContent:'center', alignItems:'center' },
  modalCard: { width:'85%', backgroundColor:'#fff', padding:20, borderRadius:14, elevation:6 },
  modalTitle: { fontSize:16, fontWeight:'700', marginBottom:8, color:'#222' },
  modalBody: { fontSize:14, color:'#444', lineHeight:20 },
  modalActions: { flexDirection:'row', justifyContent:'flex-end', marginTop:18 },
  modalBtn: { paddingVertical:10, paddingHorizontal:18, borderRadius:10, marginLeft:10 },
  modalCancel: { backgroundColor:'#eee' },
  modalConfirm: { backgroundColor:'#FF5733' },
  modalBtnText: { fontSize:14, fontWeight:'600', color:'#222' },
})
