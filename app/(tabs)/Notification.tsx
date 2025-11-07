import { ICONS } from "@/constants/icons";
import { fetchNotifications, Notification } from "@/lib/backendApi";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function NotificationsPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [rows, setRows] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchNotifications();
      // Sort newest first (time descending if available)
      const sorted = [...data].sort((a,b) => {
        if (!a.time || !b.time) return 0;
        return new Date(b.time).getTime() - new Date(a.time).getTime();
      });
      setRows(sorted);
    } catch (e:any) {
      setError(e.message || "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    (notif) => selectedCategory === "All" || typeToCategory(notif.notificationtype || "") === selectedCategory
  );

  const handleNotificationClick = async (id: number) => {
    // Without a backend update route yet, just toggle locally to demonstrate read state.
    setUpdating(id);
    setRows(prev => prev.map(r => r.id === id ? { ...r, status: "read" } : r));
    setTimeout(() => setUpdating(null), 300); // simulate quick completion
  };

  const renderItem = ({ item }: { item: Notification }) => (
    <TouchableOpacity
      style={[
        styles.notificationRow,
        item.status !== "unread" && styles.viewedNotification,
        updating === item.id && styles.updatingRow,
      ]}
      onPress={() => handleNotificationClick(item.id)}
    >
      <View style={styles.notificationLeft}>
        <Image source={ICONS.calendar} style={styles.notificationIcon} />
        <View style={styles.notificationContent}>
          <Text style={styles.notificationTitle}>
            {item.message?.slice(0,50) || 'Notification'}
          </Text>
          <Text style={styles.notificationMessage}>{item.notificationtype}</Text>
        </View>
      </View>
      <Text style={styles.notificationTime}>{item.time ? new Date(item.time).toLocaleString() : ''}</Text>
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
        keyExtractor={(item) => item.id.toString()}
        refreshing={loading}
        onRefresh={load}
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
    fontSize: 25,
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