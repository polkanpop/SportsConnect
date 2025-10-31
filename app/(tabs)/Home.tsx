import { SearchBar } from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { useRouter } from "expo-router";
import { Image, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

export default function Home() {
  const router = useRouter();

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#ffffff" }}>
        {/* Header Section */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "#ffffff",
            paddingBottom: 12,
            paddingHorizontal: 8,
          }}
        >
          {/* Search Bar */}
          <View style={{ flex: 1 }}>
            <SearchBar placeholder="Search for courts..." />
          </View>

          {/* Profile Icon */}
          <View
            style={{
              width: 48,
              height: 48,
              backgroundColor: "#d4d4d4",
              borderRadius: 24,
              alignItems: "center",
              justifyContent: "center",
              marginLeft: 8,
            }}
          >
            <Image
              source={ICONS.accountCircle}
              style={{ width: 40, height: 40 }}
              resizeMode="contain"
            />
          </View>
        </View>

        {/* Scroll View Content */}
        <ScrollView
          style={{ flex: 1, backgroundColor: "#ffffff", paddingHorizontal: 8 }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 10 }}
        >
          {/* Categories Section */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-around",
              alignItems: "center",
              paddingVertical: 16,
            }}
          >
            {[
              { icon: ICONS.player, label: "Player", color: "#FFA500" }, // Orange
              { icon: ICONS.coach, label: "Coaches", color: "#32CD32" }, // Green
              { icon: ICONS.court, label: "Court", color: "#FFB6C1" }, // Pink
            ].map((category, index) => (
              <View
                key={index}
                style={{
                  width: 80,
                  height: 80,
                  backgroundColor: category.color,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Image
                  source={category.icon}
                  style={{ width: 48, height: 48 }}
                  resizeMode="contain"
                />
                <Text style={{ fontWeight: "600", fontSize: 12 }}>
                  {category.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Tag Section */}
          <View>
            <Text style={{ fontWeight: "600", fontSize: 18, marginBottom: 8 }}>
              Your choices
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {[...Array(7)].map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 80,
                    height: 40,
                    backgroundColor: "#d4d4d4",
                    borderRadius: 8,
                    marginRight: 16,
                  }}
                />
              ))}
            </ScrollView>
          </View>

          {/* Event Section */}
          <View>
            <Text style={{ fontWeight: "600", fontSize: 18, marginVertical: 8 }}>
              Event
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {[...Array(3)].map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 240,
                    height: 160,
                    backgroundColor: "#d4d4d4",
                    borderRadius: 8,
                    marginRight: index < 2 ? 16 : 0,
                  }}
                />
              ))}
            </ScrollView>
          </View>

          {/* Recommend Section */}
          <View>
            <Text style={{ fontWeight: "600", fontSize: 18, marginVertical: 8 }}>
              Recommend for you
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {[...Array(3)].map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 240,
                    height: 160,
                    backgroundColor: "#d4d4d4",
                    borderRadius: 8,
                    marginRight: index < 2 ? 16 : 0,
                  }}
                />
              ))}
            </ScrollView>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}