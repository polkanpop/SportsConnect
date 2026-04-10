import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator, Pressable, useWindowDimensions } from 'react-native'
import { Image as ExpoImage } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useFocusEffect } from '@react-navigation/native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getCache, invalidateCache, setCache } from '@/lib/cache'
import { useTranslation } from '@/constants/translations'
import { useThemeColors } from '@/hooks/use-theme-colors'

import { autocompleteCourtAddress, cloudinarySignUpload, geocodeCourtAddress, geocodeCourtPlaceId, getCourtInfoByCourtId, registerCourt, type CourtAddressSuggestion, type CourtRegisterRequest, upsertCourtInfoIntoCache } from '@/lib/backendApi'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'

const COURT_REGISTER_VERIFY_STORAGE_KEY = '@courtRegisterVerifiedLocation'
const COURT_REGISTER_DRAFT_STORAGE_KEY = '@courtRegisterDraft'

const COURT_REGISTER_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const COURT_REGISTER_VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
type WeekDayKey = typeof WEEK_DAYS[number]

const WEEKDAY_TRANSLATION_KEYS: Record<WeekDayKey, string> = {
  Mon: 'MAP_DAY_MON',
  Tue: 'MAP_DAY_TUE',
  Wed: 'MAP_DAY_WED',
  Thu: 'MAP_DAY_THU',
  Fri: 'MAP_DAY_FRI',
  Sat: 'MAP_DAY_SAT',
  Sun: 'MAP_DAY_SUN',
}

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
const IMAGE_TILE_HEIGHT = 120

// Cloudinary delivery size (kept consistent with the on-screen frame ratio).
// Note: `expo-image-picker` does not expose crop x/y/width/height, so we can't send manual crop coordinates.
// Instead we lock the aspect ratio in the OS crop UI, then scale to an exact size at delivery time.
const CLOUDINARY_DELIVERY_WIDTH = 1280
const CLOUDINARY_DELIVERY_HEIGHT = Math.max(
  1,
  Math.round((CLOUDINARY_DELIVERY_WIDTH * IMAGE_TILE_HEIGHT) / Math.max(1, IMAGE_TILE_WIDTH))
)

const formatVnd = (value: unknown) => {
  const raw = typeof value === 'string' ? value : (value as any)
  const n = typeof raw === 'string'
    ? Number(String(raw).replace(/[^0-9.-]/g, ''))
    : Number(raw)
  const safe = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  try {
    return `${new Intl.NumberFormat('vi-VN').format(safe)}đ`
  } catch {
    return `${String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}đ`
  }
}

const digitsOnly = (s: string) => String(s || '').replace(/\D+/g, '')

const formatThousandGroups = (digits: string) => {
  const d = digitsOnly(digits)
  if (!d) return ''
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const toNumberFromInput = (value: unknown) => {
  const d = digitsOnly(String(value ?? ''))
  if (!d) return 0
  const n = Number(d)
  return Number.isFinite(n) ? n : 0
}

const canonicalizeAddress = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase()

type Venue = 'Indoor' | 'Outdoor' | 'Both'

type PlayingCourtDraft = {
  fullName: string
  fullPrice: string
  allowHalfBooking: boolean
  half1Name: string
  half1Price: string
  half2Name: string
  half2Price: string
  description: string
  images: string[]
  half1Images: string[]
  half2Images: string[]
  surface: string
}

type ServiceDraft = {
  name: string
  category: 'consumable' | 'rental'
  price: string
  stock: string
  images: string[]
}

/* -- Step badge section header -- */
function StepHeader({ step, title }: { step: number; title: string }) {
  const tc = useThemeColors()
  return (
    <View style={stepStyles.row}>
      <View style={[stepStyles.badge, { backgroundColor: tc.brand }]}>
        <Text style={stepStyles.badgeText}>{step}</Text>
      </View>
      <Text style={[stepStyles.title, { color: tc.textSecondary }]}>{title}</Text>
    </View>
  )
}
const stepStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 22, marginBottom: 8, marginHorizontal: 16, gap: 10 },
  badge: { width: 24, height: 24, borderRadius: 12, backgroundColor: COLORS.brandOrangeDeep, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  title: { fontSize: 13, fontWeight: '700', color: '#444', textTransform: 'uppercase', letterSpacing: 0.6 },
})

