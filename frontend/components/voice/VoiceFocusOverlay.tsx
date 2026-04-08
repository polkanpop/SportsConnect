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
import { useVoiceAutomation, VoiceFlowState, VoiceResult, VoiceReplyType } from '@/providers/voice-automation-provider'
import { useTranslation } from '@/constants/translations'
import { useThemeColors } from '@/hooks/use-theme-colors'

export default function VoiceFocusOverlay() {
  const { flowState, partialTranscript, result, statusMessage, stopListening, dismiss, startListening, applyAndReset } = useVoiceAutomation()
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  const tc = useThemeColors()

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
            tc={tc}
          />
        )}

        {flowState === 'processing' && (
          <ProcessingView statusMessage={statusMessage} tc={tc} />
        )}

        {flowState === 'result' && result && (
          <ResultView
            result={result}
            onApply={applyAndReset}
            onRetry={startListening}
            onDismiss={dismiss}
            t={t}
            tc={tc}
          />
        )}

        {flowState === 'error' && result && (
          <ErrorView
            errorMessage={result.reply_message ?? result.error_message ?? 'Có lỗi xảy ra.'}
            onRetry={startListening}
            onDismiss={dismiss}
            t={t}
            tc={tc}
          />
        )}
      </View>
    </Animated.View>
  )
}

// ── Listening ─────────────────────────────────────────────────────────────────

