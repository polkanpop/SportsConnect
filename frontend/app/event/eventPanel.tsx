import { ICONS } from "@/constants/icons";
import {
	approveEventBooking,
	type CombinedEvent,
	type EventBookingRow,
	getEventBookingsByEventId,
	getEventInfoByEventId,
	getPayment,
	getUserInfoByUserIdCached,
	listEventsCombinedByOrganizerId,
	rejectEventBooking,
	updateEventInfo,
} from "@/lib/backendApi";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Image,
	RefreshControl,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";

type Props = {
	organizerId: number | null;
};

function selectedEventStorageKey(organizerId: number) {
	return `@home:eventPanel:selectedEventId:v1:${organizerId}`;
}

function formatEventDateLabel(ev: { start_timestamp?: string | null; time?: string | null }) {
	const candidate = (ev.start_timestamp || ev.time || "").trim();
	const d = candidate ? new Date(candidate) : null;
	if (!d || Number.isNaN(d.getTime())) return "Date: -";
	const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const yyyy = String(d.getFullYear());
	return `Date: ${weekday}, ${mm}-${dd}-${yyyy}`;
}

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
	if (typeof v !== "string") return [];
	const s = v.trim();
	if (!s) return [];
	// JSON array
	if (s.startsWith("[") && s.endsWith("]")) {
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean);
		} catch {
			// ignore
		}
	}
	// Postgres array like {a,b}
	if (s.startsWith("{") && s.endsWith("}")) {
		return s
			.slice(1, -1)
			.split(",")
			.map((x) => x.replace(/^"|"$/g, "").trim())
			.filter(Boolean);
	}
	// Comma-separated fallback
	if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
	return [s];
}

function normaliseSportKey(s: string) {
	return s.toLowerCase().replace(/[^a-z]/g, "");
}

function sportAccentColor(sportKey: string | null) {
	const k = sportKey || "";
	if (k.includes("basket")) return "#f97316"; // orange
	if (k.includes("soccer") || k.includes("football")) return "#16a34a"; // green
	if (k.includes("running") || k.includes("run")) return "#2563eb"; // blue
	if (k.includes("tabletennis") || (k.includes("table") && k.includes("tennis"))) return "#7c3aed"; // purple
	if (k.includes("volley")) return "#db2777"; // pink
	if (k.includes("badminton")) return "#0d9488"; // teal
	if (k.includes("golf")) return "#65a30d"; // lime
	if (k.includes("pickle")) return "#ea580c"; // amber-ish
	if (k.includes("tennis")) return "#0891b2"; // cyan
	return "#16a34a";
}

function silhouetteForSport(sportKey: string | null) {
	const k = sportKey || "";
	if (k.includes("basket")) return ICONS.sillBasketball;
	if (k.includes("soccer") || k.includes("football")) return ICONS.sillFootball;
	if (k.includes("running") || k.includes("run")) return ICONS.sillRunning;
	if (k.includes("tabletennis") || (k.includes("table") && k.includes("tennis"))) return ICONS.sillTableTennis;
	if (k.includes("volley")) return ICONS.sillVolleyball;
	if (k.includes("badminton")) return ICONS.sillBadminton;
	if (k.includes("golf")) return ICONS.sillGolf;
	if (k.includes("pickle")) return ICONS.sillPickleball;
	if (k.includes("tennis")) return ICONS.sillTennis;
	return null;
}

function fallbackSilhouetteByEventId(eventid: number) {
	const all = [
		ICONS.sillBasketball,
		ICONS.sillFootball,
		ICONS.sillRunning,
		ICONS.sillTableTennis,
		ICONS.sillVolleyball,
		ICONS.sillBadminton,
		ICONS.sillGolf,
		ICONS.sillPickleball,
		ICONS.sillTennis,
	];
	const idx = Math.abs(Number(eventid) || 0) % all.length;
	return all[idx];
}

type EnrichedBooking = {
	booking: EventBookingRow;
	name: string;
	pfp?: string | null;
	paymentLabel: string;
};

