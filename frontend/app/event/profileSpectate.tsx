import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ICONS } from '@/constants/icons'
import { getUserInfoByUserIdCached, type UserInfoRow } from '@/lib/backendApi'

// Copied from profile.tsx to keep layout/appearance identical
const SPORT_COLORS: Record<string, { bg: string; color: string; border?: string }> = {
  football: { bg: '#ffffff', color: '#111', border: '#ddd' },
  tennis: { bg: '#32CD32', color: '#fff' },
  tabletennis: { bg: '#32CD32', color: '#fff' },
  badminton: { bg: '#32CD32', color: '#fff' },
  basketball: { bg: '#FFA500', color: '#111' },
  volleyball: { bg: '#FFA500', color: '#111' },
  golf: { bg: '#2e8b57', color: '#fff' },
  running: { bg: '#4682B4', color: '#fff' },
  pickleball: { bg: '#FF69B4', color: '#111' },
}

const SPORT_ICONS: Record<string, any> = {
  football: ICONS.football,
  tennis: ICONS.sportCategory,
  tabletennis: ICONS.tableTennis,
  badminton: ICONS.badminton,
  basketball: ICONS.basketball,
  volleyball: ICONS.volleyball,
  golf: ICONS.golf,
  running: ICONS.running,
  pickleball: ICONS.pickleball,
}

const DB_TO_UI_SPORT: Record<string, string> = {
  Football: 'football',
  Tennis: 'tennis',
  TableTennis: 'tabletennis',
  Badminton: 'badminton',
  Basketball: 'basketball',
  Volleyball: 'volleyball',
  Golf: 'golf',
  Running: 'running',
  Pickleball: 'pickleball',
}

function parseUserSports(userInfo: UserInfoRow | null): string[] {
  if (!userInfo?.sport) return []
  let parsedTags: string[] = []
  if (Array.isArray(userInfo.sport)) {
    parsedTags = userInfo.sport
  } else if (typeof userInfo.sport === 'string') {
    const clean = userInfo.sport.replace(/^\{|\}$/g, '')
    if (clean) parsedTags = clean.split(',')
  }
  const uiTags = parsedTags.map((t) => DB_TO_UI_SPORT[t] || String(t).toLowerCase()).filter((t) => SPORT_COLORS[t])
  return [...new Set(uiTags)]
}

export default function ProfileSpectate() {
  const router = useRouter()
  const { userid } = useLocalSearchParams<{ userid?: string }>()
  const numericUserId = useMemo(() => {
    const raw = String(userid ?? '')
    return /^\d+$/.test(raw) ? parseInt(raw, 10) : null
  }, [userid])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userInfo, setUserInfo] = useState<UserInfoRow | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (numericUserId == null) {
        setUserInfo(null)
        setError('Missing userid')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const ui = await getUserInfoByUserIdCached(numericUserId)
        if (cancelled) return
        setUserInfo(ui)
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message || String(e))
        setUserInfo(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [numericUserId])

  const tags = useMemo(() => parseUserSports(userInfo), [userInfo])
  const contactVisible = useMemo(() => {
		const v = (userInfo as any)?.contactvisiblestatus
		return typeof v === 'boolean' ? v : true
	}, [userInfo])

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={{ width: 44 }} />
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        {loading && (
          <View style={{ paddingVertical: 18 }}>
            <ActivityIndicator />
          </View>
        )}
        {error && <Text style={{ color: '#b91c1c', textAlign: 'center', paddingHorizontal: 16 }}>{error}</Text>}

        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarContainer}>
            {userInfo?.pfp ? (
              <Image source={{ uri: userInfo.pfp as string }} style={styles.avatar} />
            ) : (
              <Image source={ICONS.accountCircle} style={styles.avatar} />
            )}
          </View>
          <Text style={styles.username}>{userInfo?.name || 'Username'}</Text>

          {/* Tags */}
          <View style={styles.tagsRow}>
            {tags.map((tag) => {
              const style = SPORT_COLORS[tag] || { bg: '#eee', color: '#333' }
              const icon = SPORT_ICONS[tag]
              return (
                <View
                  key={tag}
                  style={[styles.tag, { backgroundColor: style.bg, borderColor: style.border, borderWidth: style.border ? 1 : 0 }]}
                >
                  {icon && <Image source={icon} style={[styles.tagIcon, { tintColor: style.color }]} />}
                  <Text style={[styles.tagText, { color: style.color }]}>{tag.charAt(0).toUpperCase() + tag.slice(1)}</Text>
                </View>
              )
            })}
          </View>
        </View>

        <View style={styles.divider} />

        {/* Biography */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10 }]}>Biography</Text>
          </View>
          <View style={{ padding: 4 }}>
            <Text style={{ fontSize: 14, color: userInfo?.biography ? '#333' : '#999' }}>
              {userInfo?.biography || ''}
            </Text>
          </View>
        </View>

        {/* Contact */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10 }]}>Contact</Text>
          </View>
          {!contactVisible ? (
            <Text style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>This user has hidden their contact information.</Text>
          ) : (
            <View style={styles.contactRow}>
              <Text style={styles.contactText}>{userInfo?.email || userInfo?.contactnumber || ''}</Text>
            </View>
          )}
        </View>

        <View style={{ height: 10 }} />
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#fff' },
	container: { flex: 1 },
	headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff' },
	headerTitle: { fontSize: 18, fontWeight: '600', flex: 1, textAlign: 'center' },

	profileHeader: { alignItems: 'center', paddingVertical: 20, backgroundColor: '#fff' },
	avatarContainer: { position: 'relative', marginBottom: 12 },
	avatar: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#ddd' },
	username: { fontSize: 20, fontWeight: '700', color: '#222', marginBottom: 12 },

	tagsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 20 },
	tag: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, margin: 4, elevation: 1 },
	tagIcon: { width: 16, height: 16, marginRight: 6, resizeMode: 'contain' },
	tagText: { fontSize: 12, fontWeight: '600' },

	divider: { height: 1, backgroundColor: '#eee', marginVertical: 10 },

	section: { paddingHorizontal: 20, marginBottom: 24 },
	sectionTitle: { fontSize: 16, fontWeight: '700', color: '#222', marginBottom: 8 },

	contactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
	contactText: { fontSize: 14, color: '#555' },
})