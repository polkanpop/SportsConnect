import re

PATH = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\(tabs)\Map.tsx'

with open(PATH, 'r', encoding='utf-8') as f:
    content = f.read()

# ── Step 1: Add Animated+reanimated import ───────────────────────────────────
OLD_REACT = '  import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";'
NEW_REACT = (
    '  import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";\n'
    '  import Animated, { useAnimatedStyle, useSharedValue } from \'react-native-reanimated\';'
)
assert content.count(OLD_REACT) == 1, f'Step 1: {content.count(OLD_REACT)} matches'
content = content.replace(OLD_REACT, NEW_REACT)
print('Step 1 done')

# ── Step 2: Add Gesture, GestureDetector to gesture-handler import ────────────
OLD_GH = '  import { GestureHandlerRootView } from "react-native-gesture-handler";'
NEW_GH = '  import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";'
assert content.count(OLD_GH) == 1, f'Step 2: {content.count(OLD_GH)} matches'
content = content.replace(OLD_GH, NEW_GH)
print('Step 2 done')

# ── Step 3: Add useWindowDimensions to RN import ─────────────────────────────
OLD_RN_END = '    View,\n  } from "react-native";'
NEW_RN_END = '    View,\n    useWindowDimensions,\n  } from "react-native";'
assert content.count(OLD_RN_END) == 1, f'Step 3: {content.count(OLD_RN_END)} matches'
content = content.replace(OLD_RN_END, NEW_RN_END)
print('Step 3 done')

# ── Step 4: Add zoom state + shared values after isFavorite state ─────────────
OLD_FAV = '    const [isFavorite, setIsFavorite] = useState(false);'
ZOOM_BLOCK = """
    // Image zoom
    const [zoomMapImageUri, setZoomMapImageUri] = useState<string | null>(null)
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
      if (!zoomMapImageUri) return
      zoomScale.value = 1; zoomTX.value = 0; zoomTY.value = 0
      zoomBaseScale.value = 1; zoomBaseX.value = 0; zoomBaseY.value = 0
    }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomMapImageUri, zoomScale, zoomTX, zoomTY])"""

assert content.count(OLD_FAV) == 1, f'Step 4: {content.count(OLD_FAV)} matches'
content = content.replace(OLD_FAV, OLD_FAV + ZOOM_BLOCK)
print('Step 4 done')

# ── Step 5: Wrap aggregatedImages.map Image in TouchableOpacity ───────────────
OLD_IMG = """                          {aggregatedImages.map((image, idx) => (
                            <Image
                              key={`${image}:${idx}`}
                              source={{ uri: image }}
                              style={styles.detailImageTile}
                            />
                          ))}"""
NEW_IMG = """                          {aggregatedImages.map((image, idx) => (
                            <TouchableOpacity key={`${image}:${idx}`} onPress={() => setZoomMapImageUri(image)} activeOpacity={0.9}>
                              <Image
                                source={{ uri: image }}
                                style={styles.detailImageTile}
                              />
                            </TouchableOpacity>
                          ))}"""
assert content.count(OLD_IMG) == 1, f'Step 5: {content.count(OLD_IMG)} matches'
content = content.replace(OLD_IMG, NEW_IMG)
print('Step 5 done')

# ── Step 6: Add zoom modal before </SafeAreaProvider> ─────────────────────────
ZOOM_MODAL = """
          {/* Image Zoom Modal */}
          <Modal visible={!!zoomMapImageUri} transparent animationType="fade" onRequestClose={() => setZoomMapImageUri(null)}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setZoomMapImageUri(null)}>
                {!!zoomMapImageUri && (
                  <GestureDetector gesture={zoomGesture}>
                    <Animated.Image
                      source={{ uri: zoomMapImageUri }}
                      style={[{ width: zoomFrameW, height: zoomFrameH }, zoomAnimStyle]}
                      resizeMode="contain"
                    />
                  </GestureDetector>
                )}
              </Pressable>
            </GestureHandlerRootView>
          </Modal>"""

SAFE_CLOSE = '        </SafeAreaProvider>'
assert content.count(SAFE_CLOSE) == 1, f'Step 6: {content.count(SAFE_CLOSE)} matches'
content = content.replace(SAFE_CLOSE, ZOOM_MODAL + '\n' + SAFE_CLOSE)
print('Step 6 done')

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(content)
print('\nAll done! Map.tsx written successfully.')
