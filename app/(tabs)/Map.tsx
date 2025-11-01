// Map.tsx
import { SearchBar } from "@/components/SearchBar";
import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
import { markers as ALL_MARKERS } from "@/constants/marker"; // static data for markers
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import * as Location from "expo-location";
import debounce from "lodash.debounce";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
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
  sport: string[] | string;
  venue: string | string[];
  availability: string;
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
  const bottomSheetRef = useRef<BottomSheet>(null); // Ref to BottomSheet

  const [searchQuery, setSearchQuery] = useState(""); // State for search query
  const [filteredMarkers, setFilteredMarkers] = useState<MarkerType[]>(ALL_MARKERS); // State for filtered markers
  const [selectedMarker, setSelectedMarker] = useState<MarkerType | null>(null); // State to store selected marker
  const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null); // State to store user location
  const [isFlatListVisible, setFlatListVisible] = useState(false); // To show/hide the FlatList
  const [bottomSheetIndex, setBottomSheetIndex] = useState<number>(-1); // Track BottomSheet index

  // Filter states
  const [openDropdown, setOpenDropdown] = useState<"sport" | "venue" | "availability" | null>(null);
  const [selectedSports, setSelectedSports] = useState<string[]>([]); // multi-select
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null); // single-select
  const [selectedAvailability, setSelectedAvailability] = useState<string | null>(null); // single-select

  // Snap points for the BottomSheet
  const snapPoints = useMemo(() => ["22%", "40%", "80%"], []);

  // derive sport options from markers (unique)
  const sportOptions = useMemo(() => {
    const set = new Set<string>();
    ALL_MARKERS.forEach((m) => {
      const s = m.sport;
      if (Array.isArray(s)) {
        s.forEach((x) => set.add(x));
      } else if (s) {
        set.add(s as string);
      }
    });
    return Array.from(set);
  }, []);

  const venueOptions = useMemo(() => {
    // standardize to strings Indoor/Outdoor
    const set = new Set<string>();
    ALL_MARKERS.forEach((m) => {
      const v = m.venue;
      if (Array.isArray(v)) {
        v.forEach((x) => set.add(String(x)));
      } else if (v) {
        set.add(String(v));
      }
    });
    return Array.from(set);
  }, []);

  const availabilityOptions = ["Available", "Unavailable"];

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
    if (selectedMarker?.name === marker.name) {
      bottomSheetRef.current?.snapToIndex(0);
      return;
    }
    setSelectedMarker(marker);
    mapRef.current?.animateCamera(
      {
        center: { latitude: marker.latitude, longitude: marker.longitude },
        zoom: 15,
      },
      { duration: 500 }
    );
    // open bottom sheet
    bottomSheetRef.current?.snapToIndex(0);
  };

  // Handle search input change with debounce
  const handleSearchChange = useCallback(
    debounce((text: string) => {
      setSearchQuery(text);

      // Filter markers based on search query (initial search filtering)
      const filtered = ALL_MARKERS.filter(
        (marker) =>
          marker.name.toLowerCase().includes(text.toLowerCase()) ||
          marker.address.toLowerCase().includes(text.toLowerCase())
      );

      setFilteredMarkers(filtered);
      setFlatListVisible(text.length > 0);
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

  // Utility to get sport icon (fallback to sport_category)
  const getSportIcon = (sport: string) => {
    const key = sport.toLowerCase().replace(/\s+/g, "_"); // football, table_tennis -> maybe undefined
    // Try exact key, then lowercase without spaces
    if ((ICONS as any)[key]) return (ICONS as any)[key];
    if ((ICONS as any)[sport.toLowerCase()]) return (ICONS as any)[sport.toLowerCase()];
    return ICONS.sportCategory;
  };

  // Toggle sport in multi-select
  const toggleSport = (sport: string) => {
    setSelectedSports((prev) => {
      if (prev.includes(sport)) {
        return prev.filter((s) => s !== sport);
      }
      return [...prev, sport];
    });
  };

  // Select one venue
  const chooseVenue = (venue: string) => {
    setSelectedVenue((prev) => (prev === venue ? null : venue));
  };

  // Select one availability
  const chooseAvailability = (avail: string) => {
    setSelectedAvailability((prev) => (prev === avail ? null : avail));
  };

  // Apply filters to marker list whenever filters change
  useEffect(() => {
    let results: MarkerType[] = ALL_MARKERS;

    // Filter by search query first (if any)
    if (searchQuery && searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase();
      results = results.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.address.toLowerCase().includes(q)
      );
    }

    // Filter by sports (multi)
    if (selectedSports.length > 0) {
      results = results.filter((m) => {
        const mSports = Array.isArray(m.sport) ? m.sport : [m.sport];
        // check if any selectedSports exists in mSports
        return selectedSports.some((s) =>
          mSports.map((x) => x.toLowerCase()).includes(s.toLowerCase())
        );
      });
    }

    // Filter by venue (single)
    if (selectedVenue) {
      results = results.filter((m) => {
        const mVenue = Array.isArray(m.venue) ? m.venue : [m.venue];
        return mVenue.map((x) => String(x).toLowerCase()).includes(selectedVenue.toLowerCase());
      });
    }

    // Filter by availability (single)
    if (selectedAvailability) {
      results = results.filter((m) => {
        return String(m.availability).toLowerCase() === selectedAvailability.toLowerCase();
      });
    }

    setFilteredMarkers(results);
  }, [selectedSports, selectedVenue, selectedAvailability, searchQuery]);

  // Dismiss dropdowns when tapping outside - we'll render a full-screen overlay when a dropdown is open
  const handleOverlayPress = () => {
    setOpenDropdown(null);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.container}>
          {/* Dismiss keyboard on tapping outside */}
          <TouchableWithoutFeedback onPress={() => { Keyboard.dismiss(); setOpenDropdown(null); }}>
            <View style={{ flex: 1 }}>
              {/* Search Bar */}
              <View style={styles.searchContainer}>
                <SearchBar
                  placeholder="Search for a location..."
                  onChangeText={onSearchTextChange}
                />
              </View>

              {/* === FILTER BAR (REPLACED) ===
                   Now horizontally scrollable and expands to content
              */}
              <View style={styles.filterBarWrapper}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterBarScroll}
                >
                  {/* Sport */}
                  <TouchableOpacity
                    style={styles.filterChip}
                    activeOpacity={0.8}
                    onPress={() => setOpenDropdown((prev) => (prev === "sport" ? null : "sport"))}
                  >
                    <View style={styles.filterChipLeft}>
                      <Image source={ICONS.sportCategory} style={styles.filterIcon} />
                      <Text style={styles.filterChipText}>
                        Sport{selectedSports.length > 0 ? ` (${selectedSports.length})` : ""}
                      </Text>
                    </View>
                    <Image
                      source={ICONS.arrowdown}
                      style={[
                        styles.filterArrow,
                        openDropdown === "sport" ? styles.arrowOpen : null,
                      ]}
                    />
                  </TouchableOpacity>

                  {/* Venue */}
                  <TouchableOpacity
                    style={styles.filterChip}
                    activeOpacity={0.8}
                    onPress={() => setOpenDropdown((prev) => (prev === "venue" ? null : "venue"))}
                  >
                    <View style={styles.filterChipLeft}>
                      <Image source={ICONS.venueCategory} style={styles.filterIcon} />
                      <Text style={styles.filterChipText}>
                        Venue{selectedVenue ? `: ${selectedVenue}` : ""}
                      </Text>
                    </View>
                    <Image
                      source={ICONS.arrowdown}
                      style={[
                        styles.filterArrow,
                        openDropdown === "venue" ? styles.arrowOpen : null,
                      ]}
                    />
                  </TouchableOpacity>

                  {/* Availability */}
                  <TouchableOpacity
                    style={styles.filterChip}
                    activeOpacity={0.8}
                    onPress={() =>
                      setOpenDropdown((prev) => (prev === "availability" ? null : "availability"))
                    }
                  >
                    <View style={styles.filterChipLeft}>
                      <Image source={ICONS.availCategory} style={styles.filterIcon} />
                      <Text style={styles.filterChipText}>
                        {selectedAvailability ? selectedAvailability : "Status"}
                      </Text>
                    </View>
                    <Image
                      source={ICONS.arrowdown}
                      style={[
                        styles.filterArrow,
                        openDropdown === "availability" ? styles.arrowOpen : null,
                      ]}
                    />
                  </TouchableOpacity>
                </ScrollView>
              </View>

              {/* Dropdown lists */}
              {openDropdown && (
                <>
                  {/* Transparent overlay to capture outside taps */}
                  <Pressable style={styles.overlay} onPress={handleOverlayPress} />

                  <View style={styles.dropdownContainer}>
                    {openDropdown === "sport" && (
                      <View style={styles.dropdown}>
                        <FlatList
                          data={sportOptions}
                          keyExtractor={(item) => item}
                          renderItem={({ item }) => {
                            const selected = selectedSports.includes(item);
                            return (
                              <TouchableOpacity
                                style={styles.dropdownItem}
                                onPress={() => toggleSport(item)}
                              >
                                <View style={styles.dropdownItemLeft}>
                                  <Image source={getSportIcon(item) as any} style={styles.optionIcon} />
                                  <Text style={styles.dropdownItemText}>{item}</Text>
                                </View>
                                <Image
                                  source={selected ? ICONS.tick : ""}
                                  style={styles.optionCheck}
                                />
                              </TouchableOpacity>
                            );
                          }}
                          ItemSeparatorComponent={() => <View style={styles.sep} />}
                          style={{ maxHeight: 220 }}
                        />
                        <View style={styles.dropdownFooter}>
                          <TouchableOpacity
                            onPress={() => {
                              setSelectedSports([]);
                            }}
                            style={styles.clearButton}
                          >
                            <Text style={styles.clearText}>Clear All</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}

                    {openDropdown === "venue" && (
                      <View style={styles.dropdown}>
                        <FlatList
                          data={venueOptions}
                          keyExtractor={(item) => item}
                          renderItem={({ item }) => {
                            const selected = selectedVenue === item;
                            const leftIcon = item.toLowerCase().includes("indoor")
                              ? ICONS.indoor
                              : ICONS.outdoor;
                            return (
                              <TouchableOpacity
                                style={styles.dropdownItem}
                                onPress={() => {
                                  chooseVenue(item);
                                  setOpenDropdown(null);
                                }}
                              >
                                <View style={styles.dropdownItemLeft}>
                                  <Image source={leftIcon as any} style={styles.optionIcon} />
                                  <Text style={styles.dropdownItemText}>{item}</Text>
                                </View>
                                <Image
                                  source={selected ? ICONS.tick : ""}
                                  style={styles.optionCheck}
                                />
                              </TouchableOpacity>
                            );
                          }}
                          ItemSeparatorComponent={() => <View style={styles.sep} />}
                        />
                      </View>
                    )}

                    {openDropdown === "availability" && (
                      <View style={styles.dropdown}>
                        <FlatList
                          data={availabilityOptions}
                          keyExtractor={(item) => item}
                          renderItem={({ item }) => {
                            const selected = selectedAvailability === item;
                            return (
                              <TouchableOpacity
                                style={styles.dropdownItem}
                                onPress={() => {
                                  chooseAvailability(item);
                                  setOpenDropdown(null);
                                }}
                              >
                                <View style={styles.dropdownItemLeft}>
                                  <Image
                                    source={item === "Available" ? ICONS.check : ICONS.x}
                                    style={styles.optionIcon}
                                  />
                                  <Text style={styles.dropdownItemText}>{item}</Text>
                                </View>
                                <Image
                                  source={selected ? ICONS.tick : ""}
                                  style={styles.optionCheck}
                                />
                              </TouchableOpacity>
                            );
                          }}
                          ItemSeparatorComponent={() => <View style={styles.sep} />}
                        />
                      </View>
                    )}
                  </View>
                </>
              )}

              {/* Search Results (FlatList) */}
              {isFlatListVisible && (
                <FlatList
                  data={filteredMarkers}
                  keyExtractor={(item, index) => index.toString()}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={styles.listItem}
                      onPress={() => handleFlatListItemPress(item as MarkerType)}
                    >
                      <Text style={styles.listItemTitle}>{(item as MarkerType).name}</Text>
                      <Text style={styles.listItemSubtitle}>{(item as MarkerType).address}</Text>
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
                showsUserLocation={true} // our location dot
                showsMyLocationButton={false} // Disable default location button (we use our custom one)
                toolbarEnabled={false} //disable google map bottom right hyperlink
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
                <TouchableOpacity style={styles.googleMapButton} onPress={handleGoogleMapPress}>
                  <Image source={ICONS.ggmap} style={styles.googleMapIcon} />
                </TouchableOpacity>
              )}

              {/* My Location Button */}
              {isButtonVisible && (
                <TouchableOpacity style={styles.myLocationButton} onPress={handleMyLocationPress}>
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
                    <Text style={styles.placeholderText}>Select a location to see details</Text>
                  </View>
                )}
              </BottomSheet>
            </View>
          </TouchableWithoutFeedback>
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

  // Search container (unchanged)
  searchContainer: {
    position: "absolute",
    top: 60,
    width: "90%",
    alignSelf: "center",
    zIndex: 50, // Ensure the search bar is above the map
  },

  // === FILTER BAR: wrapper + scroll ===
  filterBarWrapper: {
    position: "absolute",
    top: 115,
    width: "100%",
    zIndex: 50,
  },
  filterBarScroll: {
    paddingLeft: 16,
    paddingRight: 12,
    alignItems: "center",
    // gap is not supported on RN <0.70; we preserve spacing with margin on chips
  },

  // Individual chip (no flex:1 so it sizes to content)
  filterChip: {
    backgroundColor: COLORS.white,
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    marginRight: 8, // spacing between chips
  },
  filterChipLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  filterIcon: {
    width: 18,
    height: 18,
    marginRight: 8,
    resizeMode: "contain",
  },
  filterChipText: {
    fontSize: 14,
    fontWeight: "600",
  },
  filterArrow: {
    width: 14,
    height: 14,
    resizeMode: "contain",
    transform: [{ rotate: "0deg" }],
    marginLeft: 8,
  },
  arrowOpen: {
    transform: [{ rotate: "180deg" }],
  },

  // overlay covers full screen when dropdown open
  overlay: {
    position: "absolute",
    top: 160, // just below filter bar
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
  },
  dropdownContainer: {
    position: "absolute",
    top: 160,
    width: "92%",
    alignSelf: "center",
    zIndex: 60,
  },
  dropdown: {
    backgroundColor: COLORS.white,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    maxHeight: 260,
  },
  dropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  dropdownItemLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  optionIcon: {
    width: 26,
    height: 26,
    marginRight: 12,
    resizeMode: "contain",
  },
  dropdownItemText: {
    fontSize: 15,
  },
  optionCheck: {
    width: 20,
    height: 20,
    resizeMode: "contain",
  },
  sep: {
    height: 1,
    backgroundColor: "#eee",
    marginHorizontal: 6,
  },
  dropdownFooter: {
    paddingVertical: 8,
    alignItems: "flex-end",
    paddingRight: 12,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  clearText: {
    color: COLORS.blue,
    fontWeight: "600",
  },

  searchResults: {
    position: "absolute",
    top: 160,
    width: "90%",
    alignSelf: "center",
    backgroundColor: COLORS.lightgrey,
    borderRadius: 8,
    maxHeight: 205,
    zIndex: 45, // ensure FlatList is above the map but below dropdown
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
