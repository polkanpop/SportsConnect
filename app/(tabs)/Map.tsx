  import { SearchBar } from "@/components/SearchBar";
import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
import { markers } from "@/constants/marker"; // Static data for markers
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import * as Location from "expo-location";
import debounce from "lodash.debounce";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Keyboard,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";




  // TypeScript type for a marker
  type MarkerType = {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
    name: string;
    address: string;
    images: string[];
  };

  // Initial map region
  const INITIAL_REGION = {
    latitude: 14.0583, // Vietnam center
    longitude: 108.2772,
    latitudeDelta: 10,
    longitudeDelta: 10,
  };

  export default function App() {
    const mapRef = useRef<MapView | null>(null); // Ref to the map
    const bottomSheetRef = useRef<BottomSheet>(null);// Ref to BottomSheet

    const [searchQuery, setSearchQuery] = useState(""); // State for search query
    const [filteredMarkers, setFilteredMarkers] = useState(markers); // State for filtered markers
    const [selectedMarker, setSelectedMarker] = useState<MarkerType | null>(null); // State to store selected marker
    const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null); // State to store user location
    const [isFlatListVisible, setFlatListVisible] = useState(false); // To show/hide the FlatList
    const [bottomSheetIndex, setBottomSheetIndex] = useState<number>(-1); // Track BottomSheet index
    
    // Snap points for the BottomSheet
    const snapPoints = useMemo(() => ["20%", "40%", "80%"], []);

    // Request location permissions and fetch user location
const hasCenteredRef = useRef(false);

