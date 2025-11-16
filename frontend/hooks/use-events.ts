import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys'
import { listEventsCombined, listTrainingSessionsCombined, CombinedEvent, CombinedTrainingSession } from '@/lib/backendApi'

export function useEventsCombined() {
  return useQuery<CombinedEvent[]>({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombined(),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}

export function useTrainingSessionsCombined() {
  return useQuery<CombinedTrainingSession[]>({
    queryKey: queryKeys.trainingSessionsCombined,
    queryFn: () => listTrainingSessionsCombined(),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  })
}
