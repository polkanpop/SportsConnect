import React, { useCallback, useMemo, useRef, useState } from 'react'
import { FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { HistoryEntry, listHistory, setHistory } from '@/storage/history'
import {
  listEventsCombined,
  listTrainingSessionsCombined,
} from '@/lib/backendApi'

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)

function formatLogTime(ts: string) {
  const d = parseLoose(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function formatDateHeader(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'Unknown'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' })
}

function parseLoose(ts?: any): Date {
  if (!ts) return new Date(NaN)
  if (typeof ts === 'string' && ts.includes(' ') && !ts.includes('T')) return new Date(ts.replace(' ', 'T'))
  return new Date(ts)
}

function formatScheduleParts(entry: HistoryEntry): { date: string; time: string } | null {
  const meta: any = entry.meta || {}

  const start = parseLoose(meta.start_timestamp)
  const end = parseLoose(meta.end_timestamp)
  if (!Number.isNaN(start.getTime())) {
    const date = `${start.getDate()}-${start.getMonth() + 1}-${start.getFullYear()}`
    const s = `${start.getHours()}:${pad2(start.getMinutes())}`
    if (!Number.isNaN(end.getTime())) {
      const e = `${end.getHours()}:${pad2(end.getMinutes())}`
      return { date, time: `${s}-${e}` }
    }
    return { date, time: s }
  }

  // Legacy court booking subtitle sometimes: "YYYY-MM-DD HH:MM - HH:MM" or similar
  const subtitle = String(entry.subtitle ?? '')
  const m = subtitle.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/)
  if (m) {
    const [, y, mo, da, st, en] = m
    return { date: `${Number(da)}-${Number(mo)}-${y}`, time: `${st}-${en}` }
  }

  return null
}

function formatStatusLabel(raw?: string | null): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v.includes('cancel')) return 'Cancelled'
  if (v.includes('complete')) return 'Completed'
  if (v.includes('upcoming')) return 'Upcoming'
  if (v.includes('approve')) return 'Approved'
  if (v.includes('paid')) return 'Paid'
  if (v.includes('pending')) return 'Joined'
  return v.charAt(0).toUpperCase() + v.slice(1)
}

function formatStatusPlain(raw?: string | null): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v.includes('cancel')) return 'cancelled'
  if (v.includes('complete')) return 'completed'
  if (v.includes('upcoming')) return 'upcoming'
  if (v.includes('approve')) return 'approved'
  if (v.includes('paid')) return 'paid'
  if (v.includes('pending')) return 'joined'
  return v
}

function isNoisySubtitle(s?: string | null): boolean {
  const t = String(s ?? '').trim()
  if (!t) return true
  // Hide internal ids like "event_27", "court_88", "created_event_45".
  if (/^[a-z_]+_\d+$/i.test(t)) return true
  return false
}

function firstNonEmptyText(...values: any[]): string {
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) continue
    if (/^[a-z_]+_\d+$/i.test(s)) continue
    return s
  }
  return ''
}

function toIsoOrNow(ts: any): string {
  const d = parseLoose(ts)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return new Date().toISOString()
}

