/**
 * VoiceFocusOverlay — Full-screen overlay for voice booking flow.
 *
 * States:
 *   listening   → Pulsing mic, partial transcript, "Đang nghe..."
 *   processing  → Spinner, status message ("Đang phân tích...")
 *   result      → Intent summary with "Áp dụng" + "Thử lại" buttons
 *   error       → Error message with "Thử lại" button
 */

import React, { useCallback, useEffect, useRef } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { COLORS } from '@/constants/colors'
import { ICONS } from '@/constants/icons'
import { useVoiceAutomation, VoiceFlowState } from '@/providers/voice-automation-provider'
import { useTranslation } from '@/constants/translations'

export default function VoiceFocusOverlay() {
  const { flowState, partialTranscript, result, statusMessage, stopListening, dismiss, startListening, applyAndReset } = useVoiceAutomation()
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()

  // Fade-in animation on mount
  const fadeAnim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (flowState !== 'idle') {
      fadeAnim.setValue(0)
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start()
    }
  }, [flowState !== 'idle'])

  // Only render when flow is active
  if (flowState === 'idle') return null

  return (
    <Animated.View style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16, opacity: fadeAnim }]}>
      <TouchableOpacity style={styles.closeBtn} onPress={dismiss} hitSlop={12}>
        <Image source={ICONS.closeMenu} style={{ width: 28, height: 28, tintColor: '#FFF' }} resizeMode="contain" />
      </TouchableOpacity>

      <View style={styles.content}>
        {flowState === 'listening' && (
          <ListeningView
            partialTranscript={partialTranscript}
            onStop={stopListening}
          />
        )}

        {flowState === 'processing' && (
          <ProcessingView statusMessage={statusMessage} />
        )}

        {flowState === 'result' && result && (
          <ResultView
            result={result}
            onApply={applyAndReset}
            onRetry={startListening}
            onDismiss={dismiss}
            t={t}
          />
        )}

        {flowState === 'error' && result && (
          <ErrorView
            errorMessage={result.error_message ?? 'Có lỗi xảy ra.'}
            onRetry={startListening}
            onDismiss={dismiss}
            t={t}
          />
        )}
      </View>
    </Animated.View>
  )
}

// ── Listening ─────────────────────────────────────────────────────────────────

function ListeningView({ partialTranscript, onStop }: { partialTranscript: string; onStop: () => void }) {
  const pulseAnim = useRef(new Animated.Value(1)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.25, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.1, duration: 600, useNativeDriver: true }),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [pulseAnim])

  return (
    <View style={styles.stateContainer}>
      <Text style={styles.hintText}>Đang nghe...</Text>

      <Pressable onPress={onStop}>
        <Animated.View style={[styles.micCircle, { transform: [{ scale: pulseAnim }] }]}>
          <Image source={ICONS.microphone} style={{ width: 44, height: 44, tintColor: '#FFF' }} resizeMode="contain" />
        </Animated.View>
      </Pressable>

      {partialTranscript ? (
        <View style={styles.transcriptBox}>
          <Text style={styles.transcriptText}>{partialTranscript}</Text>
        </View>
      ) : (
        <Text style={styles.subHintText}>Nhấn nút micro để dừng</Text>
      )}
    </View>
  )
}

// ── Processing ────────────────────────────────────────────────────────────────

function ProcessingView({ statusMessage }: { statusMessage: string }) {
  return (
    <View style={styles.stateContainer}>
      <ActivityIndicator size="large" color={COLORS.brandOrangeDeep ?? '#FF6017'} />
      <Text style={styles.hintText}>{statusMessage || 'Đang xử lý...'}</Text>
    </View>
  )
}

// ── Result ────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, { en: string; vi: string }> = {
  date: { en: 'Date', vi: 'Ngày' },
  time: { en: 'Time', vi: 'Giờ' },
  duration_minutes: { en: 'Duration', vi: 'Thời lượng' },
  court_type: { en: 'Court type', vi: 'Loại sân' },
  payment_method: { en: 'Payment', vi: 'Thanh toán' },
  note: { en: 'Note', vi: 'Ghi chú' },
}

