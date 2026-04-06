import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, Text, TouchableOpacity, UIManager, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import LottieView from 'lottie-react-native'
import { ICONS } from '../../constants/icons'
import { useThemeColors } from '@/hooks/use-theme-colors'

const HAS_LOTTIE_NATIVE = !!(UIManager as any)?.getViewManagerConfig?.('LottieAnimationView')
const EVENT_CREATE_ANIM = require('../../assets/animation/EventCreateSuccessful.json')
const TRAINING_CREATE_ANIM = require('../../assets/animation/TrainingSessionCreateSuccessful.json')
const CREATE_ANIM_SIZE = 220

const CreationInfo = () => {
  const router = useRouter()
  const { type, detailsId } = useLocalSearchParams<{ type: string; detailsId?: string }>()
  const tc = useThemeColors()

  const [revealed, setRevealed] = useState(false)
  const finishedRef = useRef(false)

  const normalizedType = String(type ?? '').toLowerCase().trim()
  const title = normalizedType === 'event' ? 'Event Created Successfully !' : 'Session Created Successfully !'

  const revealAfterAnim = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    setRevealed(true)
  }, [])

  useEffect(() => {
    if (!HAS_LOTTIE_NATIVE) {
      setRevealed(true)
      return
    }

    const t = setTimeout(() => {
      if (!finishedRef.current) revealAfterAnim()
    }, 2600)
    return () => clearTimeout(t)
  }, [revealAfterAnim])

  const handleBackToHome = () => {
    router.replace('/(tabs)/Home')
  }

  const handleSeeDetails = () => {
    const id = typeof detailsId === 'string' ? detailsId : ''
    if (!id) return
    router.replace({ pathname: '/event/details', params: { id } })
  }

  return (
    <View style={[styles.container, { backgroundColor: tc.bgBase }]}>
      {HAS_LOTTIE_NATIVE ? (
        <View style={[styles.animWrap, { width: CREATE_ANIM_SIZE, height: CREATE_ANIM_SIZE }]}> 
          <LottieView
            source={normalizedType === 'event' ? EVENT_CREATE_ANIM : TRAINING_CREATE_ANIM}
            autoPlay
            loop={false}
            onAnimationFinish={revealAfterAnim}
            style={styles.anim}
          />
        </View>
      ) : (
        <Image source={ICONS.createSuccessful} style={styles.icon} />
      )}

      <Text style={[styles.title, { opacity: revealed ? 1 : 0 }]}>{title}</Text>

      <TouchableOpacity
        style={[styles.detailsButton, { opacity: revealed && detailsId ? 1 : 0, backgroundColor: tc.bgSurface, borderColor: tc.textPrimary }]}
        onPress={handleSeeDetails}
        disabled={!revealed || !detailsId}
      >
        <Text style={[styles.detailsButtonText, { color: tc.textPrimary }]}>See details</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, { opacity: revealed ? 1 : 0 }]}
        onPress={handleBackToHome}
        disabled={!revealed}
      >
        <Text style={styles.buttonText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  )
};

export default CreationInfo;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 20,
    paddingBottom: 130,
  },
  icon: {
    width: 120,
    height: 120,
    marginBottom: 30,
  },
  animWrap: {
    marginBottom: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  anim: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10,
    color: '#28a745',
    height: 34,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#FF5733',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
    width: '80%',
    maxWidth: 360,
    alignItems: 'center',
  },
  detailsButton: {
    backgroundColor: '#fff',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: '#222',
    marginTop: 18,
    marginBottom: 12,
    width: '80%',
    maxWidth: 360,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  detailsButtonText: {
    color: '#222',
    fontSize: 18,
    fontWeight: 'bold',
  },
});