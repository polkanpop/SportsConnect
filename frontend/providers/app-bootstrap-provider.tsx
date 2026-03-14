import React, { createContext, useContext } from 'react'
import type { CombinedEvent, CombinedTrainingSession, FavouriteCourt, NotificationRow, UserInfoRow } from '@/lib/backendApi'
import { useDashboard } from '@/hooks/use-dashboard'
import { useUserId } from '@/hooks/use-user-id'
import { useUserIdentity } from '@/hooks/use-user-identity'
import { useFavouriteCourts } from '@/hooks/use-favourite-courts'

type BootstrapUserInfoState = {
  data: UserInfoRow | null
  isLoading: boolean
  error: unknown
}

export type AppBootstrapValue = {
  userId: number | null
  userIdentity: ReturnType<typeof useUserIdentity>
  favouriteCourts: FavouriteCourt[]
  favouriteCourtsQuery: ReturnType<typeof useFavouriteCourts>
  dashboard: ReturnType<typeof useDashboard>
  userInfo: BootstrapUserInfoState
  notifications: NotificationRow[]
  eventsCombined: CombinedEvent[]
  trainingSessionsCombined: CombinedTrainingSession[]
}

const AppBootstrapContext = createContext<AppBootstrapValue>({
  userId: null,
  userIdentity: {
    data: null,
    isLoading: false,
    error: null,
  } as any,
  favouriteCourts: [],
  favouriteCourtsQuery: {
    data: [],
    isLoading: false,
    error: null,
  } as any,
  dashboard: {
    data: undefined,
    isLoading: false,
    error: null,
  } as any,
  userInfo: {
    data: null,
    isLoading: false,
    error: null,
  },
  notifications: [],
  eventsCombined: [],
  trainingSessionsCombined: [],
})

export function AppBootstrapProvider({ children }: { children: React.ReactNode }) {
  const { data: userIdRaw } = useUserId()
  const userId = typeof userIdRaw === 'number' ? userIdRaw : null
  // Highest-priority startup fetches.
  const userIdentity = useUserIdentity(userId)
  const favouriteCourtsQuery = useFavouriteCourts(userId)

  // Dashboard starts only after identity has at least attempted to resolve.
  const dashboard = useDashboard(userId, {
    enabled: userIdentity.isFetched,
  })

  const userInfo: BootstrapUserInfoState = {
    data: userIdentity.data ?? null,
    isLoading: userIdentity.isLoading,
    error: userIdentity.error,
  }
  const favouriteCourts = Array.isArray(favouriteCourtsQuery.data) ? favouriteCourtsQuery.data : []
  const notifications = Array.isArray(dashboard.data?.notifications) ? dashboard.data!.notifications! : []
  const eventsCombined = Array.isArray(dashboard.data?.events_combined) ? dashboard.data!.events_combined! : []
  const trainingSessionsCombined = Array.isArray(dashboard.data?.training_sessions_combined)
    ? dashboard.data!.training_sessions_combined!
    : []

  return (
    <AppBootstrapContext.Provider value={{
      userId,
      userIdentity,
      favouriteCourts,
      favouriteCourtsQuery,
      dashboard,
      userInfo,
      notifications,
      eventsCombined,
      trainingSessionsCombined,
    }}>
      {children}
    </AppBootstrapContext.Provider>
  )
}

export function useAppBootstrap() {
  return useContext(AppBootstrapContext)
}
