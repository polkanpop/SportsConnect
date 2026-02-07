import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useFocusEffect } from '@react-navigation/native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getCache, invalidateCache, setCache } from '@/lib/cache'

import { autocompleteCourtAddress, cloudinarySignUpload, geocodeCourtAddress, geocodeCourtPlaceId, registerCourt, type CourtAddressSuggestion } from '@/lib/backendApi'
import { useUserId } from '@/hooks/use-user-id'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'

const COURT_REGISTER_VERIFY_STORAGE_KEY = '@courtRegisterVerifiedLocation'
const COURT_REGISTER_DRAFT_STORAGE_KEY = '@courtRegisterDraft'

const COURT_REGISTER_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const COURT_REGISTER_VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

type Venue = 'Indoor' | 'Outdoor' | 'Both'

export default function CourtRegisterPage() {
  const router = useRouter()
  const { data: userid } = useUserId()

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [price, setPrice] = useState('')
  const [priceError, setPriceError] = useState<string | null>(null)
  const [venue, setVenue] = useState<Venue>('Indoor')

  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [addressSuggestions, setAddressSuggestions] = useState<CourtAddressSuggestion[]>([])

  const [localImageUris, setLocalImageUris] = useState<string[]>([])
  const [remoteImageUrls, setRemoteImageUrls] = useState<string[]>([])

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
          }
        } catch {}
      })()
      return () => {
        cancelled = true
      }
    }, [])
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
        if (typeof parsed?.name === 'string') setName(parsed.name)
        if (typeof parsed?.address === 'string') setAddress(parsed.address)
        if (typeof parsed?.price === 'string') setPrice(parsed.price)
        if (parsed?.venue === 'Indoor' || parsed?.venue === 'Outdoor' || parsed?.venue === 'Both') setVenue(parsed.venue)
        if (typeof parsed?.agreeTruth === 'boolean') setAgreeTruth(parsed.agreeTruth)
        if (Array.isArray(parsed?.localImageUris)) setLocalImageUris(parsed.localImageUris.filter((x: any) => typeof x === 'string'))
        if (Array.isArray(parsed?.remoteImageUrls)) setRemoteImageUrls(parsed.remoteImageUrls.filter((x: any) => typeof x === 'string'))
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
        price,
        venue,
        agreeTruth,
        localImageUris,
        remoteImageUrls,
      }
      setCache(COURT_REGISTER_DRAFT_STORAGE_KEY, payload, COURT_REGISTER_DRAFT_TTL_MS).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [name, address, price, venue, agreeTruth, localImageUris, remoteImageUrls])

  const canSubmit = useMemo(() => {
    return (
      !!userid &&
      name.trim().length > 0 &&
      address.trim().length > 0 &&
      price.trim().length > 0 &&
      !priceError &&
      Number(price) > 0 &&
      !submitting &&
      agreeTruth
    )
  }, [userid, name, address, price, priceError, submitting, agreeTruth])

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

  useEffect(() => {
    const q = address.trim()
    if (q.length < 3) {
      setAddressSuggestions([])
      return
    }
    // If user has selected a suggestion (place id) and doesn't change the field, don't re-search.
    if (selectedPlaceId) return

    let cancelled = false
    const t = setTimeout(() => {
      autocompleteCourtAddress(q, 5)
        .then((rows) => {
          if (cancelled) return
          setAddressSuggestions(Array.isArray(rows) ? rows : [])
        })
        .catch(() => {
          if (cancelled) return
          setAddressSuggestions([])
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [address, selectedPlaceId])

  const pickImages = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Please allow photo library access to select images.')
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      quality: 0.9,
    } as any)

    if (result.canceled) return
    const picked = (result.assets || []).map(a => a.uri).filter(Boolean)
    if (picked.length === 0) return

    setLocalImageUris(prev => dedupeStrings([...prev, ...picked]).slice(0, 6))
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
    return secureUrl
  }

  const handleVerifyLocation = async () => {
    const a = address.trim()
    if (!a) {
      setVerifyError('You must fill address first.')
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
    if (!agreeTruth) {
      Alert.alert('Confirm required', 'Please agree that the information you submit is true.')
      return
    }

    setSubmitting(true)
    setWarnings([])
    try {
      // Upload images (if any) first
      let urls: string[] = remoteImageUrls
      if (localImageUris.length > 0 && remoteImageUrls.length < localImageUris.length) {
        const toUpload = localImageUris.slice(remoteImageUrls.length)
        const newUrls: string[] = []
        for (let i = 0; i < toUpload.length; i++) {
          const url = await uploadOneToCloudinary(toUpload[i], remoteImageUrls.length + i)
          newUrls.push(url)
        }
        urls = [...remoteImageUrls, ...newUrls]
        setRemoteImageUrls(urls)
      }

      const payload = {
        name: nm,
        address: addr,
        ownerid: userid,
        price: p,
        venue,
        images: urls,
        // Verified location from map picker
        latitude: verifiedCoord?.latitude,
        longitude: verifiedCoord?.longitude,
        accuracy_type: verifiedCoord ? 'user_selected' : 'default',
      } as const

      const resp = await registerCourt(payload)
      const w = (resp?.geocode?.warnings || []).filter(Boolean)
      setWarnings(w)

      await invalidateCache(COURT_REGISTER_DRAFT_STORAGE_KEY).catch(() => {})
      setSubmittedVisible(true)
    } catch (e: any) {
      Alert.alert('Register failed', e?.message || 'Please try again')
    } finally {
      setSubmitting(false)
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
    if (!agreeTruth) {
      Alert.alert('Confirm required', 'Please agree that the information you submit is true.')
      return
    }
    setConfirmVisible(true)
  }

  const removeLocalImage = (uri: string) => {
    setLocalImageUris(prev => {
      const index = prev.indexOf(uri)
      if (index < 0) return prev
      setRemoteImageUrls(prevRemote => prevRemote.filter((_, i) => i !== index))
      return prev.filter((_, i) => i !== index)
    })
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
            setSelectedPlaceId(null)
            if (addressSuggestions.length) setAddressSuggestions([])
            if (verifiedCoord) setVerifiedCoord(null)
            if (verifyError) setVerifyError(null)
          }}
          placeholder="Street, City, Country"
          style={[styles.input, styles.inputWithIcon, verifyError && styles.inputError, { minHeight: 44 }]}
        />
        {!!verifiedCoord && (
          <Image source={ICONS.tick} style={styles.verifiedTickInInput} />
        )}
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
          disabled={checking || submitting}
          style={[styles.smallBtn, styles.smallBtnRed, (checking || submitting) && styles.btnDisabled]}
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

      <View style={styles.rowBetween}>
        <Text style={styles.label}>Images</Text>
      </View>

      {localImageUris.length === 0 && (
        <TouchableOpacity
          onPress={pickImages}
          disabled={submitting}
          activeOpacity={0.85}
          style={[styles.addImageEmpty, submitting && styles.btnDisabled]}
        >
          <Text style={styles.addPlus}>+</Text>
        </TouchableOpacity>
      )}

      {localImageUris.length > 0 && (
        <View style={styles.imageGrid}>
          {localImageUris.map((uri, idx) => (
            <View key={uri} style={styles.imageItem}>
              <Image source={{ uri }} style={styles.image} />
              <TouchableOpacity onPress={() => removeLocalImage(uri)} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}

          {localImageUris.length < 6 && (
            <TouchableOpacity
              onPress={pickImages}
              disabled={submitting}
              activeOpacity={0.85}
              style={[styles.addImageTile, submitting && styles.btnDisabled]}
            >
              <Text style={styles.addPlus}>+</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

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

  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: COLORS.neutral925,
  },
  smallBtnRed: { backgroundColor: COLORS.danger500 },
  smallBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },

  addImageEmpty: {
    width: 110,
    height: 110,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderStyle: 'dashed',
    backgroundColor: COLORS.neutral0,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  addImageTile: {
    width: 100,
    height: 100,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderStyle: 'dashed',
    backgroundColor: COLORS.neutral0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: { fontSize: 28, fontWeight: '700', color: COLORS.neutral800, marginTop: -1 },

  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  imageItem: { width: 100 },
  image: { width: 100, height: 100, borderRadius: 12, backgroundColor: '#f3f4f6' },
  removeBtn: { marginTop: 6, paddingVertical: 6, borderRadius: 10, backgroundColor: '#ef4444' },
  removeBtnText: { textAlign: 'center', color: '#fff', fontWeight: '800', fontSize: 12 },

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
