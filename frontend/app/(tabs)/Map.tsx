// Map.tsx
import { SearchBar } from "@/components/SearchBar";
import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
// Removed static markers import
import { supabase } from "@/lib/supabase";
// Backend API helpers (public)
import { listFavouriteCourts, addFavouriteCourt, removeFavouriteCourt, FavouriteCourt, listCourtInfo, CourtInfoRow } from '@/lib/backendApi';
import { useAuthContext } from '@/hooks/use-auth-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  id: number; // courtinfoid unique id
  courtid: number; // foreign key to courts (REAL court id for favourites)
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
  isFavorite?: boolean; // client-side instantaneous favorite flag
};

// Initial map region
const INITIAL_REGION = {
  latitude: 14.0583, // Vietnam center
  longitude: 108.2772,
  latitudeDelta: 10,
  longitudeDelta: 10,
};

export default function App() {
  // Favorite state for selected marker
  const [isFavorite, setIsFavorite] = useState(false);
  const mapRef = useRef<MapView | null>(null); // Ref to the map
  const bottomSheetRef = useRef<BottomSheet>(null); // Ref to BottomSheet

  const [searchQuery, setSearchQuery] = useState(""); // State for search query
  const [markers, setMarkers] = useState<MarkerType[]>([]); // fetched markers
  const [filteredMarkers, setFilteredMarkers] = useState<MarkerType[]>([]); // filtered subset
  const [loadingMarkers, setLoadingMarkers] = useState(false);
  const [errorMarkers, setErrorMarkers] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<MarkerType | null>(null); // State to store selected marker
  const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null); // State to store user location
  const [isFlatListVisible, setFlatListVisible] = useState(false); // To show/hide the FlatList
  const [bottomSheetIndex, setBottomSheetIndex] = useState<number>(-1); // Track BottomSheet index
  const [favoriteIds, setFavoriteIds] = useState<number[]>([]); // ids of favorited courts (courtinfoid assumed)
  const [favouriteRecords, setFavouriteRecords] = useState<FavouriteCourt[]>([]); // full favourite rows
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false); // toggle viewing only favorites
  // Zoom stages: 0 = fully out (baseline region), 1 = mid zoom, 2 = max zoom (shows ZoomOut icon)
  const [zoomStage, setZoomStage] = useState<number>(0);

  // Define zoom levels (tweak as desired)
  const ZOOM_LEVELS = useRef<number[]>([10, 13.5, 16]); // corresponds to camera zoom values

  // Filter states
  const [openDropdown, setOpenDropdown] = useState<"sport" | "venue" | "availability" | null>(null);
  const [selectedSports, setSelectedSports] = useState<string[]>([]); // multi-select
  const [selectedVenue, setSelectedVenue] = useState<string[]>([]); // multi-select
  const [selectedAvailability, setSelectedAvailability] = useState<string | null>(null); // single-select

  // Snap points for the BottomSheet
  const snapPoints = useMemo(() => ["24%", "40%", "80%"], []);

  // Auth context (backend login OR supabase anonymous/social)
  const { profile, session } = useAuthContext();
  const warnedMissingUserIdRef = useRef(false);

  // Unified resolver for numeric userid used by backend tables.
  // Priority:
  // 1. Backend profile from AuthContext (login via /auth/login)
  // 2. Cached @backendProfile in AsyncStorage (in case provider not yet hydrated)
  // 3. Attempt to parse supabase session user id IF it is numeric (rare; usually UUID -> will fail gracefully)
  const getCurrentNumericUserId = async (): Promise<number | null> => {
    // Backend remembered profile (preferred)
    if (profile && typeof (profile as any).userid === 'number') {
      return (profile as any).userid;
    }
    // Fallback: AsyncStorage directly
    try {
      const raw = await AsyncStorage.getItem('@backendProfile');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.userid === 'number') return parsed.userid;
      }
    } catch {}
    // Supabase session id (usually UUID -> cannot convert to numeric user table id)
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (uid && /^\d+$/.test(uid)) {
        const asInt = parseInt(uid, 10);
        if (!Number.isNaN(asInt)) return asInt;
      }
    } catch {}
    return null;
  };

  // derive sport options from markers (unique)
  const sportOptions = useMemo(() => {
    const set = new Set<string>();
    markers.forEach((m) => {
      const s = m.sport;
      if (Array.isArray(s)) s.forEach((x) => set.add(x));
      else if (s) set.add(s as string);
    });
    return Array.from(set);
  }, [markers]);

  const venueOptions = useMemo(() => {
    const set = new Set<string>();
    markers.forEach((m) => {
      const v = m.venue;
      if (Array.isArray(v)) v.forEach((x) => set.add(String(x)));
      else if (v) set.add(String(v));
    });
    return Array.from(set);
  }, [markers]);
  // Fetch markers from backend /courtinfo API (architecture shift away from direct Supabase client)
  useEffect(() => {
    const fetchMarkers = async () => {
      setLoadingMarkers(true);
      setErrorMarkers(null);
      try {
        // Fetch via backend API
        const rows: CourtInfoRow[] = await listCourtInfo();
        let normalized: MarkerType[] = rows.map((m: CourtInfoRow) => ({
          id: m.courtinfoid,
          courtid: m.courtid,
          latitude: m.latitude ?? 0,
          longitude: m.longitude ?? 0,
          latitudeDelta: m.latitudedelta ?? 0.05,
          longitudeDelta: m.longitudedelta ?? 0.05,
          name: m.name || m.address || `Court #${m.courtinfoid}`,
          address: m.address || "Unknown",
          images: Array.isArray(m.images) ? m.images : (m.images ? [m.images].flat() : []),
          sport: Array.isArray(m.sport) ? m.sport : (m.sport ? [m.sport].flat() : []),
          venue: Array.isArray(m.venue) ? m.venue : (m.venue ? [m.venue].flat() : []),
          availability: m.availability || "Available",
          isFavorite: false,
        }));
        setMarkers(normalized);
        // Fetch favourites from API if we can determine numeric user id (unchanged behaviour)
        const numericUserId = await getCurrentNumericUserId();
        let favIds: number[] = [];
        if (numericUserId !== null) {
          try {
            const rowsFav = await listFavouriteCourts({ userid: numericUserId });
            const favRows: FavouriteCourt[] = Array.isArray(rowsFav) ? (rowsFav as any[]).filter(r => typeof r === 'object' && 'courtid' in r) : [];
            setFavouriteRecords(favRows);
            favIds = favRows.map(r => r.courtid);
            setFavoriteIds(favIds);
          } catch (e) {
            console.warn('[Map] failed to load favouritecourts', e);
          }
        }
        normalized = normalized.map(m => ({ ...m, isFavorite: favIds.includes(m.courtid) }));
        setMarkers(normalized);
        setFilteredMarkers(normalized);
      } catch (e: any) {
        setErrorMarkers(e.message || String(e));
        setMarkers([]);
        setFilteredMarkers([]);
      }
      setLoadingMarkers(false);
    };
    fetchMarkers();
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
              zoom: 12,
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
          zoom: ZOOM_LEVELS.current[2],
        },
        { duration: 1000 }
      );
      setZoomStage(2);
    } else {
      // Animate to existing user location
      mapRef.current?.animateCamera(
        {
          center: {
            latitude: userLocation.coords.latitude,
            longitude: userLocation.coords.longitude,
          },
          zoom: ZOOM_LEVELS.current[2],
        },
        { duration: 1000 }
      );
      setZoomStage(2);
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
  const handleMarkerPress = async (marker: MarkerType) => {
    if (selectedMarker?.name === marker.name) {
      bottomSheetRef.current?.snapToIndex(0);
      return;
    }
    setSelectedMarker(marker);
  // Favorite state derived from favoriteIds
  setIsFavorite(favoriteIds.includes(marker.courtid));
    mapRef.current?.animateCamera(
      {
        center: { latitude: marker.latitude, longitude: marker.longitude },
        zoom: ZOOM_LEVELS.current[2],
      },
      { duration: 500 }
    );
    setZoomStage(2); // go to max zoom when selecting a marker
    // open bottom sheet
    bottomSheetRef.current?.snapToIndex(0);
  };

  // Cycle through zoom levels (0 -> 1 -> 2 -> 0) while updating icon state
  const handleZoomToggle = () => {
    if (!mapRef.current) return;
    // Determine next stage
    const nextStage = zoomStage < 2 ? zoomStage + 1 : 0; // cycle back out after max
    setZoomStage(nextStage);

    // Determine center focus priority: selected marker > user location > current camera center (fallback INITIAL_REGION)
    let centerLat = INITIAL_REGION.latitude;
    let centerLng = INITIAL_REGION.longitude;
    if (selectedMarker) {
      centerLat = selectedMarker.latitude;
      centerLng = selectedMarker.longitude;
    } else if (userLocation) {
      centerLat = userLocation.coords.latitude;
      centerLng = userLocation.coords.longitude;
    }

    mapRef.current.animateCamera(
      {
        center: { latitude: centerLat, longitude: centerLng },
        zoom: ZOOM_LEVELS.current[nextStage],
      },
      { duration: 600 }
    );
  };

  // Handle search input change with debounce
  const handleSearchChange = useCallback(
    debounce((text: string) => {
      setSearchQuery(text);
      const filtered = markers.filter(
        (marker) =>
          marker.name.toLowerCase().includes(text.toLowerCase()) ||
          marker.address.toLowerCase().includes(text.toLowerCase())
      );
      setFilteredMarkers(filtered);
      setFlatListVisible(text.length > 0);
    }, 300),
    [markers]
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

  // Toggle venue in multi-select
  const toggleVenue = (venue: string) => {
    setSelectedVenue((prev) => {
      if (prev.includes(venue)) {
        return prev.filter((v) => v !== venue);
      }
      return [...prev, venue];
    });
  };

  // Select one availability
  const chooseAvailability = (avail: string) => {
    setSelectedAvailability((prev) => (prev === avail ? null : avail));
  };

  // Apply filters to marker list whenever filters change
  useEffect(() => {
  // Debug/instrumentation: measure filtering cycle triggered by dependencies
  const t0 = Date.now();
  console.log('[FavoritesToggle] Filter pass start', {
    showFavoritesOnly,
    favoriteIdsCount: favoriteIds.length,
    markersCount: markers.length,
    selectedSports,
    selectedVenue,
    selectedAvailability,
    searchQueryLength: searchQuery.length,
  });
  let results: MarkerType[] = markers;

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

    // Filter by venue (multi)
    if (selectedVenue.length > 0) {
      results = results.filter((m) => {
        const mVenue = Array.isArray(m.venue) ? m.venue.map((x) => String(x).toLowerCase()) : [String(m.venue).toLowerCase()];
        if (selectedVenue.length === 2) {
          // Only show markers that have both 'indoor' and 'outdoor'
          return mVenue.includes('indoor') && mVenue.includes('outdoor');
        } else {
          // Show markers that match the selected venue
          return selectedVenue.some((v) => mVenue.includes(v.toLowerCase()));
        }
      });
    }

    // Filter by availability (single)
    if (selectedAvailability) {
      results = results.filter((m) => {
        return String(m.availability).toLowerCase() === selectedAvailability.toLowerCase();
      });
    }
    // Favorites-only toggle
    if (showFavoritesOnly) {
      results = results.filter(m => favoriteIds.includes(m.courtid));
    }
    setFilteredMarkers(results);
    console.log('[FavoritesToggle] Filter pass end', {
      resultingCount: results.length,
      durationMs: Date.now() - t0,
    });
  }, [selectedSports, selectedVenue, selectedAvailability, searchQuery, markers, showFavoritesOnly, favoriteIds]);

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
                <View style={styles.searchOverlayWrapper}>
                  <SearchBar
                    placeholder="Search for a location..."
                    onChangeText={onSearchTextChange}
                  />
                  <TouchableOpacity
                    onPress={() => {
                      console.log('[FavoritesToggle] Star icon pressed. Toggling favorites-only view from', showFavoritesOnly, 'to', !showFavoritesOnly);
                      setShowFavoritesOnly(prev => !prev);
                    }}
                    style={[styles.inlineStar, showFavoritesOnly && styles.inlineStarActive]}
                    accessibilityLabel={showFavoritesOnly ? 'Show all locations' : 'Show favorite locations only'}
                    activeOpacity={0.8}
                  >
                    <Image
                      source={ICONS.starCal}
                      style={{ width:22, height:22, tintColor: showFavoritesOnly ? '#333' : '#fff' }}
                    />
                  </TouchableOpacity>
                </View>
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
                        Venue{selectedVenue.length === 2 ? ": Both" : selectedVenue.length === 1 ? `: ${selectedVenue[0]}` : ""}
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
                            const selected = selectedVenue.includes(item);
                            const leftIcon = item.toLowerCase().includes("indoor")
                              ? ICONS.indoor
                              : ICONS.outdoor;
                            return (
                              <TouchableOpacity
                                style={styles.dropdownItem}
                                onPress={() => toggleVenue(item)}
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
                        <View style={styles.dropdownFooter}>
                          <TouchableOpacity
                            onPress={() => setSelectedVenue([])}
                            style={styles.clearButton}
                          >
                            <Text style={styles.clearText}>Clear All</Text>
                          </TouchableOpacity>
                        </View>
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

              {/* Loading / Error */}
              {loadingMarkers && (
                <View style={[styles.searchResults,{justifyContent:'center',alignItems:'center'}]}>
                  <Text>Loading courts...</Text>
                </View>
              )}
              {errorMarkers && !loadingMarkers && (
                <View style={[styles.searchResults,{justifyContent:'center'}]}>
                  <Text style={{color:'red'}}>Error: {errorMarkers}</Text>
                </View>
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
                {filteredMarkers.map((marker) => {
                  const selected = selectedMarker?.id === marker.id;
                  const pinColor = selected
                    ? COLORS.green
                    : marker.isFavorite
                      ? '#FFD700'
                      : COLORS.red;
                  const keyFingerprint = `${marker.id}-${marker.isFavorite ? 'fav' : 'nf'}-${selected ? 'sel' : 'nosel'}`;
                  return (
                    <Marker
                      key={keyFingerprint}
                      coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
                      pinColor={pinColor}
                      onPress={() => handleMarkerPress(marker)}
                    />
                  );
                })}
              </MapView>

              {/* Google Maps Button (above My Location) */}
              {isButtonVisible && (
                <TouchableOpacity style={styles.googleMapButton} onPress={handleGoogleMapPress}>
                  <Image source={ICONS.ggmap} style={styles.googleMapIcon} />
                </TouchableOpacity>
              )}

              {/* Zoom Toggle Button (left side, parallel to Google Maps button) */}
              {isButtonVisible && (
                <TouchableOpacity
                  style={styles.zoomToggleButton}
                  onPress={handleZoomToggle}
                  accessibilityLabel={zoomStage === 2 ? 'Zoom out' : 'Zoom in'}
                >
                  <Image
                    source={zoomStage === 2 ? ICONS.ZoomOut : ICONS.zoomIn}
                    style={styles.zoomIcon}
                  />
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
                    {/* ...existing code... */}
                    {/* Title & actions row (layout adjusted for single-line names) */}
                    <View style={styles.titleRow}> 
                      <Text style={styles.markerTitle} numberOfLines={2} ellipsizeMode="tail">{selectedMarker.name}</Text>
                      <View style={styles.actionRow}> 
                      <TouchableOpacity
                        style={[styles.favoriteButton, isFavorite && styles.favoriteActive]}
                        onPress={async () => {
                          if (!selectedMarker) return;
                          const numericUserId = await getCurrentNumericUserId();
                          if (numericUserId == null) {
                            if (!warnedMissingUserIdRef.current) {
                              console.warn('[Map] Cannot toggle favorite: missing numeric user id. Log in via app backend (email/username + password) to enable favourites.');
                              warnedMissingUserIdRef.current = true;
                            }
                            return;
                          }
                          const courtId = selectedMarker.courtid; // use real courts.courtid
                          const alreadyFav = favoriteIds.includes(courtId);
                          // Optimistic UI
                          setFavoriteIds(prev => alreadyFav ? prev.filter(id => id !== courtId) : [...prev, courtId]);
                          setIsFavorite(!alreadyFav);
                          setMarkers(prev => prev.map(m => m.courtid === courtId ? { ...m, isFavorite: !alreadyFav } : m));
                          setFilteredMarkers(prev => prev.map(m => m.courtid === courtId ? { ...m, isFavorite: !alreadyFav } : m));
                          setSelectedMarker(sm => sm && sm.courtid === courtId ? { ...sm, isFavorite: !alreadyFav } : sm);
                          try {
                            if (!alreadyFav) {
                              const created = await addFavouriteCourt(numericUserId, courtId);
                              setFavouriteRecords(prev => [...prev, created]);
                            } else {
                              const row = favouriteRecords.find(r => r.courtid === courtId);
                              if (row) {
                                await removeFavouriteCourt(row.favouriteid);
                                setFavouriteRecords(prev => prev.filter(r => r.favouriteid !== row.favouriteid));
                              }
                            }
                          } catch (e) {
                            console.warn('[Map] favourite toggle failed, reverting', e);
                            // Revert
                            setFavoriteIds(prev => alreadyFav ? [...prev, courtId] : prev.filter(id => id !== courtId));
                            setIsFavorite(alreadyFav);
                            setMarkers(prev => prev.map(m => m.courtid === courtId ? { ...m, isFavorite: alreadyFav } : m));
                            setFilteredMarkers(prev => prev.map(m => m.courtid === courtId ? { ...m, isFavorite: alreadyFav } : m));
                            setSelectedMarker(sm => sm && sm.courtid === courtId ? { ...sm, isFavorite: alreadyFav } : sm);
                          }
                        }}
                      >
                        <Image
                          source={ICONS.starCal}
                          style={[styles.favoriteIcon, isFavorite && { tintColor: '#FFFF00' }]}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.bookingButton, selectedMarker.availability === "Unavailable" && styles.bookingButtonDisabled]}
                        disabled={selectedMarker.availability === "Unavailable"}
                      >
                        <Image source={ICONS.booking} style={[styles.bookingIcon, selectedMarker.availability === "Unavailable" && { tintColor: '#bbb' }]} />
                        <Text style={[styles.bookingText, selectedMarker.availability === "Unavailable" && { color: '#bbb' }]}>Book</Text>
                      </TouchableOpacity>
                      </View>
                    </View>

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
    position: "relative",
  },
  topRightActions: {
    position: "absolute",
    top: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
  },
  favoriteButton: {
    marginRight: 10,
    marginTop: -12,
    padding: 6,
    borderRadius: 20,
    backgroundColor: '#eee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  favoriteActive: {
    backgroundColor: '#F0F0F0', // light grey
  },
  favoriteIcon: {
    width: 24,
    height: 24,
    tintColor: '#888',
  },
  bookingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FF5733',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginTop: -12,
    height: 36,
  },
  bookingButtonDisabled: {
    backgroundColor: '#ccc',
  },
  bookingIcon: {
    width: 20,
    height: 20,
    marginRight: 8,
    marginLeft: 2,
    tintColor: '#fff',
  },
  bookingText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 15,
  },
  placeholderText: {
    fontSize: 16,
    color: "#888",
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 4,
    justifyContent: 'space-between',
  },
  markerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    textAlign: "left",
    flexShrink: 1,
    flex: 1,
    marginRight: 12,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  // Zoom toggle button
  zoomToggleButton: {
    position: 'absolute',
    bottom: 360, // align vertically with googleMapButton
    left: 20,
    backgroundColor: COLORS.white,
    borderRadius: 50,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
    zIndex: 20,
  },
  zoomIcon: {
    width: 24,
    height: 24,
    resizeMode: 'contain',
  },
  // Search row containing search bar + favorite toggle
  searchOverlayWrapper: {
    position: 'relative',
  },
  inlineStar: {
    position: 'absolute',
    right: 14,
    top: '50%',
    transform: [{ translateY: -17 }], 
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  inlineStarActive: {
    backgroundColor: '#FFD700',
  },
});
