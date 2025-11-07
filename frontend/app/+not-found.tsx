import { Stack } from 'expo-router'
import { View, Text, Pressable } from 'react-native'
import './global.css'

export default function NotFound() {
  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-black px-6">
      <Stack.Screen options={{ title: 'Not found', presentation: 'modal' }} />
      <Text className="text-3xl font-bold mb-2 text-black dark:text-white">404</Text>
      <Text className="text-base mb-6 text-gray-600 dark:text-gray-300 text-center">
        The screen you were looking for does not exist.
      </Text>
      <Pressable
        accessibilityRole="button"
        className="px-5 py-3 rounded-xl bg-green-700 active:opacity-90"
        onPress={() => {
          // Go back to root index; expo-router will redirect accordingly
          window.location.href = '/';
        }}
      >
        <Text className="text-white font-semibold">Go Home</Text>
      </Pressable>
    </View>
  )
}
