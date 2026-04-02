import { createClient } from '@supabase/supabase-js';
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => {
    console.debug("getItem", { key, getItemAsync })
    return getItemAsync(key)
  },
  setItem: (key: string, value: string) => {
    // Removed manual size warning to reduce console noise; relying on SecureStore behavior.
    return setItemAsync(key, value);
  },
  removeItem: (key: string) => {
    return deleteItemAsync(key)
  },
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  {
    auth: {
      storage: ExpoSecureStoreAdapter as any,
      autoRefreshToken: true,
      persistSession: true,
      // Disabled: our Zalo OAuth uses a custom backend flow (not Supabase PKCE).
      // Leaving this true causes Supabase to intercept the Zalo ?code= param and
      // attempt exchangeCodeForSession → Supabase returns 404 NOT_FOUND.
      detectSessionInUrl: false,
    },
  },
);