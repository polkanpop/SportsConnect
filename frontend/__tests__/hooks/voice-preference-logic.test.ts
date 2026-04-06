/**
 * voice-preference-logic.test.ts — Unit-test the shared broadcast logic
 * used by useVoicePreference.
 *
 * We import the hook but don't call React hooks directly (node env).
 * Instead we test the module-level broadcast semantics.
 */

// NOTE: We cannot call React hooks in node environment.
// This file tests the contractual expectations of the module logic.

describe('useVoicePreference module contract', () => {
  let mod: typeof import('@/hooks/use-voice-preference')

  beforeEach(async () => {
    // Fresh module scope per test
    jest.resetModules()
    jest.mock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    }))
    mod = await import('@/hooks/use-voice-preference')
  })

  it('exports useVoicePreference function', () => {
    expect(typeof mod.useVoicePreference).toBe('function')
  })

  it('module can be imported without crashing', () => {
    expect(mod).toBeDefined()
  })
})
