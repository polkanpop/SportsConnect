import AsyncStorage from '@react-native-async-storage/async-storage'

export type HistoryKind =
  | 'court_booking'
  | 'event_booking'
  | 'session_booking'
  | 'created_event'
  | 'created_session'
  | 'payment'
  | 'status_change'

export type HistoryEntry = {
  id: string
  ts: string // ISO timestamp
  kind: HistoryKind
  title: string
  subtitle?: string | null
  fromStatus?: string | null
  toStatus?: string | null
  amount?: number | null
  meta?: Record<string, any> | null
}

const MAX_ENTRIES = 300

function keyForUser(userId: number) {
  return `@history:v1:user:${userId}`
}

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function listHistory(userId: number): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(keyForUser(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(Boolean)
      .map((x: any) => ({
        id: typeof x?.id === 'string' ? x.id : newId(),
        ts: typeof x?.ts === 'string' ? x.ts : new Date().toISOString(),
        kind: (x?.kind as HistoryKind) || 'status_change',
        title: String(x?.title ?? ''),
        subtitle: x?.subtitle ?? null,
        fromStatus: x?.fromStatus ?? null,
        toStatus: x?.toStatus ?? null,
        amount: typeof x?.amount === 'number' ? x.amount : (x?.amount == null ? null : Number(x.amount)),
        meta: x?.meta ?? null,
      }))
      .filter((x: HistoryEntry) => !!x.title)
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
  } catch {
    return []
  }
}

export async function appendHistory(userId: number, entry: Omit<HistoryEntry, 'id' | 'ts'> & { id?: string; ts?: string }) {
  try {
    const existing = await listHistory(userId)
    const full: HistoryEntry = {
      id: entry.id || newId(),
      ts: entry.ts || new Date().toISOString(),
      kind: entry.kind,
      title: entry.title,
      subtitle: entry.subtitle ?? null,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      amount: entry.amount ?? null,
      meta: entry.meta ?? null,
    }
    const next = [full, ...existing]
      .slice(0, MAX_ENTRIES)
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
    await AsyncStorage.setItem(keyForUser(userId), JSON.stringify(next))
  } catch {
    // best-effort
  }
}

export async function setHistory(userId: number, entries: HistoryEntry[]) {
  try {
    const next = (Array.isArray(entries) ? entries : [])
      .filter(Boolean)
      .slice(0, MAX_ENTRIES)
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
    await AsyncStorage.setItem(keyForUser(userId), JSON.stringify(next))
  } catch {
    // best-effort
  }
}

export async function clearHistory(userId: number) {
  try {
    await AsyncStorage.removeItem(keyForUser(userId))
  } catch {
    // best-effort
  }
}
