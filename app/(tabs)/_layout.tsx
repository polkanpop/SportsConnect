import { COLORS } from '@/constants/colors';
import { ICONS } from '@/constants/icons';
import { IMAGES } from '@/constants/images';
import { Tabs } from 'expo-router';
import React from 'react';
import { Image, ImageBackground } from 'react-native';
import '../global.css'

const _layout = () => {
  return (
    <Tabs
      screenOptions={{
        tabBarShowLabel: true,
        tabBarStyle: {
          backgroundColor: '#f3f3f3',
        },
        tabBarItemStyle: {
          justifyContent: 'center',
          alignItems: 'center',
        },
        tabBarActiveTintColor: COLORS.darkblue, // word color when at the position
        tabBarInactiveTintColor: COLORS.black, // word color
      }}
    >
      <Tabs.Screen
        name="Home"
        options={{
          title: 'Homepage',
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => ( // Explicitly type 'focused'
            <ImageBackground
              source={focused ? IMAGES.square : null} // display the focus mode with cyan frame
              className={`flex flex-row w-full flex-1 min-w-[60px] min-h-[60px] mt-2 justify-center items-center overflow-hidden ${
                focused ? '#d3d3d3 ' : ''
              }`}
            >
              <Image
                source={ICONS.home}
                tintColor={focused ? COLORS.white : COLORS.black}
                className="size-5"
              />
            </ImageBackground>
          ),
        }}
      />
      <Tabs.Screen
        name="Activity"
        options={{
          title: 'Activities',
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => ( // Explicitly type 'focused'
            <ImageBackground
              source={focused ? IMAGES.square : null}
              className={`flex flex-row w-full flex-1 min-w-[60px] min-h-[60px] mt-2 justify-center items-center overflow-hidden ${
                focused ? '#d3d3d3' : ''
              }`}
            >
              <Image
                source={ICONS.activity}
                tintColor={focused ? COLORS.white : COLORS.black}
                className="size-6"
              />
            </ImageBackground>
          ),
        }}
      />
      <Tabs.Screen
        name="Map"
        options={{
          title: 'Map',
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => ( // Explicitly type 'focused'
            <ImageBackground
              source={IMAGES.mapButton}
              className={`flex flex-row w-full flex-1 min-w-[75px] min-h-[75px] mb-14 justify-center items-center border-1 rounded-full`}
            >
              <Image
                source={ICONS.map}
                tintColor={focused ? COLORS.white : COLORS.black}
                className="size-10"
              />
            </ImageBackground>
          ),
        }}
      />
      <Tabs.Screen
        name="Notification"
        options={{
          title: 'Notification',
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => ( // Explicitly type 'focused'
            <ImageBackground
              source={focused ? IMAGES.square : null}
              className={`flex flex-row w-full flex-1 min-w-[60px] min-h-[60px] mt-2 justify-center items-center overflow-hidden ${
                focused ? '#d3d3d3' : ''
              }`}
            >
              <Image
                source={ICONS.notifications}
                tintColor={focused ? COLORS.white : COLORS.black}
                className="size-7"
              />
            </ImageBackground>
          ),
        }}
      />
      <Tabs.Screen
        name="Settings"
        options={{
          title: 'Settings',
          headerShown: false,
          tabBarIcon: ({ focused }: { focused: boolean }) => ( // Explicitly type 'focused'
            <ImageBackground
              source={focused ? IMAGES.square : null}
              className={`flex flex-row w-full flex-1 min-w-[60px] min-h-[60px] mt-2 justify-center items-center overflow-hidden ${
                focused ? '#d3d3d3' : ''
              }`}
            >
              <Image
                source={ICONS.settings}
                tintColor={focused ? COLORS.white : COLORS.black}
                className="size-6"
              />
            </ImageBackground>
          ),
        }}
      />
    </Tabs>
  );
};

export default _layout;