import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, View, UIManager } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import LottieView from 'lottie-react-native'

const HAS_LOTTIE_NATIVE = !!(UIManager as any)?.getViewManagerConfig?.('LottieAnimationView')

const ANIMATIONS = {
  success: require('../../assets/animation/SuccessfulJoin.json'),
  cancel: require('../../assets/animation/Cancel.json'),
  booking_cancel: require('../../assets/animation/BookingCancel.json'),
  event_create_successful: require('../../assets/animation/EventCreateSuccessful.json'),
  training_create_successful: require('../../assets/animation/TrainingSessionCreateSuccessful.json'),
  join_successful: require('../../assets/animation/SuccessfulJoin.json'),
  successful_join: require('../../assets/animation/SuccessfulJoin.json'),
  succesfull_join: require('../../assets/animation/SuccessfulJoin.json'),
  successfull_join: require('../../assets/animation/SuccessfulJoin.json'),
  loading: require('../../assets/animation/Loading.json'),
} as const

type AnimationKey = keyof typeof ANIMATIONS

export default function StatusTransition() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const hasNavigatedRef = useRef(false)

  const [revealed, setRevealed] = useState(false)
  const finishedRef = useRef(false)

  const animationKey: AnimationKey = useMemo(() => {
    const raw = params.anim
    const k = String(Array.isArray(raw) ? raw[0] : (raw ?? 'success')).trim() as AnimationKey
    return k in ANIMATIONS ? k : 'success'
  }, [params.anim])

  const nextPath = useMemo(() => {
    const raw = params.next
    const s = String(Array.isArray(raw) ? raw[0] : (raw ?? '')).trim()
    return s || null
  }, [params.next])

  const detailsId = useMemo(() => {
    const raw = (params as any).detailsId
    const s = String(Array.isArray(raw) ? raw[0] : (raw ?? '')).trim()
    return s || null
  }, [(params as any).detailsId])

  // `cancel`: event/session cancel (screen only shows 2 actions) -> no zoom needed.
  // `booking_cancel`: court booking cancel -> keep zoom-in/out + reveal flow.
  const isSimpleCancel = animationKey === 'cancel'
  const isCancelFlow = animationKey === 'cancel' || animationKey === 'booking_cancel'

  const noZoomFlow =
    isSimpleCancel ||
    animationKey === 'event_create_successful' ||
    animationKey === 'training_create_successful'

  const fixedSize = isSimpleCancel ? 120 : 220

  const animSize = useRef(new Animated.Value(noZoomFlow ? fixedSize : 140)).current

  const forwardParams = useMemo(() => {
    const clone: Record<string, string | string[]> = { ...params }
    delete (clone as any).anim
    delete (clone as any).next
    return clone
  }, [params])

  const goNext = () => {
    if (hasNavigatedRef.current) return
    hasNavigatedRef.current = true

    if (nextPath) {
      router.replace({ pathname: nextPath as any, params: forwardParams as any })
      return
    }

    const canGoBack = (router as any).canGoBack?.()
    if (canGoBack) {
      router.back()
      return
    }

    router.replace('/(tabs)/Home')
  }

  const titleText = useMemo(() => {
    if (animationKey === 'booking_cancel') return 'Booking Cancelled Successfully'
    if (animationKey === 'cancel') return 'Cancelled Successfully'
    if (animationKey === 'event_create_successful') return 'Event Created Successfully'
    if (animationKey === 'training_create_successful') return 'Session Created Successfully'
    if (animationKey === 'success') return 'Successful'
    return 'Successful'
  }, [animationKey])

  const handleSeeDetails = useCallback(() => {
    if (!detailsId) return
    router.replace({ pathname: '/event/details', params: { id: detailsId } } as any)
  }, [detailsId, router])

  const handleHome = useCallback(() => {
    router.dismissAll()
    router.replace('/(tabs)/Home')
  }, [router])

  const shrinkAndReveal = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true

    if (!HAS_LOTTIE_NATIVE) {
      setRevealed(true)
      return
    }

    // No-zoom flows: just reveal after the animation finishes.
    if (noZoomFlow) {
      setRevealed(true)
      return
    }

    // Other flows: zoom-out after the animation finishes.
    Animated.timing(animSize, {
      toValue: 140,
      duration: 260,
      useNativeDriver: false,
    }).start(() => setRevealed(true))
  }, [animSize, noZoomFlow])

  useEffect(() => {
    if (!HAS_LOTTIE_NATIVE) {
      setRevealed(true)
      return
    }

    // No-zoom flows: keep steady size.
    if (noZoomFlow) {
      animSize.setValue(fixedSize)
      return
    }

    // Other flows: zoom-in at start (small -> big)
    animSize.setValue(140)
    Animated.timing(animSize, {
      toValue: 260,
      duration: 220,
      useNativeDriver: false,
    }).start()
  }, [animSize, fixedSize, noZoomFlow])

  useEffect(() => {
    if (!revealed) return
    if (isCancelFlow) return
    const t = setTimeout(goNext, 900)
    return () => clearTimeout(t)
  }, [isCancelFlow, revealed])

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.page}>
        <View style={[styles.inner, isCancelFlow && styles.innerRaised]}>
          {HAS_LOTTIE_NATIVE ? (
            <>
              <Animated.View style={[styles.animationWrap, { width: animSize, height: animSize }]}>
                <LottieView
                  source={ANIMATIONS[animationKey]}
                  autoPlay
                  loop={false}
                  speed={animationKey === 'booking_cancel' ? 2 : 1}
                  onAnimationFinish={shrinkAndReveal}
                  style={styles.animation}
                />
              </Animated.View>
              <Text
                style={[
                  styles.title,
                  isSimpleCancel && styles.titleCancel,
                  { opacity: revealed ? 1 : 0 },
                ]}
              >
                {titleText}
              </Text>
            </>
          ) : (
            // No native Lottie view available -> show text/buttons immediately.
            <>
              <View style={[styles.animationWrap, { width: 140, height: 140 }]} />
              <Text
                style={[
                  styles.title,
                  isSimpleCancel && styles.titleCancel,
                  { opacity: revealed ? 1 : 0 },
                ]}
              >
                {titleText}
              </Text>
            </>
          )}
        </View>

        {isCancelFlow && revealed ? (
          <View style={styles.footer}>
            <View style={styles.footerInner}>
              <View style={{ width: '100%' }}>
                <View style={{ opacity: detailsId ? 1 : 0.45 }}>
                  <Text
                    onPress={detailsId ? handleSeeDetails : undefined}
                    style={styles.detailsBtnText}
                  >
                    See details
                  </Text>
                </View>
                <Text onPress={handleHome} style={styles.homeBtnText}>
                  Back to Home
                </Text>
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  page: {
    flex: 1,
  },
  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  innerRaised: {
    paddingBottom: 120,
  },
  animationWrap: {
    marginBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  animation: {
    width: '100%',
    height: '100%',
  },
  title: {
    marginTop: 4,
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    paddingHorizontal: 22,
    height: 32,
  },
  titleCancel: {
    fontSize: 22,
    height: 34,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 20,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  footerInner: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  detailsBtnText: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#222',
    borderRadius: 30,
    paddingVertical: 16,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: 'bold',
    color: '#222',
    marginBottom: 12,
    overflow: 'hidden',
  },
  homeBtnText: {
    backgroundColor: '#222',
    borderRadius: 30,
    paddingVertical: 16,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    overflow: 'hidden',
  },
})
