import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, ScrollView, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { listCourtInfoCached, listCourtAvailability, createPayment, createCourtBooking, PaymentRow, CourtBookingRow } from '@/lib/backendApi'
import { useAuthContext } from '@/hooks/use-auth-context'

type AvailabilityRow = {
  availabilityid: number
  courtid: number
  status: string
  start_time: string
  end_time: string
  booking_date: string[] | string
}

// Format helpers
function pad(n: number) { return n < 10 ? `0${n}` : `${n}` }
function toDateString(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }

const WEEK_DAYS: { key: string; label: string }[] = [
  { key: 'Mon', label: 'Mon' },
  { key: 'Tue', label: 'Tue' },
  { key: 'Wed', label: 'Wed' },
  { key: 'Thu', label: 'Thu' },
  { key: 'Fri', label: 'Fri' },
  { key: 'Sat', label: 'Sat' },
  { key: 'Sun', label: 'Sun' },
]

export default function CourtBooking() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const courtid = params.courtid ? parseInt(String(params.courtid), 10) : NaN
  const { profile } = useAuthContext()

  const [courtName, setCourtName] = useState<string>('')
  const [courtAddress, setCourtAddress] = useState<string>('')
  const [availability, setAvailability] = useState<AvailabilityRow | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null) // 'Mon' etc.
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [startSlot, setStartSlot] = useState<string | null>(null)
  const [endSlot, setEndSlot] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<CourtBookingRow | null>(null)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  // Derived duration (minutes) of selected booking window
  const durationMinutes = useMemo(() => {
    if (!startSlot || !endSlot) return 0
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = endSlot.split(':').map(Number)
    return (eh*60+em) - (sh*60+sm)
  }, [startSlot, endSlot])
  const durationInvalid = !!(startSlot && endSlot && (durationMinutes < 60 || durationMinutes > 180))

  // Resolve numeric userid similar to other screens
  const resolveUserId = useCallback(async (): Promise<number | null> => {
    if (profile && typeof (profile as any).userid === 'number') return (profile as any).userid
    try {
      const raw = await AsyncStorage.getItem('@backendProfile')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.userid === 'number') return parsed.userid
      }
    } catch {}
    return null
  }, [profile])
  const [userId, setUserId] = useState<number | null>(null)
  useEffect(() => { resolveUserId().then(setUserId) }, [resolveUserId])

  // Fetch court info & availability
  useEffect(() => {
    if (!courtid || Number.isNaN(courtid)) return
    let cancelled = false
    const run = async () => {
      setLoading(true); setError(null)
      try {
        const courts = await listCourtInfoCached()
        const ci = courts.find(c => c.courtid === courtid)
        if (ci) { setCourtName(ci.name || `Court ${courtid}`); setCourtAddress(ci.address || '') }
        const avRows = await listCourtAvailability(courtid)
        const row = Array.isArray(avRows) && avRows.length ? avRows[0] : null
        if (row) {
          // booking_date may be JSON string; normalize to array
          let bd: any = row.booking_date
          if (typeof bd === 'string') {
            try { bd = JSON.parse(bd) } catch {}
          }
          row.booking_date = Array.isArray(bd) ? bd : []
        }
        if (!cancelled) setAvailability(row)
      } catch (e: any) {
        if (!cancelled) setError(e.message || String(e))
      } finally { if (!cancelled) setLoading(false) }
    }
    run()
    return () => { cancelled = true }
  }, [courtid])

  // Derive current week dates (Mon -> Sun) anchored to today
  const weekDaysDetailed = useMemo(() => {
    const today = new Date()
    // Find Monday of this week
    const dayIdx = today.getDay() // Sun=0
    const offsetToMonday = ((dayIdx + 6) % 7) // converts Sun(0)->6, Mon(1)->0,...
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday)
    return WEEK_DAYS.map((wd, i) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      return { ...wd, date: d, dateStr: toDateString(d), isToday: toDateString(d) === toDateString(today) }
    })
  }, [])

  const availableDayKeys = (availability?.booking_date as string[] | undefined) || []

  // Slots: generate 30-min increments between start_time & end_time
  const timeSlots = useMemo(() => {
    if (!availability) return []
    const start = availability.start_time // '08:00'
    const end = availability.end_time
    const [sh, sm] = start.split(':').map(Number)
    const [eh, em] = end.split(':').map(Number)
    const startMinutes = sh * 60 + sm
    const endMinutes = eh * 60 + em
    const slots: string[] = []
    for (let m = startMinutes; m + 30 <= endMinutes; m += 30) {
      const hh = pad(Math.floor(m / 60)); const mm = pad(m % 60)
      slots.push(`${hh}:${mm}`)
    }
    return slots
  }, [availability])

  // Derived validity and button enable state
  const isDaySelectable = useCallback((dayKey: string) => availableDayKeys.includes(dayKey), [availableDayKeys])
  const canConfirm = !!(selectedDay && startSlot && endSlot && paymentMethod && userId && availability && !durationInvalid)

  const onSelectDay = (dayKey: string) => {
    if (!isDaySelectable(dayKey)) return
    if (selectedDay === dayKey) {
      setSelectedDay(null)
      setShowTimePicker(false)
      setStartSlot(null); setEndSlot(null)
      return
    }
    setSelectedDay(dayKey)
    setShowTimePicker(true)
    setStartSlot(null); setEndSlot(null)
  }
  const onSelectStart = (slot: string) => {
    if (startSlot === slot) { setStartSlot(null); setEndSlot(null); return }
    setStartSlot(slot)
    setEndSlot(null)
  }
  const onSelectEnd = (slot: string) => {
    if (!startSlot) return
    if (endSlot === slot) { setEndSlot(null); return }
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = slot.split(':').map(Number)
    const startM = sh*60+sm
    const endM = eh*60+em
    if (endM <= startM) return
    setEndSlot(slot)
  }

  const confirmBooking = async () => {
    if (!canConfirm || !availability || !userId || !selectedDay || !startSlot || !endSlot) return
    setSubmitting(true); setSubmitError(null); setConfirmation(null)
    try {
      // Build timestamps
      const weekDay = weekDaysDetailed.find(w => w.key === selectedDay)
      if (!weekDay) throw new Error('Week day resolve failed')
      const bookingDateStr = weekDay.dateStr
      const startTs = `${bookingDateStr} ${startSlot}:00`
      const endTs = `${bookingDateStr} ${endSlot}:00`
      const paymentStatus = paymentMethod === 'cash' ? 'pending' : 'paid'
      const payment = await createPayment({ status: paymentStatus, method: paymentMethod, amount: 50000 }) as PaymentRow
      const bookingPayload = {
        availabilityid: availability.availabilityid,
        userid: userId,
        status: 'approved',
        paymentid: payment.paymentid,
        start_timestamp: startTs,
        end_timestamp: endTs,
        bookingdate: bookingDateStr,
      }
      const booking = await createCourtBooking(bookingPayload)
      setConfirmation(booking)
      // Basic success toast substitute
      console.log('[CourtBooking] booking success', booking)
    } catch (e: any) {
      setSubmitError(e.message || String(e))
    } finally { setSubmitting(false) }
  }

  return (
    <View style={styles.screen}>
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 220 }}>
      {/* Header / Back inside SafeArea */}
      <SafeAreaView edges={['top']} style={styles.headerSafeArea}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Image source={ICONS.arrowLeft} style={styles.backIcon} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Court Booking</Text>
        </View>
      </SafeAreaView>

      {/* Section 1: Court details (title removed) */}
      <View style={styles.sectionCard}>
        {loading && <Text style={styles.statusText}>Loading...</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
        {!loading && !error && (
          <View>
            <Text style={styles.courtName}>{courtName || 'Unknown Court'}</Text>
            <View style={styles.metaRow}>
              <Image source={ICONS.mapPin} style={styles.metaIcon} />
              <Text style={styles.courtAddress}>{courtAddress}</Text>
            </View>
            {availability && (
              <View style={styles.metaRow}>
                <Image source={ICONS.clock} style={styles.metaIcon} />
                <Text style={styles.availabilityMeta}>Opening time: {availability.start_time} - {availability.end_time}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Section 2: Date & Time & Payment */}
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Schedule</Text>
        <View style={styles.weekRow}>
          {weekDaysDetailed.map(d => {
            const disabled = !isDaySelectable(d.key)
            const selected = selectedDay === d.key
            return (
              <TouchableOpacity
                key={d.key}
                disabled={disabled}
                onPress={() => onSelectDay(d.key)}
                style={[styles.dayCell, selected && styles.dayCellSelected, disabled && styles.dayCellDisabled]}
              >
                <Text style={[styles.dayLabel, d.isToday && styles.todayUnderline]}>{d.label}</Text>
                <Text style={styles.dayDate}>{d.date.getDate()}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
        {showTimePicker && availability && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.subHeading}>Select Time</Text>
            <Text style={styles.smallText}>Start</Text>
            <View style={styles.slotRow}>
              {timeSlots.map(ts => (
                <TouchableOpacity key={ts} onPress={() => onSelectStart(ts)} style={[styles.slotBtn, startSlot === ts && styles.slotBtnActive]}>
                  <Text style={styles.slotText}>{ts}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {startSlot && (
              <>
                <Text style={[styles.smallText,{marginTop:12}]}>End</Text>
                <View style={styles.slotRow}>
                  {timeSlots.filter(ts => ts > startSlot!).map(ts => (
                    <TouchableOpacity key={ts} onPress={() => onSelectEnd(ts)} style={[styles.slotBtn, endSlot === ts && styles.slotBtnActive]}>
                      <Text style={styles.slotText}>{ts}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {endSlot && durationInvalid && (
                  <Text style={styles.durationWarning}>Booking time must be between 1 and 3 hours.</Text>
                )}
              </>
            )}
          </View>
        )}
        {/* Payment Method */}
        <View style={{ marginTop: 24 }}>
          <Text style={styles.sectionTitle}>Payment</Text>
          <View style={styles.paymentRow}>
            <TouchableOpacity
              onPress={() => setPaymentMethod(paymentMethod === 'cash' ? null : 'cash')}
              style={[styles.payMethodBtn, paymentMethod === 'cash' && styles.payMethodActive]}
            >
              <Image source={ICONS.cashIcon} style={styles.payIcon} />
              <Text style={styles.payText}>Cash</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setPaymentMethod(paymentMethod === 'vnpay' ? null : 'vnpay')}
              style={[styles.payMethodBtn, paymentMethod === 'vnpay' && styles.payMethodActive]}
            >
              <Image source={ICONS.vnpayIcon} style={styles.payIcon} />
              <Text style={styles.payText}>VNPay</Text>
            </TouchableOpacity>
          </View>
          {/* Note Section */}
          <TouchableOpacity style={styles.noteRow} activeOpacity={0.8} onPress={() => setNoteExpanded(p => !p)}>
            <Image source={ICONS.noteIcon} style={styles.noteIcon} />
            <Text style={styles.noteTextLabel}>Note</Text>
            <Image source={ICONS.arrowright} style={[styles.noteArrow, noteExpanded && styles.noteArrowExpanded]} />
          </TouchableOpacity>
          {noteExpanded && (
            <View style={styles.noteInputWrapper}>
              <TextInput
                style={styles.noteInput}
                placeholder="Note something here..."
                multiline
                value={noteText}
                onChangeText={setNoteText}
              />
            </View>
          )}
          {/* Promotion moved under payment methods */}
          <View style={[styles.promoWrapper,{marginTop:16}]}>
            <TouchableOpacity style={styles.promoBox} activeOpacity={0.75}>
              <Text style={styles.promoText}>Apply Promotion Code</Text>
            </TouchableOpacity>
          </View>
          {submitError && <Text style={styles.errorText}>{submitError}</Text>}
          {confirmation && (
            <View style={styles.successBox}>
              <Text style={styles.successTitle}>Booked!</Text>
              <Text style={styles.successLine}>ID: {confirmation.courtbookingid}</Text>
              <Text style={styles.successLine}>{confirmation.start_timestamp} → {confirmation.end_timestamp}</Text>
              <Text style={styles.successLine}>Payment #{confirmation.paymentid}</Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
    {/* Fixed Bottom Booking Bar inside SafeArea */}
    <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
      <View style={styles.bottomBar}>
        <TouchableOpacity
          disabled={!canConfirm || submitting}
          onPress={confirmBooking}
          style={[styles.confirmUnifiedBtn, (!canConfirm || submitting) && styles.confirmBtnDisabled]}
        >
          <Text style={styles.confirmUnifiedText}>{submitting ? 'Processing...' : 'Confirm Booking - 50,000₫'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1 },
  headerSafeArea: { backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  backBtn: { padding: 12, borderRadius: 28, backgroundColor: '#f2f2f2', justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 20, height: 20, tintColor: '#333', marginTop: 2 },
  headerTitle: { fontSize: 18, fontWeight: '600', marginLeft: 12 },
  sectionCard: { backgroundColor: '#fafafa', marginHorizontal: 16, marginBottom: 20, padding: 16, borderRadius: 14, elevation: 2 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  courtName: { fontSize: 18, fontWeight: '700', color: '#222' },
  courtAddress: { fontSize: 14, color: '#555', marginTop: 6, lineHeight: 20 },
  availabilityMeta: { fontSize: 12, color: '#777', marginTop: 10, lineHeight: 18 },
  statusText: { fontSize: 13, color: '#666' },
  errorText: { color: '#c00', marginTop: 8, fontSize: 13 },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  dayCell: { flex: 1, marginHorizontal: 2, paddingVertical: 10, borderRadius: 10, backgroundColor: '#e9e9e9', alignItems: 'center' },
  dayCellSelected: { backgroundColor: '#FFD700' },
  dayCellDisabled: { opacity: 0.35 },
  dayLabel: { fontSize: 12, fontWeight: '600', color: '#222' },
  todayUnderline: { textDecorationLine: 'underline' },
  dayDate: { fontSize: 14, fontWeight: '700', color: '#111', marginTop: 4 },
  subHeading: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  smallText: { fontSize: 12, fontWeight: '600', color: '#333', marginBottom: 4 },
  slotRow: { flexDirection: 'row', flexWrap: 'wrap' },
  slotBtn: { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#1e1e1e', borderRadius: 8, marginRight: 8, marginBottom: 8 },
  slotBtnActive: { backgroundColor: '#32CD32' },
  slotText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  paymentRow: { flexDirection: 'row', marginTop: 20 },
  payMethodBtn: { flex: 1, paddingVertical: 14, paddingHorizontal: 12, backgroundColor: '#eaeaea', marginRight: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center' },
  payMethodActive: { backgroundColor: '#FFA500' },
  payIcon: { width: 28, height: 28, marginRight: 10, resizeMode: 'contain' },
  payText: { fontSize: 15, fontWeight: '700', color: '#222' },
  confirmBtnDisabled: { backgroundColor: '#ccc' },
  confirmText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  bottomSafeArea: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
  bottomBar: { paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'center' },
  confirmUnifiedBtn: { width: '90%', backgroundColor: '#FF5733', paddingVertical: 18, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  confirmUnifiedText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  successBox: { marginTop: 16, backgroundColor: '#e9ffe9', padding: 12, borderRadius: 10 },
  successTitle: { fontSize: 14, fontWeight: '700', color: '#0a7a0a' },
  successLine: { fontSize: 12, color: '#0a7a0a', marginTop: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  metaIcon: { width: 18, height: 18, tintColor: '#555', marginRight: 8, resizeMode: 'contain', top: 4},
  promoWrapper: { marginTop: 24 },
  promoBox: { backgroundColor: '#ffe9d6', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12 },
  promoText: { fontSize: 14, fontWeight: '600', color: '#b34700' },
  noteRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, marginTop: 16 },
  noteIcon: { width: 22, height: 22, marginRight: 10, resizeMode: 'contain' },
  noteTextLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: '#222' },
  noteArrow: { width: 18, height: 18, resizeMode: 'contain' },
  noteArrowExpanded: { transform: [{ rotate: '90deg' }] },
  noteInputWrapper: { marginTop: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 10 },
  noteInput: { minHeight: 80, padding: 10, fontSize: 14, color: '#222', textAlignVertical: 'top' },
  durationWarning: { marginTop: 8, color: '#c00', fontSize: 12, fontWeight: '600' },
})
