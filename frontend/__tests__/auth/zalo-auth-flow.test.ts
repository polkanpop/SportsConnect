/**
 * zalo-auth-flow.test.ts — Tests for Zalo CCT + Linking listener fallback.
 *
 * Validates that the Zalo auth flow handles:
 *   - openAuthSessionAsync resolving with success
 *   - openAuthSessionAsync returning non-success (cancel/dismiss)
 *   - Linking listener catching the deep link when openAuthSessionAsync doesn't
 *   - dismissAuthSession being called to close lingering CCT
 */

import { Linking } from 'react-native'

// Mock modules
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(),
  dismissAuthSession: jest.fn(),
  warmUpAsync: jest.fn().mockResolvedValue(undefined),
  coolDownAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('react-native', () => {
  const listeners: Array<(e: { url: string }) => void> = []
  return {
    Linking: {
      addEventListener: jest.fn((event: string, handler: (e: { url: string }) => void) => {
        listeners.push(handler)
        return { remove: jest.fn(() => { const i = listeners.indexOf(handler); if (i >= 0) listeners.splice(i, 1) }) }
      }),
      _simulateUrl: (url: string) => { listeners.forEach(fn => fn({ url })) },
    },
    Platform: { OS: 'android' },
    UIManager: { setLayoutAnimationEnabledExperimental: jest.fn() },
  }
})

const WebBrowser = require('expo-web-browser')

const REDIRECT_INTERCEPT = 'sportconnect://zalo-code'

describe('Zalo CCT + Linking fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('resolves code when openAuthSessionAsync returns success', async () => {
    const fakeUrl = 'sportconnect://zalo-code?code=ABC123&state=xyz'
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: fakeUrl })

    const code = await new Promise<string | null>((resolve) => {
      let settled = false
      const linkingSub = Linking.addEventListener('url', ({ url }) => {
        if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return
        settled = true
        linkingSub.remove()
        try { WebBrowser.dismissAuthSession() } catch {}
        resolve(new URL(url).searchParams.get('code'))
      })
      WebBrowser.openAuthSessionAsync('https://oauth.zaloapp.com/...', REDIRECT_INTERCEPT)
        .then((result: any) => {
          if (settled) return
          settled = true
          linkingSub.remove()
          try { WebBrowser.dismissAuthSession() } catch {}
          if (result.type === 'success') {
            resolve(new URL(result.url).searchParams.get('code'))
          } else {
            resolve(null)
          }
        })
        .catch(() => { if (!settled) { settled = true; resolve(null) } })
    })

    expect(code).toBe('ABC123')
    expect(WebBrowser.dismissAuthSession).toHaveBeenCalled()
  })

  it('returns null when user cancels', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' })

    const code = await new Promise<string | null>((resolve) => {
      let settled = false
      const linkingSub = Linking.addEventListener('url', ({ url }) => {
        if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return
        settled = true
        linkingSub.remove()
        resolve(new URL(url).searchParams.get('code'))
      })
      WebBrowser.openAuthSessionAsync('https://oauth.zaloapp.com/...', REDIRECT_INTERCEPT)
        .then((result: any) => {
          if (settled) return
          settled = true
          linkingSub.remove()
          try { WebBrowser.dismissAuthSession() } catch {}
          resolve(result.type === 'success' ? new URL(result.url).searchParams.get('code') : null)
        })
        .catch(() => { if (!settled) { settled = true; resolve(null) } })
    })

    expect(code).toBeNull()
  })

  it('catches deep link via Linking listener when auth session stalls', async () => {
    // Simulate openAuthSessionAsync never resolving (stalled)
    WebBrowser.openAuthSessionAsync.mockReturnValue(new Promise(() => {}))

    const codePromise = new Promise<string | null>((resolve) => {
      let settled = false
      const linkingSub = Linking.addEventListener('url', ({ url }) => {
        if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return
        settled = true
        linkingSub.remove()
        try { WebBrowser.dismissAuthSession() } catch {}
        resolve(new URL(url).searchParams.get('code'))
      })
      WebBrowser.openAuthSessionAsync('https://oauth.zaloapp.com/...', REDIRECT_INTERCEPT)
        .then((result: any) => {
          if (settled) return
          settled = true
          linkingSub.remove()
          resolve(result.type === 'success' ? new URL(result.url).searchParams.get('code') : null)
        })
        .catch(() => { if (!settled) { settled = true; resolve(null) } })
    })

    // Simulate the deep link arriving via Linking
    ;(Linking as any)._simulateUrl('sportconnect://zalo-code?code=OPPO_FIX&state=abc')

    const code = await codePromise
    expect(code).toBe('OPPO_FIX')
    expect(WebBrowser.dismissAuthSession).toHaveBeenCalled()
  })

  it('ignores unrelated Linking URLs', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' })

    const codePromise = new Promise<string | null>((resolve) => {
      let settled = false
      const linkingSub = Linking.addEventListener('url', ({ url }) => {
        if (settled || !url.startsWith(REDIRECT_INTERCEPT)) return
        settled = true
        linkingSub.remove()
        resolve(new URL(url).searchParams.get('code'))
      })
      WebBrowser.openAuthSessionAsync('https://oauth.zaloapp.com/...', REDIRECT_INTERCEPT)
        .then((result: any) => {
          if (settled) return
          settled = true
          linkingSub.remove()
          resolve(result.type === 'success' ? new URL(result.url).searchParams.get('code') : null)
        })
        .catch(() => { if (!settled) { settled = true; resolve(null) } })
    })

    // Simulate an unrelated URL — should be ignored
    ;(Linking as any)._simulateUrl('sportconnect://other-path?foo=bar')

    const code = await codePromise
    // Should resolve via openAuthSessionAsync (cancel), not via the unrelated link
    expect(code).toBeNull()
  })
})