function ResultView({ result, onApply, onRetry, onDismiss, t }: {
  result: { transcript: string; intent: any }
  onApply: () => void
  onRetry: () => void
  onDismiss: () => void
  t: (key: any) => string
}) {
  const intent = result.intent ?? {}
  const fields = Object.entries(intent).filter(([_, v]) => v != null)

  return (
    <View style={styles.stateContainer}>
      <Image source={ICONS.check} style={{ width: 48, height: 48, tintColor: '#4CAF50', marginBottom: 12 }} resizeMode="contain" />

      {/* Transcript */}
      <View style={styles.transcriptBox}>
        <Text style={styles.transcriptLabel}>Bạn nói:</Text>
        <Text style={styles.transcriptText}>"{result.transcript}"</Text>
      </View>

      {/* Intent summary */}
      {fields.length > 0 && (
        <View style={styles.intentCard}>
          <Text style={styles.intentTitle}>Thông tin đặt sân</Text>
          {fields.map(([key, value]) => (
            <View key={key} style={styles.intentRow}>
              <Text style={styles.intentLabel}>{FIELD_LABELS[key]?.vi ?? key}:</Text>
              <Text style={styles.intentValue}>
                {key === 'duration_minutes' ? `${value} phút` : String(value)}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Actions */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.btnSecondary} onPress={onRetry}>
          <Text style={styles.btnSecondaryText}>↻ Thử lại</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnPrimary} onPress={onApply}>
          <Image source={ICONS.check} style={{ width: 18, height: 18, tintColor: '#FFF', marginRight: 4 }} resizeMode="contain" />
          <Text style={styles.btnPrimaryText}>Áp dụng</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={onDismiss} style={{ marginTop: 8 }}>
        <Text style={styles.dismissText}>Đóng</Text>
      </TouchableOpacity>
    </View>
  )
}

// ── Error ─────────────────────────────────────────────────────────────────────

function ErrorView({ errorMessage, onRetry, onDismiss, t }: {
  errorMessage: string
  onRetry: () => void
  onDismiss: () => void
  t: (key: any) => string
}) {
  return (
    <View style={styles.stateContainer}>
      <Image source={ICONS.microphone} style={{ width: 48, height: 48, tintColor: '#F44336', marginBottom: 12 }} resizeMode="contain" />
      <Text style={styles.errorText}>{errorMessage}</Text>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.btnSecondary} onPress={onDismiss}>
          <Text style={styles.btnSecondaryText}>Đóng</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnPrimary} onPress={onRetry}>
          <Text style={styles.btnPrimaryText}>↻ Thử lại</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    zIndex: 99999,
    elevation: 50,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  closeBtn: {
    position: 'absolute',
    top: 52,
    right: 20,
    zIndex: 10,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  stateContainer: {
    alignItems: 'center',
    width: '100%',
  },
  hintText: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 24,
    textAlign: 'center',
  },
  subHintText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    marginTop: 16,
    textAlign: 'center',
  },
  micCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: COLORS.brandOrangeDeep ?? '#FF6017',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: COLORS.brandOrangeDeep ?? '#FF6017',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  transcriptBox: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginTop: 12,
  },
  transcriptLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginBottom: 4,
  },
  transcriptText: {
    color: '#FFF',
    fontSize: 16,
    lineHeight: 22,
  },
  intentCard: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginTop: 16,
  },
  intentTitle: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  intentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.15)',
  },
  intentLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
  },
  intentValue: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
    maxWidth: '60%',
    textAlign: 'right',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.brandOrangeDeep ?? '#FF6017',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  btnPrimaryText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  btnSecondaryText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    color: '#FFF',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 22,
  },
  dismissText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
  },
})
