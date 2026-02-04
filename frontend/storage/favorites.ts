// favorites.ts
// AsyncStorage-backed persistence for favorited courts.
// Stores favorites per user (Supabase session user id) under a namespaced key.

import { supabase } from '@/lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
// Use legacy FileSystem API to suppress deprecation warnings while keeping current logic.
// Later we can migrate to the new File/Directory classes without changing behavior.
import * as FileSystem from 'expo-file-system/legacy';

export type FavoriteMarker = {
  id: number; // courtinfoid
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  images?: string[];
  venue?: string[] | string;
  availability?: string;
};

// Internal shape of stored data
type FavoritesPayload = {
  items: { [id: number]: FavoriteMarker };
  order: number[]; // insertion order (can be used for recent favorites)
};

const DEFAULT_PAYLOAD: FavoritesPayload = { items: {}, order: [] };

// Directory for per-user favorites files (device persistent doc storage)
// Prefer FileSystem.documentDirectory when available (native). Fallback to cache if undefined (web/dev edge cases)
const BASE_DIR = (FileSystem as any).documentDirectory || (FileSystem as any).cacheDirectory || 'file:///tmp/';
const USERDATA_DIR = BASE_DIR + 'userdata/';

const favoritesFilePath = (userId?: string | null) => `${USERDATA_DIR}${userId ?? 'guest'}/favorites.json`;

// Build storage key using user id (anon fallback)
const buildKey = (userId?: string | null) => `@favorites:${userId ?? 'guest'}`;

// Get current user id from Supabase session (uuid) OR backend remembered profile (numeric userid)
// Return value always coerced to string so storage keys are consistent.
const getCurrentUserId = async (): Promise<string | null> => {
  // 1. Try Supabase session user id
  try {
    const { data } = await supabase.auth.getSession();
    const supaId = data.session?.user?.id;
    if (supaId) return String(supaId);
  } catch {/* fall through */}
  // 2. Fallback to backend remembered profile
  try {
    const raw = await AsyncStorage.getItem('@backendProfile');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.userid === 'number') {
        return String(parsed.userid);
      }
    }
  } catch {/* ignore */}
  return null;
};

