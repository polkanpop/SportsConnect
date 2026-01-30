import React from 'react'
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'

export default function InvoicePending() {
  const router = useRouter()
  const params = useLocalSearchParams()

  const {
    title,
    subtitle,
    courtName,
    date,
    time,
    location,
    price,
    paymentMethod,
    paymentStatus,
    bookingStatus,
    bookingId,
    note,
    type // 'court' | 'event' | 'session'
  } = params

  const normalizedType = String(type ?? '').toLowerCase().trim()
  const normalizedSubtitle = String(Array.isArray(subtitle) ? subtitle[0] : (subtitle ?? '')).toLowerCase().trim()

  const effectiveType = (() => {
    if (normalizedType) return normalizedType
    if (normalizedSubtitle.includes('event')) return 'event'
    if (normalizedSubtitle.includes('training') || normalizedSubtitle.includes('session')) return 'session'
    if (normalizedSubtitle.includes('court')) return 'court'
    return ''
  })()

  const showBookingStatus = effectiveType === 'event' || effectiveType === 'session'

  const normalizedTitle = String(Array.isArray(title) ? title[0] : (title ?? '')).trim()
  const normalizedCourtName = String(Array.isArray(courtName) ? courtName[0] : (courtName ?? '')).trim()

  const subjectLabel = (() => {
    if (effectiveType === 'event') return 'Event'
    if (effectiveType === 'session') return 'Training Session'
    return 'Court'
  })()

  const timeDisplay = (() => {
    const raw = String(Array.isArray(time) ? time[0] : (time ?? '')).trim()
    if (!raw) return '---'
    const parts = raw.split(',')
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].trim()
      return last || raw
    }
    return raw
  })()

  const bookingStatusText = (() => {
    if (!showBookingStatus) return ''
    const raw = bookingStatus ?? ''
    const s = String(Array.isArray(raw) ? raw[0] : raw).trim()
    return s || 'pending'
  })()

  const bookingStatusColor = (() => {
    const s = bookingStatusText.toLowerCase()
    if (s.includes('join') || s.includes('approve')) return '#28a745'
    if (s.includes('cancel') || s.includes('reject')) return '#dc3545'
    if (s.includes('pend')) return '#FF5733'
    return '#333'
  })()

  const handleSeeDetails = () => {
    const id = String(bookingId ?? '')
    const n = Number(id)
    if (!Number.isFinite(n) || n <= 0) return

    const t = effectiveType
    const prefix = t === 'court' ? 'court_' : (t === 'event' ? 'event_' : (t === 'session' ? 'session_' : ''))
    if (!prefix) return

    router.replace({ pathname: '/event/details', params: { id: `${prefix}${n}` } })
  }

  const handleHome = () => {
    router.dismissAll()
    router.replace('/(tabs)/Home')
  }

  const formatPrice = (val: string | string[]) => {
    if (!val) return '0'
    const num = Number(val)
    return new Intl.NumberFormat('vi-VN').format(num)
  }

  const formatDate = (val: string | string[]) => {
    if (!val) return '---'
    const str = String(val)
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, d] = str.split('-')
      return `${d}/${m}/${y}`
    }
    return str
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Image source={ICONS.pending} style={styles.headerIcon} />
          </View>
          <Text style={styles.title}>Your request has been Submitted</Text>
          <Text style={styles.subTitle}>Waiting for host approval.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardHeader}>REQUEST DETAILS</Text>
          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>Booking ID</Text>
            <Text style={styles.value}>#{bookingId || '---'}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>{subjectLabel}</Text>
            <Text style={styles.value}>{normalizedTitle || 'Unknown'}</Text>
          </View>

          {effectiveType !== 'court' && effectiveType !== '' ? (
            <View style={styles.row}>
              <Text style={styles.label}>Court</Text>
              <Text style={styles.value}>{normalizedCourtName || '---'}</Text>
            </View>
          ) : null}

          {subtitle ? (
            <View style={styles.row}>
              <Text style={styles.label}>Type</Text>
              <Text style={styles.value}>{subtitle}</Text>
            </View>
          ) : null}

          <View style={styles.row}>
            <Text style={styles.label}>Address</Text>
            <Text style={styles.value}>{location || '---'}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>Date</Text>
            <Text style={styles.value}>{formatDate(date)}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>Time</Text>
            <Text style={styles.value}>{timeDisplay}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>Payment Method</Text>
            <Text style={[styles.value, { textTransform: 'capitalize' }]}>{paymentMethod || '---'}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>Payment Status</Text>
            <Text style={[styles.value, { textTransform: 'capitalize', color: paymentStatus === 'paid' ? '#28a745' : '#FF5733' }]}>
              {paymentStatus || 'Pending'}
            </Text>
          </View>

          {showBookingStatus ? (
            <View style={styles.row}>
              <Text style={styles.label}>Approve Status</Text>
              <Text style={[styles.value, { textTransform: 'capitalize', color: bookingStatusColor }]}>
                {bookingStatusText}
              </Text>
            </View>
          ) : null}

          {note ? (
            <View style={styles.row}>
              <Text style={styles.label}>Note</Text>
              <Text style={[styles.value, { maxWidth: '60%' }]}>{note}</Text>
            </View>
          ) : null}

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total Amount</Text>
            <Text style={styles.totalValue}>{formatPrice(price)}đ</Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.detailsBtn} onPress={handleSeeDetails}>
          <Text style={styles.detailsBtnText}>See details</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.homeBtn} onPress={handleHome}>
          <Text style={styles.homeBtnText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  scrollContent: {
    padding: 20,
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 30,
    marginTop: 20,
    paddingHorizontal: 12,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#fff3cd',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerIcon: {
    width: 40,
    height: 40,
    tintColor: '#FF5733',
    resizeMode: 'contain',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#222',
    marginBottom: 8,
    textAlign: 'center',
    width: '100%',
    maxWidth: 360,
    lineHeight: 30,
  },
  subTitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    width: '100%',
    maxWidth: 360,
    lineHeight: 22,
  },
  card: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  cardHeader: {
    fontSize: 14,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  label: {
    fontSize: 14,
    color: '#666',
    flex: 1,
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
    color: '#222',
    flex: 1,
    textAlign: 'right',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 14,
    marginTop: 10,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FF5733',
  },
  footer: {
    padding: 20,
    gap: 10,
  },
  detailsBtn: {
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  detailsBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  homeBtn: {
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#111',
  },
  homeBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
})
