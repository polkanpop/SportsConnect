import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ICONS } from '@/constants/icons'

const SWITCH_TRACK_WIDTH = 66
const SWITCH_TRACK_HEIGHT = 32
const SWITCH_PADDING = 2
const SWITCH_THUMB_SIZE = SWITCH_TRACK_HEIGHT - SWITCH_PADDING * 2
const SWITCH_TRAVEL = SWITCH_TRACK_WIDTH - SWITCH_PADDING * 2 - SWITCH_THUMB_SIZE

export default function UserAccountSetting() {
  const router = useRouter()
  // UI-only for now: default to the "success/on" state so the switch looks correct.
  const [isDark, setIsDark] = useState(true)
  const thumbTranslate = useRef(new Animated.Value(isDark ? SWITCH_TRAVEL : 0)).current

  useEffect(() => {
    Animated.timing(thumbTranslate, {
      toValue: isDark ? SWITCH_TRAVEL : 0,
      duration: 220,
      useNativeDriver: true,
    }).start()
  }, [isDark, thumbTranslate])

  const thumbTransform = useMemo(() => [{ translateX: thumbTranslate }], [thumbTranslate])

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
            <View style={[styles.switchTrack, isDark ? styles.switchTrackOn : styles.switchTrackOff]}>
              <Animated.View style={[styles.switchThumb, { transform: thumbTransform }]}>
                <Image source={isDark ? ICONS.darkTheme : ICONS.lightTheme} style={styles.switchThumbIcon} />
              </Animated.View>
            </View>
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
    width: SWITCH_TRACK_WIDTH,
    height: SWITCH_TRACK_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchTrack: {
    width: SWITCH_TRACK_WIDTH,
    height: SWITCH_TRACK_HEIGHT,
    borderRadius: SWITCH_TRACK_HEIGHT / 2,
    padding: SWITCH_PADDING,
    justifyContent: 'center',
  },
  switchTrackOn: {
    backgroundColor: '#111827',
  },
  switchTrackOff: {
    backgroundColor: '#E5E7EB',
  },
  switchThumb: {
    width: SWITCH_THUMB_SIZE,
    height: SWITCH_THUMB_SIZE,
    borderRadius: SWITCH_THUMB_SIZE / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchThumbIcon: {
    width: SWITCH_THUMB_SIZE - 10,
    height: SWITCH_THUMB_SIZE - 10,
    resizeMode: 'contain',
  },
})