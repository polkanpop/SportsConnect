/**
 * useScreenStyles — provides commonly reused themed style objects
 * for screens that haven't been individually deep-themed yet.
 * Gives a safe dark-mode baseline for container, text, cards, buttons.
 */

import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import { useThemeColors, ThemeTokens } from '@/hooks/use-theme-colors'

export function useScreenStyles() {
  const tc = useThemeColors()
  const s = useMemo(() => createScreenStyles(tc), [tc])
  return { tc, s }
}

function createScreenStyles(tc: ThemeTokens) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: tc.bgBase,
    },
    container: {
      flex: 1,
      backgroundColor: tc.bgBase,
    },
    card: {
      backgroundColor: tc.cardBg,
      borderColor: tc.border,
    },
    textPrimary: {
      color: tc.textPrimary,
    },
    textSecondary: {
      color: tc.textSecondary,
    },
    textMuted: {
      color: tc.textMuted,
    },
    header: {
      backgroundColor: tc.bgBase,
    },
    headerTitle: {
      color: tc.textPrimary,
      fontSize: 20,
      fontWeight: '700',
    },
    divider: {
      backgroundColor: tc.divider,
    },
    input: {
      backgroundColor: tc.bgInput,
      borderColor: tc.border,
      color: tc.textPrimary,
    },
    btnPrimary: {
      backgroundColor: tc.btnPrimaryBg,
    },
    btnPrimaryText: {
      color: tc.btnPrimaryText,
    },
    shadow: {
      shadowColor: tc.shadow,
    },
    icon: {
      tintColor: tc.iconDefault,
    },
    iconMuted: {
      tintColor: tc.iconMuted,
    },
  })
}
