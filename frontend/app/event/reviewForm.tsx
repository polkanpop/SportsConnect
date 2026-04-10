import React, { useMemo, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, Modal, ScrollView,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Image,
} from 'react-native'
import { Svg, Path } from 'react-native-svg'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ICONS } from '@/constants/icons'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { postReview } from '@/lib/backendApi'
import { COLORS } from '@/constants/colors'
import { useTranslation } from '@/constants/translations'
import { useThemeColors } from '@/hooks/use-theme-colors'

// Route params: targettype (court|event|trainingsession), targetid (string number), title (display name)
export default function ReviewForm() {
  const router = useRouter()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { targettype, targetid, title, venueName, contextLabel } = useLocalSearchParams<{
    targettype: string
    targetid: string
    title: string
    venueName?: string
    contextLabel?: string
  }>()

  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [successVisible, setSuccessVisible] = useState(false)
  const tc = useThemeColors()

  const numericId = parseInt(String(targetid ?? ''), 10)
  const displayTitle = useMemo(() => {
    const rawTitle = title ? decodeURIComponent(String(title)) : ''
    const rawVenueName = venueName ? decodeURIComponent(String(venueName)) : ''
    const tt = String(targettype ?? '').toLowerCase()
    if (tt === 'court') return rawVenueName || rawTitle || t('REVIEW_TARGET_FALLBACK')
    return rawTitle || rawVenueName || t('REVIEW_TARGET_FALLBACK')
  }, [title, venueName, targettype])

  const mutation = useMutation({
    mutationFn: () => {
      const validTypes = ['court', 'event', 'trainingsession']
      const normalized = String(targettype ?? '').toLowerCase().trim()
      const safeType = validTypes.includes(normalized) ? normalized : 'court'
      return postReview({
        targettype: safeType,
        targetid: numericId,
        rating,
        comment: comment.trim(),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: q => {
        const k = Array.isArray(q.queryKey) ? q.queryKey[0] : null
        return k === 'reviews' || k === 'existingReview' || k === 'userReviews'
      }})
      setConfirmVisible(false)
      setSuccessVisible(true)
    },
    onError: (err: any) => {
      setConfirmVisible(false)
      alert(err?.message ?? t('REVIEW_ERR_SUBMIT_FAILED'))
    },
  })

  const handleSubmit = () => {
    if (rating === 0) { alert(t('REVIEW_ERR_NO_RATING')); return }
    if (!comment.trim()) { alert(t('REVIEW_ERR_NO_COMMENT')); return }
    if (!Number.isFinite(numericId)) { alert(t('REVIEW_ERR_INVALID_TARGET')); return }
    setConfirmVisible(true)
  }

  const handleGoBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/Activity')
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: tc.bgBase }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Header */}
          <SafeAreaView edges={['top']}>
            <View style={[styles.header, { backgroundColor: tc.bgSurface, borderBottomColor: tc.divider }]}>
              <TouchableOpacity onPress={handleGoBack} style={[styles.backBtn, { backgroundColor: tc.bgSurface }]}>
                <Image source={ICONS.arrowLeft} style={styles.backIcon} />
              </TouchableOpacity>
              <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>{t('REVIEW_HEADER_TITLE')}</Text>
              <View style={{ width: 44 }} />
            </View>
          </SafeAreaView>

          {/* Target Info */}
          <View style={[styles.card, { backgroundColor: tc.bgSurface, borderColor: tc.divider }]}>
            <Text style={[styles.targetLabel, { color: tc.textPrimary }]}>{displayTitle}</Text>
            <Text style={[styles.targetType, { color: tc.textSecondary }]}>{contextLabel ? decodeURIComponent(String(contextLabel)) : (() => { const tt = String(targettype ?? '').toLowerCase(); if (tt === 'court') return t('COMMON_LABEL_COURT'); if (tt === 'event') return t('COMMON_LABEL_EVENT'); if (tt === 'trainingsession') return t('COMMON_LABEL_TRAINING_SESSION'); return tt; })()}</Text>
          </View>

          {/* Star Rating */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: tc.textPrimary }]}>{t('REVIEW_SECTION_RATING')}</Text>
            <View style={styles.starsRow}>
              {[1, 2, 3, 4, 5].map(star => (
                <TouchableOpacity key={star} onPress={() => setRating(star)} style={styles.starBtn}>
                  <Svg width={40} height={40} viewBox="0 0 24 24">
                    <Path
                      d="M12 2L14.4 9.3H22.1L16 13.6L18.4 20.9L12 16.6L5.6 20.9L8 13.6L1.9 9.3H9.6Z"
                      fill={star <= rating ? '#FBBF24' : (COLORS.neutral425 ?? '#ccc')}
                      stroke={star <= rating ? '#F59E0B' : 'transparent'}
                      strokeWidth={1}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </Svg>
                </TouchableOpacity>
              ))}
            </View>
            {rating > 0 && (
              <Text style={[styles.ratingLabel, { color: tc.textSecondary }]}>
                {(['', t('REVIEW_RATING_POOR'), t('REVIEW_RATING_FAIR'), t('REVIEW_RATING_GOOD'), t('REVIEW_RATING_VERY_GOOD'), t('REVIEW_RATING_EXCELLENT')] as string[])[rating]}
              </Text>
            )}
          </View>

          {/* Comment Input */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: tc.textPrimary }]}>{t('REVIEW_SECTION_COMMENT')}</Text>
            <TextInput
              style={[styles.commentInput, { backgroundColor: tc.bgInput, color: tc.textPrimary, borderColor: tc.divider }]}
              placeholder={t('REVIEW_COMMENT_PLACEHOLDER')}
              placeholderTextColor={tc.placeholder}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              value={comment}
              onChangeText={setComment}
              maxLength={500}
            />
            <Text style={[styles.charCount, { color: tc.textSecondary }]}>{comment.length}/500</Text>
          </View>

          {/* Submit Button */}
          <TouchableOpacity
            style={[styles.submitBtn, (rating === 0 || !comment.trim()) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            activeOpacity={0.8}
          >
            <Text style={styles.submitBtnText}>{t('REVIEW_BTN_SUBMIT')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Confirmation Modal */}
      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: tc.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('REVIEW_MODAL_CONFIRM_TITLE')}</Text>
            <Text style={[styles.modalBody, { color: tc.textSecondary }]}>
              {t('REVIEW_MODAL_CONFIRM_BODY')}
            </Text>
            <View style={styles.starsRowSmall}>
              {[1, 2, 3, 4, 5].map(star => (
                <Svg key={star} width={28} height={28} viewBox="0 0 24 24">
                  <Path
                    d="M12 2L14.4 9.3H22.1L16 13.6L18.4 20.9L12 16.6L5.6 20.9L8 13.6L1.9 9.3H9.6Z"
                    fill={star <= rating ? '#FBBF24' : (COLORS.neutral425 ?? '#ccc')}
                    stroke={star <= rating ? '#F59E0B' : 'transparent'}
                    strokeWidth={1}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </Svg>
              ))}
            </View>
            <Text style={[styles.modalComment, { color: tc.textSecondary }]} numberOfLines={4}>{comment.trim()}</Text>
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalCancelBtn, { backgroundColor: tc.bgSurface }]}
                onPress={() => setConfirmVisible(false)}
                disabled={mutation.isPending}
              >
                <Text style={[styles.modalCancelBtnText, { color: tc.textPrimary }]}>{t('REVIEW_MODAL_BTN_CANCEL')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalConfirmBtn]}
                onPress={() => mutation.mutate()}
                disabled={mutation.isPending}
              >
                {mutation.isPending
                  ? <ActivityIndicator size="small" color={COLORS.white} />
                  : <Text style={styles.modalConfirmBtnText}>{t('REVIEW_MODAL_BTN_SUBMIT')}</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Success Modal */}
      <Modal visible={successVisible} transparent animationType="fade" onRequestClose={handleGoBack}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: tc.bgElevated }]}>
            <View style={styles.successCircle}>
              <Text style={styles.successCheck}>✓</Text>
            </View>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('REVIEW_MODAL_SUCCESS_TITLE')}</Text>
            <Text style={[styles.modalBody, { color: tc.textSecondary }]}>{t('REVIEW_MODAL_SUCCESS_BODY')}</Text>
            <TouchableOpacity style={[styles.modalBtn, styles.modalConfirmBtn, { width: '100%' }]} onPress={handleGoBack}>
              <Text style={styles.modalConfirmBtnText}>{t('REVIEW_MODAL_BTN_DONE')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.neutral0 ?? '#F5F5F5',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: COLORS.white ?? '#fff',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.neutral300 ?? '#e0e0e0',
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    width: 20,
    height: 20,
    resizeMode: 'contain',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.neutral975 ?? '#111',
    textAlign: 'center',
  },
  card: {
    margin: 16,
    padding: 16,
    backgroundColor: COLORS.white ?? '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.neutral300 ?? '#e0e0e0',
  },
  targetLabel: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.neutral975 ?? '#111',
    marginBottom: 4,
  },
  targetType: {
    fontSize: 13,
    color: COLORS.neutral600 ?? '#555',
    textTransform: 'capitalize',
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.neutral975 ?? '#111',
    marginBottom: 10,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
    justifyContent: 'center',
  },
  starBtn: {
    padding: 4,
  },
  starChar: {
    fontSize: 38,
  },
  starFilled: {
    color: '#FBBF24',
  },
  starEmpty: {
    color: COLORS.neutral425 ?? '#ccc',
  },
  ratingLabel: {
    fontSize: 14,
    color: COLORS.neutral700 ?? '#555',
    fontStyle: 'italic',
    marginTop: 2,
  },
  commentInput: {
    borderWidth: 1,
    borderColor: COLORS.neutral425 ?? '#ccc',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: COLORS.neutral975 ?? '#111',
    backgroundColor: COLORS.white ?? '#fff',
    minHeight: 120,
  },
  charCount: {
    textAlign: 'right',
    fontSize: 12,
    color: COLORS.neutral600 ?? '#888',
    marginTop: 4,
  },
  submitBtn: {
    marginHorizontal: 16,
    marginTop: 4,
    backgroundColor: COLORS.success ?? '#28A745',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.45,
  },
  submitBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.white ?? '#fff',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalBox: {
    backgroundColor: COLORS.white ?? '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
  },
  successCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    shadowColor: '#22c55e',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  successCheck: {
    fontSize: 38,
    color: '#fff',
    fontWeight: '900',
    lineHeight: 44,
    marginTop: 2,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.neutral975 ?? '#111',
    marginBottom: 8,
    textAlign: 'center',
  },
  modalBody: {
    fontSize: 14,
    color: COLORS.neutral700 ?? '#444',
    textAlign: 'center',
    marginBottom: 12,
  },
  starsRowSmall: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
    justifyContent: 'center',
  },
  starCharSmall: {
    fontSize: 28,
  },
  modalComment: {
    fontSize: 13,
    color: COLORS.neutral700 ?? '#444',
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 20,
    width: '100%',
  },
  modalBtns: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalCancelBtn: {
    backgroundColor: COLORS.neutral250 ?? '#e0e0e0',
  },
  modalCancelBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.neutral900 ?? '#222',
  },
  modalConfirmBtn: {
    backgroundColor: COLORS.success ?? '#28A745',
  },
  modalConfirmBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white ?? '#fff',
  },
})
