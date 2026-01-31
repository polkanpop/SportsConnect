import { StyleSheet, Text, View, TouchableOpacity, Image, ScrollView, TextInput, Switch, Modal, FlatList, TouchableWithoutFeedback, ActivityIndicator } from 'react-native'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ICONS } from '@/constants/icons'
import { useAuthContext } from '@/hooks/use-auth-context'
import { useUserInfo } from '@/hooks/use-user-info'
import { cloudinarySignUpload, deleteMyProfilePicture, updateUserInfo, updateUserPfp } from '@/lib/backendApi'
import { queryClient } from '@/providers/query-provider'
import { queryKeys } from '@/hooks/query-keys'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import AsyncStorage from '@react-native-async-storage/async-storage'

// Sport colors (copied from Map.tsx)
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
};

// Icon mapping for sports
const SPORT_ICONS: Record<string, any> = {
  football: ICONS.football,
  tennis: ICONS.sportCategory, // Fallback if no specific icon
  tabletennis: ICONS.tableTennis,
  badminton: ICONS.badminton,
  basketball: ICONS.basketball,
  volleyball: ICONS.volleyball,
  golf: ICONS.golf,
  running: ICONS.running,
  pickleball: ICONS.pickleball,
};

const AVAILABLE_SPORTS = Object.keys(SPORT_COLORS);

// Mapping from UI keys (lowercase) to DB Enum values (Capitalized)
const UI_TO_DB_SPORT: Record<string, string> = {
  football: 'Football',
  tennis: 'Tennis',
  tabletennis: 'TableTennis',
  badminton: 'Badminton',
  basketball: 'Basketball',
  volleyball: 'Volleyball',
  golf: 'Golf',
  running: 'Running',
  pickleball: 'Pickleball',
};

// Mapping from DB Enum values to UI keys
const DB_TO_UI_SPORT: Record<string, string> = {
  'Football': 'football',
  'Tennis': 'tennis',
  'TableTennis': 'tabletennis',
  'Badminton': 'badminton',
  'Basketball': 'basketball',
  'Volleyball': 'volleyball',
  'Golf': 'golf',
  'Running': 'running',
  'Pickleball': 'pickleball',
};

