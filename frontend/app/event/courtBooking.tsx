import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, ScrollView, TextInput, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { Image as ExpoImage } from 'expo-image'
import { ICONS } from '@/constants/icons'
import { CourtBookingRow, listCourts, createServiceBookings, listServicesByCourtId, type ServiceBookingCreateRow, type ServiceRow } from '@/lib/backendApi'
import { optimizeRemoteImageUrl } from '@/lib/imageOptimize'
import { useQuery } from '@tanstack/react-query'
import { useAuthContext } from '@/hooks/use-auth-context'
import { useCourtInfo, useCourtAvailability, useCreateBookingWithPayment, useUserCourtBookings } from '@/hooks/use-court-data'
import { useUserId } from '@/hooks/use-user-id'
import { appendHistory } from '@/storage/history'


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

// Format a start/end timestamp into same style used by event list: "Thu, Nov 20, 09:00 - 10:30"
function formatRange(start?: string | null, end?: string | null) {
  if (!start) return 'Unknown date'
  try {
    const s = new Date(start)
    const e = end ? new Date(end) : null
    const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const startTime = s.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const endTime = e ? e.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
    return `${day}, ${startTime}${endTime ? ` - ${endTime}` : ''}`
  } catch {
    return `${start}${end ? ` → ${end}` : ''}`
  }
}

