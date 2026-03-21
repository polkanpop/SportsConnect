import { ICONS } from "@/constants/icons";
import { COLORS } from "@/constants/colors";
import { deleteNotifications, listNotifications, markAllNotificationsRead, markNotificationRead, type NotificationCategory, type NotificationRow } from "@/lib/backendApi";
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { listHistory, type HistoryEntry } from '@/storage/history'
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, SectionList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

function parseNotificationDate(raw: string): Date | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  // DB stores UTC; if timezone is missing, force UTC to avoid local-time drift.
  const normalized = s.replace(' ', 'T')
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  let d = new Date(hasTimezone ? normalized : `${normalized}Z`)
  if (!Number.isNaN(d.getTime())) return d

  d = new Date(s)
  if (!Number.isNaN(d.getTime())) return d

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(normalized)) {
    d = new Date(`${normalized}Z`)
    if (!Number.isNaN(d.getTime())) return d
  }

  return null
}

export default function NotificationsPage() {
  const { dashboard, notifications, userId } = useAppBootstrap()
  const [selectedCategory, setSelectedCategory] = useState<"All" | "Court" | "Event" | "Training">("All");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [historyRows, setHistoryRows] = useState<HistoryEntry[]>([])
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleteMode, setDeleteMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

  const categoryParam: NotificationCategory | undefined = useMemo(() => {
    if (selectedCategory === 'Court') return 'court'
    if (selectedCategory === 'Event') return 'event'
    if (selectedCategory === 'Training') return 'training'
    return undefined
  }, [selectedCategory])

  // Silently refresh notifications whenever the tab is focused (at most once per 30 s)
  const lastSilentRefreshRef = useRef<number>(0);
  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - lastSilentRefreshRef.current < 30_000) return;
      lastSilentRefreshRef.current = now;
      listNotifications({ category: categoryParam })
        .then(fresh => {
          const sorted = [...fresh].sort((a, b) => {
            const bt = parseNotificationDate(b.time)?.getTime() ?? 0;
            const at = parseNotificationDate(a.time)?.getTime() ?? 0;
            return bt - at;
          });
          setRows(sorted);
        })
        .catch(() => { /* silent — user can pull-to-refresh if needed */ });
    }, [categoryParam])
  );

  const typeToCategory = useCallback((type: string): NotificationCategory | null => {
    switch (type) {
      case 'courtbooking':
        return 'court'
      case 'eventbooking':
      case 'event':
        return 'event'
      case 'tsbooking':
      case 'trainingsession':
        return 'training'
      default:
        return null
    }
  }, [])

  const getRowCategory = useCallback((row: NotificationRow): NotificationCategory | null => {
    return (row.category as any) || typeToCategory(row.notificationtype) || null
  }, [typeToCategory])

  useEffect(() => {
    let active = true
    if (typeof userId !== 'number') {
      setHistoryRows([])
      return
    }
    ;(async () => {
      const entries = await listHistory(userId)
      if (!active) return
      setHistoryRows(Array.isArray(entries) ? entries : [])
    })()
    return () => {
      active = false
    }
  }, [userId])

  const getDecisionFromStatuses = useCallback((fromRaw: unknown, toRaw: unknown): 'approved' | 'rejected' | null => {
    const from = String(fromRaw ?? '').trim().toLowerCase()
    const to = String(toRaw ?? '').trim().toLowerCase()
    if (!to) return null

    const fromPending = !from || from.includes('pending')
    if (!fromPending) return null

    if (to.includes('approve') || to.includes('joined') || to.includes('accept')) return 'approved'
    if (to.includes('reject') || to.includes('fail') || to.includes('declin') || to.includes('cancel')) return 'rejected'
    return null
  }, [])

  const localOutcomeNotifications = useMemo<NotificationRow[]>(() => {
    const out: NotificationRow[] = []

    for (const h of historyRows) {
      const kind = String(h.kind || '').toLowerCase()
      if (kind !== 'court_booking' && kind !== 'event_booking' && kind !== 'session_booking') continue

      const meta: any = h.meta || {}
      const fromStatus = String(h.fromStatus ?? meta?.fromStatus ?? 'pending')
      const toStatus = String(h.toStatus ?? meta?.status ?? meta?.bookingstatus ?? '')
      const decision = getDecisionFromStatuses(fromStatus, toStatus)
      if (!decision) continue

      const category: NotificationCategory =
        kind === 'court_booking' ? 'court' : kind === 'event_booking' ? 'event' : 'training'

      const bookingId =
        kind === 'court_booking'
          ? Number(meta?.courtbookingid ?? meta?.id ?? NaN)
          : kind === 'event_booking'
            ? Number(meta?.eventbookingid ?? meta?.id ?? NaN)
            : Number(meta?.tsbookingid ?? meta?.id ?? NaN)
      const stableIdBase = Number.isFinite(bookingId)
        ? bookingId
        : Math.abs((h.id || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0))
      const rowId = -1 * (stableIdBase * 10 + (decision === 'approved' ? 1 : 2))

      const message =
        category === 'court'
          ? (decision === 'approved' ? 'Your court booking request was approved.' : 'Your court booking request was rejected.')
          : category === 'event'
            ? (decision === 'approved' ? 'Your event booking request was approved.' : 'Your event booking request was rejected.')
            : (decision === 'approved' ? 'Your training session booking request was approved.' : 'Your training session booking request was rejected.')

      out.push({
        notificationid: rowId,
        status: 'unread',
        userid: typeof userId === 'number' ? userId : 0,
        title: decision === 'approved' ? 'Booking request approved' : 'Booking request rejected',
        message,
        time: h.ts,
        notificationtype: category === 'court' ? 'courtbooking' : category === 'event' ? 'eventbooking' : 'tsbooking',
        notificationtypeid: Number.isFinite(bookingId) ? bookingId : null,
        category,
        kind: 'booking_outcome',
        data: {
          fromStatus,
          toStatus,
          source: 'history',
        },
      })
    }

    const seen = new Set<number>()
    return out
      .sort((a, b) => (parseNotificationDate(b.time)?.getTime() ?? 0) - (parseNotificationDate(a.time)?.getTime() ?? 0))
      .filter((row) => {
        if (seen.has(row.notificationid)) return false
        seen.add(row.notificationid)
        return true
      })
  }, [getDecisionFromStatuses, historyRows, userId])

  const sourceRows = useMemo(() => {
    const baseRemote = Array.isArray(notifications) ? notifications : []
    const base = [...baseRemote, ...localOutcomeNotifications]
    const filtered = categoryParam
      ? base.filter((row) => getRowCategory(row) === categoryParam)
      : base
    return [...filtered].sort((a, b) => {
      const bt = parseNotificationDate(b.time)?.getTime() ?? 0
      const at = parseNotificationDate(a.time)?.getTime() ?? 0
      return bt - at
    })
  }, [notifications, localOutcomeNotifications, categoryParam, getRowCategory])

  useEffect(() => {
    setRows(sourceRows)
  }, [sourceRows])

  const loading = (dashboard.isLoading && rows.length === 0) || actionLoading || refreshing

  const handleRefresh = useCallback(async () => {
    setError(null)
    setRefreshing(true)
    try {
      const fresh = await listNotifications({ category: categoryParam })
      const sorted = [...fresh].sort((a, b) => {
        const bt = parseNotificationDate(b.time)?.getTime() ?? 0
        const at = parseNotificationDate(a.time)?.getTime() ?? 0
        return bt - at
      })
      setRows(sorted)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setRefreshing(false)
    }
  }, [categoryParam])

  const getIconFor = (row: NotificationRow) => {
    const text = `${String(row.title || '')} ${String(row.message || '')} ${String(row.kind || '')}`.toLowerCase()
    if (text.includes('approved') || text.includes('successful') || text.includes('accepted')) {
      return ICONS.successfulNotification
    }
    if (text.includes('rejected') || text.includes('failed') || text.includes('declined')) {
      return ICONS.failedNotification
    }

    const cat = getRowCategory(row)
    const kind = (row.kind || '').toLowerCase()
    if (cat === 'event') return ICONS.eventNoti
    if (cat === 'training') return ICONS.tsNoti
    if (cat === 'court') {
      if (kind === 'submitted' || kind === 'incoming_booking') return ICONS.courtNotiPending
      return ICONS.courtNoti
    }
    return ICONS.notifications
  }

  const getBookingDecision = useCallback((row: NotificationRow): 'approved' | 'rejected' | null => {
    const statusDecision = getDecisionFromStatuses((row as any)?.data?.fromStatus, (row as any)?.data?.toStatus)
    if (statusDecision) return statusDecision
    const text = `${String(row.title || '')} ${String(row.message || '')} ${String(row.kind || '')}`.toLowerCase()
    if (text.includes('approved') || text.includes('successful') || text.includes('accepted')) return 'approved'
    if (text.includes('rejected') || text.includes('failed') || text.includes('declined')) return 'rejected'
    return null
  }, [getDecisionFromStatuses])

  const getDisplayMessage = (row: NotificationRow) => {
    const decision = getBookingDecision(row)
    const category = getRowCategory(row)
    if (!decision || !category) return row.message

    if (category === 'court') {
      return decision === 'approved'
        ? 'Your court booking has been approved.'
        : 'Your court booking has been rejected.'
    }
    if (category === 'event') {
      return decision === 'approved'
        ? 'Your event booking request has been approved.'
        : 'Your event booking request has been rejected.'
    }
    if (category === 'training') {
      return decision === 'approved'
        ? 'Your training session booking request has been approved.'
        : 'Your training session booking request has been rejected.'
    }

    return row.message
  }

  const getSectionTitle = (iso: string) => {
    const d = parseNotificationDate(iso)
    if (!d) return 'Earlier'
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
    const t = d.getTime()
    if (t >= startOfToday) return 'Today'
    if (t >= startOfYesterday) return 'Yesterday'
    return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  }

  const formatRowTime = (iso: string) => {
    const d = parseNotificationDate(iso)
    if (!d) return ''
    const delta = Math.max(0, Date.now() - d.getTime())
    if (delta < 60_000) return 'now'
    if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`
    if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`
    if (delta < 7 * 24 * 60 * 60_000) return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
  }

  const sections = useMemo(() => {
    const buckets = new Map<string, NotificationRow[]>()
    for (const r of rows) {
      const title = getSectionTitle(r.time)
      const arr = buckets.get(title) || []
      arr.push(r)
      buckets.set(title, arr)
    }

    const todayRows = buckets.get('Today') || []
    const yesterdayRows = buckets.get('Yesterday') || []
    buckets.delete('Today')
    buckets.delete('Yesterday')

    const dated = [...buckets.entries()].sort((a, b) => {
      const at = parseNotificationDate(a[1][0]?.time || '')?.getTime() ?? 0
      const bt = parseNotificationDate(b[1][0]?.time || '')?.getTime() ?? 0
      return bt - at
    })

    const out: { title: string; data: NotificationRow[] }[] = [{ title: 'Today', data: todayRows }]
    if (yesterdayRows.length) out.push({ title: 'Yesterday', data: yesterdayRows })
    for (const [title, data] of dated) out.push({ title, data })
    return out
  }, [rows])

  const toggleSelection = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleNotificationClick = async (row: NotificationRow) => {
    const id = row.notificationid
    if (deleteMode) {
      toggleSelection(id)
      return
    }

    // Always toggle expand/collapse — decoupled from read/unread status.
    // This prevents the silent background refresh from breaking the toggle
    // (if the server returns the row as 'unread' again, status no longer gates collapse).
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

    // Side-effect only: mark as read if currently unread
    if ((row.status || '').toLowerCase() !== 'unread') return

    setUpdating(id);
    const idx = rows.findIndex(r => r.notificationid === id);
    if (idx === -1) return;
    const original = rows[idx];
    const updated = { ...original, status: "read" } as NotificationRow;
    setRows(prev => {
      const copy = [...prev];
      copy[idx] = updated;
      return copy;
    });
    try {
      await markNotificationRead(id)
    } catch (e: any) {
      // rollback row status only — keep expanded since user tapped to open
      setRows(prev => {
        const copy = [...prev];
        copy[idx] = original;
        return copy;
      });
      setError(e?.message || String(e))
    } finally {
      setUpdating(null);
    }
  };

  const handleNotificationLongPress = (row: NotificationRow) => {
    setDeleteMode(true)
    setSelectedIds(prev => {
      if (prev.has(row.notificationid)) return prev
      const next = new Set(prev)
      next.add(row.notificationid)
      return next
    })
  }

  const handleMarkAllRead = async () => {
    const unreadCount = rows.reduce((acc, r) => acc + ((r.status || '').toLowerCase() === 'unread' ? 1 : 0), 0)
    if (unreadCount === 0) return
    setActionLoading(true)
    setError(null)
    try {
      await markAllNotificationsRead(categoryParam)
      setRows(prev => prev.map(r => ({ ...r, status: 'read' })))
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setActionLoading(false)
    }
  }

  const handleDeleteSelected = async () => {
    if (!selectedIds.size) return
    setActionLoading(true)
    setError(null)
    const ids = Array.from(selectedIds)
    const keep = new Set(ids)
    const prevRows = rows
    setRows(prev => prev.filter(r => !keep.has(r.notificationid)))
    try {
      await deleteNotifications(ids)
      setSelectedIds(new Set())
      setDeleteMode(false)
    } catch (e: any) {
      setRows(prevRows)
      setError(e?.message || String(e))
    } finally {
      setActionLoading(false)
    }
  }

  const onPressDeleteSelected = () => {
    if (!selectedIds.size || actionLoading) return
    setDeleteConfirmVisible(true)
  }

  const exitDeleteMode = () => {
    setDeleteMode(false)
    setSelectedIds(new Set())
  }

  const renderItem = ({ item }: { item: NotificationRow }) => (
    <TouchableOpacity
      style={[
        styles.notificationRow,
        (item.status || '').toLowerCase() !== "unread" && styles.viewedNotification,
        updating === item.notificationid && styles.updatingRow,
        deleteMode && selectedIds.has(item.notificationid) && styles.selectedNotification,
      ]}
      onPress={() => handleNotificationClick(item)}
      onLongPress={() => handleNotificationLongPress(item)}
      activeOpacity={0.85}
    >
      <Image source={getIconFor(item)} style={styles.notificationIcon} />
      <View style={styles.notificationContent}>
        <View style={styles.titleTimeRow}>
          <Text style={styles.notificationTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.notificationTime}>{formatRowTime(item.time)}</Text>
        </View>
        {expandedIds.has(item.notificationid) && (
          <Text style={styles.notificationMessage}>{getDisplayMessage(item)}</Text>
        )}
        {(item.kind || '').toLowerCase() === 'incoming_booking' && (
          <TouchableOpacity
            style={{ alignSelf: 'flex-start' }}
            onPress={() => router.push({ pathname: '/(tabs)/Home' as any, params: { panel: 'court', courtid: String(item.data?.courtid ?? ''), courtbookingid: String(item.data?.courtbookingid ?? '') } })}
          >
            <Text style={{ color: '#3B82F6', textDecorationLine: 'underline', fontSize: 12, marginTop: 4 }}>View booking</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.neutral0 }}>
      <View style={styles.header}>
        <View style={styles.headerSideSpacer} />
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={styles.headerSideSpacer} />
      </View>

      <View style={styles.topDivider} />

      <View style={styles.toolbar}>
        <View style={styles.dropdownWrap}>
          <TouchableOpacity
            style={styles.dropdownButton}
            onPress={() => setDropdownOpen(v => !v)}
            activeOpacity={0.85}
          >
            <Text style={styles.dropdownButtonText}>{selectedCategory}</Text>
            <Image source={ICONS.arrowdown} style={[styles.dropdownArrow, dropdownOpen ? styles.dropdownArrowOpen : null]} />
          </TouchableOpacity>
          {dropdownOpen && (
            <View style={styles.dropdownMenu}>
              {(['All', 'Court', 'Event', 'Training'] as const).map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setSelectedCategory(opt)
                    setDropdownOpen(false)
                  }}
                >
                  <Text style={[styles.dropdownItemText, opt === selectedCategory ? styles.dropdownItemTextSelected : null]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <TouchableOpacity
          style={styles.historyButtonContainer}
          onPress={() => router.push('/event/history')}
          activeOpacity={0.85}
        >
          <Image source={ICONS.clock} style={styles.historyIcon} />
          <Text style={styles.historyText}>History</Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.loadingWrapper}><ActivityIndicator /></View>
      )}
      {error && (
        <View style={styles.errorWrapper}><Text style={styles.errorText}>{error}</Text></View>
      )}

      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 80 }}
        sections={sections}
        keyExtractor={(item) => item.notificationid.toString()}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <View style={[styles.sectionHeaderWrap, section.title === 'Today' ? styles.sectionHeaderWrapFirst : styles.sectionHeaderWrapAfterToday]}>
            <Text style={styles.sectionHeaderText}>{section.title}</Text>
            {section.title === 'Today' ? (
              <View style={styles.todayActionsRow}>
                {deleteMode ? (
                  <>
                    <TouchableOpacity
                      style={styles.deleteWrap}
                      onPress={exitDeleteMode}
                      activeOpacity={0.85}
                      disabled={actionLoading}
                    >
                      <Image source={ICONS.closeMenu} style={styles.closeIcon} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deleteWrap}
                      onPress={onPressDeleteSelected}
                      activeOpacity={0.85}
                      disabled={actionLoading}
                    >
                      <Image source={ICONS.deleteAll} style={styles.deleteIcon} />
                    </TouchableOpacity>
                  </>
                ) : null}
                <TouchableOpacity style={styles.markAllWrap} onPress={handleMarkAllRead} activeOpacity={0.85} disabled={actionLoading}>
                  <Text style={styles.markAllText}>Mark all as read</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.sectionHeaderActionSpacer} />
            )}
          </View>
        )}
        renderSectionFooter={({ section }) => (
          section.title === 'Today' && section.data.length === 0 ? (
            <View style={styles.emptyTodayWrap}>
              <Text style={styles.emptyTodayText}>You have no notifications today.</Text>
            </View>
          ) : null
        )}
        refreshing={loading}
        onRefresh={handleRefresh}
        stickySectionHeadersEnabled
      />

      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete notifications?</Text>
            <Text style={styles.modalText}>Selected notifications will be deleted permanently.</Text>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => setDeleteConfirmVisible(false)}>
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnDelete]}
                onPress={() => {
                  setDeleteConfirmVisible(false)
                  void handleDeleteSelected()
                }}
              >
                <Text style={styles.modalBtnDeleteText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: COLORS.neutral0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 14,
  },
  headerSideSpacer: {
    width: 78,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: COLORS.neutral975,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  dropdownWrap: {
    alignSelf: 'flex-start',
    position: 'relative',
    zIndex: 30,
    width: 156,
  },
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderRadius: 10,
    backgroundColor: COLORS.neutral0,
  },
  dropdownButtonText: {
    fontSize: 14,
    color: COLORS.neutral975,
    fontWeight: '600',
  },
  dropdownArrow: {
    width: 14,
    height: 14,
    tintColor: COLORS.neutral800,
  },
  dropdownArrowOpen: {
    transform: [{ rotate: '180deg' }]
  },
  dropdownMenu: {
    position: 'absolute',
    top: 46,
    left: 0,
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: COLORS.neutral0,
    zIndex: 40,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.neutral200,
  },
  dropdownItemText: {
    color: COLORS.neutral925,
    fontSize: 14,
  },
  dropdownItemTextSelected: {
    fontWeight: '700',
    color: COLORS.orange,
  },
  historyButtonContainer: {
    backgroundColor: COLORS.darkGray,
    width: 156,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyIcon: {
    width: 16,
    height: 16,
    marginRight: 6,
    tintColor: COLORS.white,
  },
  historyText: {
    fontSize: 14,
    color: COLORS.white,
    fontWeight: '600',
  },
  markAllBtn: {
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  markAllText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.orange,
  },
  topDivider: {
    height: 1,
    backgroundColor: COLORS.neutral300,
  },
  sectionHeaderWrap: {
    backgroundColor: COLORS.neutral0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  sectionHeaderWrapFirst: {
    paddingTop: 24,
  },
  sectionHeaderWrapAfterToday: {
    paddingTop: 26,
  },
  sectionHeaderActionSpacer: {
    width: 10,
  },
  todayActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  deleteWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 30,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderRadius: 8,
    backgroundColor: COLORS.neutral0,
  },
  markAllWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
    borderRadius: 8,
    backgroundColor: COLORS.neutral0,
  },
  deleteIcon: {
    width: 18,
    height: 18,
  },
  closeIcon: {
    width: 16,
    height: 16,
    tintColor: COLORS.neutral925,
  },
  sectionHeaderText: {
    fontSize: 19,
    fontWeight: '800',
    color: COLORS.neutral925,
    lineHeight: 24,
  },
  notificationRow: {
    flexDirection: "row",
    alignItems: 'flex-start',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.neutral200,
  },
  viewedNotification: {
    backgroundColor: COLORS.neutral100,
  },
  selectedNotification: {
    backgroundColor: COLORS.orange100,
  },
  updatingRow: {
    opacity: 0.6,
  },
  notificationIcon: {
    width: 32,
    height: 32,
    marginRight: 12,
    resizeMode: 'contain',
  },
  notificationContent: {
    flex: 1,
  },
  titleTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  notificationTitle: {
    fontWeight: "bold",
    fontSize: 16,
    color: COLORS.neutral975,
    flex: 1,
  },
  notificationMessage: {
    fontSize: 14,
    color: COLORS.neutral800,
    marginTop: 4,
    paddingRight: 2,
  },
  notificationTime: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.neutral700,
    marginLeft: 6,
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
    color: COLORS.danger
  },
  emptyTodayWrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  emptyTodayText: {
    color: COLORS.neutral700,
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    width: '100%',
    backgroundColor: COLORS.neutral0,
    borderRadius: 14,
    padding: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.neutral900,
  },
  modalText: {
    marginTop: 8,
    color: COLORS.neutral700,
    fontSize: 14,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  modalBtn: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginLeft: 8,
  },
  modalBtnCancel: {
    backgroundColor: COLORS.neutral100,
  },
  modalBtnDelete: {
    backgroundColor: '#B91C1C',
  },
  modalBtnCancelText: {
    color: COLORS.neutral900,
    fontWeight: '700',
  },
  modalBtnDeleteText: {
    color: '#fff',
    fontWeight: '800',
  },
});