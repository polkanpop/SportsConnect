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
    return `${new Intl.NumberFormat('vi-VN').format(safe)}₫`
  } catch {
    return `${String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}₫`
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

export default function CourtRegisterPage() {
  const router = useRouter()
  const isMountedRef = useRef(true)

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

        // If a registration was in-flight when the user left the screen, keep showing "Registering…"
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
      Alert.alert('Missing info', 'Please enter a court name.')
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
      setVerifyError('You must fill address first.')
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
      Alert.alert('Missing info', 'Please fill in name and address.')
      return
    }

    // Ensure the full procedure is complete before starting any Cloudinary upload.
    if (!verifiedCoord) {
      setVerifyError(' Please verify court location first.')
      return
    }
    if (!isScheduleValid) {
      Alert.alert('Invalid schedule', 'Please select days and use a valid time range (HH:MM, start < end).')
      return
    }
    if (!agreeTruth) {
      Alert.alert('Confirm required', 'Please agree that the information you submit is true.')
      return
    }

    if (playingCourts.length === 0) {
      Alert.alert('Court required', 'Please add at least one court in the “Court” section.')
      return
    }

    setSubmitting(true)
    // Persist in-flight state immediately so leaving/re-entering keeps the button in "Registering…".
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
      Alert.alert('Missing info', 'Please fill in name and address.')
      return
    }
    if (!verifiedCoord) {
      setVerifyError(' Please verify court location first.')
      return
    }
    if (!isScheduleValid) {
      Alert.alert('Invalid schedule', 'Please select days and use a valid time range (HH:MM, start < end).')
      return
    }
    if (!agreeTruth) {
      Alert.alert('Confirm required', 'Please agree that the information you submit is true.')
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
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} />
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Venue Register</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

      <Text style={styles.label}>Court Name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="e.g. Some Random Court..."
        style={styles.input}
      />

      <View style={styles.labelRow}>
        <Text style={styles.label}>Address</Text>
      </View>
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
          placeholder="Street, City, Country"
          style={[styles.input, styles.inputWithIcon, verifyError && styles.inputError, { minHeight: 44 }]}
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
      <View style={styles.verifyRow}>
        <TouchableOpacity
          onPress={handleVerifyLocation}
          disabled={checking || submitting || (!selectedPlaceId && !verifiedCoord)}
          style={[styles.smallBtn, styles.smallBtnRed, styles.verifyBtnFull, (checking || submitting || (!selectedPlaceId && !verifiedCoord)) && styles.btnDisabled]}
        >
          <Text style={styles.smallBtnText}>{checking ? 'Verifying…' : 'Verify Location'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>Venue</Text>
      <View style={styles.segmented}>
        {(['Indoor', 'Outdoor', 'Both'] as const).map(v => {
          const active = venue === v
          return (
            <TouchableOpacity
              key={v}
              onPress={() => setVenue(v)}
              style={[styles.segment, active && styles.segmentActive]}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{v}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      <Text style={styles.label}>Court</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.myCourtCardsRow}
      >
        {playingCourts.map((pc, idx) => {
          const expanded = expandedCourtIdxs.has(idx)
          return (
            <View key={`${pc.fullName}-${idx}`} style={[styles.courtCard, expanded && styles.courtCardExpanded]}>
              <TouchableOpacity
                onPress={() => toggleCourtExpanded(idx)}
                activeOpacity={0.85}
                style={styles.courtCardHeader}
              >
                <Text style={styles.myCourtName} numberOfLines={1}>{pc.fullName}</Text>
                <Image
                  source={ICONS.arrowdown}
                  style={[styles.courtCardArrow, expanded && styles.courtCardArrowOpen]}
                />
              </TouchableOpacity>

              <Text style={styles.myCourtMeta}>{`Full price: ${formatVnd(pc.fullPrice)}`}</Text>
              <Text style={styles.myCourtMeta}>{pc.allowHalfBooking ? 'Half Court Booking: On' : 'Half Court Booking: Off'}</Text>

              {expanded && (
                <View style={styles.courtCardBody}>
                  <Text style={styles.courtDetailLine}>{`Surface: ${pc.surface || 'concrete'}`}</Text>
                  {pc.allowHalfBooking ? (
                    <>
                      <Text style={styles.courtDetailLine}>{`Half Court 1: ${pc.half1Name || 'Half Court 1'} • ${formatVnd(pc.half1Price)}`}</Text>
                      <Text style={styles.courtDetailLine}>{`Half Court 2: ${pc.half2Name || 'Half Court 2'} • ${formatVnd(pc.half2Price)}`}</Text>
                    </>
                  ) : null}
                  <Text style={styles.courtDetailLabel}>Description:</Text>
                  <Text style={styles.courtDetailDesc} numberOfLines={4}>
                    {(pc.description || '').trim() ? pc.description : 'No description'}
                  </Text>
                  <Text style={styles.courtDetailLine}>{`Full Court Images: ${Array.isArray(pc.images) ? pc.images.length : 0}`}</Text>
                  {pc.allowHalfBooking ? (
                    <>
                      <Text style={styles.courtDetailLine}>{`Half Court 1 Images: ${Array.isArray(pc.half1Images) ? pc.half1Images.length : 0}`}</Text>
                      <Text style={styles.courtDetailLine}>{`Half Court 2 Images: ${Array.isArray(pc.half2Images) ? pc.half2Images.length : 0}`}</Text>
                    </>
                  ) : null}
                </View>
              )}
            </View>
          )
        })}

        <View style={[styles.coverFrame, styles.addCourtCover, (submitting || imageUploading) && styles.btnDisabled]}>
          <TouchableOpacity
            onPress={openPlayingCourtModal}
            disabled={submitting || imageUploading}
            activeOpacity={0.85}
            style={styles.coverPressable}
          >
            <Text style={styles.addCourtCoverText}>Add Court</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <TouchableOpacity
        onPress={() => setServicesExpanded(v => !v)}
        activeOpacity={0.85}
        style={styles.servicesHeaderRow}
      >
        <Text style={styles.servicesHeaderText}>Services (optional)</Text>
        <Image
          source={ICONS.arrowdown}
          style={[styles.servicesArrow, servicesExpanded && styles.servicesArrowOpen]}
        />
      </TouchableOpacity>

      {servicesExpanded && (
        <View style={styles.servicesBody}>
          {services.length === 0 ? (
            <Text style={styles.servicesHint}>No services added.</Text>
          ) : null}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.servicesCardsRow}
          >
            {services.map((s, idx) => {
              const expanded = expandedServiceIdxs.has(idx)
              return (
                <View key={`${s.name}-${idx}`} style={[styles.serviceCard, expanded && styles.serviceCardExpanded]}>
                  <TouchableOpacity
                    onPress={() => toggleServiceExpanded(idx)}
                    activeOpacity={0.85}
                    style={styles.serviceCardHeader}
                  >
                    <Text style={styles.servicesName} numberOfLines={1}>{s.name}</Text>
                    <Image
                      source={ICONS.arrowdown}
                      style={[styles.courtCardArrow, expanded && styles.courtCardArrowOpen]}
                    />
                  </TouchableOpacity>

                  <Text style={styles.servicesMeta}>{`${s.category} • ${formatVnd(s.price)}`}</Text>

                  {expanded && (
                    <View style={styles.serviceCardBody}>
                      <Text style={styles.courtDetailLine}>{`Stock: ${s.stock ? Number(s.stock) || 0 : 0}`}</Text>
                      <Text style={styles.courtDetailLine}>{`Images: ${Array.isArray(s.images) ? s.images.length : 0}`}</Text>
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

            <View style={[styles.coverFrame, styles.addServiceCover, submitting && styles.btnDisabled]}>
              <TouchableOpacity
                onPress={openAddService}
                disabled={submitting}
                activeOpacity={0.85}
                style={styles.coverPressable}
              >
                <Text style={styles.addCourtCoverText}>Add service</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {serviceDraftVisible && (
            <View style={styles.serviceDraftInline}>
                <Text style={styles.label}>Service name</Text>
                <TextInput value={svcName} onChangeText={setSvcName} placeholder="Water" style={styles.input} />

                <Text style={styles.label}>Category</Text>
                <TouchableOpacity
                  onPress={() => setSvcCategoryDropdownOpen(v => !v)}
                  activeOpacity={0.85}
                  style={styles.dropdownBtn}
                >
                  <Text style={styles.dropdownBtnText}>{svcCategory}</Text>
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
                    <View style={styles.dropdownModal}>
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
                            <Text style={styles.dropdownItemText}>{opt}</Text>
                            <Image source={selected ? ICONS.tick : ''} style={styles.dropdownCheck} />
                          </TouchableOpacity>
                        )
                      })}
                    </View>
                  </View>
                </Modal>

                <Text style={styles.label}>Price(₫) :</Text>
                <View style={styles.priceInputWrap}>
                  <TextInput
                    value={svcPrice}
                    onChangeText={(v) => setSvcPrice(formatThousandGroups(v))}
                    placeholder="0"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    style={[styles.input, styles.inputWithSuffix]}
                  />
                  <Text style={styles.suffixInInput}>₫</Text>
                </View>

                <Text style={styles.label}>Stock</Text>
                <TextInput
                  value={svcStock}
                  onChangeText={setSvcStock}
                  placeholder="0"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  style={styles.input}
                />

                <Text style={styles.label}>Images (optional)</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                  {svcImages.map((uri) => (
                    <View key={uri} style={styles.coverFrame}>
                      <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                        <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeServiceImage(uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                        <Text style={styles.removeXText}>×</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                  {svcImages.length < 6 && (
                    <View style={styles.coverFrame}>
                      <TouchableOpacity
                        onPress={pickServiceImage}
                        disabled={imageUploading}
                        activeOpacity={0.85}
                        style={styles.coverPressable}
                      >
                        <Text style={styles.addPlus}>+</Text>
                        <Text style={styles.coverHint}>{imageUploading ? 'Uploading…' : 'Add image'}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </ScrollView>

                <View style={styles.serviceDraftBtnsRow}>
                  <TouchableOpacity
                    onPress={() => setServiceDraftVisible(false)}
                    style={[styles.modalBtn, styles.modalCancel]}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.modalBtnText}>Close</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={addService}
                    style={[styles.modalBtn, styles.modalConfirm]}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.modalBtnText}>Submit</Text>
                  </TouchableOpacity>
                </View>
            </View>
          )}
        </View>
      )}

      <View style={styles.rowBetween}>
        <Text style={styles.label}>Images</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.imagesRow}
      >
        {remoteImageUrls.map((uri) => (
          <View key={uri} style={[styles.coverFrame, (submitting || imageUploading) && styles.btnDisabled]}>
            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => requestRemoveImage(uri)}
              style={styles.removeXBtn}
              activeOpacity={0.85}
            >
              <Text style={styles.removeXText}>×</Text>
            </TouchableOpacity>
          </View>
        ))}

        {remoteImageUrls.length < 6 && (
          <View style={[styles.coverFrame, (submitting || imageUploading) && styles.btnDisabled]}>
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

      <Modal
        visible={playingCourtModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPlayingCourtModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCardTall}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, styles.modalTitleCentered]}>Add Court</Text>
              <TouchableOpacity
                onPress={() => setPlayingCourtModalVisible(false)}
                style={styles.modalCloseXBtn}
                activeOpacity={0.85}
              >
                <Text style={styles.modalCloseXText}>×</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalScrollContent}>
              <Text style={styles.label}>Court Name</Text>
              <TextInput
                value={pcFullName}
                onChangeText={setPcFullName}
                placeholder="Court 1"
                style={styles.input}
              />

              <Text style={styles.label}>Price(₫) :</Text>
              <View style={styles.priceInputWrap}>
                <TextInput
                  value={pcFullPrice}
                  onChangeText={(v) => setPcFullPrice(formatThousandGroups(v))}
                  placeholder="0"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  style={[styles.input, styles.inputWithSuffix]}
                />
                <Text style={styles.suffixInInput}>₫</Text>
              </View>

              <Text style={styles.label}>Schedule</Text>
              <View style={styles.weekRow}>
                {WEEK_DAYS.map((label) => {
                  const active = scheduleDays.includes(label)
                  return (
                    <TouchableOpacity
                      key={label}
                      onPress={() => {
                        setScheduleDays(prev => (prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]))
                      }}
                      style={[styles.dayCell, active && styles.dayCellSelected]}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.dayLabel, active && styles.dayLabelSelected]}>{label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <View style={styles.timeRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Start Time (HH:MM)</Text>
                  <TextInput
                    value={startTime}
                    onChangeText={(v) => setStartTime(normalizeTimeInput(v))}
                    placeholder="08:00"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={5}
                    style={styles.input}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>End Time (HH:MM)</Text>
                  <TextInput
                    value={endTime}
                    onChangeText={(v) => setEndTime(normalizeTimeInput(v))}
                    placeholder="22:00"
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={5}
                    style={styles.input}
                  />
                </View>
              </View>

              <Text style={styles.label}>Images</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                {pcImages.map((uri) => (
                  <View key={uri} style={styles.coverFrame}>
                    <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                      <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removePlayingCourtImage('full', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                      <Text style={styles.removeXText}>×</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                {pcImages.length < 6 && (
                  <View style={styles.coverFrame}>
                    <TouchableOpacity
                      onPress={() => pickPlayingCourtImage('full')}
                      disabled={imageUploading}
                      activeOpacity={0.85}
                      style={styles.coverPressable}
                    >
                      <Text style={styles.addPlus}>+</Text>
                      <Text style={styles.coverHint}>{imageUploading ? 'Uploading…' : 'Add image'}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>

              <Text style={styles.label}>Allow Half Court Booking</Text>
              <View style={styles.segmented}>
                {([
                  { label: 'Yes', value: true },
                  { label: 'No', value: false },
                ] as const).map(opt => {
                  const active = pcAllowHalf === opt.value
                  return (
                    <TouchableOpacity
                      key={opt.label}
                      onPress={() => setPcAllowHalf(opt.value)}
                      style={[styles.segment, active && styles.segmentActive]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              {pcAllowHalf && (
                <>
                  <Text style={styles.label}>Choose Court Half:</Text>
                  <View style={styles.halfTabsRow}>
                    <TouchableOpacity
                      onPress={() => setPcHalfTab('half1')}
                      activeOpacity={0.85}
                      style={[styles.halfTab, pcHalfTab === 'half1' && styles.halfTabActive]}
                    >
                      <Text style={[styles.halfTabText, pcHalfTab === 'half1' && styles.halfTabTextActive]}>Half Court 1</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setPcHalfTab('half2')}
                      activeOpacity={0.85}
                      style={[styles.halfTab, pcHalfTab === 'half2' && styles.halfTabActive]}
                    >
                      <Text style={[styles.halfTabText, pcHalfTab === 'half2' && styles.halfTabTextActive]}>Half Court 2</Text>
                    </TouchableOpacity>
                  </View>

                  {pcHalfTab === 'half1' ? (
                    <>
                      <Text style={styles.label}>Name</Text>
                      <TextInput
                        value={pcHalf1Name}
                        onChangeText={setPcHalf1Name}
                        placeholder="Name"
                        style={styles.input}
                      />
                      <Text style={styles.label}>Price(₫) :</Text>
                      <View style={styles.priceInputWrap}>
                        <TextInput
                          value={pcHalf1Price}
                          onChangeText={(v) => setPcHalf1Price(formatThousandGroups(v))}
                          placeholder="0"
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, styles.inputWithSuffix]}
                        />
                        <Text style={styles.suffixInInput}>₫</Text>
                      </View>

                      <Text style={styles.label}>Images</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                        {pcHalf1Images.map((uri) => (
                          <View key={uri} style={styles.coverFrame}>
                            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => removePlayingCourtImage('half1', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                              <Text style={styles.removeXText}>×</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                        {pcHalf1Images.length < 6 && (
                          <View style={styles.coverFrame}>
                            <TouchableOpacity
                              onPress={() => pickPlayingCourtImage('half1')}
                              disabled={imageUploading}
                              activeOpacity={0.85}
                              style={styles.coverPressable}
                            >
                              <Text style={styles.addPlus}>+</Text>
                              <Text style={styles.coverHint}>{imageUploading ? 'Uploading…' : 'Add image'}</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </ScrollView>
                    </>
                  ) : (
                    <>
                      <Text style={styles.label}>Name</Text>
                      <TextInput
                        value={pcHalf2Name}
                        onChangeText={setPcHalf2Name}
                        placeholder="Name"
                        style={styles.input}
                      />
                      <Text style={styles.label}>Price(₫) :</Text>
                      <View style={styles.priceInputWrap}>
                        <TextInput
                          value={pcHalf2Price}
                          onChangeText={(v) => setPcHalf2Price(formatThousandGroups(v))}
                          placeholder="0"
                          keyboardType="number-pad"
                          inputMode="numeric"
                          style={[styles.input, styles.inputWithSuffix]}
                        />
                        <Text style={styles.suffixInInput}>₫</Text>
                      </View>

                      <Text style={styles.label}>Images</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                        {pcHalf2Images.map((uri) => (
                          <View key={uri} style={styles.coverFrame}>
                            <TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>
                              <ExpoImage source={{ uri }} style={styles.coverImage} contentFit="cover" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => removePlayingCourtImage('half2', uri)} style={styles.removeXBtn} activeOpacity={0.85}>
                              <Text style={styles.removeXText}>×</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                        {pcHalf2Images.length < 6 && (
                          <View style={styles.coverFrame}>
                            <TouchableOpacity
                              onPress={() => pickPlayingCourtImage('half2')}
                              disabled={imageUploading}
                              activeOpacity={0.85}
                              style={styles.coverPressable}
                            >
                              <Text style={styles.addPlus}>+</Text>
                              <Text style={styles.coverHint}>{imageUploading ? 'Uploading…' : 'Add image'}</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </ScrollView>
                    </>
                  )}
                </>
              )}

              <Text style={styles.label}>Surface</Text>
              <View style={styles.surfaceWrap}>
                {(['hardwood', 'concrete', 'synthetic'] as const).map(s => {
                  const active = pcSurface === s
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setPcSurface(s)}
                      style={[styles.surfacePill, active && styles.surfacePillActive]}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.surfacePillText, active && styles.surfacePillTextActive]}>{s}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <Text style={styles.label}>Description (optional)</Text>
              <TextInput
                value={pcDescription}
                onChangeText={setPcDescription}
                placeholder="Describe something about your court"
                style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
                multiline
              />

              

              <TouchableOpacity
                onPress={addPlayingCourt}
                style={[styles.submitBtn, { alignSelf: 'center', marginTop: 16 }]}
                activeOpacity={0.85}
              >
                <Text style={styles.submitText}>Submit</Text>
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
          {agreeTruth && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>
          I agree that all the information I submit is <Text style={styles.truthBold}>true</Text>.
        </Text>
      </TouchableOpacity>

      {warnings.length > 0 && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Warnings</Text>
          {warnings.map((w, i) => (
            <Text key={`${w}-${i}`} style={styles.warningText}>• {w}</Text>
          ))}
        </View>
      )}

      {!userid && (
        <Text style={styles.helpText}>Sign in is required to register a court.</Text>
      )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Fixed bottom submit bar (matches booking screens) */}
      <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
        <View style={styles.bottomBar}>
          <TouchableOpacity
            onPress={handlePressRegister}
            disabled={!canSubmit}
            style={[styles.submitBtn, !canSubmit && styles.btnDisabled]}
            activeOpacity={0.85}
          >
            <Text style={styles.submitText}>{submitting ? 'Registering…' : 'Register Court'}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm submission</Text>
            <Text style={styles.modalBody}>Are you sure you want to submit?</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmVisible(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalConfirm]}
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
                <Text style={styles.modalBtnText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={submittedVisible} transparent animationType="fade" onRequestClose={() => setSubmittedVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Your request has been submitted</Text>
            <Text style={styles.modalBody}>We will review your court registration request and contact you later.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalConfirm]}
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
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { padding: 10, borderRadius: 28, backgroundColor: COLORS.neutral175, justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 22, height: 22, tintColor: COLORS.neutral925 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: COLORS.neutral925, textAlign: 'center' },
  headerSpacer: { width: 42 },

  page: { flex: 1, backgroundColor: '#fff' },
  content: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 220 },
  label: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 12, marginBottom: 8 },
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
  segmentText: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
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
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 12,
    alignSelf: 'flex-start',
  },
  courtCardExpanded: { minHeight: 220 },
  courtCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  courtCardArrow: { width: 18, height: 18, tintColor: COLORS.neutral600 },
  courtCardArrowOpen: { transform: [{ rotate: '180deg' }] },
  courtCardBody: { marginTop: 10 },
  courtDetailLine: { color: COLORS.neutral800, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  courtDetailLabel: { color: COLORS.neutral800, fontSize: 13, fontWeight: '900', marginTop: 4 },
  courtDetailDesc: { color: COLORS.neutral800, fontSize: 13, marginTop: 6, lineHeight: 18 },
  addCourtCover: { borderStyle: 'dashed' },
  addCourtCoverText: { color: COLORS.neutral925, fontWeight: '900', fontSize: 14 },
  myCourtName: { color: COLORS.neutral925, fontWeight: '900', fontSize: 14 },
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
  servicesName: { color: COLORS.neutral925, fontWeight: '900', fontSize: 14 },
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
  dropdownBtnText: { color: '#0f172a', fontWeight: '800', fontSize: 14 },
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
  dropdownItemText: { color: COLORS.neutral925, fontWeight: '800', fontSize: 13 },

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
  imagesRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 6, paddingBottom: 6 },
  coverPressable: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  coverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  addPlus: { fontSize: 28, fontWeight: '700', color: COLORS.neutral800, marginTop: -1 },
  coverHint: { marginTop: 6, color: COLORS.neutral600, fontWeight: '800', fontSize: 12 },
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

  truthRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 14,
  },
  checkboxBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: COLORS.neutral550, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.neutral0 },
  checkboxBoxChecked: { backgroundColor: COLORS.limeGreen, borderColor: COLORS.limeGreen },
  checkboxTick: { color: COLORS.neutral0, fontWeight: '900', fontSize: 14, marginTop: -1 },
  checkboxLabel: { marginLeft: 10, color: COLORS.neutral925, fontWeight: '400', flex: 1, lineHeight: 18, marginTop: 1 },
  truthBold: { fontWeight: '800' },

  warningBox: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    padding: 12,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: '#92400e', marginBottom: 6 },
  warningText: { fontSize: 13, color: '#92400e', fontWeight: '600' },

  bottomSafeArea: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
  bottomBar: { paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'center' },
  submitBtn: {
    width: '100%',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.brandOrangeDeep,
  },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '900' },
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
  modalTitle: { fontSize: 16, fontWeight: '900', color: COLORS.neutral975, marginBottom: 6 },
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
  surfacePillText: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
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
  halfTabText: { fontSize: 13, fontWeight: '900', color: COLORS.neutral800 },
  halfTabTextActive: { color: COLORS.neutral0 },
})
