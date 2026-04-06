import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
import { Tabs } from "expo-router";
import React, { useEffect, useMemo, useRef } from "react";
import { Image, View, Pressable, StyleSheet, useWindowDimensions, Animated } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "@/hooks/use-theme-colors";

const AnimatedTabIcon = ({
  focused,
  icon,
  xOffset = 0,
  activeTintColor = COLORS.brandOrangeDeep,
  inactiveTintColor = COLORS.black,
}: {
  focused: boolean;
  icon: any;
  xOffset?: number;
  activeTintColor?: string;
  inactiveTintColor?: string;
}) => {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: focused ? 0.9 : 1,
      useNativeDriver: true,
      bounciness: 8,
      speed: 12,
    }).start();
  }, [focused, scale]);

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: 48, width: '100%' }}>
      <Animated.Image
        source={icon}
        style={{
          width: 26,
          height: 26,
          tintColor: focused ? activeTintColor : inactiveTintColor,
          transform: [{ translateX: xOffset }, { translateY: 3 }, { scale }],
        }}
      />
    </View>
  );
};

const MapTabButton = (props: any) => {
  const scale = useRef(new Animated.Value(1)).current;
  const tc = useThemeColors();

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
          backgroundColor: tc.brand,
          justifyContent: "center",
          alignItems: "center",
          overflow: 'hidden',
          ...styles.shadow,
        }}
      >
        <Image
          source={ICONS.map}
          style={{
            width: 34,
            height: 34,
            tintColor: COLORS.neutral0,
          }}
        />
      </Animated.View>
    </Pressable>
  );
};
const TabBarBackground = ({ width, height, fill }: { width: number; height: number; fill?: string }) => {
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
        <Path d={d} fill={fill ?? COLORS.white} />
      </Svg>
    </View>
  );
};

const TabLayout = () => {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tc = useThemeColors();

  // Base height for the tab background + safe area bottom inset
  const tabBgHeight = useMemo(() => 55 + (insets?.bottom ?? 0), [insets]);

  return (
    <Tabs
      screenOptions={{
        lazy: true,
        freezeOnBlur: true,
        tabBarShowLabel: false,
        tabBarBackground: () => (width > 0 ? <TabBarBackground width={width} height={tabBgHeight} fill={tc.tabBg} /> : null),
        tabBarStyle: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: "transparent",
          height: tabBgHeight,
          elevation: 0,
          borderTopWidth: 0,
        },
          tabBarItemStyle: {
          justifyContent: "center",
          alignItems: "center",
          paddingTop: 8,
          height: 60,
        },
        tabBarActiveTintColor: tc.tabActive,
        tabBarInactiveTintColor: tc.tabInactive,
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
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <AnimatedTabIcon
              focused={focused}
              icon={ICONS.home}
              activeTintColor={tc.tabActive}
              inactiveTintColor={tc.tabInactive}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="Activity"
        options={{
          title: "Activities",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <AnimatedTabIcon focused={focused} icon={ICONS.activity} xOffset={-8} activeTintColor={tc.tabActive} inactiveTintColor={tc.tabInactive} />
          ),
        }}
      />
      <Tabs.Screen
        name="Map"
        options={{
          title: "Map",
          headerShown: false,
          tabBarLabel: () => null,
          tabBarButton: (props: any) => <MapTabButton {...props} />,
        }}
      />
      <Tabs.Screen
        name="Notification"
        options={{
          title: "Notification",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <AnimatedTabIcon focused={focused} icon={ICONS.notifications} xOffset={8} activeTintColor={tc.tabActive} inactiveTintColor={tc.tabInactive} />
          ),
        }}
      />
      <Tabs.Screen
        name="Settings"
        options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => (
            <AnimatedTabIcon focused={focused} icon={ICONS.settings} activeTintColor={tc.tabActive} inactiveTintColor={tc.tabInactive} />
          ),
        }}
      />
    </Tabs>
  );
};

const styles = StyleSheet.create({
  shadow: {
    shadowColor: COLORS.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
    elevation: 8,
  },
});

export default TabLayout;