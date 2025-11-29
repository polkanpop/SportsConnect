import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
import { Tabs } from "expo-router";
import React, { useEffect, useMemo, useRef } from "react";
import { Image, View, Pressable, StyleSheet, useWindowDimensions, Animated, Text } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
const TabBarBackground = ({ width, height }: { width: number; height: number }) => {
  const center = width / 2;
  
  // Geometry for the "socket" cutout
  const rButton = 35; // Radius of the button (70/2)
  const rGap = 10; // Gap between button and bar
  const rCutout = rButton + rGap; // 45
  const rCorner = 12; // Radius of the smoothing corner

  // Calculate transition points
  // The fillet circle (radius rCorner) is tangent to y=0 and the cutout circle (radius rCutout)
  // Distance between centers = rCutout + rCorner
  // Horizontal distance from center to fillet center:
  const dX = Math.sqrt(Math.pow(rCutout + rCorner, 2) - Math.pow(rCorner, 2)); 
  
  // The start of the curve (on y=0)
  const xStart = center - dX;
  const xEnd = center + dX;

  // The contact point between fillet and cutout
  // Vector from CutoutCenter(center, 0) to FilletCenter(center-dX, rCorner) is (-dX, rCorner)
  // Point P is at CutoutCenter + rCutout * (Vector / Length)
  // Length is rCutout + rCorner
  const vecLength = rCutout + rCorner;
  const pX = center + rCutout * (-dX / vecLength);
  const pY = rCutout * (rCorner / vecLength);

  // SVG Path
  const d = `
    M0,0 
    L${xStart},0 
    A${rCorner},${rCorner} 0 0 1 ${pX},${pY}
    A${rCutout},${rCutout} 0 0 0 ${center + (center - pX)},${pY}
    A${rCorner},${rCorner} 0 0 1 ${xEnd},0
    L${width},0 
    L${width},${height} 
    L0,${height} 
    Z
  `;

  return (
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, width: width, height: height }}>
      <Svg width={width} height={height}>
        <Path d={d} fill="#ffffff" />
      </Svg>
    </View>
  );
};

