// Centralized environment access without react-native-dotenv.
// Uses Expo's automatic injection of EXPO_PUBLIC_* vars.
// Add any new keys here for typed access.

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''
// Backend FastAPI base URL (set EXPO_PUBLIC_API_BASE_URL in .env or eas.json env)
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8000/api'
// Auto email verification + deep link auto-login flag
export const AUTO_EMAIL_LOGIN = (process.env.EXPO_PUBLIC_AUTO_EMAIL_LOGIN || '').toLowerCase() === 'true'

// Helper to assert required env vars at runtime (only in development)
export function assertEnv() {
  const missing: string[] = []
  for (const [key, value] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL })) {
    if (!value) missing.push(key)
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn('[env] Missing required env vars:', missing.join(', '))
  }
}
