import { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ICONS } from "@/constants/icons";
import { notifications } from "@/constants/notifications"; // Import dummy notifications

export default function NotificationsPage() {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [viewedNotifications, setViewedNotifications] = useState(new Set());

  // Filter notifications based on category
  const filteredNotifications = notifications.filter(
    (notif) => selectedCategory === "All" || notif.notificationtype === selectedCategory
  );

  const handleNotificationClick = (id: number) => {
    setViewedNotifications((prev) => new Set(prev).add(id)); // Mark notification as viewed
  };

  const renderItem = ({ item }: { item: typeof notifications[0] }) => (
    <TouchableOpacity
      style={[styles.notificationRow, viewedNotifications.has(item.notificationid) && styles.viewedNotification]}
      onPress={() => handleNotificationClick(item.notificationid)}
    >
      <View style={styles.notificationLeft}>
        <Image source={ICONS.calendar} style={styles.notificationIcon} />
        <View style={styles.notificationContent}>
          <Text style={styles.notificationTitle}>{item.title}</Text>
          <Text style={styles.notificationMessage}>{item.message}</Text>
        </View>
      </View>
      <Text style={styles.notificationTime}>{item.time}</Text>
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
        {["All", "Event", "Promotion", "Update"].map((category) => (
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

      {/* Notifications List */}
      <FlatList
        data={filteredNotifications}
        renderItem={renderItem}
        keyExtractor={(item) => item.notificationid.toString()}
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
});
