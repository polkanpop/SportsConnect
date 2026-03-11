import SearchBar from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { router, useFocusEffect } from "expo-router";
import {
  Alert,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { getUserInfoByUserIdCached, authLogout, purgeSessionCaches } from '@/lib/backendApi';
import { supabase } from '@/lib/supabase';

export default function SettingsPage() {
  const [displayName, setDisplayName] = useState<string>('Guest');
  const [loadingName, setLoadingName] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignOutModal, setShowSignOutModal] = useState<boolean>(false);
  const [profilePfp, setProfilePfp] = useState<string | null>(null);

  const refreshName = useCallback(async (opts?: { showRefresh?: boolean }) => {
    const showRefresh = !!opts?.showRefresh;
    setError(null);
    if (showRefresh) setRefreshing(true);
    setLoadingName(true);
    try {
      const raw = await AsyncStorage.getItem('@backendProfile');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.name) setDisplayName(parsed.name);
          // Attempt fresh fetch in case name changed.
          if (parsed?.userid) {
            const row = await getUserInfoByUserIdCached(parsed.userid);
            if (row?.name) setDisplayName(row.name);
            setProfilePfp((row as any)?.pfp ?? null);
          }
        } catch {/* ignore parse errors */}
      } else {
        setDisplayName('Guest');
        setProfilePfp(null);
      }
    } catch (e: any) {
      setError(e.message || 'Failed loading name');
    } finally {
      setLoadingName(false);
      if (showRefresh) setRefreshing(false);
    }
  }, []);

  // Sign out handler
  const handleSignOut = useCallback(async () => {
    try {
      // Attempt backend logout (refresh token revocation)
      const revoked = await authLogout();
      if (!revoked) {
        console.log('[Settings] backend logout returned false (maybe already revoked or missing token)');
      }
      // Supabase sign out (social/anon sessions)
      try {
        const { error } = await supabase.auth.signOut();
        if (error) console.warn('[Settings] supabase signOut error', error.message);
      } catch (e) {
        console.warn('[Settings] supabase signOut threw', (e as any)?.message);
      }
      // Clear all local auth artifacts
      await AsyncStorage.multiRemove(['@backendProfile','@backendAuth','@rememberAuth','@localAuthToken']);
      // Purge all caches & persisted query data to avoid cross-account leakage
      await purgeSessionCaches();
      router.replace('/(auth)/login');
    } catch (e: any) {
      console.error('Unexpected sign out error:', e);
      Alert.alert('Sign Out Error', e.message || 'Unexpected error.');
    }
  }, []);

  const openSignOutModal = useCallback(() => setShowSignOutModal(true), []);
  const closeSignOutModal = useCallback(() => setShowSignOutModal(false), []);
  const confirmAndSignOut = useCallback(async () => {
    await handleSignOut();
    closeSignOutModal();
  }, [handleSignOut, closeSignOutModal]);

  // Refresh when screen focused
  useFocusEffect(useCallback(() => { refreshName({ showRefresh: false }); }, [refreshName]));

  return (
    <View style={{ flex: 1, backgroundColor: "#FFFFFF" }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refreshName({ showRefresh: true })}
          />
        }
      >
        {/* Title */}
        <Text style={styles.title}>Settings</Text>

        {/* Profile */}
        <TouchableOpacity
          style={styles.profileContainer}
          activeOpacity={0.8}
          onPress={() => router.push("/event/profile")}
        >
          {profilePfp ? (
            <Image source={{ uri: profilePfp }} style={styles.profilePhoto} />
          ) : (
            <Image source={ICONS.accountCircle} style={styles.profileIcon} />
          )}
          <Text style={styles.username}>{loadingName ? 'Loading...' : displayName || 'Guest'}</Text>
        </TouchableOpacity>
        {error && <Text style={{ color: '#dc2626', textAlign: 'center', marginBottom: 4 }}>{error}</Text>}

        {/* Search */}
        <SearchBar placeholder="Search in settings..." />

        {/* Section One */}
        <View style={styles.card}>
          <SettingRow icon={ICONS.user} label="Account" onPress={() => router.push('/event/userAccountSetting')} />
          <SettingRow icon={ICONS.notifications} label="Notification" />
          <SettingRow icon={ICONS.lock} label="Data and Privacy" />
          <SettingRow icon={ICONS.settingCourt} label="Court Register" onPress={() => router.push('/event/courtRegister')} />
        </View>

        {/* Section Two */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={openSignOutModal}
          style={styles.signOutButton}
        >
          <View style={styles.signOutButtonLeft}>
            <Image source={ICONS.signout} style={styles.signOutIcon} />
            <Text style={styles.signOutText}>Sign Out</Text>
          </View>
        </TouchableOpacity>
      </ScrollView>

      {/* Sign Out Confirmation Modal */}
      <Modal
        transparent
        animationType="fade"
        visible={showSignOutModal}
        onRequestClose={closeSignOutModal}
      >
        <TouchableWithoutFeedback onPress={closeSignOutModal}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.modalCenteredWrapper} pointerEvents="box-none">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Are you sure you want to sign out ?</Text>
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel, { marginRight: 12 }]}
                onPress={closeSignOutModal}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonCancelText}>Return</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={confirmAndSignOut}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** Setting Row Component */
const SettingRow = ({
  icon,
  label,
  onPress,
}: {
  icon: any;
  label: string;
  onPress?: () => void;
}) => (
  <TouchableOpacity activeOpacity={0.7} style={styles.row} onPress={onPress}>
    <View style={styles.rowLeft}>
      <Image source={icon} style={styles.rowIcon} />
      <Text style={styles.rowText}>{label}</Text>
    </View>
    <Image
      source={ICONS.arrowright}
      style={{ width: 18, height: 18, tintColor: "#555" }}
    />
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  title: {
    fontSize: 25,
    fontWeight: "bold",
    textAlign: "center",
    marginTop: 25,
    marginBottom: 10,
    color: "#000000",
    paddingTop:15
  },

  profileContainer: {
    marginTop: 5,
    alignItems: "center",
  },
  profileIcon: {
    width: 95,
    height: 95,
    tintColor: "#000000",
    marginTop: 0,
  },
  profilePhoto: {
    width: 95,
    height: 95,
    borderRadius: 48,
    marginTop: 0,
    backgroundColor: '#E5E7EB',
  },
  username: {
    marginTop: 0,
    marginBottom: 16,
    fontSize: 17,
    fontWeight: "600",
    color: "#000000",
  },

  card: {
    backgroundColor: "#F2F2F2",
    borderRadius: 18,
    marginTop: 18,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E6E6E6",
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  rowText: {
    fontSize: 16,
    color: "#000",
    marginLeft: 12,
  },
  rowIcon: {
    width: 22,
    height: 22,
    tintColor: "#000",
  },

  signOutButton: {
    marginTop: 28,
    backgroundColor: '#EF4444',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  signOutButtonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  signOutIcon: {
    width: 22,
    height: 22,
    tintColor: '#FFFFFF',
  },
  signOutText: {
    marginLeft: 12,
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  // Modal styles
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalCenteredWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingVertical: 28,
    paddingHorizontal: 22,
    width: '100%',
    maxWidth: 420,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
    textAlign: 'center',
    marginBottom: 22,
  },
  modalButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalButtonCancel: {
    backgroundColor: '#E5E7EB',
  },
  modalButtonConfirm: {
    backgroundColor: '#EF4444',
  },
  modalButtonCancelText: {
    color: '#1F2937',
    fontWeight: '600',
    fontSize: 15,
  },
  modalButtonConfirmText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
});

