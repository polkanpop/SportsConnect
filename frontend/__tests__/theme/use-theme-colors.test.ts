/**
 * use-theme-colors.test.ts — Verify that:
 *  - light theme returns LIGHT_TOKENS
 *  - dark theme returns DARK_TOKENS
 *  - all ThemeTokens keys are present
 *  - brand color is identical in both themes
 */

import { COLORS } from '@/constants/colors'

// We mock the theme provider so we can control isDark
let mockIsDark = false

jest.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({
    theme: mockIsDark ? 'dark' : 'light',
    isDark: mockIsDark,
    isReady: true,
    toggleTheme: jest.fn(),
    setTheme: jest.fn(),
  }),
}))

// Import AFTER mock is set up
import { useThemeColors, ThemeTokens } from '@/hooks/use-theme-colors'

const EXPECTED_KEYS: (keyof ThemeTokens)[] = [
  'bgBase', 'bgSurface', 'bgElevated', 'bgInput', 'bgOverlay',
  'textPrimary', 'textSecondary', 'textMuted',
  'brand', 'brandSoft', 'brandMuted',
  'accentPrimary', 'accentPrimaryLight', 'accentPrimarySoft',
  'accentSecondary', 'accentSecondaryLight', 'accentSecondarySoft',
  'border', 'borderStrong',
  'success', 'error', 'warning',
  'tabBg', 'tabActive', 'tabInactive',
  'skeletonBase', 'skeletonHighlight',
  'cardBg', 'searchBarBg',
  'shadow', 'divider', 'placeholder',
  'iconDefault', 'iconMuted',
  'btnPrimaryBg', 'btnPrimaryText',
  'btnSecondaryBg', 'btnSecondaryText', 'btnSecondaryBorder',
]

beforeEach(() => {
  mockIsDark = false
})

describe('useThemeColors', () => {
  it('returns light tokens when theme is light', () => {
    mockIsDark = false
    const tc = useThemeColors()

    expect(tc.bgBase).toBe(COLORS.white)
    expect(tc.textPrimary).toBe(COLORS.neutral975)
    expect(tc.tabActive).toBe(COLORS.brandOrangeDeep)
  })

  it('returns dark tokens when theme is dark', () => {
    mockIsDark = true
    const tc = useThemeColors()

    expect(tc.bgBase).toBe('#0D0F1A')
    expect(tc.textPrimary).toBe('#F0F2FF')
    expect(tc.tabActive).toBe('#7C3AED')
  })

  it('all expected token keys are present in light', () => {
    mockIsDark = false
    const tc = useThemeColors()

    for (const key of EXPECTED_KEYS) {
      expect(tc).toHaveProperty(key)
      expect(typeof tc[key]).toBe('string')
      expect(tc[key].length).toBeGreaterThan(0)
    }
  })

  it('all expected token keys are present in dark', () => {
    mockIsDark = true
    const tc = useThemeColors()

    for (const key of EXPECTED_KEYS) {
      expect(tc).toHaveProperty(key)
      expect(typeof tc[key]).toBe('string')
      expect(tc[key].length).toBeGreaterThan(0)
    }
  })

  it('brand color switches between themes (orange light, purple dark)', () => {
    mockIsDark = false
    const light = useThemeColors()
    mockIsDark = true
    const dark = useThemeColors()

    expect(light.brand).toBe(COLORS.brandOrangeDeep)
    expect(dark.brand).toBe('#7C3AED')
    expect(light.brand).not.toBe(dark.brand)
  })

  it('dark shadow is transparent (no shadows on dark bg)', () => {
    mockIsDark = true
    const tc = useThemeColors()
    expect(tc.shadow).toBe('transparent')
  })

  it('light and dark tokens have the same set of keys', () => {
    mockIsDark = false
    const lightKeys = Object.keys(useThemeColors()).sort()
    mockIsDark = true
    const darkKeys = Object.keys(useThemeColors()).sort()

    expect(lightKeys).toEqual(darkKeys)
  })
})
