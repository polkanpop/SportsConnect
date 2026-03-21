
import { ICONS } from "@/constants/icons";
import { COLORS } from "@/constants/colors";
import { useRouter, useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import { Image as ExpoImage } from 'expo-image'
import * as Location from 'expo-location'
import { Animated, Dimensions, Image, Modal, Pressable, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  FavouriteCourt,
  listCourtInfoByCourtIdsCached,
  listEventsCombinedCached,
  CourtInfoRow,
  type CombinedEvent,
} from "@/lib/backendApi";
import { optimizeRemoteImageUrl } from '@/lib/imageOptimize'
import { favouritesEvents } from "@/lib/favouritesEvents";
import { useAppBootstrap } from "@/providers/app-bootstrap-provider";
import ManagementPanel, { type ManagementPanelKey } from "@/components/ManagementPanel";
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import EventPanel from "@/app/event/eventPanel";
import CourtPanel from "@/app/event/courtPanel";
import ReviewsPanel from "@/app/event/reviewsPanel";
import { SkeletonBox, SkeletonPulse } from '@/components/ui/skeleton'

export default function Home() {
  const router = useRouter();
  const { panel: panelParam, courtid: deeplinkCourtIdParam, courtbookingid: deeplinkCourtBookingIdParam } = useLocalSearchParams<{ panel?: string; courtid?: string; courtbookingid?: string }>();
  const deeplinkCourtId = deeplinkCourtIdParam ? (Number(deeplinkCourtIdParam) || null) : null
  const deeplinkCourtBookingId = deeplinkCourtBookingIdParam ? (Number(deeplinkCourtBookingIdParam) || null) : null

  const [activeView, setActiveView] = useState<ManagementPanelKey>('user');
  const [eventPanelMounted, setEventPanelMounted] = useState(false);
  const [courtPanelMounted, setCourtPanelMounted] = useState(false);
  const [reviewsPanelMounted, setReviewsPanelMounted] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [managementPanelExpanded, setManagementPanelExpanded] = useState(false);
  const [uiLanguage, setUiLanguage] = useState<'en' | 'vi'>('en');
  const drawerW = Math.min(320, Math.max(260, Dimensions.get('window').width * 0.78));
  const drawerX = React.useRef(new Animated.Value(-drawerW)).current;

  const openMenu = () => {
    setMenuVisible(true);
    Animated.timing(drawerX, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  };
  const closeMenu = () => {
    Animated.timing(drawerX, { toValue: -drawerW, duration: 180, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMenuVisible(false);
    });
  };

  // Deep-link receiver: Notification tab can push panel=court to open court management directly.
  useEffect(() => {
    if (panelParam === 'court') {
      setActiveView('court');
      setManagementPanelExpanded(true);
    }
  }, [panelParam]);

  // Time logic
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000 * 60);
    return () => clearInterval(interval);
  }, []);

  const getTimeIcon = () => {
    const h = now.getHours();
    if (h >= 5 && h < 12) return ICONS.sunrise;
    if (h >= 12 && h < 18) return ICONS.sunset;
    return ICONS.night;
  };

  const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateString = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });


  const categoryLabelStyle = {
    fontWeight: "600" as const,
    fontSize: 14,
    marginTop: 6,
    textAlign: "center" as const,
    color: '#111',
  };

  // Category data with navigation routes
  const categories = [
    {
      icon: ICONS.coachIcon,
      label: "Coach",
      color: COLORS.orangeSoft,
      iconStyle: { width: 50, height: 50 },
      labelStyle: categoryLabelStyle,
      route: "/event/tsList",
    },
    {
      icon: ICONS.event_category,
      label: "Event",
      color: COLORS.orangeSoft,
      iconStyle: { width: 50, height: 50 },
      labelStyle: categoryLabelStyle,
      route: "/event/eventList",
    },
    {
      icon: ICONS.court,
      label: "Court",
      color: COLORS.orangeSoft,
      iconStyle: { width: 50, height: 50 },
      labelStyle: categoryLabelStyle,
      // Updated to point to the new simplified court list screen
      route: "/event/courtList",
    },
  ];

  // Favourites resolved with court display info
  type FavoriteLocation = {
    favouriteid: number;
    courtid: number;
    name: string;
    availability: string; // used only for color, no labels/sorting
    imageUri?: string | null;
  };
  const [pullRefreshingFavs, setPullRefreshingFavs] = useState(false);

  const { userId: bootstrapUserId, dashboard, userInfo: bootstrapUserInfo, favouriteCourts } = useAppBootstrap()
  const dashboardRaw = dashboard.data
  const refetchDashboard = dashboard.refetch
  const userInfo = bootstrapUserInfo.data ?? null
  const userId = typeof bootstrapUserId === 'number' ? bootstrapUserId : null

  // Always fetch the global public events list via the shared queryKeys.eventsCombined key.
  // This ensures every user account sees all public events (not just ones tied to their own
  // court bookings), and post-creation invalidateQueries({ queryKey: queryKeys.eventsCombined })
  // in eventCreate.tsx triggers an immediate refetch on the creator's device.
  const eventsQuery = useQuery<CombinedEvent[]>({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    enabled: !!userId,
    staleTime: 60_000,
    gcTime: 5 * 60 * 1000,
  })

  const eventsCombined = Array.isArray(eventsQuery.data) ? eventsQuery.data : []

  const [nearbyEventsOrigin, setNearbyEventsOrigin] = useState<{ latitude: number; longitude: number } | null>(null)
  const [locationResolved, setLocationResolved] = useState(false)

  const isPlaceholderImageUri = (uri: string): boolean => {
    const u = uri.trim().toLowerCase();
    if (!u) return true;
    return (
      u.includes('via.placeholder.com') ||
      u.includes('placeholder.com') ||
      u.includes('placehold.co') ||
      u.includes('dummyimage.com')
    );
  };

  const normalizeImageUri = (uri: unknown): string | null => {
    if (typeof uri !== 'string') return null;
    const trimmed = uri.trim();
    if (!trimmed) return null;
    if (isPlaceholderImageUri(trimmed)) return null;
    return trimmed;
  };

  const pickFirstRealImageUri = (uris: string[]): string | null => {
    for (const uri of uris) {
      const normalized = normalizeImageUri(uri);
      if (normalized) return normalized;
    }
    return null;
  };

  const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const toRad = (deg: number) => (deg * Math.PI) / 180
    const R = 6371 // km
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  function parseMaybeTimestamp(raw: unknown): Date | null {
    if (typeof raw !== 'string') return null
    const s = raw.trim()
    if (!s) return null

    // Fast path (ISO or JS-parseable)
    let d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d

    // Common Postgres format: "YYYY-MM-DD HH:mm:ss" (Hermes can treat this as Invalid Date)
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/)
    if (m) {
      d = new Date(`${m[1]}T${m[2]}:00`)
      if (!Number.isNaN(d.getTime())) return d
    }

    return null
  }

  const isUpcomingEvent = (ev: CombinedEvent) => {
    const st = String(
      (ev as any)?.status ??
      (ev as any)?.event_status ??
      (ev as any)?.bookingstatus ??
      ''
    ).toLowerCase().trim()
    if (st.includes('cancel') || st.includes('complete') || st.includes('missed')) return false
    // Only filter by time if we have a reliable start_timestamp resolved from the court booking.
    // Falling back to ev.time (the raw events.time column) is unsafe — it often holds a stale
    // creation date for test data, causing every event whose booking wasn't fetched to disappear.
    const startRaw = String((ev as any)?.start_timestamp ?? '').trim()
    const endRaw = String((ev as any)?.end_timestamp ?? '').trim()
    const start = parseMaybeTimestamp(startRaw)
    const end = parseMaybeTimestamp(endRaw)
    const nowTs = Date.now()

    if (end && !Number.isNaN(end.getTime())) return end.getTime() >= nowTs
    if (start && !Number.isNaN(start.getTime())) return start.getTime() >= nowTs
    return true
  }

  const getEventCoords = (ev: CombinedEvent) => {
    const latRaw =
      (ev as any)?.latitude ??
      (ev as any)?.lat ??
      (ev as any)?.court_latitude ??
      (ev as any)?.courtinfo?.latitude ??
      (ev as any)?.location?.latitude
    const lonRaw =
      (ev as any)?.longitude ??
      (ev as any)?.lng ??
      (ev as any)?.court_longitude ??
      (ev as any)?.courtinfo?.longitude ??
      (ev as any)?.location?.longitude

    const lat = typeof latRaw === 'number' ? latRaw : Number(latRaw)
    const lon = typeof lonRaw === 'number' ? lonRaw : Number(lonRaw)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  }

  const asStringArrayLoose = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof v !== 'string') return [];
    const s = v.trim();
    if (!s) return [];
    // JSON array
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean);
      } catch {
        // ignore
      }
    }
    // Postgres array like {a,b}
    if (s.startsWith('{') && s.endsWith('}')) {
      return s
        .slice(1, -1)
        .split(',')
        .map((x) => x.replace(/^"|"$/g, '').trim())
        .filter(Boolean);
    }
    // Comma-separated fallback
    if (s.includes(',')) return s.split(',').map((x) => x.trim()).filter(Boolean);
    return [s];
  };

  const formatKmLabel = (km: number | null | undefined) => {
    if (km == null || !Number.isFinite(km)) return null
    const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km)
    return `${String(rounded).replace('.', ',')} km`
  }

  const formatEventDateTimeLine = (ev: CombinedEvent) => {
    const startRaw = String((ev as any)?.start_timestamp ?? (ev as any)?.time ?? '').trim()
    const endRaw = String((ev as any)?.end_timestamp ?? '').trim()
    const start = parseMaybeTimestamp(startRaw)
    const end = parseMaybeTimestamp(endRaw)
    if (!start || Number.isNaN(start.getTime())) return null

    const pad2 = (n: number) => String(n).padStart(2, '0')
    const startTime = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`
    let timeRange = startTime
    if (end && !Number.isNaN(end.getTime())) {
      const endTime = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`
      timeRange = `${startTime}–${endTime}`
    }

    const dateLabel = start
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .replace(',', '')
    return `${timeRange} · ${dateLabel}`
  }

  const normalizeText = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const s = value.trim()
    if (!s) return null
    const low = s.toLowerCase()
    if (low === 'null' || low === 'undefined' || low === 'n/a') return null
    return s
  }

  const getEventTitle = (ev: CombinedEvent): string | null => {
    const candidates: unknown[] = [
      (ev as any)?.title,
      (ev as any)?.event_title,
      (ev as any)?.eventname,
      (ev as any)?.event_name,
      (ev as any)?.name,
      (ev as any)?.eventinfo?.title,
      (ev as any)?.event_info?.title,
      (ev as any)?.eventInfo?.title,
      (ev as any)?.meta?.title,
      (ev as any)?.info?.title,
      (ev as any)?.court_name,
    ]
    for (const c of candidates) {
      const t = normalizeText(c)
      if (t) return t
    }
    return null
  }

  const missingEventTitleIds = React.useMemo(() => {
    const ids = new Set<number>()
    for (const ev of eventsCombined) {
      const eventId = Number((ev as any)?.eventid)
      if (!Number.isFinite(eventId)) continue
      if (getEventTitle(ev)) continue
      ids.add(eventId)
    }
    return Array.from(ids)
  }, [eventsCombined])

  const eventTitleFallbackQuery = useQuery({
    queryKey: ['home-event-title-fallback', userId, missingEventTitleIds.join(',')],
    enabled: missingEventTitleIds.length > 0,
    queryFn: async () => {
      const rows = await listEventsCombinedCached()
      const map: Record<number, string> = {}
      for (const row of rows) {
        const eventId = Number((row as any)?.eventid)
        if (!Number.isFinite(eventId)) continue
        const title =
          normalizeText((row as any)?.title) ??
          normalizeText((row as any)?.event_title) ??
          normalizeText((row as any)?.eventname) ??
          normalizeText((row as any)?.event_name) ??
          normalizeText((row as any)?.name) ??
          normalizeText((row as any)?.eventinfo?.title) ??
          normalizeText((row as any)?.event_info?.title) ??
          normalizeText((row as any)?.eventInfo?.title) ??
          null
        if (title) map[eventId] = title
      }
      return map
    },
    staleTime: 60_000,
  })

  const eventTitleFallbackMap = eventTitleFallbackQuery.data ?? {}

  const upcomingEvents = React.useMemo(
    () => (Array.isArray(eventsCombined) ? eventsCombined : []).filter(isUpcomingEvent),
    [eventsCombined]
  )

  useEffect(() => {
    let active = true
    const resolveOrigin = async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync()
        if (!active) return
        if (!perm.granted) return

        const lastKnown = await Location.getLastKnownPositionAsync()
        if (!active) return
        const lkLat = lastKnown?.coords?.latitude
        const lkLon = lastKnown?.coords?.longitude
        if (Number.isFinite(lkLat) && Number.isFinite(lkLon)) {
          setNearbyEventsOrigin({ latitude: lkLat as number, longitude: lkLon as number })
        }

        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        if (!active) return
        const userLat = pos?.coords?.latitude
        const userLon = pos?.coords?.longitude
        if (Number.isFinite(userLat) && Number.isFinite(userLon)) {
          setNearbyEventsOrigin({ latitude: userLat as number, longitude: userLon as number })
        }
      } catch {
        // Keep list render non-blocking even if location is slow/fails.
      } finally {
        if (active) setLocationResolved(true)
      }
    }

    setLocationResolved(false)
    void resolveOrigin()
    return () => {
      active = false
    }
  }, [userId])

  const visibleNearbyEvents = React.useMemo(() => {
    if (!nearbyEventsOrigin) return upcomingEvents
    const filtered = upcomingEvents.filter((ev) => {
      const coords = getEventCoords(ev)
      if (!coords) return false
      return haversineKm(nearbyEventsOrigin.latitude, nearbyEventsOrigin.longitude, coords.lat, coords.lon) <= 50
    })
    return filtered.length > 0 ? filtered : upcomingEvents
  }, [upcomingEvents, nearbyEventsOrigin])

  const nearbyEventsLoading = eventsQuery.isLoading
  const nearbyEventsError = eventsQuery.error instanceof Error
    ? eventsQuery.error.message
    : eventsQuery.error
      ? String(eventsQuery.error)
      : null

  const favoriteLocationsQuery = useQuery({
    queryKey: ['home-favorite-locations', userId],
    enabled: !!userId,
    queryFn: async () => {
      const favRows: FavouriteCourt[] = Array.isArray(favouriteCourts)
        ? favouriteCourts
        : []
      if (favRows.length === 0) return [] as FavoriteLocation[]

      const targetCourtIds = favRows.map((fr) => fr.courtid)
      const courtInfoRows: CourtInfoRow[] = await listCourtInfoByCourtIdsCached(targetCourtIds)
      const infoMap = new Map<number, CourtInfoRow>()
      courtInfoRows.forEach((ci) => {
        if (typeof ci.courtid === 'number') infoMap.set(ci.courtid, ci)
      })

      const seenCourtIds = new Set<number>()
      const favs: FavoriteLocation[] = favRows.reduce<FavoriteLocation[]>((acc, fr) => {
        if (seenCourtIds.has(fr.courtid)) return acc
        seenCourtIds.add(fr.courtid)

        const info = infoMap.get(fr.courtid)
        const images = asStringArrayLoose((info as any)?.images)
        const firstImage = pickFirstRealImageUri(images)

        acc.push({
          favouriteid: fr.favouriteid,
          courtid: fr.courtid,
          name: info?.name || `Court ${fr.courtid}`,
          availability: info?.availability || 'Available',
          imageUri: firstImage,
        })
        return acc
      }, [])

      const favsAvailable: FavoriteLocation[] = []
      const favsUnavailable: FavoriteLocation[] = []
      favs.forEach((f) => {
        const isAvail = String(f.availability).toLowerCase() === 'available'
        ;(isAvail ? favsAvailable : favsUnavailable).push(f)
      })

      return [...favsAvailable, ...favsUnavailable]
    },
    staleTime: 60 * 1000,
  })

  const favoriteLocations = favoriteLocationsQuery.data ?? []
  const loadingFavs = favoriteLocationsQuery.isLoading || (favoriteLocationsQuery.isFetching && !pullRefreshingFavs)
  const favError = favoriteLocationsQuery.error instanceof Error
    ? favoriteLocationsQuery.error.message
    : favoriteLocationsQuery.error
      ? String(favoriteLocationsQuery.error)
      : null
  const refetchFavoriteLocations = favoriteLocationsQuery.refetch

  useEffect(() => {
    const unsubscribe = favouritesEvents.subscribe(async ({ userid }) => {
      if (userId != null && userId === userid) {
        await refetchDashboard()
        await refetchFavoriteLocations()
      }
    })
    return unsubscribe
  }, [userId, refetchDashboard, refetchFavoriteLocations])

  // Avoid remounting EventPanel on every hop into "Event" view (prevents constant refetch/refresh UX)
  useEffect(() => {
    if (activeView === 'event') setEventPanelMounted(true);
    if (activeView === 'court') setCourtPanelMounted(true);
    if (activeView === 'reviews') setReviewsPanelMounted(true);
  }, [activeView]);


  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#ffffff" }}>
        {/* Header Section */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "#ffffff",
            paddingBottom: 14,
            paddingHorizontal: 16,
            paddingTop: 8,
            borderBottomWidth: 1,
            borderBottomColor: '#E5E7EB',
          }}
        >
          {/* Menu Icon (Left) */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={openMenu}
          >
            <Image
              source={ICONS.homepageMenu}
              style={{ width: 24, height: 24 }}
              resizeMode="contain"
            />
          </TouchableOpacity>

          {/* Center Time/Date */}
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
             <Image source={getTimeIcon()} style={{ width: 24, height: 24, marginRight: 8 }} resizeMode="contain" />
             <Text style={{ fontSize: 16, fontWeight: '600', color: '#333' }}>
               {timeString}
             </Text>
             <Text style={{ fontSize: 16, fontWeight: '400', color: '#555', marginLeft: 6 }}>
               {dateString}
             </Text>
          </View>

          {/* Profile Icon (Right) */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.push("/event/profile")}
          >
            {userInfo?.pfp ? (
              <Image
                source={{ uri: userInfo.pfp as string }}
                style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: '#E5E7EB' }}
                resizeMode="cover"
              />
            ) : (
              <Image
                source={ICONS.accountCircle}
                style={{ width: 42, height: 42 }}
                resizeMode="contain"
              />
            )}
          </TouchableOpacity>
        </View>

        {/* Body */}
        {activeView === 'user' && (
          <ScrollView
            style={{ flex: 1, backgroundColor: "#ffffff", paddingHorizontal: 8 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 10 }}
            refreshControl={
              <RefreshControl
                refreshing={pullRefreshingFavs}
                onRefresh={async () => {
                  setPullRefreshingFavs(true);
                  try {
                    await Promise.all([
                      refetchDashboard(),
                      eventsQuery.refetch(),
                      refetchFavoriteLocations(),
                    ]);
                  } finally {
                    setPullRefreshingFavs(false);
                  }
                }}
              />
            }
          >
          {/* Categories Section */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-around",
              alignItems: "center",
              paddingVertical: 16,
            }}
          >
            {categories.map((category, index) => (
              <TouchableOpacity
                key={index}
                activeOpacity={0.7}
                onPress={() => router.push(category.route as any)}

              >
                <View
                  style={{
                    width: 80,
                    height: 80,
                    backgroundColor: category.color,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Image
                    source={category.icon}
                    style={category.iconStyle}
                    resizeMode="contain"
                  />
                  <Text style={category.labelStyle}>{category.label}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {/* Your Choices (Favorites) Section */}
          <View style={{ marginBottom: 32 }}>
            <Text style={{ fontWeight: "600", fontSize: 18, marginBottom: 8, paddingHorizontal: 10 }}>
              Your choices
            </Text>
            {favError && (
              <Text style={{ color: 'red', marginBottom: 6 }}>Failed to load favourites: {favError}</Text>
            )}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10, alignItems: 'center' }}
            >
              {loadingFavs && (
                <SkeletonPulse>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {Array.from({ length: 2 }).map((_, idx) => (
                      <SkeletonBox
                        key={idx}
                        width={280}
                        height={160}
                        radius={16}
                        style={{ marginRight: 12 }}
                      />
                    ))}
                  </View>
                </SkeletonPulse>
              )}

              {!loadingFavs && favoriteLocations.length === 0 && (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => router.push('/(tabs)/Map')}
                  style={{
                    paddingHorizontal: 22,
                    paddingVertical: 16,
                    backgroundColor: '#f5f5f5',
                    borderRadius: 20,
                    marginRight: 14,
                    minWidth: 150,
                    minHeight: 62,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: '#e2e2e2'
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#555' }}>Add more...</Text>
                  <Text style={{ fontSize: 12, color: '#888', marginTop: 3 }}>Tap to find your favourite courts!!</Text>
                </TouchableOpacity>
              )}
              {!loadingFavs && favoriteLocations.map(fav => {
                const isAvailable = String(fav.availability).toLowerCase() === 'available';
                const imageUri = normalizeImageUri(fav.imageUri);
                const optimizedImageUri = imageUri
                  ? optimizeRemoteImageUrl(imageUri, { width: 1200, height: 700, quality: 75, resize: 'cover' })
                  : null
                const hasImage = !!optimizedImageUri;
                return (
                  <TouchableOpacity
                    key={fav.favouriteid}
                    activeOpacity={isAvailable ? 0.75 : 1}
                    onPress={() => {
                      if (!isAvailable) return;
                      router.push({ pathname: '/event/courtBooking', params: { courtid: String(fav.courtid) } });
                    }}
                    disabled={!isAvailable}
                    style={{
                      width: 280,
                      height: 160,
                      borderRadius: 16,
                      marginRight: 12,
                      opacity: isAvailable ? 1 : 0.6,
                      overflow: 'hidden',
                      borderWidth: 0,
                      borderColor: 'transparent',
                      shadowColor: hasImage ? '#000' : 'transparent',
                      shadowOffset: hasImage ? { width: 0, height: 4 } : { width: 0, height: 0 },
                      shadowOpacity: hasImage ? 0.32 : 0,
                      shadowRadius: hasImage ? 12 : 0,
                      elevation: hasImage ? 6 : 0,
                    }}
                  >
                    {hasImage ? (
                      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#e6e6e6' }}>
                        <ExpoImage
                          source={{ uri: optimizedImageUri as string }}
                          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                          contentFit="cover"
                          cachePolicy="disk"
                          transition={0}
                          recyclingKey={`${fav.courtid}:${optimizedImageUri as string}`}
                        />
                        <View
                          style={{
                            position: 'absolute',
                            top: 12,
                            right: 12,
                            backgroundColor: 'transparent',
                            padding: 0,
                            borderRadius: 0,
                            borderWidth: 0,
                            borderColor: 'transparent',
                          }}
                        >
                          <Image
                            source={ICONS.starCal}
                            style={{ width: 20, height: 20, tintColor: COLORS.gold }}
                            resizeMode="contain"
                          />
                        </View>

                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: 'rgba(0,0,0,0.55)',
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 10 }}>
                            <Text
                              numberOfLines={1}
                              style={{
                                color: '#fff',
                                fontSize: 13,
                                fontWeight: '800',
                              }}
                            >
                              {fav.name || 'Unnamed'}
                            </Text>
                          </View>

                          <View
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 16,
                              backgroundColor: COLORS.gold,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Image
                              source={ICONS.arrowright}
                              style={{ width: 16, height: 16, tintColor: '#000' }}
                              resizeMode="contain"
                            />
                          </View>
                        </View>
                      </View>
                    ) : (
                      <View style={{ flex: 1, backgroundColor: '#e6e6e6', justifyContent: 'flex-end' }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            backgroundColor: 'rgba(0,0,0,0.55)',
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 10 }}>
                            <Text
                              numberOfLines={1}
                              style={{
                                color: '#fff',
                                fontSize: 13,
                                fontWeight: '800',
                              }}
                            >
                              {fav.name || 'Unnamed'}
                            </Text>
                          </View>

                          <View
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 16,
                              backgroundColor: COLORS.gold,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Image
                              source={ICONS.arrowright}
                              style={{ width: 16, height: 16, tintColor: '#000' }}
                              resizeMode="contain"
                            />
                          </View>
                        </View>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
              {!loadingFavs && favoriteLocations.length > 0 && (
                <TouchableOpacity
                  key="add-more-single"
                  activeOpacity={0.8}
                  onPress={() => router.push('/(tabs)/Map')}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 14,
                    backgroundColor: '#fafafa',
                    borderRadius: 18,
                    marginRight: 12,
                    minWidth: 120,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: '#e6e6e6',
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#666' }}>Add more...</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>

          {/* Event Section */}
          <View style={{ marginBottom: 32 }}>
            <Text style={{ fontWeight: "600", fontSize: 18, marginTop: 14, marginBottom: 12, paddingHorizontal: 10 }}>
              Event
            </Text>
            {nearbyEventsLoading ? (
              <SkeletonPulse>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 10 }}
                >
                  {Array.from({ length: 3 }).map((_, index) => (
                    <SkeletonBox
                      key={index}
                      width={320}
                      height={190}
                      radius={16}
                      style={{ marginRight: index < 2 ? 16 : 0 }}
                    />
                  ))}
                </ScrollView>
              </SkeletonPulse>
            ) : visibleNearbyEvents.length === 0 ? (
              <Text style={{ paddingHorizontal: 10, color: '#666' }}>
                There is no current event
              </Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 10 }}
              >
                {visibleNearbyEvents.slice(0, 10).map((ev) => {
                  const CARD_W = 320
                  const CARD_H = 190
                  const title = getEventTitle(ev) ?? eventTitleFallbackMap[Number((ev as any)?.eventid)] ?? `Event ${ev.eventid}`
                  const dateTimeLine = formatEventDateTimeLine(ev)
                  const origin = nearbyEventsOrigin
                  const coords = getEventCoords(ev)
                  const distanceKm = origin && coords
                    ? haversineKm(origin.latitude, origin.longitude, coords.lat, coords.lon)
                    : null
                  const distanceLabel = distanceKm != null ? formatKmLabel(distanceKm) : null
                  const approxDistanceLabel = distanceLabel ? `≈ ${distanceLabel}` : null

                  const images = asStringArrayLoose((ev as any)?.images)
                  const heroUriRaw = images[0]
                  const heroUri = normalizeImageUri(heroUriRaw)
                  const heroOptimized = heroUri
                    ? optimizeRemoteImageUrl(heroUri, { width: 1200, height: 700, quality: 75, resize: 'cover' })
                    : null

                  return (
                    <TouchableOpacity
                      key={ev.eventid}
                      activeOpacity={0.8}
                      onPress={() => router.push(`/event/eventBooking?eventid=${ev.eventid}` as any)}
                      style={{
                        width: CARD_W,
                        height: CARD_H,
                        borderRadius: 16,
                        backgroundColor: COLORS.neutral0,
                        marginRight: 12,
                        overflow: 'hidden',
                        borderWidth: 1,
                        borderColor: COLORS.neutral350,
                      }}
                    >
                      {/* Header (20%) */}
                      <View
                        style={{
                          backgroundColor: COLORS.neutral0,
                          paddingHorizontal: 12,
                          paddingTop: 8,
                          paddingBottom: 8,
                          minHeight: 56,
                          justifyContent: 'flex-start',
                          borderBottomWidth: 1,
                          borderBottomColor: COLORS.neutral350,
                        }}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            numberOfLines={3}
                            style={{ fontSize: 16, lineHeight: 19, fontWeight: '900', color: COLORS.neutral975 }}
                          >
                            {title}
                          </Text>
                          {!!dateTimeLine && (
                            <Text
                              numberOfLines={1}
                              style={{ marginTop: 4, marginBottom: 0, fontSize: 12, lineHeight: 16, fontWeight: '700', color: COLORS.neutral800 }}
                            >
                              {dateTimeLine}
                            </Text>
                          )}
                        </View>

                      </View>

                      {/* Background image (80%) */}
                      <View style={{ flex: 1, backgroundColor: COLORS.neutral150, position: 'relative' }}>
                        {heroOptimized ? (
                          <ExpoImage
                            source={{ uri: heroOptimized as string }}
                            style={{ width: '100%', height: '100%' }}
                            contentFit="cover"
                            cachePolicy="disk"
                            transition={0}
                            recyclingKey={`event:${ev.eventid}:${heroOptimized as string}`}
                          />
                        ) : (
                          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <Image
                              source={ICONS.event_category}
                              style={{ width: 34, height: 34, tintColor: COLORS.neutral600 }}
                              resizeMode="contain"
                            />
                          </View>
                        )}

                        {!!approxDistanceLabel && (
                          <Text
                            style={{
                              position: 'absolute',
                              right: 12,
                              bottom: 10,
                              fontSize: 14,
                              fontWeight: '900',
                              color: COLORS.brandOrangeDeep,
                            }}
                          >
                            {approxDistanceLabel}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
            )}

            {!!nearbyEventsError && (
              <Text style={{ paddingHorizontal: 10, marginTop: 8, color: COLORS.danger500, fontWeight: '700' }}>
                {nearbyEventsError}
              </Text>
            )}

            {!locationResolved && visibleNearbyEvents.length > 0 && (
              <Text style={{ paddingHorizontal: 10, marginTop: 8, color: '#6B7280', fontWeight: '600' }}>
                Refining nearby distance...
              </Text>
            )}
          </View>
          </ScrollView>
        )}

        <View style={{ flex: 1, display: activeView === 'event' ? 'flex' : 'none' }}>
          {eventPanelMounted ? (
            <EventPanel organizerId={userId} />
          ) : (
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
              <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 }}>
                <SkeletonPulse>
                  <SkeletonBox width={'100%'} height={54} radius={14} />
                </SkeletonPulse>
              </View>
              <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 12 }}>
                <SkeletonPulse>
                  <SkeletonBox width={140} height={22} radius={8} style={{ marginBottom: 12 }} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
                    {Array.from({ length: 2 }).map((_, idx) => (
                      <SkeletonBox
                        key={idx}
                        width={288}
                        height={148}
                        radius={14}
                        style={{ marginRight: 18 }}
                      />
                    ))}
                  </ScrollView>
                  <SkeletonBox width={180} height={22} radius={8} style={{ marginTop: 10, marginBottom: 12 }} />
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <SkeletonBox
                      key={idx}
                      width={'100%'}
                      height={72}
                      radius={12}
                      style={{ marginBottom: 10 }}
                    />
                  ))}
                </SkeletonPulse>
              </View>
            </View>
          )}
        </View>

        <View style={{ flex: 1, display: activeView === 'court' ? 'flex' : 'none' }}>
          {courtPanelMounted ? (
            <CourtPanel ownerId={userId} deeplinkCourtId={deeplinkCourtId} deeplinkCourtBookingId={deeplinkCourtBookingId} />
          ) : (
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
              <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 }}>
                <SkeletonPulse>
                  <SkeletonBox width={'100%'} height={54} radius={14} />
                </SkeletonPulse>
              </View>
              <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 12 }}>
                <SkeletonPulse>
                  <SkeletonBox width={140} height={22} radius={8} style={{ marginBottom: 12 }} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
                    {Array.from({ length: 2 }).map((_, idx) => (
                      <SkeletonBox
                        key={idx}
                        width={288}
                        height={148}
                        radius={14}
                        style={{ marginRight: 18 }}
                      />
                    ))}
                  </ScrollView>
                  <SkeletonBox width={180} height={22} radius={8} style={{ marginTop: 10, marginBottom: 12 }} />
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <SkeletonBox
                      key={idx}
                      width={'100%'}
                      height={56}
                      radius={12}
                      style={{ marginBottom: 10 }}
                    />
                  ))}
                </SkeletonPulse>
              </View>
            </View>
          )}
        </View>

        <View style={{ flex: 1, display: activeView === 'reviews' ? 'flex' : 'none' }}>
          {reviewsPanelMounted ? (
            <ReviewsPanel />
          ) : (
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
              <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 20 }}>
                <SkeletonPulse>
                  <SkeletonBox width={160} height={24} radius={8} style={{ marginBottom: 16 }} />
                  {Array.from({ length: 5 }).map((_, idx) => (
                    <SkeletonBox key={idx} width={'100%'} height={80} radius={12} style={{ marginBottom: 12 }} />
                  ))}
                </SkeletonPulse>
              </View>
            </View>
          )}
        </View>

        {/* Left Drawer Menu */}
        <Modal visible={menuVisible} transparent animationType="none" onRequestClose={closeMenu}>
          <View style={{ flex: 1 }}>
            {/* Tap outside to close */}
            <Pressable
              onPress={closeMenu}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.35)',
              }}
            />

            {/* Drawer */}
            <Animated.View
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: drawerW,
                backgroundColor: '#FFFFFF',
                paddingTop: 18,
                paddingHorizontal: 16,
                transform: [{ translateX: drawerX }],
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, marginBottom: 18 }}>
                <Text style={{ fontSize: 20, lineHeight: 32, fontWeight: '800', color: '#111' }}>Menu</Text>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={closeMenu}
                  style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Image source={ICONS.closeMenu} style={{ width: 20, height: 20, tintColor: '#111' }} resizeMode="contain" />
                </TouchableOpacity>
              </View>

              {/* Language switch (UI only for now) */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, marginTop: 6, marginBottom: 12 }}>
                <Text style={{ flex: 1, marginRight: 12, fontSize: 16, lineHeight: 24, fontWeight: '700', color: '#111' }} numberOfLines={1}>Language</Text>

                <View
                  style={{
                    width: 132,
                    flexDirection: 'row',
                    backgroundColor: '#F3F4F6',
                    borderRadius: 999,
                    padding: 2,
                    borderWidth: 1,
                    borderColor: '#E5E7EB',
                  }}
                >
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => setUiLanguage('vi')}
                    style={{
                      flex: 1,
                      height: 30,
                      borderRadius: 999,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: uiLanguage === 'vi' ? '#FFFFFF' : 'transparent',
                      shadowColor: '#000',
                      shadowOpacity: uiLanguage === 'vi' ? 0.08 : 0,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 3 },
                      elevation: uiLanguage === 'vi' ? 2 : 0,
                    }}
                  >
                    <Text style={{ fontWeight: '600', fontSize: 14, color: uiLanguage === 'vi' ? '#2563EB' : '#9CA3AF' }}>Vi</Text>
                  </TouchableOpacity>
                  <View pointerEvents="none" style={{ width: 1, backgroundColor: '#E5E7EB', marginVertical: 6, opacity: 0.8 }} />
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => setUiLanguage('en')}
                    style={{
                      flex: 1,
                      height: 30,
                      borderRadius: 999,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: uiLanguage === 'en' ? '#FFFFFF' : 'transparent',
                      shadowColor: '#000',
                      shadowOpacity: uiLanguage === 'en' ? 0.08 : 0,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 3 },
                      elevation: uiLanguage === 'en' ? 2 : 0,
                    }}
                  >
                    <Text style={{ fontWeight: '600', fontSize: 14, color: uiLanguage === 'en' ? '#2563EB' : '#9CA3AF' }}>En</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={{ height: 1, backgroundColor: '#E5E7EB', marginBottom: 16 }} />

              <ManagementPanel
                active={activeView as ManagementPanelKey}
                expanded={managementPanelExpanded}
                onExpandedChange={setManagementPanelExpanded}
                onSelect={(key) => {
                  setActiveView(key);
                  closeMenu();
                }}
              />
            </Animated.View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