useEffect(() => {
  (async () => {
    if (hasCenteredRef.current) return;
    hasCenteredRef.current = true;

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        console.log("Permission denied");
        return;
      }

      const location = await Location.getCurrentPositionAsync({});
      setUserLocation(location);

      if (mapRef.current && location) {
        mapRef.current.animateCamera(
          {
            center: {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
            },
            zoom: 15,
          },
          { duration: 1000 }
        );
      }
    } catch (e) {
      console.log("Location error:", e);
    }
  })();
}, []);



    // Center map on user’s current location when pressing the “My Location” button
    const handleMyLocationPress = async () => {
      if (!userLocation) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          console.log("Permission denied");
          return;
        }

        // Fetch location if not already available
        const location = await Location.getCurrentPositionAsync({});
        setUserLocation(location);

        // Animate camera to the user's current location
        mapRef.current?.animateCamera(
          {
            center: {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
            },
            zoom: 15,
          },
          { duration: 1000 }
        );
      } else {
        // Animate to existing user location
        mapRef.current?.animateCamera(
          {
            center: {
              latitude: userLocation.coords.latitude,
              longitude: userLocation.coords.longitude,
            },
            zoom: 15,
          },
          { duration: 1000 }
        );
      }
    };

    // Open Google Maps for selected marker
    const handleGoogleMapPress = () => {
      if (selectedMarker) {
        const { latitude, longitude } = selectedMarker;
        const url = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        Linking.openURL(url);
      } else if (userLocation) {
        const { latitude, longitude } = userLocation.coords;
        const url = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        Linking.openURL(url);
      } else {
        console.log("No location selected or user location found");
      }
    };


     
    // Handle marker when pressed
    const handleMarkerPress = (marker: MarkerType) => {
      if (selectedMarker?.name === marker.name) { //bottom sheet of the selected marker
        bottomSheetRef.current?.snapToIndex(0);
        return;
      }
      setSelectedMarker(marker);
      mapRef.current?.animateCamera( //animation
        {
          center: { latitude: marker.latitude, longitude: marker.longitude },
          zoom: 15,
        },
        { duration: 500 }
      );
    };

  

    // Handle search input change with debounce
    const handleSearchChange = useCallback(
      debounce((text: string) => {
        setSearchQuery(text);

        // Filter markers based on search query
        const filtered = markers.filter(
          (marker) =>
            marker.name.toLowerCase().includes(text.toLowerCase()) ||
            marker.address.toLowerCase().includes(text.toLowerCase())
        );

        setFilteredMarkers(filtered);
        setFlatListVisible(text.length > 0); // Show FlatList only when there is a query
      }, 300),
      []
    );

    // Called whenever search text changes
    const onSearchTextChange = (text: string) => {
      handleSearchChange(text);
    };

    // Handle tapping a search result item
    const handleFlatListItemPress = (marker: MarkerType) => {
      setSelectedMarker(marker); // Set the selected marker
      setFlatListVisible(false); // Hide the FlatList
      mapRef.current?.animateCamera(
        { center: { latitude: marker.latitude, longitude: marker.longitude }, zoom: 15 },
        { duration: 1000 }
      );
      bottomSheetRef.current?.snapToIndex(0); // Open BottomSheet
    };

    // Update bottom sheet index on change
    const handleSheetChange = useCallback((index: number) => {
      setBottomSheetIndex(index);
    }, []);

    // Compute dynamic button visibility
    const isButtonVisible = bottomSheetIndex < 3;

    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.container}>
            {/* Search Bar */}
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={styles.searchContainer}>
                <SearchBar
                  placeholder="Search for a location..."
                  onChangeText={onSearchTextChange}
                />
              </View>
            </TouchableWithoutFeedback>

            {/* Search Results (FlatList) */}
            {isFlatListVisible && (
              <FlatList
                data={filteredMarkers}
                keyExtractor={(item, index) => index.toString()}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.listItem}
                    onPress={() => handleFlatListItemPress(item)}
                  >
                    <Text style={styles.listItemTitle}>{item.name}</Text>
                    <Text style={styles.listItemSubtitle}>{item.address}</Text>
                  </TouchableOpacity>
                )}
                style={styles.searchResults}
                keyboardShouldPersistTaps="handled"
              />
            )}

            {/* Map View */}
            <MapView
              style={styles.map}
              provider={PROVIDER_GOOGLE} //googleAPI
              initialRegion={INITIAL_REGION} //vn
              showsUserLocation={true}// our location dot
              showsMyLocationButton={false} // Disable default location button (we use our custom one)
              toolbarEnabled={false} //disable google map bttom right hyperlink
              showsCompass={false}
              ref={mapRef}
            >
              {/* Render all markers */}
              {filteredMarkers.map((marker, index) => (
                <Marker
                  key={index}
                  coordinate={{
                    latitude: marker.latitude,
                    longitude: marker.longitude,
                  }}
                  pinColor={selectedMarker?.name === marker.name ? COLORS.blue : COLORS.red} // apparently only work on IOS device
                  onPress={() => handleMarkerPress(marker)}
                />
              ))}
            </MapView>

            {/* Google Maps Button (above My Location) */}
            {isButtonVisible && (
              <TouchableOpacity
                style={styles.googleMapButton}
                onPress={handleGoogleMapPress}
              >
                <Image source={ICONS.ggmap} style={styles.googleMapIcon} />
              </TouchableOpacity>
            )}

            {/* My Location Button */}
            {isButtonVisible && (
              <TouchableOpacity
                style={styles.myLocationButton}
                onPress={handleMyLocationPress}
              >
                <Image source={ICONS.location_icon} style={styles.myLocationIcon} />
              </TouchableOpacity>
            )}

            {/* BottomSheet for marker details */}
            <BottomSheet
              ref={bottomSheetRef}
              snapPoints={snapPoints}
              index={0} // closed by default
              enablePanDownToClose={true} // Allow closing bottomsheet by swiping down
              onChange={handleSheetChange} // Listen to sheet index change
            >
              {selectedMarker ? (
                <BottomSheetScrollView contentContainerStyle={styles.bottomSheetContent}>
                  {/* Location Name */}
                  <Text style={styles.markerTitle}>{selectedMarker.name}</Text>

                  {/* Location Address */}
                  <Text style={styles.markerAddress}>Address: {selectedMarker.address}</Text>

                  {/* Images */}
                  <View style={styles.imageContainer}>
                    {selectedMarker.images.map((image, idx) => (
                      <Image key={idx} source={{ uri: image }} style={styles.markerImage} />
                    ))}
                  </View>
                </BottomSheetScrollView>
              ) : (
                <View style={styles.bottomSheetContent}>
                  <Text style={styles.placeholderText}>
                    Select a location to see details
                  </Text>
                </View>
              )}
            </BottomSheet>
          </SafeAreaView>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  // Styles
  const styles = StyleSheet.create({
    container: {
      flex: 1,
    },
    map: {
      flex: 1,
    },
    searchContainer: {
      position: "absolute",
      top: 60,
      width: "90%",
      alignSelf: "center",
      zIndex: 10, // Ensure the search bar is above the map
    },
    searchResults: {
      position: "absolute",
      top: 110,
      width: "90%",
      alignSelf: "center",
      backgroundColor: COLORS.lightgrey,
      borderRadius: 8,
      maxHeight: 205,
      zIndex: 15, // Ensure FlatList is above the map
      padding: 8,
    },
    listItem: {
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: "#ddd",
    },
    listItemTitle: {
      fontSize: 16,
      fontWeight: "bold",
    },
    listItemSubtitle: {
      fontSize: 14,
      color: "#666",
    },
    bottomSheetContent: {
      alignItems: "flex-start",
      padding: 16,
    },
    placeholderText: {
      fontSize: 16,
      color: "#888",
    },
    markerTitle: {
      fontSize: 20,
      fontWeight: "bold",
      marginBottom: 8,
      textAlign: "left",
    },
    markerAddress: {
      fontSize: 16,
      color: "#666",
      textAlign: "left",
      marginBottom: 16,
      fontWeight: 500
    },
    imageContainer: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      marginTop: 16,
    },
    markerImage: {
      width: 100,
      height: 100,
      borderRadius: 8,
      margin: 4,
    },
    // Custom floating “My Location” button
    myLocationButton: {
      position: "absolute",
      bottom: 300, //my button location
      right: 20,
      backgroundColor: COLORS.white,
      borderRadius: 50,
      padding: 12,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 5,
      zIndex: 20,
    },
    myLocationIcon: {
      width: 24,
      height: 24,
    },
    // Google Map button above it
    googleMapButton: {
      position: "absolute",
      bottom: 360, // above My Location button
      right: 20,
      backgroundColor: COLORS.white,
      borderRadius: 50,
      padding: 12,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 5,
      zIndex: 20,
    },
    googleMapIcon: {
      width: 24,
      height: 24,
    },
  });