const _layout = () => {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // Base height for the tab background + safe area bottom inset
  // Lower overall tab bar height to match desired look
  // Slightly increase height for label stability while remaining compact
  const tabBgHeight = useMemo(() => 55 + (insets?.bottom ?? 0), [insets]);

  return (
    <Tabs
      screenOptions={{
        tabBarShowLabel: false,
        tabBarBackground: () => (width > 0 ? <TabBarBackground width={width} height={tabBgHeight} /> : null),
        tabBarStyle: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: "transparent", // Transparent to show SVG
          height: tabBgHeight, // Match SVG height + safe area
          elevation: 0, // Remove default shadow
          borderTopWidth: 0,
        },
          tabBarItemStyle: {
          justifyContent: "center",
          alignItems: "center",
          paddingTop: 4,
          // Keep a consistent touch target without shifting layout
          height: 60,
        },
        tabBarActiveTintColor: COLORS.darkblue,
        tabBarInactiveTintColor: COLORS.black,
      }}
    >
      {/* Reusable animated icon + label renderer */}
      {/**
       * When a tab is focused:
       * - Icon scales slightly down (from 1 to 0.9)
       * - Label fades in and slides up into place
       * Labels are hidden by default when not focused.
       */}
      
      
      <Tabs.Screen
        name="Home"
        options={{
          title: "Homepage",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => {
            const scale = useRef(new Animated.Value(1)).current;
            const labelOpacity = useRef(new Animated.Value(0)).current;
            const labelTranslateY = useRef(new Animated.Value(6)).current;
            const backgroundOpacity = useRef(new Animated.Value(0)).current;

            useEffect(() => {
              Animated.spring(scale, {
                toValue: focused ? 0.9 : 1,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();

              Animated.parallel([
                Animated.timing(labelOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 160,
                  useNativeDriver: true,
                }),
                Animated.spring(labelTranslateY, {
                  toValue: focused ? 0 : 6,
                  useNativeDriver: true,
                  bounciness: 6,
                  speed: 12,
                }),
                Animated.timing(backgroundOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 200,
                  useNativeDriver: true,
                }),
              ]).start();
            }, [focused]);

            return (
              <View style={{ alignItems: 'center', justifyContent: 'center', height: 48, width: '100%' }}>
                <Animated.View style={{
                  position: 'absolute',
                  width: 54,
                  height: 54,
                  borderRadius: 15,
                  backgroundColor: COLORS.lightgrey,
                  opacity: backgroundOpacity,
                  top: 2,
                }} />
                <Animated.Image
                  source={ICONS.home}
                  style={{
                    width: 28,
                    height: 28,
                    tintColor: focused ? COLORS.darkblue : COLORS.black,
                    transform: [{ scale }],
                    marginBottom: 2,
                  }}
                />
                <Animated.Text
                  style={{
                    opacity: labelOpacity,
                    transform: [{ translateY: labelTranslateY }],
                    color: COLORS.darkblue,
                    fontSize: 11,
                    position: 'absolute',
                    bottom: -4,
                    width: '200%',
                    textAlign: 'center',
                    left: '-50%',
                  }}
                  numberOfLines={1}
                >Home</Animated.Text>
              </View>
            );
          },
        }}
      />
      <Tabs.Screen
        name="Activity"
        options={{
          title: "Activities",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => {
            const scale = useRef(new Animated.Value(1)).current;
            const labelOpacity = useRef(new Animated.Value(0)).current;
            const labelTranslateY = useRef(new Animated.Value(6)).current;
            const backgroundOpacity = useRef(new Animated.Value(0)).current;

            useEffect(() => {
              Animated.spring(scale, {
                toValue: focused ? 0.9 : 1,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();

              Animated.parallel([
                Animated.timing(labelOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 160,
                  useNativeDriver: true,
                }),
                Animated.spring(labelTranslateY, {
                  toValue: focused ? 0 : 6,
                  useNativeDriver: true,
                  bounciness: 6,
                  speed: 12,
                }),
                Animated.timing(backgroundOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 200,
                  useNativeDriver: true,
                }),
              ]).start();
            }, [focused]);

            return (
              <View style={{ alignItems: 'center', justifyContent: 'center', height: 48, width: '100%' }}>
                <Animated.View style={{
                  position: 'absolute',
                  width: 54,
                  height: 54,
                  borderRadius: 15,
                  backgroundColor: COLORS.lightgrey,
                  opacity: backgroundOpacity,
                  top: 2,
                  transform: [{ translateX: -8 }],
                }} />
                <Animated.Image
                  source={ICONS.activity}
                  style={{
                    width: 28,
                    height: 28,
                    tintColor: focused ? COLORS.darkblue : COLORS.black,
                    transform: [{ scale }],
                    marginBottom: 2,
                    right: 8,
                  }}
                />
                <Animated.Text
                  style={{
                    opacity: labelOpacity,
                    transform: [{ translateX: -8 }, { translateY: labelTranslateY }],
                    color: COLORS.darkblue,
                    fontSize: 11,
                    position: 'absolute',
                    bottom: -4,
                    width: '200%',
                    textAlign: 'center',
                    left: '-50%',
                  }}
                  numberOfLines={1}
                >Activity</Animated.Text>
              </View>
            );
          },
        }}
      />
      <Tabs.Screen
        name="Map"
        options={{
          title: "Map",
          headerShown: false,
          tabBarLabel: () => null,
          tabBarButton: (props: any) => {
            const scale = useRef(new Animated.Value(1)).current;

            const handlePressIn = () => {
              Animated.spring(scale, {
                toValue: 1.08,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();
            };

            const handlePressOut = () => {
              Animated.spring(scale, {
                toValue: 1,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();
            };

            return (
              <Pressable
                {...props}
                android_ripple={undefined}
                style={{
                  top: -32,
                  justifyContent: "center",
                  alignItems: "center",
                }}
                onLongPress={props.onLongPress}
                onPress={props.onPress}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
             >
                <Animated.View
                  style={{
                    transform: [{ scale }],
                    width: 76,
                    height: 76,
                    borderRadius: 38,
                    backgroundColor: "#32CD32",
                    justifyContent: "center",
                    alignItems: "center",
                    overflow: 'hidden',
                    ...styles.shadow,
                  }}
                >
                  <Image
                    source={ICONS.map}
                    style={{
                      width: 30,
                      height: 30,
                    }}
                  />
                </Animated.View>
              </Pressable>
            );
          },
        }}
      />
      <Tabs.Screen
        name="Notification"
        options={{
          title: "Notification",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => {
            const scale = useRef(new Animated.Value(1)).current;
            const labelOpacity = useRef(new Animated.Value(0)).current;
            const labelTranslateY = useRef(new Animated.Value(6)).current;
            const backgroundOpacity = useRef(new Animated.Value(0)).current;

            useEffect(() => {
              Animated.spring(scale, {
                toValue: focused ? 0.9 : 1,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();

              Animated.parallel([
                Animated.timing(labelOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 160,
                  useNativeDriver: true,
                }),
                Animated.spring(labelTranslateY, {
                  toValue: focused ? 0 : 6,
                  useNativeDriver: true,
                  bounciness: 6,
                  speed: 12,
                }),
                Animated.timing(backgroundOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 200,
                  useNativeDriver: true,
                }),
              ]).start();
            }, [focused]);

            return (
              <View style={{ alignItems: 'center', justifyContent: 'center', height: 48, width: '100%' }}>
                <Animated.View style={{
                  position: 'absolute',
                  width: 54,
                  height: 54,
                  borderRadius: 15,
                  backgroundColor: COLORS.lightgrey,
                  opacity: backgroundOpacity,
                  top: 2,
                  transform: [{ translateX: 8 }],
                }} />
                <Animated.Image
                  source={ICONS.notifications}
                  style={{
                    width: 28,
                    height: 28,
                    tintColor: focused ? COLORS.darkblue : COLORS.black,
                    transform: [{ scale }],
                    marginBottom: 2,
                    left: 8,
                  }}
                />
                <Animated.Text
                  style={{
                    opacity: labelOpacity,
                    transform: [{ translateX: 8 }, { translateY: labelTranslateY }],
                    color: COLORS.darkblue,
                    fontSize: 11,
                    position: 'absolute',
                    bottom: -4,
                    width: '200%',
                    textAlign: 'center',
                    left: '-50%',
                  }}
                  numberOfLines={1}
                >Alerts</Animated.Text>
              </View>
            );
          },
        }}
      />
      <Tabs.Screen
        name="Settings"
        options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => {
            const scale = useRef(new Animated.Value(1)).current;
            const labelOpacity = useRef(new Animated.Value(0)).current;
            const labelTranslateY = useRef(new Animated.Value(6)).current;
            const backgroundOpacity = useRef(new Animated.Value(0)).current;

            useEffect(() => {
              Animated.spring(scale, {
                toValue: focused ? 0.9 : 1,
                useNativeDriver: true,
                bounciness: 8,
                speed: 12,
              }).start();

              Animated.parallel([
                Animated.timing(labelOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 160,
                  useNativeDriver: true,
                }),
                Animated.spring(labelTranslateY, {
                  toValue: focused ? 0 : 6,
                  useNativeDriver: true,
                  bounciness: 6,
                  speed: 12,
                }),
                Animated.timing(backgroundOpacity, {
                  toValue: focused ? 1 : 0,
                  duration: 200,
                  useNativeDriver: true,
                }),
              ]).start();
            }, [focused]);

            return (
              <View style={{ alignItems: 'center', justifyContent: 'center', height: 48, width: '100%' }}>
                <Animated.View style={{
                  position: 'absolute',
                  width: 54,
                  height: 54,
                  borderRadius: 15,
                  backgroundColor: COLORS.lightgrey,
                  opacity: backgroundOpacity,
                  top: 2,
                }} />
                <Animated.Image
                  source={ICONS.settings}
                  style={{
                    width: 28,
                    height: 28,
                    tintColor: focused ? COLORS.darkblue : COLORS.black,
                    transform: [{ scale }],
                    marginBottom: 2,
                  }}
                />
                <Animated.Text
                  style={{
                    opacity: labelOpacity,
                    transform: [{ translateY: labelTranslateY }],
                    color: COLORS.darkblue,
                    fontSize: 11,
                    position: 'absolute',
                    bottom: -4,
                    width: '200%',
                    textAlign: 'center',
                    left: '-50%',
                  }}
                  numberOfLines={1}
                >Settings</Animated.Text>
              </View>
            );
          },
        }}
      />
    </Tabs>
  );
};

const styles = StyleSheet.create({
  shadow: {
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
    elevation: 8,
  },
});

export default _layout;