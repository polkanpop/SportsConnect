import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, TextInput, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listCourtBookings, CourtBookingRow, listCourtInfoCached, CourtInfoRow, createEventWithInfo, CreateEventWithInfoPayload, listEventsCombinedCached, listTrainingSessionsCombined, CombinedEvent, CombinedTrainingSession } from '@/lib/backendApi'
import { useUserId } from '@/hooks/use-user-id'
import { useFocusEffect } from 'expo-router'

// Lightweight enrichment mapping booking -> court info
interface EnrichedBooking extends CourtBookingRow { courtName?: string; address?: string; courtid?: number }

export default function EventCreateScreen() {
  const router = useRouter()
  const { data: userId } = useUserId()
  const qc = useQueryClient()

  // Load user bookings (filtered by userid)
  const { data: bookingsRaw, isLoading: bookingsLoading, error: bookingsError, refetch: refetchBookings } = useQuery({
    queryKey: ['userCourtBookings', userId],
    enabled: typeof userId === 'number',
    queryFn: () => listCourtBookings({ userid: userId! })
  })

  // Fallback: if filtered result returns empty, fetch all then client-filter
  const { data: bookingsAllRaw } = useQuery({
    queryKey: ['courtBookingsAllFallback', userId],
    enabled: typeof userId === 'number' && !bookingsLoading && Array.isArray(bookingsRaw) && bookingsRaw.length === 0,
    queryFn: () => listCourtBookings()
  })

  // Effective bookings list combining filtered result or client-side filtered fallback
  const effectiveBookings: CourtBookingRow[] = useMemo(() => {
    let base: CourtBookingRow[] = []
    if (Array.isArray(bookingsRaw) && bookingsRaw.length) {
      base = bookingsRaw
    } else if (Array.isArray(bookingsAllRaw) && typeof userId === 'number') {
      base = bookingsAllRaw.filter(b => String(b.userid) === String(userId))
    }
    // Ensure uniqueness by courtbookingid to avoid visual duplicates
    const map = new Map<number, CourtBookingRow>()
    for (const b of base) map.set(b.courtbookingid, b)
    return Array.from(map.values())
  }, [bookingsRaw, bookingsAllRaw, userId])

  useEffect(() => {
    if (typeof userId === 'number') {
      console.log('[EventCreate] userId', userId, 'filteredCount', bookingsRaw?.length || 0, 'fallbackAllCount', bookingsAllRaw?.length || 0, 'effectiveCount', effectiveBookings.length)
    }
  }, [userId, bookingsRaw, bookingsAllRaw, effectiveBookings])

  // Load all courtinfo (cached helper) once (could be narrowed later)
  const { data: allCourtInfo } = useQuery({
    queryKey: ['courtInfoAllForEventCreate'],
    queryFn: () => listCourtInfoCached(),
    staleTime: 5*60*1000,
  })

  const [expandedCourts, setExpandedCourts] = useState(false)
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [participantsCap, setParticipantsCap] = useState<string>('')
  const [description, setDescription] = useState('')
  const [monetize, setMonetize] = useState<boolean>(false)
  const [entryFee, setEntryFee] = useState<string>('')
  const [payCash, setPayCash] = useState(false)
  const [payVnPay, setPayVnPay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successData, setSuccessData] = useState<any | null>(null)
  
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
        let ci: CourtInfoRow | undefined
        if (courtid && Array.isArray(allCourtInfo)) ci = allCourtInfo.find(c => c.courtid === courtid)
        result.push({ ...b, courtName: ci?.name ?? undefined, address: ci?.address ?? undefined, courtid })
      }
      return result
    }
  })

  // Fetch events and training sessions to mark used bookings
  const { data: eventsCombined, refetch: refetchEventsCombined } = useQuery({
    queryKey: ['eventsCombinedForCreate'],
    queryFn: () => listEventsCombinedCached(),
    staleTime: 60_000,
  })
  const { data: sessionsCombined, refetch: refetchSessionsCombined } = useQuery({
    queryKey: ['trainingSessionsCombinedForCreate'],
    queryFn: () => listTrainingSessionsCombined(),
    staleTime: 60_000,
  })
  const usedEventBookingIds = useMemo(() => new Set<number>((eventsCombined||[]).map((e:CombinedEvent)=>e.courtbookingid)), [eventsCombined])
  const usedSessionBookingIds = useMemo(() => new Set<number>((sessionsCombined||[]).map((s:CombinedTrainingSession)=>s.courtbookingid)), [sessionsCombined])

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
      const payload: CreateEventWithInfoPayload = {
        courtbookingid: selectedBookingId,
        title: title.trim(),
        description: description.trim() || undefined,
        participants_cap: participantsCapNum,
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
    onSuccess: (data) => {
      setSuccessData(data)
      // Invalidate events list cache so new event appears
      qc.invalidateQueries({ queryKey: ['eventsCombined'] })
      setTimeout(() => {
        router.replace(`/event/eventBooking?eventid=${data.event.eventid}` as any)
      }, 900)
    },
    onError: (err: any) => {
      setSubmitError(err?.message || 'Create failed')
    },
    onSettled: () => setSubmitting(false)
  })

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
    const disabled = isEvent || isTraining
    const tag = isEvent ? 'Event' : (isTraining ? 'Training' : null)
    return (
      <TouchableOpacity
        style={[styles.bookingItem, selectedBookingId === item.courtbookingid && !disabled && styles.bookingItemSelected, disabled && styles.bookingItemDisabled]}
        onPress={() => { if (!disabled) setSelectedBookingId(item.courtbookingid) }}
        disabled={disabled}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.bookingTitleRow}>
            <Text style={styles.bookingTitle} numberOfLines={1}>{item.courtName || `Booking ${item.courtbookingid}`}</Text>
            {tag && <View style={[styles.bookingTag, isEvent ? styles.bookingTagEvent : styles.bookingTagTraining]}><Text style={styles.bookingTagText}>{tag}</Text></View>}
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

  // Refresh bookings when screen gains focus (ensures newly created bookings appear)
  useFocusEffect(
    useCallback(() => {
      if (typeof userId === 'number') {
        refetchBookings()
        // refresh events and training sessions so used booking sets update
        try { refetchEventsCombined() } catch {};
        try { refetchSessionsCombined() } catch {};
      }
    }, [userId, refetchBookings])
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
            {bookingsLoading && <ActivityIndicator size="small" color="#555" />}
            {bookingsError && <Text style={styles.errorText}>{(bookingsError as any)?.message || 'Failed loading bookings'}</Text>}
            {!bookingsLoading && !bookingsError && (!enrichedBookings || enrichedBookings.length===0) && <Text style={styles.smallText}>You have no court bookings yet.</Text>}
            {!bookingsLoading && !bookingsError && enrichedBookings && enrichedBookings.length>0 && availableEnrichedBookings.length===0 && (
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
                {enrichedBookings.map(b => (
                  <React.Fragment key={b.courtbookingid}>
                    {renderBookingItem({ item: b })}
                  </React.Fragment>
                ))}
              </View>
            )}
          </View>

          {/* Event Details */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Details</Text>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Event title" placeholderTextColor="#777" style={styles.input} />
            <Text style={styles.fieldLabel}>Max participants</Text>
            <TextInput value={participantsCap} onChangeText={setParticipantsCap} keyboardType="number-pad" placeholder="e.g. 10" placeholderTextColor="#777" style={styles.input} />
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput value={description} onChangeText={setDescription} placeholder="Describe the event details..." placeholderTextColor="#777" multiline style={[styles.input, styles.inputMultiline]} />
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

          {/* Status / Preview */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Preview</Text>
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
          </View>
        </ScrollView>

        {/* Bottom Create Button */}
        <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
          <View style={styles.bottomBar}>
            <TouchableOpacity
              disabled={!formValid || submitting}
              onPress={onSubmit}
              style={[styles.confirmUnifiedBtn, (!formValid || submitting) && styles.confirmBtnDisabled]}
            >
              <Text style={styles.confirmUnifiedText}>{submitting ? 'Creating...' : 'Create Event'}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
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
  bookingList: { marginTop:12, maxHeight:260 },
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
})
