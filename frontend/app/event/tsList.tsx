import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { COLORS } from '@/constants/colors'
import { listTrainingSessionsCombinedCached, CombinedTrainingSession, CourtInfoRow } from '@/lib/backendApi'
import { useQuery } from '@tanstack/react-query'
import { useFocusEffect } from 'expo-router'

function asArray(v: CourtInfoRow['venue'] | undefined | null): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('|')) return v.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    return [v.trim()]
  }
  return []
}

const LIST_ACCENT = '#7c3aed' // Training sessions

const TrainingSessionListScreen = () => {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [allSessions, setAllSessions] = useState<CombinedTrainingSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'venue' | 'payment' | null>(null)
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [freeOnly, setFreeOnly] = useState(false)
  const [paymentSelections, setPaymentSelections] = useState<string[]>([])

  const { data: sessionsData, isLoading: loading, isFetching, refetch } = useQuery({
    queryKey: ['trainingSessionsCombinedList'],
    queryFn: () => listTrainingSessionsCombinedCached(),
    staleTime: 30_000,
  })
  useEffect(() => { if(Array.isArray(sessionsData)) setAllSessions(sessionsData) }, [sessionsData])
  useEffect(() => { if(!loading && !sessionsData) setError('Failed loading sessions') }, [loading, sessionsData])
  useFocusEffect(useCallback(()=>{ refetch() },[refetch]))

  const venueOptions = useMemo(() => {
    const s = new Set<string>(); allSessions.forEach(r => asArray(r.venue).forEach(x => s.add(x)))
    return [...s].sort((a,b)=>a.localeCompare(b))
  }, [allSessions])

  const filteredSessions = useMemo(() => {
    return allSessions.filter(s => {
      const title = (s.title||'').toLowerCase(); const address=(s.address||'').toLowerCase()
      const queryOk = !search || title.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if(!queryOk) return false
      const venues = asArray(s.venue)
      const venueOk = selectedVenues.length===0 || selectedVenues.every(sel => venues.includes(sel))
      if(!venueOk) return false
      // Free filter logic (assumes entry_fee meta similar to events; if absent treat as free)
      const entryFee = (s as any).entry_fee
      const supportMethod = ((s as any).support_payment_method||'').toLowerCase()
      if (freeOnly) {
        if (entryFee != null) return false
      } else if (paymentSelections.length) {
        if (paymentSelections.length === 1) {
          const allowed = new Set<string>(paymentSelections)
          if (paymentSelections.some(m => m === 'cash' || m === 'vnpay')) allowed.add('both')
          if (!allowed.has(supportMethod)) return false
        } else {
          // Multiple payment selections -> require item to explicitly support both
          if (supportMethod !== 'both') return false
        }
      }
      return true
    })
  }, [allSessions, search, selectedVenues, freeOnly, paymentSelections])

  const toggleFree = () => {
    setFreeOnly(f => { const next=!f; if (next) setPaymentSelections([]); return next })
  }
  const togglePaymentPanel = () => { if(freeOnly) return; setOpenFilter(f=>f==='payment'?null:'payment') }
  const togglePaymentSelection = (opt:string) => {
    setPaymentSelections(prev => {
      let next = prev.includes(opt)? prev.filter(x=>x!==opt): [...prev,opt]
      return next
    })
  }

  // Incremental rendering state (pagination)
  const BATCH_SIZE = 15
  const [visibleCount, setVisibleCount] = useState<number>(BATCH_SIZE)
  useEffect(() => { setVisibleCount(BATCH_SIZE) }, [search, selectedVenues])
  const handleScroll = useCallback((e: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y)
    if (distanceFromBottom < 40) {
      setVisibleCount(prev => prev >= filteredSessions.length ? prev : Math.min(prev + BATCH_SIZE, filteredSessions.length))
    }
  }, [filteredSessions])

  const toggleVenue = (v: string) => setSelectedVenues(p => p.includes(v)?p.filter(x=>x!==v):[...p,v])
  const toggleExpand = (id: number) => setExpandedIds(prev => { const n=new Set(prev); if(n.has(id)) n.delete(id); else n.add(id); return n })
  const handleOutsidePress = () => { if(openFilter) setOpenFilter(null) }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
      </View>
      <View style={styles.searchRow}>
        <View style={styles.searchContainer}>
          <Image source={ICONS.search} style={styles.searchIcon} />
          <TextInput placeholder='Search sessions...' placeholderTextColor={COLORS.neutral750} value={search} onChangeText={setSearch} style={styles.searchInput} />
        </View>
      </View>
      <View style={styles.container}>
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersInner}>
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
            onPress={togglePaymentPanel}
            disabled={freeOnly}
          >
            <Image source={ICONS.paymentMethod} style={[styles.filterIcon, freeOnly && { tintColor: COLORS.neutral600 }]} />
            <Text style={[styles.filterText, (openFilter === 'payment' || (paymentSelections.length>0 && !freeOnly)) && styles.filterTextActive, freeOnly && { color: COLORS.neutral650 }]}>Payment</Text>
            {paymentSelections.length>0 && !freeOnly && <Text style={styles.countBadge}>{paymentSelections.length}</Text>}
          </TouchableOpacity>
          </ScrollView>
        </View>
        <Text style={styles.sectionTitle}>Training Sessions</Text>
        {openFilter && openFilter!=='payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {venueOptions.map(opt => {
                const selected = selectedVenues.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => toggleVenue(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        )}
        {openFilter==='payment' && (
          <View style={styles.dropdownWrapper}>
            <ScrollView style={styles.dropdown}>
              {['cash','vnpay'].map(opt => {
                const selected = paymentSelections.includes(opt)
                return (
                  <Pressable key={opt} onPress={() => togglePaymentSelection(opt)} style={styles.dropdownItem}>
                    <Text style={styles.dropdownItemText}>{opt==='cash'?'Cash':'VNPay'}</Text>
                    <View style={[styles.tickBox, selected && styles.tickBoxSelected]}>{selected && <Text style={styles.tickText}>✓</Text>}</View>
                  </Pressable>
                )
              })}
              {paymentSelections.length===0 && <Text style={{ padding:10, fontSize:12, color: COLORS.neutral850 }}>Select payment methods to filter sessions.</Text>}
              
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
          {loading && <Text style={styles.statusText}>Loading sessions...</Text>}
          {error && <Text style={[styles.statusText,{color: COLORS.danger}]}>Failed: {error}</Text>}
          {!loading && !error && filteredSessions.length === 0 && (
            <Text style={[styles.statusText, { paddingVertical: 30 }]}>Loading sessions...</Text>
          )}
          {filteredSessions.slice(0, visibleCount).map(s => {
            const venues = asArray(s.venue)
            let venueDisplay:string[]=[]
            const lowerVenues = venues.map(v=>v.toLowerCase())
            if(lowerVenues.includes('indoor') && lowerVenues.includes('outdoor')) venueDisplay=['In/Outdoor']
            else if(venues.length) venueDisplay=[venues[0]]
            const expanded = expandedIds.has(s.sessionid)
            return (
              <TouchableOpacity
                key={s.sessionid}
                activeOpacity={0.8}
                style={[styles.card, expanded && styles.cardExpanded]}
                onPress={() => router.push(`/event/tsBooking?sessionid=${s.sessionid}` as any)}
              >
                <Image source={ICONS.sillball} style={styles.cardSilhouette} />
                <View style={styles.cardLeft}>
                  <View style={styles.titleRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{s.title || `Session ${s.sessionid}`}</Text>
                    <TouchableOpacity onPress={() => toggleExpand(s.sessionid)} style={styles.expandButton}>
                      <Image source={ICONS.arrowdown} style={[styles.expandIcon, expanded && { transform:[{rotate:'180deg'}]}]} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.dateText}>{s.time ? new Date(s.time).toLocaleString() : 'Unknown date'}</Text>
                  <View style={styles.tagRow}>
                    {venueDisplay.map(v => <View key={v} style={[styles.tag, styles.venueTag]}><Text style={[styles.tagText,{color: COLORS.white}]}>{v}</Text></View>)}
                  </View>
                  {/* Entry fee + payment methods displayed on their own line (match events layout) */}
                  <View style={styles.entryRow}>
                    <View style={[styles.tag, (s as any).entry_fee == null ? styles.freeTag : styles.entryTag, styles.entryTagRow]}>
                      <Text style={[styles.tagText, (s as any).entry_fee == null ? styles.freeTagText : styles.entryTagText]}>{(s as any).entry_fee == null ? 'Entry: Free' : `${String(Math.round(Number((s as any).entry_fee))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}₫/player`}</Text>
                    </View>
                    {(s as any).entry_fee != null && (s as any).support_payment_method && (
                      <View style={[styles.tag, styles.methodTag, styles.methodIcons, styles.methodIconsRow]}>
                        {((s as any).support_payment_method.toLowerCase()==='cash' || (s as any).support_payment_method.toLowerCase()==='both') && (
                          <Image source={ICONS.cashIcon} style={styles.methodIconImg} />
                        )}
                        {((s as any).support_payment_method.toLowerCase()==='vnpay' || (s as any).support_payment_method.toLowerCase()==='both') && (
                          <Image source={ICONS.vnpayIcon} style={styles.methodIconImg} />
                        )}
                      </View>
                    )}
                  </View>
                  <View style={styles.participantsRow}>
                    <Image source={ICONS.participants} style={styles.participantsIconLarge} />
                    <Text style={styles.participantsText}>{(s.numberofpeople ?? 0)}/{(s.participants_cap ?? 0)} participants</Text>
                  </View>
                  {expanded && (
                    <View style={styles.expandedContent}>
                      <Text style={styles.expandedLine}>Coach: {s.coachName || s.coachid}</Text>
                      <Text style={styles.expandedLine}>Address: {s.address || 'Unknown address'}</Text>
                      <Text style={styles.expandedDescLabel}>Description:</Text>
                      <Text style={styles.expandedDesc} numberOfLines={4}>{s.description || 'No description'}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      </View>
      <TouchableOpacity style={[styles.fab, { bottom: 30 + Math.max(insets.bottom || 0, 12) }]} onPress={() => router.push('/event/tsCreate' as any)}>
        <Image source={ICONS.buttonBooking} style={styles.fabIcon} />
        <Text style={styles.fabText}>Create</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

export default TrainingSessionListScreen

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
  filterButtonDisabled:{backgroundColor:COLORS.neutral200,opacity:0.6},
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
  card:{flexDirection:'row',backgroundColor:COLORS.white,borderRadius:14,padding:16,marginBottom:16,alignItems:'flex-start',minHeight:140,borderWidth:1,borderColor:'#e5e7eb',borderLeftWidth:5,borderLeftColor:LIST_ACCENT,overflow:'hidden'},
  cardExpanded:{minHeight:180},
  cardLeft:{flex:1,paddingRight:78,zIndex:1},
  cardSilhouette:{position:'absolute',top:-14,right:-18,width:128,height:128,opacity:0.14,tintColor:LIST_ACCENT,resizeMode:'contain',zIndex:0},
  titleRow:{flexDirection:'row',alignItems:'center'},
  expandButton:{padding:4,marginLeft:6},
  expandIcon:{width:18,height:18,tintColor:COLORS.neutral500},
  cardTitle:{color:COLORS.neutral950,fontSize:16,fontWeight:'800',flexShrink:1},
  dateText:{color:COLORS.neutral500,fontSize:12,marginTop:2},
  tagRow:{flexDirection:'row',flexWrap:'wrap',marginTop:6},
  tag:{backgroundColor:COLORS.neutral125,paddingHorizontal:8,paddingVertical:4,borderRadius:12,marginRight:6,marginBottom:6,flexDirection:'row',alignItems:'center'},
  tagFallback:{backgroundColor:COLORS.neutral125},
  freeTag:{backgroundColor:COLORS.greenSoft, borderColor:COLORS.seaGreen, borderWidth:1},
  entryTag:{backgroundColor:COLORS.orangeSoft, borderColor:COLORS.orangeAccent, borderWidth:1},
  methodTag:{backgroundColor:COLORS.blue50, borderColor:COLORS.blue500, borderWidth:1},
  methodIcons:{flexDirection:'row',alignItems:'center'},
  methodIconImg:{width:16,height:16,resizeMode:'contain',marginHorizontal:2},
  freeTagText:{color:COLORS.green900,fontSize:11,fontWeight:'700'},
  entryTagText:{color:COLORS.brown900,fontSize:11,fontWeight:'700'},
  entryRow:{flexDirection:'row',alignItems:'center',marginTop:6,marginBottom:6},
  entryTagRow:{paddingHorizontal:10,paddingVertical:6},
  methodIconsRow:{flexDirection:'row',alignItems:'center',marginLeft:8},
  venueTag:{backgroundColor:COLORS.slateBlue},
  tagText:{color:COLORS.neutral900,fontSize:11,fontWeight:'700'},
  participantsRow:{flexDirection:'row',alignItems:'center',marginTop:4},
  participantsIcon:{width:14,height:14,tintColor:COLORS.neutral525,marginRight:4,resizeMode:'contain'},
  participantsIconLarge:{width:18,height:18,tintColor:COLORS.neutral525,marginRight:6,resizeMode:'contain'},
  participantsText:{color:COLORS.neutral525,fontSize:12,fontWeight:'600'},
  expandedContent:{marginTop:10},
  expandedLine:{color:COLORS.neutral550,fontSize:12,marginBottom:4},
  expandedDescLabel:{color:COLORS.neutral550,fontSize:12,marginTop:4,fontWeight:'700'},
  expandedDesc:{color:COLORS.neutral525,fontSize:12,marginTop:4},
  fab:{position:'absolute',right:20,bottom:30,backgroundColor:COLORS.orangeAccent,paddingHorizontal:18,paddingVertical:12,borderRadius:30,flexDirection:'row',alignItems:'center',shadowColor:COLORS.black,shadowOpacity:0.3,shadowRadius:6,elevation:5},
  fabIcon:{width:22,height:22,tintColor:COLORS.white,marginRight:8,resizeMode:'contain'},
  fabText:{color:COLORS.white,fontSize:14,fontWeight:'700'},
})