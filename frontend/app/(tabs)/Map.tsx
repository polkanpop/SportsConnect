  // Map.tsx
  import { SearchBar } from "@/components/SearchBar";
  import { COLORS } from "@/constants/colors";
  import { ICONS } from "@/constants/icons";
  // Removed static markers import
  import { supabase } from "@/lib/supabase";
  // Backend API helpers (public)
  import {
    listFavouriteCourtsCached,
    addFavouriteCourt,
    removeFavouriteCourt,
    FavouriteCourt,
    CourtInfoRow,
    listCourtInfo,
    getDistanceMatrixCached,
    peekDistanceMatrixCached,
    listCourts,
  } from '@/lib/backendApi';
  import { favouritesEvents } from '@/lib/favouritesEvents';
  import { getCache, setCache } from '@/lib/cache';
  import { useAuthContext } from '@/hooks/use-auth-context';
  import AsyncStorage from '@react-native-async-storage/async-storage';
  import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
  import * as Location from "expo-location";
  import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
  import { useFocusEffect, useRouter } from 'expo-router';
  import {
    Dimensions,
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
    TextInput,
    TouchableOpacity,
    TouchableWithoutFeedback,
    View,
  } from "react-native";
  import { useQuery } from '@tanstack/react-query';
  import { useCourtAvailability } from '@/hooks/use-court-data';
  import { GestureHandlerRootView } from "react-native-gesture-handler";
  import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type Region } from "react-native-maps";
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
  const INITIAL_REGION: Region = {
    latitude: 14.0583, // Vietnam center
    longitude: 108.2772,
    latitudeDelta: 10,
    longitudeDelta: 10,
  };

  const VN_BOUNDS = {
    minLat: 8.0,
    maxLat: 23.6,
    minLng: 102.0,
    maxLng: 110.6,
  } as const;

  const VN_MAX_LAT_DELTA = (VN_BOUNDS.maxLat - VN_BOUNDS.minLat) + 2.0;
  const VN_MAX_LNG_DELTA = (VN_BOUNDS.maxLng - VN_BOUNDS.minLng) + 2.0;

  const VN_BOUNDS_OUTLINE = [
    { latitude: VN_BOUNDS.maxLat, longitude: VN_BOUNDS.minLng },
    { latitude: VN_BOUNDS.maxLat, longitude: VN_BOUNDS.maxLng },
    { latitude: VN_BOUNDS.minLat, longitude: VN_BOUNDS.maxLng },
    { latitude: VN_BOUNDS.minLat, longitude: VN_BOUNDS.minLng },
    { latitude: VN_BOUNDS.maxLat, longitude: VN_BOUNDS.minLng },
  ];

  // Hide default map POIs (cafes/hotels/etc.) so only app markers remain.
  const MAP_STYLE_HIDE_POI = [
    { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  ];

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  function clampRegionToVietnam(region: Region): Region {
    const latitudeDelta = Math.min(region.latitudeDelta, VN_MAX_LAT_DELTA);
    const longitudeDelta = Math.min(region.longitudeDelta, VN_MAX_LNG_DELTA);

    const halfLat = latitudeDelta / 2;
    const halfLng = longitudeDelta / 2;

    const centerLatMin = VN_BOUNDS.minLat + halfLat;
    const centerLatMax = VN_BOUNDS.maxLat - halfLat;
    const centerLngMin = VN_BOUNDS.minLng + halfLng;
    const centerLngMax = VN_BOUNDS.maxLng - halfLng;

    // If deltas are still too large (can happen on some devices), force center to VN mid
    const fallbackCenterLat = (VN_BOUNDS.minLat + VN_BOUNDS.maxLat) / 2;
    const fallbackCenterLng = (VN_BOUNDS.minLng + VN_BOUNDS.maxLng) / 2;

    const latitude = (centerLatMin <= centerLatMax)
      ? clamp(region.latitude, centerLatMin, centerLatMax)
      : fallbackCenterLat;
    const longitude = (centerLngMin <= centerLngMax)
      ? clamp(region.longitude, centerLngMin, centerLngMax)
      : fallbackCenterLng;

    return {
      latitude,
      longitude,
      latitudeDelta,
      longitudeDelta,
    };
  }

  // Format helpers
  function pad(n: number) { return n < 10 ? `0${n}` : `${n}` }
  function toDateString(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }

  function formatKmFromMeters(distanceMeters: number | null | undefined) {
    if (distanceMeters == null || !Number.isFinite(distanceMeters)) return null;
    const km = distanceMeters / 1000;
    const rounded = Math.round(km * 10) / 10;
    // Display as 9,3 km (comma decimal)
    return `${rounded.toFixed(1).replace('.', ',')} km`;
  }

  function haversineMeters(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number
  ) {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const R = 6371000; // meters
    const dLat = toRad(destLat - originLat);
    const dLng = toRad(destLng - originLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(originLat)) *
        Math.cos(toRad(destLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDuration(seconds: number | null | undefined) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
    const totalMins = Math.round(seconds / 60);
    if (totalMins < 60) return `${totalMins} min`;
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  }

  function estimateWalkSecondsFromMeters(distanceMeters: number | null | undefined) {
    if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
    // ~5 km/h walking speed => 1.388.. m/s
    const walkSpeedMps = 1.4;
    return distanceMeters / walkSpeedMps;
  }

  function estimateMotorbikeSecondsFromMeters(distanceMeters: number | null | undefined) {
    if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
    // Rough city riding speed; used only for "~" placeholder while matrix loads.
    const rideSpeedMps = 8.3; // ~30 km/h
    return distanceMeters / rideSpeedMps;
  }

  const WEEK_DAYS: { key: string; label: string }[] = [
    { key: 'Mon', label: 'Mon' },
    { key: 'Tue', label: 'Tue' },
    { key: 'Wed', label: 'Wed' },
    { key: 'Thu', label: 'Thu' },
    { key: 'Fri', label: 'Fri' },
    { key: 'Sat', label: 'Sat' },
    { key: 'Sun', label: 'Sun' },
  ]

  const DETAIL_IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.7)
  const DETAIL_IMAGE_TILE_HEIGHT = 120

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
    const [bottomSheetIndex, setBottomSheetIndex] = useState<number>(0); // Track BottomSheet index
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
    const [openDropdown, setOpenDropdown] = useState<"venue" | "availability" | "distance" | null>(null);
    const [selectedVenue, setSelectedVenue] = useState<string[]>([]); // multi-select
    const [selectedAvailability, setSelectedAvailability] = useState<string | null>(null); // single-select
    const [selectedDistanceKm, setSelectedDistanceKm] = useState<number | null>(null); // radius filter (km)
    const [distanceKmInput, setDistanceKmInput] = useState<string>('');
    const [distanceKmError, setDistanceKmError] = useState<string | null>(null);
    const [scheduleExpanded, setScheduleExpanded] = useState(true);
    const [transportExpanded, setTransportExpanded] = useState(true);
    const [reviewsExpanded, setReviewsExpanded] = useState(false);

    type DistanceMatrixStatus = 'loading' | 'loaded' | 'error';
    const [distanceMatrixStatusByCourtInfoId, setDistanceMatrixStatusByCourtInfoId] = useState<Record<number, DistanceMatrixStatus>>({});

    const lastValidRegionRef = useRef<Region>(INITIAL_REGION);
    const isProgrammaticRegionChangeRef = useRef(false);

    // Distance cache keyed by courtinfoid
    const [distanceMetersByCourtInfoId, setDistanceMetersByCourtInfoId] = useState<Record<number, number | null>>({});
    const [durationSecondsByCourtInfoId, setDurationSecondsByCourtInfoId] = useState<Record<number, number | null>>({});
    const inFlightDistanceIdsRef = useRef<Set<number>>(new Set());

    const handleRegionChangeComplete = useCallback((region: Region) => {
      if (!mapRef.current) return;

      if (isProgrammaticRegionChangeRef.current) {
        isProgrammaticRegionChangeRef.current = false;
        lastValidRegionRef.current = region;
        return;
      }

      const clamped = clampRegionToVietnam(region);
      const changed =
        Math.abs(clamped.latitude - region.latitude) > 1e-6 ||
        Math.abs(clamped.longitude - region.longitude) > 1e-6 ||
        Math.abs(clamped.latitudeDelta - region.latitudeDelta) > 1e-6 ||
        Math.abs(clamped.longitudeDelta - region.longitudeDelta) > 1e-6;

      if (!changed) {
        lastValidRegionRef.current = region;
        return;
      }

      isProgrammaticRegionChangeRef.current = true;
      lastValidRegionRef.current = clamped;
      mapRef.current.animateToRegion(clamped, 180);
    }, [mapRef]);

    // Snap points for the BottomSheet
    const snapPoints = useMemo(() => ["30%", "70%", "100%"], []);

    // Reset section expansion state when selecting a new marker
    useEffect(() => {
      if (!selectedMarker) return;
      setScheduleExpanded(true);
      setTransportExpanded(true);
      setReviewsExpanded(false);
      setWeekOffset(0);
    }, [selectedMarker?.id]);

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

    const normalizeCourtInfoRows = useCallback((rows: CourtInfoRow[]): MarkerType[] => {
      return rows.map((m: CourtInfoRow) => {
        const latRaw: any = (m as any)?.latitude
        const lngRaw: any = (m as any)?.longitude
        const lat = typeof latRaw === 'number' ? latRaw : (typeof latRaw === 'string' ? Number(latRaw) : NaN)
        const lng = typeof lngRaw === 'number' ? lngRaw : (typeof lngRaw === 'string' ? Number(lngRaw) : NaN)
        return ({
          id: m.courtinfoid,
          courtid: m.courtid,
          latitude: Number.isFinite(lat) ? lat : 0,
          longitude: Number.isFinite(lng) ? lng : 0,
          name: m.name || m.address || `Court #${m.courtinfoid}`,
          address: m.address || "Unknown",
          images: Array.isArray(m.images) ? m.images : (m.images ? [m.images].flat() : []),
          venue: Array.isArray(m.venue) ? m.venue : (m.venue ? [m.venue].flat() : []),
          availability: m.availability || "Available",
          isFavorite: false,
        })
      });
    }, []);

    const refreshFavouritesOnly = useCallback(async () => {
      const numericUserId = await getCurrentNumericUserId();
      if (numericUserId === null) return;
      try {
        const rowsFav = await listFavouriteCourtsCached({ userid: numericUserId });
        const favRows: FavouriteCourt[] = Array.isArray(rowsFav)
          ? (rowsFav as any[]).filter(r => typeof r === 'object' && 'courtid' in r)
          : [];
        setFavouriteRecords(favRows);
        const favIds = favRows.map(r => r.courtid);
        setFavoriteIds(favIds);
        setMarkers(prev => prev.map(m => ({ ...m, isFavorite: favIds.includes(m.courtid) })));
        setFilteredMarkers(prev => prev.map(m => ({ ...m, isFavorite: favIds.includes(m.courtid) })));
      } catch (e) {
        console.warn('[Map] failed to load favouritecourts', e);
      }
    }, [getCurrentNumericUserId]);

    const fetchMarkers = useCallback(async (opts?: { forceFresh?: boolean; onlyIfCacheMissing?: boolean; showLoading?: boolean }) => {
      const forceFresh = !!opts?.forceFresh;
      const onlyIfCacheMissing = !!opts?.onlyIfCacheMissing;
      const showLoading = opts?.showLoading ?? true;

      if (onlyIfCacheMissing) {
        const cached = await getCache<CourtInfoRow[]>('cache:courtinfo:v1');
        if (cached && cached.length) {
          // We already have cached markers available; sync state from cache but don't refetch on tab hop.
          const normalized: MarkerType[] = normalizeCourtInfoRows(cached);
          setMarkers(normalized);
          setFilteredMarkers(normalized);
          return;
        }
      }

      if (showLoading) setLoadingMarkers(true);
      setErrorMarkers(null);
      try {
        const cached = await getCache<CourtInfoRow[]>('cache:courtinfo:v1');
        let rows: CourtInfoRow[] = Array.isArray(cached) ? cached : [];

        // Only hit network if cache missing OR explicitly forced.
        if (forceFresh || !rows.length) {
          const fresh = await listCourtInfo();
          rows = fresh;
          // Longer TTL prevents refetch when simply hopping between tabs.
          await setCache('cache:courtinfo:v1', fresh, 60 * 1000);
        }

        let normalized: MarkerType[] = normalizeCourtInfoRows(rows);
        setMarkers(normalized);
        setFilteredMarkers(normalized);

        // Apply favourites (cheap + cached)
        const numericUserId = await getCurrentNumericUserId();
        let favIds: number[] = [];
        if (numericUserId !== null) {
          try {
            const rowsFav = await listFavouriteCourtsCached({ userid: numericUserId });
            const favRows: FavouriteCourt[] = Array.isArray(rowsFav)
              ? (rowsFav as any[]).filter(r => typeof r === 'object' && 'courtid' in r)
              : [];
            setFavouriteRecords(favRows);
            favIds = favRows.map(r => r.courtid);
            setFavoriteIds(favIds);
          } catch (e) {
            console.warn('[Map] failed to load favouritecourts', e);
          }
        }
        if (favIds.length) {
          normalized = normalized.map(m => ({ ...m, isFavorite: favIds.includes(m.courtid) }));
          setMarkers(normalized);
          setFilteredMarkers(normalized);
        }
      } catch (e: any) {
        setErrorMarkers(e.message || String(e));
        setMarkers([]);
        setFilteredMarkers([]);
      } finally {
        if (showLoading) setLoadingMarkers(false);
      }
    }, [getCurrentNumericUserId, normalizeCourtInfoRows]);

    const venueOptions = useMemo(() => {
      const set = new Set<string>();
      markers.forEach((m) => {
        const v = m.venue;
        if (Array.isArray(v)) v.forEach((x) => set.add(String(x)));
        else if (v) set.add(String(v));
      });
      return Array.from(set);
    }, [markers]);
    // On focus:
    // - Only refetch court markers if the courtinfo cache was invalidated (e.g., after Court Register)
    // - Still refresh favourites (cached) so fav pins stay in sync
    useFocusEffect(useCallback(() => {
      fetchMarkers({ onlyIfCacheMissing: true, showLoading: false });
      refreshFavouritesOnly();
    }, [fetchMarkers, refreshFavouritesOnly]));

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
    // Called whenever search text changes
    // Update immediately so filtering + dropdown always responds.
    const onSearchTextChange = (text: string) => {
      setSearchQuery(text);
      setFlatListVisible(text.trim().length > 0);
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

    // Keep map UI overlays from overlapping the BottomSheet when expanded
    const overlaysVisible = bottomSheetIndex <= 0;

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

    const sanitizeKmInput = useCallback((raw: string) => {
      // Accept digits + one decimal point. Also allow comma input (convert to dot).
      let s = raw.replace(',', '.');
      s = s.replace(/[^0-9.]/g, '');
      const parts = s.split('.');
      if (parts.length > 2) {
        s = `${parts[0]}.${parts.slice(1).join('')}`;
      }
      return s;
    }, []);

    const parseKmInput = useCallback((value: string): number | null => {
      if (!value) return null;
      if (value === '.') return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n <= 0) return null;
      return n;
    }, []);

    const getDistanceMetersForMarker = useCallback((m: MarkerType): number | null => {
      if (!userLocation) return null;
      const cached = distanceMetersByCourtInfoId[m.id];
      if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
      // fallback: straight-line distance for quick ordering/filtering
      return haversineMeters(
        userLocation.coords.latitude,
        userLocation.coords.longitude,
        m.latitude,
        m.longitude
      );
    }, [userLocation, distanceMetersByCourtInfoId]);

    const getDistanceLabelForMarker = useCallback((m: MarkerType): string | null => {
      const meters = getDistanceMetersForMarker(m);
      return formatKmFromMeters(meters);
    }, [getDistanceMetersForMarker]);

    const getDurationSecondsForMarker = useCallback((m: MarkerType): number | null => {
      const cached = durationSecondsByCourtInfoId[m.id];
      if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
      return null;
    }, [durationSecondsByCourtInfoId]);

    // Ensure we have distance + duration for the selected marker (for BottomSheet Transport section)
    useEffect(() => {
      if (!transportExpanded) return;
      if (!selectedMarker) return;
      if (!userLocation) return;
      const id = selectedMarker.id;
      if ((id in distanceMetersByCourtInfoId) && (id in durationSecondsByCourtInfoId)) return;
      if (inFlightDistanceIdsRef.current.has(id)) return;

      const payload = {
        origin_lat: userLocation.coords.latitude,
        origin_lng: userLocation.coords.longitude,
        dest_lat: selectedMarker.latitude,
        dest_lng: selectedMarker.longitude,
      };

      // If already cached in the shared runtime cache, hydrate immediately without showing a spinner.
      const already = peekDistanceMatrixCached(payload);
      if (already?.status === 'loaded') {
        const meters = typeof already.result?.distance_meters === 'number' ? already.result.distance_meters : null;
        const secs = typeof already.result?.duration_seconds === 'number' ? already.result.duration_seconds : null;
        setDistanceMetersByCourtInfoId((prev) => ({ ...prev, [id]: meters }));
        setDurationSecondsByCourtInfoId((prev) => ({ ...prev, [id]: secs }));
        setDistanceMatrixStatusByCourtInfoId((prev) => ({ ...prev, [id]: 'loaded' }));
        return;
      }

      let cancelled = false;
      inFlightDistanceIdsRef.current.add(id);
      setDistanceMatrixStatusByCourtInfoId((prev) => ({ ...prev, [id]: 'loading' }));
      (async () => {
        try {
          const peeked = peekDistanceMatrixCached(payload);
          if (peeked?.status === 'loaded') {
            const meters = typeof peeked.result?.distance_meters === 'number' ? peeked.result.distance_meters : null;
            const secs = typeof peeked.result?.duration_seconds === 'number' ? peeked.result.duration_seconds : null;
            if (!cancelled) {
              setDistanceMetersByCourtInfoId((prev) => ({ ...prev, [id]: meters }));
              setDurationSecondsByCourtInfoId((prev) => ({ ...prev, [id]: secs }));
              setDistanceMatrixStatusByCourtInfoId((prev) => ({ ...prev, [id]: 'loaded' }));
            }
            return;
          }

          const res = await getDistanceMatrixCached(payload);
          if (cancelled) return;
          const meters = typeof res?.distance_meters === 'number' ? res.distance_meters : null;
          const secs = typeof res?.duration_seconds === 'number' ? res.duration_seconds : null;
          setDistanceMetersByCourtInfoId((prev) => ({ ...prev, [id]: meters }));
          setDurationSecondsByCourtInfoId((prev) => ({ ...prev, [id]: secs }));
          setDistanceMatrixStatusByCourtInfoId((prev) => ({ ...prev, [id]: 'loaded' }));
        } catch {
          if (cancelled) return;
          setDistanceMetersByCourtInfoId((prev) => ({ ...prev, [id]: null }));
          setDurationSecondsByCourtInfoId((prev) => ({ ...prev, [id]: null }));
          setDistanceMatrixStatusByCourtInfoId((prev) => ({ ...prev, [id]: 'error' }));
        } finally {
          inFlightDistanceIdsRef.current.delete(id);
        }
      })();

      return () => {
        cancelled = true;
        inFlightDistanceIdsRef.current.delete(id);
      };
    }, [transportExpanded, selectedMarker, userLocation, distanceMetersByCourtInfoId, durationSecondsByCourtInfoId]);

    // Sorted list data for search dropdown: closest first (when user location is available)
    const sortedFilteredMarkersForList = useMemo(() => {
      if (!userLocation) return filteredMarkers;
      const withDistance = filteredMarkers
        .map((m) => ({ m, d: getDistanceMetersForMarker(m) }))
        .sort((a, b) => {
          const da = a.d;
          const db = b.d;
          if (da == null && db == null) return 0;
          if (da == null) return 1;
          if (db == null) return -1;
          return da - db;
        })
        .map((x) => x.m);
      return withDistance;
    }, [filteredMarkers, userLocation, getDistanceMetersForMarker]);

    // Note: we intentionally do NOT prefetch distance-matrix for search results.
    // Distance Matrix is expensive, so it only loads when Transport is expanded.

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
      selectedDistanceKm,
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

      // Filter by distance radius (km)
      if (selectedDistanceKm != null) {
        if (userLocation) {
          const maxMeters = selectedDistanceKm * 1000;
          results = results.filter((m) => {
            const d = getDistanceMetersForMarker(m);
            return d != null && d <= maxMeters;
          });
        } else {
          // No user location -> cannot evaluate distance filter
          results = [];
        }
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
    }, [selectedVenue, selectedAvailability, selectedDistanceKm, searchQuery, markers, showFavoritesOnly, favoriteIds, userLocation, getDistanceMetersForMarker]);


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
                {/* Map View (render first so overlays appear above on Android) */}
                <MapView
                  style={styles.map}
                  provider={PROVIDER_GOOGLE} //googleAPI
                  initialRegion={INITIAL_REGION} //vn
                  onRegionChangeComplete={handleRegionChangeComplete}
                  showsUserLocation={true} // our location dot
                  showsMyLocationButton={false} // Disable default location button (we use our custom one)
                  showsPointsOfInterest={false}
                  showsBuildings={false}
                  showsIndoors={false}
                  customMapStyle={MAP_STYLE_HIDE_POI}
                  toolbarEnabled={false} //disable google map bottom right hyperlink
                  showsCompass={false}
                  ref={mapRef}
                >
                  <Polyline
                    coordinates={VN_BOUNDS_OUTLINE}
                    strokeColor={COLORS.red}
                    strokeWidth={6}
                  />
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

                {/* Search Bar */}
                {overlaysVisible && (
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
                )}

                {/* === FILTER BAR (REPLACED) ===
                    Now horizontally scrollable and expands to content
                */}
                {overlaysVisible && (
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

                    {/* Distance */}
                    <TouchableOpacity
                      style={styles.filterChip}
                      activeOpacity={0.8}
                      onPress={() =>
                        setOpenDropdown((prev) => (prev === "distance" ? null : "distance"))
                      }
                    >
                      <View style={styles.filterChipLeft}>
                        <Image source={ICONS.radar} style={styles.filterIcon} />
                        <Text style={styles.filterChipText}>
                          {selectedDistanceKm != null ? `Distance: ${selectedDistanceKm}km` : "Distance"}
                        </Text>
                      </View>
                      <Image
                        source={ICONS.arrowdown}
                        style={[
                          styles.filterArrow,
                          openDropdown === "distance" ? styles.arrowOpen : null,
                        ]}
                      />
                    </TouchableOpacity>
                    </ScrollView>
                  </View>
                )}

                {/* Dropdown lists */}
                {overlaysVisible && openDropdown && (
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

                      {openDropdown === "distance" && (
                        <View style={styles.dropdown}>
                          <View style={styles.distanceHeader}>
                            <Text style={styles.distanceHeaderTitle}>Type distance (km)</Text>
                            <TextInput
                              value={distanceKmInput}
                              onChangeText={(t) => {
                                const cleaned = sanitizeKmInput(t);
                                setDistanceKmInput(cleaned);

                                if (cleaned.trim().length === 0) {
                                  setDistanceKmError(null);
                                  setSelectedDistanceKm(null);
                                  return;
                                }
                                const parsed = parseKmInput(cleaned);
                                if (parsed == null) {
                                  setDistanceKmError('Please type in number');
                                  return;
                                }
                                setDistanceKmError(null);
                                setSelectedDistanceKm(parsed);
                              }}
                              placeholder="e.g. 2"
                              placeholderTextColor="#888"
                              keyboardType="numeric"
                              style={[styles.distanceInput, distanceKmError ? styles.distanceInputError : null]}
                            />
                            {!!distanceKmError && (
                              <Text style={styles.distanceErrorText}>{distanceKmError}</Text>
                            )}
                          </View>
                          <View style={styles.dropdownFooter}>
                            <TouchableOpacity
                              onPress={() => {
                                setSelectedDistanceKm(null);
                                setDistanceKmInput('');
                                setDistanceKmError(null);
                              }}
                              style={styles.clearButton}
                            >
                              <Text style={styles.clearText}>Clear</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )}
                    </View>
                  </>
                )}

                {/* Loading / Error */}
                {overlaysVisible && loadingMarkers && (
                  <View style={[styles.searchResults,{justifyContent:'center',alignItems:'center'}]}>
                    <Text>Loading courts...</Text>
                  </View>
                )}
                {overlaysVisible && errorMarkers && !loadingMarkers && (
                  <View style={[styles.searchResults,{justifyContent:'center'}]}>
                    <Text style={{color:'red'}}>Error: {errorMarkers}</Text>
                  </View>
                )}
                {/* Search Results (FlatList) */}
                {overlaysVisible && isFlatListVisible && sortedFilteredMarkersForList.length > 0 && (
                  <FlatList
                    data={sortedFilteredMarkersForList}
                    keyExtractor={(item, index) => index.toString()}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={styles.listItem}
                        onPress={() => handleFlatListItemPress(item as MarkerType)}
                      >
                        <View style={styles.listItemRow}>
                          <View style={styles.listItemTextCol}>
                            <Text style={styles.listItemTitle}>{(item as MarkerType).name}</Text>
                            <Text style={styles.listItemSubtitle}>{(item as MarkerType).address}</Text>
                          </View>
                          {!!getDistanceLabelForMarker(item as MarkerType) && (
                            <Text style={styles.listItemDistanceRight}>{getDistanceLabelForMarker(item as MarkerType)}</Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    )}
                    style={styles.searchResults}
                    keyboardShouldPersistTaps="handled"
                    refreshing={loadingMarkers}
                    onRefresh={fetchMarkers}
                  />
                )}

                {overlaysVisible && isFlatListVisible && sortedFilteredMarkersForList.length === 0 && !loadingMarkers && !errorMarkers && (
                  <View style={styles.searchResults}>
                    <Text style={styles.noResultsText}>No courts found</Text>
                  </View>
                )}

                {/* Google Maps Button (above My Location) */}
                {overlaysVisible && (
                  <TouchableOpacity style={styles.googleMapButton} onPress={handleGoogleMapPress}>
                    <Image source={ICONS.ggmap} style={styles.googleMapIcon} />
                  </TouchableOpacity>
                )}

                {/* Zoom Toggle Button (left side, parallel to Google Maps button) */}
                {overlaysVisible && (
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
                {overlaysVisible && (
                  <TouchableOpacity style={styles.myLocationButton} onPress={handleMyLocationPress}>
                    <Image source={ICONS.location_icon} style={styles.myLocationIcon} />
                  </TouchableOpacity>
                )}

                {/* BottomSheet for marker details */}
                <BottomSheet
                  ref={bottomSheetRef}
                  snapPoints={snapPoints}
                  index={0} // closed by default
                  enablePanDownToClose={false} // Keep BottomSheet always enabled
                  onChange={handleSheetChange} // Listen to sheet index change
                  backgroundStyle={styles.bottomSheetBackground}
                >
                  {selectedMarker ? (
                    <BottomSheetScrollView
                      contentContainerStyle={styles.bottomSheetContent}
                      refreshControl={<RefreshControl refreshing={loadingMarkers} onRefresh={fetchMarkers} />}
                    >
                      {/* ...existing code... */}
                      {/* Title & actions row (layout adjusted for single-line names) */}
                      <View style={styles.titleRow}> 
                        <View style={{ flex: 1 }}>
                          <Text style={styles.markerTitle} numberOfLines={2} ellipsizeMode="tail">{selectedMarker.name}</Text>
                        </View>
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
                      <Text style={styles.markerAddress}>
                        <Text style={styles.markerAddressLabel}>Address: </Text>
                        {selectedMarker.address}
                      </Text>

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

                      {/* Price */}
                      <Text style={styles.priceText}>
                        Price: ({price ? new Intl.NumberFormat('vi-VN').format(Number(price)) : '0'}đ/hr)
                      </Text>

                      {/* Schedule Section (expandable, expanded by default) */}
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => setScheduleExpanded((p) => !p)}
                        style={styles.transportHeader}
                      >
                        <Text style={[styles.sectionHeader, styles.transportHeaderTitle]}>Schedule</Text>
                        <Image
                          source={ICONS.arrowdown}
                          style={[styles.transportHeaderArrow, scheduleExpanded ? styles.transportArrowOpen : null]}
                        />
                      </TouchableOpacity>

                      {scheduleExpanded && (
                        availability ? (
                          <View style={styles.scheduleBox}>
                            {/* Match the existing modal schedule UI */}
                            <View style={styles.scheduleHeaderRow}>
                              <Text
                                numberOfLines={1}
                                style={[styles.scheduleTimeText, styles.scheduleTimeTextInline]}
                              >
                                Opening Time: {String(availability.start_time || '').slice(0, 5)} - {String(availability.end_time || '').slice(0, 5)}
                              </Text>

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
                                      !isAvailable && styles.dayCellDisabled,
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
                          </View>
                        ) : (
                          <View style={styles.placeholderSection}>
                            <Text style={styles.placeholderText}>No schedule available yet.</Text>
                          </View>
                        )
                      )}

                      {/* Transport Section (expandable) */}
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => setTransportExpanded((p) => !p)}
                        style={styles.transportHeader}
                      >
                        <Text style={[styles.sectionHeader, styles.transportHeaderTitle]}>Transport</Text>
                        <Image
                          source={ICONS.arrowdown}
                          style={[styles.transportHeaderArrow, transportExpanded ? styles.transportArrowOpen : null]}
                        />
                      </TouchableOpacity>

                      {transportExpanded && (() => {
                        if (!selectedMarker) return null;
                        const id = selectedMarker.id;
                        const status = distanceMatrixStatusByCourtInfoId[id];
                        const hasDistance = typeof distanceMetersByCourtInfoId[id] === 'number' && Number.isFinite(distanceMetersByCourtInfoId[id]);
                        const hasDuration = typeof durationSecondsByCourtInfoId[id] === 'number' && Number.isFinite(durationSecondsByCourtInfoId[id]);
                        const isLoading = status === 'loading' || (!hasDistance && !hasDuration && inFlightDistanceIdsRef.current.has(id));

                        const crowMeters = (userLocation && userLocation.coords)
                          ? haversineMeters(
                              userLocation.coords.latitude,
                              userLocation.coords.longitude,
                              selectedMarker.latitude,
                              selectedMarker.longitude,
                            )
                          : null;
                        const crowKmLabel = crowMeters != null ? (formatKmFromMeters(crowMeters) ?? 'Unavailable') : null;

                        const approxKmLabel = (crowKmLabel && crowKmLabel !== 'Unavailable')
                          ? `~ ${crowKmLabel}`
                          : (crowKmLabel ?? 'Loading…');
                        const approxTravelSecs = estimateMotorbikeSecondsFromMeters(crowMeters);
                        const approxWalkSecs = estimateWalkSecondsFromMeters(crowMeters);
                        const approxTravelLabel = approxTravelSecs != null ? `~ ${formatDuration(approxTravelSecs) ?? 'Unavailable'}` : 'Loading…';
                        const approxWalkLabel = approxWalkSecs != null ? `~ ${formatDuration(approxWalkSecs) ?? 'Unavailable'}` : 'Loading…';

                        if (isLoading) {
                          // Show "as the crow flies" distance placeholder (same concept as Court List)
                          return (
                            <View style={styles.transportBox}>
                              <View style={styles.transportRow}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.distance} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Distance</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxKmLabel}</Text>
                              </View>

                              <View style={styles.transportRow}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.motorbike} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Travel time</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxTravelLabel}</Text>
                              </View>

                              <View style={styles.transportRowLast}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.walk} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Walk time</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxWalkLabel}</Text>
                              </View>
                            </View>
                          );
                        }

                        if (status === 'error') {
                          return (
                            <View style={styles.transportBox}>
                              <View style={styles.transportRow}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.distance} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Distance</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxKmLabel ?? 'Unavailable'}</Text>
                              </View>

                              <View style={styles.transportRow}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.motorbike} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Travel time</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxTravelSecs != null ? approxTravelLabel : 'Unavailable'}</Text>
                              </View>

                              <View style={styles.transportRowLast}>
                                <View style={styles.transportLeft}>
                                  <Image source={ICONS.walk} style={styles.transportIcon} />
                                  <Text style={styles.transportLabel}>Walk time</Text>
                                </View>
                                <Text style={styles.transportValue}>{approxWalkSecs != null ? approxWalkLabel : 'Unavailable'}</Text>
                              </View>
                            </View>
                          );
                        }

                        const meters = hasDistance ? distanceMetersByCourtInfoId[id] : null;
                        const secs = hasDuration ? durationSecondsByCourtInfoId[id] : null;
                        const kmLabel = meters != null ? (formatKmFromMeters(meters) ?? 'Unavailable') : 'Unavailable';
                        const travelLabel = secs != null ? (formatDuration(secs) ?? 'Unavailable') : 'Unavailable';
                        const walkSecs = meters != null ? estimateWalkSecondsFromMeters(meters) : null;
                        const walkLabel = walkSecs != null ? (formatDuration(walkSecs) ?? 'Unavailable') : 'Unavailable';

                        return (
                          <View style={styles.transportBox}>
                            <View style={styles.transportRow}>
                              <View style={styles.transportLeft}>
                                <Image source={ICONS.distance} style={styles.transportIcon} />
                                <Text style={styles.transportLabel}>Distance</Text>
                              </View>
                              <Text style={styles.transportValue}>{kmLabel}</Text>
                            </View>

                            <View style={styles.transportRow}>
                              <View style={styles.transportLeft}>
                                <Image source={ICONS.motorbike} style={styles.transportIcon} />
                                <Text style={styles.transportLabel}>Travel time</Text>
                              </View>
                              <Text style={styles.transportValue}>{travelLabel}</Text>
                            </View>

                            <View style={styles.transportRowLast}>
                              <View style={styles.transportLeft}>
                                <Image source={ICONS.walk} style={styles.transportIcon} />
                                <Text style={styles.transportLabel}>Walk time</Text>
                              </View>
                              <Text style={styles.transportValue}>{walkLabel}</Text>
                            </View>
                          </View>
                        );
                      })()}

                      {/* Images Section */}
                      <Text style={styles.sectionHeader}>Images</Text>
                      {selectedMarker.images && selectedMarker.images.length > 0 ? (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imagesRow}>
                          {selectedMarker.images.map((image, idx) => (
                            <Image
                              key={idx}
                              source={{ uri: image }}
                              style={styles.detailImageTile}
                            />
                          ))}
                        </ScrollView>
                      ) : (
                        <View style={styles.placeholderSection}>
                          <Text style={styles.placeholderText}>No images available yet.</Text>
                        </View>
                      )}

                      {/* Reviews Section */}
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => setReviewsExpanded((p) => !p)}
                        style={styles.transportHeader}
                      >
                        <Text style={[styles.sectionHeader, styles.transportHeaderTitle]}>Reviews</Text>
                        <Image
                          source={ICONS.arrowdown}
                          style={[styles.transportHeaderArrow, reviewsExpanded ? styles.transportArrowOpen : null]}
                        />
                      </TouchableOpacity>

                      {reviewsExpanded && (
                        <View style={styles.placeholderSection}>
                          <Text style={styles.placeholderText}>Placeholder for user review :D</Text>
                        </View>
                      )}
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
    distanceHeader: {
      paddingHorizontal: 6,
      paddingBottom: 8,
    },
    distanceHeaderTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: COLORS.slate900,
      marginBottom: 6,
    },
    distanceInput: {
      borderWidth: 1,
      borderColor: COLORS.neutral450,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: COLORS.slate900,
      backgroundColor: COLORS.neutral0,
    },
    distanceInputError: {
      borderColor: COLORS.red,
    },
    distanceErrorText: {
      marginTop: 6,
      color: COLORS.red,
      fontSize: 12,
      fontWeight: "600",
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
      zIndex: 70, // keep above MapView (Android needs elevation too)
      elevation: 8,
      shadowColor: "#000",
      shadowOpacity: 0.12,
      shadowRadius: 8,
      padding: 8,
    },
    listItem: {
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: "#ddd",
    },
    listItemRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    listItemTextCol: {
      flex: 1,
      minWidth: 0,
    },
    listItemTitle: {
      fontSize: 16,
      fontWeight: "bold",
    },
    listItemSubtitle: {
      fontSize: 14,
      color: "#666",
    },
    listItemDistanceRight: {
      fontSize: 13,
      color: "#666",
      fontWeight: "600",
      marginTop: 2,
      flexShrink: 0,
      textAlign: "right",
    },
    noResultsText: {
      paddingVertical: 10,
      paddingHorizontal: 6,
      color: COLORS.slate600,
      fontSize: 14,
      fontWeight: "600",
    },
    bottomSheetBackground: {
      backgroundColor: COLORS.white,
    },
    bottomSheetContent: {
      alignItems: "flex-start",
      padding: 16,
      position: "relative",
      paddingBottom: 96,
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
      marginTop: 10,
      marginBottom: 16,
    },
    markerAddressLabel: {
      fontWeight: 'bold',
      color: "#666",
    },
    priceText: {
      fontSize: 18,
      fontWeight: 'bold',
      color: '#333',
      marginBottom: 6,
    },
    scheduleBox: {
      width: '100%',
      backgroundColor: COLORS.neutral0,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: COLORS.neutral450,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    scheduleTimeText: {
      fontSize: 14,
      fontWeight: '700',
      color: COLORS.slate900,
      marginBottom: 10,
    },
    scheduleTimeTextInline: {
      marginBottom: 0,
      marginRight: 10,
      flex: 1,
    },
    scheduleDaysRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    scheduleDayPill: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: COLORS.neutral350,
      backgroundColor: COLORS.white,
      marginRight: 8,
      marginBottom: 8,
    },
    scheduleDayPillDisabled: {
      opacity: 0.35,
    },
    scheduleDayText: {
      fontSize: 13,
      fontWeight: '700',
      color: COLORS.slate600,
    },
    imagesRow: {
      paddingVertical: 6,
      paddingRight: 16,
    },
    detailImageTile: {
      width: DETAIL_IMAGE_TILE_WIDTH,
      height: DETAIL_IMAGE_TILE_HEIGHT,
      borderRadius: 12,
      marginRight: 12,
      backgroundColor: '#eee',
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
    transportHeader: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: 16,
      paddingBottom: 8,
    },
    transportHeaderTitle: {
      marginTop: 0,
      marginBottom: 0,
      marginRight: 8,
    },
    transportHeaderArrow: {
      width: 16,
      height: 16,
      resizeMode: 'contain',
      tintColor: COLORS.slate600,
      transform: [{ rotate: '0deg' }],
      marginTop: 2,
    },
    transportArrowOpen: {
      transform: [{ rotate: '180deg' }],
    },
    transportLoading: {
      width: '100%',
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    transportErrorText: {
      color: COLORS.slate600,
      fontSize: 13,
      fontWeight: '600',
    },
    transportBox: {
      width: '100%',
      backgroundColor: COLORS.neutral0,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: COLORS.neutral450,
      overflow: 'hidden',
    },
    transportRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: COLORS.neutral350,
    },
    transportRowLast: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    transportLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      minWidth: 0,
    },
    transportIcon: {
      width: 22,
      height: 22,
      resizeMode: 'contain',
      marginRight: 10,
    },
    transportLabel: {
      fontSize: 14,
      fontWeight: '700',
      color: COLORS.slate900,
    },
    transportValue: {
      fontSize: 14,
      fontWeight: '700',
      color: COLORS.slate600,
      marginLeft: 12,
      flexShrink: 0,
      textAlign: 'right',
    },
    modalOverlay: { position: 'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.35)', justifyContent:'center', alignItems:'center' },
    modalCard: { width:'85%', backgroundColor:'#fff', padding:20, borderRadius:14, elevation:6 },
    modalTitle: { fontSize:16, fontWeight:'700', marginBottom:8, color:'#222' },
    modalActions: { flexDirection:'row', justifyContent:'flex-end', marginTop:18 },
    modalBtn: { paddingVertical:10, paddingHorizontal:18, borderRadius:10, marginLeft:10 },
    modalCancel: { backgroundColor:'#eee' },
    modalBtnText: { fontSize:14, fontWeight:'600', color:'#222' },
    weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
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
