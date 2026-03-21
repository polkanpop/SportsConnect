import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listCourtInfoCached, listCourtAvailabilityCached, createCourtBooking, createPayment, listCourtBookings, deleteCourtBooking, listPlayingCourtsByCourtId, getPlayingCourtInfo, listPlayingCourtInfoByCourt, type PlayingCourtRow } from '@/lib/backendApi'
import { queryKeys } from './query-keys'
import { useDashboard } from './use-dashboard'

// Deprecated local keys kept for backward compatibility (will remove later)
const courtInfoKey = ['courtinfo']
const courtAvailabilityKey = (courtid: number) => ['courtavailability', courtid]

export function useCourtInfo() {
  return useQuery({
    queryKey: queryKeys.courtInfo,
    queryFn: () => listCourtInfoCached(),
  })
}

export function useCourtAvailability(courtid: number | null) {
  return useQuery({
    queryKey: queryKeys.courtAvailability(courtid),
    queryFn: () => {
      if (courtid == null || Number.isNaN(courtid)) return []
      return listCourtAvailabilityCached(courtid)
    },
    enabled: !!courtid && !Number.isNaN(courtid),
		staleTime: 60_000,
		gcTime: 10 * 60_000,
		refetchOnWindowFocus: false,
  })
}

export function useCreatePayment() {
  return useMutation({
    mutationFn: (payload: { status: 'paid'|'pending'|'failed'; method: 'vnpay'|'cash'; amount: number }) => createPayment(payload),
  })
}

export function useCreateCourtBooking() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      availabilityid: number
      userid: number
      status: string
      paymentid?: number | null
      start_timestamp: string
      end_timestamp: string
      bookingdate: string
      note?: string | null
      playingcourtid?: number | null
      selected_court_name?: string | null
      selected_base_name?: string | null
      venue_name?: string | null
      selected_part?: 'full' | 'half_a' | 'half_b' | null
      selected_surface?: string | null
      court_price_at_booking?: number | null
      duration_minutes?: number | null
      total_amount?: number | null
    }) => createCourtBooking(payload),
    onSuccess: (_data, variables) => {
      // Invalidate availability queries (cannot reliably map availabilityid -> courtid here)
      queryClient.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability'
      })
      // Force dashboard + user booking list refresh so newly booked slots/records show immediately.
      queryClient.invalidateQueries({ queryKey: queryKeys.courtBookingsUser(variables.userid) })
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(variables.userid) })
    },
  })
}

// Future deletion (toggle booking back to normal availability)
export function useDeleteCourtBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { courtbookingid: number; availabilityid: number; userid: number }) => deleteCourtBooking(payload.courtbookingid),
    onMutate: async (payload) => {
      // Optimistically update user bookings cache
      const key = queryKeys.courtBookingsUser(payload.userid)
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<any[]>(key) || []
      qc.setQueryData<any[]>(key, prev.filter(b => b.courtbookingid !== payload.courtbookingid))
      return { prev }
    },
    onError: (_err, payload, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.courtBookingsUser(payload.userid), ctx.prev)
    },
    onSuccess: (_data, payload) => {
      qc.invalidateQueries({ queryKey: queryKeys.courtBookingsUser(payload.userid) })
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(payload.userid) })
      // Invalidate availability to reflect freed slot
      qc.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability'
      })
    },
  })
}

// Composite mutation: create payment then booking. Provides rollback if booking fails.
export function useCreateBookingWithPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: {
      availabilityid: number
      userid: number
      status: string
      paymentMethod: 'cash' | 'vnpay'
      start_timestamp: string
      end_timestamp: string
      bookingdate: string
      amount: number
      note?: string | null
      playingcourtid?: number | null
      selected_court_name?: string | null
      selected_base_name?: string | null
      venue_name?: string | null
      selected_part?: 'full' | 'half_a' | 'half_b' | null
      selected_surface?: string | null
      court_price_at_booking?: number | null
      duration_minutes?: number | null
      total_amount?: number | null
    }) => {
      const payment = await createPayment({ status: 'paid', method: payload.paymentMethod, amount: payload.amount })
      const booking = await createCourtBooking({
        availabilityid: payload.availabilityid,
        userid: payload.userid,
        status: payload.status,
        paymentid: payment.paymentid,
        start_timestamp: payload.start_timestamp,
        end_timestamp: payload.end_timestamp,
        bookingdate: payload.bookingdate,
        note: payload.note ?? null,
        playingcourtid: payload.playingcourtid ?? null,
        selected_court_name: payload.selected_court_name ?? null,
        selected_base_name: payload.selected_base_name ?? null,
        venue_name: payload.venue_name ?? null,
        selected_part: payload.selected_part ?? null,
        selected_surface: payload.selected_surface ?? null,
        court_price_at_booking: payload.court_price_at_booking ?? null,
        duration_minutes: payload.duration_minutes ?? null,
        total_amount: payload.total_amount ?? payload.amount ?? null,
      })
      return { booking, payment }
    },
    onSuccess: (data) => {
      // After successful booking invalidate availability for re-fetch
      qc.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability'
      })
      qc.invalidateQueries({ queryKey: queryKeys.courtBookingsUser(data.booking.userid) })
      qc.invalidateQueries({ queryKey: queryKeys.dashboard(data.booking.userid) })
    },
  })
}

export function useUserCourtBookings(userid: number | null | undefined) {
  const q = useDashboard(typeof userid === 'number' ? userid : null)
  return {
    ...q,
    data: Array.isArray(q.data?.court_bookings) ? q.data.court_bookings : [],
  }
}

export function usePlayingCourts(courtid: number | null) {
  return useQuery<PlayingCourtRow[]>({
    queryKey: queryKeys.playingCourts(courtid),
    queryFn: () => listPlayingCourtsByCourtId(courtid!),
    enabled: !!courtid && Number.isFinite(courtid),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  })
}

export function usePlayingCourtImages(courtId: number | null, playingCourtIds: number[]) {
  return useQuery<Record<number, string[]>>({
    queryKey: queryKeys.playingCourtImages(courtId, playingCourtIds),
    queryFn: ({ signal }) => listPlayingCourtInfoByCourt(courtId!, signal),
    enabled: !!courtId && Number.isFinite(courtId) && playingCourtIds.length > 0,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  })
}