function buildSeedHistoryFromDashboard(dashboardRaw: any, userId: number): HistoryEntry[] {
  const out: HistoryEntry[] = []

  const courtBookings = Array.isArray(dashboardRaw?.court_bookings) ? dashboardRaw.court_bookings : []
  for (const b of courtBookings) {
    const id = Number(b?.courtbookingid)
    if (!Number.isFinite(id)) continue
    const courtName = firstNonEmptyText(b?.court_name, b?.courtName, b?.title) || `Court #${id}`
    out.push({
      id: `seed-court-${id}`,
      ts: toIsoOrNow(b?.updated_at ?? b?.end_timestamp ?? b?.start_timestamp),
      kind: 'court_booking',
      title: `Booked court: ${courtName}`,
      subtitle: null,
      fromStatus: null,
      toStatus: String(b?.bookingstatus ?? b?.status ?? 'upcoming'),
      meta: {
        courtbookingid: id,
        availabilityid: b?.availabilityid ?? null,
        start_timestamp: b?.start_timestamp ?? null,
        end_timestamp: b?.end_timestamp ?? null,
      },
    })
  }

  const eventBookings = Array.isArray(dashboardRaw?.event_bookings) ? dashboardRaw.event_bookings : []
  for (const b of eventBookings) {
    const id = Number(b?.eventbookingid)
    if (!Number.isFinite(id)) continue
    const eventId = Number(b?.eventid)
    const eventLabel = firstNonEmptyText(b?.event_title, b?.title, b?.name) || (Number.isFinite(eventId) ? `Event ${eventId}` : `Event booking ${id}`)
    out.push({
      id: `seed-event-${id}`,
      ts: toIsoOrNow(b?.updated_at ?? b?.end_timestamp ?? b?.start_timestamp),
      kind: 'event_booking',
      title: `Booked event: ${eventLabel}`,
      subtitle: null,
      fromStatus: null,
      toStatus: String(b?.bookingstatus ?? b?.status ?? 'upcoming'),
      meta: {
        eventbookingid: id,
        eventid: Number.isFinite(eventId) ? eventId : null,
        start_timestamp: b?.start_timestamp ?? null,
        end_timestamp: b?.end_timestamp ?? null,
      },
    })
  }

  const sessionBookings = Array.isArray(dashboardRaw?.training_bookings) ? dashboardRaw.training_bookings : []
  for (const b of sessionBookings) {
    const id = Number(b?.tsbookingid)
    if (!Number.isFinite(id)) continue
    const sessionId = Number(b?.sessionid)
    const label = firstNonEmptyText(b?.session_title, b?.title, b?.name) || (Number.isFinite(sessionId) ? `Session ${sessionId}` : `Session booking ${id}`)
    out.push({
      id: `seed-session-${id}`,
      ts: toIsoOrNow(b?.updated_at ?? b?.end_timestamp ?? b?.start_timestamp),
      kind: 'session_booking',
      title: `Booked session: ${label}`,
      subtitle: null,
      fromStatus: null,
      toStatus: String(b?.bookingstatus ?? b?.status ?? 'upcoming'),
      meta: {
        tsbookingid: id,
        sessionid: Number.isFinite(sessionId) ? sessionId : null,
        start_timestamp: b?.start_timestamp ?? null,
        end_timestamp: b?.end_timestamp ?? null,
      },
    })
  }

  const createdEvents = Array.isArray(dashboardRaw?.events_combined) ? dashboardRaw.events_combined : []
  for (const e of createdEvents) {
    if (Number(e?.organizerid) !== userId) continue
    const eventId = Number(e?.eventid)
    if (!Number.isFinite(eventId)) continue
    const title = firstNonEmptyText(e?.title, e?.event_title) || `Event ${eventId}`
    out.push({
      id: `seed-created-event-${eventId}`,
      ts: toIsoOrNow(e?.updated_at ?? e?.end_timestamp ?? e?.start_timestamp ?? e?.time),
      kind: 'created_event',
      title: `Event created: ${title}`,
      subtitle: null,
      fromStatus: null,
      toStatus: String(e?.status ?? ''),
      meta: {
        eventid: eventId,
        courtbookingid: e?.courtbookingid ?? null,
        start_timestamp: e?.start_timestamp ?? e?.time ?? null,
        end_timestamp: e?.end_timestamp ?? null,
        court_name: e?.court_name ?? e?.courtName ?? null,
      },
    })
  }

  const createdSessions = Array.isArray(dashboardRaw?.training_sessions_combined) ? dashboardRaw.training_sessions_combined : []
  for (const s of createdSessions) {
    if (Number(s?.coachid) !== userId) continue
    const sessionId = Number(s?.sessionid)
    if (!Number.isFinite(sessionId)) continue
    const title = firstNonEmptyText(s?.title, s?.session_title) || `Session ${sessionId}`
    out.push({
      id: `seed-created-session-${sessionId}`,
      ts: toIsoOrNow(s?.updated_at ?? s?.end_timestamp ?? s?.start_timestamp ?? s?.time),
      kind: 'created_session',
      title: `Session created: ${title}`,
      subtitle: null,
      fromStatus: null,
      toStatus: String(s?.status ?? ''),
      meta: {
        sessionid: sessionId,
        courtbookingid: s?.courtbookingid ?? null,
        start_timestamp: s?.start_timestamp ?? s?.time ?? null,
        end_timestamp: s?.end_timestamp ?? null,
        court_name: s?.court_name ?? s?.courtName ?? null,
      },
    })
  }

  const dedup = new Map<string, HistoryEntry>()
  for (const row of out) {
    dedup.set(row.id, row)
  }

  return Array.from(dedup.values())
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
    .slice(0, 300)
}

function statusColor(s?: string | null) {
  const v = String(s ?? '').toLowerCase()
  if (v.includes('miss')) return { bg: '#fef2f2', fg: '#991b1b', dot: '#dc2626' }
  if (v.includes('cancel')) return { bg: '#fee2e2', fg: '#b91c1c', dot: '#ef4444' }
  if (v.includes('complete') || v.includes('paid')) return { bg: '#dcfce7', fg: '#166534', dot: '#22c55e' }
  if (v.includes('approve')) return { bg: '#dcfce7', fg: '#166534', dot: '#22c55e' }
  if (v.includes('pending')) return { bg: '#fef3c7', fg: '#92400e', dot: '#f59e0b' }
  if (v.includes('upcoming')) return { bg: '#e0f2fe', fg: '#075985', dot: '#0ea5e9' }
  return { bg: '#eef2ff', fg: '#3730a3', dot: '#6366f1' }
}

function kindBadgeColor(label: string) {
  const v = String(label ?? '').trim().toLowerCase()
  if (v === 'court') return { bg: '#f1f5f9', fg: '#0f172a', border: '#e2e8f0' }
  if (v === 'event') return { bg: '#fef9c3', fg: '#854d0e', border: '#fde047' }
  if (v === 'session') return { bg: '#e0f2fe', fg: '#075985', border: '#bae6fd' }
  if (v === 'hosting') return { bg: '#ffedd5', fg: '#9a3412', border: '#fed7aa' }
  if (v === 'payment') return { bg: '#ffe4e6', fg: '#9f1239', border: '#fecdd3' }
  return { bg: '#f1f5f9', fg: '#0f172a', border: '#e2e8f0' }
}

function kindLabel(kind: HistoryEntry['kind']) {
  if (kind === 'court_booking') return 'Court'
  if (kind === 'event_booking') return 'Event'
  if (kind === 'session_booking') return 'Session'
  if (kind === 'created_event') return 'Hosting'
  if (kind === 'created_session') return 'Hosting'
  if (kind === 'payment') return 'Payment'
  return 'Status'
}

