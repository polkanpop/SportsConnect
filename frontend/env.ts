// Centralized environment access without react-native-dotenv.
// Uses Expo's automatic injection of EXPO_PUBLIC_* vars.
// Add any new keys here for typed access.

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''
export const GOOGLE_AUTH_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_AUTH_WEB_CLIENT_ID ?? ''

// Helper to assert required env vars at runtime (only in development)
export function assertEnv() {
  const missing: string[] = []
  for (const [key, value] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY })) {
    if (!value) missing.push(key)
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn('[env] Missing required env vars:', missing.join(', '))
  }
}
