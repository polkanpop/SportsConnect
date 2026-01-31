import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
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
  type CombinedTrainingSession,
  getTrainingSessionInfoBySessionId,
  listTrainingSessionsCombinedByCoachId,
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

export default function TrainingSessionPanel({ coachId }: Props) {
  const router = useRouter()
  const preferredSelectedSessionIdRef = useRef<number | null>(null)

  const [sessions, setSessions] = useState<CombinedTrainingSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState<string | null>(null)

  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const selectedSession = useMemo(
    () => (selectedSessionId != null ? sessions.find((s) => s.sessionid === selectedSessionId) : undefined),
    [sessions, selectedSessionId],
  )

  const [infoMeta, setInfoMeta] = useState<TrainingSessionInfoMeta | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)

  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCap, setEditCap] = useState('')
  const [editEntryFee, setEditEntryFee] = useState('')
  const [editPaymentMethod, setEditPaymentMethod] = useState<'cash' | 'vnpay' | 'both'>('cash')

  const [saving, setSaving] = useState(false)

  const loadSessions = useCallback(
    async (preferredSessionId?: number | null) => {
      if (coachId == null) {
        setSessions([])
        setSelectedSessionId(null)
        return
      }

      setSessionsLoading(true)
      setSessionsError(null)
      try {
        const rows = await listTrainingSessionsCombinedByCoachId(coachId)
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
        setSessionsError(e?.message || String(e))
      } finally {
        setSessionsLoading(false)
      }
    },
    [coachId],
  )

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
        setEditEntryFee(meta?.entry_fee != null ? String(meta.entry_fee) : '')
        const method = String(meta?.support_payment_method || 'cash').toLowerCase()
        if (method === 'vnpay' || method === 'both') setEditPaymentMethod(method)
        else setEditPaymentMethod('cash')
      } catch (e: any) {
        setInfoMeta(null)
        setInfoError(e?.message || String(e))
      } finally {
        setInfoLoading(false)
      }
    })()
  }, [coachId, selectedSessionId, selectedSession?.title, selectedSession?.description])

  const onSave = async () => {
    if (!infoMeta?.sessioninfoid) return

    const cap = safeNumberOrNull(editCap)
    const fee = safeNumberOrNull(editEntryFee)

    setSaving(true)
    setInfoError(null)
    try {
      await updateTrainingSessionInfo(infoMeta.sessioninfoid, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        participants_cap: cap,
        entry_fee: fee,
        support_payment_method: editPaymentMethod,
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

  const disabled = coachId == null

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#F6F7FB' }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={sessionsLoading} onRefresh={() => loadSessions(selectedSessionId)} />}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <Text style={{ fontSize: 20, fontWeight: '900', color: '#111' }}>Training Sessions</Text>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push('/event/tsCreate' as any)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: '#F97316' }}
        >
          <Image source={ICONS.buttonBooking} style={{ width: 18, height: 18, tintColor: '#fff' }} resizeMode="contain" />
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Create</Text>
        </TouchableOpacity>
      </View>

      {disabled && (
        <View style={{ padding: 14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB' }}>
          <Text style={{ color: '#666' }}>Sign in to manage your training sessions.</Text>
        </View>
      )}

      {!!sessionsError && (
        <View style={{ padding: 14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#FECACA', marginBottom: 12 }}>
          <Text style={{ color: '#B91C1C', fontWeight: '700' }}>Failed loading sessions</Text>
          <Text style={{ color: '#991B1B', marginTop: 6 }}>{sessionsError}</Text>
        </View>
      )}

      {/* Session picker */}
      <View style={{ marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '800', color: '#111' }}>My Sessions</Text>
          {sessionsLoading && <ActivityIndicator size="small" />}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 6 }}>
          {sessions.length === 0 ? (
            <View style={{ padding: 14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB', minWidth: 260 }}>
              <Text style={{ color: '#666' }}>No training sessions yet.</Text>
            </View>
          ) : (
            sessions.map((s) => {
              const selected = s.sessionid === selectedSessionId
              return (
                <TouchableOpacity
                  key={s.sessionid}
                  activeOpacity={0.85}
                  onPress={() => setSelectedSessionId(s.sessionid)}
                  style={{
                    width: 280,
                    marginRight: 12,
                    padding: 14,
                    borderRadius: 16,
                    backgroundColor: '#fff',
                    borderWidth: 2,
                    borderColor: selected ? '#F97316' : '#E5E7EB',
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '900', color: '#111' }} numberOfLines={1}>
                    {s.title || `Session #${s.sessionid}`}
                  </Text>
                  <Text style={{ marginTop: 6, color: '#444', fontWeight: '700', fontSize: 12 }}>{formatSessionDateLabel(s)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 }}>
                    <Image source={ICONS.participants} style={{ width: 18, height: 18, tintColor: '#6B7280' }} resizeMode="contain" />
                    <Text style={{ color: '#6B7280', fontWeight: '800', fontSize: 12 }}>
                      {String(s.numberofpeople ?? 0)}/{String(s.participants_cap ?? 0)} participants
                    </Text>
                  </View>
                </TouchableOpacity>
              )
            })
          )}
        </ScrollView>
      </View>

      {/* Modify */}
      <View style={{ padding: 14, borderRadius: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB' }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: '900', color: '#111' }}>Session Modify</Text>
          {selectedSessionId != null && (
            <Pressable onPress={() => router.push((`/event/details?id=created_session_${selectedSessionId}` as any) as any)}>
              <Text style={{ color: '#2563EB', fontWeight: '900', fontSize: 12, textDecorationLine: 'underline' }}>Details</Text>
            </Pressable>
          )}
        </View>

        {infoLoading ? (
          <View style={{ paddingVertical: 18 }}>
            <ActivityIndicator />
          </View>
        ) : infoError ? (
          <Text style={{ color: '#B91C1C', fontWeight: '700' }}>{infoError}</Text>
        ) : selectedSessionId == null ? (
          <Text style={{ color: '#666' }}>Pick a session to edit.</Text>
        ) : (
          <>
            <Text style={{ fontSize: 12, fontWeight: '800', color: '#374151', marginBottom: 6 }}>Title</Text>
            <TextInput
              value={editTitle}
              onChangeText={setEditTitle}
              placeholder="Session title"
              placeholderTextColor="#9CA3AF"
              style={{
                borderWidth: 1,
                borderColor: '#E5E7EB',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: '#111',
                fontWeight: '700',
                marginBottom: 12,
              }}
            />

            <Text style={{ fontSize: 12, fontWeight: '800', color: '#374151', marginBottom: 6 }}>Description</Text>
            <TextInput
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Session description"
              placeholderTextColor="#9CA3AF"
              multiline
              style={{
                borderWidth: 1,
                borderColor: '#E5E7EB',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: '#111',
                fontWeight: '700',
                minHeight: 90,
                marginBottom: 12,
              }}
            />

            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: '#374151', marginBottom: 6 }}>Cap</Text>
                <TextInput
                  value={editCap}
                  onChangeText={setEditCap}
                  placeholder="e.g. 20"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numeric"
                  style={{
                    borderWidth: 1,
                    borderColor: '#E5E7EB',
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    color: '#111',
                    fontWeight: '700',
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: '#374151', marginBottom: 6 }}>Entry fee</Text>
                <TextInput
                  value={editEntryFee}
                  onChangeText={setEditEntryFee}
                  placeholder="empty = free"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numeric"
                  style={{
                    borderWidth: 1,
                    borderColor: '#E5E7EB',
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    color: '#111',
                    fontWeight: '700',
                  }}
                />
              </View>
            </View>

            <Text style={{ fontSize: 12, fontWeight: '800', color: '#374151', marginBottom: 8 }}>Payment method</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
              {(['cash', 'vnpay', 'both'] as const).map((m) => {
                const selected = editPaymentMethod === m
                return (
                  <Pressable
                    key={m}
                    onPress={() => setEditPaymentMethod(m)}
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: selected ? '#F97316' : '#E5E7EB',
                      backgroundColor: selected ? '#FFF7ED' : '#FFFFFF',
                      paddingVertical: 10,
                      borderRadius: 12,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: '#111', fontWeight: selected ? '900' : '800', fontSize: 12 }}>
                      {m === 'cash' ? 'Cash' : m === 'vnpay' ? 'VNPay' : 'Both'}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={onSave}
              disabled={saving || !infoMeta?.sessioninfoid}
              style={{
                height: 46,
                borderRadius: 14,
                backgroundColor: saving ? '#FDBA74' : '#F97316',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '900' }}>{saving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <View style={{ height: 18 }} />

      <View style={{ padding: 14, borderRadius: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB' }}>
        <Text style={{ fontSize: 14, fontWeight: '900', color: '#111' }}>Bookings</Text>
        <Text style={{ marginTop: 6, color: '#6B7280', fontWeight: '700', fontSize: 12 }}>
          Applicant/participant management for sessions is coming next.
        </Text>
      </View>
    </ScrollView>
  )
}
