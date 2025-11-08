import SearchBar from "@/components/SearchBar";
import { ICONS } from "@/constants/icons";
import { router, useFocusEffect } from "expo-router";
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { getUserInfoByUserId } from '@/lib/backendApi';

export default function SettingsPage() {
  const [displayName, setDisplayName] = useState<string>('Guest');
  const [loadingName, setLoadingName] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshName = useCallback(async () => {
    setError(null);
    setLoadingName(true);
    try {
      const raw = await AsyncStorage.getItem('@backendProfile');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.name) setDisplayName(parsed.name);
          // Attempt fresh fetch in case name changed.
          if (parsed?.userid) {
            const row = await getUserInfoByUserId(parsed.userid);
            if (row?.name) setDisplayName(row.name);
          }
        } catch {/* ignore parse errors */}
      } else {
        setDisplayName('Guest');
      }
    } catch (e: any) {
      setError(e.message || 'Failed loading name');
    } finally {
      setLoadingName(false);
    }
  }, []);

  // Refresh when screen focused
  useFocusEffect(useCallback(() => { refreshName(); }, [refreshName]));

  return (
    <View style={{ flex: 1, backgroundColor: "#FFFFFF" }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Title */}
        <Text style={styles.title}>Settings</Text>

        {/* Profile */}
        <TouchableOpacity
          style={styles.profileContainer}
          activeOpacity={0.8}
          onPress={() => router.push("/event/profile")}
        >
          <Image source={ICONS.accountCircle} style={styles.profileIcon} />
          <Text style={styles.username}>{loadingName ? 'Loading...' : displayName || 'Guest'}</Text>
        </TouchableOpacity>
        {error && <Text style={{ color: '#dc2626', textAlign: 'center', marginBottom: 4 }}>{error}</Text>}

        {/* Search */}
        <SearchBar placeholder="Search in settings..." />

        {/* Section One */}
        <View style={styles.card}>
          <SettingRow icon={ICONS.user} label="Account" />
          <SettingRow icon={ICONS.notifications} label="Notification" />
          <SettingRow icon={ICONS.lock} label="Data and Privacy" />
          <SettingRow icon={ICONS.language} label="Language" />
        </View>

        {/* Section Two */}
        <View style={styles.card}>
          <SettingRow icon={ICONS.supportCentre} label="Contact Support Centre" />
          <SettingRow icon={ICONS.comment} label="Share your feedback" />
          <SettingRow icon={ICONS.checkBoxLight} label="Term of Services" />
          <SettingRow icon={ICONS.users} label="About us" />
        </View>
      </ScrollView>
    </View>
  );
}

/** ✅ Setting Row Component */
const SettingRow = ({
  icon,
  label,
}: {
  icon: any;
  label: string;
}) => (
  <TouchableOpacity activeOpacity={0.7} style={styles.row}>
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
});

