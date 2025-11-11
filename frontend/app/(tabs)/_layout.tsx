import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
import { Tabs } from "expo-router";
import React from "react";
import { Image, ImageBackground, View } from "react-native";

const _layout = () => {
  return (
    <Tabs
      screenOptions={{
        tabBarShowLabel: true,
        tabBarStyle: {
          backgroundColor: "#ffffff", // Set navigation bar to white
        },
        tabBarItemStyle: {
          justifyContent: "center",
          alignItems: "center",
        },
        tabBarActiveTintColor: COLORS.darkblue,
        tabBarInactiveTintColor: COLORS.black,
      }}
    >
      <Tabs.Screen
        name="Home"
        options={{
          title: "Homepage",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                flex: 1,
                minWidth: 55,
                minHeight: 50,
                marginTop: 8,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: focused ? "#87CEEB" : "transparent", 
                borderRadius: 8,
              }}
            >
              <Image
                source={ICONS.home}
                style={{
                  width: 24,
                  height: 24,
                  tintColor: focused ? COLORS.white : COLORS.black,
                }}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="Activity"
        options={{
          title: "Activities",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                flex: 1,
                minWidth: 55,
                minHeight: 50,
                marginTop: 8,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: focused ? "#87CEEB" : "transparent",
                borderRadius: 8,
              }}
            >
              <Image
                source={ICONS.activity}
                style={{
                  width: 24,
                  height: 24,
                  tintColor: focused ? COLORS.white : COLORS.black,
                }}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="Map"
        options={{
          title: "Map",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                flex: 1,
                minWidth: 75,
                minHeight: 75,
                marginBottom: 56,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor:  "#f5a623" , 
                borderWidth: 1, 
                borderColor: "#000000",
                borderRadius: 37.5,
              }}
            >
              <Image
                source={ICONS.map}
                style={{
                  width: 40,
                  height: 40,
                  tintColor: focused ? COLORS.white : COLORS.black,
                }}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="Notification"
        options={{
          title: "Notification",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                flex: 1,
                minWidth: 55,
                minHeight: 50,
                marginTop: 8,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: focused ? "#87CEEB" : "transparent",
                borderRadius: 8,
              }}
            >
              <Image
                source={ICONS.notifications}
                style={{
                  width: 24,
                  height: 24,
                  tintColor: focused ? COLORS.white : COLORS.black,
                }}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="Settings"
        options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                flex: 1,
                minWidth: 55,
                minHeight: 50,
                marginTop: 8,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: focused ? "#87CEEB" : "transparent",
                borderRadius: 8,
              }}
            >
              <Image
                source={ICONS.settings}
                style={{
                  width: 24,
                  height: 24,
                  tintColor: focused ? COLORS.white : COLORS.black,
                }}
              />
            </View>
          ),
        }}
      />
    </Tabs>
  );
};

export default _layout;