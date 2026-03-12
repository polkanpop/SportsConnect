import re

PATH = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\courtRegister.tsx'

with open(PATH, 'r', encoding='utf-8') as f:
    content = f.read()

# ── Step 1: React import – add Animated + gesture handler ────────────────────
OLD_REACT = "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'"
NEW_REACT = (
    "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'\n"
    "import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'\n"
    "import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'"
)
assert content.count(OLD_REACT) == 1, f'Step 1: {content.count(OLD_REACT)} matches'
content = content.replace(OLD_REACT, NEW_REACT)
print('Step 1 done')

# ── Step 2: RN import – add useWindowDimensions ───────────────────────────────
OLD_RN = "import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator, Pressable } from 'react-native'"
NEW_RN = "import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator, Pressable, useWindowDimensions } from 'react-native'"
assert content.count(OLD_RN) == 1, f'Step 2: {content.count(OLD_RN)} matches'
content = content.replace(OLD_RN, NEW_RN)
print('Step 2 done')

# ── Step 3: Add zoom state + shared values after expandedCourtIdxs useState ───
OLD_STATE = "  const [expandedCourtIdxs, setExpandedCourtIdxs] = useState<Set<number>>(new Set())"
ZOOM_BLOCK = """\n  // Image zoom
  const [zoomImageUri, setZoomImageUri] = useState<string | null>(null)
  const zoomWindow = useWindowDimensions()
  const zoomFrameW = Math.max(260, Math.min(Math.round(zoomWindow.width * 0.92), 560))
  const zoomFrameH = Math.max(260, Math.min(Math.round(zoomWindow.height * 0.72), 640))
  const zoomScale = useSharedValue(1)
  const zoomTX = useSharedValue(0)
  const zoomTY = useSharedValue(0)
  const zoomBaseScale = useSharedValue(1)
  const zoomBaseX = useSharedValue(0)
  const zoomBaseY = useSharedValue(0)
  const zoomAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: zoomTX.value }, { translateY: zoomTY.value }, { scale: zoomScale.value }],
  }))
  const zoomGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onUpdate((e) => { zoomScale.value = Math.max(1, Math.min(zoomBaseScale.value * e.scale, 4)) })
      .onEnd(() => { zoomBaseScale.value = zoomScale.value })
    const pan = Gesture.Pan()
      .onUpdate((e) => { if (zoomScale.value <= 1) return; zoomTX.value = zoomBaseX.value + e.translationX; zoomTY.value = zoomBaseY.value + e.translationY })
      .onEnd(() => { zoomBaseX.value = zoomTX.value; zoomBaseY.value = zoomTY.value })
    return Gesture.Simultaneous(pinch, pan)
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomScale, zoomTX, zoomTY])
  useEffect(() => {
    if (!zoomImageUri) return
    zoomScale.value = 1; zoomTX.value = 0; zoomTY.value = 0
    zoomBaseScale.value = 1; zoomBaseX.value = 0; zoomBaseY.value = 0
  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomImageUri, zoomScale, zoomTX, zoomTY])"""

assert content.count(OLD_STATE) == 1, f'Step 3: {content.count(OLD_STATE)} matches'
content = content.replace(OLD_STATE, OLD_STATE + ZOOM_BLOCK)
print('Step 3 done')

# ── Step 4: Replace all image-only coverPressable Views with TouchableOpacity ─
# Pattern: any indentation, <View style={styles.coverPressable}> with only <Image/> inside
# Uses backreference so closing indentation matches opening
pattern = re.compile(
    r'( +)<View style=\{styles\.coverPressable\}>\n'
    r'( +)<Image source=\{\{ uri \}\} style=\{styles\.coverImage\} />\n'
    r'\1</View>',
    re.MULTILINE
)
matches = pattern.findall(content)
print(f'Step 4: found {len(matches)} coverPressable+Image patterns')

def replace_cover(m):
    outer = m.group(1)
    inner = m.group(2)
    return (
        f'{outer}<TouchableOpacity style={{styles.coverPressable}} onPress={{() => setZoomImageUri(uri)}} activeOpacity={{0.9}}>\n'
        f'{inner}<Image source={{{{ uri }}}} style={{styles.coverImage}} />\n'
        f'{outer}</TouchableOpacity>'
    )

new_content, count = pattern.subn(replace_cover, content)
print(f'Step 4: replaced {count} instances')
content = new_content

# ── Step 5: Add zoom modal before the final </View> ) } of the component ─────
ZOOM_MODAL = """\n      {/* Image Zoom Modal */}
      <Modal visible={!!zoomImageUri} transparent animationType="fade" onRequestClose={() => setZoomImageUri(null)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setZoomImageUri(null)}>
            {!!zoomImageUri && (
              <GestureDetector gesture={zoomGesture}>
                <Animated.Image
                  source={{ uri: zoomImageUri }}
                  style={[{ width: zoomFrameW, height: zoomFrameH }, zoomAnimStyle]}
                  resizeMode="contain"
                />
              </GestureDetector>
            )}
          </Pressable>
        </GestureHandlerRootView>
      </Modal>"""

CLOSING = "    </View>\n  )\n}"
# rfind = last occurrence (the component's closing View)
idx = content.rfind(CLOSING)
assert idx != -1, 'Step 5: closing not found'
content = content[:idx] + ZOOM_MODAL + '\n' + CLOSING + content[idx + len(CLOSING):]
print('Step 5 done')

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(content)
print('\nAll done! courtRegister.tsx written successfully.')
