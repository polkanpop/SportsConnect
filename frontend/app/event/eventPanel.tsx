import { ICONS } from "@/constants/icons";
import TrainingSessionPanel from "@/app/event/trainingSessionPanel";
import {
	approveEventBooking,
	cloudinarySignUpload,
	createBlock,
	deleteCloudinaryAssetsByUrl,
	getEventBookingsByEventId,
	getEventInfoByEventId,
	getPayment,
	getUserInfoByUserIdCached,
	listBlockList,
	listEventsCombinedByOrganizerId,
	removeBlock,
	rejectEventBooking,
	updateEvent,
	updateEventInfo,
} from "@/lib/backendApi";
import { SkeletonBox, SkeletonPulse } from "@/components/ui/skeleton";
import { COLORS } from "@/constants/colors";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Dimensions,
	Image,
	Modal,
	Pressable,
	RefreshControl,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { Image as ExpoImage } from 'expo-image'

type BlockListRow = any;
type CombinedEvent = any;
type EventBookingRow = any;

type Props = {
	organizerId: number | null;
};

function selectedEventStorageKey(organizerId: number) {
	return `@home:eventPanel:selectedEventId:v1:${organizerId}`;
}

function parseTimestampLoose(raw: unknown): Date | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s) return null;
	let d = new Date(s);
	if (!Number.isNaN(d.getTime())) return d;
	// Postgres: "YYYY-MM-DD HH:mm:ss" (Hermes can treat as invalid)
	const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
	if (m) {
		d = new Date(`${m[1]}T${m[2]}:00`);
		if (!Number.isNaN(d.getTime())) return d;
	}
	return null;
}

function isPastEventLoose(ev: any): boolean {
	const end = parseTimestampLoose(ev?.end_timestamp ?? null);
	const start = parseTimestampLoose(ev?.start_timestamp ?? ev?.time ?? null);
	const now = Date.now();
	if (end) return end.getTime() < now;
	if (start) return start.getTime() < now;
	return false;
}

function isHiddenEventStatus(statusRaw: unknown): boolean {
	const st = String(statusRaw ?? "").trim().toLowerCase();
	return st === "completed" || st === "cancelled";
}

