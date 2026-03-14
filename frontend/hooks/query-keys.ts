// Centralized query keys
// Pattern: export const queryKeys = { resource: ['resource'], resourceDetail: (id:number)=>['resource', id] }
// Use consistent key factories to avoid typos across hooks/components.

export const queryKeys = {
  courtInfo: ['courtinfo'] as const,
  courtAvailability: (courtid: number | null) => ['courtavailability', courtid ?? -1] as const,
  courtAvailabilityById: (availabilityid: number | null) => ['courtavailability', 'by-id', availabilityid ?? -1] as const,
  playingCourts: (courtid: number | null) => ['playingCourts', courtid ?? -1] as const,
  playingCourtImages: (courtId: number | null, pcIds: number[]) => ['playingCourtImages', courtId ?? -1, pcIds.join(',')] as const,
  userId: ['userId'] as const,
  favouriteCourts: (userid: number | null, idsOnly?: boolean) => ['favouritecourts', userid ?? -1, idsOnly ? 'ids' : 'full'] as const,
  userInfo: (userid: number | null) => ['userinfo', userid ?? -1] as const,
  courtBookingsUser: (userid: number | null) => ['bookings', 'court', userid ?? -1] as const,
  eventBookingsUser: (userid: number | null) => ['bookings', 'event', userid ?? -1] as const,
  trainingBookingsUser: (userid: number | null) => ['bookings', 'training', userid ?? -1] as const,
  eventsCombined: ['eventsCombined'] as const,
  trainingSessionsCombined: ['trainingSessionsCombined'] as const,
  dashboard: (userid: number | null) => ['dashboard', userid ?? -1] as const,
  reviews: (params?: { userid?: number | null; targettype?: string; targetid?: number | null }) =>
    ['reviews', params?.userid ?? null, params?.targettype ?? null, params?.targetid ?? null] as const,
}

export type QueryKey = ReturnType<typeof queryKeys.courtAvailability>
