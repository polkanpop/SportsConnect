import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { listEventsCombinedCached, CombinedEvent, CourtInfoRow } from '@/lib/backendApi'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import { useFocusEffect } from 'expo-router'

// Reuse helper from courtList (duplicated locally to avoid circular import)
function asArray(v: CourtInfoRow['sport'] | CourtInfoRow['venue'] | undefined | null): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}
const normaliseKey = (s: string) => s.replace(/\s+/g, '').toLowerCase()

// Sport color map (same palette)
const SPORT_COLORS: Record<string, { bg: string; color: string; border?: string }> = {
  football: { bg: COLORS.white, color: COLORS.neutral975, border: COLORS.neutral525 },
  soccer: { bg: COLORS.white, color: COLORS.neutral975, border: COLORS.neutral525 },
  tennis: { bg: COLORS.limeGreen, color: COLORS.white },
  tabletennis: { bg: COLORS.limeGreen, color: COLORS.white },
  badminton: { bg: COLORS.limeGreen, color: COLORS.white },
  basketball: { bg: COLORS.orange500, color: COLORS.neutral975 },
  volleyball: { bg: COLORS.orange500, color: COLORS.neutral975 },
  golf: { bg: COLORS.seaGreen, color: COLORS.white },
  running: { bg: COLORS.steelBlue, color: COLORS.white },
  pickleball: { bg: COLORS.hotPink, color: COLORS.neutral975 },
}

function formatPaymentMethod(method: string) {
  switch (method?.toLowerCase()) {
    case 'cash': return 'Cash'
    case 'vnpay': return 'VNPay'
    default: return method
  }
}

