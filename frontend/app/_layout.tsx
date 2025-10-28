import { Stack } from "expo-router";
import './global.css';
import { StackScreen } from "react-native-screens";

export default function RootLayout() {
  return <Stack>
  <Stack.Screen
  name="(tabs)"
  options={{headerShown: false}}
  />
  <Stack.Screen
  name="event/[id]"
  options={{headerShown: false}}
  />


 </Stack>
}
