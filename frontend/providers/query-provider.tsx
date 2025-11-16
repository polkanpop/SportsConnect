import React, { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import { AppState } from 'react-native'

// Configure react-query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000, // 1 min fresh
      gcTime: 30 * 60 * 1000, // 30 min cache retention
      retry: 1,
      refetchOnReconnect: true,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 0,
    },
  },
})

// React Native online state wiring
onlineManager.setEventListener(setOnline => {
  return NetInfo.addEventListener(state => {
    setOnline(Boolean(state.isConnected) && Boolean(state.isInternetReachable))
  })
})

// App foreground/background focus wiring
focusManager.setEventListener(handleFocus => {
  const subscription = AppState.addEventListener('change', status => {
    handleFocus(status === 'active')
  })
  return () => subscription.remove()
})

// Redact helper: remove sensitive-looking token fields recursively before writing
function redact(obj: any) {
  if (!obj || typeof obj !== 'object') return obj
  const clone = JSON.parse(JSON.stringify(obj)) // deep clone
  const stack: any[] = [clone]
  while (stack.length) {
    const current = stack.pop()
    for (const key of Object.keys(current)) {
      const value = current[key]
      if (['token', 'access_token', 'refresh_token', 'authToken'].includes(key)) {
        current[key] = '__redacted__'
      } else if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }
  return clone
}

// Persistence via AsyncStorage with redaction & custom key
const CACHE_KEY = 'tanstack-cache-v1'
const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: CACHE_KEY,
  throttleTime: 1500,
  serialize: data => {
    try { return JSON.stringify(redact(data)) } catch { return '{}' }
  },
  deserialize: str => {
    try { return JSON.parse(str) } catch { return {} }
  },
})

type Props = { children: ReactNode }

export default function QueryProvider({ children }: Props) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60 * 1000, // 24h
        buster: 'cache-schema-v1', // bump when query shapes change
        dehydrateOptions: {
          // Only dehydrate queries we explicitly want persisted (example: skip transient auth)
          shouldDehydrateQuery: q => {
            const keyFirst = Array.isArray(q.queryKey) ? q.queryKey[0] : null
            if (keyFirst === 'auth' || keyFirst === 'session') return false // skip auth/session
            return true
          },
        },
      }}
      onSuccess={() => {
        // Optionally: prefetch or invalidate certain keys after hydration if freshness required
        // queryClient.invalidateQueries({ queryKey: ['courtinfo'] })
      }}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </PersistQueryClientProvider>
  )
}

// Helper hook examples can live elsewhere but kept minimal here.
export { queryClient }