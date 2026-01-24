import React from 'react'
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ICONS } from '@/constants/icons'

export default function Invoice() {
  const router = useRouter()
  const params = useLocalSearchParams()

  const {
    title,
    subtitle,
    date,
    time,
    location,
    price,
    paymentMethod,
    paymentStatus,
    bookingId,
    note,
    type // 'court' | 'event' | 'session'
  } = params

  const handleSeeDetails = () => {
    const id = String(bookingId ?? '')
    const n = Number(id)
    if (!Number.isFinite(n) || n <= 0) return

    const t = String(type ?? '').toLowerCase()
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
    // Handle YYYY-MM-DD (from courtBooking)
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, d] = str.split('-')
      return `${d}/${m}/${y}`
    }
    // If it's already formatted or different, return as is
    return str
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Success Header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Image source={ICONS.checkSquare} style={styles.checkIcon} />
          </View>
          <Text style={styles.successTitle}>Booking Successful!</Text>
          <Text style={styles.successSub}>Your booking has been confirmed.</Text>
        </View>

        {/* Invoice Card */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>INVOICE DETAILS</Text>
          
          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>Booking ID</Text>
            <Text style={styles.value}>#{bookingId || '---'}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>Court</Text>
            <Text style={styles.value}>{title || 'Unknown'}</Text>
          </View>

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
            <Text style={styles.value}>{time || '---'}</Text>
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
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e9ffe9',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  checkIcon: {
    width: 40,
    height: 40,
    tintColor: '#28a745',
    resizeMode: 'contain',
  },
  successTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#222',
    marginBottom: 8,
  },
  successSub: {
    fontSize: 16,
    color: '#666',
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
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#222',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FF5733',
  },
  footerNote: {
    marginTop: 24,
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: {
    padding: 20,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  detailsBtn: {
    backgroundColor: '#fff',
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222',
    marginBottom: 12,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  detailsBtnText: {
    color: '#222',
    fontSize: 16,
    fontWeight: 'bold',
  },
  homeBtn: {
    backgroundColor: '#222',
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  homeBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
})