async function ensureUserDir(userId?: string | null) {
  try {
    const dir = USERDATA_DIR + (userId ?? 'guest');
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch (e) {
    // Swallow errors – fallback to AsyncStorage only (reduce warning noise)
    console.debug('[favorites] ensureUserDir failed (non-fatal)', (e as any)?.message);
  }
}

async function readFilePayload(userId?: string | null): Promise<FavoritesPayload | null> {
  try {
    await ensureUserDir(userId);
    const path = favoritesFilePath(userId);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    if (!raw) return null;
    const parsed: FavoritesPayload = JSON.parse(raw);
    if (!parsed.items || !parsed.order) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

async function writeFilePayload(userId: string | null, payload: FavoritesPayload) {
  try {
    await ensureUserDir(userId);
    const path = favoritesFilePath(userId);
    await FileSystem.writeAsStringAsync(path, JSON.stringify(payload));
  } catch (e) {
    // Non-fatal; AsyncStorage already written. Avoid noisy warning spam.
    console.debug('[favorites] writeFilePayload failed (non-fatal)', (e as any)?.message);
  }
}

async function readPayload(userId?: string | null): Promise<FavoritesPayload> {
  // 1. Try AsyncStorage
  const key = buildKey(userId);
  const raw = await AsyncStorage.getItem(key);
  if (raw) {
    try {
      const parsed: FavoritesPayload = JSON.parse(raw);
      if (parsed.items && parsed.order) return parsed;
    } catch {/* continue to file fallback */}
  }
  // 2. Try file-system fallback
  const filePayload = await readFilePayload(userId);
  if (filePayload) return filePayload;
  // 3. Default
  return DEFAULT_PAYLOAD;
}

async function writePayload(userId: string | null, payload: FavoritesPayload) {
  const key = buildKey(userId);
  await AsyncStorage.setItem(key, JSON.stringify(payload));
  await writeFilePayload(userId, payload);
}

// --- Remote persistence helpers (Supabase) ---
// We keep a table (see SQL provided separately) named user_favorites(user_id uuid, courtinfoid int, created_at timestamptz).
// Only basic read/write needed.

async function fetchRemoteFavorites(userId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from('user_favorites')
    .select('courtinfoid')
    .eq('user_id', userId);
  if (error || !data) return [];
  return data.map(r => r.courtinfoid).filter((x: any) => typeof x === 'number');
}

async function addRemoteFavorite(userId: string, courtinfoid: number) {
  // upsert to avoid duplicates
  await supabase.from('user_favorites').upsert({ user_id: userId, courtinfoid });
}

async function removeRemoteFavorite(userId: string, courtinfoid: number) {
  await supabase.from('user_favorites').delete().match({ user_id: userId, courtinfoid });
}

// Public API

export async function getFavorites(): Promise<FavoriteMarker[]> {
  const userId = await getCurrentUserId();
  const payload = await readPayload(userId);
  return payload.order.map(id => payload.items[id]).filter(Boolean);
}

// Remote favorite ids (lightweight). Returns [] for guest.
export async function getRemoteFavoriteIds(): Promise<number[]> {
  const userId = await getCurrentUserId();
  // Only Supabase UUID users are synced remotely; numeric backend ids currently have no remote table mapping.
  // We conservatively attempt remote fetch for any non-null id string.
  if (!userId) return [];
  return fetchRemoteFavorites(userId);
}

export async function isFavorited(id: number): Promise<boolean> {
  const userId = await getCurrentUserId();
  const payload = await readPayload(userId);
  return !!payload.items[id];
}

export async function addFavorite(marker: FavoriteMarker): Promise<void> {
  const userId = await getCurrentUserId();
  const payload = await readPayload(userId);
  if (!payload.items[marker.id]) {
    payload.items[marker.id] = marker;
    payload.order.push(marker.id);
    await writePayload(userId, payload);
  }
}

export async function removeFavorite(id: number): Promise<void> {
  const userId = await getCurrentUserId();
  const payload = await readPayload(userId);
  if (payload.items[id]) {
    delete payload.items[id];
    payload.order = payload.order.filter(x => x !== id);
    await writePayload(userId, payload);
  }
}

// Toggle returns new favorited state (true if now favorited)
export async function toggleFavorite(marker: FavoriteMarker): Promise<boolean> {
  const userId = await getCurrentUserId();
  const payload = await readPayload(userId);
  if (payload.items[marker.id]) {
    delete payload.items[marker.id];
    payload.order = payload.order.filter(x => x !== marker.id);
    await writePayload(userId, payload);
    if (userId) await removeRemoteFavorite(userId, marker.id);
    return false;
  } else {
    payload.items[marker.id] = marker;
    payload.order.push(marker.id);
    await writePayload(userId, payload);
    if (userId) await addRemoteFavorite(userId, marker.id);
    return true;
  }
}

// Convenience: replace entire favorites list (e.g., sync)
export async function setFavorites(markers: FavoriteMarker[]): Promise<void> {
  const userId = await getCurrentUserId();
  const payload: FavoritesPayload = {
    items: markers.reduce((acc, m) => { acc[m.id] = m; return acc; }, {} as { [id: number]: FavoriteMarker }),
    order: markers.map(m => m.id),
  };
  await writePayload(userId, payload);
}

// Initialize favorites for current user (ensure directory & sync remote -> local file)
export async function initFavoritesForCurrentUser(): Promise<void> {
  const userId = await getCurrentUserId();
  await ensureUserDir(userId);
  // Merge remote favorite ids into local payload if missing
  if (userId) {
    const remoteIds = await fetchRemoteFavorites(userId);
    if (remoteIds.length) {
      const payload = await readPayload(userId);
      let changed = false;
      remoteIds.forEach(id => {
        if (!payload.items[id]) {
          // Minimal stub entry; can be hydrated later by map fetch
          payload.items[id] = { id, name: '', address: '', latitude: 0, longitude: 0 };
          payload.order.push(id);
          changed = true;
        }
      });
      if (changed) await writePayload(userId, payload);
    }
  }
}
