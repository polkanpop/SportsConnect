import { ICONS } from "@/constants/icons";
import { supabase } from "@/lib/supabase";
import { useCallback, useEffect, useState } from "react";
import { hydrateThenRefresh, setCache } from '@/lib/cache'
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface NotificationRow {
  notificationid: number;
  status: string;
  userid: number;
  message: string;
  time: string; // ISO/timestamp string
  notificationtype: string; // enum in db
  notificationtypeid: number;
  title: string;
}

export default function NotificationsPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await hydrateThenRefresh<NotificationRow[]>(
        'cache:notifications:v1',
        30 * 1000, // fresh TTL
        60 * 1000, // allow cached fallback for a bit, but always refresh UI
        async () => {
          const { data, error } = await supabase
            .from('notifications')
            .select('notificationid,status,userid,message,time,notificationtype,notificationtypeid,title')
            .order('time', { ascending: false })
          if (error || !data) throw new Error(error?.message || 'Failed notifications')
          return data as NotificationRow[]
        },
        (val) => setRows(Array.isArray(val) ? val : [])
      )
    } catch (e: any) {
      setError(e.message || String(e))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Map notificationtype to new categories
  const categories = ["All", "Event", "Coach", "Court"];
  const typeToCategory = (type: string) => {
    switch (type) {
      case "eventbooking":
        return "Event";
      case "tsbooking":
        return "Coach";
      case "coach":
        return "Coach";
      case "courtbooking":
        return "Court";
      default:
        return "Event";
    }
  };
  const filteredNotifications = rows.filter(
    (notif) => selectedCategory === "All" || typeToCategory(notif.notificationtype) === selectedCategory
  );

  const handleNotificationClick = async (id: number) => {
    // Optimistic update to mark read
    setUpdating(id);
    const idx = rows.findIndex(r => r.notificationid === id);
    if (idx === -1) return;
    const original = rows[idx];
    const updated = { ...original, status: "read" };
    setRows(prev => {
      const copy = [...prev];
      copy[idx] = updated;
      return copy;
    });
    // Best-effort cache sync
    try {
      const copy = [...rows]
      copy[idx] = updated as any
      await setCache('cache:notifications:v1', copy, 30 * 1000, 60 * 1000)
    } catch {}
    const { error } = await supabase
      .from("notifications")
      .update({ status: "read" })
      .eq("notificationid", id);
    if (error) {
      // rollback
      setRows(prev => {
        const copy = [...prev];
        copy[idx] = original;
        return copy;
      });
      try {
        const copy = [...rows]
        copy[idx] = original as any
        await setCache('cache:notifications:v1', copy, 30 * 1000, 60 * 1000)
      } catch {}
      setError(error.message);
    }
    setUpdating(null);
  };

  const renderItem = ({ item }: { item: NotificationRow }) => (
    <TouchableOpacity
      style={[
        styles.notificationRow,
        item.status !== "unread" && styles.viewedNotification,
        updating === item.notificationid && styles.updatingRow,
      ]}
      onPress={() => handleNotificationClick(item.notificationid)}
    >
      <View style={styles.notificationLeft}>
        <Image source={ICONS.calendar} style={styles.notificationIcon} />
        <View style={styles.notificationContent}>
          <Text style={styles.notificationTitle}>
            {item.title}
          </Text>
          <Text style={styles.notificationMessage}>{item.message}</Text>
        </View>
      </View>
      <Text style={styles.notificationTime}>{new Date(item.time).toLocaleString()}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#FFF" }}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifications</Text>
      </View>

      {/* Category Tabs */}
      <View style={styles.categoryContainer}>
        {categories.map((category) => (
          <TouchableOpacity
            key={category}
            style={[
              styles.categoryTab,
              selectedCategory === category && styles.selectedCategory,
            ]}
            onPress={() => setSelectedCategory(category)}
          >
            <Text style={styles.categoryText}>{category}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && (
        <View style={styles.loadingWrapper}><ActivityIndicator /></View>
      )}
      {error && (
        <View style={styles.errorWrapper}><Text style={styles.errorText}>{error}</Text></View>
      )}

      {/* Notifications List */}
      <FlatList
        data={filteredNotifications}
        renderItem={renderItem}
        keyExtractor={(item) => item.notificationid.toString()}
        refreshing={loading}
        onRefresh={fetchNotifications}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: "#fff", // Header color
    paddingTop: 5,
    paddingBottom: 25,
    alignItems: "center",
    justifyContent: "center",
    marginBottom:3

  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#000",
  },
  categoryContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 10,
    backgroundColor: "#F0F0F0",
  },
  categoryTab: {
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  selectedCategory: {
    borderBottomWidth: 2,
    borderBottomColor: "#FF5733", // Highlight the selected category
  },
  categoryText: {
    fontSize: 16,
    color: "#333",
  },
  notificationRow: {
    flexDirection: "row",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#EEE",
  },
  viewedNotification: {
    backgroundColor: "#F5F5F5",
  },
  updatingRow: {
    opacity: 0.6,
  },
  notificationLeft: {
    flexDirection: "row",
    flex: 1,
  },
  notificationIcon: {
    width: 30,
    height: 30,
    marginRight: 10,
  },
  notificationContent: {
    flex: 1,
  },
  notificationTitle: {
    fontWeight: "bold",
    fontSize: 16,
  },
  notificationMessage: {
    fontSize: 14,
    color: "#666",
  },
  notificationTime: {
    fontSize: 12,
    color: "#888",
    marginLeft: 10,
  },
  loadingWrapper: {
    paddingVertical: 8,
    alignItems: 'center'
  },
  errorWrapper: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  errorText: {
    color: '#c00'
  }
});