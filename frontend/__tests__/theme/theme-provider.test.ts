/**
 * theme-provider.test.ts — Verify theme provider module:
 *  - exports correct types and functions
 *  - ThemeMode type correctness
 *  - AppThemeProvider is a valid React component
 *
 * NOTE: Full hook + rendering tests require a React Native test environment.
 * These tests verify the module exports and structure in a node env.
 */

// Mock AsyncStorage before importing the module
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}))

import { AppThemeProvider, useTheme, ThemeMode } from '@/providers/theme-provider'

describe('theme-provider module', () => {
  it('exports AppThemeProvider as a function', () => {
    expect(typeof AppThemeProvider).toBe('function')
  })

  it('exports useTheme as a function', () => {
    expect(typeof useTheme).toBe('function')
  })

  it('ThemeMode type accepts light and dark', () => {
    const light: ThemeMode = 'light'
    const dark: ThemeMode = 'dark'
    expect(light).toBe('light')
    expect(dark).toBe('dark')
  })

  it('AppThemeProvider accepts children prop (component signature)', () => {
    // Verify it can be invoked as a function component
    expect(AppThemeProvider.length).toBeGreaterThanOrEqual(1)
  })

  it('AsyncStorage mock is correctly wired', () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage')
    expect(typeof AsyncStorage.getItem).toBe('function')
    expect(typeof AsyncStorage.setItem).toBe('function')
  })
})
