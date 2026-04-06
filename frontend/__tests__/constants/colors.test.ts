/**
 * colors.test.ts — Verify COLORS constant integrity.
 *
 * Ensures all color values are valid hex codes and essential brand
 * colors are present. Catches accidental deletion or typos.
 */

import { COLORS } from '@/constants/colors'

const HEX_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/

describe('COLORS constant', () => {
  it('is a non-empty object', () => {
    expect(Object.keys(COLORS).length).toBeGreaterThan(0)
  })

  it('all values are valid hex color strings', () => {
    const invalid = Object.entries(COLORS).filter(([_, v]) => !HEX_REGEX.test(v as string))
    expect(invalid).toEqual([])
  })

  it('contains brand orange', () => {
    expect(COLORS.brandOrangeDeep).toBe('#FF6017')
  })

  it('contains neutral extremes', () => {
    expect(COLORS.neutral0).toBeDefined()
  })
})