function formatPaymentLabel(opts: { isFree: boolean; payment: Awaited<ReturnType<typeof getPayment>> | null }) {
	if (opts.isFree) return "Free";
	if (!opts.payment) return "Unpaid";
	const method = String(opts.payment.method || "").toUpperCase();
	const status = String(opts.payment.status || "").toUpperCase();
	return `${method || "PAYMENT"} • ${status || "UNKNOWN"}`;
}

function FreeBadge() {
	return (
		<View
			style={{
				alignSelf: "flex-start",
				marginTop: 6,
				backgroundColor: "#16a34a",
				paddingHorizontal: 10,
				paddingVertical: 4,
				borderRadius: 999,
				shadowColor: "#000",
				shadowOpacity: 0.12,
				shadowRadius: 6,
				elevation: 2,
			}}
		>
			<Text style={{ color: "#fff", fontWeight: "900", fontSize: 11, letterSpacing: 0.8 }}>FREE</Text>
		</View>
	);
}

export default function EventPanel({ organizerId }: Props) {
	const router = useRouter();
	const preferredSelectedEventIdRef = useRef<number | null>(null);
	const sportPickByEventIdRef = useRef<Record<number, string>>({});

	const getPickedSportKey = useCallback((ev: CombinedEvent) => {
		const existing = sportPickByEventIdRef.current[ev.eventid];
		if (existing) return existing;
		const sports = asStringArray(ev.sport);
		if (sports.length === 0) {
			sportPickByEventIdRef.current[ev.eventid] = "";
			return "";
		}
		// Deterministic pick so it doesn't change between renders/restarts.
		const idx = Math.abs((ev.eventid * 9301 + 49297) % 233280) % sports.length;
		const picked = normaliseSportKey(sports[idx] || "");
		sportPickByEventIdRef.current[ev.eventid] = picked;
		return picked;
	}, []);

	const [hostEvents, setHostEvents] = useState<CombinedEvent[]>([]);
	const [hostEventsLoading, setHostEventsLoading] = useState(false);
	const [hostEventsError, setHostEventsError] = useState<string | null>(null);
	const [selectedHostEventId, setSelectedHostEventId] = useState<number | null>(null);

	const selectedEvent = useMemo(
		() => (selectedHostEventId != null ? hostEvents.find((e) => e.eventid === selectedHostEventId) : undefined),
		[hostEvents, selectedHostEventId]
	);

	const [applicants, setApplicants] = useState<EnrichedBooking[]>([]);
	const [participants, setParticipants] = useState<EnrichedBooking[]>([]);
	const [bookingsLoading, setBookingsLoading] = useState(false);
	const [bookingsError, setBookingsError] = useState<string | null>(null);

	const [editTitle, setEditTitle] = useState("");
	const [editDescription, setEditDescription] = useState("");
	const [editCap, setEditCap] = useState("");
	const [savingEvent, setSavingEvent] = useState(false);
	const [mutatingBookingIds, setMutatingBookingIds] = useState<Record<number, "approve" | "reject">>({});

	const loadHostEvents = useCallback(async (preferredEventId?: number | null) => {
		if (organizerId == null) {
			setHostEvents([]);
			setSelectedHostEventId(null);
			return;
		}
		setHostEventsLoading(true);
		setHostEventsError(null);
		try {
			const rows = await listEventsCombinedByOrganizerId(organizerId);
			const normalized = Array.isArray(rows) ? rows : [];
			setHostEvents(normalized);
			if (normalized.length === 0) {
				setSelectedHostEventId(null);
				return;
			}
			const preferred =
				typeof preferredEventId === "number"
					? preferredEventId
					: typeof preferredSelectedEventIdRef.current === "number"
						? preferredSelectedEventIdRef.current
						: null;
			setSelectedHostEventId((prev) => {
				const has = (id: number | null) => id != null && normalized.some((e) => e.eventid === id);
				if (preferred != null && has(preferred)) return preferred;
				if (has(prev)) return prev;
				return normalized[0].eventid;
			});
		} catch (e: any) {
			setHostEventsError(e?.message || String(e));
		} finally {
			setHostEventsLoading(false);
		}
	}, [organizerId]);

	const enrichBookings = useCallback(async (eventMeta: CombinedEvent | undefined, rows: EventBookingRow[]) => {
		const isFree = (eventMeta?.entry_fee ?? 0) <= 0;

		const userInfos = await Promise.all(
			rows.map(async (b) => {
				try {
					const ui = await getUserInfoByUserIdCached(b.userid);
					return {
						userid: b.userid,
						name: (ui?.name as string) || `User ${b.userid}`,
						pfp: (ui?.pfp as string) || null,
					};
				} catch {
					return { userid: b.userid, name: `User ${b.userid}`, pfp: null };
				}
			})
		);
		const infoByUserId = new Map<number, { name: string; pfp: string | null }>();
		userInfos.forEach((u) => infoByUserId.set(u.userid, { name: u.name, pfp: u.pfp }));

		const payments = await Promise.all(
			rows.map(async (b) => {
				if (!b.paymentid) return { bookingId: b.eventbookingid, payment: null };
				const p = await getPayment(b.paymentid);
				return { bookingId: b.eventbookingid, payment: p };
			})
		);
		const paymentByBookingId = new Map<number, Awaited<ReturnType<typeof getPayment>> | null>();
		payments.forEach((p) => paymentByBookingId.set(p.bookingId, p.payment));

		return rows.map((booking) => {
			const ui = infoByUserId.get(booking.userid);
			const pay = paymentByBookingId.get(booking.eventbookingid) || null;
			return {
				booking,
				name: ui?.name || `User ${booking.userid}`,
				pfp: ui?.pfp || null,
				paymentLabel: formatPaymentLabel({ isFree, payment: pay }),
			};
		});
	}, []);

	const loadBookingsForEvent = useCallback(
		async (eventid: number) => {
			setBookingsLoading(true);
			setBookingsError(null);
			try {
				const [pendingRows, joinedRows] = await Promise.all([
					getEventBookingsByEventId(eventid, { status: "pending" }),
					getEventBookingsByEventId(eventid, { status: "joined" }),
				]);
				const meta = hostEvents.find((e) => e.eventid === eventid);
				const [pendingEnriched, joinedEnriched] = await Promise.all([
					enrichBookings(meta, Array.isArray(pendingRows) ? pendingRows : []),
					enrichBookings(meta, Array.isArray(joinedRows) ? joinedRows : []),
				]);
				setApplicants(pendingEnriched);
				setParticipants(joinedEnriched);
			} catch (e: any) {
				setBookingsError(e?.message || String(e));
			} finally {
				setBookingsLoading(false);
			}
		},
		[enrichBookings, hostEvents]
	);

	useEffect(() => {
		if (organizerId == null) return;
		let cancelled = false;
		(async () => {
			try {
				const raw = await AsyncStorage.getItem(selectedEventStorageKey(organizerId));
				const parsed = raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
				if (!cancelled) preferredSelectedEventIdRef.current = parsed;
			} catch {
				// ignore
			}
			if (!cancelled) await loadHostEvents(preferredSelectedEventIdRef.current);
		})();
		return () => {
			cancelled = true;
		};
	}, [loadHostEvents, organizerId]);

	useEffect(() => {
		if (organizerId == null || selectedHostEventId == null) return;
		preferredSelectedEventIdRef.current = selectedHostEventId;
		AsyncStorage.setItem(selectedEventStorageKey(organizerId), String(selectedHostEventId)).catch(() => {});
	}, [organizerId, selectedHostEventId]);

	useEffect(() => {
		if (selectedHostEventId == null) return;
		const meta = hostEvents.find((e) => e.eventid === selectedHostEventId);
		setEditTitle(String(meta?.title || ""));
		setEditDescription(String(meta?.description || ""));
		setEditCap(meta?.participants_cap != null ? String(meta?.participants_cap) : "");
		loadBookingsForEvent(selectedHostEventId);
	}, [loadBookingsForEvent, selectedHostEventId]);

	const onApproveApplicant = useCallback(
		async (eventid: number, booking: EventBookingRow) => {
			const bookingId = booking.eventbookingid;
			if (mutatingBookingIds[bookingId]) return;
			if (String(booking.status || "").toLowerCase() !== "pending") return;
			setMutatingBookingIds((prev) => ({ ...prev, [bookingId]: "approve" }));
			try {
				await approveEventBooking(booking.eventbookingid);
				await Promise.all([loadHostEvents(), loadBookingsForEvent(eventid)]);
			} catch (e: any) {
				setBookingsError(e?.message || String(e));
			} finally {
				setMutatingBookingIds((prev) => {
					const next = { ...prev };
					delete next[bookingId];
					return next;
				});
			}
		},
		[loadBookingsForEvent, loadHostEvents, mutatingBookingIds]
	);

	const onRejectApplicant = useCallback(
		async (eventid: number, booking: EventBookingRow) => {
			const bookingId = booking.eventbookingid;
			if (mutatingBookingIds[bookingId]) return;
			if (String(booking.status || "").toLowerCase() !== "pending") return;
			setMutatingBookingIds((prev) => ({ ...prev, [bookingId]: "reject" }));
			try {
				await rejectEventBooking(booking.eventbookingid);
				await loadBookingsForEvent(eventid);
			} catch (e: any) {
				setBookingsError(e?.message || String(e));
			} finally {
				setMutatingBookingIds((prev) => {
					const next = { ...prev };
					delete next[bookingId];
					return next;
				});
			}
		},
		[loadBookingsForEvent, mutatingBookingIds]
	);

	const onSaveEventInfo = useCallback(async () => {
		if (selectedHostEventId == null) return;
		setSavingEvent(true);
		try {
			const meta = await getEventInfoByEventId(selectedHostEventId);
			if (!meta?.eventinfoid) throw new Error("Missing event info");
			const capNum = editCap.trim() ? Number(editCap) : null;
			await updateEventInfo(meta.eventinfoid, {
				title: editTitle.trim() || meta.title,
				description: editDescription,
				participants_cap: capNum != null && Number.isFinite(capNum) ? capNum : meta.participants_cap,
			});
			await loadHostEvents();
		} catch (e: any) {
			setHostEventsError(e?.message || String(e));
		} finally {
			setSavingEvent(false);
		}
	}, [editCap, editDescription, editTitle, loadHostEvents, selectedHostEventId]);

	const refreshing = hostEventsLoading || bookingsLoading;
	const isFree = (selectedEvent?.entry_fee ?? 0) <= 0;

	return (
		<ScrollView
			style={{ flex: 1, backgroundColor: "#F0F0F0" }}
			contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 140 }}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
				loadHostEvents();
				if (selectedHostEventId != null) loadBookingsForEvent(selectedHostEventId);
			}} />}
			keyboardShouldPersistTaps="handled"
		>
			<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 10, marginBottom: 8 }}>My Event</Text>

			{organizerId == null && (
				<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
					<Text style={{ fontWeight: "700", fontSize: 14, marginBottom: 4 }}>Sign in required</Text>
					<Text style={{ color: "#555" }}>Log in to see events you created.</Text>
				</View>
			)}

			{hostEventsError && (
				<Text style={{ color: "red", marginBottom: 8 }}>Failed to load your events: {hostEventsError}</Text>
			)}

			{hostEventsLoading ? (
				<View style={{ paddingVertical: 18 }}>
					<ActivityIndicator />
				</View>
			) : hostEvents.length === 0 ? (
				<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
					<Text style={{ fontWeight: "700", fontSize: 14, marginBottom: 4 }}>No events yet</Text>
					<Text style={{ color: "#555" }}>Create an event to manage applicants here.</Text>
					<TouchableOpacity
						style={{ marginTop: 10, backgroundColor: "#16a34a", paddingVertical: 10, borderRadius: 10, alignItems: "center" }}
						onPress={() => router.push("/event/eventCreate" as any)}
					>
						<Text style={{ color: "#fff", fontWeight: "700" }}>Create Event</Text>
					</TouchableOpacity>
				</View>
			) : (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					removeClippedSubviews={false}
					style={{ overflow: "visible" }}
					contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 18, paddingBottom: 12 }}
				>
					{hostEvents.map((ev) => {
						const selected = ev.eventid === selectedHostEventId;
						const sportKey = getPickedSportKey(ev);
						const accent = sportAccentColor(sportKey);
						const silhouette = silhouetteForSport(sportKey) || fallbackSilhouetteByEventId(ev.eventid);
						return (
							<View key={ev.eventid} style={{ width: 288, marginRight: 18, overflow: "visible" }}>
								{selected && (
									<View
										pointerEvents="none"
										style={{
											position: "absolute",
											top: -3,
											left: -3,
											right: -3,
											bottom: -3,
											borderRadius: 17,
											backgroundColor: "rgba(255,255,255,0.92)",
											opacity: 1,
										}}
									/>
								)}
								<View
									pointerEvents="none"
									style={{
										position: "absolute",
										top: 0,
										left: 0,
										right: 0,
										bottom: 0,
										borderRadius: 14,
										backgroundColor: "#ffffff",
										shadowColor: "#000",
										shadowOffset: { width: 0, height: 6 },
										shadowOpacity: selected ? 0.22 : 0.12,
										shadowRadius: selected ? 14 : 8,
										elevation: selected ? 12 : 6,
									}}
								/>
								<TouchableOpacity
									activeOpacity={0.8}
									onPress={() => {
										if (selectedHostEventId !== ev.eventid) setSelectedHostEventId(ev.eventid);
									}}
									style={{
										width: "100%",
										borderRadius: 14,
										backgroundColor: selected ? accent : "#ffffff",
										borderWidth: 1,
										borderColor: selected ? "rgba(255,255,255,0.55)" : "#e5e7eb",
										borderLeftWidth: 5,
										borderLeftColor: accent,
										padding: 14,
										minHeight: 118,
										overflow: "hidden",
									}}
								>
								<Image
									source={silhouette}
									resizeMode="contain"
									style={{
										position: "absolute",
										top: -14,
										right: -18,
										width: 128,
										height: 128,
										opacity: selected ? 0.26 : 0.14,
										tintColor: selected ? "#ffffff" : accent,
										zIndex: 0,
									}}
								/>
								<View style={{ paddingRight: 78, flex: 1 }}>
									<Text numberOfLines={1} style={{ fontWeight: "900", fontSize: 16, color: selected ? "#fff" : "#111" }}>
										{ev.title || `Event #${ev.eventid}`}
									</Text>
									<Text
										numberOfLines={1}
										style={{
											color: selected ? "#f0fdf4" : "#555",
											marginTop: 8,
											fontSize: 12,
											fontWeight: "700",
											lineHeight: 16,
										}}
									>
										{formatEventDateLabel(ev)}
									</Text>
									<Text
										style={{
											color: selected ? "#ecfdf5" : "#374151",
											marginTop: "auto",
											paddingBottom: 2,
											fontSize: 12,
											fontWeight: "900",
											letterSpacing: 0.6,
										}}
									>
										PARTICIPANTS: {ev.numberofpeople ?? 0}/{ev.participants_cap ?? "-"}
									</Text>
								</View>
								</TouchableOpacity>
								<View
									pointerEvents="none"
									style={{
										position: "absolute",
										top: -24,
										right: -24,
										width: 56,
										height: 56,
										zIndex: 200,
										elevation: 24,
										opacity: selected ? 0.95 : 0.9,
									}}
								>
									<Image source={ICONS.eventDeco} resizeMode="contain" style={{ width: 48, height: 48, bottom: -13, right: -8}} />
								</View>
							</View>
						);
					})}
				</ScrollView>
			)}

			{selectedHostEventId != null && (
				<>
					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 10, marginBottom: 8 }}>Applicant List</Text>
					{bookingsError && (
						<Text style={{ color: "red", marginBottom: 8 }}>Failed to load applicants: {bookingsError}</Text>
					)}

					{bookingsLoading ? (
						<View style={{ paddingVertical: 18 }}>
							<ActivityIndicator />
						</View>
					) : applicants.length === 0 ? (
						<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
							<Text style={{ color: "#555" }}>No pending requests.</Text>
						</View>
					) : (
						<View>
								{applicants.map((a) => (
									<View
									key={a.booking.eventbookingid}
									style={{
										backgroundColor: "#fff",
										borderRadius: 12,
										padding: 12,
										flexDirection: "row",
										alignItems: "center",
										marginBottom: 10,
									}}
								>
										<TouchableOpacity
											activeOpacity={0.75}
											onPress={() => router.push({ pathname: "/event/profileSpectate", params: { userid: String(a.booking.userid) } } as any)}
											style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
										>
											{a.pfp ? (
												<Image
													source={{ uri: a.pfp }}
													style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#E5E7EB" }}
												/>
											) : (
												<Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />
											)}

											<View style={{ flex: 1, marginLeft: 10 }}>
												<Text style={{ fontWeight: "800", fontSize: 14 }} numberOfLines={1}>
													{a.name}
												</Text>
												{!isFree && (
													<Text style={{ color: "#555", marginTop: 2 }} numberOfLines={1}>
														{a.paymentLabel}
													</Text>
												)}
												{isFree && <FreeBadge />}
											</View>
										</TouchableOpacity>

									<View style={{ flexDirection: "row", alignItems: "center" }}>
										<TouchableOpacity
											disabled={!!mutatingBookingIds[a.booking.eventbookingid]}
											onPress={() => onApproveApplicant(selectedHostEventId, a.booking)}
											style={{
												width: 36,
												height: 36,
												borderRadius: 18,
												backgroundColor: "#dcfce7",
												alignItems: "center",
												justifyContent: "center",
												marginRight: 10,
												opacity: mutatingBookingIds[a.booking.eventbookingid] ? 0.6 : 1,
											}}
										>
											{mutatingBookingIds[a.booking.eventbookingid] === "approve" ? (
												<ActivityIndicator size={14} />
											) : (
												<Image source={ICONS.approve} style={{ width: 18, height: 18 }} resizeMode="contain" />
											)}
										</TouchableOpacity>
										<TouchableOpacity
											disabled={!!mutatingBookingIds[a.booking.eventbookingid]}
											onPress={() => onRejectApplicant(selectedHostEventId, a.booking)}
											style={{
												width: 36,
												height: 36,
												borderRadius: 18,
												backgroundColor: "#fee2e2",
												alignItems: "center",
												justifyContent: "center",
												opacity: mutatingBookingIds[a.booking.eventbookingid] ? 0.6 : 1,
											}}
										>
											{mutatingBookingIds[a.booking.eventbookingid] === "reject" ? (
												<ActivityIndicator size={14} />
											) : (
												<Image source={ICONS.reject} style={{ width: 18, height: 18 }} resizeMode="contain" />
											)}
										</TouchableOpacity>
										<TouchableOpacity
											activeOpacity={0.7}
											onPress={() => {
												// placeholder for future actions menu
											}}
											style={{
												width: 36,
												height: 36,
												borderRadius: 18,
												backgroundColor: "#f3f4f6",
												alignItems: "center",
												justifyContent: "center",
												marginLeft: 10,
											}}
										>
											<Image source={ICONS.dotdotdot} style={{ width: 18, height: 18, tintColor: "#111827" }} resizeMode="contain" />
										</TouchableOpacity>
									</View>
								</View>
							))}
						</View>
					)}

					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 14, marginBottom: 8 }}>Participant List</Text>
					{bookingsLoading ? (
						<View style={{ paddingVertical: 18 }}>
							<ActivityIndicator />
						</View>
					) : participants.length === 0 ? (
						<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
							<Text style={{ color: "#555" }}>No participants yet.</Text>
						</View>
					) : (
						<View>
								{participants.map((p) => (
									<View
									key={p.booking.eventbookingid}
									style={{
										backgroundColor: "#fff",
										borderRadius: 12,
										padding: 12,
										flexDirection: "row",
										alignItems: "center",
										marginBottom: 10,
									}}
								>
										<TouchableOpacity
											activeOpacity={0.75}
											onPress={() => router.push({ pathname: "/event/profileSpectate", params: { userid: String(p.booking.userid) } } as any)}
											style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
										>
											{p.pfp ? (
												<Image
													source={{ uri: p.pfp }}
													style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#E5E7EB" }}
												/>
											) : (
												<Image source={ICONS.accountCircle} style={{ width: 40, height: 40 }} resizeMode="contain" />
											)}
											<View style={{ flex: 1, marginLeft: 10 }}>
												<Text style={{ fontWeight: "800", fontSize: 14 }} numberOfLines={1}>
													{p.name}
												</Text>
												{!isFree ? (
													<Text style={{ color: "#555", marginTop: 2 }} numberOfLines={1}>
														{p.paymentLabel}
													</Text>
												) : (
													<FreeBadge />
												)}
											</View>
										</TouchableOpacity>
									<TouchableOpacity
										activeOpacity={0.7}
										onPress={() => {
											// placeholder for future actions menu
										}}
										style={{
											width: 36,
											height: 36,
											borderRadius: 18,
											backgroundColor: "#f3f4f6",
											alignItems: "center",
											justifyContent: "center",
										}}
									>
										<Image source={ICONS.dotdotdot} style={{ width: 18, height: 18, tintColor: "#111827" }} resizeMode="contain" />
									</TouchableOpacity>
								</View>
							))}
						</View>
					)}

					<View
						style={{
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "space-between",
							marginTop: 14,
							marginBottom: 8,
						}}
					>
						<Text style={{ fontSize: 18, fontWeight: "700" }}>Event Modify</Text>
						<TouchableOpacity
							activeOpacity={0.75}
							onPress={() =>
								router.push({ pathname: "/event/details", params: { id: `created_event_${selectedHostEventId}` } } as any)
							}
							style={{ paddingHorizontal: 6, paddingVertical: 4 }}
						>
							<Text style={{ color: "#2563eb", fontWeight: "800", textDecorationLine: "underline" }}>Details</Text>
						</TouchableOpacity>
					</View>
					<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 12 }}>
						<Text style={{ fontWeight: "700", marginBottom: 6 }}>Title</Text>
						<TextInput
							value={editTitle}
							onChangeText={setEditTitle}
							placeholder="Event title"
							style={{ backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 }}
						/>

						<Text style={{ fontWeight: "700", marginBottom: 6 }}>Description</Text>
						<TextInput
							value={editDescription}
							onChangeText={setEditDescription}
							placeholder="Description"
							multiline
							style={{
								backgroundColor: "#f3f4f6",
								borderRadius: 10,
								paddingHorizontal: 12,
								paddingVertical: 10,
								minHeight: 70,
								marginBottom: 10,
							}}
						/>

						<Text style={{ fontWeight: "700", marginBottom: 6 }}>Participants cap</Text>
						<TextInput
							value={editCap}
							onChangeText={setEditCap}
							placeholder="e.g. 20"
							keyboardType="numeric"
							style={{ backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 }}
						/>

						<TouchableOpacity
							disabled={savingEvent}
							onPress={onSaveEventInfo}
							style={{
								backgroundColor: savingEvent ? "#9ca3af" : "#16a34a",
								paddingVertical: 12,
								borderRadius: 10,
								alignItems: "center",
							}}
						>
							<Text style={{ color: "#fff", fontWeight: "800" }}>{savingEvent ? "Saving..." : "Save changes"}</Text>
						</TouchableOpacity>
					</View>
				</>
			)}
		</ScrollView>
	);
}
