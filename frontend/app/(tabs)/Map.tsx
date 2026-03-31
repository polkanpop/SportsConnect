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
    listCourtInfoSpatial,
    type PlayingCourtRow,
    getDistanceMatrixCached,
    peekDistanceMatrixCached,
    listCourtBookingsByCourtId,
    type CourtBookingRow,
    listEventsForMap,
    listTrainingSessionsForMap,
    type MapBounds,
    type MapEventPin,
    type MapTSPin,
  } from '@/lib/backendApi';
  import { favouritesEvents } from '@/lib/favouritesEvents';
  import { getCache, setCache } from '@/lib/cache';
  import { useAuthContext } from '@/hooks/use-auth-context';
  import AsyncStorage from '@react-native-async-storage/async-storage';
  import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
  import * as Location from "expo-location";
  import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
  import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
  import { useFocusEffect, useRouter } from 'expo-router';
  import {
    Dimensions,
    FlatList,
    Image,
    Keyboard,
    Linking,
    Modal,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    TouchableWithoutFeedback,
    View,
    useWindowDimensions,
  } from "react-native";
  
  import { useCourtAvailability, usePlayingCourts, usePlayingCourtImages } from '@/hooks/use-court-data';
  import { useDistanceMatrixPrefetch } from '@/hooks/use-distance-matrix';
  import { useQuery } from '@tanstack/react-query';
  import { queryKeys } from '@/hooks/query-keys';
  import DynamicMap, { type DynamicMapMarker } from '@/components/maps/DynamicMap';
  import { Image as ExpoImage } from 'expo-image'
  import { GestureHandlerRootView, Gesture, GestureDetector, NativeViewGestureHandler } from "react-native-gesture-handler";
  import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
  import { regionToZoom } from '@/lib/goong-map'

  type Region = {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  };

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

  // Initial map region
  const INITIAL_REGION: Region = {
    latitude: 14.0583, // Vietnam center
    longitude: 108.2772,
    latitudeDelta: 10,
    longitudeDelta: 10,
  };

  const VN_BOUNDS = {
    minLat: 7.5,
    maxLat: 24.0,
    minLng: 101.5,
    maxLng: 111.0,
  } as const;

  const VN_MAX_LAT_DELTA = (VN_BOUNDS.maxLat - VN_BOUNDS.minLat);
  const VN_MAX_LNG_DELTA = (VN_BOUNDS.maxLng - VN_BOUNDS.minLng);
  // Keep max zoom-out slightly tighter than whole-country width so panning remains possible.
  const VN_VIEW_MAX_LAT_DELTA = VN_MAX_LAT_DELTA * 0.74;
  const VN_VIEW_MAX_LNG_DELTA = VN_MAX_LNG_DELTA * 0.74;
  const VN_MIN_LAT_DELTA = 0.01;
  const VN_MIN_LNG_DELTA = 0.01;
  const VN_MIN_ZOOM_LEVEL = regionToZoom({ longitudeDelta: VN_VIEW_MAX_LNG_DELTA });
  const VN_MAX_ZOOM_LEVEL = regionToZoom({ longitudeDelta: VN_MIN_LNG_DELTA });
  // Collapsed sheet is 30%; shift focused markers into the upper-third of the visible 70%.
  const MAP_FOCUS_LAT_OFFSET_RATIO = 0.20;
  // Push the map floor up so markers never sit behind the 30% collapsed sheet.
  const MAP_SOUTH_VISUAL_BUFFER_RATIO = 0.08;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  function dedupeStrings(input: any[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const v of Array.isArray(input) ? input : []) {
      if (typeof v !== 'string') continue
      const s = v.trim()
      if (!s) continue
      if (seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
    return out
  }

  function clampRegionToVietnam(region: Region): Region {
    const latitudeDelta = Math.max(VN_MIN_LAT_DELTA, Math.min(region.latitudeDelta, VN_VIEW_MAX_LAT_DELTA));
    const longitudeDelta = Math.max(VN_MIN_LNG_DELTA, Math.min(region.longitudeDelta, VN_VIEW_MAX_LNG_DELTA));

    const halfLat = latitudeDelta / 2;
    const halfLng = longitudeDelta / 2;
    const totalLatSpan = VN_BOUNDS.maxLat - VN_BOUNDS.minLat;
    const centerRangeLat = Math.max(0, totalLatSpan - latitudeDelta);
    const desiredSouthPadding = latitudeDelta * MAP_SOUTH_VISUAL_BUFFER_RATIO;
    // Cap padding so pan range remains positive and smooth.
    const southPadding = Math.min(desiredSouthPadding, centerRangeLat * 0.6);

    const centerLatMin = VN_BOUNDS.minLat + halfLat + southPadding;
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

  function isSameRegion(a: Region, b: Region): boolean {
    const eps = 0.000001
    return (
      Math.abs(a.latitude - b.latitude) < eps &&
      Math.abs(a.longitude - b.longitude) < eps &&
      Math.abs(a.latitudeDelta - b.latitudeDelta) < eps &&
      Math.abs(a.longitudeDelta - b.longitudeDelta) < eps
    )
  }

  function regionToBounds(region: Region) {
    const halfLat = Math.max(0, region.latitudeDelta / 2)
    const halfLng = Math.max(0, region.longitudeDelta / 2)
    return {
      minLat: region.latitude - halfLat,
      maxLat: region.latitude + halfLat,
      minLng: region.longitude - halfLng,
      maxLng: region.longitude + halfLng,
    }
  }

  function sameMarkerList(a: MarkerType[], b: MarkerType[]) {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i]
      const y = b[i]
      if (
        x.id !== y.id ||
        x.courtid !== y.courtid ||
        x.latitude !== y.latitude ||
        x.longitude !== y.longitude ||
        x.isFavorite !== y.isFavorite
      ) {
        return false
      }
    }
    return true
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

  const DETAIL_IMAGE_TILE_WIDTH = Math.round((Dimensions.get('window').width - 36) * 0.82)
  const DETAIL_IMAGE_TILE_HEIGHT = 160

  export default function App() {
    const router = useRouter();
    // Favorite state for selected marker
    const [isFavorite, setIsFavorite] = useState(false);
    // Image zoom
    const [zoomMapImageUri, setZoomMapImageUri] = useState<string | null>(null)
    const zoomWindow = useWindowDimensions()
    const zoomFrameW = Math.max(260, Math.min(Math.round(zoomWindow.width * 0.92), 560))
    const zoomFrameH = Math.max(260, Math.min(Math.round(zoomWindow.height * 0.72), 640))
    const [mapContainerHeight, setMapContainerHeight] = useState(zoomWindow.height)
    const zoomScale = useSharedValue(1)
    const zoomTX = useSharedValue(0)
    const zoomTY = useSharedValue(0)
    const zoomBaseScale = useSharedValue(1)
    const zoomBaseX = useSharedValue(0)
    const zoomBaseY = useSharedValue(0)
    const zoomAnimStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: zoomTX.value }, { translateY: zoomTY.value }, { scale: zoomScale.value }],
    }))
    const zoomGesture = useMemo(() => {
      const pinch = Gesture.Pinch()
        .onUpdate((e) => { zoomScale.value = Math.max(1, Math.min(zoomBaseScale.value * e.scale, 4)) })
        .onEnd(() => {
          zoomScale.value = withTiming(1, { duration: 160 })
          zoomTX.value = withTiming(0, { duration: 160 })
          zoomTY.value = withTiming(0, { duration: 160 })
          zoomBaseScale.value = 1
          zoomBaseX.value = 0
          zoomBaseY.value = 0
        })
      const pan = Gesture.Pan()
        .onUpdate((e) => { if (zoomScale.value <= 1) return; zoomTX.value = zoomBaseX.value + e.translationX; zoomTY.value = zoomBaseY.value + e.translationY })
        .onEnd(() => {
          zoomScale.value = withTiming(1, { duration: 160 })
          zoomTX.value = withTiming(0, { duration: 160 })
          zoomTY.value = withTiming(0, { duration: 160 })
          zoomBaseScale.value = 1
          zoomBaseX.value = 0
          zoomBaseY.value = 0
        })
      return Gesture.Simultaneous(pinch, pan)
    }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomScale, zoomTX, zoomTY])
    useEffect(() => {
      if (!zoomMapImageUri) return
      zoomScale.value = 1; zoomTX.value = 0; zoomTY.value = 0
      zoomBaseScale.value = 1; zoomBaseX.value = 0; zoomBaseY.value = 0
    }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomMapImageUri, zoomScale, zoomTX, zoomTY])
    const bottomSheetRef = useRef<BottomSheet>(null); // Ref to BottomSheet
    const bottomSheetHasOpenedRef = useRef(false); // true after the sheet has been successfully opened once

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
    const [mapRegion, setMapRegion] = useState<Region>(INITIAL_REGION);
    const [cameraCommandId, setCameraCommandId] = useState(0);
    const [calendarModalVisible, setCalendarModalVisible] = useState(false);
    const [weekOffset, setWeekOffset] = useState(0);
    const mapRegionRef = useRef<Region>(INITIAL_REGION);
    const favoriteIdsRef = useRef<number[]>([]);
    const collapsedSheetHeightPx = Math.round(mapContainerHeight * 0.30);
    const floatingButtonsBottom = Math.max(116, collapsedSheetHeightPx + 60);
    const googleButtonBottom = floatingButtonsBottom + 62;

    // Approximate zoom stages for DynamicMap region deltas.
    const ZOOM_STAGE_DELTAS = useRef<Array<{ latitudeDelta: number; longitudeDelta: number }>>([
      { latitudeDelta: INITIAL_REGION.latitudeDelta, longitudeDelta: INITIAL_REGION.longitudeDelta },
      { latitudeDelta: 0.4, longitudeDelta: 0.4 },
      { latitudeDelta: 0.08, longitudeDelta: 0.08 },
    ]);
    const MARKER_FOCUS_STAGE = 2;

    // Filter states
    const [openDropdown, setOpenDropdown] = useState<"venue" | "availability" | "distance" | null>(null);
    const [selectedVenue, setSelectedVenue] = useState<string[]>([]); // multi-select
    const [selectedAvailability, setSelectedAvailability] = useState<string | null>(null); // single-select
    const [selectedDistanceKm, setSelectedDistanceKm] = useState<number | null>(null); // radius filter (km)
    const [distanceKmInput, setDistanceKmInput] = useState<string>('');
    const [distanceKmError, setDistanceKmError] = useState<string | null>(null);
    const [activeSheetTab, setActiveSheetTab] = useState<'Schedule' | 'Transport' | 'Images' | 'Reviews'>('Schedule');

    // Map mode (Courts / Events / Training Sessions)
    const [mapMode, setMapMode] = useState<'courts' | 'events' | 'training'>('courts');
    const [selectedEventPin, setSelectedEventPin] = useState<MapEventPin | null>(null);
    const [selectedTSPin, setSelectedTSPin] = useState<MapTSPin | null>(null);

    // Bounds key: rounded bbox string used as stable React Query key
    const boundsKey = useMemo(() => {
      const { latitude, longitude, latitudeDelta, longitudeDelta } = mapRegion;
      const minLat = Math.round((latitude - latitudeDelta / 2) * 100) / 100;
      const maxLat = Math.round((latitude + latitudeDelta / 2) * 100) / 100;
      const minLng = Math.round((longitude - longitudeDelta / 2) * 100) / 100;
      const maxLng = Math.round((longitude + longitudeDelta / 2) * 100) / 100;
      return `${minLat},${maxLat},${minLng},${maxLng}`;
    }, [mapRegion]);

    const regionToBounds = useCallback((): MapBounds => {
      const { latitude, longitude, latitudeDelta, longitudeDelta } = mapRegion;
      return {
        minLat: latitude - latitudeDelta / 2,
        maxLat: latitude + latitudeDelta / 2,
        minLng: longitude - longitudeDelta / 2,
        maxLng: longitude + longitudeDelta / 2,
      };
    }, [mapRegion]);

    // Event pins for map (only fetched when in events mode)
    const { data: eventPins = [] } = useQuery<MapEventPin[]>({
      queryKey: queryKeys.mapEventsInBounds(boundsKey),
      queryFn: () => listEventsForMap(regionToBounds()),
      enabled: mapMode === 'events',
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    });

    // TS pins for map (only fetched when in training mode)
    const { data: tsPins = [] } = useQuery<MapTSPin[]>({
      queryKey: queryKeys.mapTSInBounds(boundsKey),
      queryFn: () => listTrainingSessionsForMap(regionToBounds()),
      enabled: mapMode === 'training',
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    });

    // Clear per-mode selections when switching modes
    useEffect(() => {
      setSelectedEventPin(null);
      setSelectedTSPin(null);
      if (mapMode !== 'courts') {
        setSelectedMarker(null);
        bottomSheetRef.current?.close();
      }
    }, [mapMode]);

    const [selectedSchedulePlayingCourtId, setSelectedSchedulePlayingCourtId] = useState<number | null>(null);
    const [selectedMapScheduleDate, setSelectedMapScheduleDate] = useState<string | null>(null);


    type DistanceMatrixStatus = 'loading' | 'loaded' | 'error';
    const [distanceMatrixStatusByCourtInfoId, setDistanceMatrixStatusByCourtInfoId] = useState<Record<number, DistanceMatrixStatus>>({});

    // Distance cache keyed by courtinfoid
    const [distanceMetersByCourtInfoId, setDistanceMetersByCourtInfoId] = useState<Record<number, number | null>>({});
    const [durationSecondsByCourtInfoId, setDurationSecondsByCourtInfoId] = useState<Record<number, number | null>>({});
    const inFlightDistanceIdsRef = useRef<Set<number>>(new Set());
    const [distanceMatrixDeferredReady, setDistanceMatrixDeferredReady] = useState(false);

    const focusMapRegion = useCallback((latitude: number, longitude: number, stage: number, animated = true) => {
      const delta = ZOOM_STAGE_DELTAS.current[Math.max(0, Math.min(stage, ZOOM_STAGE_DELTAS.current.length - 1))];
      const nextRegion = clampRegionToVietnam({
        latitude: latitude - (delta.latitudeDelta * MAP_FOCUS_LAT_OFFSET_RATIO),
        longitude,
        latitudeDelta: delta.latitudeDelta,
        longitudeDelta: delta.longitudeDelta,
      });
      mapRegionRef.current = nextRegion;
      setMapRegion(nextRegion);
      if (animated) setCameraCommandId((prev) => prev + 1);
    }, []);

    const handleRegionChangeComplete = useCallback((region: Region) => {
      const clamped = clampRegionToVietnam(region);
      if (isSameRegion(mapRegionRef.current, clamped)) return;
      mapRegionRef.current = clamped;
      setMapRegion(clamped);
      // Do NOT call setCameraCommandId here — that would re-trigger the camera animation
      // every time a programmatic move completes, creating an infinite loop.
    }, []);

    useEffect(() => {
      mapRegionRef.current = mapRegion;
    }, [mapRegion]);

    useEffect(() => {
      favoriteIdsRef.current = favoriteIds;
    }, [favoriteIds]);

    const setMarkerStatesIfChanged = useCallback((nextMarkers: MarkerType[]) => {
      setMarkers((prev) => (sameMarkerList(prev, nextMarkers) ? prev : nextMarkers));
      setFilteredMarkers((prev) => (sameMarkerList(prev, nextMarkers) ? prev : nextMarkers));
    }, []);

    // Snap points for the BottomSheet
    const snapPoints = useMemo(() => ["30%", "70%", "100%"], []);

    // Reset tab state when selecting a new marker
    useEffect(() => {
      if (!selectedMarker) return;
      setActiveSheetTab('Schedule');
      setWeekOffset(0);
      setSelectedMapScheduleDate(null);
    }, [selectedMarker?.id]);

    // Auth context (backend login OR supabase anonymous/social)
    const { profile, session } = useAuthContext();

    // Fetch availability for selected marker
    const { data: availabilityRows, isLoading: availabilityLoading } = useCourtAvailability(selectedMarker?.courtid || null);

    // Fetch bookings for selected court (view-only, for marking booked slots)
    const { data: mapCourtBookings = [] } = useQuery<CourtBookingRow[]>({
      queryKey: ['mapCourtBookings', selectedMarker?.courtid ?? null],
      queryFn: () => listCourtBookingsByCourtId(selectedMarker!.courtid),
      enabled: !!selectedMarker?.courtid,
      staleTime: 30_000,
    })

    // Lazy-load playing courts and their info images using TanStack Query (only fires when a court pin is tapped)
    const { data: rawPlayingCourts, isLoading: playingCourtsLoading } = usePlayingCourts(selectedMarker?.courtid ?? null);
    const playingCourtsForSelected = useMemo(
      () => (Array.isArray(rawPlayingCourts) ? rawPlayingCourts : []) as PlayingCourtRow[],
      [rawPlayingCourts]
    );
    const pcIds = useMemo(
      () => playingCourtsForSelected
        .map((pc: any) => (typeof pc?.playingcourtid === 'number' ? pc.playingcourtid : Number(pc?.playingcourtid)))
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
      [playingCourtsForSelected]
    );
    const { data: rawPlayingCourtImages } = usePlayingCourtImages(selectedMarker?.courtid ?? null, pcIds);
    const playingCourtImagesById = useMemo<Record<number, string[]>>(
      () => rawPlayingCourtImages ?? {},
      [rawPlayingCourtImages]
    );

    const venueDataReady = !!selectedMarker && !availabilityLoading && !playingCourtsLoading;

    // Defer distance matrix fetch so venue details paint first, then distance fades in later.
    useEffect(() => {
      setDistanceMatrixDeferredReady(false);
      if (!venueDataReady) return;
      const timer = setTimeout(() => setDistanceMatrixDeferredReady(true), 500);
      return () => clearTimeout(timer);
    }, [selectedMarker?.id, venueDataReady]);

    // Choose which playingcourt's schedule to display (defaults to first availability row)
    useEffect(() => {
      if (!Array.isArray(availabilityRows) || availabilityRows.length === 0) {
        setSelectedSchedulePlayingCourtId(null);
        return;
      }
      const availIds = availabilityRows
        .map((r: any) => (typeof r?.playingcourtid === 'number' ? r.playingcourtid : Number(r?.playingcourtid)))
        .filter((pid: any): pid is number => typeof pid === 'number' && Number.isFinite(pid));
      const availSet = new Set<number>(availIds);

      // Prefer a FULL part if we have playingcourts loaded.
      const preferredFull = playingCourtsForSelected
        .filter((pc: any) => String(pc?.part || '').toUpperCase() === 'FULL')
        .map((pc: any) => (typeof pc?.playingcourtid === 'number' ? pc.playingcourtid : Number(pc?.playingcourtid)))
        .find((pid: any) => typeof pid === 'number' && Number.isFinite(pid) && availSet.has(pid)) as number | undefined;

      setSelectedSchedulePlayingCourtId(preferredFull ?? (availIds[0] ?? null));
    }, [selectedMarker?.id, availabilityRows, playingCourtsForSelected]);

    const availability = useMemo(() => {
      if (!Array.isArray(availabilityRows) || !availabilityRows.length) return null;

      const normalized = availabilityRows.map((r: any) => {
        let bd = r?.booking_date;
        if (typeof bd === 'string') {
          try { bd = JSON.parse(bd); } catch { bd = []; }
        }
        return { ...r, booking_date: Array.isArray(bd) ? bd : [] };
      });

      if (selectedSchedulePlayingCourtId != null) {
        const match = normalized.find((r: any) => Number(r?.playingcourtid) === selectedSchedulePlayingCourtId);
        if (match) return match;
      }

      return normalized[0];
    }, [availabilityRows, selectedSchedulePlayingCourtId]);

    const scheduleSwitchOptions = useMemo(() => {
      if (!Array.isArray(availabilityRows) || availabilityRows.length < 2) return [] as Array<{ id: number; label: string }>;
      const availIds = availabilityRows
        .map((r: any) => (typeof r?.playingcourtid === 'number' ? r.playingcourtid : Number(r?.playingcourtid)))
        .filter((n: any): n is number => typeof n === 'number' && Number.isFinite(n));
      const availSet = new Set<number>(availIds);

      // If we know sub-courts (base_name), show one option per base_name (prefer FULL).
      if (Array.isArray(playingCourtsForSelected) && playingCourtsForSelected.length) {
        const baseOrder: string[] = [];
        const baseToPcs = new Map<string, PlayingCourtRow[]>();

        for (const pc of playingCourtsForSelected) {
          const base = String((pc as any)?.base_name || (pc as any)?.name || '').trim();
          if (!base) continue;
          if (!baseToPcs.has(base)) {
            baseToPcs.set(base, []);
            baseOrder.push(base);
          }
          baseToPcs.get(base)!.push(pc);
        }

        const opts: Array<{ id: number; label: string }> = [];
        for (const base of baseOrder) {
          const pcs = baseToPcs.get(base) || [];
          const full = pcs.find((x: any) => String(x?.part || '').toUpperCase() === 'FULL');
          const fullId = typeof (full as any)?.playingcourtid === 'number' ? (full as any).playingcourtid : Number((full as any)?.playingcourtid);
          if (Number.isFinite(fullId) && availSet.has(fullId)) {
            opts.push({ id: fullId, label: base });
            continue;
          }

          const firstAvail = pcs
            .map((x: any) => (typeof x?.playingcourtid === 'number' ? x.playingcourtid : Number(x?.playingcourtid)))
            .find((pid: any) => typeof pid === 'number' && Number.isFinite(pid) && availSet.has(pid)) as number | undefined;
          if (firstAvail != null) opts.push({ id: firstAvail, label: base });
        }

        return opts.length > 1 ? opts : [];
      }

      // Fallback: one option per playingcourtid.
      const unique: number[] = [];
      const seen = new Set<number>();
      for (const id of availIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
      }
      return unique.length > 1
        ? unique.map((id, idx) => ({ id, label: `Court ${idx + 1}` }))
        : [];
    }, [availabilityRows, playingCourtsForSelected]);

    const aggregatedImages = useMemo(() => {
      const main = Array.isArray(selectedMarker?.images) ? selectedMarker!.images : [];
      const sub = Object.values(playingCourtImagesById || {}).flat();
      return dedupeStrings([...(main || []), ...(sub || [])]);
    }, [selectedMarker?.images, playingCourtImagesById]);

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

    // 30-min time slots derived from availability window (view-only in Map)
    const mapTimeSlots = useMemo((): string[] => {
      if (!availability) return []
      const [sh, sm] = String(availability.start_time || '08:00').split(':').map(Number)
      const [eh, em] = String(availability.end_time || '22:00').split(':').map(Number)
      if (!Number.isFinite(sh) || !Number.isFinite(eh)) return []
      const slots: string[] = []
      for (let m = sh * 60 + sm; m + 30 <= eh * 60 + em; m += 30) {
        slots.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
      }
      return slots
    }, [availability])

    // Compute booked slots for the selected date (approved bookings only)
    const mapBookedSlots = useMemo((): Set<string> => {
      if (!selectedMapScheduleDate || !mapTimeSlots.length) return new Set()
      const slotToMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
      const tsToMin = (raw: string | null | undefined): number | null => {
        const match = String(raw ?? '').match(/(?:T|\s)(\d{2}):(\d{2})/)
        return match ? Number(match[1]) * 60 + Number(match[2]) : null
      }
      const booked = new Set<string>()
      for (const b of mapCourtBookings) {
        const bDate = typeof b.bookingdate === 'string' ? b.bookingdate.slice(0, 10) : null
        if (bDate !== selectedMapScheduleDate) continue
        const bStatus = String((b as any).status ?? '').toLowerCase()
        if (bStatus === 'rejected' || bStatus === 'pending' || bStatus === 'waiting') continue
        const bStart = tsToMin(b.start_timestamp)
        const bEnd = tsToMin(b.end_timestamp)
        if (bStart == null || bEnd == null) continue
        for (const slot of mapTimeSlots) {
          const sMin = slotToMin(slot)
          if (sMin >= bStart && sMin + 30 <= bEnd) booked.add(slot)
        }
      }
      return booked
    }, [selectedMapScheduleDate, mapTimeSlots, mapCourtBookings])

    // Auto-expand BottomSheet to full height when a day is selected so all time slots are visible
    useEffect(() => {
      if (selectedMapScheduleDate) {
        bottomSheetRef.current?.snapToIndex(2)
      }
    }, [selectedMapScheduleDate])

    // Reset week offset when modal opens
    useEffect(() => {
      if (calendarModalVisible) {
        setWeekOffset(0);
      }
    }, [calendarModalVisible]);

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
        const courtInfoIdRaw: any = (m as any)?.courtinfoid
        const courtIdRaw: any = (m as any)?.courtid
        const courtinfoid = typeof courtInfoIdRaw === 'number' ? courtInfoIdRaw : (typeof courtInfoIdRaw === 'string' ? Number(courtInfoIdRaw) : NaN)
        const courtid = typeof courtIdRaw === 'number' ? courtIdRaw : (typeof courtIdRaw === 'string' ? Number(courtIdRaw) : NaN)
        const latRaw: any = (m as any)?.latitude
        const lngRaw: any = (m as any)?.longitude
        const lat = typeof latRaw === 'number' ? latRaw : (typeof latRaw === 'string' ? Number(latRaw) : NaN)
        const lng = typeof lngRaw === 'number' ? lngRaw : (typeof lngRaw === 'string' ? Number(lngRaw) : NaN)
        return ({
          id: Number.isFinite(courtinfoid) ? courtinfoid : 0,
          courtid: Number.isFinite(courtid) ? courtid : 0,
          latitude: Number.isFinite(lat) ? lat : 0,
          longitude: Number.isFinite(lng) ? lng : 0,
          name: m.name || m.address || `Court #${Number.isFinite(courtinfoid) ? courtinfoid : ''}`,
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
        const favIds = favRows
          .map(r => Number((r as any)?.courtid))
          .filter((n): n is number => Number.isFinite(n));
        const favIdSet = new Set(favIds);
        favoriteIdsRef.current = favIds;
        setFavoriteIds(favIds);
        setMarkers(prev => {
          let changed = false;
          const next = prev.map((m) => {
            const nextFav = favIdSet.has(Number((m as any).courtid));
            if (m.isFavorite !== nextFav) changed = true;
            return changed ? { ...m, isFavorite: nextFav } : m;
          });
          return changed ? next : prev;
        });
        setFilteredMarkers(prev => {
          let changed = false;
          const next = prev.map((m) => {
            const nextFav = favIdSet.has(Number((m as any).courtid));
            if (m.isFavorite !== nextFav) changed = true;
            return changed ? { ...m, isFavorite: nextFav } : m;
          });
          return changed ? next : prev;
        });
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
        let normalized: MarkerType[] = [];

        // Phase 1: load visible courts first using spatial bounds.
        if (forceFresh || !rows.length) {
          const bounds = regionToBounds(mapRegionRef.current)
          const phaseOneRows = await listCourtInfoSpatial({
            minLat: bounds.minLat,
            maxLat: bounds.maxLat,
            minLng: bounds.minLng,
            maxLng: bounds.maxLng,
            limit: 350,
          })
          rows = Array.isArray(phaseOneRows) ? phaseOneRows : []
          normalized = normalizeCourtInfoRows(rows)
          setMarkerStatesIfChanged(normalized)

          // Phase 2: silently fetch and merge the full dataset.
          void (async () => {
            try {
              const fullRows = await listCourtInfo()
              if (!Array.isArray(fullRows)) return
              await setCache('cache:courtinfo:v1', fullRows, 60 * 1000)
              const mergedMap = new Map<number, CourtInfoRow>()
              for (const row of rows) {
                const key = Number((row as any)?.courtinfoid)
                if (Number.isFinite(key)) mergedMap.set(key, row)
              }
              for (const row of fullRows) {
                const key = Number((row as any)?.courtinfoid)
                if (Number.isFinite(key)) mergedMap.set(key, row)
              }
              const mergedRows = Array.from(mergedMap.values())
              const favSet = new Set(favoriteIdsRef.current)
              const mergedNormalized = normalizeCourtInfoRows(mergedRows).map((m) => ({
                ...m,
                isFavorite: favSet.has(Number((m as any).courtid)),
              }))
              setMarkerStatesIfChanged(mergedNormalized)
            } catch (phaseTwoError) {
              console.warn('[Map] background phase-2 load failed', phaseTwoError)
            }
          })()
        } else {
          normalized = normalizeCourtInfoRows(rows)
        }

        if (!normalized.length && rows.length) {
          normalized = normalizeCourtInfoRows(rows)
        }

        setMarkerStatesIfChanged(normalized);

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
            favIds = favRows
              .map(r => Number((r as any)?.courtid))
              .filter((n): n is number => Number.isFinite(n));
            favoriteIdsRef.current = favIds;
            setFavoriteIds(favIds);
          } catch (e) {
            console.warn('[Map] failed to load favouritecourts', e);
          }
        }
        if (favIds.length) {
          const favIdSet = new Set(favIds);
          normalized = normalized.map(m => ({ ...m, isFavorite: favIdSet.has(Number((m as any).courtid)) }));
          setMarkerStatesIfChanged(normalized);
        }
      } catch (e: any) {
        setErrorMarkers(e.message || String(e));
        setMarkers([]);
        setFilteredMarkers([]);
      } finally {
        if (showLoading) setLoadingMarkers(false);
      }
    }, [getCurrentNumericUserId, normalizeCourtInfoRows, setMarkerStatesIfChanged]);

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
      setSelectedMarker(null);
      bottomSheetRef.current?.close();
    }, [fetchMarkers, refreshFavouritesOnly]));

    const availabilityOptions = ["Available", "Unavailable"];

    // Center map on user location - called on every tab focus and by the My Location button.
    // Use last-known position for an immediate snap, then update with a fresh GPS fix.
    const handleMyLocationPress = useCallback(async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        // Immediate center from cached position (no GPS wait)
        const lastKnown = await Location.getLastKnownPositionAsync();
        if (lastKnown) {
          setUserLocation(lastKnown);
          focusMapRegion(lastKnown.coords.latitude, lastKnown.coords.longitude, 2);
        }
        // Then refresh with accurate fix
        const fresh = await Location.getCurrentPositionAsync({});
        setUserLocation(fresh);
        focusMapRegion(fresh.coords.latitude, fresh.coords.longitude, 2);
      } catch (e) {
        console.log("Location error:", e);
      }
    }, [focusMapRegion]);

    // Every time the user enters the Map tab, auto-center to their location
    useFocusEffect(useCallback(() => {
      void handleMyLocationPress();
    }, [handleMyLocationPress]));

    // Handle marker when pressed
    const handleMarkerPress = async (marker: MarkerType) => {
      setSelectedMarker(marker);
      setSelectedEventPin(null);
      setSelectedTSPin(null);
      // Favorite state derived from favoriteIds
      setIsFavorite(favoriteIds.includes(marker.courtid));
      focusMapRegion(marker.latitude, marker.longitude, MARKER_FOCUS_STAGE);
      // First open needs a longer delay: the BottomSheet layout measurement hasn't run yet.
      // After that, 50 ms is sufficient for subsequent taps.
      const delay = bottomSheetHasOpenedRef.current ? 50 : 300;
      setTimeout(() => {
        bottomSheetRef.current?.snapToIndex(0);
        bottomSheetHasOpenedRef.current = true;
      }, delay);
    };

    const handleOpenGoogleMaps = useCallback(async () => {
      if (!selectedMarker) return;
      const latitude = Number(selectedMarker.latitude);
      const longitude = Number(selectedMarker.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

      const encodedLabel = encodeURIComponent(selectedMarker.name || 'Destination');
      const webUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
      const nativeUrl = Platform.OS === 'ios'
        ? `comgooglemaps://?q=${latitude},${longitude}`
        : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodedLabel})`;

      try {
        const canOpenNative = await Linking.canOpenURL(nativeUrl);
        await Linking.openURL(canOpenNative ? nativeUrl : webUrl);
      } catch (error) {
        console.warn('[Map] failed to open native maps URL, fallback to web', error);
        await Linking.openURL(webUrl);
      }
    }, [selectedMarker]);

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
      focusMapRegion(marker.latitude, marker.longitude, MARKER_FOCUS_STAGE);
      const delay = bottomSheetHasOpenedRef.current ? 50 : 300;
      setTimeout(() => {
        bottomSheetRef.current?.snapToIndex(0);
        bottomSheetHasOpenedRef.current = true;
      }, delay); // Open BottomSheet after state commits
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
      if (activeSheetTab !== 'Transport') return;
      if (!distanceMatrixDeferredReady) return;
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
    }, [activeSheetTab, distanceMatrixDeferredReady, selectedMarker, userLocation, distanceMetersByCourtInfoId, durationSecondsByCourtInfoId]);

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

    const { distanceStateById: listDistanceStateByCourtInfoId } = useDistanceMatrixPrefetch({
      enabled: !!userLocation && sortedFilteredMarkersForList.length > 0,
      userLocation: userLocation
        ? {
            latitude: userLocation.coords.latitude,
            longitude: userLocation.coords.longitude,
          }
        : null,
      markers: sortedFilteredMarkersForList.map((marker) => ({
        id: marker.id,
        latitude: marker.latitude,
        longitude: marker.longitude,
      })),
      maxPrefetch: 12,
      deferMs: 250,
    });

    const getListDistanceDisplay = useCallback((marker: MarkerType) => {
      const exact = listDistanceStateByCourtInfoId[marker.id];
      if (typeof exact?.distanceMeters === 'number' && Number.isFinite(exact.distanceMeters)) {
        const label = formatKmFromMeters(exact.distanceMeters);
        return label ? { label, exact: true, loading: false } : null;
      }
      const fallback = getDistanceMetersForMarker(marker);
      const fallbackLabel = formatKmFromMeters(fallback);
      if (!fallbackLabel) return null;
      return {
        label: `~${fallbackLabel}`,
        exact: false,
        loading: exact?.status === 'idle' || exact?.status === 'loading',
      };
    }, [getDistanceMetersForMarker, listDistanceStateByCourtInfoId]);

    // Note: we intentionally do NOT prefetch distance-matrix for search results.
    // Transport details still lazy-load on expand; the court list only prefetches the first visible rows.

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
            <View style={{ flex: 1 }} onLayout={(e) => setMapContainerHeight(e.nativeEvent.layout.height)}>
                {/* Map View (render first so overlays appear above on Android) */}
                <DynamicMap
                  style={styles.map}
                  initialRegion={INITIAL_REGION}
                  region={mapRegion}
                  cameraCommandId={cameraCommandId}
                  minZoomLevel={VN_MIN_ZOOM_LEVEL}
                  maxZoomLevel={VN_MAX_ZOOM_LEVEL}
                  maxBounds={{
                    northEast: { latitude: VN_BOUNDS.maxLat, longitude: VN_BOUNDS.maxLng },
                    southWest: { latitude: VN_BOUNDS.minLat, longitude: VN_BOUNDS.minLng },
                  }}
                  scrollEnabled={true}
                  zoomEnabled={true}
                  showsUserLocation={true}
                  showsPointsOfInterest={false}
                  showsBuildings={false}
                  showsIndoors={false}
                  rotateEnabled={false}
                  pitchEnabled={false}
                  onRegionChangeComplete={handleRegionChangeComplete}
                  markers={
                    mapMode === 'courts'
                      ? filteredMarkers.map((marker): DynamicMapMarker => ({
                          id: marker.id,
                          coordinate: { latitude: marker.latitude, longitude: marker.longitude },
                          title: marker.name,
                          description: marker.address,
                          pinColor: selectedMarker?.id === marker.id
                            ? COLORS.green
                            : marker.isFavorite
                              ? COLORS.amber200
                              : COLORS.brandOrangeDeep,
                        }))
                      : mapMode === 'events'
                      ? eventPins.map((pin): DynamicMapMarker => ({
                          id: `event-${pin.eventid}`,
                          coordinate: { latitude: pin.latitude, longitude: pin.longitude },
                          title: pin.title ?? '',
                          description: pin.address ?? '',
                          imageKey: 'event',
                        }))
                      : tsPins.map((pin): DynamicMapMarker => ({
                          id: `ts-${pin.sessionid}`,
                          coordinate: { latitude: pin.latitude, longitude: pin.longitude },
                          title: pin.title ?? '',
                          description: pin.address ?? '',
                          imageKey: 'training',
                        }))
                  }
                  onMarkerPress={(markerId) => {
                    if (mapMode === 'courts') {
                      const marker = filteredMarkers.find((m) => String(m.id) === String(markerId));
                      if (marker) void handleMarkerPress(marker);
                    } else if (mapMode === 'events') {
                      const pin = eventPins.find((p) => `event-${p.eventid}` === String(markerId));
                      if (pin) {
                        setSelectedEventPin(pin);
                        setSelectedTSPin(null);
                        setSelectedMarker(null);
                        focusMapRegion(pin.latitude, pin.longitude, MARKER_FOCUS_STAGE);
                        setTimeout(() => {
                          bottomSheetRef.current?.snapToIndex(0);
                          bottomSheetHasOpenedRef.current = true;
                        }, bottomSheetHasOpenedRef.current ? 50 : 300);
                      }
                    } else {
                      const pin = tsPins.find((p) => `ts-${p.sessionid}` === String(markerId));
                      if (pin) {
                        setSelectedTSPin(pin);
                        setSelectedEventPin(null);
                        setSelectedMarker(null);
                        focusMapRegion(pin.latitude, pin.longitude, MARKER_FOCUS_STAGE);
                        setTimeout(() => {
                          bottomSheetRef.current?.snapToIndex(0);
                          bottomSheetHasOpenedRef.current = true;
                        }, bottomSheetHasOpenedRef.current ? 50 : 300);
                      }
                    }
                  }}
                  onPress={(coordinate) => {
                    const nearest = filteredMarkers.reduce<{ marker: MarkerType | null; dist: number }>(
                      (best, marker) => {
                        const d = haversineMeters(
                          coordinate.latitude,
                          coordinate.longitude,
                          marker.latitude,
                          marker.longitude
                        );
                        return d < best.dist ? { marker, dist: d } : best;
                      },
                      { marker: null, dist: Number.POSITIVE_INFINITY }
                    );
                    if (nearest.marker && nearest.dist <= 120) {
                      void handleMarkerPress(nearest.marker);
                    }
                  }}
                />

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
                          style={{ width:22, height:22, tintColor: showFavoritesOnly ? COLORS.brandOrangeDeep : COLORS.neutral700 }}
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
                    {/* Mode: Courts / Events / Training Sessions */}
                    <TouchableOpacity
                      style={[styles.filterChip, mapMode !== 'courts' && { backgroundColor: COLORS.brandOrangeDeep }]}
                      activeOpacity={0.8}
                      onPress={() => setMapMode((prev) => prev === 'courts' ? 'events' : prev === 'events' ? 'training' : 'courts')}
                    >
                      <View style={styles.filterChipLeft}>
                        <Image
                          source={mapMode === 'events' ? ICONS.markerEvent : mapMode === 'training' ? ICONS.markerTs : ICONS.mapPin}
                          style={[styles.filterIcon, mapMode === 'courts' && { tintColor: COLORS.neutral700 }]}
                        />
                        <Text style={[styles.filterChipText, mapMode !== 'courts' && { color: '#fff' }]}>
                          {mapMode === 'courts' ? 'Courts' : mapMode === 'events' ? 'Events' : 'Training'}
                        </Text>
                      </View>
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
                    renderItem={({ item }) => {
                      const marker = item as MarkerType;
                      const listDistance = getListDistanceDisplay(marker);
                      return (
                        <TouchableOpacity
                          style={styles.listItem}
                          onPress={() => handleFlatListItemPress(marker)}
                        >
                          <View style={styles.listItemRow}>
                            <View style={styles.listItemTextCol}>
                              <Text style={styles.listItemTitle}>{marker.name}</Text>
                              <Text style={styles.listItemSubtitle}>{marker.address}</Text>
                            </View>
                            {!!listDistance && (
                              <Text
                                style={[
                                  styles.listItemDistanceRight,
                                  !listDistance.exact && styles.listItemDistancePending,
                                  listDistance.loading && styles.listItemDistanceLoading,
                                ]}
                              >
                                {listDistance.label}
                              </Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      );
                    }}
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

                {/* Google Maps Redirect Button */}
                {overlaysVisible && selectedMarker && (
                  <TouchableOpacity
                    style={[styles.googleMapsFloatingButton, { bottom: googleButtonBottom }]}
                    onPress={() => { void handleOpenGoogleMaps(); }}
                    activeOpacity={0.85}
                    accessibilityLabel="Open in Google Maps"
                  >
                    <Image source={ICONS.ggmap} style={styles.googleMapsFloatingIcon} />
                  </TouchableOpacity>
                )}

                {/* My Location Button */}
                {overlaysVisible && (
                  <TouchableOpacity style={[styles.myLocationButton, { bottom: floatingButtonsBottom }]} onPress={handleMyLocationPress}>
                    <Image source={ICONS.location_icon} style={styles.myLocationIcon} />
                  </TouchableOpacity>
                )}

                {/* BottomSheet for marker details */}
                <BottomSheet
                  ref={bottomSheetRef}
                  snapPoints={snapPoints}
                  index={-1}
                  bottomInset={0}
                  enableContentPanningGesture
                  enablePanDownToClose={true}
                  onChange={handleSheetChange} // Listen to sheet index change
                  backgroundStyle={styles.bottomSheetBackground}
                >
                  {selectedEventPin ? (
                    <BottomSheetScrollView contentContainerStyle={styles.bottomSheetContent}>
                      <View style={styles.sheetHeaderCard}>
                        <Text style={styles.sheetCoverTitle} numberOfLines={2}>{selectedEventPin.title ?? 'Event'}</Text>
                        <Text style={styles.sheetCoverAddress} numberOfLines={2}>{selectedEventPin.address ?? ''}</Text>
                        {selectedEventPin.court_name ? (
                          <Text style={[styles.sheetCoverAddress, { marginTop: 2 }]}>{selectedEventPin.court_name}</Text>
                        ) : null}
                        <View style={[styles.actionRow, { marginTop: 10 }]}>
                          {selectedEventPin.start_timestamp ? (
                            <Text style={styles.filterChipText}>
                              {new Date(selectedEventPin.start_timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                            </Text>
                          ) : null}
                          {selectedEventPin.entry_fee != null ? (
                            <Text style={[styles.filterChipText, { marginLeft: 10 }]}>
                              {selectedEventPin.entry_fee === 0 ? 'Free' : `${selectedEventPin.entry_fee.toLocaleString()} ₫`}
                            </Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          style={styles.bookingButton}
                          onPress={() => router.push({ pathname: '/event/eventBooking', params: { eventid: String(selectedEventPin.eventid) } })}
                        >
                          <Image source={ICONS.booking} style={styles.bookingIcon} />
                          <Text style={styles.bookingText}>Join</Text>
                        </TouchableOpacity>
                      </View>
                    </BottomSheetScrollView>
                  ) : selectedTSPin ? (
                    <BottomSheetScrollView contentContainerStyle={styles.bottomSheetContent}>
                      <View style={styles.sheetHeaderCard}>
                        <Text style={styles.sheetCoverTitle} numberOfLines={2}>{selectedTSPin.title ?? 'Training Session'}</Text>
                        <Text style={styles.sheetCoverAddress} numberOfLines={2}>{selectedTSPin.address ?? ''}</Text>
                        {selectedTSPin.court_name ? (
                          <Text style={[styles.sheetCoverAddress, { marginTop: 2 }]}>{selectedTSPin.court_name}</Text>
                        ) : null}
                        <View style={[styles.actionRow, { marginTop: 10 }]}>
                          {selectedTSPin.start_timestamp ? (
                            <Text style={styles.filterChipText}>
                              {new Date(selectedTSPin.start_timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                            </Text>
                          ) : null}
                          {selectedTSPin.entry_fee != null ? (
                            <Text style={[styles.filterChipText, { marginLeft: 10 }]}>
                              {selectedTSPin.entry_fee === 0 ? 'Free' : `${selectedTSPin.entry_fee.toLocaleString()} ₫`}
                            </Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          style={styles.bookingButton}
                          onPress={() => router.push({ pathname: '/event/tsBooking', params: { sessionid: String(selectedTSPin.sessionid) } })}
                        >
                          <Image source={ICONS.booking} style={styles.bookingIcon} />
                          <Text style={styles.bookingText}>Join</Text>
                        </TouchableOpacity>
                      </View>
                    </BottomSheetScrollView>
                  ) : selectedMarker ? (
                    <BottomSheetScrollView
                      scrollEnabled
                      contentContainerStyle={[
                        styles.bottomSheetContent,
                        activeSheetTab === 'Images' ? styles.bottomSheetContentImages : null,
                      ]}
                      refreshControl={<RefreshControl refreshing={loadingMarkers} onRefresh={fetchMarkers} />}
                    >
                      {(() => {
                        const coverImageUri = aggregatedImages[0] || null;
                        return (
                          <View style={styles.sheetCoverFrame}>
                            {coverImageUri ? (
                              <ExpoImage
                                source={{ uri: coverImageUri }}
                                style={styles.sheetCoverImage}
                                contentFit="cover"
                              />
                            ) : (
                              <View style={styles.sheetCoverPlaceholder}>
                                <Text style={styles.placeholderText}>No cover image available</Text>
                              </View>
                            )}
                          </View>
                        );
                      })()}

                      <View style={styles.sheetHeaderCard}>
                        <View style={styles.titleRow}> 
                          <Text style={styles.sheetCoverTitle} numberOfLines={2} ellipsizeMode="tail">
                            {selectedMarker.name}
                          </Text>
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
                              const courtId = Number((selectedMarker as any).courtid); // use real courts.courtid
                              if (!Number.isFinite(courtId)) return;
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
                            style={[
                              styles.favoriteIcon,
                              { tintColor: isFavorite ? COLORS.brandOrangeDeep : COLORS.neutral700 },
                            ]}
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

                        <Text style={styles.sheetCoverAddress} numberOfLines={2} ellipsizeMode="tail">
                          Address: {selectedMarker.address}
                        </Text>

                        <View style={styles.sheetTagRow}>
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
                      </View>

                      <View style={styles.sheetTabsRow}>
                        {(['Schedule', 'Transport', 'Images', 'Reviews'] as const).map((tab) => {
                          const active = activeSheetTab === tab;
                          const isLast = tab === 'Reviews';
                          return (
                            <TouchableOpacity
                              key={tab}
                              style={[styles.sheetTabBtn, !isLast && styles.sheetTabBtnDivider, active && styles.sheetTabBtnActive]}
                              onPress={() => setActiveSheetTab(tab)}
                              activeOpacity={0.85}
                            >
                              <Text style={[styles.sheetTabBtnText, active && styles.sheetTabBtnTextActive]}>{tab}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {activeSheetTab === 'Schedule' && (
                        availabilityLoading ? (
                          <View style={styles.placeholderSection}>
                            <Text style={styles.placeholderText}>Loading schedule...</Text>
                          </View>
                        ) : availability ? (
                          <View style={styles.scheduleBox}>
                            {scheduleSwitchOptions.length > 1 && (
                              <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.subCourtSwitchRow}
                              >
                                {scheduleSwitchOptions.map((opt) => {
                                  const active = opt.id === selectedSchedulePlayingCourtId;
                                  return (
                                    <TouchableOpacity
                                      key={opt.id}
                                      style={[styles.subCourtSwitchPill, active && styles.subCourtSwitchPillActive]}
                                      activeOpacity={0.85}
                                      onPress={() => setSelectedSchedulePlayingCourtId(opt.id)}
                                    >
                                      <Text style={[styles.subCourtSwitchText, active && styles.subCourtSwitchTextActive]} numberOfLines={1}>
                                        {opt.label}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </ScrollView>
                            )}

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
                                const isSelected = selectedMapScheduleDate === day.dateStr;

                                return (
                                  <TouchableOpacity
                                    key={index}
                                    onPress={() => isAvailable && setSelectedMapScheduleDate(prev => prev === day.dateStr ? null : day.dateStr)}
                                    activeOpacity={0.85}
                                    style={[
                                      styles.dayCell,
                                      isSelected && { backgroundColor: '#f97316' },
                                      isAvailable && !isSelected && { backgroundColor: '#fef9c3' },
                                      !isAvailable && styles.dayCellDisabled,
                                    ]}
                                  >
                                    <Text style={[styles.dayLabel, isSelected && { color: '#fff' }, isAvailable && !isSelected && { color: '#78350f' }]}>{day.label}</Text>
                                    <Text style={[styles.dayDate, day.isToday && styles.todayUnderline, isSelected && { color: '#fff' }]}>
                                      {day.date.getDate()}
                                    </Text>
                                  </TouchableOpacity>
                                )
                              })}
                            </View>
                            {/* Time slot expansion for selected date (view-only) */}
                            {selectedMapScheduleDate && mapTimeSlots.length > 0 && (
                              <View style={{ marginTop: 10, backgroundColor: '#fff7ed', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#FED7AA' }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', color: '#9a3412', marginBottom: 6 }}>
                                  {`Open: ${String(availability!.start_time || '').slice(0, 5)} – ${String(availability!.end_time || '').slice(0, 5)}`}
                                </Text>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                                  {mapTimeSlots.map((slot) => {
                                    const isBooked = mapBookedSlots.has(slot)
                                    return (
                                      <View key={slot} style={{ width: 52, backgroundColor: isBooked ? '#f97316' : '#1e1e1e', borderRadius: 6, paddingVertical: 4, margin: 2, alignItems: 'center', justifyContent: 'center' }}>
                                        <Text style={{ fontSize: 11, color: '#fff', fontWeight: '600' }}>{slot}</Text>
                                      </View>
                                    )
                                  })}
                                </View>
                              </View>
                            )}
                          </View>
                        ) : (
                          <View style={styles.placeholderSection}>
                            <Text style={styles.placeholderText}>No schedule available yet.</Text>
                          </View>
                        )
                      )}

                      {activeSheetTab === 'Transport' && (() => {
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

                      {activeSheetTab === 'Images' && (aggregatedImages.length > 0 ? (
                        <NativeViewGestureHandler disallowInterruption>
                          <ScrollView
                            horizontal
                            nestedScrollEnabled
                            directionalLockEnabled
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.imagesRow}
                            style={styles.imagesScroller}
                            alwaysBounceHorizontal
                            bounces
                            overScrollMode="always"
                          >
                            {aggregatedImages.map((image, idx) => (
                              <TouchableOpacity key={`${image}:${idx}`} onPress={() => setZoomMapImageUri(image)} activeOpacity={0.9}>
                                <ExpoImage
                                  source={{ uri: image }}
                                  style={styles.detailImageTile}
                                  contentFit="cover"
                                />
                              </TouchableOpacity>
                            ))}
                          </ScrollView>
                        </NativeViewGestureHandler>
                      ) : playingCourtsLoading ? (
                        <View style={styles.placeholderSection}>
                          <Text style={styles.placeholderText}>Loading images...</Text>
                        </View>
                      ) : (
                        <View style={styles.placeholderSection}>
                          <Text style={styles.placeholderText}>No images available yet.</Text>
                        </View>
                      ))}

                      {activeSheetTab === 'Reviews' && (
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
                          isAvailable && { backgroundColor: '#fb923c' },
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

          {/* Image Zoom Modal */}
          <Modal visible={!!zoomMapImageUri} transparent animationType="fade" onRequestClose={() => setZoomMapImageUri(null)}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setZoomMapImageUri(null)}>
                {!!zoomMapImageUri && (
                  <GestureDetector gesture={zoomGesture}>
                    <Animated.Image
                      source={{ uri: zoomMapImageUri }}
                      style={[{ width: zoomFrameW, height: zoomFrameH }, zoomAnimStyle]}
                      resizeMode="contain"
                    />
                  </GestureDetector>
                )}
              </Pressable>
            </GestureHandlerRootView>
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
    otaProofBanner: {
      position: 'absolute',
      top: 8,
      left: 10,
      right: 10,
      zIndex: 999,
      elevation: 12,
      backgroundColor: '#ff0000',
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    otaProofText: {
      color: '#ffffff',
      fontSize: 15,
      fontWeight: '700',
      letterSpacing: 0.6,
      textAlign: 'center',
    },
    otaProofSubText: {
      marginTop: 2,
      color: '#ffecec',
      fontSize: 12,
      fontWeight: '700',
      textAlign: 'center',
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
    listItemDistancePending: {
      color: COLORS.slate500,
    },
    listItemDistanceLoading: {
      opacity: 0.7,
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
      paddingBottom: 80,
    },
    bottomSheetContentImages: {
      paddingBottom: 6,
    },
    sheetCoverFrame: {
      width: '100%',
      height: 182,
      borderRadius: 16,
      overflow: 'hidden',
      marginBottom: 0,
      backgroundColor: COLORS.neutral150,
      position: 'relative',
    },
    sheetHeaderCard: {
      width: '100%',
      marginTop: -56,
      backgroundColor: COLORS.white,
      borderRadius: 16,
      paddingTop: 8,
      paddingBottom: 6,
      paddingHorizontal: 10,
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
      marginBottom: 14,
      zIndex: 6,
    },
    sheetCoverImage: {
      width: '100%',
      height: '100%',
    },
    sheetCoverPlaceholder: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: COLORS.neutral150,
    },
    sheetCoverTitle: {
      flex: 1,
      fontSize: 16,
      fontWeight: '700',
      color: COLORS.neutral975,
      marginRight: 10,
    },
    sheetCoverAddress: {
      marginTop: 6,
      fontSize: 14,
      fontWeight: '600',
      color: COLORS.neutral850,
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
      marginTop: 0,
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
      tintColor: COLORS.brandOrangeDeep,
    },
    bookingButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#FF5733',
      borderRadius: 20,
      paddingVertical: 8,
      paddingHorizontal: 14,
      marginTop: 0,
      height: 36,
    },
    bookingButtonDisabled: {
      backgroundColor: '#ccc',
    },
    bookingIcon: {
      width: 20,
      height: 20,
      marginRight: 6,
      tintColor: '#fff',
    },
    bookingText: {
      color: '#fff',
      fontWeight: 'bold',
      fontSize: 15,
      lineHeight: 18,
      includeFontPadding: false,
      textAlignVertical: 'center',
    },
    placeholderText: {
      fontSize: 16,
      color: "#888",
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      marginTop: 0,
      marginBottom: 2,
      paddingHorizontal: 0,
      justifyContent: 'space-between',
      zIndex: 5,
    },
    markerTitle: {
      fontSize: 17,
      fontWeight: "bold",
      textAlign: "left",
      flexShrink: 1,
      flex: 1,
      marginRight: 12,
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    markerAddress: {
      fontSize: 16,
      color: "#666",
      textAlign: "left",
      marginTop: 10,
      marginBottom: 16,
    },
    googleMapsFloatingButton: {
      position: 'absolute',
      bottom: 360,
      right: 20,
      backgroundColor: COLORS.white,
      borderRadius: 50,
      padding: 8,
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 5,
      zIndex: 20,
    },
    googleMapsFloatingIcon: {
      width: 28,
      height: 28,
      resizeMode: 'contain',
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
    subCourtSwitchRow: {
      paddingBottom: 10,
      paddingRight: 8,
      gap: 8,
    },
    subCourtSwitchPill: {
      maxWidth: 220,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: COLORS.neutral350,
      backgroundColor: COLORS.white,
    },
    subCourtSwitchPillActive: {
      backgroundColor: COLORS.brandOrangeDeep,
      borderColor: COLORS.brandOrangeDeep,
    },
    subCourtSwitchText: {
      fontSize: 13,
      fontWeight: '700',
      color: COLORS.slate600,
    },
    subCourtSwitchTextActive: {
      color: COLORS.white,
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
    imagesScroller: {
      width: '100%',
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
      bottom: 300,
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
      backgroundColor: 'rgba(255,255,255,0.25)',
    },
    // Bottom sheet tag styles
    sheetTagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 4,
      marginBottom: 4,
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
    sheetTabsRow: {
      width: '100%',
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: COLORS.neutral375,
      borderRadius: 12,
      overflow: 'hidden',
      marginTop: 2,
      marginBottom: 12,
      backgroundColor: COLORS.white,
    },
    sheetTabBtn: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: COLORS.white,
    },
    sheetTabBtnDivider: {
      borderRightWidth: 1,
      borderRightColor: COLORS.neutral375,
    },
    sheetTabBtnActive: {
      backgroundColor: COLORS.brandOrangeDeep,
    },
    sheetTabBtnText: {
      fontSize: 14,
      fontWeight: '700',
      color: COLORS.slate600,
    },
    sheetTabBtnTextActive: {
      color: COLORS.white,
    },
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
    modalCancel: { backgroundColor: COLORS.danger },
    modalBtnText: { fontSize:14, fontWeight:'600', color: COLORS.neutral0 },
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
    sectionHeader: { fontSize: 15, fontWeight: '700', marginTop: 16, marginBottom: 8, color: '#333' },
    placeholderSection: { padding: 20, backgroundColor: '#f9f9f9', borderRadius: 8, alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: 10 },
  });
