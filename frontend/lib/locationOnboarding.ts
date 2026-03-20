import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Location from 'expo-location'

const FIRST_SIGNUP_LOCATION_PROMPT_KEY = '@firstSignupLocationPromptAsked'

// Ask location permission once after first successful account creation/login bootstrap.
export async function requestLocationPermissionOnceAfterSignup(): Promise<void> {
  try {
    const asked = await AsyncStorage.getItem(FIRST_SIGNUP_LOCATION_PROMPT_KEY)
    if (asked === 'true') return

    const current = await Location.getForegroundPermissionsAsync()
    if (!current.granted) {
      await Location.requestForegroundPermissionsAsync()
    }

    await AsyncStorage.setItem(FIRST_SIGNUP_LOCATION_PROMPT_KEY, 'true')
  } catch {
    // Never block auth flow if permission prompt fails.
  }
}
