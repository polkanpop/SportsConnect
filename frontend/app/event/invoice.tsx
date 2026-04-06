import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, View, ScrollView, TouchableOpacity, Image, UIManager } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import LottieView from 'lottie-react-native'
import { ICONS } from '@/constants/icons'
import { useTranslation } from '@/constants/translations'

const SUCCESS_ANIM = require('../../assets/animation/SuccessfulJoin.json')
const HAS_LOTTIE_NATIVE = !!(UIManager as any)?.getViewManagerConfig?.('LottieAnimationView')

export default function Invoice() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const { t } = useTranslation()

  const [revealed, setRevealed] = useState(false)
  const finishedRef = useRef(false)
  const animSize = useRef(new Animated.Value(140)).current

  const shrinkAndReveal = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true

    if (!HAS_LOTTIE_NATIVE) {
      setRevealed(true)
      return
    }

    Animated.timing(animSize, {
      toValue: 140,
      duration: 260,
      useNativeDriver: false,
    }).start(() => setRevealed(true))
  }, [animSize])

  useEffect(() => {
    if (!HAS_LOTTIE_NATIVE) {
      setRevealed(true)
      return
    }

    // Zoom-in at start (small -> big)
    animSize.setValue(140)
    Animated.timing(animSize, {
      toValue: 260,
      duration: 220,
      useNativeDriver: false,
    }).start()

    // Fallback in case the animation finish callback doesn't fire on some devices.
    const t = setTimeout(() => {
      if (!finishedRef.current) shrinkAndReveal()
    }, 2600)
    return () => clearTimeout(t)
  }, [animSize, shrinkAndReveal])

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
    if (effectiveType === 'event') return t('INVOICE_SUBJECT_EVENT')
    if (effectiveType === 'session') return t('INVOICE_SUBJECT_SESSION')
    return t('INVOICE_SUBJECT_COURT')
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

  const translateBookingStatus = (s: string) => {
    const low = s.toLowerCase()
    if (low.includes('join') || low.includes('approv')) return t('INVOICE_STATUS_APPROVED')
    if (low.includes('cancel')) return t('INVOICE_STATUS_CANCELLED')
    if (low.includes('reject')) return t('INVOICE_STATUS_REJECTED')
    if (low.includes('pend')) return t('INVOICE_STATUS_PENDING')
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  const translatePaymentMethod = (raw: any) => {
    const s = String(raw ?? '').trim().toLowerCase()
    if (s.includes('cash') || s === 'tiền mặt') return t('INVOICE_PAYMENT_CASH')
    if (s.includes('vnpay')) return t('INVOICE_PAYMENT_VNPAY')
    return String(raw ?? '---')
  }

  const translatePaymentStatus = (raw: any) => {
    const s = String(raw ?? '').trim().toLowerCase()
    if (s === 'paid') return t('INVOICE_PAYMENT_PAID')
    if (s === 'unpaid' || !s) return t('INVOICE_PAYMENT_UNPAID')
    return String(raw ?? t('INVOICE_STATUS_PENDING'))
  }

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
          {HAS_LOTTIE_NATIVE ? (
            <Animated.View style={[styles.successAnimWrap, { width: animSize, height: animSize }]}>
              <LottieView
                source={SUCCESS_ANIM}
                autoPlay
                loop={false}
                onAnimationFinish={shrinkAndReveal}
                style={styles.successAnim}
              />
            </Animated.View>
          ) : (
            <View style={styles.iconCircle}>
              <Image source={ICONS.checkSquare} style={styles.checkIcon} />
            </View>
          )}

          {revealed ? (
            <>
              <Text style={styles.successTitle}>{t('INVOICE_SUCCESS_TITLE')}</Text>
              <Text style={styles.successSub}>{t('INVOICE_SUCCESS_SUB')}</Text>
            </>
          ) : null}
        </View>

        {revealed ? (
          <View style={styles.card}>
          <Text style={styles.cardHeader}>{t('INVOICE_CARD_HEADER')}</Text>
          
          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_BOOKING_ID')}</Text>
            <Text style={styles.value}>#{bookingId || '---'}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>{subjectLabel}</Text>
            <Text style={styles.value}>{normalizedTitle || 'Unknown'}</Text>
          </View>

          {effectiveType !== 'court' && effectiveType !== '' ? (
            <View style={styles.row}>
              <Text style={styles.label}>{t('INVOICE_LABEL_COURT')}</Text>
              <Text style={styles.value}>{normalizedCourtName || '---'}</Text>
            </View>
          ) : null}

          {subtitle ? (
            <View style={styles.row}>
              <Text style={styles.label}>{t('INVOICE_LABEL_TYPE')}</Text>
              <Text style={styles.value}>{subtitle}</Text>
            </View>
          ) : null}

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_ADDRESS')}</Text>
            <Text style={styles.value}>{location || '---'}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_DATE')}</Text>
            <Text style={styles.value}>{formatDate(date)}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_TIME')}</Text>
            <Text style={styles.value}>{timeDisplay}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_PAYMENT_METHOD')}</Text>
            <Text style={styles.value}>{translatePaymentMethod(paymentMethod)}</Text>
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>{t('INVOICE_LABEL_PAYMENT_STATUS')}</Text>
            <Text style={[styles.value, { color: paymentStatus === 'paid' ? '#28a745' : '#FF5733' }]}>
              {translatePaymentStatus(paymentStatus)}
            </Text>
          </View>

          {showBookingStatus ? (
            <View style={styles.row}>
              <Text style={styles.label}>{t('INVOICE_LABEL_BOOKING_STATUS')}</Text>
              <Text style={[styles.value, { color: bookingStatusColor }]}>
                {translateBookingStatus(bookingStatusText)}
              </Text>
            </View>
          ) : null}

          {note ? (
            <View style={styles.row}>
              <Text style={styles.label}>{t('INVOICE_LABEL_NOTE')}</Text>
              <Text style={[styles.value, { maxWidth: '60%' }]}>{note}</Text>
            </View>
          ) : null}

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>{t('INVOICE_TOTAL_AMOUNT')}</Text>
            <Text style={styles.totalValue}>{formatPrice(price)}đ</Text>
          </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.detailsBtn} onPress={handleSeeDetails}>
          <Text style={styles.detailsBtnText}>{t('INVOICE_BTN_SEE_DETAILS')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.homeBtn} onPress={handleHome}>
          <Text style={styles.homeBtnText}>{t('INVOICE_BTN_BACK_HOME')}</Text>
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
    marginBottom: 20,
    marginTop: 20,
  },
  successAnimWrap: {
    width: 200,
    height: 200,
    marginBottom: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successAnim: {
    width: '100%',
    height: '100%',
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
    marginBottom: 4,
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