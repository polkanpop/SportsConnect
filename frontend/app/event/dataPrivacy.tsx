import { ICONS } from '@/constants/icons'
import { router } from 'expo-router'
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function DataPrivacyScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </Pressable>
        <Text style={styles.title}>Data &amp; Privacy</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Content */}
      <View style={styles.body}>
        <Text style={styles.bodyText}>
          Our Terms of Service:{' '}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL('https://sportconnects.org/terms')}
          >
            click here
          </Text>
        </Text>
        <Text style={[styles.bodyText, { marginTop: 12 }]}>
          Our Policy:{' '}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL('https://sportconnects.org/privacy')}
          >
            click here
          </Text>
        </Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  backBtn: {
    width: 36,
  },
  backIcon: {
    width: 22,
    height: 22,
    tintColor: '#000',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
  },
  headerSpacer: {
    width: 36,
  },
  body: {
    padding: 24,
  },
  bodyText: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 24,
  },
  link: {
    color: '#FF6017',
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
})