// Helper to normalise venue value to array of strings (matches courtList.tsx)
function asArray(v: any): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

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
  useAuthContext()

  const { data: courtInfoData, isLoading: courtInfoLoading, error: courtInfoError } = useCourtInfo()
  const courtInfo = courtInfoData?.find?.((c:any)=> c.courtid === courtid)
  const { data: availabilityRows, isLoading: availabilityLoading, error: availabilityError } = useCourtAvailability(courtid)
  const availability: AvailabilityRow | null = Array.isArray(availabilityRows) && availabilityRows.length ? {
    ...availabilityRows[0],
    booking_date: (() => {
      const bd: any = availabilityRows[0].booking_date
      if (typeof bd === 'string') {
        try { const parsed = JSON.parse(bd); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
      }
      return Array.isArray(bd) ? bd : []
    })()
  } : null
  const loading = courtInfoLoading || availabilityLoading
  const error = (courtInfoError as any)?.message || (availabilityError as any)?.message || null
  // selectedDateStr holds the absolute date string (YYYY-MM-DD) for the selected day
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null)
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [startSlot, setStartSlot] = useState<string | null>(null)
  const [endSlot, setEndSlot] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<CourtBookingRow | null>(null)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [servicesExpanded, setServicesExpanded] = useState(true)
  const [serviceQtyById, setServiceQtyById] = useState<Record<number, number>>({})
  const [serviceTouchedById, setServiceTouchedById] = useState<Record<number, boolean>>({})
  // Week navigation (0 = current week, can move forward to +2)
  const [weekOffset, setWeekOffset] = useState(0)
  // Derived duration (minutes) of selected booking window
  const durationMinutes = useMemo(() => {
    if (!startSlot || !endSlot) return 0
    const [sh, sm] = startSlot.split(':').map(Number)
    const [eh, em] = endSlot.split(':').map(Number)
    return (eh*60+em) - (sh*60+sm)
  }, [startSlot, endSlot])
  const durationInvalid = !!(startSlot && endSlot && (durationMinutes < 60 || durationMinutes > 180))

  // Resolve numeric userid similar to other screens via query
  const { data: userId } = useUserId()
  const { data: existingBookings, refetch: refetchUserBookings } = useUserCourtBookings(userId)
  const bookings = Array.isArray(existingBookings) ? existingBookings : []

  const isActiveCourtBooking = useCallback((b: CourtBookingRow) => {
    const s = String((b as any)?.bookingstatus ?? (b as any)?.status ?? '').toLowerCase()
    if (!s) return true
    return !(s.includes('cancel') || s.includes('complete') || s.includes('reject'))
  }, [])

  // Only block duplicates for the same availability when the existing booking is still active.
  const hasBookingForCurrentAvailability = !!(
    availability && bookings.some(b => b.availabilityid === availability.availabilityid && isActiveCourtBooking(b))
  )

  // Ensure we see fresh bookings after navigating back from Details/cancel.
  useFocusEffect(
    useCallback(() => {
      if (userId == null) return
      void refetchUserBookings()
    }, [refetchUserBookings, userId])
  )

  // Derive week dates (Mon -> Sun) with offset (future weeks only)
  const weekDaysDetailed = useMemo(() => {
    const today = new Date()
    const dayIdx = today.getDay() // Sun=0
    const offsetToMonday = ((dayIdx + 6) % 7)
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday + weekOffset * 7)
    return WEEK_DAYS.map((wd, i) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      return { ...wd, date: d, dateStr: toDateString(d), isToday: weekOffset === 0 && toDateString(d) === toDateString(today) }
    })
  }, [weekOffset])

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
  // Courts pricing (price per hour) fetched from /courts
  const { data: courtsData } = useQuery({ queryKey: ['courts'], queryFn: () => listCourts() })
  const pricePerHour: number | null = courtsData?.find?.((c: any) => c.courtid === courtid)?.price ?? null
  const courtAmount = useMemo(() => {
    if (pricePerHour == null || !startSlot || !endSlot) return 0
    return Math.round(Number(pricePerHour) * (durationMinutes / 60)) // prorated (e.g. 90m = 1.5h)
  }, [pricePerHour, durationMinutes, startSlot, endSlot])

  const { data: servicesData, isLoading: servicesLoading } = useQuery({
    queryKey: ['courtServices', courtid],
    queryFn: () => listServicesByCourtId(courtid),
    enabled: Number.isFinite(courtid),
    staleTime: 5 * 60 * 1000,
  })

  const servicesTotal = useMemo(() => {
    const rows: ServiceRow[] = Array.isArray(servicesData) ? servicesData : []
    let sum = 0
    for (const s of rows) {
      const qty = serviceQtyById[s.serviceid] || 0
      if (qty > 0) sum += qty * (Number(s.price) || 0)
    }
    return sum
  }, [servicesData, serviceQtyById])

  const totalAmount = useMemo(() => {
    return Math.max(0, Number(courtAmount) || 0) + Math.max(0, Number(servicesTotal) || 0)
  }, [courtAmount, servicesTotal])
  const formattedAmount = useMemo(() => {
    if (!totalAmount) return 'Confirm Booking'
    try {
      return `Confirm Booking - ${new Intl.NumberFormat('vi-VN').format(totalAmount)}₫`
    } catch { return `Confirm Booking - ${totalAmount}₫` }
  }, [totalAmount])
  // Disallow duplicate booking for same availability
  const canConfirm = !!(selectedDateStr && startSlot && endSlot && paymentMethod && userId && availability && !durationInvalid && !hasBookingForCurrentAvailability)

  const onSelectDay = (dateStr: string, dayKey: string) => {
    if (!isDaySelectable(dayKey)) return
    if (selectedDateStr === dateStr) {
      setSelectedDateStr(null)
      setShowTimePicker(false)
      setStartSlot(null); setEndSlot(null)
      return
    }
    setSelectedDateStr(dateStr)
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

  const bookingMutation = useCreateBookingWithPayment()
  const confirmBooking = async () => {
    if (!canConfirm || !availability || !userId || !startSlot || !endSlot || !paymentMethod) return
    setSubmitError(null); setConfirmation(null)
    setSubmitting(true)
    const bookingDateStr = selectedDateStr
    if (!bookingDateStr) { setSubmitError('Selected date missing'); setSubmitting(false); return }
    const startTs = `${bookingDateStr} ${startSlot}:00`
    const endTs = `${bookingDateStr} ${endSlot}:00`
    bookingMutation.mutate({
      availabilityid: availability.availabilityid,
      userid: userId,
      status: 'approved',
      paymentMethod: paymentMethod,
      start_timestamp: startTs,
      end_timestamp: endTs,
      bookingdate: bookingDateStr,
      amount: totalAmount || 0,
      note: noteText.trim() ? noteText.trim() : null,
    }, {
      onSuccess: async (data) => {
        // Persist selected service line items (servicebooking table) if any were chosen.
        try {
          const courtbookingid = Number((data as any)?.booking?.courtbookingid)
          const paymentidRaw = (data as any)?.payment?.paymentid ?? (data as any)?.booking?.paymentid
          const paymentid = Number(paymentidRaw)
          const paymentidSafe = Number.isFinite(paymentid) && paymentid > 0 ? paymentid : null
          if (Number.isFinite(courtbookingid) && courtbookingid > 0) {
            const rows: ServiceRow[] = Array.isArray(servicesData) ? servicesData : []
            const items: ServiceBookingCreateRow[] = rows
              .map((s) => ({
                courtbookingid,
                serviceid: Number(s.serviceid),
                quantity: Number(serviceQtyById[s.serviceid] || 0),
                unit_price: Number(s.price),
                paymentid: paymentidSafe,
              }))
              .filter((r) =>
                Number.isFinite(r.serviceid) && r.serviceid > 0 &&
                Number.isFinite(r.quantity) && r.quantity > 0 &&
                Number.isFinite(r.unit_price) && r.unit_price >= 0
              )

            if (items.length > 0) {
              console.log('[courtBooking] creating servicebookings', { count: items.length, sample: items[0] })
              await createServiceBookings(items)
            }
          }
        } catch (e) {
          // Best-effort only; booking + payment should still succeed even if servicebooking insert fails.
          console.warn('[courtBooking] createServiceBookings failed', e)
        }

        if (typeof userId === 'number') {
          const courtTitle = courtInfo?.name || 'Court Booking'
          void appendHistory(userId, {
            kind: 'payment',
            title: `Payment for ${courtTitle}`,
            subtitle: `Method: ${paymentMethod}`,
            fromStatus: 'unpaid',
            toStatus: String(data.payment?.status ?? 'pending'),
            amount: typeof totalAmount === 'number' ? totalAmount : (totalAmount == null ? null : Number(totalAmount)),
            meta: {
              paymentid: data.payment?.paymentid,
              type: 'court',
              availabilityid: availability.availabilityid,
              courtbookingid: data.booking?.courtbookingid,
              start_timestamp: startTs,
              end_timestamp: endTs,
            },
          })

          void appendHistory(userId, {
            kind: 'court_booking',
            title: `Booked court: ${courtTitle}`,
            subtitle: null,
            fromStatus: 'pending',
            toStatus: String(data.booking?.status ?? data.booking?.bookingstatus ?? 'approved'),
            meta: {
              courtbookingid: data.booking?.courtbookingid,
              availabilityid: availability.availabilityid,
              start_timestamp: startTs,
              end_timestamp: endTs,
            },
          })
        }

        // Redirect to Invoice (Invoice header plays the success animation)
        router.replace({
          pathname: '/event/invoice',
          params: {
            title: courtInfo?.name || 'Court Booking',
            subtitle: '',
            date: selectedDateStr,
            time: `${startSlot} - ${endSlot}`,
            location: courtInfo?.address,
            price: totalAmount,
            paymentMethod: paymentMethod,
            paymentStatus: data.payment?.status,
            bookingId: data.booking?.courtbookingid,
            note: noteText.trim(),
            type: 'court',
          },
        })
      },
      onError: (err: any) => {
        setSubmitError(err?.message || 'Booking failed')
      },
      onSettled: () => setSubmitting(false)
    })
  }

  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

  const onPressConfirm = () => {
    if (!canConfirm || submitting) return
    setConfirmModalVisible(true)
  }

  // Force refetch when screen gains focus to reflect external deletions (manual DB changes)
  // Use simple interval-less refetch on mount + when userId changes (manual DB deletes reflected)
  // Refetch bookings whenever screen gains focus (captures manual DB deletions/insertions)
  useFocusEffect(useCallback(() => {
    if (userId != null) refetchUserBookings()
  }, [userId, refetchUserBookings]))

  // Poll for external deletions (simple immediate sync after manual DB changes)
  useEffect(() => {
    if (userId == null) return
    const interval = setInterval(() => {
      refetchUserBookings()
    }, 4000) // 4s polling interval
    return () => clearInterval(interval)
  }, [userId, refetchUserBookings])

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
            <View style={styles.courtHeaderRow}>
              {(() => {
                const venueRaw = courtInfo?.venue
                const venueTokens = asArray(venueRaw).map(v => v.toLowerCase())
                const hasIndoor = venueTokens.some(t => t.includes('indoor'))
                const hasOutdoor = venueTokens.some(t => t.includes('outdoor'))
                let iconSrc = null
                if (hasIndoor && hasOutdoor) iconSrc = ICONS.bothVenue
                else if (hasIndoor) iconSrc = ICONS.indoorIcon
                else if (hasOutdoor) iconSrc = ICONS.outdoorIcon
                return iconSrc ? <Image source={iconSrc} style={styles.venueIcon} /> : null
              })()}
              <Text style={styles.courtName}>{courtInfo?.name || `Court ${courtid}`}</Text>
            </View>
            {(() => {
              return null
            })()}
            <View style={styles.metaRow}>
              <Image source={ICONS.mapPin} style={styles.metaIcon} />
              <Text style={styles.courtAddress}>{(courtInfoData?.find?.((c:any)=>c.courtid===courtid)?.address) || ''}</Text>
            </View>
            {availability && (
              <View style={styles.metaRow}>
                <Image source={ICONS.clock} style={styles.metaIcon} />
                <Text style={styles.availabilityMeta}>Opening {availability.start_time} - {availability.end_time}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Section 2: Date & Time & Payment */}
      <View style={styles.sectionCard}>
        <View style={styles.scheduleHeaderRow}>
          <Text style={styles.sectionTitle}>Schedule</Text>
          <View style={styles.weekNavInline}>
            <TouchableOpacity
              disabled={weekOffset === 0}
              onPress={() => { if (weekOffset > 0) setWeekOffset(w => w - 1) }}
              style={[styles.navBtn, weekOffset === 0 && styles.navBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={[styles.navIcon,{ transform:[{ rotate:'180deg'}]}]} />
            </TouchableOpacity>
            <TouchableOpacity
              disabled={weekOffset === 2}
              onPress={() => { if (weekOffset < 2) setWeekOffset(w => w + 1) }}
              style={[styles.navBtn, weekOffset === 2 && styles.navBtnDisabled]}
            >
              <Image source={ICONS.arrowright} style={styles.navIcon} />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.weekRow}>
          {weekDaysDetailed.map(d => {
            const today = new Date();
            const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate())
            const pastDisabled = weekOffset === 0 && d.date < todayOnly
            const disabled = !isDaySelectable(d.key) || pastDisabled
            const selected = selectedDateStr === d.dateStr
            return (
              <TouchableOpacity
                key={d.key}
                disabled={disabled}
                onPress={() => onSelectDay(d.dateStr, d.key)}
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
          <Text style={styles.sectionTitle}>
            {pricePerHour != null ? `Payment (${new Intl.NumberFormat('vi-VN').format(pricePerHour)}₫/hr)` : 'Payment (price/hr)'}
          </Text>
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

          {/* Services (expandable, closed by default) */}
          <TouchableOpacity style={styles.servicesHeaderRow} activeOpacity={0.8} onPress={() => setServicesExpanded(p => !p)}>
            <Text style={styles.servicesHeaderText}>Services</Text>
            <Image source={ICONS.arrowdown} style={[styles.servicesArrow, servicesExpanded && styles.servicesArrowOpen]} />
          </TouchableOpacity>
          {servicesExpanded && (
            <View style={styles.servicesWrapper}>
              {servicesLoading ? (
                <Text style={styles.statusText}>Loading services...</Text>
              ) : (
                (Array.isArray(servicesData) ? servicesData : []).length === 0 ? (
                  <Text style={styles.statusText}>This court have no services</Text>
                ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.servicesScrollContent}>
                  {(Array.isArray(servicesData) ? servicesData : []).map((s: ServiceRow) => {
                    const qty = serviceQtyById[s.serviceid] || 0
                    const touched = !!serviceTouchedById[s.serviceid]
                    const rawImageUri = Array.isArray(s.images) && s.images.length ? s.images[0] : null
                    const imageUri = typeof rawImageUri === 'string' && rawImageUri.trim()
                      ? optimizeRemoteImageUrl(rawImageUri, { width: 600, height: 300, quality: 75, resize: 'contain' })
                      : null
                    return (
                      <View key={s.serviceid} style={styles.serviceCard}>
                        {imageUri ? (
                          <View style={styles.serviceImageWrap}>
                            <ExpoImage
                              source={{ uri: imageUri }}
                              style={styles.serviceImage}
                              contentFit="contain"
                              cachePolicy="disk"
                              transition={0}
                              recyclingKey={`${s.serviceid}:${imageUri}`}
                            />
                          </View>
                        ) : (
                          <View style={styles.serviceImagePlaceholder} />
                        )}
                        <Text style={styles.serviceName} numberOfLines={2}>{s.name}</Text>
                        <Text style={styles.servicePrice}>{new Intl.NumberFormat('vi-VN').format(Number(s.price) || 0)}₫</Text>

                        <View style={styles.qtyRow}>
                          <TouchableOpacity
                            onPress={() => {
                              setServiceTouchedById(prev => ({ ...prev, [s.serviceid]: true }))
                              setServiceQtyById(prev => {
                                const cur = prev[s.serviceid] || 0
                                const next = Math.max(0, cur - 1)
                                return { ...prev, [s.serviceid]: next }
                              })
                            }}
                            style={styles.qtyBox}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.qtyBoxText}>-</Text>
                          </TouchableOpacity>
                          <View style={styles.qtyBoxMid}>
                            <Text style={styles.qtyMidText}>{touched ? String(qty) : ''}</Text>
                          </View>
                          <TouchableOpacity
                            onPress={() => {
                              setServiceTouchedById(prev => ({ ...prev, [s.serviceid]: true }))
                              setServiceQtyById(prev => {
                                const cur = prev[s.serviceid] || 0
                                const next = cur + 1
                                return { ...prev, [s.serviceid]: next }
                              })
                            }}
                            style={styles.qtyBox}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.qtyBoxText}>+</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )
                  })}
                </ScrollView>
                )
              )}
            </View>
          )}

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
          {hasBookingForCurrentAvailability && !confirmation && (
            <Text style={styles.errorText}>You have already booked this court.</Text>
          )}
          {confirmation && (
            <View style={styles.successBox}>
              <Text style={styles.successTitle}>Booked!</Text>
              <Text style={styles.successLine}>ID: {confirmation.courtbookingid}</Text>
              <Text style={styles.successLine}>{formatRange(confirmation.start_timestamp, confirmation.end_timestamp)}</Text>
              <Text style={styles.successLine}>Payment #{confirmation.paymentid}</Text>
            </View>
          )}
          {bookingMutation.isError && !submitError && (
            <Text style={styles.errorText}>Mutation error occurred.</Text>
          )}
        </View>
      </View>
    </ScrollView>
    {/* Fixed Bottom Booking Bar inside SafeArea */}
    <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
      <View style={styles.bottomBar}>
        <TouchableOpacity
          disabled={!canConfirm || submitting}
          onPress={onPressConfirm}
          style={[styles.confirmUnifiedBtn, (!canConfirm || submitting) && styles.confirmBtnDisabled]}
        >
          <Text style={styles.confirmUnifiedText}>{submitting ? 'Processing...' : formattedAmount}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>

    <Modal
      transparent={true}
      visible={confirmModalVisible}
      animationType="fade"
      onRequestClose={() => setConfirmModalVisible(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Confirm Booking</Text>
          <Text style={styles.modalBody}>Are you sure you want to book this court?</Text>
          <View style={styles.modalActions}>
            <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmModalVisible(false)}>
              <Text style={styles.modalBtnText}>Cancel</Text>
            </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm]} onPress={() => {
              setConfirmModalVisible(false)
              confirmBooking()
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
  servicesHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  servicesHeaderText: { fontSize: 16, fontWeight: '700', color: '#222' },
  servicesWrapper: { marginTop: 10 },
  servicesScrollContent: { paddingVertical: 8, paddingRight: 8 },
  serviceCard: { width: 130, marginRight: 14 },
  serviceImageWrap: { width: '100%', height: 62, borderRadius: 10, backgroundColor: '#f2f2f2', overflow: 'hidden' },
  serviceImage: { width: '100%', height: '100%' },
  serviceImagePlaceholder: { width: '100%', height: 62, borderRadius: 10, backgroundColor: '#f2f2f2' },
  serviceName: { marginTop: 8, fontSize: 13, fontWeight: '700', color: '#222', minHeight: 34 },
  servicePrice: { marginTop: 2, fontSize: 12, fontWeight: '700', color: '#111' },
  qtyRow: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyBox: { width: 36, height: 32, borderRadius: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#d9d9d9', alignItems: 'center', justifyContent: 'center' },
  qtyBoxMid: { flex: 1, height: 32, marginHorizontal: 8, borderRadius: 8, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#e2e2e2', alignItems: 'center', justifyContent: 'center' },
  qtyBoxText: { fontSize: 18, fontWeight: '800', color: '#111', lineHeight: 18 },
  qtyMidText: { fontSize: 14, fontWeight: '800', color: '#111' },
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
  servicesArrow: { width: 16, height: 16, resizeMode: 'contain', transform: [{ rotate: '0deg' }], marginTop: 2 },
  servicesArrowOpen: { transform: [{ rotate: '180deg' }] },
  noteInputWrapper: { marginTop: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 10 },
  noteInput: { minHeight: 80, padding: 10, fontSize: 14, color: '#222', textAlignVertical: 'top' },
  durationWarning: { marginTop: 8, color: '#c00', fontSize: 12, fontWeight: '600' },
  courtHeaderRow: { flexDirection:'row', alignItems:'center', marginBottom:4 },
  venueIcon: { width:28, height:28, resizeMode:'contain', marginRight:8 },
  tagsRow: { flexDirection:'row', flexWrap:'wrap', marginTop:8 },
  tag: { backgroundColor:'#eee', paddingHorizontal:10, paddingVertical:6, borderRadius:16, marginRight:6, marginBottom:6 },
  tagFallback: { backgroundColor:'#eee' },
  tagText: { fontSize:12, fontWeight:'600', color:'#333' },
  // New schedule header + navigation styles
  scheduleHeaderRow: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:4 },
  weekNavInline: { flexDirection:'row', alignItems:'center' },
  navBtn: { padding:8, borderRadius:10, backgroundColor:'#e0e0e0', marginHorizontal:4 },
  navBtnDisabled: { opacity:0.35 },
  navIcon: { width:20, height:20, tintColor:'#333', resizeMode:'contain' },
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
