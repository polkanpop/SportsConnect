import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import { listEventsCombinedCached, listTrainingSessionsCombinedCached, CombinedEvent, CombinedTrainingSession } from '@/lib/backendApi'

export function useEventsCombined() {
  return useQuery<CombinedEvent[]>({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}

export function useTrainingSessionsCombined() {
  return useQuery<CombinedTrainingSession[]>({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombinedCached(),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}
