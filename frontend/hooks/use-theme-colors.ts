/**
 * useThemeColors — returns flat color tokens for the current theme.
 * Usage: const tc = useThemeColors()
 *        <View style={{ backgroundColor: tc.bgBase }}>
 */

import { useTheme } from '@/providers/theme-provider'
import { COLORS } from '@/constants/colors'

export interface ThemeTokens {
  // Backgrounds
  bgBase: string
  bgSurface: string
  bgElevated: string
  bgInput: string
  bgOverlay: string

  // Text
  textPrimary: string
  textSecondary: string
  textMuted: string

  // Brand (preserved in both themes)
  brand: string
  brandSoft: string

  // Accent
  accentPrimary: string
  accentPrimaryLight: string
  accentPrimarySoft: string
  accentSecondary: string
  accentSecondaryLight: string
  accentSecondarySoft: string

  // Borders
  border: string
  borderStrong: string

  // Status
  success: string
  error: string
  warning: string

  // Tab bar
  tabBg: string
  tabActive: string
  tabInactive: string

  // Skeleton
  skeletonBase: string
  skeletonHighlight: string

  // Cards / Surfaces
  cardBg: string
  searchBarBg: string

  // Misc
  shadow: string
  divider: string
  placeholder: string
}

const LIGHT_TOKENS: ThemeTokens = {
  bgBase: COLORS.white,
  bgSurface: COLORS.neutral100,
  bgElevated: COLORS.white,
  bgInput: COLORS.white,
  bgOverlay: 'rgba(0,0,0,0.35)',

  textPrimary: COLORS.neutral975,
  textSecondary: COLORS.neutral800,
  textMuted: COLORS.neutral650,

  brand: COLORS.brandOrangeDeep,
  brandSoft: COLORS.orangeSoft,

  accentPrimary: '#7C3AED',
  accentPrimaryLight: '#A78BFA',
  accentPrimarySoft: '#EDE9FE',
  accentSecondary: COLORS.blue600,
  accentSecondaryLight: '#60A5FA',
  accentSecondarySoft: COLORS.blue50,

  border: COLORS.gray200,
  borderStrong: COLORS.neutral450,

  success: COLORS.success,
  error: COLORS.danger,
  warning: COLORS.warning,

  tabBg: COLORS.white,
  tabActive: COLORS.brandOrangeDeep,
  tabInactive: COLORS.neutral650,

  skeletonBase: COLORS.neutral325,
  skeletonHighlight: COLORS.neutral200,

  cardBg: COLORS.white,
  searchBarBg: COLORS.searchBarBg,

  shadow: 'rgba(0,0,0,0.08)',
  divider: COLORS.neutral300,
  placeholder: COLORS.neutral650,
}

const DARK_TOKENS: ThemeTokens = {
  bgBase: '#0D0F1A',
  bgSurface: '#13162A',
  bgElevated: '#1C2040',
  bgInput: '#1A1D35',
  bgOverlay: 'rgba(0,0,0,0.6)',

  textPrimary: '#F0F2FF',
  textSecondary: '#9BA3C7',
  textMuted: '#5A6080',

  brand: COLORS.brandOrangeDeep,
  brandSoft: '#2D1A0A',

  accentPrimary: '#7C3AED',
  accentPrimaryLight: '#A78BFA',
  accentPrimarySoft: '#1E1640',
  accentSecondary: '#2563EB',
  accentSecondaryLight: '#60A5FA',
  accentSecondarySoft: '#0F1F3D',

  border: '#252848',
  borderStrong: '#3A3F6B',

  success: '#34D399',
  error: '#F87171',
  warning: '#FBBF24',

  tabBg: '#10122A',
  tabActive: '#7C3AED',
  tabInactive: '#4A5080',

  skeletonBase: '#1C2040',
  skeletonHighlight: '#252849',

  cardBg: '#13162A',
  searchBarBg: '#1A1D35',

  shadow: 'transparent',
  divider: '#252848',
  placeholder: '#5A6080',
}

export function useThemeColors(): ThemeTokens {
  const { isDark } = useTheme()
  return isDark ? DARK_TOKENS : LIGHT_TOKENS
}