function kindBadges(kind: HistoryEntry['kind']): string[] {
  if (kind === 'created_event') return ['Event', 'Hosting']
  if (kind === 'created_session') return ['Session', 'Hosting']
  return [kindLabel(kind)]
}

function stripAddMe(s: string): string {
  const cleaned = s.replace(/\s*\(\s*add\s*me\s*\)/ig, '').trim()
  if (/^auto-?join$/i.test(cleaned)) return ''
  if (/^auto-?join\b/i.test(cleaned)) return ''
  return cleaned
}

function normalizePaymentMethod(method: string): string {
  const v = String(method ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v.includes('vn')) return 'vnpay'
  if (v.includes('cash')) return 'cash'
  if (v.includes('free')) return 'free'
  return method.trim()
}

function parsePaymentMethodFromSubtitle(subtitle: any): string {
  const t = String(subtitle ?? '').trim()
  if (!t) return ''
  if (t.toLowerCase() === 'free') return 'free'
  const m = t.match(/method:\s*(.+)$/i)
  if (m) return normalizePaymentMethod(m[1])
  return normalizePaymentMethod(t)
}

function isScheduleLikeSubtitle(s: string): boolean {
  const t = String(s ?? '').trim()
  if (!t) return false
  // ISO-like date ranges: "2026-01-26 09:30 - 11:30"
  if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(t)) return true
  // Locale-like: "Mon, Jan 26, 09:30 - 11:30" or similar
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+[A-Za-z]{3,}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/i.test(t)) return true
  // Date + time range: "26-1-2026 9:30-11:30" or "26-1-2026 9:30 - 11:30"
  if (/^\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(t)) return true
  return false
}

