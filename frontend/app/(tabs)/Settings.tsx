import SearchBar from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { COLORS } from "@/constants/colors";
import { router, useFocusEffect } from "expo-router";
import { Image as ExpoImage } from 'expo-image'
import {
  Alert,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useMemo, useState } from 'react';
import { getUserInfoByUserIdCached, authLogout, purgeSessionCaches } from '@/lib/backendApi';
import { supabase } from '@/lib/supabase';
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from '@/constants/translations';
import { useLanguage } from '@/providers/language-provider';
import { useVoicePreference } from '@/hooks/use-voice-preference';
import { usePushNotificationPreference } from '@/hooks/use-push-notification-preference';

export default function SettingsPage() {
  const { t } = useTranslation();
  const { lang, toggleLanguage } = useLanguage();
  const isVietnamese = lang === 'vi';
  const { enabled: voiceEnabled, setEnabled: setVoiceEnabled } = useVoicePreference();
  const { enabled: pushEnabled, setEnabled: setPushEnabled } = usePushNotificationPreference();

  const [displayName, setDisplayName] = useState<string>('Guest');
  const [loadingName, setLoadingName] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignOutModal, setShowSignOutModal] = useState<boolean>(false);
  const [profilePfp, setProfilePfp] = useState<string | null>(null);

  // ── Settings search ────────────────────────────────────────────────────
  const [settingsSearch, setSettingsSearch] = useState('');
  const settingsRows = useMemo(() => {
    const rows = [
      { key: 'account', keywords: [t('SETTINGS_ROW_ACCOUNT'), 'account', 'tài khoản', 'profile', 'hồ sơ'].join(' ').toLowerCase() },
      { key: 'notification', keywords: [t('SETTINGS_ROW_NOTIFICATION'), 'notification', 'thông báo'].join(' ').toLowerCase() },
      { key: 'language', keywords: [t('SETTINGS_ROW_LANGUAGE'), 'language', 'ngôn ngữ', t('SETTINGS_LANG_TOGGLE_LABEL')].join(' ').toLowerCase() },
      { key: 'feature', keywords: ['feature', 'tính năng', 'voice', 'giọng nói', 'voice automation', 'push notification'].join(' ').toLowerCase() },
      { key: 'court_register', keywords: [t('SETTINGS_ROW_COURT_REGISTER'), 'court', 'sân', 'register', 'đăng ký'].join(' ').toLowerCase() },
      { key: 'data_privacy', keywords: [t('SETTINGS_ROW_DATA_PRIVACY'), 'data', 'privacy', 'dữ liệu', 'quyền riêng tư'].join(' ').toLowerCase() },
      { key: 'sign_out', keywords: [t('SETTINGS_BTN_SIGN_OUT'), 'sign out', 'đăng xuất', 'logout'].join(' ').toLowerCase() },
    ];
    return rows;
  }, [t]);
  const showRow = useMemo(() => {
    const q = settingsSearch.trim().toLowerCase();
    if (!q) return { account: true, notification: true, language: true, feature: true, court_register: true, data_privacy: true, sign_out: true };
    const result: Record<string, boolean> = {};
    for (const r of settingsRows) {
      result[r.key] = r.keywords.includes(q) || r.keywords.split(' ').some(w => w.startsWith(q));
    }
    return result;
  }, [settingsSearch, settingsRows]);

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
    <SafeAreaView style={{ flex: 1, backgroundColor: "#FFFFFF" }}>
      <View style={styles.header}>
        <View style={styles.headerSideSpacer} />
        <Text style={styles.title}>{t('SETTINGS_TITLE')}</Text>
        <View style={styles.headerSideSpacer} />
      </View>
      <View style={styles.divider} />

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
        {/* Profile */}
        <TouchableOpacity
          style={styles.profileContainer}
          activeOpacity={0.8}
          onPress={() => router.push("/event/profile")}
        >
          {profilePfp ? (
            <ExpoImage source={{ uri: profilePfp }} style={styles.profilePhoto} contentFit="cover" />
          ) : (
            <Image source={ICONS.accountCircle} style={styles.profileIcon} />
          )}
          <Text style={styles.username}>{loadingName ? 'Loading...' : displayName || 'Guest'}</Text>
        </TouchableOpacity>
        {error && <Text style={{ color: '#dc2626', textAlign: 'center', marginBottom: 4 }}>{error}</Text>}

        {/* Search */}
        <View style={styles.searchRow}>
          <View style={styles.searchContainer}>
            <Image source={ICONS.search} style={styles.searchIcon} />
            <TextInput
              placeholder={t('SETTINGS_SEARCH_PLACEHOLDER')}
              placeholderTextColor="#999"
              value={settingsSearch}
              onChangeText={setSettingsSearch}
              style={styles.searchInput}
              returnKeyType="search"
            />
          </View>
        </View>

        {/* Section One: Account + Notification + Language */}
        {(showRow.account || showRow.notification || showRow.language) && (
        <View style={styles.card}>
          {showRow.account && <SettingRow icon={ICONS.user} label={t('SETTINGS_ROW_ACCOUNT')} onPress={() => router.push('/event/accountSettings' as any)} />}
          {showRow.notification && <SettingRow icon={ICONS.notifications} label={t('SETTINGS_ROW_NOTIFICATION')} />}
          {showRow.language && <SettingRowSwitch
            icon={ICONS.language}
            label={t('SETTINGS_ROW_LANGUAGE')}
            sublabel={t('SETTINGS_LANG_TOGGLE_LABEL')}
            value={isVietnamese}
            onValueChange={toggleLanguage}
          />}
        </View>
        )}

        {/* Feature section: Voice Automation + Push Notifications */}
        {showRow.feature && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t('SETTINGS_ROW_FEATURE')}</Text>
          <SettingRowSwitch
            icon={ICONS.microphone}
            label={t('SETTINGS_FEATURE_VOICE_LABEL')}
            sublabel={t('SETTINGS_FEATURE_VOICE_SUBLABEL')}
            value={voiceEnabled}
            onValueChange={() => setVoiceEnabled(!voiceEnabled)}
          />
          <SettingRowSwitch
            icon={ICONS.notifications}
            label={t('SETTINGS_ROW_NOTIFICATION')}
            sublabel=""
            value={pushEnabled}
            onValueChange={() => setPushEnabled(!pushEnabled)}
          />
        </View>
        )}

        {/* Section Two: Court Register + Data & Privacy */}
        {(showRow.court_register || showRow.data_privacy) && (
        <View style={styles.card}>
          {showRow.court_register && <SettingRow icon={ICONS.settingCourt} label={t('SETTINGS_ROW_COURT_REGISTER')} onPress={() => router.push('/event/courtRegister')} />}
          {showRow.data_privacy && <SettingRow icon={ICONS.lock} label={t('SETTINGS_ROW_DATA_PRIVACY')} onPress={() => router.push('/event/dataPrivacy' as any)} />}
        </View>
        )}

        {/* Sign Out */}
        {showRow.sign_out && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={openSignOutModal}
          style={styles.signOutButton}
        >
          <View style={styles.signOutButtonLeft}>
            <Image source={ICONS.signout} style={styles.signOutIcon} />
            <Text style={styles.signOutText}>{t('SETTINGS_BTN_SIGN_OUT')}</Text>
          </View>
        </TouchableOpacity>
        )}
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
            <Text style={styles.modalTitle}>{t('SETTINGS_MODAL_SIGN_OUT_TITLE')}</Text>
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel, { marginRight: 12 }]}
                onPress={closeSignOutModal}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonCancelText}>{t('SETTINGS_MODAL_BTN_RETURN')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={confirmAndSignOut}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonConfirmText}>{t('SETTINGS_MODAL_BTN_CONFIRM')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/** Setting Row Component */
const SettingRow = ({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: any;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}) => (
  <TouchableOpacity
    activeOpacity={disabled ? 1 : 0.7}
    style={[styles.row, disabled && styles.rowDisabled]}
    onPress={disabled ? undefined : onPress}
    disabled={!!disabled}
  >
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

/** Setting Row with a Switch toggle instead of chevron */
const SettingRowSwitch = ({
  icon,
  label,
  sublabel,
  value,
  onValueChange,
}: {
  icon: any;
  label: string;
  sublabel: string;
  value: boolean;
  onValueChange: () => void;
}) => (
  <View style={[styles.row, { borderBottomWidth: 0 }]}>
    <View style={styles.rowLeft}>
      <Image source={icon} style={styles.rowIcon} />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={styles.rowText}>{label}</Text>
        <Text style={[styles.rowSubText, { marginTop: 0, marginLeft: 8 }]}>{sublabel}</Text>
      </View>
    </View>
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: '#D1D5DB', true: COLORS.brandOrangeDeep }}
      thumbColor="#FFFFFF"
    />
  </View>
);

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 14,
    paddingHorizontal: 16,
  },
  headerSideSpacer: {
    width: 78,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.neutral300,
    marginBottom: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
    marginTop: 0,
    marginBottom: 0,
    color: "#000000",
    paddingTop: 0,
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
    fontSize: 16,
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: 4,
    marginTop: 4,
    marginBottom: 2,
  },

  searchRow: {
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 0,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F2F2',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 44,
  },
  searchIcon: {
    width: 18,
    height: 18,
    tintColor: '#999',
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#222',
    paddingVertical: 0,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E6E6E6",
  },
  rowDisabled: {
    opacity: 0.55,
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
  rowSubText: {
    fontSize: 12,
    color: "#888",
    marginLeft: 12,
    marginTop: 1,
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

