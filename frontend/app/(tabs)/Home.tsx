import { SearchBar } from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "@/lib/supabase"; // legacy only; backend login may not populate supabase session
import { listFavouriteCourts, FavouriteCourt, listCourtInfo, CourtInfoRow } from "@/lib/backendApi";
import { favouritesEvents } from "@/lib/favouritesEvents";
import { useAuthContext } from "@/hooks/use-auth-context";
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function Home() {
  const router = useRouter();

  // Define different label styles based on the icon sizes
  const labelStyles = {
    first: {
      fontWeight: "600" as const,
      fontSize: 14,
      marginTop: 5,
      textAlign: "center" as const,
    },
    second: {
      fontWeight: "600" as const,
      fontSize: 13,
      marginTop: 1,
      marginBottom: 2,
      textAlign: "center" as const,
    },
    third: {
      fontWeight: "600" as const,
      fontSize: 13,
      marginBottom: 10,
      textAlign: "center" as const,
    },
  };

  // Category data with navigation routes
  const categories = [
    {
      icon: ICONS.coach,
      label: "Coach",
      color: "#32CD32",
      iconStyle: { width: 45, height: 45 },
      labelStyle: labelStyles.first,
      route: "/event/tsLit",
    },
    {
      icon: ICONS.event_category,
      label: "Event",
      color: "#FFA500",
      iconStyle: { width: 50, height: 50 },
      labelStyle: labelStyles.second,
      route: "/event/eventList",
    },
    {
      icon: ICONS.court,
      label: "Court",
      color: "#FFB6C1",
      iconStyle: { width: 60, height: 60 },
      labelStyle: labelStyles.third,
      // Updated to point to the new simplified court list screen
      route: "/event/courtList",
    },
  ];

  // Favourites resolved with court display info
  type FavoriteLocation = {
    favouriteid: number;
    courtid: number;
    name: string;
    address: string;
  };
  const [favoriteLocations, setFavoriteLocations] = useState<FavoriteLocation[]>([]);
  const [loadingFavs, setLoadingFavs] = useState(false);
  const [favError, setFavError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const lastLoadAbortRef = React.useRef<AbortController | null>(null);

  // Unified numeric user id resolver (matches Map.tsx logic):
  // 1. Backend profile from AuthContext (login via /auth/login)
  // 2. AsyncStorage persisted @backendProfile
  // 3. Supabase session id if numeric (anonymous or social sign-in rarely numeric)
  const { profile } = useAuthContext();
  const getCurrentNumericUserId = async (): Promise<number | null> => {
    if (profile && typeof (profile as any).userid === 'number') return (profile as any).userid;
    try {
      const raw = await AsyncStorage.getItem('@backendProfile');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.userid === 'number') return parsed.userid;
      }
    } catch {}
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

  const loadFavorites = async () => {
    // Abort any in-flight load to avoid race conditions when user switches rapidly
    if (lastLoadAbortRef.current) {
      lastLoadAbortRef.current.abort();
    }
    const abortController = new AbortController();
    lastLoadAbortRef.current = abortController;
    setLoadingFavs(true);
    setFavError(null);
    try {
      const userId = await getCurrentNumericUserId();
      setCurrentUserId(userId);
      if (abortController.signal.aborted) return; // early exit if aborted mid lookup
      if (userId == null) {
        setFavoriteLocations([]);
        return;
      }
      const rows = await listFavouriteCourts({ userid: userId });
      if (abortController.signal.aborted) return;
      const favRows: FavouriteCourt[] = Array.isArray(rows) ? (rows as any[]).filter(r => typeof r === 'object' && 'courtid' in r) : [];
      if (favRows.length === 0) { setFavoriteLocations([]); return; }
      const courtInfoRows: CourtInfoRow[] = await listCourtInfo();
      if (abortController.signal.aborted) return;
      const infoMap = new Map<number, CourtInfoRow>();
      courtInfoRows.forEach(ci => { if (typeof ci.courtid === 'number') infoMap.set(ci.courtid, ci); });
      // De-duplicate in case of any accidental duplicates from backend (defensive)
      const seenCourtIds = new Set<number>();
      const favs: FavoriteLocation[] = favRows.reduce<FavoriteLocation[]>((acc, fr) => {
        if (seenCourtIds.has(fr.courtid)) return acc;
        seenCourtIds.add(fr.courtid);
        const info = infoMap.get(fr.courtid);
        acc.push({
          favouriteid: fr.favouriteid,
          courtid: fr.courtid,
          name: info?.name || `Court ${fr.courtid}`,
          address: info?.address || '',
        });
        return acc;
      }, []);
      setFavoriteLocations(favs);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // silent abort
      setFavError(e.message || String(e));
    } finally {
      if (!abortController.signal.aborted) setLoadingFavs(false);
    }
  };

  // Initial load
  useEffect(() => { loadFavorites(); }, []);
  // Refresh on screen focus
  useFocusEffect(useCallback(() => { loadFavorites(); }, []));
  // Refresh when profile (and thus potential numeric user id) changes
  useEffect(() => { loadFavorites(); }, [profile]);
  // Subscribe to favourites change events emitted by Map or other screens
  useEffect(() => {
    const unsubscribe = favouritesEvents.subscribe(async ({ userid }) => {
      // Only reload if event matches currently resolved user id
      const activeId = await getCurrentNumericUserId();
      if (activeId != null && activeId === userid) {
        loadFavorites();
      }
    });
    return unsubscribe;
  }, []);


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
            paddingBottom: 12,
            paddingHorizontal: 8,
          }}
        >
          {/* Search Bar */}
          <View style={{ flex: 1 }}>
            <SearchBar placeholder="Search for courts..." />
          </View>

          {/* Profile Icon (Touchable) */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.push("/event/profile")}
          >
            <View
              style={{
                width: 48,
                height: 48,
                backgroundColor: "#d4d4d4",
                borderRadius: 24,
                alignItems: "center",
                justifyContent: "center",
                marginLeft: 8,
              }}
            >
              <Image
                source={ICONS.accountCircle}
                style={{ width: 40, height: 40 }}
                resizeMode="contain"
              />
            </View>
          </TouchableOpacity>
        </View>

        {/* Scroll View Content */}
        <ScrollView
          style={{ flex: 1, backgroundColor: "#ffffff", paddingHorizontal: 8 }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 10 }}
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
            <Text style={{ fontWeight: "600", fontSize: 18, marginBottom: 8 }}>
              Your choices
            </Text>
            {favError && (
              <Text style={{ color: 'red', marginBottom: 6 }}>Failed to load favourites: {favError}</Text>
            )}
            {loadingFavs && (
              <Text style={{ marginBottom: 6 }}>Loading favourites...</Text>
            )}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10, alignItems: 'center' }}
            >
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
                  <Text style={{ fontSize: 10, color: '#888', marginTop: 3 }}>Tap to find your favourite courts!!</Text>
                </TouchableOpacity>
              )}
              {favoriteLocations.map(fav => (
                <TouchableOpacity
                  key={fav.favouriteid}
                  activeOpacity={0.75}
                  onPress={() => {
                    console.log('Pressed favorite location', fav.courtid, fav.name);
                  }}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: '#FFD700',
                    borderRadius: 16,
                    marginRight: 12,
                    minWidth: 120,
                    maxWidth: 160,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 13, fontWeight: '600', color: '#333' }}
                  >
                    {fav.name || 'Unnamed'}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 11, color: '#444' }}
                  >
                    {fav.address || ''}
                  </Text>
                </TouchableOpacity>
              ))}
              {favoriteLocations.length > 0 && (
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
            <Text style={{ fontWeight: "600", fontSize: 18, marginVertical: 8 }}>
              Event
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {[...Array(3)].map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 240,
                    height: 160,
                    backgroundColor: "#d4d4d4",
                    borderRadius: 8,
                    marginRight: index < 2 ? 16 : 0,
                  }}
                />
              ))}
            </ScrollView>
          </View>

          {/* Recommend Section */}
          <View style={{ marginBottom: 32 }}>
            <Text style={{ fontWeight: "600", fontSize: 18, marginVertical: 8 }}>
              Recommend for you
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
            >
              {[...Array(3)].map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 240,
                    height: 160,
                    backgroundColor: "#d4d4d4",
                    borderRadius: 8,
                    marginRight: index < 2 ? 16 : 0,
                  }}
                />
              ))}
            </ScrollView>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
