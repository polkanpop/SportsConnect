/**
 * translations.test.ts — Verify that every key in `en` also exists in `vi`
 * and vice-versa, preventing partial translations from reaching production.
 */

import { en, vi } from '@/constants/translations'

describe('Translation dictionaries', () => {
  const enKeys = Object.keys(en).sort()
  const viKeys = Object.keys(vi).sort()

  it('en and vi have the same number of keys', () => {
    expect(enKeys.length).toBe(viKeys.length)
  })

  it('every en key exists in vi', () => {
    const missingInVi = enKeys.filter(k => !(k in vi))
    expect(missingInVi).toEqual([])
  })

  it('every vi key exists in en', () => {
    const missingInEn = viKeys.filter(k => !(k in en))
    expect(missingInEn).toEqual([])
  })

  it('no en value is empty string', () => {
    const empty = enKeys.filter(k => (en as any)[k] === '')
    expect(empty).toEqual([])
  })

  it('no vi value is empty string', () => {
    const empty = viKeys.filter(k => (vi as any)[k] === '')
    expect(empty).toEqual([])
  })

  it('key naming follows SCREAMING_SNAKE_CASE convention', () => {
    const bad = enKeys.filter(k => k !== k.toUpperCase())
    expect(bad).toEqual([])
  })
})
