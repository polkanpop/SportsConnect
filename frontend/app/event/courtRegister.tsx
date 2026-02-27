import React, { useMemo, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { useRouter } from 'expo-router'

import { cloudinarySignUpload, geocodeCourtAddress, registerCourt } from '@/lib/backendApi'
import { getCache, invalidateCache } from '@/lib/cache'
import { useUserId } from '@/hooks/use-user-id'

const COURT_REGISTER_VERIFY_STORAGE_KEY = '@courtRegisterVerifiedLocation'

type Venue = 'Indoor' | 'Outdoor' | 'Both'

export default function CourtRegisterPage() {
  const router = useRouter()
  const { data: userid } = useUserId()

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [price, setPrice] = useState('')
  const [venue, setVenue] = useState<Venue>('Indoor')

  const [localImageUris, setLocalImageUris] = useState<string[]>([])
  const [remoteImageUrls, setRemoteImageUrls] = useState<string[]>([])

  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])

  const canSubmit = useMemo(() => {
    return (
      !!userid &&
      name.trim().length > 0 &&
      address.trim().length > 0 &&
      !submitting
    )
  }, [userid, name, address, submitting])

  const pickImages = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Please allow photo library access to select images.')
      return
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.9,
      selectionLimit: 6,
    } as any)

    if (result.canceled) return
    const picked = (result.assets || []).map(a => a.uri).filter(Boolean)
    if (picked.length === 0) return

    setLocalImageUris(prev => [...prev, ...picked].slice(0, 6))
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

  const handleCheckAddress = async () => {
    const a = address.trim()
    if (!a) {
      Alert.alert('Missing address', 'Please enter an address first.')
      return
    }
    setChecking(true)
    setWarnings([])
    try {
      const geo = await geocodeCourtAddress(a)
      const w = (geo?.warnings || []).filter(Boolean)
      setWarnings(w)
      Alert.alert(
        'Geocode result',
        `${geo?.formatted_address || a}\n\nLat: ${geo.latitude}\nLng: ${geo.longitude}${w.length ? `\n\nWarnings:\n- ${w.join('\n- ')}` : ''}`
      )
    } catch (e: any) {
      Alert.alert('Geocode failed', e?.message || 'Please try again')
    } finally {
      setChecking(false)
    }
  }

  const handleSubmit = async () => {
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

    setSubmitting(true)
    setWarnings([])
    try {
      // If user verified a pin on MapVerify, use those coordinates to ensure it shows on the map immediately.
      let verifiedCoord: { latitude: number; longitude: number } | null = null
      try {
        const saved = await getCache<any>(COURT_REGISTER_VERIFY_STORAGE_KEY)
        const lat = saved?.latitude != null ? Number(saved.latitude) : NaN
        const lng = saved?.longitude != null ? Number(saved.longitude) : NaN
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          verifiedCoord = { latitude: lat, longitude: lng }
        }
      } catch {}
      // Consume + clear it (so it doesn't apply to future registrations)
      try { await invalidateCache(COURT_REGISTER_VERIFY_STORAGE_KEY) } catch {}

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

      const p = Number(price)
      const payload = {
        name: nm,
        address: addr,
        ownerid: userid,
        price: Number.isFinite(p) && p > 0 ? p : 0,
        venue,
        images: urls,
        ...(verifiedCoord ? { latitude: verifiedCoord.latitude, longitude: verifiedCoord.longitude, accuracy_type: 'user_selected' } : {}),
      } as const

      const resp = await registerCourt(payload)
      // Bust cached courtinfo so Map/Court List can reflect new court immediately.
      try { await invalidateCache('cache:courtinfo:v1') } catch {}
      const w = (resp?.geocode?.warnings || []).filter(Boolean)
      setWarnings(w)

      Alert.alert(
        'Court registered',
        `courtid: ${resp.courtid}\ncourtinfoid: ${resp.courtinfoid}${w.length ? `\n\nWarnings:\n- ${w.join('\n- ')}` : ''}`,
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      )
    } catch (e: any) {
      Alert.alert('Register failed', e?.message || 'Please try again')
    } finally {
      setSubmitting(false)
    }
  }

  const removeLocalImage = (uri: string) => {
    setLocalImageUris(prev => prev.filter(x => x !== uri))
    setRemoteImageUrls(prev => prev.filter((_, idx) => localImageUris[idx] !== uri))
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Court Register</Text>

      <Text style={styles.label}>Court Name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="e.g. Saigon Football Field"
        style={styles.input}
      />

      <Text style={styles.label}>Address</Text>
      <TextInput
        value={address}
        onChangeText={setAddress}
        placeholder="Street, City, Country"
        style={[styles.input, { minHeight: 44 }]}
      />

      <View style={styles.rowBetween}>
        <Text style={styles.label}>Price (VND)</Text>
        <TouchableOpacity
          onPress={handleCheckAddress}
          disabled={checking || submitting}
          style={[styles.smallBtn, (checking || submitting) && styles.btnDisabled]}
        >
          <Text style={styles.smallBtnText}>{checking ? 'Checking…' : 'Check Address'}</Text>
        </TouchableOpacity>
      </View>
      <TextInput
        value={price}
        onChangeText={setPrice}
        placeholder="e.g. 200000"
        keyboardType="numeric"
        style={styles.input}
      />

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
        <TouchableOpacity
          onPress={pickImages}
          disabled={submitting}
          style={[styles.smallBtn, submitting && styles.btnDisabled]}
        >
          <Text style={styles.smallBtnText}>Pick Images</Text>
        </TouchableOpacity>
      </View>

      {localImageUris.length > 0 && (
        <View style={styles.imageGrid}>
          {localImageUris.map((uri, idx) => (
            <View key={uri} style={styles.imageItem}>
              <Image source={{ uri }} style={styles.image} />
              <TouchableOpacity onPress={() => removeLocalImage(uri)} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>Remove</Text>
              </TouchableOpacity>
              {!!remoteImageUrls[idx] && <Text style={styles.uploadedTag}>Uploaded</Text>}
            </View>
          ))}
        </View>
      )}

      {warnings.length > 0 && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Warnings</Text>
          {warnings.map((w, i) => (
            <Text key={`${w}-${i}`} style={styles.warningText}>• {w}</Text>
          ))}
        </View>
      )}

      <TouchableOpacity
        onPress={handleSubmit}
        disabled={!canSubmit}
        style={[styles.submitBtn, !canSubmit && styles.btnDisabled]}
        activeOpacity={0.85}
      >
        <Text style={styles.submitText}>{submitting ? 'Registering…' : 'Register Court'}</Text>
      </TouchableOpacity>

      {!userid && (
        <Text style={styles.helpText}>Sign in is required to register a court.</Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  content: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 120 },
  title: { fontSize: 22, fontWeight: '800', color: '#0f172a', textAlign: 'center', marginBottom: 14 },

  label: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 12, marginBottom: 8 },
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
    backgroundColor: '#0f172a',
  },
  smallBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },

  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  imageItem: { width: 100 },
  image: { width: 100, height: 100, borderRadius: 12, backgroundColor: '#f3f4f6' },
  removeBtn: { marginTop: 6, paddingVertical: 6, borderRadius: 10, backgroundColor: '#ef4444' },
  removeBtnText: { textAlign: 'center', color: '#fff', fontWeight: '800', fontSize: 12 },
  uploadedTag: { marginTop: 4, fontSize: 11, fontWeight: '800', color: '#16a34a', textAlign: 'center' },

  warningBox: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    padding: 12,
  },
  warningTitle: { fontSize: 14, fontWeight: '900', color: '#92400e', marginBottom: 6 },
  warningText: { fontSize: 13, color: '#92400e', fontWeight: '700' },

  submitBtn: {
    marginTop: 18,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#2563eb',
  },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '900' },
  btnDisabled: { opacity: 0.45 },

  helpText: { marginTop: 12, textAlign: 'center', color: '#64748b', fontWeight: '700' },
})