export default function Profile() {
  const router = useRouter()
  const { profile, session } = useAuthContext()
  const [userid, setUserid] = useState<number | null>(null)

  const resolveUserId = useCallback(async () => {
    // Supabase path: backend userid might not exist
    if (session) {
      const ctxId = profile && typeof (profile as any).userid === 'number' ? (profile as any).userid : null
      setUserid(ctxId)
      return
    }

    // Backend-auth path: prefer AsyncStorage since AuthProvider can be long-lived and stale across account switches
    let next: number | null = profile && typeof (profile as any).userid === 'number' ? (profile as any).userid : null
    try {
      const raw = await AsyncStorage.getItem('@backendProfile')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.userid === 'number') next = parsed.userid
      }
    } catch {
      // ignore storage/parse issues
    }
    setUserid(next)
  }, [profile, session])

  useEffect(() => { resolveUserId() }, [resolveUserId])
  useFocusEffect(useCallback(() => { resolveUserId() }, [resolveUserId]))
  
  const { data: userInfo, isLoading, error } = useUserInfo(userid)
  
  const [bio, setBio] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tempTags, setTempTags] = useState<string[]>([])
  const [contactVisible, setContactVisible] = useState(true)
  const [showTagModal, setShowTagModal] = useState(false)
  const [showContactLog, setShowContactLog] = useState(false)
  const logTimerRef = useRef<any>(null)
  
  const [isEditingBio, setIsEditingBio] = useState(false)
  const [showBioSuccess, setShowBioSuccess] = useState(false)
  const [showUnsavedModal, setShowUnsavedModal] = useState(false)
  const bioSuccessTimerRef = useRef<any>(null)

  const [showActionModal, setShowActionModal] = useState(false)
  const [actionModalTitle, setActionModalTitle] = useState<string>('')
  const [actionModalMessage, setActionModalMessage] = useState<string | null>(null)
  const [actionModalButtons, setActionModalButtons] = useState<Array<{ text: string; variant?: 'cancel' | 'confirm'; onPress: () => void }>>([])

  const [uploadingPfp, setUploadingPfp] = useState(false)
  const [pfpOverrideUri, setPfpOverrideUri] = useState<string | null>(null)

  const closeActionModal = () => setShowActionModal(false)
  const openActionModal = (opts: {
    title: string
    message?: string | null
    buttons: Array<{ text: string; variant?: 'cancel' | 'confirm'; onPress: () => void }>
  }) => {
    setActionModalTitle(opts.title)
    setActionModalMessage(typeof opts.message === 'string' ? opts.message : null)
    setActionModalButtons(opts.buttons)
    setShowActionModal(true)
  }

  // Sync local state with fetched data
  useEffect(() => {
    if (userInfo) {
      setBio(userInfo.biography || '')
      // Parse tags if they are stored as array or string
      let parsedTags: string[] = []
      if (Array.isArray(userInfo.sport)) {
        parsedTags = userInfo.sport
      } else if (typeof userInfo.sport === 'string') {
        // Handle potential string format like "{football,basketball}" or "football,basketball"
        const clean = (userInfo.sport as string).replace(/^\{|\}$/g, '')
        if (clean) parsedTags = clean.split(',')
      }
      // Map DB values back to UI keys
      const uiTags = parsedTags.map(t => DB_TO_UI_SPORT[t] || t.toLowerCase()).filter(t => SPORT_COLORS[t])
      // Deduplicate
      setTags([...new Set(uiTags)])

    // Persisted privacy: if backend provides a boolean, respect it
    const persisted = (userInfo as any)?.contactvisiblestatus
		if (typeof persisted === 'boolean') setContactVisible(persisted)
    }
  }, [userInfo])

  const handleEditBio = () => {
    setIsEditingBio(true)
    setShowBioSuccess(false)
  }

  const handleCancelEdit = () => {
    const originalBio = userInfo?.biography || ''
    if (bio !== originalBio) {
      setShowUnsavedModal(true)
    } else {
      setIsEditingBio(false)
    }
  }

  const handleConfirmExit = () => {
    const originalBio = userInfo?.biography || ''
    setIsEditingBio(false)
    setBio(originalBio)
    setShowUnsavedModal(false)
  }

  const handleSaveBio = async () => {
    if (!userid) return
    try {
      await updateUserInfo(userid, { biography: bio })
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
      setIsEditingBio(false)
      setShowBioSuccess(true)
      if (bioSuccessTimerRef.current) clearTimeout(bioSuccessTimerRef.current)
      bioSuccessTimerRef.current = setTimeout(() => {
        setShowBioSuccess(false)
      }, 3000)
    } catch (e) {
      console.error('Failed to update bio', e)
    }
  }

  const handleOpenTagModal = () => {
    setTempTags([...tags])
    setShowTagModal(true)
  }

  const handleToggleTempTag = (sport: string) => {
    if (tempTags.includes(sport)) {
      setTempTags(tempTags.filter(t => t !== sport))
    } else {
      setTempTags([...tempTags, sport])
    }
  }

  const handleConfirmTags = async () => {
    setTags(tempTags)
    setShowTagModal(false)
    if (!userid) return
    try {
      // Map UI keys to DB Enum values
      const dbTags = tempTags.map(t => UI_TO_DB_SPORT[t] || t)
      // Deduplicate DB tags
      const uniqueDbTags = [...new Set(dbTags)]
      await updateUserInfo(userid, { sport: uniqueDbTags as any }) 
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
    } catch (e) {
      console.error('Failed to update tags', e)
      openActionModal({
        title: 'Error',
        message: 'Failed to update tags',
        buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
      })
    }
  }

  const handleToggleContact = async () => {
    if (!userid) return
	const next = !contactVisible
    setContactVisible(next)
    setShowContactLog(true)
    if (logTimerRef.current) clearTimeout(logTimerRef.current)
    logTimerRef.current = setTimeout(() => {
      setShowContactLog(false)
    }, 5000)
  try {
    await updateUserInfo(userid, { contactvisiblestatus: next } as any)
		queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
	} catch (e) {
		console.warn('Failed to persist contact visibility', (e as any)?.message)
	}
  }

  const uploadToCloudinary = async (localUri: string) => {
    if (!userid) throw new Error('Missing userid')

    // Ensure manageable size: 512px wide, JPEG compressed
    const resized = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: 512 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
    )

    const sign = await cloudinarySignUpload({
      public_id: `pfp_user_${userid}`,
      overwrite: true,
    })

    const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(sign.cloudName)}/image/upload`

    const form = new FormData()
    form.append('file', {
      uri: resized.uri,
      name: `pfp_user_${userid}.jpg`,
      type: 'image/jpeg',
    } as any)
    form.append('api_key', sign.apiKey)
    form.append('timestamp', String(sign.timestamp))
    form.append('signature', sign.signature)
    if (sign.uploadPreset) form.append('upload_preset', String(sign.uploadPreset))
    if (sign.folder) form.append('folder', String(sign.folder))
    form.append('public_id', `pfp_user_${userid}`)
    form.append('overwrite', 'true')

    const resp = await fetch(endpoint, { method: 'POST', body: form })
    const json = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = json?.error?.message || `Upload failed (HTTP ${resp.status})`
      throw new Error(msg)
    }
    const secureUrl: string | undefined = json?.secure_url
    if (!secureUrl) throw new Error('Upload succeeded but missing secure_url')
    return secureUrl
  }

  const handleChangeProfilePictureFromResult = async (result: ImagePicker.ImagePickerResult) => {
    if (!userid) {
      openActionModal({
        title: 'Not signed in',
        message: 'Please log in again.',
        buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
      })
      return
    }
    if (result.canceled) return
    const uri = result.assets?.[0]?.uri
    if (!uri) return

    setUploadingPfp(true)
    setPfpOverrideUri(uri)
    try {
      const remoteUrl = await uploadToCloudinary(uri)
      await updateUserPfp(userid, remoteUrl)
      setPfpOverrideUri(remoteUrl)
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
    } catch (e: any) {
      console.error('PFP upload failed', e)
      openActionModal({
        title: 'Upload failed',
        message: e?.message || 'Please try again',
        buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
      })
      // Revert to server value
      setPfpOverrideUri(null)
    } finally {
      setUploadingPfp(false)
    }
  }

  const handlePickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      openActionModal({
        title: 'Permission needed',
        message: 'Please allow photo library access to select a profile picture.',
        buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
      })
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    })
    await handleChangeProfilePictureFromResult(result)
  }

  const handleTakePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      openActionModal({
        title: 'Permission needed',
        message: 'Please allow camera access to take a profile picture.',
        buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
      })
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    })
    await handleChangeProfilePictureFromResult(result)
  }

  const handlePressCamera = () => {
    if (uploadingPfp) return
    openActionModal({
      title: 'Profile picture',
      message: 'Choose a photo from your library or take a new one.',
      buttons: [
        {
          text: 'Take photo',
          variant: 'confirm',
          onPress: () => {
            closeActionModal()
            void handleTakePhoto()
          },
        },
        {
          text: 'Choose from library',
          variant: 'cancel',
          onPress: () => {
            closeActionModal()
            void handlePickFromLibrary()
          },
        },
        {
          text: 'Delete profile picture',
          variant: 'cancel',
          onPress: () => {
            closeActionModal()
            void (async () => {
              if (!userid) {
                openActionModal({
                  title: 'Not signed in',
                  message: 'Please log in again.',
                  buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
                })
                return
              }
              setUploadingPfp(true)
              setPfpOverrideUri(null)
              try {
                await deleteMyProfilePicture()
                await updateUserPfp(userid, null)
                queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
              } catch (e: any) {
                console.error('Delete PFP failed', e)
                openActionModal({
                  title: 'Failed',
                  message: e?.message || 'Could not delete profile picture',
                  buttons: [{ text: 'OK', variant: 'cancel', onPress: closeActionModal }],
                })
              } finally {
                setUploadingPfp(false)
              }
            })()
          },
        },
      ],
    })
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Header */}
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={styles.backIcon} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Your Profile</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarContainer}>
            {pfpOverrideUri || userInfo?.pfp ? (
              <Image source={{ uri: (pfpOverrideUri || userInfo?.pfp) as string }} style={styles.avatar} />
            ) : (
              <Image source={ICONS.accountCircle} style={styles.avatar} />
            )}
            <TouchableOpacity style={styles.cameraBtn} onPress={handlePressCamera} disabled={uploadingPfp}>
              {uploadingPfp ? (
                <ActivityIndicator size="small" color="#333" />
              ) : (
                <Image source={ICONS.camera} style={styles.cameraIcon} />
              )}
            </TouchableOpacity>
          </View>
          <Text style={styles.username}>{userInfo?.name || 'Username'}</Text>
          
          {/* Tags */}
          <View style={styles.tagsRow}>
            {tags.map(tag => {
              const style = SPORT_COLORS[tag] || { bg: '#eee', color: '#333' }
              const icon = SPORT_ICONS[tag]
              return (
                <TouchableOpacity key={tag} style={[styles.tag, { backgroundColor: style.bg, borderColor: style.border, borderWidth: style.border ? 1 : 0 }]} onPress={handleOpenTagModal}>
                  {icon && <Image source={icon} style={[styles.tagIcon, { tintColor: style.color }]} />}
                  <Text style={[styles.tagText, { color: style.color }]}>{tag.charAt(0).toUpperCase() + tag.slice(1)}</Text>
                </TouchableOpacity>
              )
            })}
            <TouchableOpacity style={[styles.tag, styles.addTagBtn]} onPress={handleOpenTagModal}>
              <Text style={styles.addTagText}>+ Add Sport</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Biography */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10 }]}>Biography</Text>
            <TouchableOpacity onPress={isEditingBio ? handleCancelEdit : handleEditBio}>
              <Image 
                source={isEditingBio ? ICONS.cancelEdit : ICONS.edit} 
                style={{ width: 14, height: 14 }} 
              />
            </TouchableOpacity>
            {showBioSuccess && (
              <Text style={{ marginLeft: 10, fontSize: 10, color: 'green', fontStyle: 'italic' }}>
                change successfully
              </Text>
            )}
          </View>
          
          {isEditingBio ? (
            <View style={styles.bioContainer}>
              <TextInput
                style={styles.bioInput}
                multiline
                placeholder="Something about myself..."
                value={bio}
                onChangeText={setBio}
                autoFocus
              />
              <TouchableOpacity 
                style={{ position: 'absolute', bottom: 8, right: 8 }}
                onPress={handleSaveBio}
              >
                <Image source={ICONS.tick} style={{ width: 14, height: 14, tintColor: 'green' }} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 4 }}>
              <Text style={{ fontSize: 14, color: bio ? '#333' : '#999' }}>
                {bio || "Something about myself..."}
              </Text>
            </View>
          )}
        </View>

        {/* Contact */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10 }]}>Contact</Text>
            <TouchableOpacity onPress={handleToggleContact}>
              <Image 
                source={contactVisible ? ICONS.eye : ICONS.notEye} 
                style={{ width: 16, height: 16, tintColor: '#555' }} 
              />
            </TouchableOpacity>
            {showContactLog && (
              <Text style={{ marginLeft: 10, fontSize: 10, color: '#888', flex: 1, fontStyle: 'italic' }}>
                {contactVisible 
                  ? "Your contact information is now visible" 
                  : "Your contact information is now hidden"}
              </Text>
            )}
          </View>
          <View style={styles.contactRow}>
            <Text style={styles.contactText}>{userInfo?.email || 'email/phone'}</Text>
          </View>
        </View>

        {/* Achievements */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Achievements</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.achievementsScroll}>
             {/* Placeholder 1 */}
             <View style={styles.achievementPlaceholder}>
                <View style={styles.achievementIconPlaceholder} />
                <View style={styles.achievementLines}>
                    <View style={[styles.line, { width: '60%' }]} />
                    <View style={[styles.line, { width: '40%' }]} />
                </View>
             </View>
             {/* Placeholder 2 */}
             <View style={[styles.achievementPlaceholder, { backgroundColor: '#FFFACD' }]}>
                <View style={[styles.achievementIconPlaceholder, { backgroundColor: '#FFD700' }]} />
                <View style={styles.achievementLines}>
                    <View style={[styles.line, { width: '50%' }]} />
                    <View style={[styles.line, { width: '30%' }]} />
                </View>
             </View>
          </ScrollView>
        </View>

      </ScrollView>

      {/* Tag Selection Modal */}
      <Modal visible={showTagModal} transparent animationType="fade" onRequestClose={() => setShowTagModal(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowTagModal(false)}>
          <View style={styles.modalContent}>
            <Text style={styles.tagModalTitle}>Select Sport</Text>
            <View style={styles.modalTags}>
              {AVAILABLE_SPORTS.map(sport => {
                 const isSelected = tempTags.includes(sport)
                 const style = SPORT_COLORS[sport]
                 const icon = SPORT_ICONS[sport]
                 return (
                   <TouchableOpacity 
                    key={sport} 
                    style={[
                      styles.modalTag, 
                      { 
                        backgroundColor: style.bg, 
                        borderColor: isSelected ? '#32CD32' : (style.border || 'transparent'), 
                        borderWidth: isSelected ? 2 : (style.border ? 1 : 0) 
                      }
                    ]} 
                    onPress={() => handleToggleTempTag(sport)}
                   >
                      {icon && <Image source={icon} style={[styles.tagIcon, { tintColor: style.color }]} />}
                      <Text style={[styles.tagText, { color: style.color }]}>{sport.charAt(0).toUpperCase() + sport.slice(1)}</Text>
                      {isSelected && (
                        <Image source={ICONS.tick} style={{ width: 16, height: 16, tintColor: 'green', marginLeft: 6 }} />
                      )}
                   </TouchableOpacity>
                 )
              })}
            </View>
            <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirmTags}>
              <Image source={ICONS.tick} style={styles.confirmBtnIcon} />
              <Text style={styles.confirmBtnText}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Unsaved Changes Modal */}
      <Modal
        transparent
        animationType="fade"
        visible={showUnsavedModal}
        onRequestClose={() => setShowUnsavedModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowUnsavedModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.modalCenteredWrapper} pointerEvents="box-none">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Your changes have not been saved. Are you sure you want to exit?</Text>
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel, { marginRight: 12 }]}
                onPress={() => setShowUnsavedModal(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonCancelText}>Return</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={handleConfirmExit}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonConfirmText}>Exit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Action / Info Modal (matches Settings logout modal style) */}
      <Modal
        transparent
        animationType="fade"
        visible={showActionModal}
        onRequestClose={closeActionModal}
      >
        <TouchableWithoutFeedback onPress={closeActionModal}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={styles.modalCenteredWrapper} pointerEvents="box-none">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{actionModalTitle}</Text>
            {!!actionModalMessage && <Text style={styles.modalMessage}>{actionModalMessage}</Text>}
            <View style={actionModalButtons.length === 2 ? styles.modalButtonsRow : undefined}>
              {actionModalButtons.map((btn, idx) => {
                const isConfirm = btn.variant === 'confirm'
                const isRow = actionModalButtons.length === 2
                const isFirstInRow = isRow && idx === 0
                const isNotLastInColumn = !isRow && idx < actionModalButtons.length - 1
                return (
                  <TouchableOpacity
                    key={`${btn.text}-${idx}`}
                    style={[
                      styles.modalButton,
                      isConfirm ? styles.modalButtonConfirm : styles.modalButtonCancel,
                      !isRow && { width: '100%', flex: 0 },
                      isFirstInRow && { marginRight: 12 },
                      isNotLastInColumn && { marginBottom: 10 },
                    ]}
                    onPress={btn.onPress}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={{
                        color: isConfirm ? '#FFFFFF' : '#111111',
                        fontWeight: '600',
                        fontSize: 15,
                        textAlign: 'center',
                      }}
                    >
                      {btn.text}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff' },
  backBtn: { padding: 12, borderRadius: 28, backgroundColor: '#f2f2f2', justifyContent: 'center', alignItems: 'center' },
  backIcon: { width: 20, height: 20, tintColor: '#333', marginTop: 2 },
  headerTitle: { fontSize: 18, fontWeight: '600', flex: 1, textAlign: 'center' },
  
  profileHeader: { alignItems: 'center', paddingVertical: 20, backgroundColor: '#fff' },
  avatarContainer: { position: 'relative', marginBottom: 12 },
  avatar: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#ddd' },
  cameraBtn: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#fff', borderRadius: 20, padding: 6, elevation: 2, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4 },
  cameraIcon: { width: 20, height: 20, tintColor: '#333' },
  username: { fontSize: 20, fontWeight: '700', color: '#222', marginBottom: 12 },
  
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 20 },
  tag: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, margin: 4, elevation: 1 },
  tagIcon: { width: 16, height: 16, marginRight: 6, resizeMode: 'contain' },
  tagText: { fontSize: 12, fontWeight: '600' },
  addTagBtn: { backgroundColor: '#f0f0f0', borderStyle: 'dashed', borderWidth: 1, borderColor: '#ccc' },
  addTagText: { fontSize: 12, color: '#666' },

  divider: { height: 1, backgroundColor: '#eee', marginVertical: 10 },

  section: { paddingHorizontal: 20, marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#222', marginBottom: 8 },
  
  bioContainer: { backgroundColor: '#f5f5f5', borderRadius: 12, padding: 4 },
  bioInput: { minHeight: 100, padding: 12, fontSize: 14, color: '#333', textAlignVertical: 'top' },
  
  contactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  contactText: { fontSize: 14, color: '#555' },

  achievementsScroll: { marginTop: 8 },
  achievementPlaceholder: { width: 140, height: 100, backgroundColor: '#e9ffe9', borderRadius: 12, padding: 12, marginRight: 12, justifyContent: 'center' },
  achievementIconPlaceholder: { width: 32, height: 32, backgroundColor: '#32CD32', borderRadius: 8, marginBottom: 12 },
  achievementLines: { },
  line: { height: 8, backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 4, marginBottom: 6 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '80%', backgroundColor: '#fff', borderRadius: 16, padding: 20, maxHeight: '60%' },
  tagModalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center', color: '#111' },
  modalTags: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 20 },
  modalTag: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, margin: 6, elevation: 2 },
  confirmBtn: { 
    backgroundColor: '#EF4444', 
    paddingVertical: 8, 
    paddingHorizontal: 16, 
    borderRadius: 20, 
    alignSelf: 'flex-end', 
    flexDirection: 'row', 
    alignItems: 'center',
    marginTop: 10
  },
  confirmBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  confirmBtnIcon: { width: 14, height: 14, tintColor: '#fff', marginRight: 6 },

  // Modal styles
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalCenteredWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingVertical: 28,
    paddingHorizontal: 22,
    width: '100%',
    maxWidth: 420,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
    textAlign: 'center',
    marginBottom: 22,
  },
  modalMessage: {
    fontSize: 14,
    color: '#374151',
    textAlign: 'center',
    marginBottom: 18,
  },
  modalButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonCancel: {
    backgroundColor: '#E5E7EB',
  },
  modalButtonConfirm: {
    backgroundColor: '#EF4444',
  },
  modalButtonCancelText: {
    color: '#1F2937',
    fontWeight: '600',
    fontSize: 15,
  },
  modalButtonConfirmText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
})
