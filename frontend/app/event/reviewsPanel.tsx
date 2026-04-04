import React, { useMemo } from 'react'
import {
  ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import {
  listEventsCombinedCached,
  listTrainingSessionsCombinedCached,
  listCourtAvailabilityAll,
  listCourtInfoCached,
} from '@/lib/backendApi'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { COLORS } from '@/constants/colors'
import { useTranslation } from '@/constants/translations'

type ReviewItem = {
  key: string
  title: string
  subtitle: string
  venueName?: string
  targettype: string
  targetid: number
}

function firstText(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const s = value.trim()
      if (s) return s
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') continue
        const s = item.trim()
        if (s) return s
      }
    }
  }
  return null
}

function firstRelatedRow(rel: any): any | null {
  if (Array.isArray(rel)) return rel[0] ?? null
  if (rel && typeof rel === 'object') return rel
  return null
}

function pickNestedTitle(row: any): string | null {
  const info = firstRelatedRow((row as any)?.eventinfo) || firstRelatedRow((row as any)?.trainingsessioninfo)
  return firstText((row as any)?.title, (info as any)?.title, (row as any)?.name)
}

function pickVenueName(row: any): string | null {
  const info = firstRelatedRow((row as any)?.eventinfo) || firstRelatedRow((row as any)?.trainingsessioninfo)
  return firstText(
    (info as any)?.venue,
    (info as any)?.address,
    (row as any)?.venue,
    (row as any)?.address,
    (row as any)?.court_name,
  )
}

function normalizeBookingStatus(row: any): string {
  const bs = String(row?.bookingstatus ?? row?.status ?? '').toLowerCase()
  if (bs.includes('cancel')) return 'cancelled'
  if (bs.includes('complet')) return 'completed'
  return bs
}

function parseTimestampLoose(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const normalized = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s
  const dt = new Date(normalized)
  if (Number.isNaN(dt.getTime())) return null
  return dt
}

function isReviewableByStatusAndTime(opts: { bookingStatus?: unknown; sessionStatus?: unknown; startTs?: unknown; endTs?: unknown }) {
  const bs = String(opts.bookingStatus ?? '').trim().toLowerCase()
  const ss = String(opts.sessionStatus ?? '').trim().toLowerCase()
  if (ss.includes('cancel') || ss === 'missed') return false
  if (ss === 'completed' || ss === 'complete') return true
  return false
}

