import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { View, Text, TouchableOpacity, Image, StyleSheet, TextInput, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  adjustTrainingSessionParticipants,
  createTrainingSessionBooking,
  createTrainingSessionWithInfo,
  CreateTrainingSessionWithInfoPayload,
  invalidateTrainingSessionsCombinedCache,
  listCourtBookings,
  CourtBookingRow,
  listCourtInfoCached,
  listTrainingSessionsCombined,
  listTrainingSessionsCombinedCached,
  listEventsCombinedCached,
} from '@/lib/backendApi'
import { queryKeys } from '@/hooks/query-keys'
import { useUserId } from '@/hooks/use-user-id'
import { useFocusEffect } from 'expo-router'

interface EnrichedBooking extends CourtBookingRow { courtName?: string; address?: string; courtid?: number }

export default function TsCreate() {
  const router = useRouter()
  const { data: userId } = useUserId()
  const qc = useQueryClient()

  const { data: bookingsRaw, isLoading: bookingsLoading, error: bookingsError, refetch: refetchBookings } = useQuery({
    queryKey: ['userCourtBookings', userId],
    enabled: typeof userId === 'number',
    queryFn: () => listCourtBookings({ userid: userId! })
  })

  const { data: bookingsAllRaw } = useQuery({
    queryKey: ['courtBookingsAllFallback', userId],
    enabled: typeof userId === 'number' && !bookingsLoading && Array.isArray(bookingsRaw) && bookingsRaw.length === 0,
    queryFn: () => listCourtBookings()
  })

  const effectiveBookings: CourtBookingRow[] = useMemo(() => {
    let base: CourtBookingRow[] = []
    if (Array.isArray(bookingsRaw) && bookingsRaw.length) base = bookingsRaw
    else if (Array.isArray(bookingsAllRaw) && typeof userId === 'number') base = bookingsAllRaw.filter(b => String(b.userid) === String(userId))
    const map = new Map<number, CourtBookingRow>()
    for (const b of base) map.set(b.courtbookingid, b)
    return Array.from(map.values())
  }, [bookingsRaw, bookingsAllRaw, userId])

  const { data: allCourtInfo } = useQuery({ queryKey: ['courtInfoAllForTsCreate'], queryFn: () => listCourtInfoCached(), staleTime: 5*60*1000 })

  const [expandedCourts, setExpandedCourts] = useState(false)
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [participantsCap, setParticipantsCap] = useState<string>('')
  const [description, setDescription] = useState('')
  const [addMeToParticipants, setAddMeToParticipants] = useState(true)
  const [monetize, setMonetize] = useState<boolean>(false)
  const [entryFee, setEntryFee] = useState<string>('')
  const [payCash, setPayCash] = useState(false)
  const [payVnPay, setPayVnPay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successData, setSuccessData] = useState<any | null>(null)
  const [previewOpen, setPreviewOpen] = useState<boolean>(true)
  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

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

  const { data: enrichedBookings, isLoading: enriching } = useQuery({
    queryKey: ['enrichedBookings', effectiveBookings],
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
        let ci: any | undefined
        if (courtid && Array.isArray(allCourtInfo)) ci = allCourtInfo.find((c:any) => c.courtid === courtid)
        result.push({ ...b, courtName: ci?.name ?? undefined, address: ci?.address ?? undefined, courtid })
      }
      return result
    }
  })

  const { data: sessionsCombined, refetch: refetchSessionsCombined } = useQuery({ queryKey: ['trainingSessionsCombinedForCreate'], queryFn: () => listTrainingSessionsCombined(), staleTime: 60_000 })
  const { data: eventsCombined, refetch: refetchEventsCombined } = useQuery({ queryKey: ['eventsCombinedForCreate'], queryFn: () => listEventsCombinedCached(), staleTime: 60_000 })
  const usedSessionBookingIds = useMemo(() => new Set<number>((sessionsCombined||[]).map((s:any)=>s.courtbookingid)), [sessionsCombined])
  const usedEventBookingIds = useMemo(() => new Set<number>((eventsCombined||[]).map((e:any)=>e.courtbookingid)), [eventsCombined])

  const availableEnrichedBookings = useMemo(() => {
    if (!enrichedBookings) return [] as EnrichedBooking[]
    return enrichedBookings.filter(b => !usedSessionBookingIds.has(b.courtbookingid) && !usedEventBookingIds.has(b.courtbookingid))
  }, [enrichedBookings, usedSessionBookingIds, usedEventBookingIds])

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

  const paymentMethodsValue = useMemo<('cash'|'vnpay'|'both')[] | null>(() => {
    if (!monetize) return null
    const arr: ('cash'|'vnpay'|'both')[] = []
    if (payCash) arr.push('cash')
    if (payVnPay) arr.push('vnpay')
    return arr
  }, [monetize, payCash, payVnPay])

  const participantsCapNum = useMemo(() => { const n = parseInt(participantsCap, 10); return Number.isFinite(n) ? n : 0 }, [participantsCap])
  const entryFeeNum = useMemo(() => { const n = parseInt(entryFee, 10); return Number.isFinite(n) ? n : 0 }, [entryFee])

  const formValid = useMemo(() => {
    if (!selectedBookingId) return false
    if (!title.trim()) return false
    if (participantsCapNum <= 0) return false
    if (monetize) {
      if (entryFeeNum <= 0) return false
      if (!paymentMethodsValue || paymentMethodsValue.length === 0) return false
    }
    return true
  }, [selectedBookingId, title, participantsCapNum, monetize, entryFeeNum, paymentMethodsValue])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!formValid || !selectedBookingId) throw new Error('Invalid form')
      setSubmitError(null); setSuccessData(null)
      const payload: CreateTrainingSessionWithInfoPayload = {
        courtbookingid: selectedBookingId,
        title: title.trim(),
        description: description.trim() || undefined,
        participants_cap: participantsCapNum,
        monetize,
        coachid: typeof userId === 'number' ? userId : undefined,
      }
      if (monetize) {
        payload.entry_fee = entryFeeNum
        payload.payment_methods = paymentMethodsValue!
      }
      const resp = await createTrainingSessionWithInfo(payload)
      return resp
    },
    onSuccess: (data) => {
      setSuccessData(data)

      const createdSessionId = typeof data?.session?.sessionid === 'number' ? data.session.sessionid : null

      // Make the created session show up immediately in lists + details.
      if (typeof createdSessionId === 'number') {
        const sessionRow: any = data?.session
        const infoRow: any = data?.info
        const combinedRow: any = {
          sessionid: createdSessionId,
          time: sessionRow?.time,
          status: sessionRow?.status ?? 'upcoming',
          courtbookingid: sessionRow?.courtbookingid,
          coachid: sessionRow?.coachid ?? (typeof userId === 'number' ? userId : undefined),
          coachName: null,
          title: infoRow?.title ?? title.trim(),
          description: infoRow?.description ?? (description.trim() || null),
          numberofpeople: infoRow?.numberofpeople ?? 0,
          participants_cap: infoRow?.participants_cap ?? participantsCapNum,
          entry_fee: infoRow?.entry_fee ?? null,
          support_payment_method: infoRow?.support_payment_method ?? null,
          join_status: infoRow?.join_status ?? null,
          start_timestamp: selectedBooking?.start_timestamp ?? null,
          end_timestamp: selectedBooking?.end_timestamp ?? null,
          address: selectedBooking?.address ?? undefined,
          court_name: selectedBooking?.courtName ?? null,
        }

        qc.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
          const arr = Array.isArray(prev) ? prev : []
          if (arr.some((r: any) => r?.sessionid === createdSessionId)) return arr
          return [combinedRow, ...arr]
        })
        if (typeof userId === 'number') {
          qc.setQueryData(['createdTrainingSessionsCombined', userId], (prev: any) => {
            const arr = Array.isArray(prev) ? prev : []
            if (arr.some((r: any) => r?.sessionid === createdSessionId)) return arr
            return [combinedRow, ...arr]
          })
        }

        qc.setQueryData(['details', 'createdSession', createdSessionId], sessionRow)
        qc.setQueryData(['details', 'createdSessionInfo', createdSessionId], infoRow)
      }

      const bumpParticipantsInSessionsCombined = (sessionId: number, delta: number) => {
        qc.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row: any) => {
            if (row?.sessionid !== sessionId) return row
            const cur = Number(row?.numberofpeople)
            const curN = Number.isFinite(cur) ? cur : 0
            return { ...row, numberofpeople: Math.max(0, curN + delta) }
          })
        })
      }

      const upsertUserBookingCache = (booking: any) => {
        if (typeof userId !== 'number') return
        qc.setQueryData(['trainingSessionBookingsByUserId', userId], (prev: any) => {
          const arr = Array.isArray(prev) ? prev : []
          const exists = arr.some((b: any) => {
            if (typeof b?.sessionid !== 'number') return false
            if (b.sessionid !== booking?.sessionid) return false
            const s = String(b?.bookingstatus ?? b?.status ?? '').toLowerCase()
            return !s.includes('cancel')
          })
          return exists ? arr : [booking, ...arr]
        })
      }

      // Optional: automatically join as a participant so the creator doesn't need to book again.
      if (addMeToParticipants && typeof userId === 'number' && typeof createdSessionId === 'number') {
        const sessionId = createdSessionId
        void (async () => {
          try {
            const booking = await createTrainingSessionBooking({
              sessionid: sessionId,
              userid: userId,
              status: 'pending',
              bookingstatus: 'upcoming',
              note: null,
            } as any)
            upsertUserBookingCache(booking)
            bumpParticipantsInSessionsCombined(sessionId, +1)

            try { await adjustTrainingSessionParticipants(sessionId, +1) } catch {}

            void invalidateTrainingSessionsCombinedCache()
            qc.invalidateQueries({ queryKey: queryKeys.trainingSessionsCombined })
          } catch {}

          qc.invalidateQueries({ queryKey: ['trainingSessionBookingsByUserId', userId] })
        })()
      }

      void invalidateTrainingSessionsCombinedCache()
      qc.invalidateQueries({ queryKey: queryKeys.trainingSessionsCombined })
      // clear draft on success
      try { AsyncStorage.removeItem('@tsCreate:draft') } catch {}

      const detailsId = typeof createdSessionId === 'number' ? `created_session_${createdSessionId}` : undefined
      setTimeout(() => { router.replace({ pathname: '/event/CreationInfo', params: { type: 'training', detailsId } }) }, 900)
    },
    onError: (err: any) => setSubmitError(err?.message || 'Create failed'),
    onSettled: () => setSubmitting(false)
  })

  // Draft persistence: load on mount
  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem('@tsCreate:draft')
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (!mounted || !parsed) return
        if (typeof parsed.title === 'string') setTitle(parsed.title)
        if (typeof parsed.participantsCap === 'string') setParticipantsCap(parsed.participantsCap)
        if (typeof parsed.description === 'string') setDescription(parsed.description)
        if (typeof parsed.addMeToParticipants === 'boolean') setAddMeToParticipants(parsed.addMeToParticipants)
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
        title, participantsCap, description, addMeToParticipants, monetize, entryFee, payCash, payVnPay, selectedBookingId
      }
      try { AsyncStorage.setItem('@tsCreate:draft', JSON.stringify(payload)) } catch (e) {}
    }, 400)
    return () => clearTimeout(t)
  }, [title, participantsCap, description, addMeToParticipants, monetize, entryFee, payCash, payVnPay, selectedBookingId])

  const onSubmit = () => {
    if (submitting) return
    let bookingToUseId = selectedBookingId
    const isSelectedAvailable = bookingToUseId != null && availableEnrichedBookings.some(b => b.courtbookingid === bookingToUseId)
    if (!isSelectedAvailable) {
      if (availableEnrichedBookings.length > 0) { bookingToUseId = availableEnrichedBookings[0].courtbookingid; setSelectedBookingId(bookingToUseId) }
      else { setSubmitError('No available bookings to create a session.'); return }
    }
    if (!title.trim()) { setSubmitError('Please enter a title'); return }
    if (participantsCapNum <= 0) { setSubmitError('Please set max participants'); return }
    if (monetize) {
      if (entryFeeNum <= 0) { setSubmitError('Please set a valid entry fee'); return }
      if (!paymentMethodsValue || paymentMethodsValue.length === 0) { setSubmitError('Please select a payment method'); return }
    }
    setSubmitError(null); setSuccessData(null); setSubmitting(true)
    mutation.mutate({ _bookingFallbackId: bookingToUseId } as any)
  }

  const renderBookingItem = ({ item }: { item: EnrichedBooking }) => {
    const isSession = usedSessionBookingIds.has(item.courtbookingid)
    const isEvent = usedEventBookingIds.has(item.courtbookingid)
    const disabled = isSession || isEvent
    const tag = isSession ? 'Training' : (isEvent ? 'Event' : null)
    return (
      <TouchableOpacity
        style={[styles.bookingItem, selectedBookingId === item.courtbookingid && !disabled && styles.bookingItemSelected, disabled && styles.bookingItemDisabled]}
        onPress={() => { if (!disabled) setSelectedBookingId(item.courtbookingid) }}
        disabled={disabled}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.bookingTitleRow}>
            <Text style={styles.bookingTitle} numberOfLines={1}>{item.courtName || `Booking ${item.courtbookingid}`}</Text>
            {tag && <View style={[styles.bookingTag, isSession ? styles.bookingTagTraining : styles.bookingTagEvent]}><Text style={styles.bookingTagText}>{tag}</Text></View>}
          </View>
          {item.address && <Text style={styles.bookingMeta} numberOfLines={1}>{item.address}</Text>}
          <Text style={styles.bookingMeta}>{formatRange(item.start_timestamp as any, item.end_timestamp as any)}</Text>
        </View>
        <Image source={ICONS.arrowright} style={styles.bookingArrow} />
      </TouchableOpacity>
    )
  }

  useEffect(() => {
    if (!bookingsLoading && Array.isArray(availableEnrichedBookings) && availableEnrichedBookings.length && selectedBookingId == null) {
      setSelectedBookingId(availableEnrichedBookings[0].courtbookingid)
    }
  }, [bookingsLoading, availableEnrichedBookings, selectedBookingId])

  useEffect(() => {
    if (selectedBookingId != null) {
      const stillAvailable = availableEnrichedBookings.some(b => b.courtbookingid === selectedBookingId)
      if (!stillAvailable) { if (availableEnrichedBookings.length) setSelectedBookingId(availableEnrichedBookings[0].courtbookingid); else setSelectedBookingId(null) }
    }
  }, [availableEnrichedBookings, selectedBookingId])

  useFocusEffect(useCallback(() => { if (typeof userId === 'number') { refetchBookings(); try { refetchSessionsCombined() } catch {}; try { refetchEventsCombined() } catch {} } }, [userId, refetchBookings]))

  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 220 }}>
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Image source={ICONS.arrowLeft} style={styles.backIcon} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Create Training Session</Text>
          </View>
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Court Booking</Text>
              <TouchableOpacity onPress={() => setExpandedCourts(e => !e)} style={styles.expandBtn}>
                <Image source={ICONS.arrowdown} style={[styles.expandIcon, expandedCourts && { transform:[{ rotate: '180deg'}] }]} />
              </TouchableOpacity>
            </View>
            {bookingsLoading && <ActivityIndicator size="small" color="#555" />}
            {bookingsError && <Text style={styles.errorText}>{(bookingsError as any)?.message || 'Failed loading bookings'}</Text>}
            {!bookingsLoading && !bookingsError && (!enrichedBookings || enrichedBookings.length===0) && <Text style={styles.smallText}>You have no court bookings yet.</Text>}
            {!bookingsLoading && !bookingsError && enrichedBookings && enrichedBookings.length>0 && availableEnrichedBookings.length===0 && (
              <Text style={styles.smallText}>No available courts for training session booking.</Text>
            )}
            {selectedBookingId && (
              <View style={styles.selectedBookingBox}>
                <View style={styles.bookingTitleRow}>
                  <Text style={styles.selectedBookingTitle}>{enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.courtName || 'Selected Booking'}</Text>
                  {usedSessionBookingIds.has(selectedBookingId) && <View style={[styles.bookingTag, styles.bookingTagTraining]}><Text style={styles.bookingTagText}>Training</Text></View>}
                  {usedEventBookingIds.has(selectedBookingId) && <View style={[styles.bookingTag, styles.bookingTagEvent]}><Text style={styles.bookingTagText}>Event</Text></View>}
                </View>
                <Text style={styles.selectedBookingMeta}>{enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.address}</Text>
                <Text style={styles.selectedBookingMeta}>{formatRange(enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.start_timestamp as any, enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.end_timestamp as any)}</Text>
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
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Details</Text>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Session title" placeholderTextColor="#777" style={styles.input} />
            <Text style={styles.fieldLabel}>Max participants</Text>
            <TextInput value={participantsCap} onChangeText={setParticipantsCap} keyboardType="number-pad" placeholder="e.g. 10" placeholderTextColor="#777" style={styles.input} />
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput value={description} onChangeText={setDescription} placeholder="Describe the session details..." placeholderTextColor="#777" multiline style={[styles.input, styles.inputMultiline]} />

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
          </View>
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
            <Text style={styles.monetizeNote}>{monetize ? 'Note: Each player entering the session will be charged the amount below; please select the price and payment methods carefully.' : 'Note: All players enter the session at no cost!'}</Text>
            {monetize && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.fieldLabel}>Entry Fee (VND)</Text>
                <TextInput value={entryFee} onChangeText={setEntryFee} keyboardType="number-pad" placeholder="e.g. 30,000" placeholderTextColor="#777" style={styles.input} />
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
                <Text style={styles.previewLine}>Location: {selectedBookingId ? (enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.courtName || selectedBookingId) : 'None'}</Text>
                <Text style={styles.previewLine}>Time: {selectedBookingId ? formatRange(enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.start_timestamp as any, enrichedBookings?.find(b=>b.courtbookingid===selectedBookingId)?.end_timestamp as any) : 'N/A'}</Text>
                <Text style={styles.previewLine}>Max participants: {participantsCapNum || 'N/A'}</Text>
                {monetize ? (
                  <Text style={styles.previewLine}>Entry Fee: {entryFeeNum > 0 ? entryFeeNum.toLocaleString() + ' VND' : 'N/A'} | Methods: {paymentMethodsValue?.join(', ') || 'None'}</Text>
                ) : (
                  <Text style={styles.previewLine}>Entry Fee: Free</Text>
                )}
                {submitError && <Text style={styles.errorText}>{submitError}</Text>}
                {successData && (
                  <View style={styles.successBox}>
                    <Text style={styles.successTitle}>Session Created!</Text>
                    <Text style={styles.successLine}>ID: {successData.session.sessionid}</Text>
                    <Text style={styles.successLine}>Title: {successData.sessioninfo.title}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <View style={[styles.bottomSafeArea, { paddingBottom: 12 }]}>
        <View style={styles.bottomBar}>
          <TouchableOpacity onPress={() => setConfirmModalVisible(true)} disabled={!formValid || submitting} style={[styles.confirmUnifiedBtn, (!formValid || submitting) && styles.confirmBtnDisabled]}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmUnifiedText}>Create Session</Text>}
          </TouchableOpacity>
        </View>
      </View>

      <Modal
        transparent={true}
        visible={confirmModalVisible}
        animationType="fade"
        onRequestClose={() => setConfirmModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Creation</Text>
            <Text style={styles.modalBody}>Are you sure you want to create this session?</Text>
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
    </View>
  )
}

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
  bookingList: { marginTop:12, maxHeight:260 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  checkboxBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: '#bbb', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  checkboxBoxChecked: { backgroundColor: '#FF5733', borderColor: '#FF5733' },
  checkboxTick: { color: '#fff', fontWeight: '900', fontSize: 14, marginTop: -1 },
  checkboxLabel: { marginLeft: 10, color: '#222', fontWeight: '700' },
  bookingItem: { flexDirection:'row', alignItems:'center', backgroundColor:'#eee', padding:12, borderRadius:12, marginBottom:10 },
  bookingItemSelected: { backgroundColor:'#FFD700' },
  bookingItemDisabled: { opacity:0.5 },
  bookingTitleRow: { flexDirection:'row', alignItems:'center' },
  bookingTag: { marginLeft:6, backgroundColor:'#444', paddingHorizontal:6, paddingVertical:2, borderRadius:8 },
  bookingTagEvent: { backgroundColor:'#ff6b3b' },
  bookingTagTraining: { backgroundColor:'#6a5acd' },
  bookingTagText: { color:'#fff', fontSize:10, fontWeight:'700' },
  bookingTitle: { fontSize:14, fontWeight:'700', color:'#222' },
  bookingMeta: { fontSize:11, color:'#555', marginTop:2 },
  bookingArrow: { width:16, height:16, tintColor:'#333' },
  selectedBookingBox: { backgroundColor:'#e9e9e9', padding:12, borderRadius:12, marginTop:6 },
  selectedBookingTitle: { fontSize:14, fontWeight:'700', color:'#222' },
  selectedBookingMeta: { fontSize:11, color:'#444', marginTop:4 },
  fieldLabel: { fontSize:13, fontWeight:'600', color:'#333', marginBottom:6, marginTop:4 },
  input: { backgroundColor:'#fff', borderWidth:1, borderColor:'#ddd', borderRadius:10, paddingHorizontal:12, paddingVertical:10, fontSize:14, color:'#222', marginBottom:12 },
  inputMultiline: { minHeight:100, textAlignVertical:'top' },
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