function ListeningView({ partialTranscript, onStop, tc }: { partialTranscript: string; onStop: () => void; tc: ReturnType<typeof useThemeColors> }) {
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
        <Animated.View style={[styles.micCircle, { backgroundColor: tc.brand, shadowColor: tc.brand, transform: [{ scale: pulseAnim }] }]}>
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

function ProcessingView({ statusMessage, tc }: { statusMessage: string; tc: ReturnType<typeof useThemeColors> }) {
  return (
    <View style={styles.stateContainer}>
      <ActivityIndicator size="large" color={tc.brand} />
      <Text style={styles.hintText}>{statusMessage || 'Đang xử lý...'}</Text>
    </View>
  )
}

// ── Result ────────────────────────────────────────────────────────────────────

const EXTRACTED_LABELS: Record<string, { en: string; vi: string }> = {
  court_name_raw: { en: 'Court', vi: 'Sân' },
  court_half: { en: 'Half court', vi: 'Nửa sân' },
  date_raw: { en: 'Date', vi: 'Ngày' },
  time_start_raw: { en: 'Time', vi: 'Giờ' },
  duration_raw: { en: 'Duration', vi: 'Thời lượng' },
  player_count: { en: 'Players', vi: 'Số người chơi' },
  event_name_raw: { en: 'Event', vi: 'Sự kiện' },
  event_id_raw: { en: 'Event ID', vi: 'Mã sự kiện' },
  booking_ref_raw: { en: 'Booking ref', vi: 'Mã đặt chỗ' },
  cancel_type: { en: 'Cancel type', vi: 'Hủy loại' },
}

const INTENT_TITLES: Record<string, { en: string; vi: string }> = {
  book_court: { en: 'Court Booking', vi: 'Đặt sân' },
  book_training_session: { en: 'Training Session', vi: 'Đăng ký buổi tập' },
  book_event: { en: 'Event Registration', vi: 'Đăng ký sự kiện' },
  cancel_booking: { en: 'Cancel Booking', vi: 'Hủy đặt chỗ' },
  check_availability: { en: 'Check Availability', vi: 'Kiểm tra lịch trống' },
  query_schedule: { en: 'View Schedule', vi: 'Xem lịch trình' },
}

function ResultView({ result, onApply, onRetry, onDismiss, t, tc }: {
  result: VoiceResult
  onApply: () => void
  onRetry: () => void
  onDismiss: () => void
  t: (key: any) => string
  tc: ReturnType<typeof useThemeColors>
}) {
  const { intent, booking_type, reply_type, reply_message, extracted, clarification_needed, confidence } = result

  // ── Non-booking intents (greeting, off_topic, unclear, clarification) ──
  if (reply_type === 'greeting' || reply_type === 'off_topic' || reply_type === 'unclear') {
    return (
      <View style={styles.stateContainer}>
        <Image
          source={ICONS.microphone}
          style={{ width: 48, height: 48, tintColor: reply_type === 'greeting' ? '#4CAF50' : '#FFA726', marginBottom: 12 }}
          resizeMode="contain"
        />
        <Text style={styles.replyMessage}>{reply_message ?? 'Bạn hãy thử lại nhé.'}</Text>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.btnSecondary} onPress={onDismiss}>
            <Text style={styles.btnSecondaryText}>Đóng</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btnPrimary, { backgroundColor: tc.brand }]} onPress={onRetry}>
            <Text style={styles.btnPrimaryText}>↻ Thử lại</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  // ── Clarification needed ──
  if (reply_type === 'clarification') {
    return (
      <View style={styles.stateContainer}>
        <Image source={ICONS.microphone} style={{ width: 48, height: 48, tintColor: '#FFA726', marginBottom: 12 }} resizeMode="contain" />

        {/* Show what we have so far */}
        <View style={styles.transcriptBox}>
          <Text style={styles.transcriptLabel}>Bạn nói:</Text>
          <Text style={styles.transcriptText}>"{result.transcript}"</Text>
        </View>

        {/* Clarification prompt */}
        <View style={[styles.intentCard, { borderLeftWidth: 3, borderLeftColor: '#FFA726' }]}>
          <Text style={[styles.intentTitle, { color: '#FFA726' }]}>Cần thêm thông tin</Text>
          <Text style={styles.replyMessageSmall}>{reply_message}</Text>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.btnSecondary} onPress={onDismiss}>
            <Text style={styles.btnSecondaryText}>Đóng</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btnPrimary, { backgroundColor: tc.brand }]} onPress={onRetry}>
            <Image source={ICONS.microphone} style={{ width: 18, height: 18, tintColor: '#FFF', marginRight: 4 }} resizeMode="contain" />
            <Text style={styles.btnPrimaryText}>Nói lại</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  // ── Optimistic / booking result ──
  const title = intent ? (INTENT_TITLES[intent]?.vi ?? 'Yêu cầu') : 'Yêu cầu'
  const extractedFields = extracted
    ? Object.entries(extracted).filter(([_, v]) => v != null && v !== false)
    : []

  return (
    <View style={styles.stateContainer}>
      <Image source={ICONS.check} style={{ width: 48, height: 48, tintColor: '#4CAF50', marginBottom: 12 }} resizeMode="contain" />

      {/* Transcript */}
      <View style={styles.transcriptBox}>
        <Text style={styles.transcriptLabel}>Bạn nói:</Text>
        <Text style={styles.transcriptText}>"{result.transcript}"</Text>
      </View>

      {/* Intent summary */}
      {extractedFields.length > 0 && (
        <View style={styles.intentCard}>
          <View style={styles.intentHeader}>
            <Text style={styles.intentTitle}>{title}</Text>
            {booking_type && (
              <View style={[styles.badge, { backgroundColor: tc.brand }]}>
                <Text style={styles.badgeText}>
                  {booking_type === 'court' ? 'Sân' : booking_type === 'training_session' ? 'Buổi tập' : 'Sự kiện'}
                </Text>
              </View>
            )}
          </View>
          {extractedFields.map(([key, value]) => (
            <View key={key} style={styles.intentRow}>
              <Text style={styles.intentLabel}>{EXTRACTED_LABELS[key]?.vi ?? key}:</Text>
              <Text style={styles.intentValue}>
                {typeof value === 'boolean' ? 'Có' : String(value)}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Optimistic message */}
      {reply_message && reply_type === 'optimistic' && (
        <Text style={styles.optimisticText}>{reply_message}</Text>
      )}

      {/* Actions */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.btnSecondary} onPress={onRetry}>
          <Text style={styles.btnSecondaryText}>↻ Thử lại</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.btnPrimary, { backgroundColor: tc.brand }]} onPress={onApply}>
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

function ErrorView({ errorMessage, onRetry, onDismiss, t, tc }: {
  errorMessage: string
  onRetry: () => void
  onDismiss: () => void
  t: (key: any) => string
  tc: ReturnType<typeof useThemeColors>
}) {
  return (
    <View style={styles.stateContainer}>
      <Image source={ICONS.microphone} style={{ width: 48, height: 48, tintColor: '#F44336', marginBottom: 12 }} resizeMode="contain" />
      <Text style={styles.errorText}>{errorMessage}</Text>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.btnSecondary} onPress={onDismiss}>
          <Text style={styles.btnSecondaryText}>Đóng</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.btnPrimary, { backgroundColor: tc.brand }]} onPress={onRetry}>
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
  replyMessage: {
    color: '#FFF',
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 24,
    paddingHorizontal: 12,
  },
  replyMessageSmall: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 4,
  },
  intentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  badgeText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  optimisticText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
    fontStyle: 'italic',
  },
})