export default function CourtRegisterPage() {
  const router = useRouter()
  const isMountedRef = useRef(true)
  const { t } = useTranslation()
  const tc = useThemeColors()
  const coverFrameDynamic = { backgroundColor: tc.bgElevated, borderColor: tc.border }
  const coverFrameModalDynamic = { backgroundColor: tc.bgSurface, borderColor: tc.border }

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])
  const { userId: userid } = useAppBootstrap()

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [venue, setVenue] = useState<Venue>('Indoor')

  const [scheduleDays, setScheduleDays] = useState<WeekDayKey[]>([...WEEK_DAYS])
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('22:00')

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

  const [lastVerified, setLastVerified] = useState<{
    address: string
    placeId: string | null
    coord: { latitude: number; longitude: number; formatted_address?: string | null }
  } | null>(null)

  const [localImageUris, setLocalImageUris] = useState<string[]>([])
  const [remoteImageUrls, setRemoteImageUrls] = useState<string[]>([])
  const [imageUploading, setImageUploading] = useState(false)

  const [playingCourts, setPlayingCourts] = useState<PlayingCourtDraft[]>([])
  const [expandedCourtIdxs, setExpandedCourtIdxs] = useState<Set<number>>(new Set())
  // Image zoom
  const [zoomImageUri, setZoomImageUri] = useState<string | null>(null)
  const zoomWindow = useWindowDimensions()
  const zoomFrameW = Math.max(260, Math.min(Math.round(zoomWindow.width * 0.92), 560))
  const zoomFrameH = Math.max(260, Math.min(Math.round(zoomWindow.height * 0.72), 640))
  const zoomScale = useSharedValue(1)
  const zoomTX = useSharedValue(0)
  const zoomTY = useSharedValue(0)
  const zoomBaseScale = useSharedValue(1)
  const zoomBaseX = useSharedValue(0)
  const zoomBaseY = useSharedValue(0)
  const zoomAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: zoomTX.value }, { translateY: zoomTY.value }, { scale: zoomScale.value }],
  }))
  const zoomGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onUpdate((e) => { zoomScale.value = Math.max(1, Math.min(zoomBaseScale.value * e.scale, 4)) })
      .onEnd(() => { zoomBaseScale.value = zoomScale.value })
    const pan = Gesture.Pan()
      .onUpdate((e) => { if (zoomScale.value <= 1) return; zoomTX.value = zoomBaseX.value + e.translationX; zoomTY.value = zoomBaseY.value + e.translationY })
      .onEnd(() => { zoomBaseX.value = zoomTX.value; zoomBaseY.value = zoomTY.value })
    return Gesture.Simultaneous(pinch, pan)
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomScale, zoomTX, zoomTY])
  useEffect(() => {
    if (!zoomImageUri) return
    zoomScale.value = 1; zoomTX.value = 0; zoomTY.value = 0
    zoomBaseScale.value = 1; zoomBaseX.value = 0; zoomBaseY.value = 0
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomImageUri, zoomScale, zoomTX, zoomTY])
  const [playingCourtModalVisible, setPlayingCourtModalVisible] = useState(false)
  const [pcFullName, setPcFullName] = useState('')
  const [pcFullPrice, setPcFullPrice] = useState('')
  const [pcAllowHalf, setPcAllowHalf] = useState(true)
  const [pcHalf1Name, setPcHalf1Name] = useState('')
  const [pcHalf1Price, setPcHalf1Price] = useState('')
  const [pcHalf2Name, setPcHalf2Name] = useState('')
  const [pcHalf2Price, setPcHalf2Price] = useState('')
  const [pcDescription, setPcDescription] = useState('')
  const [pcSurface, setPcSurface] = useState<'hardwood' | 'concrete' | 'synthetic'>('concrete')
  const [pcImages, setPcImages] = useState<string[]>([])
  const [pcHalf1Images, setPcHalf1Images] = useState<string[]>([])
  const [pcHalf2Images, setPcHalf2Images] = useState<string[]>([])
  const [pcHalfTab, setPcHalfTab] = useState<'half1' | 'half2'>('half1')

  const [servicesExpanded, setServicesExpanded] = useState(false)
  const [services, setServices] = useState<ServiceDraft[]>([])
  const [serviceDraftVisible, setServiceDraftVisible] = useState(false)
  const [expandedServiceIdxs, setExpandedServiceIdxs] = useState<Set<number>>(new Set())
  const [svcName, setSvcName] = useState('')
  const [svcCategory, setSvcCategory] = useState<'consumable' | 'rental'>('consumable')
  const [svcCategoryDropdownOpen, setSvcCategoryDropdownOpen] = useState(false)
  const [svcPrice, setSvcPrice] = useState('')
  const [svcStock, setSvcStock] = useState('')
  const [svcImages, setSvcImages] = useState<string[]>([])

  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [verifiedCoord, setVerifiedCoord] = useState<{ latitude: number; longitude: number; formatted_address?: string | null } | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [agreeTruth, setAgreeTruth] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [submittedVisible, setSubmittedVisible] = useState(false)
  const [removeImageConfirmVisible, setRemoveImageConfirmVisible] = useState(false)
  const [removeImageCandidateUri, setRemoveImageCandidateUri] = useState<string | null>(null)

  const toggleCourtExpanded = useCallback((idx: number) => {
    setExpandedCourtIdxs(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      ;(async () => {
        try {
          // Read via TTL cache. Fallback to legacy raw AsyncStorage (migration).
          let parsed: any = await getCache<any>(COURT_REGISTER_VERIFY_STORAGE_KEY)
          if (!parsed) {
            const raw = await AsyncStorage.getItem(COURT_REGISTER_VERIFY_STORAGE_KEY)
            if (raw) {
              try {
                parsed = JSON.parse(raw)
                await setCache(COURT_REGISTER_VERIFY_STORAGE_KEY, parsed, COURT_REGISTER_VERIFY_TTL_MS)
              } catch {}
            }
          }
          if (!parsed) return
          await invalidateCache(COURT_REGISTER_VERIFY_STORAGE_KEY)
          const latitude = Number(parsed?.latitude)
          const longitude = Number(parsed?.longitude)
          const formatted_address = parsed?.formatted_address
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
          if (!cancelled) {
            setVerifiedCoord({ latitude, longitude, formatted_address: typeof formatted_address === 'string' ? formatted_address : null })
            setVerifyError(null)

            // Snapshot this verified result so we can restore the tick if the user edits
            // the address and then types it back exactly.
            const currentAddress = address.trim()
            if (currentAddress) {
              setLastVerified({
                address: currentAddress,
                placeId: selectedPlaceId,
                coord: { latitude, longitude, formatted_address: typeof formatted_address === 'string' ? formatted_address : null },
              })

              // Immediately persist verified result into the draft cache (no debounce),
              // so navigating away and back doesn't force the user to re-verify.
              try {
                const existingDraft: any = await getCache<any>(COURT_REGISTER_DRAFT_STORAGE_KEY)
                const mergedDraft = {
                  ...(existingDraft && typeof existingDraft === 'object' ? existingDraft : {}),
                  address: currentAddress,
                  selectedPlaceId: selectedPlaceId,
                  selectedPlaceAddress: selectedPlaceId ? currentAddress : null,
                  verifiedAddress: currentAddress,
                  verifiedCoord: { latitude, longitude, formatted_address: typeof formatted_address === 'string' ? formatted_address : null },
                }
                await setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, mergedDraft, COURT_REGISTER_DRAFT_TTL_MS)
              } catch {}
            }
          }
        } catch {}
      })()
      return () => {
        cancelled = true
      }
    }, [address, selectedPlaceId])
  )

  // Keep filled form values when user accidentally goes back.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Read via TTL cache. Fallback to legacy raw AsyncStorage (migration).
        let parsed: any = await getCache<any>(COURT_REGISTER_DRAFT_STORAGE_KEY)
        if (!parsed) {
          const raw = await AsyncStorage.getItem(COURT_REGISTER_DRAFT_STORAGE_KEY)
          if (raw) {
            try {
              parsed = JSON.parse(raw)
              await setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, parsed, COURT_REGISTER_DRAFT_TTL_MS)
            } catch {}
          }
        }
        if (!parsed) return
        if (cancelled) return

        // If a registration was in-flight when the user left the screen, keep showing "Registering?"
        // for a short window so the UI doesn't fall back to a disabled state.
        if (parsed?.registerInFlight === true) {
          const startedAt = Number(parsed?.registerInFlightStartedAt)
          if (Number.isFinite(startedAt) && Date.now() - startedAt < 2 * 60 * 1000) {
            setSubmitting(true)
          }
        }

        // Restore selection/autocomplete state first to avoid triggering a refetch.
        // Be forgiving on formatting (spaces/case) so users don't lose progress.
        const parsedAddress = typeof parsed?.address === 'string' ? parsed.address : ''
        const parsedSelectedPlaceId = typeof parsed?.selectedPlaceId === 'string' ? parsed.selectedPlaceId : null
        const parsedSelectedPlaceAddress = typeof parsed?.selectedPlaceAddress === 'string' ? parsed.selectedPlaceAddress : null
        if (parsedSelectedPlaceId) {
          if (!parsedSelectedPlaceAddress || canonicalizeAddress(parsedSelectedPlaceAddress) === canonicalizeAddress(parsedAddress)) {
            setSelectedPlaceId(parsedSelectedPlaceId)
          } else {
            setSelectedPlaceId(null)
          }
        } else {
          setSelectedPlaceId(null)
        }

        if (typeof parsed?.name === 'string') setName(parsed.name)
        if (typeof parsed?.address === 'string') setAddress(parsed.address)
        if (parsed?.venue === 'Indoor' || parsed?.venue === 'Outdoor' || parsed?.venue === 'Both') setVenue(parsed.venue)
        if (Array.isArray(parsed?.scheduleDays)) {
          const wanted = parsed.scheduleDays.filter((d: any) => typeof d === 'string' && (WEEK_DAYS as readonly string[]).includes(d))
          setScheduleDays((wanted.length ? wanted : [...WEEK_DAYS]) as WeekDayKey[])
        }
        if (typeof parsed?.startTime === 'string') setStartTime(normalizeTimeInput(parsed.startTime))
        if (typeof parsed?.endTime === 'string') setEndTime(normalizeTimeInput(parsed.endTime))
        if (typeof parsed?.agreeTruth === 'boolean') setAgreeTruth(parsed.agreeTruth)
        if (Array.isArray(parsed?.localImageUris)) setLocalImageUris(parsed.localImageUris.filter((x: any) => typeof x === 'string'))
        if (Array.isArray(parsed?.remoteImageUrls)) setRemoteImageUrls(parsed.remoteImageUrls.filter((x: any) => typeof x === 'string'))

        // Restore last geocode (used to re-open MapVerify without re-calling geocode)
        const lgAddr = typeof parsed?.lastGeocodeAddress === 'string' ? parsed.lastGeocodeAddress : null
        const lgPid = typeof parsed?.lastGeocodePlaceId === 'string' ? parsed.lastGeocodePlaceId : null
        const lgLat = Number(parsed?.lastGeocodeLatitude)
        const lgLng = Number(parsed?.lastGeocodeLongitude)
        const lgFmt = parsed?.lastGeocodeFormatted
        const lgWarnings = Array.isArray(parsed?.lastGeocodeWarnings) ? parsed.lastGeocodeWarnings.filter((x: any) => typeof x === 'string') : []
        if (lgAddr && Number.isFinite(lgLat) && Number.isFinite(lgLng)) {
          // Only restore if it matches the current address + selected place (canonical compare).
          const addrOk = canonicalizeAddress(lgAddr) === canonicalizeAddress(parsedAddress)
          const pidOk = (lgPid || null) === (parsedSelectedPlaceId || null)
          if (addrOk && pidOk) {
            setLastGeocode({
              address: parsedAddress.trim(),
              placeId: parsedSelectedPlaceId || null,
              formatted_address: typeof lgFmt === 'string' ? lgFmt : null,
              latitude: lgLat,
              longitude: lgLng,
              warnings: lgWarnings,
            })
          }
        }

        // Restore last autocomplete suggestions (only if they match current address and nothing is selected yet)
        if (!parsedSelectedPlaceId && typeof parsed?.autocompleteAddress === 'string' && parsed.autocompleteAddress.trim() === parsedAddress.trim()) {
          if (Array.isArray(parsed?.addressSuggestions)) {
            const restored = parsed.addressSuggestions
              .filter((x: any) => x && typeof x === 'object')
              .map((x: any) => ({
                description: String(x.description || ''),
                place_id: String(x.place_id || ''),
                main_text: x.main_text != null ? String(x.main_text) : null,
                secondary_text: x.secondary_text != null ? String(x.secondary_text) : null,
              }))
              .filter((x: any) => x.description && x.place_id)
            if (restored.length) setAddressSuggestions(restored)
          }
        }

        // Restore verified coordinate (tick) if it matches the restored address (canonical compare).
        const verifiedAddressRaw = typeof parsed?.verifiedAddress === 'string' ? parsed.verifiedAddress : null
        if (verifiedAddressRaw && canonicalizeAddress(verifiedAddressRaw) === canonicalizeAddress(parsedAddress)) {
          const lat = Number(parsed?.verifiedCoord?.latitude)
          const lng = Number(parsed?.verifiedCoord?.longitude)
          const formatted = parsed?.verifiedCoord?.formatted_address
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const coord = { latitude: lat, longitude: lng, formatted_address: typeof formatted === 'string' ? formatted : null }
            setVerifiedCoord(coord)
            setLastVerified({
              address: parsedAddress.trim(),
              placeId: parsedSelectedPlaceId,
              coord,
            })
            setLastGeocode({
              address: parsedAddress.trim(),
              placeId: parsedSelectedPlaceId,
              formatted_address: coord.formatted_address || null,
              latitude: lat,
              longitude: lng,
              warnings: [],
            })
          }
        }
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const payload = {
        name,
        address,
        // Autocomplete persistence
        autocompleteAddress: address.trim(),
        addressSuggestions,
        selectedPlaceId,
        selectedPlaceAddress: selectedPlaceId ? address.trim() : null,
        // Verified tick persistence
        verifiedAddress: verifiedCoord ? address.trim() : null,
        verifiedCoord,
        // Last geocode persistence (so backing out of MapVerify doesn't cause re-geocode)
        lastGeocodeAddress: lastGeocode?.address || null,
        lastGeocodePlaceId: lastGeocode?.placeId || null,
        lastGeocodeFormatted: lastGeocode?.formatted_address || null,
        lastGeocodeLatitude: typeof lastGeocode?.latitude === 'number' ? lastGeocode.latitude : null,
        lastGeocodeLongitude: typeof lastGeocode?.longitude === 'number' ? lastGeocode.longitude : null,
        lastGeocodeWarnings: Array.isArray(lastGeocode?.warnings) ? lastGeocode.warnings : [],
        venue,
        scheduleDays,
        startTime,
        endTime,
        agreeTruth,
        localImageUris,
        remoteImageUrls,
      }
      setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, payload, COURT_REGISTER_DRAFT_TTL_MS).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [name, address, addressSuggestions, selectedPlaceId, verifiedCoord, venue, scheduleDays, startTime, endTime, agreeTruth, localImageUris, remoteImageUrls])

  const isValidHHMM = (s: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test((s || '').trim())
  const toMinutes = (s: string) => {
    const [hh, mm] = (s || '00:00').split(':').map(Number)
    return hh * 60 + mm
  }

  const isScheduleValid = useMemo(() => {
    const st = startTime.trim()
    const et = endTime.trim()
    if (!scheduleDays.length) return false
    if (!isValidHHMM(st) || !isValidHHMM(et)) return false
    return toMinutes(st) < toMinutes(et)
  }, [scheduleDays, startTime, endTime])

  const canSubmit = useMemo(() => {
    return (
      !!userid &&
      name.trim().length > 0 &&
      address.trim().length > 0 &&
      !submitting &&
      isScheduleValid &&
      agreeTruth
    )
  }, [userid, name, address, submitting, agreeTruth, isScheduleValid])

  const dedupeStrings = (items: string[]) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const it of items) {
      const v = String(it || '')
      if (!v) continue
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    return out
  }

  const normalizeTimeInput = (raw: string) => {
    const digits = String(raw || '').replace(/\D/g, '').slice(0, 4)
    if (!digits) return ''
    let hh = digits.slice(0, 2)
    let mm = digits.slice(2, 4)

    if (hh.length === 2) {
      const h = Math.min(23, Math.max(0, Number(hh)))
      hh = String(h).padStart(2, '0')
    }
    if (mm.length === 2) {
      const m = Math.min(59, Math.max(0, Number(mm)))
      mm = String(m).padStart(2, '0')
    }

    if (digits.length <= 2) return hh
    return `${hh}:${mm}`
  }



  useEffect(() => {
    const q = address.trim()
    if (q.length < 3) {
      setAddressSuggestions([])
      setAddressLoading(false)
      return
    }
    // If user has selected a suggestion (place id) and doesn't change the field, don't re-search.
    if (selectedPlaceId) {
      setAddressLoading(false)
      return
    }

    // If we already have suggestions for this exact input (e.g. restored from draft cache),
    // don't refetch immediately.
    if (addressSuggestions.length > 0) {
      setAddressLoading(false)
      return
    }

    let cancelled = false
    const t = setTimeout(() => {
      if (!cancelled) setAddressLoading(true)
      autocompleteCourtAddress(q, 5)
        .then((rows) => {
          if (cancelled) return
          setAddressSuggestions(Array.isArray(rows) ? rows : [])
          setAddressLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setAddressSuggestions([])
          setAddressLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(t)
      setAddressLoading(false)
    }
  }, [address, selectedPlaceId, addressSuggestions.length])

  const pickImages = async () => {
    if (imageUploading) return
    if (!userid) {
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
      // Lock crop aspect ratio to match the fixed UI frame.
      // Prevents users from choosing a crop shape that will be re-cropped in our preview.
      aspect: [IMAGE_TILE_WIDTH, IMAGE_TILE_HEIGHT],
      quality: 0.9,
    } as any)

    if (result.canceled) return
    const picked = (result.assets || []).map(a => a.uri).filter(Boolean)
    if (picked.length === 0) return

    // Simplest manual crop: user edits in OS crop UI (allowsEditing).
    // Upload the returned (cropped) image to Cloudinary immediately.
    setImageUploading(true)
    try {
      const uploadedUrl = await uploadOneToCloudinary(picked[0], remoteImageUrls.length)
      setRemoteImageUrls(prev => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
      setLocalImageUris([])
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Please try again')
    } finally {
      setImageUploading(false)
    }
  }

  const pickPlayingCourtImage = async (target: 'full' | 'half1' | 'half2') => {
    if (imageUploading) return
    if (!userid) {
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
    const picked = (result.assets || []).map(a => a.uri).filter(Boolean)
    if (picked.length === 0) return

    setImageUploading(true)
    try {
      if (target === 'full') {
        const uploadedUrl = await uploadOneToCloudinary(picked[0], pcImages.length, 'pc_full')
        setPcImages(prev => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
      } else if (target === 'half1') {
        const uploadedUrl = await uploadOneToCloudinary(picked[0], pcHalf1Images.length, 'pc_half1')
        setPcHalf1Images(prev => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
      } else {
        const uploadedUrl = await uploadOneToCloudinary(picked[0], pcHalf2Images.length, 'pc_half2')
        setPcHalf2Images(prev => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
      }
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Please try again')
    } finally {
      setImageUploading(false)
    }
  }

  const removePlayingCourtImage = (target: 'full' | 'half1' | 'half2', uri: string) => {
    if (target === 'full') setPcImages(prev => prev.filter(u => u !== uri))
    if (target === 'half1') setPcHalf1Images(prev => prev.filter(u => u !== uri))
    if (target === 'half2') setPcHalf2Images(prev => prev.filter(u => u !== uri))
  }

  const pickServiceImage = async () => {
    if (imageUploading) return
    if (!userid) {
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
    const picked = (result.assets || []).map(a => a.uri).filter(Boolean)
    if (picked.length === 0) return

    setImageUploading(true)
    try {
      const uploadedUrl = await uploadOneToCloudinary(picked[0], svcImages.length, 'svc')
      setSvcImages(prev => dedupeStrings([...prev, uploadedUrl]).slice(0, 6))
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Please try again')
    } finally {
      setImageUploading(false)
    }
  }

  const removeServiceImage = (uri: string) => {
    setSvcImages(prev => prev.filter(u => u !== uri))
  }

  const openPlayingCourtModal = () => {
    setPcFullName('')
    setPcFullPrice('')
    setPcAllowHalf(true)
    setPcHalf1Name('')
    setPcHalf1Price('')
    setPcHalf2Name('')
    setPcHalf2Price('')
    setPcDescription('')
    setPcSurface('concrete')
    setPcImages([])
    setPcHalf1Images([])
    setPcHalf2Images([])
    setPcHalfTab('half1')
    setPlayingCourtModalVisible(true)
  }

  const addPlayingCourt = () => {
    const fullName = pcFullName.trim()
    const fullPrice = pcFullPrice.trim()
    if (!fullName) {
      Alert.alert(t('COMMON_ERR_MISSING_INFO'), t('COURT_PANEL_ERR_ENTER_NAME'))
      return
    }
    if (!fullPrice || !Number.isFinite(toNumberFromInput(fullPrice)) || toNumberFromInput(fullPrice) < 0) {
      Alert.alert('Missing info', 'Please enter a valid full court price.')
      return
    }

    let half1Name = pcHalf1Name.trim()
    let half2Name = pcHalf2Name.trim()
    const half1Price = pcHalf1Price.trim()
    const half2Price = pcHalf2Price.trim()

    if (pcAllowHalf) {
      if (!half1Name || !half2Name) {
        Alert.alert('Missing info', 'Please enter Half Court 1 and Half Court 2 names.')
        return
      }
      if (!half1Price || !Number.isFinite(toNumberFromInput(half1Price)) || toNumberFromInput(half1Price) < 0) {
        Alert.alert('Missing info', 'Please enter a valid price for Half Court 1.')
        return
      }
      if (!half2Price || !Number.isFinite(toNumberFromInput(half2Price)) || toNumberFromInput(half2Price) < 0) {
        Alert.alert('Missing info', 'Please enter a valid price for Half Court 2.')
        return
      }
    } else {
      half1Name = ''
      half2Name = ''
    }

    const item: PlayingCourtDraft = {
      fullName,
      fullPrice,
      allowHalfBooking: !!pcAllowHalf,
      half1Name,
      half1Price: pcAllowHalf ? half1Price : '',
      half2Name,
      half2Price: pcAllowHalf ? half2Price : '',
      description: pcDescription.trim(),
      images: pcImages,
      half1Images: pcAllowHalf ? pcHalf1Images : [],
      half2Images: pcAllowHalf ? pcHalf2Images : [],
      surface: pcSurface,
    }
    setPlayingCourts(prev => [...prev, item])
    setPlayingCourtModalVisible(false)
  }

  const openAddService = () => {
    setSvcName('')
    setSvcCategory('consumable')
    setSvcCategoryDropdownOpen(false)
    setSvcPrice('')
    setSvcStock('')
    setSvcImages([])
    setServiceDraftVisible(true)
  }

  const addService = () => {
    const nm = svcName.trim()
    const price = svcPrice.trim()
    const stock = svcStock.trim()
    if (!nm) {
      Alert.alert('Missing info', 'Please enter a service name.')
      return
    }
    if (!price || !Number.isFinite(toNumberFromInput(price)) || toNumberFromInput(price) < 0) {
      Alert.alert('Missing info', 'Please enter a valid service price.')
      return
    }
    if (stock && (!Number.isFinite(Number(stock)) || Number(stock) < 0)) {
      Alert.alert('Missing info', 'Please enter a valid stock (or leave empty).')
      return
    }
    setServices(prev => [
      ...prev,
      {
        name: nm,
        category: svcCategory,
        price,
        stock,
        images: svcImages,
      },
    ])
    setServiceDraftVisible(false)
  }

  const applyCloudinaryDeliveryOptimizations = (secureUrl: string) => {
    // Delivery-time optimizations only (no AI/auto-crop).
    // Example: .../upload/<transformations>/v1234/...jpg
    try {
      const marker = '/upload/'
      const idx = secureUrl.indexOf(marker)
      if (idx < 0) return secureUrl
      const before = secureUrl.slice(0, idx + marker.length)
      const after = secureUrl.slice(idx + marker.length)
      // `c_fill` gives an exact output size; because we lock the aspect ratio in the OS crop UI,
      // this should not do any unexpected cropping.
      const transform = `c_fill,w_${CLOUDINARY_DELIVERY_WIDTH},h_${CLOUDINARY_DELIVERY_HEIGHT},q_auto,f_auto`
      return `${before}${transform}/${after}`
    } catch {
      return secureUrl
    }
  }

  const uploadOneToCloudinary = async (localUri: string, idx: number, prefix: string = 'court') => {
    const resized = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: 800 } }],
      { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG }
    )

  const publicId = `${prefix}_${userid}_${Date.now()}_${idx}`
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
  }

  const handleVerifyLocation = async () => {
    const a = address.trim()
    if (!a) {
      setVerifyError(t('COURT_PANEL_ERR_FILL_ADDRESS'))
      return
    }

    // Fast-path: if user already verified (or restored) coords, reopen map instantly.
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

    // Fast-path: if user previously opened map for the same address/placeId and just backed out,
    // don't re-geocode; reuse the cached lat/lng.
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

    setChecking(true)
    setWarnings([])
    setVerifiedCoord(null)
    setVerifyError(null)
    try {
      const geo = selectedPlaceId ? await geocodeCourtPlaceId(selectedPlaceId) : await geocodeCourtAddress(a)
      const w = (geo?.warnings || []).filter(Boolean)
      setWarnings(w)

      // Cache this geocode so subsequent Verify taps reopen the map instantly.
      const lg = {
        address: a,
        placeId: selectedPlaceId,
        formatted_address: geo?.formatted_address || null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        warnings: w,
      }
      setLastGeocode(lg)

      // Persist it immediately (no debounce) so leaving/re-entering doesn't re-geocode.
      try {
        const existingDraft: any = await getCache<any>(COURT_REGISTER_DRAFT_STORAGE_KEY)
        const mergedDraft = {
          ...(existingDraft && typeof existingDraft === 'object' ? existingDraft : {}),
          address: a,
          selectedPlaceId: selectedPlaceId,
          selectedPlaceAddress: selectedPlaceId ? a : null,
          lastGeocodeAddress: lg.address,
          lastGeocodePlaceId: lg.placeId,
          lastGeocodeFormatted: lg.formatted_address,
          lastGeocodeLatitude: lg.latitude,
          lastGeocodeLongitude: lg.longitude,
          lastGeocodeWarnings: lg.warnings || [],
        }
        await setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, mergedDraft, COURT_REGISTER_DRAFT_TTL_MS)
      } catch {}

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
      Alert.alert('Geocode failed', e?.message || 'Please try again')
    } finally {
      setChecking(false)
    }
  }

  const toggleServiceExpanded = (idx: number) => {
    setExpandedServiceIdxs(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (!userid) {
      Alert.alert('Not signed in', 'Please sign in first.')
      return
    }
    const nm = name.trim()
    const addr = address.trim()
    if (!nm || !addr) {
      Alert.alert(t('COMMON_ERR_MISSING_INFO'), t('COURT_PANEL_ERR_FILL_NAME_ADDR'))
      return
    }

    // Ensure the full procedure is complete before starting any Cloudinary upload.
    if (!verifiedCoord) {
      setVerifyError(t('COURT_PANEL_ERR_VERIFY_LOC_FIRST'))
      return
    }
    if (!isScheduleValid) {
      Alert.alert(t('COURT_REGISTER_ERR_INVALID_SCHEDULE'), t('COURT_REGISTER_ERR_INVALID_SCHEDULE_MSG'))
      return
    }
    if (!agreeTruth) {
      Alert.alert(t('COURT_REGISTER_ERR_AGREE_TRUTH'), t('COURT_REGISTER_ERR_AGREE_TRUTH_MSG'))
      return
    }

    if (playingCourts.length === 0) {
      Alert.alert('Court required', 'Please add at least one court in the ?Court? section.')
      return
    }

    setSubmitting(true)
    // Persist in-flight state immediately so leaving/re-entering keeps the button in "Registering?".
    try {
      const existingDraft: any = await getCache<any>(COURT_REGISTER_DRAFT_STORAGE_KEY)
      const mergedDraft = {
        ...(existingDraft && typeof existingDraft === 'object' ? existingDraft : {}),
        registerInFlight: true,
        registerInFlightStartedAt: Date.now(),
      }
      await setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, mergedDraft, COURT_REGISTER_DRAFT_TTL_MS)
    } catch {}
    setWarnings([])
    try {
      const urls: string[] = remoteImageUrls

      const payload: CourtRegisterRequest = {
        name: nm,
        address: addr,
        ownerid: userid,
        venue,
        images: urls,
        allow_half_court: playingCourts.some(pc => pc.allowHalfBooking),
        playing_courts: playingCourts.map(pc => ({
          name: pc.fullName,
          full_price: toNumberFromInput(pc.fullPrice),
          allow_half_booking: pc.allowHalfBooking,
          half_a_name: pc.allowHalfBooking ? pc.half1Name : undefined,
          half_b_name: pc.allowHalfBooking ? pc.half2Name : undefined,
          half_a_price: pc.allowHalfBooking ? toNumberFromInput(pc.half1Price) : undefined,
          half_b_price: pc.allowHalfBooking ? toNumberFromInput(pc.half2Price) : undefined,
          description: pc.description || undefined,
          images: pc.images,
          half_a_images: pc.allowHalfBooking ? pc.half1Images : undefined,
          half_b_images: pc.allowHalfBooking ? pc.half2Images : undefined,
          surface: pc.surface || undefined,
        })),
        services: services.map(s => ({
          name: s.name,
          category: s.category,
          price: toNumberFromInput(s.price),
          stock: s.stock ? Number(s.stock) : 0,
          images: Array.isArray(s.images) ? s.images : [],
        })),
        schedule: {
          booking_date: scheduleDays,
          start_time: startTime.trim(),
          end_time: endTime.trim(),
        },
        // Verified location from map picker
        latitude: verifiedCoord?.latitude,
        longitude: verifiedCoord?.longitude,
        accuracy_type: verifiedCoord ? 'user_selected' : 'default',
      }

      const resp = await registerCourt(payload)
      const w = (resp?.geocode?.warnings || []).filter(Boolean)
      setWarnings(w)

      // Fetch ONLY the newly created court and merge into cache so Map/Court List/etc. update immediately
      // without refetching the full court list.
      if (resp?.courtid != null) {
        try {
          const existingCourtInfo = await getCache<any>('cache:courtinfo:v1')
          const hasExistingList = Array.isArray(existingCourtInfo) && existingCourtInfo.length > 0
          if (!hasExistingList) {
            await invalidateCache('cache:courtinfo:v1').catch(() => {})
          } else {
            const newInfo = await getCourtInfoByCourtId(resp.courtid)
            if (newInfo) await upsertCourtInfoIntoCache(newInfo)
            else await invalidateCache('cache:courtinfo:v1').catch(() => {})
          }
        } catch {
          await invalidateCache('cache:courtinfo:v1').catch(() => {})
        }
      } else {
        await invalidateCache('cache:courtinfo:v1').catch(() => {})
      }

      await invalidateCache(COURT_REGISTER_DRAFT_STORAGE_KEY).catch(() => {})
      setSubmittedVisible(true)
    } catch (e: any) {
      Alert.alert('Register failed', e?.message || 'Please try again')
      // Clear in-flight flag so the UI doesn't get stuck.
      try {
        const existingDraft: any = await getCache<any>(COURT_REGISTER_DRAFT_STORAGE_KEY)
        const mergedDraft = {
          ...(existingDraft && typeof existingDraft === 'object' ? existingDraft : {}),
          registerInFlight: false,
          registerInFlightStartedAt: null,
        }
        await setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, mergedDraft, COURT_REGISTER_DRAFT_TTL_MS)
      } catch {}
    } finally {
      if (isMountedRef.current) setSubmitting(false)
    }
  }

  const handlePressRegister = () => {
    if (submitting) return
    if (!userid) {
      Alert.alert('Not signed in', 'Please sign in first.')
      return
    }
    if (!name.trim() || !address.trim()) {
      Alert.alert(t('COMMON_ERR_MISSING_INFO'), t('COURT_PANEL_ERR_FILL_NAME_ADDR'))
      return
    }
    if (!verifiedCoord) {
      setVerifyError(t('COURT_PANEL_ERR_VERIFY_LOC_FIRST'))
      return
    }
    if (!isScheduleValid) {
      Alert.alert(t('COURT_REGISTER_ERR_INVALID_SCHEDULE'), t('COURT_REGISTER_ERR_INVALID_SCHEDULE_MSG'))
      return
    }
    if (!agreeTruth) {
      Alert.alert(t('COURT_REGISTER_ERR_AGREE_TRUTH'), t('COURT_REGISTER_ERR_AGREE_TRUTH_MSG'))
      return
    }
    setConfirmVisible(true)
  }

  const removeLocalImage = (uri: string) => {
    setRemoteImageUrls(prev => prev.filter(u => u !== uri))
  }

  const requestRemoveImage = (uri: string) => {
    setRemoveImageCandidateUri(uri)
    setRemoveImageConfirmVisible(true)
  }

  const onConfirmRemoveImage = () => {
    if (removeImageCandidateUri) removeLocalImage(removeImageCandidateUri)
    setRemoveImageConfirmVisible(false)
    setRemoveImageCandidateUri(null)
  }


  return (
    <View style={[styles.screen, { backgroundColor: tc.bgBase }]}>
      <SafeAreaView edges={['top']} />
      <View style={[styles.headerRow, { borderBottomColor: tc.divider }]}>
        <TouchableOpacity style={[styles.backBtn, { backgroundColor: tc.bgElevated }]} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={[styles.backIcon, { tintColor: tc.textPrimary }]} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>{t('COURT_REGISTER_TITLE')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={[styles.page, { backgroundColor: tc.bgBase }]} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

      {/* -- Venue Info ---------------------------------- */}
      <StepHeader step={1} title={t('COURT_REGISTER_SECTION_INFO')} />
      <View style={[styles.card, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]}>
      <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>{t('COURT_PANEL_LABEL_COURT_NAME')}</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={t('COURT_REGISTER_PLACEHOLDER_NAME')}
        placeholderTextColor={tc.placeholder}
        style={[styles.input, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }]}
      />
      <View style={[styles.cardDivider, { backgroundColor: tc.divider }]} />
      <Text style={[styles.fieldLabel, { color: tc.textSecondary }]}>{t('COMMON_LABEL_ADDRESS')}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={address}
          onChangeText={(v) => {
            setAddress(v)

            // If user types back exactly the same address they previously verified,
            // restore the verified tick/coords without forcing them to re-verify.
            const nextTrimmed = v.trim()
            if (lastVerified && nextTrimmed && nextTrimmed === lastVerified.address) {
              setSelectedPlaceId(lastVerified.placeId)
              setVerifiedCoord(lastVerified.coord)
              setVerifyError(null)
              // Ensure subsequent Verify taps reuse the already-known coordinates.
              setLastGeocode({
                address: nextTrimmed,
                placeId: lastVerified.placeId,
                formatted_address: lastVerified.coord.formatted_address || null,
                latitude: lastVerified.coord.latitude,
                longitude: lastVerified.coord.longitude,
                warnings: [],
              })
              if (addressSuggestions.length) setAddressSuggestions([])
              return
            }

            // Any change away from the last verified address invalidates verification.
            setSelectedPlaceId(null)
            if (lastGeocode) setLastGeocode(null)
            if (addressSuggestions.length) setAddressSuggestions([])
            if (verifiedCoord) setVerifiedCoord(null)
            if (verifyError) setVerifyError(null)
          }}
          placeholder={t('COURT_REGISTER_PLACEHOLDER_ADDRESS')}
          placeholderTextColor={tc.placeholder}
          style={[styles.input, styles.inputWithIcon, { backgroundColor: tc.bgSurface, borderColor: tc.divider, color: tc.textPrimary }, verifyError && styles.inputError, { minHeight: 44 }]}
        />
        {!!verifiedCoord ? (
          <Image source={ICONS.tick} style={styles.verifiedTickInInput} />
        ) : addressLoading ? (
          <ActivityIndicator size="small" color={COLORS.neutral600} style={styles.addressSpinnerInInput} />
        ) : null}
      </View>

      {addressSuggestions.length > 0 && !verifiedCoord && (
        <View style={styles.suggestBox}>
          {addressSuggestions.map((s, i) => (
            <TouchableOpacity
              key={s.place_id}
              activeOpacity={0.85}
              style={[styles.suggestItem, i === addressSuggestions.length - 1 && styles.suggestItemLast]}
              onPress={() => {
                setAddress(s.description)
                setSelectedPlaceId(s.place_id)
                setAddressSuggestions([])
                setAddressLoading(false)
                if (lastGeocode) setLastGeocode(null)
                if (verifiedCoord) setVerifiedCoord(null)
                if (verifyError) setVerifyError(null)
              }}
            >
              <Text style={styles.suggestText} numberOfLines={2}>
                {s.description}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {!!verifyError && <Text style={styles.verifyErrorText}>{verifyError}</Text>}
      <TouchableOpacity
        onPress={handleVerifyLocation}
        disabled={checking || submitting || (!selectedPlaceId && !verifiedCoord)}
        style={[styles.verifyFullBtn, { backgroundColor: tc.brand }, verifiedCoord ? styles.verifyBtnVerified : (checking || submitting || (!selectedPlaceId && !verifiedCoord)) ? styles.btnDisabled : null]}
        activeOpacity={0.85}
      >
        <Text style={styles.verifyFullBtnText}>
          {checking ? t('COURT_REGISTER_VERIFYING') : t('COURT_PANEL_BTN_VERIFY')}
        </Text>
      </TouchableOpacity>
      </View>

      {/* -- Venue Type ------------------------------- */}
      <StepHeader step={2} title={t('COURT_REGISTER_LABEL_VENUE_TYPE')} />
      <View style={[styles.card, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]}>
      <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
        {(['Indoor', 'Outdoor', 'Both'] as Venue[]).map((v) => {
          const active = venue === v
          return (
            <TouchableOpacity
              key={v}
              onPress={() => setVenue(v)}
              style={[styles.segment, { backgroundColor: tc.bgSurface }, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>
                {v === 'Indoor' ? t('MAP_LABEL_INDOOR') : v === 'Outdoor' ? t('MAP_LABEL_OUTDOOR') : t('COURT_PANEL_VENUE_BOTH')}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>

      </View>

      {/* -- Courts ------------------------------------ */}
      <StepHeader step={3} title={t('COURT_REGISTER_LABEL_COURT_SECTION')} />
      <View style={[styles.card, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]}>
      <ScrollView
      >
        {playingCourts.map((pc, idx) => {
          const expanded = expandedCourtIdxs.has(idx)
          return (
            <View key={`${pc.fullName}-${idx}`} style={[styles.courtCard, { backgroundColor: tc.bgSurface, borderLeftColor: tc.brand, borderColor: tc.divider, shadowColor: tc.shadow }, expanded && styles.courtCardExpanded]}>
              <TouchableOpacity
                onPress={() => toggleCourtExpanded(idx)}
                activeOpacity={0.85}
                style={styles.courtCardHeader}
              >
                <Text style={[styles.myCourtName, { color: tc.textPrimary }]} numberOfLines={1}>{pc.fullName}</Text>
                <Image
                  source={ICONS.arrowdown}
                  style={[styles.courtCardArrow, expanded && styles.courtCardArrowOpen]}
                />
              </TouchableOpacity>

              <Text style={[styles.myCourtMeta, { color: tc.textSecondary }]}>{`${t('COURT_REGISTER_FULL_PRICE_PREFIX')}${formatVnd(pc.fullPrice)}`}</Text>
              <Text style={[styles.myCourtMeta, { color: tc.textSecondary }]}>{pc.allowHalfBooking ? t('COURT_REGISTER_HALF_BOOKING_ON') : t('COURT_REGISTER_HALF_BOOKING_OFF')}</Text>

              {expanded && (
                <View style={styles.courtCardBody}>
                  <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_SURFACE_PREFIX')}${pc.surface || 'concrete'}`}</Text>
                  {pc.allowHalfBooking ? (
                    <>
                      <Text style={styles.courtDetailLine}>{`Half Court 1: ${pc.half1Name || 'Half Court 1'} · ${formatVnd(pc.half1Price)}`}</Text>
                      <Text style={styles.courtDetailLine}>{`Half Court 2: ${pc.half2Name || 'Half Court 2'} · ${formatVnd(pc.half2Price)}`}</Text>
                    </>
                  ) : null}
                  <Text style={[styles.courtDetailLabel, { color: tc.textSecondary }]}>Description:</Text>
                  <Text style={[styles.courtDetailDesc, { color: tc.textSecondary }]} numberOfLines={4}>
                    {(pc.description || '').trim() ? pc.description : t('COURT_REGISTER_NO_DESCRIPTION')}
                  </Text>
                  <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_FULL_COURT_IMAGES_PREFIX')}${Array.isArray(pc.images) ? pc.images.length : 0}`}</Text>
                  {pc.allowHalfBooking ? (
                    <>
                      <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_HALF1_IMAGES_PREFIX')}${Array.isArray(pc.half1Images) ? pc.half1Images.length : 0}`}</Text>
                      <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_HALF2_IMAGES_PREFIX')}${Array.isArray(pc.half2Images) ? pc.half2Images.length : 0}`}</Text>
                    </>
                  ) : null}
                </View>
              )}
            </View>
          )
        })}

        <View style={[styles.coverFrame, coverFrameDynamic, styles.addCourtCover, { borderColor: tc.brand }, (submitting || imageUploading) && styles.btnDisabled]}>
          <TouchableOpacity
            onPress={openPlayingCourtModal}
            disabled={submitting || imageUploading}
            activeOpacity={0.85}
            style={styles.coverPressable}
          >
            <Text style={styles.addPlus}>+</Text>
            <Text style={[styles.addCourtCoverText, { color: tc.brand }]}>{t('COURT_REGISTER_BTN_ADD_COURT')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
      </View>

      {/* -- Services --------------------------------- */}
      <TouchableOpacity
        onPress={() => setServicesExpanded(v => !v)}
        activeOpacity={0.85}
        style={styles.sectionAccordion}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={[stepStyles.badge, { backgroundColor: tc.brand }]}>
            <Text style={stepStyles.badgeText}>4</Text>
          </View>
          <Text style={[styles.sectionAccordionLabel, { color: tc.textSecondary }]}>{t('COURT_REGISTER_LABEL_SERVICES')}</Text>
        </View>
        <Image
          source={ICONS.arrowdown}
          style={[styles.servicesArrow, servicesExpanded && styles.servicesArrowOpen]}
        />
      </TouchableOpacity>

      {servicesExpanded && (
        <View style={[styles.card, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]}>
          {services.length === 0 ? (
            <Text style={[styles.servicesHint, { color: tc.textSecondary }]}>{t('COURT_REGISTER_NO_SERVICES')}</Text>
          ) : null}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.servicesCardsRow}
          >
            {services.map((s, idx) => {
              const expanded = expandedServiceIdxs.has(idx)
              return (
                <View key={`${s.name}-${idx}`} style={[styles.serviceCard, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, expanded && styles.serviceCardExpanded]}>
                  <TouchableOpacity
                    onPress={() => toggleServiceExpanded(idx)}
                    activeOpacity={0.85}
                    style={styles.serviceCardHeader}
                  >
                    <Text style={[styles.servicesName, { color: tc.textPrimary }]} numberOfLines={1}>{s.name}</Text>
                    <Image
                      source={ICONS.arrowdown}
                      style={[styles.courtCardArrow, expanded && styles.courtCardArrowOpen]}
                    />
                  </TouchableOpacity>

                  <Text style={[styles.servicesMeta, { color: tc.textSecondary }]}>{`${s.category} � ${formatVnd(s.price)}`}</Text>

                  {expanded && (
                    <View style={styles.serviceCardBody}>
                  <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_STOCK_PREFIX')}${s.stock ? Number(s.stock) || 0 : 0}`}</Text>
                      <Text style={styles.courtDetailLine}>{`${t('COURT_REGISTER_IMAGES_COUNT_PREFIX')}${Array.isArray(s.images) ? s.images.length : 0}`}</Text>
                      {Array.isArray(s.images) && s.images.length > 0 ? (
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={styles.thumbsRow}
                        >
                          {s.images.map((uri) => (
                            <View key={uri} style={styles.thumbFrame}>
                              <ExpoImage source={{ uri }} style={styles.thumbImage} contentFit="cover" />
                            </View>
                          ))}
                        </ScrollView>
                      ) : null}
                    </View>
                  )}
                </View>
              )
            })}

            <View style={[styles.coverFrame, coverFrameDynamic, styles.addServiceCover, submitting && styles.btnDisabled]}>
              <TouchableOpacity
                onPress={openAddService}
                disabled={submitting}
                activeOpacity={0.85}
                style={styles.coverPressable}
              >
                <Text style={styles.addCourtCoverText}>{t('COURT_REGISTER_BTN_ADD_SERVICE')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {serviceDraftVisible && (
            <View style={styles.serviceDraftInline}>
                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_SVC_NAME')}</Text>
                <TextInput value={svcName} onChangeText={setSvcName} placeholder="Water" placeholderTextColor={tc.brand} style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]} />

                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_CATEGORY')}</Text>
                <TouchableOpacity
                  onPress={() => setSvcCategoryDropdownOpen(v => !v)}
                  activeOpacity={0.85}
                  style={[styles.dropdownBtn, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
                >
                  <Text style={[styles.dropdownBtnText, { color: tc.textPrimary }]}>{svcCategory}</Text>
                  <Image
                    source={ICONS.arrowdown}
                    style={[styles.dropdownArrow, svcCategoryDropdownOpen && styles.dropdownArrowOpen]}
                  />
                </TouchableOpacity>

                <Modal
                  visible={svcCategoryDropdownOpen}
                  transparent
                  animationType="fade"
                  onRequestClose={() => setSvcCategoryDropdownOpen(false)}
                >
                  <Pressable style={styles.dropdownOverlay} onPress={() => setSvcCategoryDropdownOpen(false)} />
                  <View style={styles.dropdownModalContainer}>
                    <View style={[styles.dropdownModal, { backgroundColor: tc.bgElevated, borderColor: tc.divider }]}>
                      {(['consumable', 'rental'] as const).map(opt => {
                        const selected = svcCategory === opt
                        return (
                          <TouchableOpacity
                            key={opt}
                            onPress={() => {
                              setSvcCategory(opt)
                              setSvcCategoryDropdownOpen(false)
                            }}
                            activeOpacity={0.85}
                            style={styles.dropdownModalItem}
                          >
                            <Text style={styles.dropdownItemText}>{opt === 'consumable' ? t('COURT_PANEL_CATEGORY_CONSUMABLE') : t('COURT_PANEL_CATEGORY_RENTAL')}</Text>
                            <Image source={selected ? ICONS.tick : ''} style={styles.dropdownCheck} />
                          </TouchableOpacity>
                        )
                      })}
                    </View>
                  </View>
                </Modal>

                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_PRICE')}</Text>
                <View style={styles.priceInputWrap}>
                  <TextInput
                    value={svcPrice}
                    onChangeText={(v) => setSvcPrice(formatThousandGroups(v))}
                    placeholder="0"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    placeholderTextColor={tc.placeholder}
                    style={[styles.input, styles.inputWithSuffix, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                  />
                  <Text style={styles.suffixInInput}>đ</Text>
                </View>

                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_STOCK')}</Text>
                <TextInput
                  value={svcStock}
                  onChangeText={setSvcStock}
                  placeholder="0"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  placeholderTextColor={tc.placeholder}
                  style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                />

                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_IMAGES_OPT')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                  {svcImages.map((uri) => (
                    <View key={uri} style={[styles.coverFrame, coverFrameDynamic]}>
                      <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                        <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeServiceImage(uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                        <Text style={styles.removeXText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                  {svcImages.length < 6 && (
                    <View style={[styles.coverFrame, coverFrameDynamic]}>
                      <TouchableOpacity
                        onPress={pickServiceImage}
                        disabled={imageUploading}
                        activeOpacity={0.85}
                        style={styles.coverPressable}
                      >
                        <Text style={styles.addPlus}>+</Text>
                        <Text style={styles.coverHint}>{imageUploading ? t('COURT_REGISTER_UPLOADING') : t('COURT_REGISTER_ADD_IMAGE')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </ScrollView>

                <View style={styles.serviceDraftBtnsRow}>
                  <TouchableOpacity
                    onPress={() => setServiceDraftVisible(false)}
                    style={[styles.modalBtn, styles.modalCancel, { backgroundColor: tc.bgSurface }]}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.modalBtnText, { color: tc.textPrimary }]}>{t('COMMON_BTN_CLOSE')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={addService}
                    style={[styles.modalBtn, styles.modalConfirm, { backgroundColor: tc.brand }]}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.modalBtnText}>{t('COURT_REGISTER_BTN_SUBMIT')}</Text>
                  </TouchableOpacity>
                </View>
            </View>
          )}
        </View>
      )}

      {/* -- Images ----------------------------------- */}
      <StepHeader step={5} title={t('COURT_REGISTER_LABEL_IMAGES')} />
      <View style={[styles.card, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.imagesRow}
      >
        {remoteImageUrls.map((uri) => (
          <View key={uri} style={[styles.coverFrame, coverFrameDynamic, (submitting || imageUploading) && styles.btnDisabled]}>
            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => requestRemoveImage(uri)}
              style={styles.removeXBtn}
              activeOpacity={0.85}
            >
              <Text style={styles.removeXText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}

        {remoteImageUrls.length < 6 && (
          <View style={[styles.coverFrame, coverFrameDynamic, (submitting || imageUploading) && styles.btnDisabled]}>
            <TouchableOpacity
              onPress={pickImages}
              disabled={submitting || imageUploading}
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
      </View>

      <Modal
        visible={playingCourtModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPlayingCourtModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCardTall, { backgroundColor: tc.bgElevated }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, styles.modalTitleCentered, { color: tc.textPrimary }]}>{t('COURT_REGISTER_BTN_ADD_COURT')}</Text>
              <TouchableOpacity
                onPress={() => setPlayingCourtModalVisible(false)}
                style={[styles.modalCloseXBtn, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}
                activeOpacity={0.85}
              >
                <Text style={[styles.modalCloseXText, { color: tc.textPrimary }]}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalScrollContent}>
              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_PANEL_LABEL_COURT_NAME')}</Text>
              <TextInput
                value={pcFullName}
                onChangeText={setPcFullName}
                placeholder={t('COURT_REGISTER_PLACEHOLDER_COURT_NAME')}
                placeholderTextColor={tc.placeholder}
                style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
              />

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_PRICE')}</Text>
              <View style={styles.priceInputWrap}>
                <TextInput
                  value={pcFullPrice}
                  onChangeText={(v) => setPcFullPrice(formatThousandGroups(v))}
                  placeholder="0"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  placeholderTextColor={tc.placeholder}
                  style={[styles.input, styles.inputWithSuffix, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                />
                <Text style={styles.suffixInInput}>đ</Text>
              </View>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_SCHEDULE')}</Text>
              <View style={styles.weekRow}>
                {WEEK_DAYS.map((label) => {
                  const active = scheduleDays.includes(label)
                  return (
                    <TouchableOpacity
                      key={label}
                      onPress={() => {
                        setScheduleDays(prev => (prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]))
                      }}
                      style={[styles.dayCell, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, active && [styles.dayCellSelected, { backgroundColor: tc.brandSoft, borderColor: tc.brand }]]}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.dayLabel, { color: tc.textPrimary }, active && [styles.dayLabelSelected, { color: tc.brand }]]}>{t(WEEKDAY_TRANSLATION_KEYS[label])}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <View style={styles.timeRow}>
                <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_START_TIME')}</Text>
                  <TextInput
                    value={startTime}
                    onChangeText={(v) => setStartTime(normalizeTimeInput(v))}
                    placeholder="08:00"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={5}
                    placeholderTextColor={tc.placeholder}
                    style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                  />
                </View>
                <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_END_TIME')}</Text>
                  <TextInput
                    value={endTime}
                    onChangeText={(v) => setEndTime(normalizeTimeInput(v))}
                    placeholder="22:00"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={5}
                    placeholderTextColor={tc.placeholder}
                    style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                  />
                </View>
              </View>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_IMAGES')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                {pcImages.map((uri) => (
                  <View key={uri} style={[styles.coverFrame, coverFrameModalDynamic]}>
                    <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                      <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removePlayingCourtImage('full', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                      <Text style={styles.removeXText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                {pcImages.length < 6 && (
                  <View style={[styles.coverFrame, coverFrameModalDynamic]}>
                    <TouchableOpacity
                      onPress={() => pickPlayingCourtImage('full')}
                      disabled={imageUploading}
                      activeOpacity={0.85}
                      style={styles.coverPressable}
                    >
                      <Text style={styles.addPlus}>+</Text>
                      <Text style={styles.coverHint}>{imageUploading ? t('COURT_REGISTER_UPLOADING') : t('COURT_REGISTER_ADD_IMAGE')}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_ALLOW_HALF')}</Text>
              <View style={[styles.segmented, { borderColor: tc.divider, backgroundColor: tc.bgSurface }]}>
                {([
                  { label: t('COURT_REGISTER_LABEL_YES'), value: true as const },
                  { label: t('COURT_REGISTER_LABEL_NO'), value: false as const },
                ] as const).map(opt => {
                  const active = pcAllowHalf === opt.value
                  return (
                    <TouchableOpacity
                      key={opt.label}
                      onPress={() => setPcAllowHalf(opt.value)}
                      style={[styles.segment, { backgroundColor: tc.bgSurface }, active && [styles.segmentActive, { backgroundColor: tc.brandSoft }]]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.segmentText, { color: tc.textPrimary }, active && [styles.segmentTextActive, { color: tc.brand }]]}>{opt.label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              {pcAllowHalf && (
                <>
                  <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_CHOOSE_HALF')}</Text>
                  <View style={styles.halfTabsRow}>
                    <TouchableOpacity
                      onPress={() => setPcHalfTab('half1')}
                      activeOpacity={0.85}
                      style={[styles.halfTab, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, pcHalfTab === 'half1' && [styles.halfTabActive, { backgroundColor: tc.brand, borderColor: tc.brand }]]}
                    >
                      <Text style={[styles.halfTabText, { color: tc.textPrimary }, pcHalfTab === 'half1' && [styles.halfTabTextActive, { color: tc.btnPrimaryText }]]}>{t('COURT_REGISTER_LABEL_HALF1')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setPcHalfTab('half2')}
                      activeOpacity={0.85}
                      style={[styles.halfTab, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, pcHalfTab === 'half2' && [styles.halfTabActive, { backgroundColor: tc.brand, borderColor: tc.brand }]]}
                    >
                      <Text style={[styles.halfTabText, { color: tc.textPrimary }, pcHalfTab === 'half2' && [styles.halfTabTextActive, { color: tc.btnPrimaryText }]]}>{t('COURT_REGISTER_LABEL_HALF2')}</Text>
                    </TouchableOpacity>
                  </View>

                  {pcHalfTab === 'half1' ? (
                    <>
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_NAME')}</Text>
                      <TextInput
                        value={pcHalf1Name}
                        onChangeText={setPcHalf1Name}
                        placeholder={t('COURT_REGISTER_LABEL_NAME')}
                        style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                      />
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_PRICE')}</Text>
                      <View style={styles.priceInputWrap}>
                        <TextInput
                          value={pcHalf1Price}
                          onChangeText={(v) => setPcHalf1Price(formatThousandGroups(v))}
                          placeholder="0"
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, styles.inputWithSuffix, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                        />
                        <Text style={styles.suffixInInput}>đ</Text>
                      </View>

                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_IMAGES')}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                        {pcHalf1Images.map((uri) => (
                          <View key={uri} style={[styles.coverFrame, coverFrameModalDynamic]}>
                            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => removePlayingCourtImage('half1', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                              <Text style={styles.removeXText}>✕</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                        {pcHalf1Images.length < 6 && (
                          <View style={[styles.coverFrame, coverFrameModalDynamic]}>
                            <TouchableOpacity
                              onPress={() => pickPlayingCourtImage('half1')}
                              disabled={imageUploading}
                              activeOpacity={0.85}
                              style={styles.coverPressable}
                            >
                              <Text style={styles.addPlus}>+</Text>
                              <Text style={styles.coverHint}>{imageUploading ? t('COURT_REGISTER_UPLOADING') : t('COURT_REGISTER_ADD_IMAGE')}</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </ScrollView>
                    </>
                  ) : (
                    <>
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_NAME')}</Text>
                      <TextInput
                        value={pcHalf2Name}
                        onChangeText={setPcHalf2Name}
                        placeholder={t('COURT_REGISTER_LABEL_NAME')}
                        style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                      />
                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_PRICE')}</Text>
                      <View style={styles.priceInputWrap}>
                        <TextInput
                          value={pcHalf2Price}
                          onChangeText={(v) => setPcHalf2Price(formatThousandGroups(v))}
                          placeholder="0"
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, styles.inputWithSuffix, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary }]}
                        />
                        <Text style={styles.suffixInInput}>đ</Text>
                      </View>

                      <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_IMAGES')}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                        {pcHalf2Images.map((uri) => (
                          <View key={uri} style={[styles.coverFrame, coverFrameModalDynamic]}>
                            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => removePlayingCourtImage('half2', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                              <Text style={styles.removeXText}>✕</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                        {pcHalf2Images.length < 6 && (
                          <View style={[styles.coverFrame, coverFrameModalDynamic]}>
                            <TouchableOpacity
                              onPress={() => pickPlayingCourtImage('half2')}
                              disabled={imageUploading}
                              activeOpacity={0.85}
                              style={styles.coverPressable}
                            >
                              <Text style={styles.addPlus}>+</Text>
                              <Text style={styles.coverHint}>{imageUploading ? t('COURT_REGISTER_UPLOADING') : t('COURT_REGISTER_ADD_IMAGE')}</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </ScrollView>
                    </>
                  )}
                </>
              )}

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_SURFACE')}</Text>
              <View style={styles.surfaceWrap}>
                {(['hardwood', 'concrete', 'synthetic'] as const).map(s => {
                  const active = pcSurface === s
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setPcSurface(s)}
                      style={[styles.surfacePill, { backgroundColor: tc.bgSurface, borderColor: tc.divider }, active && { backgroundColor: tc.brandSoft, borderColor: tc.brand }]}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.surfacePillText, { color: tc.textPrimary }, active && { color: tc.brand }]}>{t(('COURT_SURFACE_' + s.toUpperCase()) as any)}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <Text style={[styles.label, { color: tc.textPrimary }]}>{t('COURT_REGISTER_LABEL_DESC_OPT')}</Text>
              <TextInput
                value={pcDescription}
                onChangeText={setPcDescription}
                placeholder={t('COURT_REGISTER_PLACEHOLDER_DESCRIPTION')}
                style={[styles.input, { backgroundColor: tc.bgInput, borderColor: tc.divider, color: tc.textPrimary, minHeight: 80, textAlignVertical: 'top' }]}
                multiline
              />

              

              <TouchableOpacity
                onPress={addPlayingCourt}
                style={[styles.submitBtn, { alignSelf: 'center', marginTop: 16, backgroundColor: tc.brand }]}
                activeOpacity={0.85}
              >
                <Text style={styles.submitText}>{t('COURT_REGISTER_BTN_SUBMIT')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <TouchableOpacity
        style={styles.truthRow}
        activeOpacity={0.85}
        onPress={() => setAgreeTruth(v => !v)}
      >
        <View style={[styles.checkboxBox, agreeTruth && styles.checkboxBoxChecked]}>
          {agreeTruth && <ExpoImage source={ICONS.checkSmall} style={styles.checkboxTick} contentFit="contain" />}
        </View>
        <Text style={[styles.checkboxLabel, { color: tc.textPrimary }]}>
          {t('COURT_REGISTER_AGREE_TRUTH1')}<Text style={styles.truthBold}>{t('COURT_REGISTER_AGREE_TRUTH_BOLD')}</Text>.
        </Text>
      </TouchableOpacity>

      {warnings.length > 0 && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>{t('COURT_REGISTER_WARNINGS_TITLE')}</Text>
          {warnings.map((w, i) => (
            <Text key={`${w}-${i}`} style={styles.warningText}>{w}</Text>
          ))}
        </View>
      )}

      {!userid && (
        <Text style={[styles.helpText, { color: tc.textSecondary }]}>{t('COURT_REGISTER_SIGN_IN_REQUIRED')}</Text>
      )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Fixed bottom submit bar (matches booking screens) */}
      <SafeAreaView edges={['bottom']} style={[styles.bottomSafeArea, { backgroundColor: tc.bgBase }]}>
        <View style={[styles.bottomBar, { backgroundColor: tc.bgBase, borderTopColor: tc.divider }]}>
          <View style={styles.bottomSummaryRow}>
            <Text style={[styles.bottomSummaryText, { color: tc.textSecondary }]}>
              {playingCourts.length} {t('COURT_REGISTER_UNIT_COURTS')} ◆ {remoteImageUrls.length} {t('COURT_REGISTER_UNIT_IMAGES')} ◆ {services.length} {t('COURT_REGISTER_UNIT_SERVICES')}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handlePressRegister}
            disabled={!canSubmit}
            style={[styles.submitBtn, { backgroundColor: tc.brand }, !canSubmit && styles.btnDisabled]}
            activeOpacity={0.85}
          >
            <Text style={styles.submitText}>{submitting ? t('COURT_REGISTER_REGISTERING') : t('COURT_REGISTER_BTN_REGISTER')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('COURT_REGISTER_CONFIRM_TITLE')}</Text>
            <Text style={[styles.modalBody, { color: tc.textSecondary }]}>{t('COURT_REGISTER_CONFIRM_BODY')}</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel, { backgroundColor: tc.bgSurface }]} onPress={() => setConfirmVisible(false)}>
                <Text style={[styles.modalBtnText, { color: tc.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalConfirm, { backgroundColor: tc.brand }]}
                onPress={() => {
                  setConfirmVisible(false)
                  handleSubmit()
                }}
              >
                <Text style={[styles.modalBtnText, { color: COLORS.neutral0 }]}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={removeImageConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setRemoveImageConfirmVisible(false)
          setRemoveImageCandidateUri(null)
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('COURT_REGISTER_REMOVE_IMG_TITLE')}</Text>
            <Text style={[styles.modalBody, { color: tc.textSecondary }]}>{t('COURT_REGISTER_REMOVE_IMG_BODY')}</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalCancel, { backgroundColor: tc.bgSurface }]}
                onPress={() => {
                  setRemoveImageConfirmVisible(false)
                  setRemoveImageCandidateUri(null)
                }}
              >
                <Text style={[styles.modalBtnText, { color: tc.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm, { backgroundColor: tc.brand }]} onPress={onConfirmRemoveImage}>
                <Text style={styles.modalBtnText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={submittedVisible} transparent animationType="fade" onRequestClose={() => setSubmittedVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('COURT_REGISTER_SUBMITTED_TITLE')}</Text>
            <Text style={[styles.modalBody, { color: tc.textSecondary }]}>{t('COURT_REGISTER_SUBMITTED_BODY')}</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalConfirm, { backgroundColor: tc.brand }]}
                onPress={() => {
                  setSubmittedVisible(false)
                  router.back()
                }}
              >
                <Text style={[styles.modalBtnText, { color: COLORS.neutral0 }]}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Image Zoom Modal */}
      <Modal visible={!!zoomImageUri} transparent animationType="fade" onRequestClose={() => setZoomImageUri(null)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setZoomImageUri(null)}>
            {!!zoomImageUri && (
              <GestureDetector gesture={zoomGesture}>
                <Animated.Image
                  source={{ uri: zoomImageUri }}
                  style={[{ width: zoomFrameW, height: zoomFrameH }, zoomAnimStyle]}
                  resizeMode="contain"
                />
              </GestureDetector>
            )}
          </Pressable>
        </GestureHandlerRootView>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  backBtn: { padding: 10, borderRadius: 28, backgroundColor: COLORS.neutral175, justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 22, height: 22, tintColor: COLORS.neutral925 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: COLORS.neutral925, textAlign: 'center' },
  headerSpacer: { width: 42 },

  page: { flex: 1, backgroundColor: '#f5f5f7' },
  content: { paddingHorizontal: 0, paddingTop: 8, paddingBottom: 220 },

  /* -- Design system: cards & section headers -- */
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 6,
    marginHorizontal: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    marginBottom: 4,
  },
  cardDivider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 10 },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  /* -- Verify button -- */
  verifyFullBtn: {
    backgroundColor: COLORS.brandOrangeDeep,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  verifyBtnVerified: { backgroundColor: COLORS.limeGreen },
  verifyFullBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  /* -- Services accordion header -- */
  sectionAccordion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 0,
    paddingVertical: 4,
  },
  sectionAccordionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  label: { fontSize: 12, fontWeight: '700', color: '#0f172a', marginTop: 12, marginBottom: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputWrap: { position: 'relative' },
  inputWithIcon: { paddingRight: 40 },
  verifiedTickInInput: { position: 'absolute', right: 12, top: '50%', marginTop: -8, width: 16, height: 16, tintColor: COLORS.green },
  addressSpinnerInInput: { position: 'absolute', right: 12, top: '50%', marginTop: -8 },
  suggestBox: {
    marginTop: 6,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: COLORS.neutral0,
    borderRadius: 12,
    overflow: 'hidden',
  },
  suggestItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  suggestItemLast: { borderBottomWidth: 0 },
  suggestText: { color: COLORS.neutral925, fontWeight: '700', fontSize: 13 },
  verifyErrorText: { marginTop: 6, color: COLORS.danger500, fontWeight: '600', fontSize: 12 },
  inputError: { borderColor: COLORS.danger500 },
  verifyRow: { flexDirection: 'row', marginTop: 10 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: COLORS.neutral200 },
  smallBtnRed: { backgroundColor: COLORS.coral },
  verifyBtnFull: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  smallBtnText: { color: COLORS.neutral0, fontWeight: '900', fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#fff',
  },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    overflow: 'hidden',
  },
  segment: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: '#fff' },
  segmentActive: { backgroundColor: COLORS.orange200 },
  segmentText: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  segmentTextActive: { color: COLORS.brown900 },

  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  chipActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  chipText: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  chipTextActive: { color: '#1d4ed8' },

  weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  dayCell: {
    flex: 1,
    marginHorizontal: 2,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: COLORS.neutral175,
    borderWidth: 1,
    borderColor: COLORS.neutral200,
    alignItems: 'center',
  },
  dayCellSelected: { backgroundColor: COLORS.orange200, borderColor: COLORS.orange200 },
  dayLabel: { fontSize: 12, fontWeight: '600', color: COLORS.neutral600 },
  dayLabelSelected: { color: COLORS.brown900 },

  timeRow: { flexDirection: 'row', gap: 10, marginTop: 10 },

  myCourtBox: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: COLORS.neutral0,
    borderRadius: 12,
    padding: 12,
  },
  myCourtHint: { color: COLORS.neutral600, fontWeight: '700', fontSize: 13, marginBottom: 10 },
  myCourtCardsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 },
  courtCard: {
    width: 260,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#fff',
    padding: 14,
    alignSelf: 'flex-start',
    borderLeftWidth: 3,
    borderLeftColor: COLORS.brandOrangeDeep,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  courtCardExpanded: { minHeight: 220 },
  courtCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  courtCardArrow: { width: 18, height: 18, tintColor: COLORS.neutral600 },
  courtCardArrowOpen: { transform: [{ rotate: '180deg' }] },
  courtCardBody: { marginTop: 10 },
  courtDetailLine: { color: COLORS.neutral800, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  courtDetailLabel: { color: COLORS.neutral800, fontSize: 13, fontWeight: '700', marginTop: 4 },
  courtDetailDesc: { color: COLORS.neutral800, fontSize: 13, marginTop: 6, lineHeight: 18 },
  addCourtCover: { borderStyle: 'dashed', width: 140, height: 140, borderColor: COLORS.brandOrangeDeep },
  addCourtCoverText: { color: COLORS.brandOrangeDeep, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  myCourtName: { color: COLORS.neutral925, fontWeight: '400', fontSize: 13 },
  myCourtMeta: { color: COLORS.neutral600, fontWeight: '700', fontSize: 12, marginTop: 2 },

  servicesBox: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: COLORS.neutral0,
    borderRadius: 12,
    overflow: 'hidden',
  },
  servicesHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 8 },
  servicesHeaderText: { color: '#0f172a', fontWeight: '700', fontSize: 14 },
  servicesArrow: { width: 18, height: 18, tintColor: COLORS.neutral600 },
  servicesArrowOpen: { transform: [{ rotate: '180deg' }] },
  servicesBody: { paddingHorizontal: 12, paddingBottom: 12 },
  servicesHint: { color: COLORS.neutral600, fontWeight: '700', fontSize: 13, marginBottom: 10 },
  servicesList: { gap: 10, marginBottom: 12 },
  servicesRow: { flexDirection: 'row', alignItems: 'center' },
  servicesName: { color: COLORS.neutral925, fontWeight: '700', fontSize: 13 },
  servicesMeta: { color: COLORS.neutral600, fontWeight: '700', fontSize: 12, marginTop: 2 },
  serviceDraftBox: { marginTop: 12 },
  serviceDraftBtnsRow: { flexDirection: 'row', gap: 10, marginTop: 12 },

  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  dropdownBtnText: { color: '#0f172a', fontWeight: '700', fontSize: 13 },
  dropdownArrow: { width: 18, height: 18, tintColor: COLORS.neutral600 },
  dropdownArrowOpen: { transform: [{ rotate: '180deg' }] },
  dropdownOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.2)' },
  dropdownModalContainer: { flex: 1, justifyContent: 'center', paddingHorizontal: 18 },
  dropdownModal: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  dropdownModalItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  dropdownCheck: { width: 18, height: 18, tintColor: COLORS.neutral800 },
  dropdownItemText: { color: COLORS.neutral925, fontWeight: '500', fontSize: 13 },

  coverFrame: {
    width: IMAGE_TILE_WIDTH,
    height: IMAGE_TILE_HEIGHT,
    alignSelf: 'flex-start',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  imagesRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 6, paddingBottom: 6 },
  coverPressable: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  coverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  addPlus: { fontSize: 28, fontWeight: '700', color: COLORS.neutral600, marginTop: -1 },
  coverHint: { marginTop: 6, color: COLORS.neutral600, fontWeight: '500', fontSize: 12 },
  removeXBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeXText: { fontSize: 20, lineHeight: 20, fontWeight: '900', color: '#ffffff', marginTop: -1 },

  truthRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 14,
    marginHorizontal: 16,
  },
  checkboxBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: COLORS.neutral550, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.neutral0 },
  checkboxBoxChecked: { backgroundColor: COLORS.limeGreen, borderColor: COLORS.limeGreen },
  checkboxTick: { width: 20, height: 20, tintColor: COLORS.neutral0 },
  checkboxLabel: { marginLeft: 10, color: COLORS.neutral925, fontWeight: '400', flex: 1, lineHeight: 18, marginTop: 1 },
  truthBold: { fontWeight: '800' },

  warningBox: {
    marginTop: 14,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    padding: 12,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: '#92400e', marginBottom: 6 },
  warningText: { fontSize: 13, color: '#92400e', fontWeight: '600' },

  bottomSafeArea: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
  bottomBar: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'center' },
  bottomSummaryRow: { marginBottom: 8 },
  bottomSummaryText: { fontSize: 12, fontWeight: '600', color: COLORS.neutral600, textAlign: 'center' },
  submitBtn: {
    width: '100%',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.brandOrangeDeep,
  },
  submitText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  btnDisabled: { opacity: 0.45 },

  helpText: { marginTop: 12, textAlign: 'center', color: '#64748b', fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: COLORS.black50, justifyContent: 'center', alignItems: 'center', padding: 18 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: COLORS.neutral0, borderRadius: 14, padding: 16 },
  modalCardTall: {
    width: '100%',
    maxWidth: 420,
    maxHeight: Math.max(200, Math.round(Dimensions.get('window').height * 0.85)),
    backgroundColor: COLORS.neutral0,
    borderRadius: 14,
    padding: 16,
  },

  servicesCardsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 10, paddingBottom: 6 },
  serviceCard: {
    width: Math.min(240, Math.max(190, Math.round(Dimensions.get('window').width * 0.62))),
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    backgroundColor: COLORS.neutral0,
    padding: 12,
  },
  serviceCardExpanded: { borderColor: COLORS.neutral550 },
  serviceCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  serviceCardBody: { marginTop: 8 },
  addServiceCover: { width: 170, height: 120 },
  serviceDraftInline: { marginTop: 12 },
  thumbsRow: { flexDirection: 'row', gap: 8, paddingTop: 8, paddingBottom: 2 },
  thumbFrame: {
    width: 72,
    height: 72,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.neutral200,
    backgroundColor: COLORS.neutral0,
  },
  thumbImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  modalCloseXBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.neutral0,
    borderWidth: 1,
    borderColor: COLORS.neutral200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseXText: { fontSize: 22, lineHeight: 22, fontWeight: '900', color: COLORS.neutral925, marginTop: -1 },
  modalScrollContent: { paddingBottom: 14 },
  modalTitle: { fontSize: 15, fontWeight: '700', color: COLORS.neutral975, marginBottom: 6 },
  modalTitleCentered: { flex: 1, textAlign: 'center' },

  priceInputWrap: { position: 'relative' },
  inputWithSuffix: { paddingRight: 40 },
  suffixInInput: { position: 'absolute', right: 12, top: '50%', marginTop: -9, fontSize: 14, fontWeight: '900', color: COLORS.neutral800 },
  modalBody: { fontSize: 14, fontWeight: '700', color: COLORS.neutral800 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  modalBtnsRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  modalCancel: { backgroundColor: COLORS.danger },
  modalConfirm: { backgroundColor: COLORS.brandOrangeDeep },
  modalBtnText: { fontWeight: '900', color: COLORS.neutral0 },

  surfaceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  surfacePill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  surfacePillActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  surfacePillText: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  surfacePillTextActive: { color: '#1d4ed8' },

  halfTabsRow: { flexDirection: 'row', gap: 10, marginTop: 4, marginBottom: 8 },
  halfTab: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: COLORS.neutral350,
  },
  halfTabActive: { backgroundColor: COLORS.brandOrangeDeep, borderColor: COLORS.brandOrangeDeep },
  halfTabText: { fontSize: 13, fontWeight: '700', color: COLORS.neutral800 },
  halfTabTextActive: { color: COLORS.neutral0 },
})
