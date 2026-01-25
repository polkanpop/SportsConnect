import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listCourtInfoCached, listCourtAvailability, createCourtBooking, createPayment, listCourtBookings, deleteCourtBooking } from '@/lib/backendApi'
import { queryKeys } from './query-keys'

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
      return listCourtAvailability(courtid)
    },
    enabled: !!courtid && !Number.isNaN(courtid),
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
    mutationFn: (payload: { availabilityid: number; userid: number; status: string; paymentid?: number|null; start_timestamp: string; end_timestamp: string; bookingdate: string }) => createCourtBooking(payload),
    onSuccess: (_data, variables) => {
      // Invalidate availability queries (cannot reliably map availabilityid -> courtid here)
      queryClient.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability'
      })
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
      const key = ['courtbookings','user', payload.userid]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<any[]>(key) || []
      qc.setQueryData<any[]>(key, prev.filter(b => b.courtbookingid !== payload.courtbookingid))
      return { prev }
    },
    onError: (_err, payload, ctx) => {
      if (ctx?.prev) qc.setQueryData(['courtbookings','user', payload.userid], ctx.prev)
    },
    onSuccess: (_data, payload) => {
      qc.invalidateQueries({ queryKey: ['courtbookings','user', payload.userid] })
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
    mutationFn: async (payload: { availabilityid: number; userid: number; status: string; paymentMethod: 'cash'|'vnpay'; start_timestamp: string; end_timestamp: string; bookingdate: string; amount: number; note?: string | null }) => {
      const paymentStatus = payload.paymentMethod === 'cash' ? 'pending' : 'paid'
      const payment = await createPayment({ status: paymentStatus, method: payload.paymentMethod, amount: payload.amount })
      const booking = await createCourtBooking({
        availabilityid: payload.availabilityid,
        userid: payload.userid,
        status: payload.status,
        paymentid: payment.paymentid,
        start_timestamp: payload.start_timestamp,
        end_timestamp: payload.end_timestamp,
        bookingdate: payload.bookingdate,
        note: payload.note ?? null,
      })
      return { booking, payment }
    },
    onSuccess: (data) => {
      // After successful booking invalidate availability for re-fetch
      qc.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'courtavailability'
      })
      qc.invalidateQueries({ queryKey: ['courtbookings','user', data.booking.userid] })
    },
  })
}

export function useUserCourtBookings(userid: number | null | undefined) {
  return useQuery({
    queryKey: ['courtbookings','user', userid],
    queryFn: () => {
      if (userid == null) return []
      return listCourtBookings({ userid })
    },
    enabled: userid != null,
  })
}
