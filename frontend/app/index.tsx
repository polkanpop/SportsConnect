import { useAuthContext } from '@/hooks/use-auth-context';
import { Redirect } from 'expo-router';

/**
 * Root index route.
 * Expo Router shows the "Welcome" placeholder when there are no concrete leaf routes
 * available at initial load ("/"). In the previous setup only grouped stacks existed
 * (e.g. (auth), (tabs)) with no index screen inside them, so a fresh clone opened at "/"
 * had nothing to render and fell back to the welcome screen.
 *
 * This file becomes the leaf route for "/" and immediately redirects based on auth state.
 * We wait for isLoading=false before redirecting so that AsyncStorage-backed auth state
 * (rememberMe, backendAuth tokens) is fully resolved before we decide the destination.
 * Without this gate, the redirect fires while isLoggedIn is still false (tokens not yet
 * read from AsyncStorage), causing a brief flash of the login screen on cold start.
 */
export default function Index() {
  const { isLoggedIn, isLoading } = useAuthContext();

  if (isLoading) return null;

  return <Redirect href={isLoggedIn ? '/(tabs)/Home' : '/(auth)/login'} />;
}
