import { courtBookings, eventBookings, trainingSessions } from "@/constants/bookings";
import { ICONS } from "@/constants/icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Dimensions, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Type definition for Unified Booking
type UnifiedBooking = {
  id: string; // Unique identifier for each booking
  title: string;
  status: "Completed" | "Upcoming" | "Cancelled"; // Status of the booking
  type: keyof typeof ICONS; // The icon type from ICONS object
  date: string; // Date of the event or booking
  time: string; // Time of the event or booking
  day: string; // Day of the week (Mon, Tue, etc.)
};

// Merge all bookings into a unified list
const mergeBookings = () => {
  const allBookings = [
    ...courtBookings.map((item) => ({
      id: `court_${item.courtbookingid}`,
      title: item.court,
      status: item.status as "Completed" | "Upcoming" | "Cancelled",
      type: item.type as keyof typeof ICONS,
      date: item.start_timestamp?.slice(0, 10) || "dd/mm/yy",
      time: item.start_timestamp?.slice(11, 16) || "hh:mm",
      day: item.day || "", // Day of the week (if available)
    })),
    ...eventBookings.map((item) => ({
      id: `event_${item.eventbookingid}`,
      title: item.event,
      status: item.status as "Completed" | "Upcoming" | "Cancelled",
      type: item.type as keyof typeof ICONS,
      date: item.date || "dd/mm/yy",
      time: item.time || "hh:mm",
      day: item.day || "", // Day of the week (if available)
    })),
    ...trainingSessions.map((item) => ({
      id: `session_${item.sessionid}`,
      title: item.sessioninfo,
      status: item.status as "Completed" | "Upcoming" | "Cancelled",
      type: item.type as keyof typeof ICONS,
      date: item.time.slice(0, 10) || "dd/mm/yy",  // Extract date from time field
      time: item.time.slice(11, 16) || "hh:mm",  // Extract time from time field
      day: item.day || "", // Day of the week (if available)
    })),
  ];

  return allBookings;
};

// Shuffle for variety demo :)
const shuffleArray = (array: UnifiedBooking[]) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]; // Swap elements
  }
  return array;
};


export default function ActivityPage() {
  const [showAll, setShowAll] = useState(false);
  const router = useRouter();
  let data = mergeBookings();  // Unified bookings data

  // Shuffle the data to display random results
  data = shuffleArray(data);

  const screenWidth = Dimensions.get("window").width; // Get screen width for calendar layout

  // Getting the status styles for different states
  const getStatusStyle = (status: "Completed" | "Upcoming" | "Cancelled") => {
    switch (status.toLowerCase()) {
      case "completed":
        return styles.completed;
      case "upcoming":
        return styles.upcoming;
      case "cancelled":
        return styles.cancelled;
      default:
        return {};
    }
  };

  // Render each item in the Activity List
  const renderItem = ({ item }: { item: UnifiedBooking }) => (
    <View style={styles.eventItem}>
      {/* Render the icon dynamically */}
      <Image
        source={ICONS[item.type]} // Dynamically pulling the icon from the ICONS object
        style={[styles.eventImage, { tintColor: ICONS[item.type]?.color }]} // Apply color dynamically
      />
      <View style={styles.eventDetails}>
        <Text style={styles.eventTitle}>{item.title}</Text>
        <Text style={styles.eventTime}>
          Date: {item.date}, {item.time} - {item.day || "No Day Available"} {/* Show the assigned day */}
        </Text>
        <TouchableOpacity>
          <Text style={styles.detailsText}>details</Text>
        </TouchableOpacity>
      </View>
      {/* Status Box */}
      <View style={[styles.statusBox, getStatusStyle(item.status)]}>
        <Text style={styles.statusText}>{item.status}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#F9F9F9" }}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Activity</Text>
        <TouchableOpacity style={styles.historyButton} onPress={() => router.push("/event/history")}> 
          <View style={styles.historyButtonContainer}>
            <Image
              source={ICONS.clock} // History Icon
              style={styles.historyIcon}
            />
            <Text style={styles.historyText}>History</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Horizontal Line (divider) */}
      <View style={styles.divider} />

      {/* Ongoing Activities Calendar */}
      <View style={styles.calendarContainer}>
        <Text style={styles.subHeader}>Ongoing activities</Text>

        {/* Calendar - 7 days view */}
        <View style={styles.calendar}>
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => (
            <View key={index} style={styles.dayContainer}>
              <Text style={styles.dayText}>{day}</Text>
              <View style={styles.bookingsContainer}>
                {data
                  .filter((item) => item.day === day) // Filter bookings by day
                  .map((booking, index) => (
                    <Image
                      key={index}
                      source={ICONS[booking.type]} // Dynamic icon based on type
                      style={styles.bookingIcon}
                    />
                  ))}
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Activity Records */}
      <View style={styles.activityRecordsContainer}>
        <View style={styles.recordsHeader}>
          <Text style={styles.subHeader}>Activity Records</Text>
          <TouchableOpacity onPress={() => setShowAll(!showAll)}>
            <Text style={styles.viewAllText}>{showAll ? "Collapse" : "View All"}</Text>
          </TouchableOpacity>
        </View>
        <FlatList
          data={showAll ? data : data.slice(0, 7)} // Show limited items unless "View All" is active
          renderItem={renderItem}
          keyExtractor={(item) => item.id} // Using unique id
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    backgroundColor: "#FFF",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
  },
  historyButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,  
  },
  historyButtonContainer: {
    backgroundColor: "#a9a9a9",  
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 30,  
    flexDirection: "row",
    alignItems: "center",
  },
  historyIcon: {
    width: 18,
    height: 18,
    marginRight: 5,
    tintColor: "#fff", 
  },
  historyText: {
    fontSize: 16,
    color: "#fff", 
  },
  divider: {
    height: 1,
    backgroundColor: "#E0E0E0",  
    marginVertical: 10,
  },
  calendarContainer: {
    padding: 20,
    backgroundColor: "#FFF",
    marginBottom: 10,
  },
  calendar: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  dayContainer: {
    alignItems: "center",
  },
  dayText: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#000",
  },
  bookingsContainer: {
    marginTop: 5,
  },
  bookingIcon: {
    width: 30,
    height: 30,
    margin: 5,
  },
  activityRecordsContainer: {
    flex: 1,
    padding: 20,
    backgroundColor: "#FFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  recordsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  subHeader: {
    fontSize: 18,
    fontWeight: "bold",
  },
  viewAllText: {
    fontSize: 16,
    color: "#007BFF",
    textDecorationLine: 'underline',
    fontStyle: 'italic',
  },
  eventItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 15,
    backgroundColor: "#F5F5F5",
    borderRadius: 10,
    marginBottom: 10,
  },
  eventImage: {
    width: 50,
    height: 50,
    marginRight: 15,
  },
  statusIndicator: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginRight: 10,
  },
  eventDetails: {
    flex: 1,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: "bold",
  },
  eventTime: {
    fontSize: 14,
    color: "#555",
    marginBottom: 5,
  },
  detailsText: {
    fontSize: 14,
    color: "#007BFF",
    textDecorationLine: 'underline',
  },
  statusBox: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 5,
    alignSelf: "flex-start",
  },
  statusText: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#FFF",
  },
  completed: {
    backgroundColor: "#28A745",
  },
  upcoming: {
    backgroundColor: "#007BFF",
  },
  cancelled: {
    backgroundColor: "#DC3545",
  },
});