function formatCurrency(n: number | null | undefined) {
  if (n == null) return ''
  const s = String(Math.round(Number(n)))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const EventListScreen = () => {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [allEvents, setAllEvents] = useState<CombinedEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'sport' | 'venue' | 'payment' | null>(null)
  const [selectedSports, setSelectedSports] = useState<string[]>([])
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [freeOnly, setFreeOnly] = useState<boolean>(false)
  const [paymentSelections, setPaymentSelections] = useState<string[]>([]) // 'cash','vnpay'

  // React Query fetch with cache key; create/update screens invalidate this key.
  const { data: eventsData, isLoading: loading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.eventsCombined,
    queryFn: () => listEventsCombinedCached(),
    staleTime: 30_000,
  })
  // Push data into local state for existing code references.
  useEffect(() => { if (Array.isArray(eventsData)) setAllEvents(eventsData) }, [eventsData])
  useEffect(() => { if (!loading && !eventsData) setError('Failed loading events') }, [loading, eventsData])
  // Refresh on screen focus (handles coming back after edit/create/delete)
  useFocusEffect(useCallback(() => { refetch() }, [refetch]))

  // Derive options
  const sportOptions = useMemo(() => {
    const set = new Set<string>()
    allEvents.forEach(ev => asArray(ev.sport).forEach(s => set.add(s)))
    return [...set].sort((a,b) => a.localeCompare(b))
  }, [allEvents])
  const venueOptions = useMemo(() => {
    const set = new Set<string>()
    allEvents.forEach(ev => asArray(ev.venue).forEach(v => set.add(v)))
    return [...set].sort((a,b) => a.localeCompare(b))
  }, [allEvents])

  // Filtering
  const filteredEvents = useMemo(() => {
    return allEvents.filter(ev => {
      const status = String((ev as any)?.status ?? '').toLowerCase()
      if (status.includes('cancel')) {
        const cancelledAt = typeof (ev as any)?._cancelledAt === 'number' ? (ev as any)._cancelledAt : 0
        // Unlist cancelled events; allow a short grace window for freshly-cancelled items.
        if (!cancelledAt) return false
        if (Date.now() - cancelledAt >= 15_000) return false
      }
      // text search
      const title = (ev.title || '').toLowerCase()
      const address = (ev.address || '').toLowerCase()
      const queryOk = !search || title.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if (!queryOk) return false
      // sport & venue filters
      const sports = asArray(ev.sport)
      const venues = asArray(ev.venue)
      const sportOk = selectedSports.length === 0 || sports.some(s => selectedSports.includes(s))
      const venueOk = selectedVenues.length === 0 || selectedVenues.every(sel => venues.includes(sel))
      if (!sportOk || !venueOk) return false
      // Free filter
      if (freeOnly) {
        if (ev.entry_fee != null) return false
      } else {
        // Payment method filter (only when not free)
        if (paymentSelections.length) {
          const method = (ev.support_payment_method || '').toLowerCase()
          if (paymentSelections.length === 1) {
            const allowed = new Set<string>(paymentSelections)
            if (paymentSelections.some(m => m === 'cash' || m === 'vnpay')) allowed.add('both')
            if (!allowed.has(method)) return false
          } else {
            if (method !== 'both') return false
          }
        }
      }
      return true
    })
  }, [allEvents, search, selectedSports, selectedVenues, freeOnly, paymentSelections])

  const toggleFree = () => {
    setFreeOnly(f => {
      const next = !f
      if (next) setPaymentSelections([]) // disable payment filter when free is active
      return next
    })
  }
  const togglePaymentFilterPanel = () => {
    if (freeOnly) return
    setOpenFilter(f => f === 'payment' ? null : 'payment')
  }
  const togglePaymentSelection = (opt: string) => {
    setPaymentSelections(prev => {
      let next = prev.includes(opt) ? prev.filter(x => x !== opt) : [...prev, opt]
      return next
    })
  }

  // Pagination state for incremental rendering
  const BATCH_SIZE = 15
  const [visibleCount, setVisibleCount] = useState<number>(BATCH_SIZE)
  useEffect(() => { setVisibleCount(BATCH_SIZE) }, [search, selectedSports, selectedVenues])
  const handleScroll = useCallback((e: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y)
    if (distanceFromBottom < 40) {
      setVisibleCount(prev => prev >= filteredEvents.length ? prev : Math.min(prev + BATCH_SIZE, filteredEvents.length))
    }
  }, [filteredEvents])

  const toggleSport = (s: string) => setSelectedSports(p => p.includes(s) ? p.filter(x => x!==s) : [...p, s])
  const toggleVenue = (v: string) => setSelectedVenues(p => p.includes(v) ? p.filter(x => x!==v) : [...p, v])
  const toggleExpand = (id: number) => setExpandedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const handleOutsidePress = () => { if (openFilter) setOpenFilter(null) }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Back */}
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
      </View>
      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchContainer}>
          <Image source={ICONS.search} style={styles.searchIcon} />
          <TextInput
            placeholder='Search events...'
            placeholderTextColor={COLORS.neutral750}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
          />
        </View>
      </View>
      <View style={styles.container}>
        {/* Filters */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersInner}>
          <TouchableOpacity style={[styles.filterButton, (openFilter === 'sport' || selectedSports.length>0) && styles.filterButtonActive]} onPress={() => setOpenFilter(openFilter==='sport'?null:'sport')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'sport' || selectedSports.length>0) && styles.filterTextActive]}>Sport</Text>
            {selectedSports.length>0 && <Text style={styles.countBadge}>{selectedSports.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterButton, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterButtonActive]} onPress={() => setOpenFilter(openFilter==='venue'?null:'venue')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={[styles.filterText, (openFilter === 'venue' || selectedVenues.length>0) && styles.filterTextActive]}>Venue</Text>
            {selectedVenues.length>0 && <Text style={styles.countBadge}>{selectedVenues.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterButton, freeOnly && styles.filterButtonActive]} onPress={toggleFree}>
            <Image source={ICONS.freeIcon} style={styles.filterIcon} />
            <Text style={[styles.filterText, freeOnly && styles.filterTextActive]}>Free</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterButton, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterButtonActive, freeOnly && styles.filterButtonDisabled]}
            onPress={togglePaymentFilterPanel}
            disabled={freeOnly}
          >
            <Image source={ICONS.paymentMethod} style={[styles.filterIcon, freeOnly && { tintColor: COLORS.neutral600 }]} />
            <Text style={[styles.filterText, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterTextActive, freeOnly && { color: COLORS.neutral650 }]}>Payment</Text>
            {paymentSelections.length>0 && !freeOnly && <Text style={styles.countBadge}>{paymentSelections.length}</Text>}
          </TouchableOpacity>
          </ScrollView>
        </View>
        <Text style={styles.sectionTitle}>Events</Text>
        {openFilter && openFilter !== 'payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {(openFilter==='sport'?sportOptions:venueOptions).map(opt => {
                const selected = openFilter==='sport'?selectedSports.includes(opt):selectedVenues.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => openFilter==='sport'?toggleSport(opt):toggleVenue(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}
        {openFilter === 'payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {['cash','vnpay'].map(opt => {
                const selected = paymentSelections.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => togglePaymentSelection(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt === 'cash' ? 'Cash' : 'VNPay'}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
              {paymentSelections.length===0 && <Text style={{ padding:10, fontSize:12, color: COLORS.neutral850 }}>Select payment methods to filter events.</Text>}
              
            </ScrollView>
          </View>
        )}
        {openFilter && <Pressable style={styles.overlay} onPress={handleOutsidePress} />}
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 100 }}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl
              refreshing={loading || isFetching}
              onRefresh={() => refetch()}
            />
          }
        >
          {(loading || isFetching) && <Text style={styles.statusText}>Loading events...</Text>}
          {error && <Text style={[styles.statusText,{color: COLORS.danger}]}>Failed: {error}</Text>}
          {!loading && !isFetching && !error && filteredEvents.length === 0 && (
            <Text style={[styles.statusText, { paddingVertical: 30 }]}>No matching events.</Text>
          )}
          {filteredEvents.slice(0, visibleCount).map(ev => {
              const sports = asArray(ev.sport)
              const venues = asArray(ev.venue)
              let venueDisplay: string[] = []
              const lowerVenues = venues.map(v => v.toLowerCase())
              if (lowerVenues.includes('indoor') && lowerVenues.includes('outdoor')) venueDisplay=['In/Outdoor']
              else if (venues.length) venueDisplay=[venues[0]]
              const expanded = expandedIds.has(ev.eventid)
              return (
                <TouchableOpacity
                  key={ev.eventid}
                  activeOpacity={0.8}
                  style={[styles.card, expanded && styles.cardExpanded]}
                  onPress={() => router.push(`/event/eventBooking?eventid=${ev.eventid}` as any)}
                >
                  <View style={styles.cardLeft}>
                    <View style={styles.titleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{ev.title || `Event ${ev.eventid}`}</Text>
                      <TouchableOpacity onPress={() => toggleExpand(ev.eventid)} style={styles.expandButton}>
                        <Image source={ICONS.arrowdown} style={[styles.expandIcon, expanded && { transform:[{rotate:'180deg'}]}]} />
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.dateText}>{(() => {
                      const start = ev.start_timestamp || ev.time
                      const end = ev.end_timestamp
                      if (!start) return 'Unknown date'
                      const startD = new Date(start)
                      const endD = end ? new Date(end) : null
                      const day = startD.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })
                      const startTime = startD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })
                      const endTime = endD ? endD.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : ''
                      return `${day}, ${startTime}${endTime?` - ${endTime}`:''}`
                    })()}</Text>
                    <View style={styles.tagRow}>
                      {sports.length===0 && <View style={[styles.tag, styles.tagFallback]}><Text style={styles.tagText}>Sport N/A</Text></View>}
                      {sports.map(s => {
                        const key = normaliseKey(s)
                        const cfg = SPORT_COLORS[key]
                        return (
                          <View key={s} style={[styles.tag, cfg ? { backgroundColor: cfg.bg, borderColor: cfg.border||'transparent', borderWidth: cfg.border?1:0 } : styles.tagFallback]}>
                            <Text style={[styles.tagText, cfg && { color: cfg.color }]}>{s}</Text>
                          </View>
                        )
                      })}
                      {venueDisplay.map(v => (
                        <View key={v} style={[styles.tag, styles.venueTag]}><Text style={[styles.tagText,{color: COLORS.white}]}>{v}</Text></View>
                      ))}
                    </View>
                    {/* Entry fee + payment methods displayed on their own line */}
                    <View style={styles.entryRow}>
                      <View style={[styles.tag, ev.entry_fee == null ? styles.freeTag : styles.entryTag, styles.entryTagRow]}>
                        <Text style={[styles.tagText, ev.entry_fee == null ? styles.freeTagText : styles.entryTagText]}>{ev.entry_fee == null ? 'Entry: Free' : `${formatCurrency(ev.entry_fee)}₫/player`}</Text>
                      </View>
                      {ev.entry_fee != null && ev.support_payment_method && (
                        <View style={[styles.tag, styles.methodTag, styles.methodIcons, styles.methodIconsRow]}>
                          {(ev.support_payment_method.toLowerCase()==='cash' || ev.support_payment_method.toLowerCase()==='both') && (
                            <Image source={ICONS.cashIcon} style={styles.methodIconImg} />
                          )}
                          {(ev.support_payment_method.toLowerCase()==='vnpay' || ev.support_payment_method.toLowerCase()==='both') && (
                            <Image source={ICONS.vnpayIcon} style={styles.methodIconImg} />
                          )}
                        </View>
                      )}
                    </View>
                    <View style={styles.participantsRow}>
                      <Image source={ICONS.participants} style={styles.participantsIconLarge} />
                      <Text style={styles.participantsText}>{(ev.numberofpeople ?? 0)}/{(ev.participants_cap ?? 0)} participants</Text>
                    </View>
                    {expanded && (
                      <View style={styles.expandedContent}>
                        <Text style={styles.expandedLine}>Organizer: {ev.organizerName || ev.organizerid}</Text>
                        <Text style={styles.expandedLine}>Address: {ev.address || 'Unknown address'}</Text>
                        <Text style={styles.expandedDescLabel}>Description:</Text>
                        <Text style={styles.expandedDesc} numberOfLines={4}>{ev.description || 'No description'}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.cardRight}>
                    <View style={styles.placeholderImg} />
                    <Image source={ICONS.arrowright} style={styles.arrowIcon} />
                  </View>
                </TouchableOpacity>
              )
            })}
        </ScrollView>
      </View>
      {/* Floating Create Button */}
      <TouchableOpacity style={[styles.fab, { bottom: 30 + Math.max(insets.bottom || 0, 12) }]} onPress={() => router.push('/event/eventCreate' as any)}>
        <Image source={ICONS.buttonBooking} style={styles.fabIcon} />
        <Text style={styles.fabText}>Create</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

