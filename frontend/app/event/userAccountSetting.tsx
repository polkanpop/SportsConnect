import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Image, Pressable, StyleSheet, Text, TouchableOpacity, View, UIManager } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ICONS } from '@/constants/icons'
import LottieView from 'lottie-react-native'

const THEME_SWITCH_ANIM = require('../../assets/animation/ThemeSwitch.json')
const AnimatedLottieView = Animated.createAnimatedComponent(LottieView)
const HAS_LOTTIE_NATIVE = !!(UIManager as any)?.getViewManagerConfig?.('LottieAnimationView')

export default function UserAccountSetting() {
  const router = useRouter()
  const [isDark, setIsDark] = useState(false)
  const switchProgress = useRef(new Animated.Value(isDark ? 1 : 0)).current

  useEffect(() => {
    Animated.timing(switchProgress, {
      toValue: isDark ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [isDark, switchProgress])

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.headerRow}>
        <View style={styles.headerSide}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Image source={ICONS.arrowLeft} style={styles.backIcon} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>Account</Text>
        <View style={styles.headerSide} />
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowLeft}>
            <Text style={styles.rowText}>Theme</Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: isDark }}
            onPress={() => setIsDark(v => !v)}
            style={styles.themeSwitchWrap}
          >
            {HAS_LOTTIE_NATIVE ? (
              <AnimatedLottieView
                source={THEME_SWITCH_ANIM}
                progress={switchProgress}
                autoPlay={false}
                loop={false}
                style={styles.themeSwitch}
              />
            ) : (
              <View style={styles.themeSwitchFallback}>
                <View style={[styles.fallbackHalf, !isDark && styles.fallbackHalfActive]}>
                  <Image source={ICONS.lightTheme} style={styles.fallbackIcon} />
                </View>
                <View style={[styles.fallbackHalf, isDark && styles.fallbackHalfActive]}>
                  <Image source={ICONS.darkTheme} style={styles.fallbackIcon} />
                </View>
              </View>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  headerSide: { width: 44, alignItems: 'flex-start' },
  backBtn: { padding: 6, borderRadius: 24, backgroundColor: '#E5E7EB' },
  backIcon: { width: 24, height: 24, tintColor: '#111827', resizeMode: 'contain' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700', color: '#000000' },

  card: { backgroundColor: '#F2F2F2', borderRadius: 18, marginTop: 18, marginHorizontal: 20, paddingHorizontal: 10, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 },
  rowLeft: { flexDirection: 'row', alignItems: 'center' },
  rowText: { fontSize: 15, fontWeight: '600', color: '#000000' },

  themeSwitchWrap: {
    width: 96,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeSwitch: {
    width: 96,
    height: 44,
  },
  themeSwitchFallback: {
    width: 96,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E5E7EB',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  fallbackHalf: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.55,
  },
  fallbackHalfActive: {
    opacity: 1,
    backgroundColor: '#111827',
  },
  fallbackIcon: {
    width: 18,
    height: 18,
    resizeMode: 'contain',
    tintColor: '#FFFFFF',
  },
})