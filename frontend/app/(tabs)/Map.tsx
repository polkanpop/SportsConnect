// Map.tsx
import { SearchBar } from "@/components/SearchBar";
import { COLORS } from "@/constants/colors";
import { ICONS } from "@/constants/icons";
// Removed static markers import
import { supabase } from "@/lib/supabase";
// Backend API helpers (public)
import { listFavouriteCourtsCached, addFavouriteCourt, removeFavouriteCourt, FavouriteCourt, listCourtInfoCached, CourtInfoRow } from '@/lib/backendApi';
import { favouritesEvents } from '@/lib/favouritesEvents';
import { getCache, setCache } from '@/lib/cache';
import { useAuthContext } from '@/hooks/use-auth-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import * as Location from "expo-location";
import debounce from "lodash.debounce";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from 'expo-router';
import {
  FlatList,
  Image,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useQuery } from '@tanstack/react-query';
import { useCourtAvailability } from '@/hooks/use-court-data';
import { listCourts } from '@/lib/backendApi';
import { GestureHandlerRootView } from "react-native-gesture-handler";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

// TypeScript type for a marker
type MarkerType = {
  id: number; // courtinfoid unique id
  courtid: number; // foreign key to courts (REAL court id for favourites)
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  images: string[];
  venue: string | string[];
  availability: string;
  isFavorite?: boolean; // client-side instantaneous favorite flag
};

// Memoized marker component – only re-renders if favorite state, selection, or coordinates change.
type CourtMarkerProps = {
  marker: MarkerType;
  selectedId: number | null;
  onPress: (m: MarkerType) => void;
};

const CourtMarker = React.memo(function CourtMarker({ marker, selectedId, onPress }: CourtMarkerProps) {
  const isSelected = selectedId === marker.id;
  const pinColor = isSelected
    ? COLORS.green
    : marker.isFavorite
      ? '#FFD700'
      : COLORS.red;
  const coordinate = useMemo(() => ({ latitude: marker.latitude, longitude: marker.longitude }), [marker.latitude, marker.longitude]);
  const handlePress = useCallback(() => onPress(marker), [onPress, marker]);
  // Key still includes states to preserve previous remount semantics when fav/selection toggles
  const keyFingerprint = `${marker.id}-${marker.isFavorite ? 'fav' : 'nf'}-${isSelected ? 'sel' : 'nosel'}`;
  return (
    <Marker
      key={keyFingerprint}
      coordinate={coordinate}
      pinColor={pinColor}
      onPress={handlePress}
    />
  );
}, (prev, next) => {
  return (
    prev.selectedId === next.selectedId &&
    prev.marker.isFavorite === next.marker.isFavorite &&
    prev.marker.latitude === next.marker.latitude &&
    prev.marker.longitude === next.marker.longitude
  );
});

// Initial map region
const INITIAL_REGION = {
  latitude: 14.0583, // Vietnam center
  longitude: 108.2772,
  latitudeDelta: 10,
  longitudeDelta: 10,
};

// Format helpers
function pad(n: number) { return n < 10 ? `0${n}` : `${n}` }
function toDateString(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }

const WEEK_DAYS: { key: string; label: string }[] = [
  { key: 'Mon', label: 'Mon' },
  { key: 'Tue', label: 'Tue' },
  { key: 'Wed', label: 'Wed' },
  { key: 'Thu', label: 'Thu' },
  { key: 'Fri', label: 'Fri' },
  { key: 'Sat', label: 'Sat' },
  { key: 'Sun', label: 'Sun' },
]

