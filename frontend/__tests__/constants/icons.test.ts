/**
 * icons.test.ts — Guard against broken icon imports.
 *
 * Every value in the ICONS constant is a `require(...)` call that resolves
 * at build time. If someone deletes or renames a .png the require will
 * throw at import time. This test simply importing the module ensures all
 * icon paths are valid.
 */

describe('ICONS constant', () => {
  let ICONS: Record<string, any>

  beforeAll(async () => {
    // Dynamic import so a broken require blows up inside the test
    // rather than at module-parse time of this test file.
    const mod = await import('@/constants/icons')
    ICONS = mod.ICONS
  })

  it('exports a non-empty object', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(0)
  })

  it('every key maps to a truthy value (resolved require)', () => {
    for (const [key, val] of Object.entries(ICONS)) {
      expect(val).toBeTruthy()
    }
  })

  it('contains essential voice-feature icons', () => {
    expect(ICONS.mic).toBeTruthy()
    expect(ICONS.closeMenu).toBeTruthy()
    expect(ICONS.check).toBeTruthy()
    expect(ICONS.cancelEdit).toBeTruthy()
  })

  it('contains essential navigation icons', () => {
    expect(ICONS.home).toBeTruthy()
    expect(ICONS.map).toBeTruthy()
    expect(ICONS.search).toBeTruthy()
    expect(ICONS.settings).toBeTruthy()
    expect(ICONS.notifications).toBeTruthy()
  })

  it('contains sport-type icons', () => {
    const sports = ['football', 'basketball', 'badminton', 'volleyball', 'pickleball', 'golf', 'tableTennis', 'running']
    for (const s of sports) {
      expect(ICONS[s]).toBeTruthy()
    }
  })
})
