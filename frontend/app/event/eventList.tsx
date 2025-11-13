import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { listEventsCombined, CombinedEvent, CourtInfoRow } from '@/lib/backendApi'

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
  football: { bg: '#ffffff', color: '#111', border: '#ddd' },
  soccer: { bg: '#ffffff', color: '#111', border: '#ddd' },
  tennis: { bg: '#32CD32', color: '#fff' },
  tabletennis: { bg: '#32CD32', color: '#fff' },
  badminton: { bg: '#32CD32', color: '#fff' },
  basketball: { bg: '#FFA500', color: '#111' },
  volleyball: { bg: '#FFA500', color: '#111' },
  golf: { bg: '#2e8b57', color: '#fff' },
  running: { bg: '#4682B4', color: '#fff' },
  pickleball: { bg: '#FF69B4', color: '#111' },
}

const EventListScreen = () => {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [allEvents, setAllEvents] = useState<CombinedEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openFilter, setOpenFilter] = useState<'sport' | 'venue' | null>(null)
  const [selectedSports, setSelectedSports] = useState<string[]>([])
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  // Load events
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const rows = await listEventsCombined()
      setAllEvents(rows)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

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
      const title = (ev.title || '').toLowerCase()
      const address = (ev.address || '').toLowerCase()
      const queryOk = !search || title.includes(search.toLowerCase()) || address.includes(search.toLowerCase())
      if (!queryOk) return false
      const sports = asArray(ev.sport)
      const venues = asArray(ev.venue)
      const sportOk = selectedSports.length === 0 || sports.some(s => selectedSports.includes(s))
      const venueOk = selectedVenues.length === 0 || venues.some(v => selectedVenues.includes(v))
      return sportOk && venueOk
    })
  }, [allEvents, search, selectedSports, selectedVenues])

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
            placeholderTextColor={'#777'}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
          />
        </View>
      </View>
      <View style={styles.container}>
        {/* Filters */}
        <View style={styles.filterRow}>
          <TouchableOpacity style={styles.filterButton} onPress={() => setOpenFilter(openFilter==='sport'?null:'sport')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={styles.filterText}>Sport</Text>
            {selectedSports.length>0 && <Text style={styles.countBadge}>{selectedSports.length}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.filterButton} onPress={() => setOpenFilter(openFilter==='venue'?null:'venue')}>
            <Image source={ICONS.menu} style={styles.filterIcon} />
            <Text style={styles.filterText}>Venue</Text>
            {selectedVenues.length>0 && <Text style={styles.countBadge}>{selectedVenues.length}</Text>}
          </TouchableOpacity>
        </View>
        <Text style={styles.sectionTitle}>Events</Text>
        {openFilter && (
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
        {openFilter && <Pressable style={styles.overlay} onPress={handleOutsidePress} />}
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 100 }}>
          {loading && <Text style={styles.statusText}>Loading events...</Text>}
            {error && <Text style={[styles.statusText,{color:'red'}]}>Failed: {error}</Text>}
            {!loading && !error && filteredEvents.length===0 && <Text style={styles.statusText}>No events found.</Text>}
            {filteredEvents.map(ev => {
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
                    <Text style={styles.dateText}>{ev.time ? new Date(ev.time).toLocaleString() : 'Unknown date'}</Text>
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
                        <View key={v} style={[styles.tag, styles.venueTag]}><Text style={[styles.tagText,{color:'#fff'}]}>{v}</Text></View>
                      ))}
                    </View>
                    <View style={styles.participantsRow}>
                      <Image source={ICONS.participants} style={styles.participantsIconLarge} />
                      <Text style={styles.participantsText}>{ev.numberofpeople ?? '0'} participants</Text>
                    </View>
                    {expanded && (
                      <View style={styles.expandedContent}>
                        <Text style={styles.expandedLine}>Organizer: {ev.organizerName || ev.organizerid}</Text>
                        <Text style={styles.expandedLine}>Address: {ev.address || 'Unknown address'}</Text>
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
      <TouchableOpacity style={[styles.fab, { bottom: 30 + Math.max(insets.bottom || 0, 12) }]} onPress={() => router.push('/event/eventBooking' as any)}>
        <Image source={ICONS.buttonBooking} style={styles.fabIcon} />
        <Text style={styles.fabText}>Create</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

export default EventListScreen

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#ffffff'},
  headerRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingTop:6,marginBottom:13},
  backButton:{padding:8,marginRight:8,borderRadius:28,backgroundColor:'#f2f2f2'},
  backIcon:{width:24,height:24,tintColor:'#333',resizeMode:'contain'},
  searchRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingBottom:4},
  searchContainer:{flex:1,flexDirection:'row',alignItems:'center',backgroundColor:'#f5f5f5',borderRadius:24,paddingHorizontal:14,paddingVertical:10},
  searchIcon:{width:18,height:18,tintColor:'#666',marginRight:8,resizeMode:'contain'},
  searchInput:{flex:1,color:'#111',fontSize:15,paddingVertical:0},
  container:{flex:1,paddingHorizontal:12,paddingTop:4},
  filterRow:{flexDirection:'row',gap:10,marginBottom:12},
  filterButton:{flexDirection:'row',alignItems:'center',backgroundColor:'#f5f5f5',paddingHorizontal:12,paddingVertical:6,borderRadius:20},
  filterIcon:{width:16,height:16,tintColor:'#666',marginRight:6,resizeMode:'contain'},
  filterText:{color:'#222',fontSize:13,fontWeight:'600'},
  countBadge:{marginLeft:6,backgroundColor:'#ddd',color:'#111',paddingHorizontal:6,paddingVertical:2,borderRadius:10,fontSize:11,overflow:'hidden'},
  sectionTitle:{fontSize:22,fontWeight:'500',color:'#222',marginBottom:12,marginLeft:4,marginTop:15},
  dropdownWrapper:{position:'absolute',top:100,left:12,right:12,zIndex:20},
  dropdown:{maxHeight:200,backgroundColor:'#ffffff',borderRadius:8,paddingVertical:4,borderWidth:1,borderColor:'#e5e5e5'},
  dropdownItem:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:12,paddingVertical:8},
  dropdownItemText:{color:'#222',fontSize:14},
  tickBox:{width:20,height:20,borderRadius:4,borderWidth:1,borderColor:'#bbb',alignItems:'center',justifyContent:'center'},
  tickBoxSelected:{backgroundColor:'#32CD32',borderColor:'#32CD32'},
  tickText:{color:'#fff',fontSize:14},
  overlay:{position:'absolute',top:0,left:0,right:0,bottom:0},
  list:{flex:1,marginTop:14},
  statusText:{color:'#666',fontSize:12,paddingVertical:12,textAlign:'center'},
  card:{flexDirection:'row',backgroundColor:'#1e1e1e',borderRadius:14,padding:16,marginBottom:16,alignItems:'flex-start',minHeight:140},
  cardExpanded:{minHeight:180},
  cardLeft:{flex:1,paddingRight:12},
  titleRow:{flexDirection:'row',alignItems:'center'},
  expandButton:{padding:4,marginLeft:6},
  expandIcon:{width:18,height:18,tintColor:'#ccc'},
  cardTitle:{color:'#fff',fontSize:16,fontWeight:'700',flexShrink:1},
  dateText:{color:'#ccc',fontSize:12,marginTop:2},
  tagRow:{flexDirection:'row',flexWrap:'wrap',marginTop:6},
  tag:{backgroundColor:'#333',paddingHorizontal:8,paddingVertical:4,borderRadius:12,marginRight:6,marginBottom:6,flexDirection:'row',alignItems:'center'},
  tagFallback:{backgroundColor:'#444'},
  venueTag:{backgroundColor:'#6a5acd'},
  tagText:{color:'#ddd',fontSize:11,fontWeight:'600'},
  participantsRow:{flexDirection:'row',alignItems:'center',marginTop:4},
  participantsIcon:{width:14,height:14,tintColor:'#ddd',marginRight:4,resizeMode:'contain'},
  participantsIconLarge:{width:18,height:18,tintColor:'#ddd',marginRight:6,resizeMode:'contain'},
  participantsText:{color:'#ddd',fontSize:12,fontWeight:'600'},
  expandedContent:{marginTop:10},
  expandedLine:{color:'#bbb',fontSize:12,marginBottom:4},
  expandedDesc:{color:'#ddd',fontSize:12,marginTop:4},
  cardRight:{alignItems:'center'},
  placeholderImg:{width:70,height:70,backgroundColor:'#2d2d2d',borderRadius:10,marginBottom:6},
  arrowIcon:{width:22,height:22,tintColor:'#888',position:'absolute',left:53,top:80},
  fab:{position:'absolute',right:20,bottom:30,backgroundColor:'#ff6b3b',paddingHorizontal:18,paddingVertical:12,borderRadius:30,flexDirection:'row',alignItems:'center',shadowColor:'#000',shadowOpacity:0.3,shadowRadius:6,elevation:5},
  fabIcon:{width:22,height:22,tintColor:'#fff',marginRight:8,resizeMode:'contain'},
  fabText:{color:'#fff',fontSize:14,fontWeight:'700'},
})