function formatEventDateLabel(ev: { start_timestamp?: string | null; time?: string | null }) {
	const candidate = (ev.start_timestamp || ev.time || "").trim();
	const d = candidate ? parseTimestampLoose(candidate) : null;
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

const BASKETBALL_SILHOUETTES = [
	ICONS.sillBasketball,
	ICONS.sillBasketball1,
	ICONS.sillBasketball2,
	ICONS.sillBasketball3,
	ICONS.sillBasketball4,
];

function fallbackSilhouetteByEventId(eventid: number) {
	const idx = Math.abs(Number(eventid) || 0) % BASKETBALL_SILHOUETTES.length;
	return BASKETBALL_SILHOUETTES[idx];
}

const IMAGE_TILE_WIDTH = Math.round((Dimensions.get("window").width - 36) * 0.7);
const IMAGE_TILE_HEIGHT = 120;

const CLOUDINARY_DELIVERY_WIDTH = 1280;
const CLOUDINARY_DELIVERY_HEIGHT = Math.max(
	1,
	Math.round((CLOUDINARY_DELIVERY_WIDTH * IMAGE_TILE_HEIGHT) / Math.max(1, IMAGE_TILE_WIDTH))
);

const dedupeStrings = (arr: string[]) => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of arr) {
		const v = String(s || "").trim();
		if (!v || seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
};

const applyCloudinaryDeliveryOptimizations = (secureUrl: string) => {
	try {
		const marker = "/upload/";
		const idx = secureUrl.indexOf(marker);
		if (idx < 0) return secureUrl;
		const before = secureUrl.slice(0, idx + marker.length);
		const after = secureUrl.slice(idx + marker.length);
		const transform = `c_fill,w_${CLOUDINARY_DELIVERY_WIDTH},h_${CLOUDINARY_DELIVERY_HEIGHT},q_auto,f_auto`;
		return `${before}${transform}/${after}`;
	} catch {
		return secureUrl;
	}
};

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
	const [managementMode, setManagementMode] = useState<'event' | 'trainingSession'>('event');
	const preferredSelectedEventIdRef = useRef<number | null>(null);

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
	const [hosts, setHosts] = useState<Array<{ userid: number; name: string; pfp: string | null }>>([]);
	const [hostsLoading, setHostsLoading] = useState(false);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [blocked, setBlocked] = useState<BlockListRow[]>([]);
	const [blockedLoading, setBlockedLoading] = useState(false);
	const [blockedError, setBlockedError] = useState<string | null>(null);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [blockedNameByUserId, setBlockedNameByUserId] = useState<Record<number, string>>({});
	const [actionMenuVisible, setActionMenuVisible] = useState(false);
	const [actionUser, setActionUser] = useState<{ userid: number; name: string } | null>(null);
	const [actionMenuPos, setActionMenuPos] = useState<{ x: number; y: number } | null>(null);
	const [confirmBlockVisible, setConfirmBlockVisible] = useState(false);
	const [blocking, setBlocking] = useState(false);
	const [confirmRemoveVisible, setConfirmRemoveVisible] = useState(false);
	const [removeCandidate, setRemoveCandidate] = useState<{ userid: number; name: string } | null>(null);
	const [confirmCancelVisible, setConfirmCancelVisible] = useState(false);
	const [cancellingEvent, setCancellingEvent] = useState(false);

	const [editTitle, setEditTitle] = useState("");
	const [editDescription, setEditDescription] = useState("");
	const [editCap, setEditCap] = useState("");
	const [editImages, setEditImages] = useState<string[]>([]);
	const [imageUploading, setImageUploading] = useState(false);
	const [removeImageConfirmVisible, setRemoveImageConfirmVisible] = useState(false);
	const [removeImageCandidateUri, setRemoveImageCandidateUri] = useState<string | null>(null);
	const [pendingCloudinaryDeletes, setPendingCloudinaryDeletes] = useState<string[]>([]);
	const [savingEvent, setSavingEvent] = useState(false);
	const [mutatingBookingIds, setMutatingBookingIds] = useState<Record<number, "approve" | "reject">>({});
	const [expandedNoteEventIds, setExpandedNoteEventIds] = useState<Set<number>>(new Set());

	const lastHydratedEventIdRef = useRef<number | null>(null);
	const initialEditSnapshotRef = useRef<string>("");
	const isDirtyRef = useRef<boolean>(false);

	const makeEditSnapshot = useCallback(
		(payload: { title: string; description: string; cap: string; images: string[] }) => {
			const title = String(payload.title || "").trim();
			const description = String(payload.description || "");
			const cap = String(payload.cap || "").trim();
			const images = dedupeStrings(Array.isArray(payload.images) ? payload.images : []);
			return JSON.stringify({ title, description, cap, images });
		},
		[]
	);

	const currentEditSnapshot = useMemo(() => {
		return makeEditSnapshot({ title: editTitle, description: editDescription, cap: editCap, images: editImages });
	}, [editCap, editDescription, editImages, editTitle, makeEditSnapshot]);

	const isDirty = useMemo(() => {
		if (!initialEditSnapshotRef.current) return false;
		return currentEditSnapshot !== initialEditSnapshotRef.current;
	}, [currentEditSnapshot]);

	useEffect(() => {
		isDirtyRef.current = isDirty;
	}, [isDirty]);

	const uploadOneToCloudinary = useCallback(
		async (localUri: string, idx: number) => {
			if (typeof organizerId !== "number") throw new Error("Not signed in");

			const resized = await ImageManipulator.manipulateAsync(
				localUri,
				[{ resize: { width: 1280 } }],
				{ compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
			);

			const publicId = `event_${organizerId}_${Date.now()}_${idx}`;
			const sign = await cloudinarySignUpload({ public_id: publicId, overwrite: true } as any);
			const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(sign.cloudName)}/image/upload`;

			const form = new FormData();
			form.append("file", {
				uri: resized.uri,
				name: `${publicId}.jpg`,
				type: "image/jpeg",
			} as any);
			form.append("api_key", sign.apiKey);
			form.append("timestamp", String(sign.timestamp));
			form.append("signature", sign.signature);
			if (sign.uploadPreset) form.append("upload_preset", String(sign.uploadPreset));
			if (sign.folder) form.append("folder", String(sign.folder));
			form.append("public_id", publicId);
			form.append("overwrite", "true");

			const resp = await fetch(endpoint, { method: "POST", body: form });
			const json = await resp.json().catch(() => null);
			if (!resp.ok) {
				const msg = json?.error?.message || `Upload failed (HTTP ${resp.status})`;
				throw new Error(msg);
			}
			const secureUrl: string | undefined = json?.secure_url;
			if (!secureUrl) throw new Error("Upload succeeded but missing secure_url");
			return applyCloudinaryDeliveryOptimizations(secureUrl);
		},
		[organizerId]
	);

	const pickImage = useCallback(async () => {
		if (imageUploading) return;
		if (typeof organizerId !== "number") {
			Alert.alert("Not signed in", "Please sign in first.");
			return;
		}
		const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
		if (!perm.granted) {
			Alert.alert("Permission needed", "Please allow photo library access to select images.");
			return;
		}

		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ImagePicker.MediaTypeOptions.Images,
			allowsMultipleSelection: false,
			allowsEditing: true,
			aspect: [IMAGE_TILE_WIDTH, IMAGE_TILE_HEIGHT],
			quality: 0.9,
		} as any);

		if (result.canceled) return;
		const picked = (result.assets || []).map((a) => a.uri).filter(Boolean);
		if (picked.length === 0) return;

		setImageUploading(true);
		try {
			const uploadedUrl = await uploadOneToCloudinary(picked[0], editImages.length);
			setEditImages((prev) => dedupeStrings([...prev, uploadedUrl]).slice(0, 6));
			setPendingCloudinaryDeletes((prev) => prev.filter((u) => u !== uploadedUrl));
		} catch (e: any) {
			Alert.alert("Upload failed", e?.message || String(e));
		} finally {
			setImageUploading(false);
		}
	}, [editImages.length, imageUploading, organizerId, uploadOneToCloudinary]);

	const requestRemoveImage = useCallback((uri: string) => {
		setRemoveImageCandidateUri(uri);
		setRemoveImageConfirmVisible(true);
	}, []);

	const onConfirmRemoveImage = useCallback(() => {
		if (removeImageCandidateUri) {
			setPendingCloudinaryDeletes((prev) => (prev.includes(removeImageCandidateUri) ? prev : [...prev, removeImageCandidateUri]));
			setEditImages((prev) => prev.filter((u) => u !== removeImageCandidateUri));
		}
		setRemoveImageConfirmVisible(false);
		setRemoveImageCandidateUri(null);
	}, [removeImageCandidateUri]);

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
			const filtered = normalized.filter((ev) => {
				if (isHiddenEventStatus((ev as any)?.status)) return false;
				if (isPastEventLoose(ev)) return false;
				return true;
			});
			setHostEvents(filtered);
			if (filtered.length === 0) {
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
				const has = (id: number | null) => id != null && filtered.some((e) => e.eventid === id);
				if (preferred != null && has(preferred)) return preferred;
				if (has(prev)) return prev;
				return filtered[0].eventid;
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

	const loadBlockedForTarget = useCallback(async (eventid: number) => {
		setBlockedLoading(true);
		setBlockedError(null);
		try {
			const rows = await listBlockList({ targettype: "event", targetid: eventid });
			setBlocked(Array.isArray(rows) ? rows : []);
		} catch (e: any) {
			setBlocked([]);
			setBlockedError(e?.message || String(e));
		} finally {
			setBlockedLoading(false);
		}
	}, []);

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
		const isNewSelection = lastHydratedEventIdRef.current !== selectedHostEventId;
		if (!isNewSelection && isDirtyRef.current) return;
		lastHydratedEventIdRef.current = selectedHostEventId;
		setPendingCloudinaryDeletes([]);
		const meta = hostEvents.find((e) => e.eventid === selectedHostEventId);
		setEditTitle(String(meta?.title || ""));
		setEditDescription(String(meta?.description || ""));
		setEditCap(meta?.participants_cap != null ? String(meta?.participants_cap) : "");
		loadBookingsForEvent(selectedHostEventId);
		loadBlockedForTarget(selectedHostEventId);

		let cancelled = false;
		(async () => {
			try {
				const info = await getEventInfoByEventId(selectedHostEventId);
				if (cancelled) return;
				const imgs = asStringArray((info as any)?.images);
				setEditImages(imgs);
				const snapshot = makeEditSnapshot({
					title: String(meta?.title || ""),
					description: String(meta?.description || ""),
					cap: meta?.participants_cap != null ? String(meta?.participants_cap) : "",
					images: imgs,
				});
				initialEditSnapshotRef.current = snapshot;
			} catch {
				if (cancelled) return;
				setEditImages([]);
				const snapshot = makeEditSnapshot({
					title: String(meta?.title || ""),
					description: String(meta?.description || ""),
					cap: meta?.participants_cap != null ? String(meta?.participants_cap) : "",
					images: [],
				});
				initialEditSnapshotRef.current = snapshot;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [hostEvents, loadBlockedForTarget, loadBookingsForEvent, makeEditSnapshot, selectedHostEventId]);

	const openActionMenuForUser = useCallback((userid: number, name: string, pos?: { x: number; y: number } | null) => {
		setActionUser({ userid, name });
		setActionMenuPos(pos || null);
		setActionMenuVisible(true);
	}, []);

	const onConfirmBlock = useCallback(async () => {
		if (selectedHostEventId == null || !actionUser) return;
		setBlocking(true);
		setBlockedError(null);
		try {
			await createBlock({ targettype: "event", targetid: selectedHostEventId, blocked_userid: actionUser.userid });
			setConfirmBlockVisible(false);
			setActionMenuVisible(false);
			await loadBlockedForTarget(selectedHostEventId);
		} catch (e: any) {
			setBlockedError(e?.message || String(e));
		} finally {
			setBlocking(false);
		}
	}, [actionUser, loadBlockedForTarget, selectedHostEventId]);

	const onRequestRemoveBlockedUser = useCallback(
		(userid: number) => {
			const name = blockedNameByUserId[userid] || `User ${userid}`;
			setRemoveCandidate({ userid, name });
			setConfirmRemoveVisible(true);
		},
		[blockedNameByUserId]
	);

	const onConfirmRemoveBlockedUser = useCallback(async () => {
		if (selectedHostEventId == null || !removeCandidate) return;
		setBlockedError(null);
		try {
			await removeBlock({ targettype: "event", targetid: selectedHostEventId, blocked_userid: removeCandidate.userid });
			setConfirmRemoveVisible(false);
			setRemoveCandidate(null);
			await loadBlockedForTarget(selectedHostEventId);
		} catch (e: any) {
			setBlockedError(e?.message || String(e));
		}
	}, [loadBlockedForTarget, removeCandidate, selectedHostEventId]);

	useEffect(() => {
		if (!blocked.length) return;
		let cancelled = false;

		const missing = blocked
			.map((b) => b.blocked_userid)
			.filter((id) => id != null)
			.filter((id) => blockedNameByUserId[id] == null)
			.slice(0, 25);

		if (!missing.length) return;

		(async () => {
			const entries = await Promise.all(
				missing.map(async (id) => {
					try {
						const ui = await getUserInfoByUserIdCached(id);
						const nm = (ui?.name as string) || null;
						return { id, name: nm || `User ${id}` };
					} catch {
						return { id, name: `User ${id}` };
					}
				})
			);
			if (cancelled) return;
			setBlockedNameByUserId((prev) => {
				const next = { ...prev };
				for (const e of entries) next[e.id] = e.name;
				return next;
			});
		})();

		return () => {
			cancelled = true;
		};
	}, [blocked, blockedNameByUserId]);

	useEffect(() => {
		if (selectedHostEventId == null) return;
		let cancelled = false;

		setHosts([]);
		setHostsError(null);
		setHostsLoading(true);
		(async () => {
			try {
				const meta = hostEvents.find((e) => e.eventid === selectedHostEventId);
				const hostUserId = (meta as any)?.organizerid ?? organizerId;
				if (hostUserId == null) {
					if (!cancelled) setHosts([]);
					return;
				}
				const ui = await getUserInfoByUserIdCached(hostUserId);
				if (cancelled) return;
				setHosts([
					{
						userid: hostUserId,
						name: (ui?.name as string) || `User ${hostUserId}`,
						pfp: (ui?.pfp as string) || null,
					},
				]);
			} catch (e: any) {
				if (cancelled) return;
				setHostsError(e?.message || String(e));
			} finally {
				if (cancelled) return;
				setHostsLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [hostEvents, organizerId, selectedHostEventId]);

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
		if (!isDirty) return;
		setSavingEvent(true);
		try {
			const meta = await getEventInfoByEventId(selectedHostEventId);
			if (!meta?.eventinfoid) throw new Error("Missing event info");
			const capNum = editCap.trim() ? Number(editCap) : null;
			await updateEventInfo(meta.eventinfoid, {
				title: editTitle.trim() || meta.title,
				description: editDescription,
				participants_cap: capNum != null && Number.isFinite(capNum) ? capNum : meta.participants_cap,
				images: editImages,
			});
			const urlsToDelete = pendingCloudinaryDeletes.filter((u) => !editImages.includes(u));
			if (urlsToDelete.length) {
				try {
					await deleteCloudinaryAssetsByUrl(urlsToDelete);
				} catch (e: any) {
					console.warn('[eventPanel] cloudinary delete failed', e?.message || String(e));
				}
			}
			await loadHostEvents();
			initialEditSnapshotRef.current = currentEditSnapshot;
			setPendingCloudinaryDeletes([]);
		} catch (e: any) {
			setHostEventsError(e?.message || String(e));
		} finally {
			setSavingEvent(false);
		}
	}, [currentEditSnapshot, deleteCloudinaryAssetsByUrl, editCap, editDescription, editImages, editTitle, isDirty, loadHostEvents, pendingCloudinaryDeletes, selectedHostEventId]);

	const canCancelSelectedEvent = useMemo(() => {
		const s = String((selectedEvent as any)?.status ?? "").toLowerCase();
		if (!s) return true;
		if (s.includes("cancel") || s.includes("complete")) return false;
		return s.includes("upcoming") || s.includes("active") || s.includes("scheduled");
	}, [selectedEvent]);

	const onConfirmCancelEvent = useCallback(async () => {
		if (selectedHostEventId == null) return;
		if (!canCancelSelectedEvent) return;
		setCancellingEvent(true);
		setHostEventsError(null);
		try {
			await updateEvent(selectedHostEventId, { status: "cancelled" } as any);
			setConfirmCancelVisible(false);
			await loadHostEvents(selectedHostEventId);
			const detailsId = `created_event_${selectedHostEventId}`;
			router.replace({ pathname: "/event/statusTransition", params: { anim: "cancel", detailsId } } as any);
		} catch (e: any) {
			setHostEventsError(e?.message || String(e));
		} finally {
			setCancellingEvent(false);
		}
	}, [canCancelSelectedEvent, loadHostEvents, router, selectedHostEventId]);

	const isFree = (selectedEvent?.entry_fee ?? 0) <= 0;

	const toggle = (
		<View
			style={{
				paddingHorizontal: 12,
				paddingTop: 12,
				paddingBottom: 6,
				backgroundColor: '#F0F0F0',
			}}
		>
			<View
				style={{
					flexDirection: 'row',
					backgroundColor: '#fff',
					borderRadius: 14,
					padding: 4,
					borderWidth: 1,
					borderColor: COLORS.neutral350,
				}}
			>
				<TouchableOpacity
					activeOpacity={0.85}
					onPress={() => setManagementMode('event')}
					style={{
						flex: 1,
						height: 42,
						borderRadius: 12,
						alignItems: 'center',
						justifyContent: 'center',
						backgroundColor: managementMode === 'event' ? COLORS.brandOrangeYellow : 'transparent',
					}}
				>
					<Text style={{ fontWeight: '900', fontSize: 14, color: managementMode === 'event' ? COLORS.white : COLORS.brandOrangeYellow }}>Event</Text>
				</TouchableOpacity>
				<TouchableOpacity
					activeOpacity={0.85}
					onPress={() => setManagementMode('trainingSession')}
					style={{
						flex: 1,
						height: 42,
						borderRadius: 12,
						alignItems: 'center',
						justifyContent: 'center',
						backgroundColor: managementMode === 'trainingSession' ? COLORS.purple : 'transparent',
					}}
				>
					<Text style={{ fontWeight: '900', fontSize: 14, color: managementMode === 'trainingSession' ? COLORS.white : COLORS.purple }}>Training Session</Text>
				</TouchableOpacity>
			</View>
		</View>
	);

	return (
		<View style={{ flex: 1, backgroundColor: '#F0F0F0' }}>
			{toggle}
			<View style={{ flex: 1 }}>
				<View style={{ flex: 1, display: managementMode === 'event' ? 'flex' : 'none' }}>
					<ScrollView
				style={{ flex: 1, backgroundColor: "#F0F0F0" }}
				contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 140 }}
				refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={async () => {
					setPullRefreshing(true);
					try {
						await loadHostEvents();
						if (selectedHostEventId != null) {
							await Promise.all([
								loadBookingsForEvent(selectedHostEventId),
								loadBlockedForTarget(selectedHostEventId),
							]);
						}
					} finally {
						setPullRefreshing(false);
					}
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
				<SkeletonPulse>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						removeClippedSubviews={false}
						style={{ overflow: "visible" }}
						contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 18, paddingBottom: 12 }}
					>
						{Array.from({ length: 2 }).map((_, idx) => (
							<SkeletonBox
								key={idx}
								width={288}
								height={148}
								radius={14}
									style={{ marginRight: idx < 1 ? 18 : 0 }}
							/>
						))}
					</ScrollView>
				</SkeletonPulse>
			) : hostEvents.length === 0 ? (
				<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
					<Text style={{ fontWeight: "700", fontSize: 14, marginBottom: 4 }}>No events yet</Text>
					<Text style={{ color: "#555" }}>Create an event to manage applicants here.</Text>
					<TouchableOpacity
						style={{ marginTop: 10, backgroundColor: COLORS.brandOrangeDeep, paddingVertical: 10, borderRadius: 10, alignItems: "center" }}
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
					contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 18, paddingBottom: 12 }}
				>
						{hostEvents.map((ev, idx) => {
						const selected = ev.eventid === selectedHostEventId;
						const accent = "#16a34a";
						const silhouette = fallbackSilhouetteByEventId(ev.eventid);
						return (
								<View
									key={ev.eventid}
									style={{ width: 288, marginRight: idx < hostEvents.length - 1 ? 18 : 0, overflow: "visible" }}
								>
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
									<View
										pointerEvents="none"
										style={{
											position: "absolute",
											top: -14,
											right: -18,
											width: 120,
											height: 120,
											zIndex: 0,
										}}
									>
										<Image
											source={silhouette}
											resizeMode="contain"
											style={{
												width: "100%",
												height: "100%",
												opacity: selected ? 0.26 : 0.14,
												tintColor: selected ? "#ffffff" : accent,
											}}
										/>
									</View>
									<View
										pointerEvents="none"
										style={{
											position: "absolute",
											top: -2,
											right: -6,
											width: 46,
											height: 46,
											opacity: selected ? 0.95 : 0.9,
											zIndex: 2,
										}}
									>
										<Image source={ICONS.eventDeco} resizeMode="contain" style={{ width: "100%", height: "100%" }} />
									</View>
									<View style={{ flex: 1, minWidth: 0, paddingRight: 56 }}>
										<Text numberOfLines={2} style={{ fontWeight: "900", fontSize: 16, lineHeight: 18, color: selected ? "#fff" : "#111" }}>
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
						<SkeletonPulse>
							<View style={{ paddingVertical: 12 }}>
								{Array.from({ length: 4 }).map((_, idx) => (
									<SkeletonBox
										key={idx}
										width={'100%'}
										height={72}
										radius={12}
										style={{ marginBottom: 10 }}
									/>
								))}
							</View>
						</SkeletonPulse>
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
										marginBottom: 10,
									}}
								>
									<View style={{ flexDirection: "row", alignItems: "center" }}>
										<TouchableOpacity
											activeOpacity={0.75}
											onPress={() => router.push({ pathname: "/event/profileSpectate", params: { userid: String(a.booking.userid) } } as any)}
											style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
										>
											{a.pfp ? (
												<ExpoImage
													source={{ uri: a.pfp }}
													style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#E5E7EB" }}
													contentFit="cover"
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
											activeOpacity={0.75}
											onPress={() => setExpandedNoteEventIds(prev => {
												const n = new Set(prev);
												if (n.has(a.booking.eventbookingid)) n.delete(a.booking.eventbookingid);
												else n.add(a.booking.eventbookingid);
												return n;
											})}
											style={{ padding: 6, alignItems: "center", justifyContent: "center", marginLeft: 2 }}
										>
											<Text style={{ fontSize: 16 }}>✏️</Text>
										</TouchableOpacity>
										<TouchableOpacity
											activeOpacity={0.7}
											onPress={(e) => {
												openActionMenuForUser(a.booking.userid, a.name, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
											}}
											style={{
												padding: 6,
												alignItems: "center",
												justifyContent: "center",
												marginLeft: 8,
											}}
										>
											<Image source={ICONS.dotdotdot} style={{ width: 18, height: 18, tintColor: "#111827" }} resizeMode="contain" />
										</TouchableOpacity>
									</View>
									</View>
									{expandedNoteEventIds.has(a.booking.eventbookingid) && (
										<View style={{ marginTop: 8, backgroundColor: "#f9fafb", borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: "#d1d5db" }}>
											<Text style={{ fontSize: 12, fontWeight: "700", color: "#374151", marginBottom: 4 }}>Note</Text>
											<Text style={{ fontSize: 13, color: "#555" }}>{(a.booking as any).note?.trim() ? (a.booking as any).note : "No note provided."}</Text>
										</View>
									)}
								</View>
							))}
						</View>
					)}

					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 14, marginBottom: 8 }}>Participant List</Text>
					{bookingsLoading ? (
						<SkeletonPulse>
							<View style={{ paddingVertical: 12 }}>
								{Array.from({ length: 4 }).map((_, idx) => (
									<SkeletonBox
										key={idx}
										width={'100%'}
										height={72}
										radius={12}
										style={{ marginBottom: 10 }}
									/>
								))}
							</View>
						</SkeletonPulse>
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
												<ExpoImage
													source={{ uri: p.pfp }}
													style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#E5E7EB" }}
													contentFit="cover"
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
										onPress={(e) => {
											openActionMenuForUser(p.booking.userid, p.name, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
										}}
										style={{
											padding: 6,
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

					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 14, marginBottom: 8 }}>Host List</Text>
					<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
						{hostsError ? (
							<Text style={{ color: "#B91C1C", fontWeight: "700" }}>{hostsError}</Text>
						) : hostsLoading ? (
							<SkeletonPulse>
								<View>
									{Array.from({ length: 3 }).map((_, idx) => (
										<SkeletonBox
											key={idx}
											width={'100%'}
											height={56}
											radius={12}
											style={{ marginBottom: idx < 2 ? 10 : 0 }}
										/>
									))}
								</View>
							</SkeletonPulse>
						) : hosts.length === 0 ? (
							<Text style={{ color: "#555" }}>No hosts yet.</Text>
						) : (
							<View>
								{hosts.map((h) => (
									<TouchableOpacity
										key={h.userid}
										activeOpacity={0.75}
										onPress={() => router.push({ pathname: "/event/profileSpectate", params: { userid: String(h.userid) } } as any)}
										style={{ flexDirection: "row", alignItems: "center" }}
									>
										{h.pfp ? (
											<ExpoImage source={{ uri: h.pfp }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#E5E7EB" }} contentFit="cover" />
										) : (
											<Image source={ICONS.accountCircle} style={{ width: 44, height: 44 }} resizeMode="contain" />
										)}
										<View style={{ marginLeft: 10, flex: 1 }}>
											<Text style={{ fontWeight: "800", fontSize: 14 }} numberOfLines={1}>
												{h.name}
											</Text>
											<Text style={{ color: "#555", marginTop: 2 }} numberOfLines={1}>
												Host
											</Text>
										</View>
									</TouchableOpacity>
								))}
							</View>
						)}
					</View>

					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 14, marginBottom: 8 }}>Administrator List</Text>
					<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
						<Text style={{ color: "#555" }}>No administrators yet.</Text>
					</View>

					<Text style={{ fontSize: 18, fontWeight: "700", marginTop: 14, marginBottom: 8 }}>Block List</Text>
					<View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14 }}>
						<View style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#e5e7eb" }}>
							<Text style={{ flex: 1.2, fontWeight: "800", color: "#111827" }}>User</Text>
							<Text style={{ flex: 1.4, fontWeight: "800", color: "#111827" }}>Blocked At</Text>
							<Text style={{ flex: 1.0, fontWeight: "800", color: "#111827", textAlign: "right" }} />
						</View>

						{!!blockedError && <Text style={{ color: "#B91C1C", fontWeight: "700", marginTop: 10 }}>{blockedError}</Text>}

						{blockedLoading ? (
							<SkeletonPulse>
								<View style={{ paddingTop: 10 }}>
									{Array.from({ length: 3 }).map((_, idx) => (
										<SkeletonBox
											key={idx}
											width={'100%'}
											height={44}
											radius={10}
											style={{ marginBottom: idx < 2 ? 10 : 0 }}
										/>
									))}
								</View>
							</SkeletonPulse>
						) : blocked.length === 0 ? (
							<Text style={{ color: "#555", marginTop: 10 }}>No blocked users.</Text>
						) : (
							<View style={{ marginTop: 8 }}>
								{blocked.map((b) => (
									<View
										key={b.blockid}
										style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" }}
									>
										<TouchableOpacity
											activeOpacity={0.75}
											onPress={() => router.push({ pathname: "/event/profileSpectate", params: { userid: String(b.blocked_userid) } } as any)}
											style={{ flex: 1.2 }}
										>
											<Text style={{ fontSize: 14, fontWeight: "800", color: "#111827" }} numberOfLines={1}>
												{blockedNameByUserId[b.blocked_userid] || `User ${b.blocked_userid}`}
											</Text>
										</TouchableOpacity>
										<Text style={{ flex: 1.4, fontSize: 14, fontWeight: "800", color: "#111827" }} numberOfLines={1}>
											{b.blocked_at ? String(b.blocked_at).slice(0, 10) : "-"}
										</Text>
										<TouchableOpacity
											activeOpacity={0.8}
											onPress={() => onRequestRemoveBlockedUser(b.blocked_userid)}
											style={{ flex: 1.0, alignItems: "flex-end" }}
										>
											<Text style={{ color: "#2563eb", fontWeight: "900", textDecorationLine: "underline" }}>Remove</Text>
										</TouchableOpacity>
									</View>
								))}
							</View>
						)}
					</View>

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

						<Text style={{ fontWeight: "700", marginBottom: 6 }}>Images</Text>
						<ScrollView
							horizontal
							showsHorizontalScrollIndicator={false}
							contentContainerStyle={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingTop: 6, paddingBottom: 6 }}
							style={{ marginBottom: 10 }}
						>
							{editImages.map((uri) => (
								<View
									key={uri}
									style={{
										width: IMAGE_TILE_WIDTH,
										height: IMAGE_TILE_HEIGHT,
										alignSelf: "flex-start",
										borderRadius: 12,
										borderWidth: 1,
										borderColor: COLORS.neutral350,
										borderStyle: "dashed",
										backgroundColor: COLORS.neutral0,
										alignItems: "center",
										justifyContent: "center",
										overflow: "hidden",
									}}
								>
									<View style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
										<ExpoImage source={{ uri }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
									</View>
									<TouchableOpacity
										activeOpacity={0.85}
										onPress={() => requestRemoveImage(uri)}
										style={{
											position: "absolute",
											top: 8,
											right: 8,
											width: 28,
											height: 28,
											borderRadius: 14,
											backgroundColor: COLORS.neutral0,
											borderWidth: 1,
											borderColor: COLORS.neutral200,
											alignItems: "center",
											justifyContent: "center",
										}}
									>
										<Text style={{ fontSize: 20, lineHeight: 20, fontWeight: "900", color: COLORS.neutral925, marginTop: -1 }}>×</Text>
									</TouchableOpacity>
								</View>
							))}

							{editImages.length < 6 && (
								<View
									style={{
										width: IMAGE_TILE_WIDTH,
										height: IMAGE_TILE_HEIGHT,
										alignSelf: "flex-start",
										borderRadius: 12,
										borderWidth: 1,
										borderColor: COLORS.neutral350,
										borderStyle: "dashed",
										backgroundColor: COLORS.neutral0,
										alignItems: "center",
										justifyContent: "center",
										overflow: "hidden",
									}}
								>
									<TouchableOpacity
										activeOpacity={0.85}
										disabled={imageUploading}
										onPress={pickImage}
										style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
									>
										{imageUploading ? (
											<ActivityIndicator size="small" color={COLORS.neutral800} />
										) : (
											<Text style={{ fontSize: 28, fontWeight: "700", color: COLORS.neutral800, marginTop: -1 }}>+</Text>
										)}
									</TouchableOpacity>
								</View>
							)}
						</ScrollView>

						<Text style={{ fontWeight: "700", marginBottom: 6 }}>Participants cap</Text>
						<TextInput
							value={editCap}
							onChangeText={setEditCap}
							placeholder="e.g. 20"
							keyboardType="numeric"
							style={{ backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 }}
						/>

						<TouchableOpacity
							disabled={savingEvent || !isDirty}
							onPress={onSaveEventInfo}
							style={{
								backgroundColor: savingEvent || !isDirty ? "#9ca3af" : COLORS.brandOrangeDeep,
								paddingVertical: 12,
								borderRadius: 10,
								alignItems: "center",
							}}
						>
							<Text style={{ color: "#fff", fontWeight: "800" }}>{savingEvent ? "Saving..." : "Save changes"}</Text>
						</TouchableOpacity>

						<TouchableOpacity
							disabled={cancellingEvent || !canCancelSelectedEvent}
							onPress={() => setConfirmCancelVisible(true)}
							style={{
								marginTop: 10,
								backgroundColor: cancellingEvent || !canCancelSelectedEvent ? "#9ca3af" : COLORS.brandOrangeDeep,
								paddingVertical: 12,
								borderRadius: 10,
								alignItems: "center",
							}}
						>
							<Text style={{ color: "#fff", fontWeight: "900" }}>{cancellingEvent ? "Cancelling..." : "Cancel Event"}</Text>
						</TouchableOpacity>
					</View>
				</>
			)}
					</ScrollView>
				</View>
				<View style={{ flex: 1, display: managementMode === 'trainingSession' ? 'flex' : 'none' }}>
					<TrainingSessionPanel coachId={organizerId} />
				</View>
			</View>

			<Modal transparent visible={actionMenuVisible} animationType="fade" onRequestClose={() => setActionMenuVisible(false)}>
				<Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.01)" }} onPress={() => setActionMenuVisible(false)}>
					{(() => {
						const { width, height } = Dimensions.get("window");
						const MENU_W = 170;
						const MENU_H = 92;
						const x = actionMenuPos?.x ?? 16;
						const y = actionMenuPos?.y ?? 120;
						const left = Math.min(Math.max(x - MENU_W + 18, 12), Math.max(12, width - MENU_W - 12));
						const top = Math.min(y + 10, Math.max(12, height - MENU_H - 12));
						return (
							<Pressable
								style={{
									position: "absolute",
									left,
									top,
									width: MENU_W,
									backgroundColor: "#fff",
									borderRadius: 12,
									paddingVertical: 6,
									shadowColor: "#000",
									shadowOpacity: 0.15,
									shadowRadius: 12,
									elevation: 6,
								}}
								onPress={() => {}}
							>
								<TouchableOpacity activeOpacity={0.75} onPress={() => setActionMenuVisible(false)} style={{ paddingVertical: 10, paddingHorizontal: 12 }}>
									<Text style={{ fontWeight: "800", color: "#111827" }}>Report</Text>
								</TouchableOpacity>
								<View style={{ height: 1, backgroundColor: "#e5e7eb" }} />
								<TouchableOpacity
									activeOpacity={0.75}
									onPress={() => {
										setActionMenuVisible(false);
										setConfirmBlockVisible(true);
									}}
									style={{ paddingVertical: 10, paddingHorizontal: 12 }}
								>
									<Text style={{ fontWeight: "900", color: "#B91C1C" }}>Block</Text>
								</TouchableOpacity>
							</Pressable>
						);
					})()}
				</Pressable>
			</Modal>

			<Modal transparent visible={confirmBlockVisible} animationType="fade" onRequestClose={() => setConfirmBlockVisible(false)}>
				<View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 }}>
					<View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
						<Text style={{ fontSize: 16, fontWeight: "800", color: "#111827" }}>Confirm Block</Text>
						<Text style={{ marginTop: 8, color: "#374151" }}>Are you sure you want to block this user ?</Text>
						<View style={{ flexDirection: "row", marginTop: 14 }}>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={() => setConfirmBlockVisible(false)}
								style={{ flex: 1, backgroundColor: "#f3f4f6", paddingVertical: 12, borderRadius: 12, alignItems: "center", marginRight: 10 }}
								disabled={blocking}
							>
								<Text style={{ fontWeight: "800", color: "#111827" }}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={onConfirmBlock}
								style={{ flex: 1, backgroundColor: blocking ? "#9ca3af" : "#B91C1C", paddingVertical: 12, borderRadius: 12, alignItems: "center" }}
								disabled={blocking}
							>
								<Text style={{ fontWeight: "900", color: "#fff" }}>{blocking ? "Blocking..." : "Block"}</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>

			<Modal transparent visible={confirmCancelVisible} animationType="fade" onRequestClose={() => setConfirmCancelVisible(false)}>
				<View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 }}>
					<View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
						<Text style={{ fontSize: 16, fontWeight: "800", color: "#111827" }}>Confirm Cancel</Text>
						<Text style={{ marginTop: 8, color: "#374151" }}>Are you sure you want to cancel this event?</Text>
						<View style={{ flexDirection: "row", marginTop: 14 }}>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={() => setConfirmCancelVisible(false)}
								style={{ flex: 1, backgroundColor: "#f3f4f6", paddingVertical: 12, borderRadius: 12, alignItems: "center", marginRight: 10 }}
								disabled={cancellingEvent}
							>
								<Text style={{ fontWeight: "800", color: "#111827" }}>No</Text>
							</TouchableOpacity>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={onConfirmCancelEvent}
								style={{ flex: 1, backgroundColor: cancellingEvent ? "#9ca3af" : "#B91C1C", paddingVertical: 12, borderRadius: 12, alignItems: "center" }}
								disabled={cancellingEvent || !canCancelSelectedEvent}
							>
								<Text style={{ fontWeight: "900", color: "#fff" }}>{cancellingEvent ? "Cancelling..." : "Yes"}</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>

			<Modal transparent visible={confirmRemoveVisible} animationType="fade" onRequestClose={() => setConfirmRemoveVisible(false)}>
				<View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 }}>
					<View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
						<Text style={{ fontSize: 16, fontWeight: "800", color: "#111827" }}>Confirm Remove</Text>
						<Text style={{ marginTop: 8, color: "#374151" }}>Remove this user from block list ?</Text>
						<View style={{ flexDirection: "row", marginTop: 14 }}>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={() => {
									setConfirmRemoveVisible(false);
									setRemoveCandidate(null);
								}}
								style={{ flex: 1, backgroundColor: "#f3f4f6", paddingVertical: 12, borderRadius: 12, alignItems: "center", marginRight: 10 }}
							>
								<Text style={{ fontWeight: "800", color: "#111827" }}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={onConfirmRemoveBlockedUser}
								style={{ flex: 1, backgroundColor: "#2563eb", paddingVertical: 12, borderRadius: 12, alignItems: "center" }}
								disabled={removeCandidate == null}
							>
								<Text style={{ fontWeight: "900", color: "#fff" }}>Remove</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>

			<Modal
				transparent
				visible={removeImageConfirmVisible}
				animationType="fade"
				onRequestClose={() => {
					setRemoveImageConfirmVisible(false);
					setRemoveImageCandidateUri(null);
				}}
			>
				<View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 }}>
					<View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
						<Text style={{ fontSize: 16, fontWeight: "800", color: "#111827" }}>Remove image</Text>
						<Text style={{ marginTop: 8, color: "#374151" }}>Do you want to remove this image?</Text>
						<View style={{ flexDirection: "row", marginTop: 14 }}>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={() => {
									setRemoveImageConfirmVisible(false);
									setRemoveImageCandidateUri(null);
								}}
								style={{ flex: 1, backgroundColor: "#f3f4f6", paddingVertical: 12, borderRadius: 12, alignItems: "center", marginRight: 10 }}
							>
								<Text style={{ fontWeight: "800", color: "#111827" }}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								activeOpacity={0.8}
								onPress={onConfirmRemoveImage}
								style={{ flex: 1, backgroundColor: removeImageCandidateUri ? "#2563eb" : "#9ca3af", paddingVertical: 12, borderRadius: 12, alignItems: "center" }}
								disabled={!removeImageCandidateUri}
							>
								<Text style={{ fontWeight: "900", color: "#fff" }}>Remove</Text>
							</TouchableOpacity>
						</View>
					</View>
				</View>
			</Modal>
		</View>
	);
}
