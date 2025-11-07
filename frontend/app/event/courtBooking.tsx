import { ICONS } from "@/constants/icons";
import { useRouter } from "expo-router";
import React from "react";
import { Image, Text, TouchableOpacity, View } from "react-native";

export default function CourtBooking() {
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: "#fff" }}>
      <TouchableOpacity
        style={{ flexDirection: "row", alignItems: "center", padding: 16 }}
        onPress={() => router.back()}
      >
        <Image source={ICONS.arrowLeft} style={{ width: 28, height: 28 }} />
        <Text style={{ marginLeft: 8, fontWeight: "600", fontSize: 16 }}>Return</Text>
      </TouchableOpacity>
      {/* Content here */}
    </View>
  );
}
