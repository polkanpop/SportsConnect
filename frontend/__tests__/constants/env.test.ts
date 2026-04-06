/**
 * env.test.ts — Verify env.ts exports the expected shape.
 *
 * In production these are populated by EXPO_PUBLIC_* vars. In tests
 * they fall back to defaults. We just verify the shape and fallback
 * behaviour so a broken export doesn't crash the whole app at startup.
 */

describe('env.ts', () => {
  let env: typeof import('@/env')

  beforeAll(async () => {
    env = await import('@/env')
  })

  it('exports API_BASE_URL as a string', () => {
    expect(typeof env.API_BASE_URL).toBe('string')
  })

  it('API_BASE_URL fallback is localhost when env var missing', () => {
    // In test env EXPO_PUBLIC_API_BASE_URL is not set
    expect(env.API_BASE_URL).toBe('http://127.0.0.1:8000/api')
  })

  it('exports SUPABASE_URL as a string', () => {
    expect(typeof env.SUPABASE_URL).toBe('string')
  })

  it('exports SUPABASE_ANON_KEY as a string', () => {
    expect(typeof env.SUPABASE_ANON_KEY).toBe('string')
  })

  it('exports MAPBOX_PUBLIC_TOKEN as a string', () => {
    expect(typeof env.MAPBOX_PUBLIC_TOKEN).toBe('string')
  })

  it('exports AUTO_EMAIL_LOGIN as a boolean', () => {
    expect(typeof env.AUTO_EMAIL_LOGIN).toBe('boolean')
  })

  it('exports assertEnv as a function', () => {
    expect(typeof env.assertEnv).toBe('function')
  })
})
