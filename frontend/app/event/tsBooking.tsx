import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Image, ScrollView, StyleSheet, TextInput, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import {
  adjustTrainingSessionParticipants,
  createPayment,
  createTrainingSessionBooking,
  invalidateTrainingSessionsCombinedCache,
  listTrainingSessionsCombined,
  listTrainingSessionsCombinedCached,
  CombinedTrainingSession,
  TrainingSessionBookingRow,
} from '@/lib/backendApi'
import { useAuthContext } from '@/hooks/use-auth-context'
import { appendHistory } from '@/storage/history'

function asArray(v: any): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

function formatTime(session: CombinedTrainingSession | null): string {
  if (!session || !session.time) return 'Unknown date'
  try {
    const d = new Date(session.time)
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const tm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `${day}, ${tm}`
  } catch { return 'Unknown date' }
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return ''
  const s = String(Math.round(Number(n)))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default function TrainingSessionBooking() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const params = useLocalSearchParams()
  const sessionid = params.sessionid ? parseInt(String(params.sessionid), 10) : NaN
  const { profile } = useAuthContext()
  const { userId, dashboard } = useAppBootstrap()

  // Cached aggregated list (may be stale right after creation)
  const { data: sessionsCached, isLoading: loadingCached } = useQuery({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombinedCached(),
    staleTime: 30_000,
  })
  // Determine if we need a fresh fetch (session absent in cached list)
  const needFresh = useMemo(() => Array.isArray(sessionsCached) && !sessionsCached.some(s => s.sessionid === sessionid), [sessionsCached, sessionid])
  const { data: sessionsFresh } = useQuery({
    queryKey: ['trainingSessionsCombinedFresh', sessionid],
    queryFn: () => listTrainingSessionsCombined(),
    enabled: needFresh && !isNaN(sessionid),
    staleTime: 0,
  })
  const allSessions: CombinedTrainingSession[] = useMemo(() => {
    if (needFresh && Array.isArray(sessionsFresh)) return sessionsFresh
    return Array.isArray(sessionsCached) ? sessionsCached : []
  }, [needFresh, sessionsFresh, sessionsCached])
  const loadingSessions = loadingCached && !sessionsFresh
  const session: CombinedTrainingSession | null = useMemo(() => allSessions.find(s => s.sessionid === sessionid) || null, [allSessions, sessionid])

  const dashboardRaw = dashboard.data
  const userSessionBookingsRaw = dashboardRaw?.training_bookings ?? []

  const alreadyBooked = useMemo(() => {
    if (typeof userId !== 'number') return false
    if (!Number.isFinite(sessionid)) return false
    const rows = Array.isArray(userSessionBookingsRaw) ? userSessionBookingsRaw : []
    return rows.some((b: any) => {
      if (typeof b?.sessionid !== 'number') return false
      if (b.sessionid !== sessionid) return false
      const s = String(b?.bookingstatus ?? b?.status ?? '').toLowerCase()
      return !s.includes('cancel')
    })
  }, [userId, sessionid, userSessionBookingsRaw])

  // Mirror courtBooking layout: always expanded, remove toggle arrow logic
  const [courtExpanded] = useState(true)
  const [noteExpanded, setNoteExpanded] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'vnpay' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<TrainingSessionBookingRow | null>(null)
  const [confirmModalVisible, setConfirmModalVisible] = useState(false)

  React.useEffect(() => {
    if (alreadyBooked && confirmModalVisible) setConfirmModalVisible(false)
  }, [alreadyBooked, confirmModalVisible])

  const isFree = session?.entry_fee == null
  const allowedMethods: ('cash' | 'vnpay')[] = useMemo(() => {
    if (!session || isFree || !session.support_payment_method) return []
    const m = session.support_payment_method.toLowerCase()
    if (m === 'cash') return ['cash']
    if (m === 'vnpay') return ['vnpay']
    if (m === 'both') return ['cash', 'vnpay']
    return []
  }, [session, isFree])

  const canSubmit = !!session && !!userId && !alreadyBooked && !submitting && !confirmation && (isFree || (!!paymentMethod))

  const handleSubmit = useCallback(async () => {
    if (!session || userId == null) return
    if (alreadyBooked) {
      setSubmitError('Already booked')
      return
    }
    if (!isFree && !paymentMethod) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payment = await createPayment({
        status: isFree ? 'paid' : 'pending',
        method: isFree ? 'cash' : paymentMethod!,
        amount: isFree ? 0 : (session.entry_fee! || 0)
      })
      const booking = await createTrainingSessionBooking({
        sessionid: session.sessionid,
        userid: userId,
        status: 'pending',
        paymentid: payment.paymentid,
        note: noteText || null,
      })

      // Avoid "caching" feeling: refresh both the user's bookings and the cached session list immediately.
      // (listTrainingSessionsCombinedCached uses fetchWithCache, so invalidate that too.)
      try { await invalidateTrainingSessionsCombinedCache() } catch {}
      queryClient.invalidateQueries({ queryKey: queryKeys.trainingSessionsCombined })
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(userId) })

      if (typeof userId === 'number') {
        void appendHistory(userId, {
          kind: 'payment',
          title: `Payment for ${session.title || `Session ${session.sessionid}`}`,
          subtitle: isFree ? 'Free' : `Method: ${paymentMethod}`,
          fromStatus: 'unpaid',
          toStatus: payment.status,
          amount: isFree ? 0 : (session.entry_fee! || 0),
          meta: {
            paymentid: payment.paymentid,
            type: 'session',
            sessionid: session.sessionid,
            tsbookingid: booking.tsbookingid,
            start_timestamp: (session as any).start_timestamp || session.time || null,
            end_timestamp: (session as any).end_timestamp || null,
          },
        })

        void appendHistory(userId, {
          kind: 'session_booking',
          title: `Booked session: ${session.title || `Session ${session.sessionid}`}`,
          subtitle: null,
          fromStatus: 'pending',
          toStatus: String(booking?.status ?? 'pending'),
          meta: {
            sessionid: session.sessionid,
            tsbookingid: booking.tsbookingid,
            start_timestamp: (session as any).start_timestamp || session.time || null,
            end_timestamp: (session as any).end_timestamp || null,
          },
        })
      }

      // Best-effort participant increment
      const approvalStatus = String((booking as any)?.status ?? '').toLowerCase()
      const isApprovedJoin = approvalStatus.includes('join') || approvalStatus.includes('approve')
      if (isApprovedJoin) {
        try {
          await adjustTrainingSessionParticipants(session.sessionid, +1)
          queryClient.setQueryData(queryKeys.trainingSessionsCombined, (prev: any) => {
            if (!Array.isArray(prev)) return prev
            return prev.map((row: any) => {
              if (row?.sessionid !== session.sessionid) return row
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
          title: session.title,
          courtName: session.court_name || '',
          subtitle: 'Training Session',
          date: (() => { const d = new Date(session.time ?? new Date().toISOString()); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })(),
          time: formatTime(session),
          location: session.address || 'Unknown Location',
          price: isFree ? 0 : session.entry_fee,
          paymentMethod: isFree ? 'Free' : paymentMethod,
          paymentStatus: payment.status,
          bookingStatus: String((booking as any)?.status ?? 'pending'),
          bookingId: booking.tsbookingid,
          note: noteText.trim(),
          type: 'session'
        }
      })
    } catch (e) {
      setSubmitError((e as any)?.message || 'Failed booking')
    } finally { setSubmitting(false) }
  }, [session, userId, alreadyBooked, paymentMethod, noteText, isFree, router, queryClient])

  const venues = asArray(session?.venue)
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
          <Text style={styles.headerTitle}>Session Booking</Text>
        </View>
      </SafeAreaView>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 220, paddingTop: 12 }}>
        <View style={styles.sectionCard}>
          {loadingSessions && <Text style={styles.statusText}>Loading session...</Text>}
          {!loadingSessions && !session && <Text style={styles.errorText}>Session not found.</Text>}
          {session && (
            <View style={styles.titleRowInline}>
              <Text style={styles.sessionTitle}>{session.title || `Session ${session.sessionid}`}</Text>
            </View>
          )}
          {session && (
            <>
              <Text style={styles.sessionTime}>{formatTime(session)}</Text>
              <Text style={styles.sessionFee}>{isFree ? 'Entry: Free' : `Entry Fee: ${formatCurrency(session.entry_fee)}₫/player`}</Text>
              <Text style={styles.sessionDesc}>Description: {session.description || 'No description'}</Text>
            </>
          )}
        </View>
        {session && (
          <View style={styles.sectionCard}>
            <View style={styles.courtHeaderRow}>
              {(() => {
                const venueRaw = session.venue
                const venueTokens = asArray(venueRaw).map(v => v.toLowerCase())
                const hasIndoor = venueTokens.some(t => t.includes('indoor'))
                const hasOutdoor = venueTokens.some(t => t.includes('outdoor'))
                let iconSrc: any = null
                if (hasIndoor && hasOutdoor) iconSrc = ICONS.bothVenue
                else if (hasIndoor) iconSrc = ICONS.indoorIcon
                else if (hasOutdoor) iconSrc = ICONS.outdoorIcon
                return iconSrc ? <Image source={iconSrc} style={styles.venueIcon} /> : null
              })()}
              <Text style={styles.courtNameText}>{session.court_name || 'Court'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Image source={ICONS.mapPin} style={styles.metaIcon} />
              <Text style={styles.courtAddress}>{session.address || 'Address N/A'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Image source={ICONS.clock} style={styles.metaIcon} />
              <Text style={styles.sessionTime}>{formatTime(session)}</Text>
            </View>
          </View>
        )}
        {session && (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>{isFree ? 'Payment' : `Payment (${formatCurrency(session.entry_fee)}₫/player)`}</Text>
            {isFree && <Text style={styles.freeNote}>This training session entry is free</Text>}
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
          <View style={[styles.sectionCard,{backgroundColor:'#e9ffe9'}]}>
            <Text style={styles.successTitle}>Booking Submitted</Text>
            <Text style={styles.successLine}>Status: pending</Text>
            <Text style={styles.successLine}>Session: {session?.title || session?.sessionid}</Text>
            <Text style={styles.successLine}>Time: {formatTime(session)}</Text>
            <Text style={styles.successLine}>Payment Method: {isFree ? 'cash (free)' : paymentMethod}</Text>
          </View>
        )}
      </ScrollView>
      {!confirmation && (
        <SafeAreaView edges={['bottom']} style={styles.bottomSafeArea}>
          <View style={styles.bottomBar}>
            <TouchableOpacity style={[styles.confirmUnifiedBtn, !canSubmit && styles.confirmBtnDisabled]} disabled={!canSubmit} onPress={() => setConfirmModalVisible(true)}>
              <Text style={styles.confirmUnifiedText}>
                {alreadyBooked ? 'Already Booked' : (submitting ? 'Submitting...' : 'Confirm Booking')}
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
            <Text style={styles.modalBody}>Are you sure you want to book this session?</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setConfirmModalVisible(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalConfirm]} onPress={() => {
                setConfirmModalVisible(false)
                handleSubmit()
              }} disabled={!canSubmit}>
                <Text style={[styles.modalBtnText, {color: '#fff'}]}>
                  {alreadyBooked ? 'Already Booked' : 'Confirm'}
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
  screen:{flex:1,backgroundColor:'#fff'},
  headerRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:10},
  backBtn:{padding:10,borderRadius:28,backgroundColor:'#f2f2f2',justifyContent:'center',alignItems:'center'},
  backIcon:{width:22,height:22,tintColor:'#333',resizeMode:'contain'},
  headerTitle:{fontSize:18,fontWeight:'700',marginLeft:12},
  sectionCard:{backgroundColor:'#fafafa',marginHorizontal:16,marginBottom:20,padding:16,borderRadius:14,elevation:2},
  container:{flex:1},
  headerSafeArea:{backgroundColor:'#fff'},
  sectionTitle:{fontSize:16,fontWeight:'700',marginBottom:8},
  statusText:{fontSize:12,color:'#666'},
  errorText:{color:'#c00',fontSize:12,fontWeight:'600'},
  sessionTitle:{fontSize:18,fontWeight:'700',color:'#222'},
  sessionTime:{fontSize:13,color:'#555',marginTop:6},
  sessionFee:{fontSize:13,color:'#333',marginTop:6,fontWeight:'600'},
  sessionDesc:{fontSize:12,color:'#444',lineHeight:18,marginTop:8},
  titleRowInline:{flexDirection:'row',alignItems:'center'},
  courtNameText:{fontSize:18,fontWeight:'700',color:'#222'},
  courtHeaderRow:{flexDirection:'row',alignItems:'center',marginBottom:4},
  expandIcon:{width:18,height:18,tintColor:'#333',resizeMode:'contain'},
  courtAddress:{fontSize:13,color:'#555',marginTop:4},
  venueIcon:{width:28,height:28,resizeMode:'contain',marginRight:8},
  metaRow:{flexDirection:'row',alignItems:'center',marginTop:8},
  metaIcon:{width:18,height:18,tintColor:'#555',marginRight:8,resizeMode:'contain'},
  tagsRow:{flexDirection:'row',flexWrap:'wrap',marginTop:8},
  tag:{backgroundColor:'#eee',paddingHorizontal:10,paddingVertical:6,borderRadius:16,marginRight:6,marginBottom:6},
  tagFallback:{backgroundColor:'#eee'},
  venueTag:{backgroundColor:'#6a5acd'},
  tagText:{fontSize:12,fontWeight:'600',color:'#333'},
  paymentRow:{flexDirection:'row',marginTop:12},
  payMethodBtn:{flex:1,paddingVertical:12,paddingHorizontal:12,backgroundColor:'#eaeaea',marginRight:10,borderRadius:12,flexDirection:'row',alignItems:'center'},
  payMethodActive:{backgroundColor:'#FFA500'},
  payIcon:{width:24,height:24,marginRight:8,resizeMode:'contain'},
  payText:{fontSize:14,fontWeight:'700',color:'#222'},
  paymentMeta:{fontSize:12,fontWeight:'600',color:'#555'},
  freeNote:{fontSize:12,color:'#2e8b57',fontWeight:'700'},
  smallText:{fontSize:12,color:'#666'},
  noteRow:{flexDirection:'row',alignItems:'center',backgroundColor:'#f5f5f5',paddingVertical:14,paddingHorizontal:12,borderRadius:12},
  noteIcon:{width:22,height:22,marginRight:10,resizeMode:'contain'},
  noteTextLabel:{flex:1,fontSize:14,fontWeight:'600',color:'#222'},
  noteArrow:{width:18,height:18,resizeMode:'contain'},
  noteArrowExpanded:{transform:[{rotate:'90deg'}]},
  noteInputWrapper:{marginTop:12,backgroundColor:'#fff',borderWidth:1,borderColor:'#ddd',borderRadius:10},
  noteInput:{minHeight:80,padding:10,fontSize:14,color:'#222',textAlignVertical:'top'},
  bottomBar:{paddingHorizontal:16,paddingVertical:16,backgroundColor:'#ffffff',borderTopWidth:1,borderTopColor:'#eee',alignItems:'center'},
  bottomSafeArea:{position:'absolute',left:0,right:0,bottom:0,backgroundColor:'#ffffff'},
  confirmUnifiedBtn:{width:'90%',backgroundColor:'#FF5733',paddingVertical:18,borderRadius:32,justifyContent:'center',alignItems:'center'},
  confirmUnifiedText:{color:'#fff',fontWeight:'700',fontSize:16},
  confirmBtnDisabled:{backgroundColor:'#ccc'},
  successTitle:{fontSize:14,fontWeight:'700',color:'#0a7a0a'},
  successLine:{fontSize:12,color:'#0a7a0a',marginTop:4},
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
