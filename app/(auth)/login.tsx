import AppleSignInButton from "@/components/social-auth-buttons/apple/expo-apple-sign-in-button";
import GoogleSignInButton from "@/components/social-auth-buttons/google/google-sign-in-button";
import { ICONS } from "@/constants/icons";
import { supabase } from "@/lib/supabase";
import { Link, Stack, router } from "expo-router";
import { useState } from "react";
import { Image, Pressable, Text, TextInput, TouchableOpacity, View } from "react-native";

export default function LoginScreen() {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      {/* this for the sign in google bug where it auto resize the footer component*/}
      <View className="flex-1 bg-[#f8f8f8] px-7 pt-20">

        {/* Logo Section  */}
        <View className="items-center mb-8">
          <Image source={ICONS.app_icon} className="w-20 h-20" />
          <Text className="text-4xl font-extrabold text-green-700 mt-2 tracking-wide">
            SportConnect
          </Text>
        </View>

        {/* LOGIN FORM */}
        <View>
          <Text className="text-3xl font-bold text-dark-300 mb-6 text-center">
            Login
          </Text>

          <TextInput
            placeholder="Email"
            placeholderTextColor="#6A6B6B"
            value={email}
            onChangeText={setEmail}
            className="w-full bg-white rounded-xl py-3 px-4 border border-dark-300 mb-4 text-dark-300"
          />

          <View className="w-full mb-5 flex-row items-center bg-white rounded-xl border border-dark-300 pr-3">
            <TextInput
              placeholder="Password"
              placeholderTextColor="#6A6B6B"
              secureTextEntry={!passwordVisible}
              value={password}
              onChangeText={setPassword}
              className="flex-1 py-3 px-4 text-dark-300"
            />
            <Pressable onPress={() => setPasswordVisible(!passwordVisible)}>
              <Image
                source={passwordVisible ? ICONS.notEye : ICONS.eye}
                className="w-6 h-6 tint-dark-300"
              />
            </Pressable>
          </View>

          <View className="w-full flex-row justify-between items-center mb-8">
            <Pressable
              onPress={() => setRememberMe(!rememberMe)}
              className="flex-row items-center"
            >
              <View
                className={`w-5 h-5 rounded-md border mr-2 justify-center items-center ${
                  rememberMe ? "bg-green-700 border-green-700" : "border-dark-300"
                }`}
              >
                {rememberMe && (
                  <Image source={ICONS.checkSmall} className="w-5 h-5 tint-white" />
                )}
              </View>
              <Text className="text-dark-300">Remember me</Text>
            </Pressable>

            <Pressable>
              <Text className="text-green-700 font-semibold">
                Forgot Password?
              </Text>
            </Pressable>
          </View>

          <TouchableOpacity
            onPress={async () => {
              if (!email || !password) {
                alert("Please fill in both email and password.");
                return;
              }

              if (email !== "test@example.com" || password !== "123456") {
                alert("Wrong email or password.");
                return;
              }

              alert("Login successful!");
            }}
            className="bg-green-700 w-full py-3 rounded-xl shadow-md"
          >
            <Text className="text-white text-center font-semibold text-lg">
              Login
            </Text>
          </TouchableOpacity>
        </View>

        {/* Divider */}
        <View className="flex-row items-center w-full mt-8 mb-3">
          <View className="flex-1 h-[1px] bg-dark-300 opacity-30 mr-3" />
          <Text className="text-dark-300 text-sm">Or Login with</Text>
          <View className="flex-1 h-[1px] bg-dark-300 opacity-30 ml-3" />
        </View>

        {/* Social Buttons */}
        <View className="flex-row justify-center w-full gap-3 mb-8">
          <GoogleSignInButton />
          <AppleSignInButton />
        </View>

        {/* Quick Login */}
        <TouchableOpacity
          onPress={async () => {
            const { error } = await supabase.auth.signInAnonymously();
            if (!error) router.replace("/(tabs)/Home");
          }}
        >
          <Text className="underline text-blue-600 text-base mb-5 text-center">
            Quick Access to Home
          </Text>
        </TouchableOpacity>

        {/* Sign Up */}
        <View className="flex-row gap-1 mb-10 justify-center">
          <Text className="text-dark-300">Don't have an account?</Text>
          <Link href="/(auth)/signup">
            <Text className="text-green-700 font-bold">Sign up</Text>
          </Link>
        </View>
      </View>
    </>
  );
}
