
import { ICONS } from "@/constants/icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Animated, Dimensions, Image, Modal, Pressable, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "@/lib/supabase"; // legacy only; backend login may not populate supabase session
import {
  listFavouriteCourts,
  FavouriteCourt,
  listCourtInfoCached,
  CourtInfoRow,
} from "@/lib/backendApi";
import { favouritesEvents } from "@/lib/favouritesEvents";
import { useAuthContext } from "@/hooks/use-auth-context";
import { useUserInfo } from "@/hooks/use-user-info";
import ManagementPanel, { type ManagementPanelKey } from "@/components/ManagementPanel";
import AsyncStorage from '@react-native-async-storage/async-storage';
import EventPanel from "@/app/event/eventPanel";

export default function Home() {
  const router = useRouter();

  const [activeView, setActiveView] = useState<Exclude<ManagementPanelKey, 'court'>>('user');
  const [eventPanelMounted, setEventPanelMounted] = useState(false);
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


  // Define different label styles based on the icon sizes
  const labelStyles = {
    first: {
      fontWeight: "600" as const,
      fontSize: 14,
      marginTop: 5,
      bottom: 1,
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
      icon: ICONS.coachIcon,
      label: "Coach",
      color: "rgba(151, 251, 104, 1)",
      iconStyle: { width: 45, height: 45,top:8 },
      labelStyle: labelStyles.first,
      route: "/event/tsList",
    },
    {
      icon: ICONS.event_category,
      label: "Event",
      color: "#91ffffff",
      iconStyle: { width: 50, height: 50 },
      labelStyle: labelStyles.second,
      route: "/event/eventList",
    },
    {
      icon: ICONS.court,
      label: "Court",
      color: "#ffcc4bff",
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
    availability: string; // used only for color, no labels/sorting
  };
  const [favoriteLocations, setFavoriteLocations] = useState<FavoriteLocation[]>([]);
  const [loadingFavs, setLoadingFavs] = useState(false);
  const [favError, setFavError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const lastLoadAbortRef = React.useRef<AbortController | null>(null);

  const { data: userInfo } = useUserInfo(currentUserId);

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

  const lastUserIdRef = React.useRef<number | null>(null);

  const loadFavorites = async (force: boolean = false) => {
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
      // Skip duplicate fetches for same user unless forced (e.g. after a favourite change)
      if (!force && lastUserIdRef.current === userId) {
        return;
      }
      lastUserIdRef.current = userId;
      // Use non-cached fetch for immediate reflection of changes
      const rows = await listFavouriteCourts({ userid: userId });
      if (abortController.signal.aborted) return;
      const favRows: FavouriteCourt[] = Array.isArray(rows) ? (rows as any[]).filter(r => typeof r === 'object' && 'courtid' in r) : [];
      if (favRows.length === 0) { setFavoriteLocations([]); return; }
      const courtInfoRows: CourtInfoRow[] = await listCourtInfoCached();
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
          availability: info?.availability || 'Available',
        });
        return acc;
      }, []);
      // Sort favourites so "Available" courts appear first while preserving original relative order within groups.
      const favsAvailable: FavoriteLocation[] = [];
      const favsUnavailable: FavoriteLocation[] = [];
      favs.forEach(f => {
        const isAvail = String(f.availability).toLowerCase() === 'available';
        (isAvail ? favsAvailable : favsUnavailable).push(f);
      });
      setFavoriteLocations([...favsAvailable, ...favsUnavailable]);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // silent abort
      setFavError(e.message || String(e));
    } finally {
      if (!abortController.signal.aborted) setLoadingFavs(false);
    }
  };

  // Initial load (forced to ensure we fetch once on mount)
  useEffect(() => { loadFavorites(true); }, []);
  // Load again only if profile user id changes from null to a different number
  useEffect(() => { loadFavorites(false); }, [profile]);
  // Subscribe to favourites change events emitted by Map or other screens
  useEffect(() => {
    const unsubscribe = favouritesEvents.subscribe(async ({ userid }) => {
      // Only reload if event matches currently resolved user id
      const activeId = await getCurrentNumericUserId();
      if (activeId != null && activeId === userid) {
        loadFavorites(true); // force reload after a favourites mutation
      }
    });
    return unsubscribe;
  }, []);

  // Avoid remounting EventPanel on every hop into "Event" view (prevents constant refetch/refresh UX)
  useEffect(() => {
    if (activeView === 'event') setEventPanelMounted(true);
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
            paddingBottom: 12,
            paddingHorizontal: 20,
            paddingTop: 10,
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
            style={{ flex: 1, backgroundColor: "#F0F0F0", paddingHorizontal: 8 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 10 }}
            refreshControl={
              <RefreshControl
                refreshing={loadingFavs}
                onRefresh={() => loadFavorites(true)}
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
              {favoriteLocations.map(fav => {
                const isAvailable = String(fav.availability).toLowerCase() === 'available';
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
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      backgroundColor: isAvailable ? '#FFD700' : '#d4d4d4', // simple color diff only
                      borderRadius: 16,
                      marginRight: 12,
                      minWidth: 120,
                      maxWidth: 180,
                      opacity: isAvailable ? 1 : 0.6,
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
                );
              })}
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
        )}

        <View style={{ flex: 1, display: activeView === 'event' ? 'flex' : 'none' }}>
          {eventPanelMounted && <EventPanel organizerId={currentUserId} />}
        </View>

        {activeView !== 'user' && activeView !== 'event' && (
          <View style={{ flex: 1, backgroundColor: '#F0F0F0', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#666' }}>This panel is coming soon.</Text>
          </View>
        )}

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
                <Text style={{ fontSize: 24, lineHeight: 38, fontWeight: '800', color: '#111' }}>Menu</Text>
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
                <Text style={{ flex: 1, marginRight: 12, fontSize: 20, lineHeight: 28, fontWeight: '800', color: '#111' }} numberOfLines={1}>Language</Text>

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