export default function ReviewsPanel() {
  const router = useRouter()
  const { t } = useTranslation()
  const { userId, dashboard } = useAppBootstrap()

  const dashboardRaw = dashboard.data
  const dashboardLoading = dashboard.isLoading
  const courtBookingsRaw =
    dashboardRaw?.court_bookings ??
    dashboardRaw?.courtbookings ??
    dashboardRaw?.booked_courts ??
    []
  const eventBookingsRaw =
    dashboardRaw?.event_bookings ??
    dashboardRaw?.eventbookings ??
    []
  const tsBookingsRaw =
    dashboardRaw?.training_bookings ??
    dashboardRaw?.training_session_bookings ??
    dashboardRaw?.ts_bookings ??
    dashboardRaw?.tsbookings ??
    []

  const { data: eventsCombined } = useQuery<any[]>({
    queryKey: ['eventsCombined'],
    queryFn: () => listEventsCombinedCached(),
    staleTime: 5 * 60_000,
  })

  const { data: sessionsCombined } = useQuery<any[]>({
    queryKey: ['trainingSessionsCombined'],
    queryFn: () => listTrainingSessionsCombinedCached(),
    staleTime: 5 * 60_000,
  })

  const { data: courtAvailabilityRaw } = useQuery<any[]>({
    queryKey: ['courtAvailabilityAll'],
    queryFn: () => listCourtAvailabilityAll(),
    enabled: typeof userId === 'number',
    staleTime: 5 * 60_000,
  })

  const { data: courtInfoRaw } = useQuery<any[]>({
    queryKey: ['courtInfoAll'],
    queryFn: () => listCourtInfoCached(),
    enabled: typeof userId === 'number',
    staleTime: 5 * 60_000,
  })

  const isLoading = dashboardLoading

  const reviewItems = useMemo<ReviewItem[]>(() => {
    const items: ReviewItem[] = []

    // Build lookup maps — use Number() to avoid string/number key mismatches from JSON
    const availabilityById = new Map<number, any>()
    if (Array.isArray(courtAvailabilityRaw)) {
      for (const a of courtAvailabilityRaw) {
        const aid = Number(a?.availabilityid)
        if (Number.isFinite(aid)) availabilityById.set(aid, a)
      }
    }
    const courtInfoByCourtId = new Map<number, any>()
    if (Array.isArray(courtInfoRaw)) {
      for (const ci of courtInfoRaw) {
        const cid = Number(ci?.courtid)
        if (Number.isFinite(cid)) courtInfoByCourtId.set(cid, ci)
      }
    }
    const eventsById = new Map<number, any>()
    if (Array.isArray(eventsCombined)) {
      for (const e of eventsCombined) {
        if (typeof e?.eventid === 'number') eventsById.set(e.eventid, e)
      }
    }
    const sessionsById = new Map<number, any>()
    if (Array.isArray(sessionsCombined)) {
      for (const s of sessionsCombined) {
        if (typeof s?.sessionid === 'number') sessionsById.set(s.sessionid, s)
      }
    }

    // Court bookings (completed)
    if (Array.isArray(courtBookingsRaw)) {
      for (const cb of courtBookingsRaw) {
        const reviewable = isReviewableByStatusAndTime({
          bookingStatus: (cb as any)?.status,
          sessionStatus: (cb as any)?.bookingstatus,
          startTs: (cb as any)?.start_timestamp,
          endTs: (cb as any)?.end_timestamp,
        })
        if (!reviewable) continue
        const av = availabilityById.get(Number(cb.availabilityid))
        const courtid = Number.isFinite(Number(av?.courtid)) ? Number(av?.courtid) : undefined
        const courtNameFromBooking = typeof (cb as any)?.court_name === 'string' ? (cb as any).court_name : undefined
        const courtName = courtNameFromBooking || (courtid != null
          ? (courtInfoByCourtId.get(courtid)?.name as string | undefined)
          : undefined)
        const venueName = firstText(courtName, (av as any)?.venue_name, (av as any)?.address)
        items.push({
          key: `court_${cb.courtbookingid}`,
          title: venueName ?? 'Court',
          subtitle: t('REVIEW_PANEL_SUBTITLE_COURT'),
          venueName: venueName ?? undefined,
          targettype: 'court',
          targetid: courtid ?? Number(cb.courtbookingid),
        })
      }
    }

    // Event bookings (completed)
    if (Array.isArray(eventBookingsRaw)) {
      for (const eb of eventBookingsRaw) {
        const ev = eventsById.get(eb.eventid)
        const reviewable = isReviewableByStatusAndTime({
          bookingStatus: (eb as any)?.status,
          sessionStatus: (eb as any)?.bookingstatus,
          startTs: (ev as any)?.start_timestamp ?? (ev as any)?.time,
          endTs: (ev as any)?.end_timestamp,
        })
        if (!reviewable) continue
        const title = pickNestedTitle(ev) || 'Event'
        const venueName = pickVenueName(ev) || undefined
        items.push({
          key: `event_${eb.eventbookingid}`,
          title,
          subtitle: t('REVIEW_PANEL_SUBTITLE_EVENT'),
          venueName,
          targettype: 'event',
          targetid: eb.eventid,
        })
      }
    }

    // Training session bookings (completed)
    if (Array.isArray(tsBookingsRaw)) {
      for (const tb of tsBookingsRaw) {
        const sess = sessionsById.get(tb.sessionid)
        const reviewable = isReviewableByStatusAndTime({
          bookingStatus: (tb as any)?.status,
          sessionStatus: (tb as any)?.bookingstatus,
          startTs: (sess as any)?.start_timestamp ?? (sess as any)?.time,
          endTs: (sess as any)?.end_timestamp,
        })
        if (!reviewable) continue
        const title = pickNestedTitle(sess) || 'Training Session'
        const venueName = pickVenueName(sess) || undefined
        items.push({
          key: `session_${tb.tsbookingid}`,
          title,
          subtitle: t('REVIEW_PANEL_SUBTITLE_TRAINING'),
          venueName,
          targettype: 'trainingsession',
          targetid: tb.sessionid,
        })
      }
    }

    return items
  }, [courtBookingsRaw, eventBookingsRaw, tsBookingsRaw, courtAvailabilityRaw, courtInfoRaw, eventsCombined, sessionsCombined, t])

  if (isLoading) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color={COLORS.bootstrapBlue} />
      </View>
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Text style={styles.heading}>{t('REVIEW_PANEL_HEADING')}</Text>
      <Text style={styles.subheading}>
        {t('REVIEW_PANEL_SUBHEADING')}
      </Text>

      {reviewItems.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>{t('REVIEW_PANEL_EMPTY')}</Text>
        </View>
      ) : (
        reviewItems.map(item => (
          <View key={item.key} style={styles.card}>
            <View style={styles.cardInfo}>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.cardSubtitle}>{item.subtitle}</Text>
            </View>
            <TouchableOpacity
              style={styles.reviewBtn}
              activeOpacity={0.8}
              onPress={() =>
                router.push({
                  pathname: '/event/reviewForm',
                  params: {
                    targettype: item.targettype,
                    targetid: String(item.targetid),
                    title: encodeURIComponent(item.title),
                    venueName: item.venueName ? encodeURIComponent(item.venueName) : undefined,
                  },
                })
              }
            >
              <Text style={styles.reviewBtnText}>{t('REVIEW_PANEL_BTN_REVIEW')}</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: {
    padding: 16,
    paddingBottom: 32,
    backgroundColor: COLORS.neutral0 ?? '#F5F5F5',
    flexGrow: 1,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.neutral0 ?? '#F5F5F5',
  },
  heading: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.neutral975 ?? '#111',
    marginBottom: 4,
  },
  subheading: {
    fontSize: 13,
    color: COLORS.neutral600 ?? '#666',
    marginBottom: 18,
  },
  emptyBox: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.neutral700 ?? '#555',
    fontStyle: 'italic',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white ?? '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.neutral300 ?? '#e0e0e0',
  },
  cardInfo: {
    flex: 1,
    paddingRight: 10,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.neutral975 ?? '#111',
    marginBottom: 2,
  },
  cardSubtitle: {
    fontSize: 12,
    color: COLORS.neutral600 ?? '#777',
  },
  reviewBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: COLORS.bootstrapBlue ?? '#007BFF',
  },
  reviewBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white ?? '#fff',
  },
})