export default EventListScreen

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:COLORS.white},
  headerRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingTop:6,marginBottom:13},
  backButton:{padding:8,marginRight:8,borderRadius:28,backgroundColor:COLORS.neutral175},
  backIcon:{width:24,height:24,tintColor:COLORS.neutral925,resizeMode:'contain'},
  searchRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingBottom:4},
  searchContainer:{flex:1,flexDirection:'row',alignItems:'center',backgroundColor:COLORS.neutral125,borderRadius:24,paddingHorizontal:14,paddingVertical:10},
  searchIcon:{width:18,height:18,tintColor:COLORS.neutral800,marginRight:8,resizeMode:'contain'},
  searchInput:{flex:1,color:COLORS.neutral975,fontSize:15,paddingVertical:0},
  container:{flex:1,paddingHorizontal:12,paddingTop:4},
  filterRow:{marginBottom:12},
  filtersInner:{flexDirection:'row',gap:10,paddingRight:4},
  filterButton:{flexDirection:'row',alignItems:'center',backgroundColor:COLORS.neutral125,paddingHorizontal:12,paddingVertical:6,borderRadius:20},
  filterButtonActive:{backgroundColor:COLORS.limeGreen},
  filterButtonDisabled:{backgroundColor:COLORS.neutral200, opacity:0.6},
  filterIcon:{width:16,height:16,tintColor:COLORS.neutral800,marginRight:6,resizeMode:'contain'},
  filterText:{color:COLORS.neutral950,fontSize:13,fontWeight:'600'},
  filterTextActive:{ color:COLORS.white },
  countBadge:{marginLeft:6,backgroundColor:COLORS.neutral525,color:COLORS.neutral975,paddingHorizontal:6,paddingVertical:2,borderRadius:10,fontSize:11,overflow:'hidden',fontWeight:'600'},
  
  sectionTitle:{fontSize:22,fontWeight:'500',color:COLORS.neutral950,marginBottom:12,marginLeft:4,marginTop:15},
  dropdownWrapper:{position:'absolute',top:100,left:12,right:12,zIndex:20},
  dropdown:{maxHeight:200,backgroundColor:COLORS.white,borderRadius:8,paddingVertical:4,borderWidth:1,borderColor:COLORS.neutral350},
  dropdownItem:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:12,paddingVertical:8},
  dropdownItemText:{color:COLORS.neutral950,fontSize:14},
  tickBox:{width:20,height:20,borderRadius:4,borderWidth:1,borderColor:COLORS.neutral550,alignItems:'center',justifyContent:'center'},
  tickBoxSelected:{backgroundColor:COLORS.limeGreen,borderColor:COLORS.limeGreen},
  tickText:{color:COLORS.white,fontSize:14},
  overlay:{position:'absolute',top:0,left:0,right:0,bottom:0},
  list:{flex:1,marginTop:14},
  statusText:{color:COLORS.neutral800,fontSize:12,paddingVertical:12,textAlign:'center'},
  card:{flexDirection:'row',backgroundColor:COLORS.surfaceDark,borderRadius:14,padding:16,marginBottom:16,alignItems:'flex-start',minHeight:140},
  cardExpanded:{minHeight:180},
  cardLeft:{flex:1,paddingRight:12},
  titleRow:{flexDirection:'row',alignItems:'center'},
  expandButton:{padding:4,marginLeft:6},
  expandIcon:{width:18,height:18,tintColor:COLORS.neutral500},
  cardTitle:{color:COLORS.white,fontSize:16,fontWeight:'700',flexShrink:1},
  dateText:{color:COLORS.neutral500,fontSize:12,marginTop:4,marginBottom:2},
  tagRow:{flexDirection:'row',flexWrap:'wrap',marginTop:8},
  tag:{backgroundColor:COLORS.neutral925,paddingHorizontal:8,paddingVertical:4,borderRadius:12,marginRight:6,marginBottom:6,flexDirection:'row',alignItems:'center'},
  tagFallback:{backgroundColor:COLORS.neutral900},
  venueTag:{backgroundColor:COLORS.slateBlue},
  freeTag:{backgroundColor:COLORS.greenSoft, borderColor:COLORS.seaGreen, borderWidth:1},
  entryTag:{backgroundColor:COLORS.orangeSoft, borderColor:COLORS.orangeAccent, borderWidth:1},
  methodTag:{backgroundColor:COLORS.blue50, borderColor:COLORS.blue500, borderWidth:1},
  methodIcons:{flexDirection:'row',alignItems:'center'},
  methodIconImg:{width:16,height:16,resizeMode:'contain',marginHorizontal:2},
  entryRow:{flexDirection:'row',alignItems:'center',marginTop:8,marginBottom:6},
  entryTagRow:{paddingHorizontal:10,paddingVertical:6},
  methodIconsRow:{flexDirection:'row',alignItems:'center',marginLeft:8},
  tagText:{color:COLORS.neutral525,fontSize:11,fontWeight:'600'},
  freeTagText:{color:COLORS.green900,fontSize:11,fontWeight:'700'},
  entryTagText:{color:COLORS.brown900,fontSize:11,fontWeight:'700'},
  participantsRow:{flexDirection:'row',alignItems:'center',marginTop:8},
  participantsIcon:{width:14,height:14,tintColor:COLORS.neutral525,marginRight:4,resizeMode:'contain'},
  participantsIconLarge:{width:18,height:18,tintColor:COLORS.neutral525,marginRight:6,resizeMode:'contain'},
  participantsText:{color:COLORS.neutral525,fontSize:12,fontWeight:'600'},
  expandedContent:{marginTop:12},
  expandedLine:{color:COLORS.neutral550,fontSize:12,marginBottom:6},
  expandedDescLabel:{color:COLORS.neutral550,fontSize:12,marginTop:6,fontWeight:'700'},
  expandedDesc:{color:COLORS.neutral525,fontSize:12,marginTop:6,lineHeight:16},
  cardRight:{alignItems:'center'},
  placeholderImg:{width:70,height:70,backgroundColor:COLORS.surfaceDarker,borderRadius:10,marginBottom:6},
  arrowIcon:{width:22,height:22,tintColor:COLORS.neutral700,position:'absolute',left:53,top:80},
  fab:{position:'absolute',right:20,bottom:30,backgroundColor:COLORS.orangeAccent,paddingHorizontal:18,paddingVertical:12,borderRadius:30,flexDirection:'row',alignItems:'center',shadowColor:COLORS.black,shadowOpacity:0.3,shadowRadius:6,elevation:5},
  fabIcon:{width:22,height:22,tintColor:COLORS.white,marginRight:8,resizeMode:'contain'},
  fabText:{color:COLORS.white,fontSize:14,fontWeight:'700'},
})