function stripNullTail(s: string): string {
  const v = String(s || '').trim()
  if (!v) return ''
  return v
    .replace(/\s+at\s+null\s*$/i, '')
    .replace(/\s+\|\s*null\s*$/i, '')
    .replace(/\bnull\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function firstRelatedRow(v: any): any | null {
  if (Array.isArray(v)) return (v[0] && typeof v[0] === 'object') ? v[0] : null
  if (v && typeof v === 'object') return v
  return null
}

function formatScheduleFromTimes(startRaw: any, endRaw: any): { date: string; time: string } | null {
  const start = parseLoose(startRaw)
  const end = parseLoose(endRaw)
  if (Number.isNaN(start.getTime())) return null
  const date = `${start.getDate()}-${start.getMonth() + 1}-${start.getFullYear()}`
  const s = `${start.getHours()}:${pad2(start.getMinutes())}`
  if (!Number.isNaN(end.getTime())) {
    const e = `${end.getHours()}:${pad2(end.getMinutes())}`
    return { date, time: `${s}-${e}` }
  }
  return { date, time: s }
}

export default function HistoryPage() {
  const router = useRouter()
  const { userId, dashboard } = useAppBootstrap()
  const dashboardRaw = dashboard.data
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const lastReloadAtRef = useRef(0)
  const loadingRef = useRef(false)
  const itemsCountRef = useRef(0)
  const hasLoadedOnceRef = useRef(false)

  const reconcile = useCallback(async (rows: HistoryEntry[]) => {
    if (typeof userId !== 'number') return rows

    // Best-effort reconcile: if a DB record was deleted, drop related history items.
    try {
      const [eventsCombined, sessionsCombined] = await Promise.all([
        listEventsCombined().catch(() => [] as any[]),
        listTrainingSessionsCombined().catch(() => [] as any[]),
      ])

      const courtBookings = Array.isArray(dashboardRaw?.court_bookings) ? dashboardRaw.court_bookings : []
      const eventBookings = Array.isArray(dashboardRaw?.event_bookings) ? dashboardRaw.event_bookings : []
      const sessionBookings = Array.isArray(dashboardRaw?.training_bookings) ? dashboardRaw.training_bookings : []

      const courtBookingIds = new Set((Array.isArray(courtBookings) ? courtBookings : []).map((b: any) => b?.courtbookingid))
      const courtBookingById = new Map<number, any>()
      for (const b of Array.isArray(courtBookings) ? courtBookings : []) {
        const id = b?.courtbookingid
        if (typeof id === 'number') courtBookingById.set(id, b)
      }
      const eventBookingIds = new Set((Array.isArray(eventBookings) ? eventBookings : []).map((b: any) => b?.eventbookingid))
      const sessionBookingIds = new Set((Array.isArray(sessionBookings) ? sessionBookings : []).map((b: any) => b?.tsbookingid))
      const createdEventsRows = (Array.isArray(eventsCombined) ? eventsCombined : []).filter((e: any) => Number(e?.organizerid) === userId)
      const createdSessionsRows = (Array.isArray(sessionsCombined) ? sessionsCombined : []).filter((s: any) => Number(s?.coachid) === userId)

      const createdEventIds = new Set(createdEventsRows.map((e: any) => e?.eventid))
      const createdSessionIds = new Set(createdSessionsRows.map((s: any) => s?.sessionid))

      const createdEventMonetizeById = new Map<number, boolean>()
      const createdEventCourtNameById = new Map<number, string>()
      for (const e of createdEventsRows) {
        const id = e?.eventid
        if (typeof id !== 'number') continue
        const fee = Number(e?.entry_fee)
        const monetize = (Number.isFinite(fee) && fee > 0) || !!e?.support_payment_method
        createdEventMonetizeById.set(id, monetize)
        const courtName = typeof e?.court_name === 'string' ? e.court_name : (typeof e?.courtName === 'string' ? e.courtName : '')
        if (courtName && courtName.trim()) createdEventCourtNameById.set(id, courtName.trim())
      }

      const createdSessionMonetizeById = new Map<number, boolean>()
      const createdSessionCourtNameById = new Map<number, string>()
      for (const s of createdSessionsRows) {
        const id = s?.sessionid
        if (typeof id !== 'number') continue
        const fee = Number(s?.entry_fee)
        const monetize = (Number.isFinite(fee) && fee > 0) || !!s?.support_payment_method
        createdSessionMonetizeById.set(id, monetize)
        const courtName = typeof s?.court_name === 'string' ? s.court_name : (typeof s?.courtName === 'string' ? s.courtName : '')
        if (courtName && courtName.trim()) createdSessionCourtNameById.set(id, courtName.trim())
      }

      const keep = (entry: HistoryEntry) => {
        const meta: any = entry.meta || {}

        const linkedCourtBookingId = meta.courtbookingid
        const linkedEventBookingId = meta.eventbookingid
        const linkedSessionBookingId = meta.tsbookingid
        const linkedEventId = meta.eventid
        const linkedSessionId = meta.sessionid

        if (entry.kind === 'court_booking') {
          return typeof linkedCourtBookingId === 'number' ? courtBookingIds.has(linkedCourtBookingId) : true
        }
        if (entry.kind === 'event_booking') {
          return typeof linkedEventBookingId === 'number' ? eventBookingIds.has(linkedEventBookingId) : true
        }
        if (entry.kind === 'session_booking') {
          return typeof linkedSessionBookingId === 'number' ? sessionBookingIds.has(linkedSessionBookingId) : true
        }
        if (entry.kind === 'created_event') {
          return typeof linkedEventId === 'number' ? createdEventIds.has(linkedEventId) : true
        }
        if (entry.kind === 'created_session') {
          return typeof linkedSessionId === 'number' ? createdSessionIds.has(linkedSessionId) : true
        }
        if (entry.kind === 'payment') {
          // If payment is tied to a record, prune with it.
          if (typeof linkedCourtBookingId === 'number') return courtBookingIds.has(linkedCourtBookingId)
          if (typeof linkedEventBookingId === 'number') return eventBookingIds.has(linkedEventBookingId)
          if (typeof linkedSessionBookingId === 'number') return sessionBookingIds.has(linkedSessionBookingId)
          if (typeof linkedEventId === 'number') return createdEventIds.has(linkedEventId)
          if (typeof linkedSessionId === 'number') return createdSessionIds.has(linkedSessionId)
          return true
        }

        return true
      }

      const filtered = (Array.isArray(rows) ? rows : []).filter(keep)

      let changed = filtered.length !== rows.length
      const enriched = filtered.map((entry) => {
        const meta: any = entry.meta || {}

        // Backfill timestamps for court bookings (including cancelled ones logged earlier).
        if (entry.kind === 'court_booking' && typeof meta.courtbookingid === 'number') {
          const b = courtBookingById.get(meta.courtbookingid)
          if (b && (!meta.start_timestamp || !meta.end_timestamp)) {
            const nextMeta = {
              ...meta,
              start_timestamp: meta.start_timestamp ?? b?.start_timestamp ?? null,
              end_timestamp: meta.end_timestamp ?? b?.end_timestamp ?? null,
              availabilityid: meta.availabilityid ?? b?.availabilityid ?? null,
            }
            if (JSON.stringify(nextMeta) !== JSON.stringify(meta)) {
              changed = true
              return { ...entry, meta: nextMeta }
            }
          }
        }

        if (entry.kind === 'created_event') {
          const eventId = typeof meta.eventid === 'number' ? meta.eventid : null
          let nextMeta = meta

          if (typeof meta.monetize !== 'boolean' && typeof eventId === 'number') {
            const v = createdEventMonetizeById.get(eventId)
            if (typeof v === 'boolean') nextMeta = { ...nextMeta, monetize: v }
          }
          if ((!meta.court_name || !String(meta.court_name).trim()) && typeof eventId === 'number') {
            const name = createdEventCourtNameById.get(eventId)
            if (name) nextMeta = { ...nextMeta, court_name: name }
          }
          if (nextMeta !== meta) {
            changed = true
            return { ...entry, meta: nextMeta }
          }
        }

        if (entry.kind === 'created_session') {
          const sessionId = typeof meta.sessionid === 'number' ? meta.sessionid : null
          let nextMeta = meta

          if (typeof meta.monetize !== 'boolean' && typeof sessionId === 'number') {
            const v = createdSessionMonetizeById.get(sessionId)
            if (typeof v === 'boolean') nextMeta = { ...nextMeta, monetize: v }
          }
          if ((!meta.court_name || !String(meta.court_name).trim()) && typeof sessionId === 'number') {
            const name = createdSessionCourtNameById.get(sessionId)
            if (name) nextMeta = { ...nextMeta, court_name: name }
          }
          if (nextMeta !== meta) {
            changed = true
            return { ...entry, meta: nextMeta }
          }
        }

        return entry
      })

      if (changed) {
        void setHistory(userId, enriched)
      }
      return enriched
    } catch {
      return rows
    }
  }, [userId, dashboardRaw])

  const loadLocal = useCallback(async (): Promise<HistoryEntry[]> => {
    if (typeof userId !== 'number') return []
    const rows = await listHistory(userId)
    const local = Array.isArray(rows) ? rows : []
    itemsCountRef.current = local.length
    hasLoadedOnceRef.current = true
    setItems(local)
    return local
  }, [userId])

  const reconcileFrom = useCallback(async (base: HistoryEntry[]) => {
    if (typeof userId !== 'number') return
    if (loadingRef.current) return

    loadingRef.current = true
    try {
      lastReloadAtRef.current = Date.now()
      const reconciled = await reconcile(base)
      const next = Array.isArray(reconciled) ? reconciled : base
      itemsCountRef.current = next.length
      setItems(next)
    } finally {
      loadingRef.current = false
    }
  }, [userId, reconcile])

  const reload = useCallback(async (opts?: { showRefresh?: boolean; forceReconcile?: boolean }) => {
    const showRefresh = !!opts?.showRefresh
    const forceReconcile = !!opts?.forceReconcile
    if (typeof userId !== 'number') return

    if (showRefresh) setRefreshing(true)
    try {
      // Always refresh from local storage first (fast) so the UI reflects
      // recent booking/creating/cancelling immediately when returning here.
      let local = await loadLocal()

      // If local history is empty, seed from dashboard rows so users still see records.
      if (local.length === 0 && typeof userId === 'number') {
        const seeded = buildSeedHistoryFromDashboard(dashboardRaw, userId)
        if (seeded.length > 0) {
          local = seeded
          itemsCountRef.current = seeded.length
          hasLoadedOnceRef.current = true
          setItems(seeded)
          void setHistory(userId, seeded)
        }
      }

      const now = Date.now()
      const age = now - lastReloadAtRef.current
      const isEmpty = local.length === 0
      const minAge = isEmpty ? 5_000 : 30_000
      const shouldReconcile = forceReconcile || !hasLoadedOnceRef.current || age > minAge

      if (shouldReconcile) {
        await reconcileFrom(local)
      }
    } finally {
      if (showRefresh) setRefreshing(false)
    }
  }, [userId, loadLocal, reconcileFrom])

  useFocusEffect(
    useCallback(() => {
      // Always load local history on focus so changes appear instantly.
      void reload({ showRefresh: false })
    }, [reload])
  )

  const data = useMemo(() => {
    const sorted = Array.isArray(items) ? [...items].sort((a, b) => +new Date(b.ts) - +new Date(a.ts)) : []
    return sorted
  }, [items])

  const paymentIndex = useMemo(() => {
    const byEventBooking = new Map<number, string>()
    const bySessionBooking = new Map<number, string>()
    const byCourtBooking = new Map<number, string>()

    for (const entry of data) {
      if (entry.kind !== 'payment') continue
      const meta: any = entry.meta || {}
      const method = parsePaymentMethodFromSubtitle(entry.subtitle)
      if (!method) continue

      const eventBookingId = meta.eventbookingid
      const tsBookingId = meta.tsbookingid
      const courtBookingId = meta.courtbookingid

      // data is sorted desc, so first seen is the latest.
      if (typeof eventBookingId === 'number' && !byEventBooking.has(eventBookingId)) byEventBooking.set(eventBookingId, method)
      if (typeof tsBookingId === 'number' && !bySessionBooking.has(tsBookingId)) bySessionBooking.set(tsBookingId, method)
      if (typeof courtBookingId === 'number' && !byCourtBooking.has(courtBookingId)) byCourtBooking.set(courtBookingId, method)
    }

    return { byEventBooking, bySessionBooking, byCourtBooking }
  }, [data])

  const linkedRows = useMemo(() => {
    const courtBookingById = new Map<number, any>()
    const eventBookingById = new Map<number, any>()
    const sessionBookingById = new Map<number, any>()
    const eventById = new Map<number, any>()
    const sessionById = new Map<number, any>()

    for (const row of Array.isArray(dashboardRaw?.court_bookings) ? dashboardRaw.court_bookings : []) {
      const id = Number(row?.courtbookingid)
      if (Number.isFinite(id)) courtBookingById.set(id, row)
    }
    for (const row of Array.isArray(dashboardRaw?.event_bookings) ? dashboardRaw.event_bookings : []) {
      const id = Number(row?.eventbookingid)
      if (Number.isFinite(id)) eventBookingById.set(id, row)
    }
    for (const row of Array.isArray(dashboardRaw?.training_bookings) ? dashboardRaw.training_bookings : []) {
      const id = Number(row?.tsbookingid)
      if (Number.isFinite(id)) sessionBookingById.set(id, row)
    }
    for (const row of Array.isArray(dashboardRaw?.events_combined) ? dashboardRaw.events_combined : []) {
      const id = Number(row?.eventid)
      if (Number.isFinite(id)) eventById.set(id, row)
    }
    for (const row of Array.isArray(dashboardRaw?.training_sessions_combined) ? dashboardRaw.training_sessions_combined : []) {
      const id = Number(row?.sessionid)
      if (Number.isFinite(id)) sessionById.set(id, row)
    }

    return { courtBookingById, eventBookingById, sessionBookingById, eventById, sessionById }
  }, [dashboardRaw])

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          hitSlop={{ top: 24, bottom: 24, left: 24, right: 24 }}
          pressRetentionOffset={{ top: 18, bottom: 18, left: 18, right: 18 }}
          activeOpacity={0.8}
        >
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text pointerEvents="none" style={styles.headerTitle}>History</Text>
      </View>

      <View style={styles.subHeader}>
        <Text style={styles.subHeaderTitle}>Activity Logs:</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(it) => it.id}
        contentContainerStyle={styles.listContent}
        refreshing={refreshing}
        onRefresh={() => reload({ showRefresh: true, forceReconcile: true })}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Image source={ICONS.clock} style={styles.emptyIcon} />
            <Text style={styles.emptyTitle}>No history yet</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const prev = index > 0 ? data[index - 1] : null
          const showDate = !prev || formatDateHeader(prev.ts) !== formatDateHeader(item.ts)
          const statusRaw = item.toStatus || item.fromStatus || ''
          const isJoin = (item.kind === 'event_booking' || item.kind === 'session_booking') && /^joined\b/i.test(String(item.title || ''))
          const schedule = formatScheduleParts(item)
          const badges = kindBadges(item.kind)

          const meta: any = item.meta || {}
          const titleAndVenue = (() => {
            const cleanTitle = stripNullTail(item.title || '')
            let title = cleanTitle
            let venue = ''
            let startRaw: any = meta?.start_timestamp ?? null
            let endRaw: any = meta?.end_timestamp ?? null

            if (item.kind === 'event_booking') {
              const eb = typeof meta.eventbookingid === 'number' ? linkedRows.eventBookingById.get(meta.eventbookingid) : null
              const ebEvent = firstRelatedRow((eb as any)?.events)
              const ebEventInfo = firstRelatedRow((ebEvent as any)?.eventinfo)
              const eventId = Number(meta.eventid ?? eb?.eventid ?? ebEvent?.eventid)
              const ev = Number.isFinite(eventId) ? linkedRows.eventById.get(eventId) : null
              const eventName = firstNonEmptyText(
                ev?.title,
                ev?.event_title,
                ebEvent?.title,
                ebEventInfo?.title,
                eb?.event_title,
                eb?.title,
                eb?.name,
              )
              const venueName = firstNonEmptyText(
                ev?.court_name,
                ev?.courtName,
                ebEvent?.court_name,
                ebEvent?.courtName,
                eb?.court_name,
                eb?.courtName,
                meta?.court_name,
                meta?.courtName,
                ev?.address,
                ebEvent?.address,
              )
              title = eventName ? `Booked event: ${eventName}` : (cleanTitle || 'Booked event')
              venue = venueName
              startRaw = startRaw ?? eb?.start_timestamp ?? ebEvent?.start_timestamp ?? ev?.start_timestamp ?? ebEvent?.time ?? ev?.time ?? null
              endRaw = endRaw ?? eb?.end_timestamp ?? ebEvent?.end_timestamp ?? ev?.end_timestamp ?? null
            } else if (item.kind === 'session_booking') {
              const sb = typeof meta.tsbookingid === 'number' ? linkedRows.sessionBookingById.get(meta.tsbookingid) : null
              const sbSession = firstRelatedRow((sb as any)?.trainingsessions)
              const sbSessionInfo = firstRelatedRow((sbSession as any)?.trainingsessioninfo)
              const sessionId = Number(meta.sessionid ?? sb?.sessionid ?? sbSession?.sessionid)
              const sess = Number.isFinite(sessionId) ? linkedRows.sessionById.get(sessionId) : null
              const sessionName = firstNonEmptyText(
                sess?.title,
                sess?.session_title,
                sbSession?.title,
                sbSessionInfo?.title,
                sb?.session_title,
                sb?.title,
                sb?.name,
              )
              const venueName = firstNonEmptyText(
                sess?.court_name,
                sess?.courtName,
                sbSession?.court_name,
                sbSession?.courtName,
                sb?.court_name,
                sb?.courtName,
                meta?.court_name,
                meta?.courtName,
                sess?.address,
                sbSession?.address,
              )
              title = sessionName ? `Booked session: ${sessionName}` : (cleanTitle || 'Booked session')
              venue = venueName
              startRaw = startRaw ?? sb?.start_timestamp ?? sbSession?.start_timestamp ?? sess?.start_timestamp ?? sbSession?.time ?? sess?.time ?? null
              endRaw = endRaw ?? sb?.end_timestamp ?? sbSession?.end_timestamp ?? sess?.end_timestamp ?? null
            } else if (item.kind === 'court_booking') {
              const cb = typeof meta.courtbookingid === 'number' ? linkedRows.courtBookingById.get(meta.courtbookingid) : null
              const courtName = firstNonEmptyText(cb?.court_name, cb?.courtName, meta?.court_name, meta?.courtName)
              title = courtName ? `Booked court: ${courtName}` : (cleanTitle || 'Booked court')
              venue = firstNonEmptyText(cb?.address)
              startRaw = startRaw ?? cb?.start_timestamp ?? null
              endRaw = endRaw ?? cb?.end_timestamp ?? null
            } else if (item.kind === 'created_event') {
              const eventId = Number(meta.eventid)
              const ev = Number.isFinite(eventId) ? linkedRows.eventById.get(eventId) : null
              const eventName = firstNonEmptyText(ev?.title, ev?.event_title)
              title = eventName ? `Event created: ${eventName}` : (cleanTitle || 'Event created')
              venue = firstNonEmptyText(ev?.court_name, ev?.courtName, ev?.address)
              startRaw = startRaw ?? ev?.start_timestamp ?? ev?.time ?? null
              endRaw = endRaw ?? ev?.end_timestamp ?? null
            } else if (item.kind === 'created_session') {
              const sessionId = Number(meta.sessionid)
              const sess = Number.isFinite(sessionId) ? linkedRows.sessionById.get(sessionId) : null
              const sessionName = firstNonEmptyText(sess?.title, sess?.session_title)
              title = sessionName ? `Session created: ${sessionName}` : (cleanTitle || 'Session created')
              venue = firstNonEmptyText(sess?.court_name, sess?.courtName, sess?.address)
              startRaw = startRaw ?? sess?.start_timestamp ?? sess?.time ?? null
              endRaw = endRaw ?? sess?.end_timestamp ?? null
            }

            return { title: title || 'Activity', venue, startRaw, endRaw }
          })()

          const resolvedSchedule = schedule ?? formatScheduleFromTimes(titleAndVenue.startRaw, titleAndVenue.endRaw)
          const resolvedStart = parseLoose(titleAndVenue.startRaw)

          const displayStatusLabel = (() => {
            const bookingStatus = String(meta?.status ?? item.fromStatus ?? '').trim().toLowerCase()
            const sessionStatus = String(meta?.bookingstatus ?? item.toStatus ?? '').trim().toLowerCase()
            const isPast = !Number.isNaN(resolvedStart.getTime()) && resolvedStart.getTime() < Date.now()

            if (sessionStatus === 'missed' || statusRaw.toLowerCase() === 'missed') return 'Missed'
            if (isPast && bookingStatus === 'pending' && (sessionStatus === 'upcoming' || sessionStatus === 'missed' || !sessionStatus)) {
              return 'Missed'
            }
            if (isJoin) return 'Joined'
            return formatStatusLabel(statusRaw)
          })()

          const statusColors = displayStatusLabel === 'Joined' ? statusColor('approved') : statusColor(displayStatusLabel)
          const statusIsDuplicate = !!displayStatusLabel && badges.some((b) => b.toLowerCase() === displayStatusLabel.toLowerCase())

          const subtitleRaw = !isNoisySubtitle(item.subtitle ?? null) ? stripAddMe(String(item.subtitle)) : ''
          const subtitleText = subtitleRaw && !(resolvedSchedule && isScheduleLikeSubtitle(subtitleRaw)) ? subtitleRaw : null
          const venueSubtitle = titleAndVenue.venue ? `Venue: ${titleAndVenue.venue}` : null
          const missedSubtitle = displayStatusLabel === 'Missed'
            ? (item.kind === 'event_booking'
              ? 'You missed this event'
              : item.kind === 'session_booking'
                ? 'You missed this session'
                : 'You missed this booking')
            : null
          const displaySubtitle = missedSubtitle || subtitleText || venueSubtitle

          const paymentMethod = (() => {
            if (item.kind === 'event_booking' && typeof meta.eventbookingid === 'number') {
              return paymentIndex.byEventBooking.get(meta.eventbookingid) || ''
            }
            if (item.kind === 'session_booking' && typeof meta.tsbookingid === 'number') {
              return paymentIndex.bySessionBooking.get(meta.tsbookingid) || ''
            }
            if (item.kind === 'court_booking' && typeof meta.courtbookingid === 'number') {
              return paymentIndex.byCourtBooking.get(meta.courtbookingid) || ''
            }
            // For auto-join entries (no payment record), fall back to meta if present.
            if ((item.kind === 'event_booking' || item.kind === 'session_booking') && typeof meta.payment_method === 'string') {
              return normalizePaymentMethod(meta.payment_method)
            }
            return ''
          })()

          const courtName = (() => {
            const n = meta?.court_name ?? meta?.courtName
            return typeof n === 'string' && n.trim() ? n.trim() : ''
          })()

          const createdType = (() => {
            if (item.kind !== 'created_event' && item.kind !== 'created_session') return ''
            const m = meta?.monetize
            if (typeof m !== 'boolean') return ''
            return m ? 'monetize' : 'free'
          })()

          const courtType = item.kind === 'court_booking' ? (paymentMethod || '') : ''

          const detailsId = (() => {
            if (item.kind === 'court_booking' && typeof meta?.courtbookingid === 'number') return `court_${meta.courtbookingid}`
            if (item.kind === 'event_booking' && typeof meta?.eventbookingid === 'number') return `event_${meta.eventbookingid}`
            if (item.kind === 'session_booking' && typeof meta?.tsbookingid === 'number') return `session_${meta.tsbookingid}`
            if (item.kind === 'created_event' && typeof meta?.eventid === 'number') return `created_event_${meta.eventid}`
            if (item.kind === 'created_session' && typeof meta?.sessionid === 'number') return `created_session_${meta.sessionid}`
            if (item.kind === 'payment') {
              // Prefer linking payment to the booking it belongs to.
              if (typeof meta?.courtbookingid === 'number') return `court_${meta.courtbookingid}`
              if (typeof meta?.eventbookingid === 'number') return `event_${meta.eventbookingid}`
              if (typeof meta?.tsbookingid === 'number') return `session_${meta.tsbookingid}`
              if (typeof meta?.eventid === 'number') return `created_event_${meta.eventid}`
              if (typeof meta?.sessionid === 'number') return `created_session_${meta.sessionid}`
            }
            return ''
          })()

          const handlePress = () => {
            if (!detailsId) return
            router.push({ pathname: '/event/details', params: { id: detailsId } } as any)
          }

          return (
            <View>
              {showDate && (
                <Text style={styles.dateHeader}>{formatDateHeader(item.ts)}</Text>
              )}
              <View style={styles.row}>
                <View style={styles.timelineCol}>
                  <View style={styles.line} />
                  <View style={[styles.dot, { backgroundColor: statusColors.dot }]} />
                </View>

                <TouchableOpacity
                  style={styles.card}
                  onPress={handlePress}
                  disabled={!detailsId}
                  activeOpacity={detailsId ? 0.7 : 1}
                >
                  <View style={styles.cardTop}>
                    <View style={styles.badgeRow}>
                      {badges.map((b) => {
                        const c = kindBadgeColor(b)
                        return (
                          <View key={b} style={[styles.kindBadge, { backgroundColor: c.bg, borderColor: c.border }]}>
                            <Text style={[styles.kindBadgeText, { color: c.fg }]}>{b}</Text>
                          </View>
                        )
                      })}

                      {!!displayStatusLabel && !statusIsDuplicate && (
                        <View style={[styles.statusBadge, { backgroundColor: statusColors.bg }]}>
                          <Text style={[styles.statusBadgeText, { color: statusColors.fg }]}>{displayStatusLabel}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.timeText}>{formatLogTime(item.ts)}</Text>
                  </View>

                  <Text style={styles.title}>{titleAndVenue.title}</Text>
                  {!!resolvedSchedule && (
                    <View style={styles.scheduleWrap}>
                      <Text style={styles.scheduleText}>Time: {resolvedSchedule.time}</Text>
                      {(item.kind === 'created_event' || item.kind === 'created_session') && !!createdType && (
                        <Text style={styles.scheduleText}>Type: {createdType}</Text>
                      )}
                      {(item.kind === 'created_event' || item.kind === 'created_session') && !!courtName && (
                        <Text style={styles.scheduleText}>Court: {courtName}</Text>
                      )}
                    </View>
                  )}
                  {!!displaySubtitle && <Text style={styles.subtitle}>{displaySubtitle}</Text>}

                  {(item.kind === 'event_booking' || item.kind === 'session_booking' || item.kind === 'court_booking') && !!paymentMethod && (
                    <Text style={styles.metaText}>Payment: {paymentMethod}</Text>
                  )}

                  {item.kind === 'court_booking' && !!courtType && (
                    <Text style={styles.metaText}>Type: {courtType}</Text>
                  )}
                  {(item.kind === 'created_event' || item.kind === 'created_session') && !!createdType && !resolvedSchedule && (
                    <Text style={styles.metaText}>Type: {createdType}</Text>
                  )}
                  {(item.kind === 'created_event' || item.kind === 'created_session') && !!courtName && !resolvedSchedule && (
                    <Text style={styles.metaText}>Court: {courtName}</Text>
                  )}

                  {typeof item.amount === 'number' && (
                    <Text style={styles.amount}>Amount: {Math.round(item.amount).toLocaleString()}₫</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )
        }}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F9F9F9' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#EAEAEA',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111',
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
  },
  backButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    borderRadius: 24,
    backgroundColor: '#f2f2f2',
    zIndex: 3,
  },
  backIcon: { width: 20, height: 20, tintColor: '#333', resizeMode: 'contain' },

  subHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  subHeaderTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#0F172A',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  listContent: { paddingHorizontal: 12, paddingTop: 0, paddingBottom: 28 },
  dateHeader: { marginTop: 14, marginBottom: 8, fontSize: 14, fontWeight: '700', color: '#222', marginLeft: 4 },

  row: { flexDirection: 'row', alignItems: 'stretch' },
  timelineCol: { width: 28, alignItems: 'center' },
  line: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#E2E8F0', borderRadius: 1 },
  dot: { width: 12, height: 12, borderRadius: 999, marginTop: 16, borderWidth: 2, borderColor: '#fff' },

  card: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  kindBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  kindBadgeText: { fontSize: 12, fontWeight: '900', color: '#0F172A' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusBadgeText: { fontSize: 12, fontWeight: '900' },
  timeText: { color: '#64748B', fontSize: 12, fontWeight: '800' },
  title: { marginTop: 10, fontSize: 16, fontWeight: '900', color: '#0F172A' },
  scheduleWrap: { marginTop: 6, gap: 2 },
  scheduleText: { fontSize: 12, fontWeight: '800', color: '#64748B' },
  subtitle: { marginTop: 4, fontSize: 14, fontWeight: '700', color: '#475569' },
  metaText: { marginTop: 4, fontSize: 12, fontWeight: '800', color: '#64748B' },
  amount: { marginTop: 8, color: '#0F172A', fontWeight: '900', fontSize: 14 },

  emptyWrap: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 24 },
  emptyIcon: { width: 48, height: 48, tintColor: '#94A3B8', resizeMode: 'contain' },
  emptyTitle: { marginTop: 12, fontSize: 18, fontWeight: '900', color: '#0F172A' },
})