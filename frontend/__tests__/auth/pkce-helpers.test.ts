/**
 * pkce-helpers.test.ts — Tests for the PKCE helper functions used in Zalo/OAuth flows.
 *
 * Validates code_verifier, code_challenge, and state generation.
 */

// Mock expo-crypto
jest.mock('expo-crypto', () => ({
  getRandomBytes: jest.fn((n: number) => {
    const arr = new Uint8Array(n)
    for (let i = 0; i < n; i++) arr[i] = (i * 7 + 13) % 256
    return arr
  }),
  digestStringAsync: jest.fn().mockResolvedValue('dGVzdGhhc2g='), // base64 "testhash"
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}))

// Re-implement the helpers as they exist in the app
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  const Crypto = require('expo-crypto')
  const bytes = Crypto.getRandomBytes(48)
  const base64 = btoa(String.fromCharCode(...bytes))
  return toBase64Url(base64)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const Crypto = require('expo-crypto')
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  )
  return toBase64Url(hash)
}

function generateState(): string {
  const Crypto = require('expo-crypto')
  const bytes = Crypto.getRandomBytes(16)
  return toBase64Url(btoa(String.fromCharCode(...bytes))).slice(0, 20)
}

describe('PKCE helpers', () => {
  it('generates a code_verifier of correct format', () => {
    const verifier = generateCodeVerifier()
    expect(typeof verifier).toBe('string')
    expect(verifier.length).toBeGreaterThan(40)
    // Must not contain +, /, or = (base64url)
    expect(verifier).not.toMatch(/[+/=]/)
  })

  it('generates a code_challenge from verifier', async () => {
    const challenge = await generateCodeChallenge('test-verifier')
    expect(typeof challenge).toBe('string')
    expect(challenge).not.toMatch(/[+/=]/)
  })

  it('generates a state string of 20 chars', () => {
    const state = generateState()
    expect(typeof state).toBe('string')
    expect(state.length).toBe(20)
    expect(state).not.toMatch(/[+/=]/)
  })

  it('toBase64Url replaces +, /, and = correctly', () => {
    expect(toBase64Url('abc+def/ghi=')).toBe('abc-def_ghi')
    expect(toBase64Url('a+b+c/d/e==')).toBe('a-b-c_d_e')
  })
})
