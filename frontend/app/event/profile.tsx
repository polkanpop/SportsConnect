import { StyleSheet, Text, View, TouchableOpacity, Image, ScrollView, TextInput, Switch, Modal, FlatList, TouchableWithoutFeedback, ActivityIndicator } from 'react-native'
import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ICONS } from '@/constants/icons'
import { Image as ExpoImage } from 'expo-image'
import { useAppBootstrap } from '@/providers/app-bootstrap-provider'
import { cloudinarySignUpload, deleteMyProfilePicture, updateUserInfo, updateUserPfp } from '@/lib/backendApi'
import { queryClient } from '@/providers/query-provider'
import { queryKeys } from '@/hooks/query-keys'
import * as ImagePicker from 'expo-image-picker'
import * as ImageManipulator from 'expo-image-manipulator'
import { useTranslation } from '@/constants/translations'
import { useThemeColors } from '@/hooks/use-theme-colors'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { setCache } from '@/lib/cache'

export default function Profile() {
  const router = useRouter()
  const { t } = useTranslation()
  const tc = useThemeColors()
  const { userId: userid, userInfo: userInfoQuery } = useAppBootstrap()
  const userInfo = userInfoQuery.data
  
  const [bio, setBio] = useState('')
  const [emailVisible, setEmailVisible] = useState(true)
  const [phoneVisible, setPhoneVisible] = useState(true)
  const [showContactLog, setShowContactLog] = useState<{ field: 'email' | 'phone'; visible: boolean } | null>(null)
  const logTimerRef = useRef<any>(null)
  
  const [isEditingBio, setIsEditingBio] = useState(false)
  const [showBioSuccess, setShowBioSuccess] = useState(false)
  const [showUnsavedModal, setShowUnsavedModal] = useState(false)
  const bioSuccessTimerRef = useRef<any>(null)

  const [showActionModal, setShowActionModal] = useState(false)
  const [actionModalTitle, setActionModalTitle] = useState<string>('')
  const [actionModalMessage, setActionModalMessage] = useState<string | null>(null)
  const [actionModalButtons, setActionModalButtons] = useState<Array<{ text: string; variant?: 'cancel' | 'confirm'; onPress: () => void }>>([])
  const [actionModalLayout, setActionModalLayout] = useState<'row' | 'column' | null>(null)

  const [uploadingPfp, setUploadingPfp] = useState(false)
  const [pfpOverrideUri, setPfpOverrideUri] = useState<string | null>(null)

  const closeActionModal = () => setShowActionModal(false)
  const openActionModal = (opts: {
    title: string
    message?: string | null
    buttons: Array<{ text: string; variant?: 'cancel' | 'confirm'; onPress: () => void }>
    layout?: 'row' | 'column'
  }) => {
    setActionModalTitle(opts.title)
    setActionModalMessage(typeof opts.message === 'string' ? opts.message : null)
    setActionModalButtons(opts.buttons)
    setActionModalLayout(opts.layout ?? null)
    setShowActionModal(true)
  }

  // Sync local state with fetched data
  useEffect(() => {
    if (userInfo) {
      setBio(userInfo.biography || '')
      if (typeof userInfo.emailvisiblestatus === 'boolean') setEmailVisible(userInfo.emailvisiblestatus)
      if (typeof userInfo.phonevisiblestatus === 'boolean') setPhoneVisible(userInfo.phonevisiblestatus)
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


  const handleToggleEmail = async () => {
    if (!userid) return
    const next = !emailVisible
    setEmailVisible(next)
    setShowContactLog({ field: 'email', visible: next })
    if (logTimerRef.current) clearTimeout(logTimerRef.current)
    logTimerRef.current = setTimeout(() => setShowContactLog(null), 5000)
    try {
      await updateUserInfo(userid, { emailvisiblestatus: next })
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
    } catch (e) {
      console.warn('Failed to persist email visibility', (e as any)?.message)
    }
  }

  const handleTogglePhone = async () => {
    if (!userid) return
    const next = !phoneVisible
    setPhoneVisible(next)
    setShowContactLog({ field: 'phone', visible: next })
    if (logTimerRef.current) clearTimeout(logTimerRef.current)
    logTimerRef.current = setTimeout(() => setShowContactLog(null), 5000)
    try {
      await updateUserInfo(userid, { phonevisiblestatus: next })
      queryClient.invalidateQueries({ queryKey: queryKeys.userInfo(userid) })
    } catch (e) {
      console.warn('Failed to persist phone visibility', (e as any)?.message)
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
        title: t('COMMON_ERR_NOT_SIGNED_IN'),
        message: t('PROFILE_ERR_LOGIN_AGAIN'),
        buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
      })
      return
    }
    if (result.canceled) return
    const uri = result.assets?.[0]?.uri
    if (!uri) return

    setUploadingPfp(true)
    setPfpOverrideUri(uri)
    try {
      // If the user already has a profile picture, delete the previous Cloudinary asset first
      // (requirement: change/delete should remove the previous one from Cloudinary).
      if (userInfo?.pfp) {
        try {
          await deleteMyProfilePicture()
        } catch (e: any) {
          console.error('Delete previous PFP failed', e)
          openActionModal({
            title: t('PROFILE_PFP_ERR_FAILED_TITLE'),
            message: e?.message || t('PROFILE_PFP_ERR_DELETE_PREV'),
            buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
          })
          setPfpOverrideUri(null)
          return
        }
      }
      const remoteUrl = await uploadToCloudinary(uri)
      await updateUserPfp(userid, remoteUrl)
      setPfpOverrideUri(remoteUrl)
      // Patch dashboard cache in-place — no invalidation avoids stale refetch race with backend Redis
      queryClient.setQueryData(queryKeys.dashboard(userid), (old: any) =>
        old ? { ...old, userinfo: { ...(old.userinfo ?? {}), pfp: remoteUrl } } : old
      )
      // Pre-warm AsyncStorage cache so Settings.tsx shows new pfp immediately
      try {
        await setCache(`cache:userinfo:user:${userid}:v1`, { ...(userInfo as any ?? {}), pfp: remoteUrl }, 60_000, 120_000)
        const raw = await AsyncStorage.getItem('@backendProfile')
        if (raw) {
          const parsed = JSON.parse(raw)
          parsed.pfp = remoteUrl
          await AsyncStorage.setItem('@backendProfile', JSON.stringify(parsed))
        }
      } catch { /* ignore cache errors */ }
    } catch (e: any) {
      console.error('PFP upload failed', e)
      openActionModal({
        title: t('COMMON_ERR_UPLOAD'),
        message: e?.message || t('COMMON_ERR_TRY_AGAIN'),
        buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
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
        title: t('COMMON_ERR_PERMISSION'),
        message: t('PROFILE_PFP_ERR_PHOTO_PERM'),
        buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
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
        title: t('COMMON_ERR_PERMISSION'),
        message: t('PROFILE_PFP_ERR_CAMERA_PERM'),
        buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
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
    const hasPfp = !!(pfpOverrideUri || userInfo?.pfp)

    const openChangePicker = () => {
      openActionModal({
        title: t('PROFILE_PFP_CHANGE_TITLE'),
        message: t('PROFILE_PFP_PICK_HINT'),
        buttons: [
          {
            text: t('PROFILE_PFP_BTN_TAKE_PHOTO'),
            variant: 'confirm',
            onPress: () => {
              closeActionModal()
              void handleTakePhoto()
            },
          },
          {
            text: t('PROFILE_PFP_BTN_LIBRARY'),
            variant: 'cancel',
            onPress: () => {
              closeActionModal()
              void handlePickFromLibrary()
            },
          },
        ],
      })
    }

    if (!hasPfp) {
      // No existing photo: go straight to pick/take
      openChangePicker()
      return
    }

    // Existing photo: only show the two required options
    openActionModal({
      title: t('PROFILE_PFP_TITLE'),
      message: null,
      layout: 'column',
      buttons: [
        {
          text: t('PROFILE_PFP_CHANGE_TITLE'),
          variant: 'confirm',
          onPress: () => {
            closeActionModal()
            openChangePicker()
          },
        },
        {
          text: t('PROFILE_PFP_BTN_DELETE'),
          variant: 'cancel',
          onPress: () => {
            closeActionModal()
            void (async () => {
              if (!userid) {
                openActionModal({
                  title: t('COMMON_ERR_NOT_SIGNED_IN'),
                  message: t('PROFILE_ERR_LOGIN_AGAIN'),
                  buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
                })
                return
              }
              setUploadingPfp(true)
              setPfpOverrideUri(null)
              try {
                await deleteMyProfilePicture()
                // Patch dashboard cache in-place with pfp cleared
                queryClient.setQueryData(queryKeys.dashboard(userid), (old: any) =>
                  old ? { ...old, userinfo: { ...(old.userinfo ?? {}), pfp: null } } : old
                )
                // Pre-warm AsyncStorage cache with pfp cleared
                try {
                  await setCache(`cache:userinfo:user:${userid}:v1`, { ...(userInfo as any ?? {}), pfp: null }, 60_000, 120_000)
                  const raw = await AsyncStorage.getItem('@backendProfile')
                  if (raw) {
                    const parsed = JSON.parse(raw)
                    parsed.pfp = null
                    await AsyncStorage.setItem('@backendProfile', JSON.stringify(parsed))
                  }
                } catch { /* ignore cache errors */ }
              } catch (e: any) {
                console.error('Delete PFP failed', e)
                openActionModal({
                  title: t('PROFILE_PFP_ERR_FAILED_TITLE'),
                  message: e?.message || t('PROFILE_PFP_ERR_DELETE'),
                  buttons: [{ text: t('COMMON_BTN_OK'), variant: 'cancel', onPress: closeActionModal }],
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
    <SafeAreaView style={[styles.screen, { backgroundColor: tc.bgBase }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.headerRow, { backgroundColor: tc.bgBase }]}>
        <TouchableOpacity style={[styles.backBtn, { backgroundColor: tc.bgSurface }]} onPress={() => router.back()}>
          <Image source={ICONS.arrowLeft} style={[styles.backIcon, { tintColor: tc.textPrimary }]} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>{t('PROFILE_HEADER_TITLE')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Profile Header */}
        <View style={[styles.profileHeader, { backgroundColor: tc.bgBase }]}>
          <View style={styles.avatarContainer}>
            {pfpOverrideUri || userInfo?.pfp ? (
              <ExpoImage source={{ uri: (pfpOverrideUri || userInfo?.pfp) as string }} style={styles.avatar} contentFit="cover" />
            ) : (
              <Image source={ICONS.accountCircle} style={styles.avatar} />
            )}
            <TouchableOpacity style={[styles.cameraBtn, { backgroundColor: tc.bgSurface, shadowColor: tc.shadow }]} onPress={handlePressCamera} disabled={uploadingPfp}>
              {uploadingPfp ? (
                <ActivityIndicator size="small" color="#333" />
              ) : (
                <Image source={ICONS.camera} style={[styles.cameraIcon, { tintColor: tc.textPrimary }]} />
              )}
            </TouchableOpacity>
          </View>
          <Text style={[styles.username, { color: tc.textPrimary }]}>{userInfo?.name || t('PROFILE_USERNAME_FALLBACK')}</Text>
        </View>

        <View style={[styles.divider, { backgroundColor: tc.divider }]} />

        {/* Biography */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, marginRight: 10, color: tc.textPrimary }]}>{t('PROFILE_SECTION_BIOGRAPHY')}</Text>
            <TouchableOpacity onPress={isEditingBio ? handleCancelEdit : handleEditBio}>
              <Image 
                source={isEditingBio ? ICONS.cancelEdit : ICONS.edit} 
                style={{ width: 14, height: 14 }} 
              />
            </TouchableOpacity>
            {showBioSuccess && (
              <Text style={{ marginLeft: 10, fontSize: 12, color: 'green', fontStyle: 'italic' }}>
                {t('PROFILE_BIO_SAVE_SUCCESS')}
              </Text>
            )}
          </View>
          
          {isEditingBio ? (
            <View style={[styles.bioContainer, { backgroundColor: tc.bgInput }]}>
              <TextInput
                style={[styles.bioInput, { color: tc.textPrimary }]}
                multiline
                placeholder={t('PROFILE_BIO_PLACEHOLDER')}
                placeholderTextColor={tc.placeholder}
                value={bio}
                onChangeText={setBio}
                autoFocus
              />
              <TouchableOpacity 
                style={{ position: 'absolute', bottom: 8, right: 8 }}
                onPress={() => {
                  const originalBio = userInfo?.biography || ''
                  if (bio === originalBio) { setIsEditingBio(false) } else { handleSaveBio() }
                }}
              >
                <Image source={ICONS.tick} style={{ width: 22, height: 22, tintColor: 'green' }} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 4 }}>
              <Text style={{ fontSize: 14, color: bio ? tc.textPrimary : tc.textMuted }}>
                {bio || t('PROFILE_BIO_PLACEHOLDER')}
              </Text>
            </View>
          )}
        </View>

        {/* Contact */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { marginBottom: 12, color: tc.textPrimary }]}>{t('PROFILE_SECTION_CONTACT')}</Text>

          {/* Email row */}
          <View style={[styles.contactRow, { marginBottom: 10 }]}>
            <Text style={[styles.contactLabel]}>{t('PROFILE_CONTACT_LABEL_EMAIL')}</Text>
            <Text style={[styles.contactText, { flex: 1 }]}>{userInfo?.email || t('PROFILE_CONTACT_FALLBACK')}</Text>
            <TouchableOpacity onPress={handleToggleEmail} style={{ paddingLeft: 8 }}>
              <Image source={emailVisible ? ICONS.eye : ICONS.notEye} style={{ width: 16, height: 16, tintColor: tc.textSecondary }} />
            </TouchableOpacity>
          </View>

          {/* Phone row */}
          <View style={styles.contactRow}>
            <Text style={[styles.contactLabel]}>{t('PROFILE_CONTACT_LABEL_PHONE')}</Text>
            <Text style={[styles.contactText, { flex: 1 }]}>{userInfo?.contactnumber ? (userInfo.contactnumber.startsWith('+84') && userInfo.contactnumber.length === 12 ? '0' + userInfo.contactnumber.slice(3) : userInfo.contactnumber) : t('PROFILE_CONTACT_NO_PHONE')}</Text>
            <TouchableOpacity onPress={handleTogglePhone} style={{ paddingLeft: 8 }}>
              <Image source={phoneVisible ? ICONS.eye : ICONS.notEye} style={{ width: 16, height: 16, tintColor: tc.textSecondary }} />
            </TouchableOpacity>
          </View>

          {showContactLog && (
            <Text style={{ marginTop: 6, fontSize: 12, color: tc.textSecondary, fontStyle: 'italic' }}>
              {showContactLog.field === 'email'
                ? (showContactLog.visible ? t('PROFILE_EMAIL_NOW_VISIBLE') : t('PROFILE_EMAIL_NOW_HIDDEN'))
                : (showContactLog.visible ? t('PROFILE_PHONE_NOW_VISIBLE') : t('PROFILE_PHONE_NOW_HIDDEN'))}
            </Text>
          )}
        </View>

        {/* Achievements removed */}

      </ScrollView>

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
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated, shadowColor: tc.shadow }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{t('PROFILE_MODAL_UNSAVED_CHANGES')}</Text>
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel, { marginRight: 12 }]}
                onPress={() => setShowUnsavedModal(false)}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalButtonCancelText, { color: tc.textPrimary }]}>{t('PROFILE_MODAL_BTN_RETURN')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={handleConfirmExit}
                activeOpacity={0.8}
              >
                <Text style={styles.modalButtonConfirmText}>{t('PROFILE_MODAL_BTN_EXIT')}</Text>
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
          <View style={[styles.modalCard, { backgroundColor: tc.bgElevated, shadowColor: tc.shadow }]}>
            <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>{actionModalTitle}</Text>
            {!!actionModalMessage && <Text style={[styles.modalMessage, { color: tc.textSecondary }]}>{actionModalMessage}</Text>}
            <View style={actionModalLayout === 'row' || (actionModalLayout == null && actionModalButtons.length === 2) ? styles.modalButtonsRow : undefined}>
              {actionModalButtons.map((btn, idx) => {
                const isConfirm = btn.variant === 'confirm'
                const isRow = actionModalLayout === 'row' || (actionModalLayout == null && actionModalButtons.length === 2)
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
                        color: isConfirm ? '#FFFFFF' : tc.textPrimary,
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
  changeThemeLink: { fontSize: 13, color: '#333', textDecorationLine: 'underline', marginBottom: 4 },
  
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
  contactLabel: { fontSize: 13, fontWeight: '600', color: '#888', minWidth: 80 },
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