export default function App() {
  const router = useRouter();
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
  const [calendarModalVisible, setCalendarModalVisible] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);

  // Define zoom levels (tweak as desired)
  const ZOOM_LEVELS = useRef<number[]>([10, 13.5, 16]); // corresponds to camera zoom values

  // Filter states
  const [openDropdown, setOpenDropdown] = useState<"venue" | "availability" | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<string[]>([]); // multi-select
  const [selectedAvailability, setSelectedAvailability] = useState<string | null>(null); // single-select

  // Snap points for the BottomSheet
  const snapPoints = useMemo(() => ["24%", "40%", "80%"], []);

  // Auth context (backend login OR supabase anonymous/social)
  const { profile, session } = useAuthContext();

  // Fetch availability for selected marker
  const { data: availabilityRows } = useCourtAvailability(selectedMarker?.courtid || null);
  const availability = useMemo(() => {
    if (!Array.isArray(availabilityRows) || !availabilityRows.length) return null;
    const row = availabilityRows[0];
    let bd = row.booking_date;
    if (typeof bd === 'string') {
      try { bd = JSON.parse(bd); } catch { bd = []; }
    }
    return { ...row, booking_date: Array.isArray(bd) ? bd : [] };
  }, [availabilityRows]);

  // Derive week dates (Mon -> Sun) for modal
  const weekDaysDetailed = useMemo(() => {
    const today = new Date()
    const dayIdx = today.getDay() // Sun=0
    const offsetToMonday = ((dayIdx + 6) % 7)
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday + weekOffset * 7)
    return WEEK_DAYS.map((wd, i) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      return { ...wd, date: d, dateStr: toDateString(d), isToday: weekOffset === 0 && toDateString(d) === toDateString(today) }
    })
  }, [weekOffset])

  // Reset week offset when modal opens
  useEffect(() => {
    if (calendarModalVisible) {
      setWeekOffset(0);
    }
  }, [calendarModalVisible]);

  // Fetch courts for price
  const { data: courtsData } = useQuery({ 
    queryKey: ['courts'], 
    queryFn: () => listCourts(),
    enabled: !!selectedMarker 
  });
  const price = courtsData?.find((c: any) => c.courtid === selectedMarker?.courtid)?.price;

  const warnedMissingUserIdRef = useRef(false);

  // Unified resolver for numeric userid used by backend tables.
  // Priority:
  // 1. Backend profile from AuthContext (login via /auth/login)
  // 2. Cached @backendProfile in AsyncStorage (in case provider not yet hydrated)
  // 3. Attempt to parse supabase session user id IF it is numeric (rare; usually UUID -> will fail gracefully)
  const getCurrentNumericUserId = useCallback(async (): Promise<number | null> => {
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
  }, [profile]);

  const fetchMarkers = useCallback(async () => {
    setLoadingMarkers(true);
    setErrorMarkers(null);
    try {
      // Fetch via backend API
      // Hydrate markers from cache first for snappy load
      const cached = await getCache<CourtInfoRow[]>('cache:courtinfo:v1')
      let rows: CourtInfoRow[] = []
      if (cached) rows = cached
      // Always fetch fresh (cached variant handles TTL)
      try {
        const fresh = await listCourtInfoCached();
        rows = fresh
        // refresh cache TTL
        setCache('cache:courtinfo:v1', fresh, 5 * 60 * 1000, 5 * 60 * 1000)
      } catch (e) {
        if (!cached) throw e // only surface if we had nothing cached
      }
      let normalized: MarkerType[] = rows.map((m: CourtInfoRow) => ({
        id: m.courtinfoid,
        courtid: m.courtid,
        latitude: m.latitude ?? 0,
        longitude: m.longitude ?? 0,
        name: m.name || m.address || `Court #${m.courtinfoid}`,
        address: m.address || "Unknown",
        images: Array.isArray(m.images) ? m.images : (m.images ? [m.images].flat() : []),
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
          const rowsFav = await listFavouriteCourtsCached({ userid: numericUserId });
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
  }, [getCurrentNumericUserId]);

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
    fetchMarkers();
  }, [fetchMarkers]);

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
  }, [selectedVenue, selectedAvailability, searchQuery, markers, showFavoritesOnly, favoriteIds]);


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
                  refreshing={loadingMarkers}
                  onRefresh={fetchMarkers}
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
                {/* Render all markers via memoized CourtMarker */}
                {filteredMarkers.map(marker => (
                  <CourtMarker
                    key={marker.id}
                    marker={marker}
                    selectedId={selectedMarker?.id ?? null}
                    onPress={handleMarkerPress}
                  />
                ))}
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
                  <BottomSheetScrollView
                    contentContainerStyle={styles.bottomSheetContent}
                    refreshControl={<RefreshControl refreshing={loadingMarkers} onRefresh={fetchMarkers} />}
                  >
                    {/* ...existing code... */}
                    {/* Title & actions row (layout adjusted for single-line names) */}
                    <View style={styles.titleRow}> 
                      <TouchableOpacity onPress={() => setCalendarModalVisible(true)} style={{ flex: 1 }}>
                        <Text style={styles.markerTitle} numberOfLines={2} ellipsizeMode="tail">{selectedMarker.name}</Text>
                      </TouchableOpacity>
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
                              favouritesEvents.emitFavouriteChanged(numericUserId);
                            } else {
                              const row = favouriteRecords.find(r => r.courtid === courtId);
                              if (row) {
                                await removeFavouriteCourt(row.favouriteid);
                                setFavouriteRecords(prev => prev.filter(r => r.favouriteid !== row.favouriteid));
                                favouritesEvents.emitFavouriteChanged(numericUserId);
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
                            // Emit after revert so Home can reflect original state
                            favouritesEvents.emitFavouriteChanged(numericUserId);
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
                        onPress={() => {
                          if (!selectedMarker || selectedMarker.availability === 'Unavailable') return;
                          router.push({ pathname: '/event/courtBooking', params: { courtid: String(selectedMarker.courtid) } });
                        }}
                        accessibilityLabel="Book this court"
                      >
                        <Image source={ICONS.booking} style={[styles.bookingIcon, selectedMarker.availability === "Unavailable" && { tintColor: '#bbb' }]} />
                        <Text style={[styles.bookingText, selectedMarker.availability === "Unavailable" && { color: '#bbb' }]}>Book</Text>
                      </TouchableOpacity>
                      </View>
                    </View>


                    {/* Location Address */}
                    <Text style={styles.markerAddress}>Address: {selectedMarker.address}</Text>

                    {/* Venue Tags (moved under address) */}
                    <View style={styles.sheetTagRow}>
                      {/* Venue */}
                      {(() => {
                        const venueRaw = Array.isArray(selectedMarker.venue) ? selectedMarker.venue : [selectedMarker.venue].filter(Boolean)
                        const venues = venueRaw.filter(Boolean).map(v => String(v))
                        const lower = venues.map(v => v.toLowerCase())
                        let venueDisplay: string[] = []
                        if (lower.includes('indoor') && lower.includes('outdoor')) venueDisplay = ['In/Outdoor']
                        else if (venues.length) venueDisplay = [venues[0]]
                        return venueDisplay.map(v => (
                          <View key={v} style={[styles.sheetTag, styles.sheetVenueTag]}>
                            <Text style={[styles.sheetTagText, { color: '#fff' }]}>{v}</Text>
                          </View>
                        ))
                      })()}
                    </View>

                    {/* Images Section */}
                    <Text style={styles.sectionHeader}>Images</Text>
                    {selectedMarker.images && selectedMarker.images.length > 0 ? (
                      <View style={styles.imageContainer}>
                        {selectedMarker.images.map((image, idx) => (
                          <Image key={idx} source={{ uri: image }} style={styles.markerImage} />
                        ))}
                      </View>
                    ) : (
                      <View style={styles.placeholderSection}>
                        <Text style={styles.placeholderText}>No images available yet.</Text>
                      </View>
                    )}

                    {/* Reviews Section */}
                    <Text style={styles.sectionHeader}>Reviews</Text>
                    <View style={styles.placeholderSection}>
                      <Text style={styles.placeholderText}>Placeholder for user review :D</Text>
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
        <Modal
          visible={calendarModalVisible}
          transparent={true}
          animationType="slide"
          onRequestClose={() => setCalendarModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              {/* Schedule Header with Navigation */}
              <View style={styles.scheduleHeaderRow}>
                <Text style={styles.modalTitle}>Schedule</Text>
                <View style={styles.weekNavInline}>
                  <TouchableOpacity 
                    style={[styles.navBtn, weekOffset === 0 && styles.navBtnDisabled]} 
                    onPress={() => setWeekOffset(prev => Math.max(0, prev - 1))}
                    disabled={weekOffset === 0}
                  >
                    <Image source={ICONS.arrowright} style={[styles.navIcon, { transform: [{ rotate: '180deg' }] }]} />
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[styles.navBtn, weekOffset === 2 && styles.navBtnDisabled]} 
                    onPress={() => setWeekOffset(prev => Math.min(2, prev + 1))}
                    disabled={weekOffset === 2}
                  >
                    <Image source={ICONS.arrowright} style={styles.navIcon} />
                  </TouchableOpacity>
                </View>
              </View>
              
              {availability && (
                <Text style={{ fontSize: 14, color: '#444', marginBottom: 12 }}>
                  Opening Time: {availability.start_time?.slice(0, 5)} - {availability.end_time?.slice(0, 5)}
                </Text>
              )}

              {/* Week Row */}
              <View style={styles.weekRow}>
                {weekDaysDetailed.map((day, index) => {
                  const today = new Date();
                  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                  const isPast = weekOffset === 0 && day.date < todayOnly;
                  const isDayAvailable = availability?.booking_date?.includes(day.key);
                  const isAvailable = isDayAvailable && !isPast;

                  return (
                    <View 
                      key={index} 
                      style={[
                        styles.dayCell, 
                        !isAvailable && styles.dayCellDisabled
                      ]}
                    >
                      <Text style={styles.dayLabel}>{day.label}</Text>
                      <Text style={[styles.dayDate, day.isToday && styles.todayUnderline]}>
                        {day.date.getDate()}
                      </Text>
                    </View>
                  )
                })}
              </View>

              <Text style={{ fontSize: 16, marginTop: 20, fontWeight: 'bold' }}>
                Price: ({price ? new Intl.NumberFormat('vi-VN').format(Number(price)) : '0'}đ/hr)
              </Text>

              <View style={styles.modalActions}>
                <TouchableOpacity 
                  style={[styles.modalBtn, styles.modalCancel]} 
                  onPress={() => setCalendarModalVisible(false)}
                >
                  <Text style={styles.modalBtnText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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
  // Bottom sheet tag styles
  sheetTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    marginBottom: 14,
  },
  sheetTag: {
    backgroundColor: '#333',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    marginRight: 10,
    marginBottom: 10,
  },
  sheetTagFallback: { backgroundColor: '#444' },
  sheetVenueTag: { backgroundColor: '#6a5acd' },
  sheetTagText: { color: '#ddd', fontSize: 14, fontWeight: '700' },
  modalOverlay: { position: 'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.35)', justifyContent:'center', alignItems:'center' },
  modalCard: { width:'85%', backgroundColor:'#fff', padding:20, borderRadius:14, elevation:6 },
  modalTitle: { fontSize:16, fontWeight:'700', marginBottom:8, color:'#222' },
  modalActions: { flexDirection:'row', justifyContent:'flex-end', marginTop:18 },
  modalBtn: { paddingVertical:10, paddingHorizontal:18, borderRadius:10, marginLeft:10 },
  modalCancel: { backgroundColor:'#eee' },
  modalBtnText: { fontSize:14, fontWeight:'600', color:'#222' },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  scheduleHeaderRow: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:4 },
  weekNavInline: { flexDirection:'row', alignItems:'center' },
  navBtn: { padding:8, borderRadius:10, backgroundColor:'#e0e0e0', marginHorizontal:4 },
  navBtnDisabled: { opacity:0.35 },
  navIcon: { width:20, height:20, tintColor:'#333', resizeMode:'contain' },
  dayCell: { flex: 1, marginHorizontal: 2, paddingVertical: 10, borderRadius: 10, backgroundColor: '#e9e9e9', alignItems: 'center' },
  dayCellDisabled: { opacity: 0.35 },
  dayLabel: { fontSize: 12, fontWeight: '600', color: '#222' },
  todayUnderline: { textDecorationLine: 'underline' },
  dayDate: { fontSize: 14, fontWeight: '700', color: '#111', marginTop: 4 },
  sectionHeader: { fontSize: 18, fontWeight: 'bold', marginTop: 16, marginBottom: 8, color: '#333' },
  placeholderSection: { padding: 20, backgroundColor: '#f9f9f9', borderRadius: 8, alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: 10 },
});
