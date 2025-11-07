import { useAuthContext } from '@/hooks/use-auth-context';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';

/**
 * Root index route.
 * Expo Router shows the "Welcome" placeholder when there are no concrete leaf routes
 * available at initial load ("/"). In the previous setup only grouped stacks existed
 * (e.g. (auth), (tabs)) with no index screen inside them, so a fresh clone opened at "/"
 * had nothing to render and fell back to the welcome screen.
 *
 * This file becomes the leaf route for "/" and immediately redirects based on auth state.
 */
export default function Index() {
  const { isLoggedIn } = useAuthContext();
  const [ready, setReady] = useState(false);

  // In case auth context initializes asynchronously, wait a tick if undefined
  useEffect(() => {
    if (typeof isLoggedIn === 'boolean') setReady(true);
  }, [isLoggedIn]);

  if (!ready) return null; // Could place a splash/loading component here

  return <Redirect href={isLoggedIn ? '/(tabs)/Home' : '/(auth)/login'} />;
}
