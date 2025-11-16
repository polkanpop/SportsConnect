// Centralized query keys
// Pattern: export const queryKeys = { resource: ['resource'], resourceDetail: (id:number)=>['resource', id] }
// Use consistent key factories to avoid typos across hooks/components.

export const queryKeys = {
  courtInfo: ['courtinfo'] as const,
  courtAvailability: (courtid: number | null) => ['courtavailability', courtid ?? -1] as const,
  userId: ['userId'] as const,
  favouriteCourts: (userid: number | null, idsOnly?: boolean) => ['favouritecourts', userid ?? -1, idsOnly ? 'ids' : 'full'] as const,
  userInfo: (userid: number | null) => ['userinfo', userid ?? -1] as const,
  eventsCombined: ['eventsCombined'] as const,
  trainingSessionsCombined: ['trainingSessionsCombined'] as const,
}

export type QueryKey = ReturnType<typeof queryKeys.courtAvailability>
