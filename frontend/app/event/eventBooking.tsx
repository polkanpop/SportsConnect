import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Image, ScrollView, StyleSheet, TextInput, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import {
  adjustEventParticipants,
  createEventBooking,
  createPayment,
  invalidateEventsCombinedCache,
  listEventsCombined,
  listEventsCombinedCached,
  CombinedEvent,
  EventBookingRow,
} from '@/lib/backendApi'
import { useAuthContext } from '@/hooks/use-auth-context'
import { appendHistory } from '@/storage/history'

// Normalise array-ish fields (duplicated helper to avoid import loops)
function asArray(v: any): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

function formatRange(ev: CombinedEvent | null): string {
  if (!ev) return ''
  const start = ev.start_timestamp || ev.time
  const end = ev.end_timestamp
  if (!start) return 'Unknown date'
  try {
    const startD = new Date(start)
    const endD = end ? new Date(end) : null
    const day = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const startTime = startD.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const endTime = endD ? endD.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
    return `${day}, ${startTime}${endTime ? ` - ${endTime}` : ''}`
  } catch { return 'Unknown date' }
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return ''
  const s = String(Math.round(Number(n)))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default function EventBooking() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const params = useLocalSearchParams()
  const eventid = params.eventid ? parseInt(String(params.eventid), 10) : NaN
  const { profile } = useAuthContext()
  const { userId, dashboard } = useAppBootstrap()

  // Fetch combined events list & derive target event
  const { data: eventsCached, isLoading: loadingCached } = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    staleTime: 30_000,
  })
  const needFresh = useMemo(() => Array.isArray(eventsCached) && !eventsCached.some(e => e.eventid === eventid), [eventsCached, eventid])
  const { data: eventsFresh } = useQuery({
    queryKey: ['eventsCombinedFresh', eventid],
    queryFn: () => listEventsCombined(),
    enabled: needFresh && !isNaN(eventid),
    staleTime: 0,
  })
  const allEvents: CombinedEvent[] = useMemo(() => {
    if (needFresh && Array.isArray(eventsFresh)) return eventsFresh
    return Array.isArray(eventsCached) ? eventsCached : []
  }, [needFresh, eventsFresh, eventsCached])
  const loadingEvents = loadingCached && !eventsFresh
  const event: CombinedEvent | null = useMemo(() => allEvents.find(e => e.eventid === eventid) || null, [allEvents, eventid])

  const dashboardRaw = dashboard.data
  const userEventBookingsRaw = dashboardRaw?.event_bookings ?? []

  const alreadyBooked = useMemo(() => {
    if (typeof userId !== 'number') return false
    if (!Number.isFinite(eventid)) return false
    const rows = Array.isArray(userEventBookingsRaw) ? userEventBookingsRaw : []
    return rows.some((b: any) => {
      if (typeof b?.eventid !== 'number') return false
      if (b.eventid !== eventid) return false
      const s = String(b?.bookingstatus ?? b?.status ?? '').toLowerCase()
      return !s.includes('cancel')
    })
  }, [userId, eventid, userEventBookingsRaw])

  const isCancelledEvent = useMemo(() => {
    const s = String(event?.status ?? '').toLowerCase()
    return s.includes('cancel')
  }, [event?.status])

  // UI state
  // Court section no longer collapsible; mirror courtBooking visual layout
  const [courtExpanded] = useState(true)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<EventBookingRow | null>(null)
  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

  const isFree = event?.entry_fee == null
  const allowedMethods: ('cash' | 'vnpay')[] = useMemo(() => {
    if (!event || isFree || !event.support_payment_method) return []
    const m = event.support_payment_method.toLowerCase()
    if (m === 'cash') return ['cash']
    if (m === 'vnpay') return ['vnpay']
    if (m === 'both') return ['cash', 'vnpay']
    return []
  }, [event, isFree])

  const canSubmit = !!event && !!userId && !alreadyBooked && !isCancelledEvent && !submitting && !confirmation && (isFree || (!!paymentMethod))

  const handleSubmit = useCallback(async () => {
    if (!event || userId == null) return
    const cancelled = String(event?.status ?? '').toLowerCase().includes('cancel')
    if (cancelled) {
      setSubmitError('Event was cancelled')
      return
    }
    // For paid events require selected method
    if (!isFree && !paymentMethod) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const bookingStatus = event.join_status ? 'joined' : 'pending'
      const payment = await createPayment({
        status: 'paid',
        method: isFree ? 'cash' : paymentMethod!,
        amount: isFree ? 0 : (event.entry_fee! || 0)
      })
      const booking = await createEventBooking({
        eventid: event.eventid,
        userid: userId,
        status: bookingStatus,
        paymentid: payment.paymentid,
        note: noteText || null,
      })

      if (typeof userId === 'number') {
        void appendHistory(userId, {
          kind: 'payment',
          title: `Payment for ${event.title || `Event ${event.eventid}`}`,
          subtitle: isFree ? 'Free' : `Method: ${paymentMethod}`,
          fromStatus: 'unpaid',
          toStatus: payment.status,
          amount: isFree ? 0 : (event.entry_fee! || 0),
          meta: {
            paymentid: payment.paymentid,
            type: 'event',
            eventid: event.eventid,
            eventbookingid: booking.eventbookingid,
            start_timestamp: event.start_timestamp || event.time || null,
            end_timestamp: event.end_timestamp || null,
          },
        })

        void appendHistory(userId, {
          kind: 'event_booking',
          title: `Booked event: ${event.title || `Event ${event.eventid}`}`,
          subtitle: null,
          fromStatus: 'pending',
          toStatus: String(booking?.status ?? 'pending'),
          meta: {
            eventid: event.eventid,
            eventbookingid: booking.eventbookingid,
            start_timestamp: event.start_timestamp || event.time || null,
            end_timestamp: event.end_timestamp || null,
          },
        })
      }

      // Make Activity/details reflect the booking immediately
      const upsert = (key: readonly unknown[]) => {
        queryClient.setQueryData(key, (prev: any) => {
          const arr = Array.isArray(prev) ? prev : []
          const exists = arr.some((b: any) => {
            if (typeof b?.eventid !== 'number') return false
            if (b.eventid !== event.eventid) return false
            const s = String(b?.bookingstatus ?? b?.status ?? '').toLowerCase()
            return !s.includes('cancel')
          })
          return exists ? arr : [booking, ...arr]
        })
      }
      upsert(queryKeys.eventBookingsUser(userId))
      queryClient.invalidateQueries({ queryKey: queryKeys.eventBookingsUser(userId) })

      // Invalidate combined events cache so eventList / Home reflect the new booking state
      void invalidateEventsCombinedCache()
      void queryClient.invalidateQueries({ queryKey: queryKeys.eventsCombined })
      if (typeof userId === 'number') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userId) })
      }

      // Best-effort participant increment
      const approvalStatus = String((booking as any)?.status ?? '').toLowerCase()
      const isApprovedJoin = approvalStatus.includes('join') || approvalStatus.includes('approve')
      if (isApprovedJoin) {
        try {
          await adjustEventParticipants(event.eventid, +1)
          queryClient.setQueryData(queryKeys.eventsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.eventid !== event.eventid) return row
              const cur = typeof row?.numberofpeople === 'number' ? row.numberofpeople : (row?.numberofpeople == null ? 0 : Number(row.numberofpeople))
              return { ...row, numberofpeople: Number.isFinite(cur) ? cur + 1 : row.numberofpeople }
            })
          })
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userId) })
        } catch {
          // Ignore count sync failures to avoid blocking booking
        }
      }
      
      const invoicePath = String((booking as any)?.status ?? 'pending').toLowerCase().includes('pend')
        ? '/event/invoicePending'
        : '/event/invoice'

      router.replace({
        pathname: invoicePath,
        params: {
          title: event.title,
          courtName: event.court_name || '',
          subtitle: 'Event',
          date: (() => { const d = new Date(event.start_timestamp || event.time || new Date()); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })(),
          time: formatRange(event),
          location: event.address || 'Unknown Location',
          price: isFree ? 0 : event.entry_fee,
          paymentMethod: isFree ? 'Free' : paymentMethod,
          paymentStatus: payment.status,
          bookingStatus: String((booking as any)?.status ?? 'pending'),
          bookingId: booking.eventbookingid,
          note: noteText.trim(),
          type: 'event'
        }
      })
    } catch (e) {
      setSubmitError((e as any)?.message || 'Failed booking')
    } finally { setSubmitting(false) }
  }, [event, userId, paymentMethod, noteText, isFree, router, queryClient])

  const venues = asArray(event?.venue)
  let venueDisplay: string[] = []
  if (venues.length) {
    const lower = venues.map(v => v.toLowerCase())
    if (lower.includes('indoor') && lower.includes('outdoor')) venueDisplay = ['In/Outdoor']
    else venueDisplay = [venues[0]]
  }

  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']} style={styles.headerSafeArea}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Image source={ICONS.arrowLeft} style={styles.backIcon} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Event Booking</Text>
        </View>
      </SafeAreaView>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 220, paddingTop: 12 }}>
        <View style={styles.sectionCard}>
          {loadingEvents && <Text style={styles.statusText}>Loading event...</Text>}
          {!loadingEvents && !event && <Text style={styles.errorText}>Event not found.</Text>}
          {!loadingEvents && !!event && isCancelledEvent && (
            <View style={{ backgroundColor: '#ffe5e5', borderColor: '#cc0000', borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 10 }}>
              <Text style={{ color: '#cc0000', fontWeight: '700' }}>This event was cancelled.</Text>
              <Text style={{ color: '#cc0000', marginTop: 2 }}>Booking is disabled.</Text>
            </View>
          )}
          {event && (
            <View style={styles.titleRowInline}>
              <Text style={styles.eventTitle}>{event.title || `Event ${event.eventid}`}</Text>
            </View>
          )}
          {event && (
            <>
              <Text style={styles.eventTime}>{formatRange(event)}</Text>
              <Text style={styles.eventFee}>{isFree ? 'Entry: Free' : `Entry Fee: ${formatCurrency(event.entry_fee)}₫/player`}</Text>
              <Text style={styles.eventDesc}>Description: {event.description || 'No description'}</Text>
            </>
          )}
        </View>
        {event && (
          <View style={styles.sectionCard}>
            <View style={styles.courtHeaderRow}>
              {(() => {
                const venueRaw = event.venue
                const venueTokens = asArray(venueRaw).map(v => v.toLowerCase())
                const hasIndoor = venueTokens.some(t => t.includes('indoor'))
                const hasOutdoor = venueTokens.some(t => t.includes('outdoor'))
                let iconSrc: any = null
                if (hasIndoor && hasOutdoor) iconSrc = ICONS.bothVenue
                else if (hasIndoor) iconSrc = ICONS.indoorIcon
                else if (hasOutdoor) iconSrc = ICONS.outdoorIcon
                return iconSrc ? <Image source={iconSrc} style={styles.venueIcon} /> : null
              })()}
              <Text style={styles.courtNameText}>{event.court_name || 'Court'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Image source={ICONS.mapPin} style={styles.metaIcon} />
              <Text style={styles.courtAddress}>{event.address || 'Address N/A'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Image source={ICONS.clock} style={styles.metaIcon} />
              <Text style={styles.eventTime}>{formatRange(event)}</Text>
            </View>
          </View>
        )}
        {event && (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>{isFree ? 'Payment' : `Payment (${formatCurrency(event.entry_fee)}₫/player)`}</Text>
            {isFree && <Text style={styles.freeNote}>This event entry is free</Text>}
            {!isFree && (
              <View style={{marginTop:4}}>
                <Text style={styles.paymentMeta}>Select payment method:</Text>
                <View style={styles.paymentRow}>
                  {allowedMethods.map(m => {
                    const active = paymentMethod === m
                    return (
                      <TouchableOpacity key={m} style={[styles.payMethodBtn, active && styles.payMethodActive]} onPress={() => setPaymentMethod(m)}>
                        <Image source={m === 'cash' ? ICONS.cashIcon : ICONS.vnpayIcon} style={styles.payIcon} />
                        <Text style={styles.payText}>{m === 'cash' ? 'Cash' : 'VNPay'}</Text>
                      </TouchableOpacity>
                    )
                  })}
                  {allowedMethods.length === 0 && <Text style={styles.smallText}>No supported methods.</Text>}
                </View>
              </View>
            )}
          </View>
        )}
        {/* Note Section */}
        <View style={styles.sectionCard}>
          <TouchableOpacity style={styles.noteRow} onPress={() => setNoteExpanded(n => !n)}>
            <Image source={ICONS.noteIcon} style={styles.noteIcon} />
            <Text style={styles.noteTextLabel}>Add a note (optional)</Text>
            <Image source={ICONS.arrowright} style={[styles.noteArrow, noteExpanded && styles.noteArrowExpanded]} />
          </TouchableOpacity>
          {noteExpanded && (
            <View style={styles.noteInputWrapper}>
              <TextInput
                placeholder='Type your note here...'
                placeholderTextColor={'#888'}
                value={noteText}
                onChangeText={setNoteText}
                multiline
                style={styles.noteInput}
              />
            </View>
          )}
        </View>
        {submitError && <Text style={[styles.errorText,{marginHorizontal:16}]}>{submitError}</Text>}
        {confirmation && (
          <View style={[styles.sectionCard, { backgroundColor: '#e9ffe9' }] }>
            <Text style={styles.successTitle}>Booking Submitted</Text>
            <Text style={styles.successLine}>Status: pending</Text>
            <Text style={styles.successLine}>Event: {event?.title || event?.eventid}</Text>
            <Text style={styles.successLine}>Time: {formatRange(event)}</Text>
            <Text style={styles.successLine}>Payment Method: {isFree ? 'cash (free)' : paymentMethod}</Text>
          </View>
        )}
      </ScrollView>
      {/* Bottom confirm button */}
      {!confirmation && (
        <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={[styles.confirmUnifiedBtn, !canSubmit && styles.confirmBtnDisabled]}
              disabled={!canSubmit}
              onPress={() => setConfirmModalVisible(true)}
            >
              <Text style={styles.confirmUnifiedText}>
                {submitting ? 'Submitting...' : alreadyBooked ? 'Already Booked' : 'Confirm Booking'}
              </Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      )}

      <Modal
        transparent={true}
        visible={confirmModalVisible}
        animationType="fade"
        onRequestClose={() => setConfirmModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Booking</Text>
            <Text style={styles.modalBody}>Are you sure you want to book this event?</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmModalVisible(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm]} onPress={() => {
                setConfirmModalVisible(false)
                handleSubmit()
              }} disabled={!canSubmit}>
                <Text style={[styles.modalBtnText, {color: '#fff'}]}>
                  Confirm
                </Text>
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
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  backBtn: { padding: 10, borderRadius: 28, backgroundColor: '#f2f2f2', justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 22, height: 22, tintColor: '#333', resizeMode: 'contain' },
  headerTitle: { fontSize: 18, fontWeight: '700', marginLeft: 12 },
  sectionCard: { backgroundColor: '#fafafa', marginHorizontal: 16, marginBottom: 20, padding: 16, borderRadius: 14, elevation: 2 },
  container: { flex: 1 },
  headerSafeArea: { backgroundColor: '#fff' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  statusText: { fontSize: 12, color: '#666' },
  errorText: { color: '#c00', fontSize: 12, fontWeight: '600' },
  eventTitle: { fontSize: 18, fontWeight: '700', color: '#222' },
  eventTime: { fontSize: 13, color: '#555', marginTop: 6 },
  eventFee: { fontSize: 13, color: '#333', marginTop: 6, fontWeight: '600' },
  eventDesc: { fontSize: 12, color: '#444', lineHeight: 18, marginTop: 8 },
  titleRowInline: { flexDirection: 'row', alignItems: 'center' },
  courtNameText: { fontSize: 18, fontWeight: '700', color: '#222' },
  courtHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  expandIcon: { width: 18, height: 18, tintColor: '#333', resizeMode: 'contain' },
  courtAddress: { fontSize: 13, color: '#555', marginTop: 4 },
  venueIcon: { width:28, height:28, resizeMode:'contain', marginRight:8 },
  metaRow: { flexDirection:'row', alignItems:'center', marginTop:8 },
  metaIcon: { width:18, height:18, tintColor:'#555', marginRight:8, resizeMode:'contain' },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  tag: { backgroundColor: '#eee', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, marginRight: 6, marginBottom: 6 },
  tagFallback: { backgroundColor: '#eee' },
  venueTag: { backgroundColor: '#6a5acd' },
  tagText: { fontSize: 12, fontWeight: '600', color: '#333' },
  paymentRow: { flexDirection: 'row', marginTop: 12 },
  payMethodBtn: { flex: 1, paddingVertical: 12, paddingHorizontal: 12, backgroundColor: '#eaeaea', marginRight: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center' },
  payMethodActive: { backgroundColor: '#FFA500' },
  payIcon: { width: 24, height: 24, marginRight: 8, resizeMode: 'contain' },
  payText: { fontSize: 14, fontWeight: '700', color: '#222' },
  paymentMeta: { fontSize: 12, fontWeight: '600', color: '#555' },
  freeNote: { fontSize: 12, color: '#2e8b57', fontWeight: '700' },
  smallText: { fontSize: 12, color: '#666' },
  noteRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12 },
  noteIcon: { width: 22, height: 22, marginRight: 10, resizeMode: 'contain' },
  noteTextLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: '#222' },
  noteArrow: { width: 18, height: 18, resizeMode: 'contain' },
  noteArrowExpanded: { transform: [{ rotate: '90deg' }] },
  noteInputWrapper: { marginTop: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 10 },
  noteInput: { minHeight: 80, padding: 10, fontSize: 14, color: '#222', textAlignVertical: 'top' },
  bottomBar: { paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'center' },
  bottomSafeArea: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
  confirmUnifiedBtn: { width: '90%', backgroundColor: '#FF5733', paddingVertical: 18, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  confirmUnifiedText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  confirmBtnDisabled: { backgroundColor: '#ccc' },
  successTitle: { fontSize: 14, fontWeight: '700', color: '#0a7a0a' },
  successLine: { fontSize: 12, color: '#0a7a0a', marginTop: 4 },
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
