import { SearchBar } from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { IMAGES } from "@/constants/images";
import { useRouter } from "expo-router";
import { Image, ImageBackground, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

export default function Home() {
  const router = useRouter();

  // placeholder for our future event banner
  const eventBanners = [
    { id: 1, image: IMAGES.eventBanner }, 
    { id: 2, image: IMAGES.eventBanner },
    { id: 3, image: IMAGES.eventBanner },
  ];

  return (
    <SafeAreaProvider>
      <SafeAreaView className="flex-1 bg-light-300">

        {/* Header Section */}
        <View className="flex flex-row items-center justify-between bg-light-300 pb-3 px-2">

          {/* Search Bar */}
          <View className="flex-1">
            <SearchBar placeholder="Search for courts..." />
          </View>

          {/* Profile Icon */}
          <View className="w-12 h-12 bg-light-400 rounded-full flex items-center justify-center ml-2">
            <Image
              source={ICONS.accountCircle}
              className="w-10 h-10"
              resizeMode="contain"
            />
          </View>
        </View>

        {/* Scroll View Content */}
        <ScrollView
          className="flex-1 px-1 bg-light-400"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 10 }}
        >

          {/*-------------------------------------------------------------------------------- */}
          {/* Flexbox for Categories Sections: 3 flebox at the top  */}
          <View className="flex flex-row justify-around items-center py-4">
            <View className="w-20 h-20 bg-light-500 rounded-lg flex items-center justify-center">
              <Image
                source={ICONS.player}
                className="w-12 h-12"
                resizeMode="contain"
              />
              <Text className="font-semibold text-sm">Player</Text>
            </View>
            <View className="w-20 h-20 bg-light-200 rounded-lg flex items-center justify-center">
              <Image
                source={ICONS.coach}
                className="w-12 h-12"
                resizeMode="contain"
              />
              <Text className="font-semibold text-sm">Coaches</Text>
            </View>
            <View className="w-20 h-20 bg-light-100 rounded-lg flex items-center justify-center">
              <Image
                source={ICONS.court}
                className="w-16 h-16"
                resizeMode="contain"
              />
              <Text className="font-semibold text-sm fixed bottom-2">Court</Text>
            </View>
          </View>

          {/*-------------------------------------------------------------------------------- */}
          {/* Tag Section ( this is temporary placeholder for tag because tag required algorithms */}
          <View className="flex flex-row py-4">
            <Text className="font-semibold text-xl">Your choices</Text>
          </View>
      <View className="py-4">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 10 }}
        >
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
        <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
         <ImageBackground
          source={IMAGES.tag}
          className="w-20 h-5 rounded-lg overflow-hidden mr-8"
        />
      </ScrollView>
          </View>
          
          {/*-------------------------------------------------------------------------------- */}
          {/*Event section: fill with event banners */}
          <View className="flex flex-row py-4">
            <Text className="font-semibold text-xl">Event</Text>
          </View>

          <View className="py-4">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {eventBanners.map((event) => (
                <ImageBackground
                  key={event.id}
                  source={event.image} // for every banner then load the images and expand to the right side horizontally
                  className="w-60 h-40 rounded-lg overflow-hidden mr-6"
                />
              ))}
            </ScrollView>
          </View>

          {/*-------------------------------------------------------------------------------- */}
          {/* Recommend for you Section ( this is temporary placeholder for tag because tag required algorithms */}
      <View className="flex flex-row py-4">
        <Text className="font-semibold text-xl">Recommend for you</Text>
        </View>
          <View className="py-4">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
            <ImageBackground
              source={IMAGES.tag} // tag or eventBanner doesn't matter anyway
              className="w-60 h-40 rounded-lg overflow-hidden mr-6"
            />
            <ImageBackground
              source={IMAGES.tag}
              className="w-60 h-40 rounded-lg overflow-hidden mr-6"
            />
            <ImageBackground
              source={IMAGES.tag}
              className="w-60 h-40 rounded-lg overflow-hidden"
            />

            </ScrollView>
          </View> 
          
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}