import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Image as ExpoImage } from 'expo-image'
import { ICONS } from '@/constants/icons'
import { getUserInfoByUserIdCached, type UserInfoRow } from '@/lib/backendApi'
import { useThemeColors } from '@/hooks/use-theme-colors'

export default function ProfileSpectate() {
  const router = useRouter()
  const tc = useThemeColors()
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

  const contactVisible = useMemo(() => {
		const ev = (userInfo as any)?.emailvisiblestatus
		const pv = (userInfo as any)?.phonevisiblestatus
		const emailV = typeof ev === 'boolean' ? ev : true
		const phoneV = typeof pv === 'boolean' ? pv : true
		return emailV || phoneV
	}, [userInfo])

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tc.bgBase }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.headerRow, { backgroundColor: tc.bgBase }]}>
        <View style={{ width: 44 }} />
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Profile</Text>
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
        <View style={[styles.profileHeader, { backgroundColor: tc.bgBase }]}>
          <View style={styles.avatarContainer}>
            {userInfo?.pfp ? (
              <ExpoImage source={{ uri: userInfo.pfp as string }} style={styles.avatar} contentFit="cover" />
            ) : (
              <Image source={ICONS.accountCircle} style={styles.avatar} />
            )}
          </View>
          <Text style={[styles.username, { color: tc.textPrimary }]}>{userInfo?.name || 'Username'}</Text>
        </View>

        <View style={[styles.divider, { backgroundColor: tc.divider }]} />

        {/* Biography */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10, color: tc.textPrimary }]}>Biography</Text>
          </View>
          <View style={{ padding: 4 }}>
            <Text style={{ fontSize: 14, color: userInfo?.biography ? tc.textPrimary : tc.textMuted }}>
              {userInfo?.biography || ''}
            </Text>
          </View>
        </View>

        {/* Contact */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10, color: tc.textPrimary }]}>Contact</Text>
          </View>
          {!contactVisible ? (
            <Text style={{ fontSize: 12, color: tc.textSecondary, fontStyle: 'italic' }}>This user has hidden their contact information.</Text>
          ) : (() => {
            const email = userInfo?.email
            const phone = userInfo?.contactnumber
            if (!email && !phone) return null
            const label = email ? 'Email' : 'Phone'
            const value = email || phone || ''
            return (
              <View style={styles.contactRow}>
                <Text style={[styles.contactText, { color: tc.textSecondary, marginRight: 6 }]}>{label}:</Text>
                <Text style={[styles.contactText, { color: tc.textSecondary }]}>{value}</Text>
              </View>
            )
          })()}
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