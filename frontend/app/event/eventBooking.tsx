import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Image, ScrollView, StyleSheet, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import { listEventsCombinedCached, CombinedEvent, createPayment, createEventBooking, PaymentRow, EventBookingRow, listEventsCombined } from '@/lib/backendApi'
import { useUserId } from '@/hooks/use-user-id'
import { useAuthContext } from '@/hooks/use-auth-context'

// Normalise sport/venue (duplicated helper to avoid import loops)
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
  const params = useLocalSearchParams()
  const eventid = params.eventid ? parseInt(String(params.eventid), 10) : NaN
  const { profile } = useAuthContext()
  const { data: userId } = useUserId()

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

  // UI state
  // Court section no longer collapsible; mirror courtBooking visual layout
  const [courtExpanded] = useState(true)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<EventBookingRow | null>(null)

  const isFree = event?.entry_fee == null
  const allowedMethods: ('cash' | 'vnpay')[] = useMemo(() => {
    if (!event || isFree || !event.support_payment_method) return []
    const m = event.support_payment_method.toLowerCase()
    if (m === 'cash') return ['cash']
    if (m === 'vnpay') return ['vnpay']
    if (m === 'both') return ['cash', 'vnpay']
    return []
  }, [event, isFree])

  const canSubmit = !!event && !!userId && !submitting && !confirmation && (isFree || (!!paymentMethod))

  const handleSubmit = useCallback(async () => {
    if (!event || userId == null) return
    // For paid events require selected method
    if (!isFree && !paymentMethod) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payment = await createPayment({
        status: isFree ? 'paid' : 'pending',
        method: isFree ? 'cash' : paymentMethod!,
        amount: isFree ? 0 : (event.entry_fee! || 0)
      })
      const booking = await createEventBooking({
        eventid: event.eventid,
        userid: userId,
        status: 'pending',
        paymentid: payment.paymentid,
        note: noteText || null,
      })
      setConfirmation(booking)
    } catch (e) {
      setSubmitError((e as any)?.message || 'Failed booking')
    } finally { setSubmitting(false) }
  }, [event, userId, paymentMethod, noteText, isFree])

  const sports = asArray(event?.sport)
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
          {event && (
            <View style={styles.titleRowInline}>
              <Image source={ICONS.starCal} style={styles.leadingCalIcon} />
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
            {(() => {
              const sportTokens = sports
              const tags = sportTokens.map(t => String(t).trim()).filter(t => t.length)
              if (!tags.length) return null
              const SPORT_COLORS: Record<string, { bg: string; color: string; border?: string }> = {
                football: { bg: '#ffffff', color: '#111', border: '#ddd' },
                soccer: { bg: '#ffffff', color: '#111', border: '#ddd' },
                tennis: { bg: '#32CD32', color: '#fff' },
                tabletennis: { bg: '#32CD32', color: '#fff' },
                badminton: { bg: '#32CD32', color: '#fff' },
                basketball: { bg: '#FFA500', color: '#111' },
                volleyball: { bg: '#FFA500', color: '#111' },
                golf: { bg: '#2e8b57', color: '#fff' },
                running: { bg: '#4682B4', color: '#fff' },
                pickleball: { bg: '#FF69B4', color: '#111' },
              }
              const normaliseKey = (s: string) => s.replace(/\s+/g, '').toLowerCase()
              return (
                <View style={styles.tagsRow}>
                  {tags.map(tag => {
                    const key = normaliseKey(tag)
                    const cfg = SPORT_COLORS[key]
                    return (
                      <View
                        key={tag}
                        style={[styles.tag, cfg ? { backgroundColor: cfg.bg, borderColor: cfg.border || 'transparent', borderWidth: cfg.border ? 1 : 0 } : styles.tagFallback]}
                      >
                        <Text style={[styles.tagText, cfg && { color: cfg.color }]}>{tag}</Text>
                      </View>
                    )
                  })}
                </View>
              )
            })()}
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
              onPress={handleSubmit}
            >
              <Text style={styles.confirmUnifiedText}>{submitting ? 'Submitting...' : 'Confirm Booking'}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      )}
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
  starCalIcon: { width: 22, height: 22, tintColor: '#FFB703', marginLeft: 8, resizeMode: 'contain' },
  leadingCalIcon: { width: 24, height: 24, tintColor: '#FFB703', marginRight: 10, resizeMode: 'contain' },
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
  smallText: { fontSize: 11, color: '#666' },
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
})
