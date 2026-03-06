import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useFocusEffect } from '@react-navigation/native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getCache, invalidateCache, setCache } from '@/lib/cache'

import { autocompleteCourtAddress, cloudinarySignUpload, geocodeCourtAddress, geocodeCourtPlaceId, getCourtInfoByCourtId, registerCourt, type CourtAddressSuggestion, type CourtRegisterRequest, upsertCourtInfoIntoCache } from '@/lib/backendApi'
import { useUserId } from '@/hooks/use-user-id'
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

const canonicalizeAddress = (s: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase()

type Venue = 'Indoor' | 'Outdoor' | 'Both'

export default function CourtRegisterPage() {
  const router = useRouter()
  const isMountedRef = useRef(true)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])
  const { data: userid } = useUserId()

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [price, setPrice] = useState('')
  const [priceError, setPriceError] = useState<string | null>(null)
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

  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [verifiedCoord, setVerifiedCoord] = useState<{ latitude: number; longitude: number; formatted_address?: string | null } | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [agreeTruth, setAgreeTruth] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [submittedVisible, setSubmittedVisible] = useState(false)

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
        if (typeof parsed?.price === 'string') setPrice(parsed.price)
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
        price,
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
  }, [name, address, addressSuggestions, selectedPlaceId, verifiedCoord, price, venue, scheduleDays, startTime, endTime, agreeTruth, localImageUris, remoteImageUrls])

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
      price.trim().length > 0 &&
      !priceError &&
      Number(price) > 0 &&
      !submitting &&
      isScheduleValid &&
      agreeTruth
    )
  }, [userid, name, address, price, priceError, submitting, agreeTruth, isScheduleValid])

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

  const uploadOneToCloudinary = async (localUri: string, idx: number) => {
    const resized = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: 1280 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
    )

    const publicId = `court_${userid}_${Date.now()}_${idx}`
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
    if (priceError) {
      return
    }
    const p = Number(price)
    if (!Number.isFinite(p) || p <= 0) {
      Alert.alert('Invalid price', 'Please enter a valid price.')
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

    setSubmitting(true)
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
        price: p,
        venue,
        images: urls,
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


  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} />
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Court Register</Text>
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
          style={[styles.smallBtn, styles.smallBtnRed, (checking || submitting || (!selectedPlaceId && !verifiedCoord)) && styles.btnDisabled]}
        >
          <Text style={styles.smallBtnText}>{checking ? 'Verifying…' : 'Verify Location'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>Price (VND)</Text>
      <TextInput
        value={price}
        onChangeText={(raw) => {
          if (!raw) {
            setPrice('')
            setPriceError(null)
            return
          }
          const digits = raw.replace(/[^\d]/g, '')
          setPrice(digits)
          const hasLetters = /[A-Za-z]/.test(raw)
          setPriceError(hasLetters ? 'Please type in number' : null)
        }}
        placeholder="e.g. 200000"
        keyboardType="numeric"
        style={styles.input}
      />
      {!!priceError && <Text style={styles.verifyErrorText}>{priceError}</Text>}

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
            <View style={styles.coverPressable}>
              <Image source={{ uri }} style={styles.coverImage} />
            </View>
            <TouchableOpacity
              onPress={() => removeLocalImage(uri)}
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

      <TouchableOpacity
        style={styles.truthRow}
        activeOpacity={0.85}
        onPress={() => setAgreeTruth(v => !v)}
      >
        <View style={[styles.checkboxBox, agreeTruth && styles.checkboxBoxChecked]}>
          {agreeTruth && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>
          I agree that all the information I submit is <Text style={styles.underline}>true</Text>.
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
  verifyRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: COLORS.neutral200 },
  smallBtnRed: { backgroundColor: COLORS.coral },
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
  segmentActive: { backgroundColor: '#2563eb' },
  segmentText: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  segmentTextActive: { color: '#fff' },

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
  dayCellSelected: { borderColor: COLORS.neutral800 },
  dayLabel: { fontSize: 12, fontWeight: '600', color: COLORS.neutral600 },
  dayLabelSelected: { color: COLORS.neutral800 },

  timeRow: { flexDirection: 'row', gap: 10, marginTop: 10 },

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
  checkboxLabel: { marginLeft: 10, color: COLORS.neutral925, fontWeight: '700', flex: 1, lineHeight: 18, marginTop: 1 },
  underline: { textDecorationLine: 'underline' },

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
    backgroundColor: COLORS.limeGreen,
  },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '900' },
  btnDisabled: { opacity: 0.45 },

  helpText: { marginTop: 12, textAlign: 'center', color: '#64748b', fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: COLORS.black50, justifyContent: 'center', alignItems: 'center', padding: 18 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: COLORS.neutral0, borderRadius: 14, padding: 16 },
  modalTitle: { fontSize: 16, fontWeight: '900', color: COLORS.neutral975, marginBottom: 6 },
  modalBody: { fontSize: 14, fontWeight: '700', color: COLORS.neutral800 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  modalCancel: { backgroundColor: COLORS.neutral200 },
  modalConfirm: { backgroundColor: COLORS.coral },
  modalBtnText: { fontWeight: '900', color: COLORS.neutral925 },
})
