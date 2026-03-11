import re

REGISTER_PATH = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\courtRegister.tsx'

# ========== courtRegister.tsx ==========
with open(REGISTER_PATH, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add Animated + gesture imports
old_imports_reg = "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'"
new_imports_reg = ("import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'\n"
                   "import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'\n"
                   "import { Gesture, GestureDetector } from 'react-native-gesture-handler'\n"
                   "import { GestureHandlerRootView } from 'react-native-gesture-handler'")
assert content.count(old_imports_reg) == 1, 'Import check fail'
content = content.replace(old_imports_reg, new_imports_reg)

# 2. Add useWindowDimensions to the RN imports (it's not there yet)
old_rn_import = "import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator, Pressable } from 'react-native'"
new_rn_import = "import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Image, Alert, KeyboardAvoidingView, Platform, Modal, Dimensions, ActivityIndicator, Pressable, useWindowDimensions } from 'react-native'"
assert content.count(old_rn_import) == 1, 'RN import check fail'
content = content.replace(old_rn_import, new_rn_import)

# 3. Find a good place to add zoom state + values - look for existing useMemo useState cluster
# Add after the first useState that appears in the component function
# Search for the function definition and first state
zoom_state_str = (
    "\n  // Image zoom\n"
    "  const [zoomImageUri, setZoomImageUri] = useState<string | null>(null)\n"
    "  const zoomWindow = useWindowDimensions()\n"
    "  const zoomFrameW = Math.max(260, Math.min(Math.round(zoomWindow.width * 0.92), 560))\n"
    "  const zoomFrameH = Math.max(260, Math.min(Math.round(zoomWindow.height * 0.72), 640))\n"
    "  const zoomScale = useSharedValue(1)\n"
    "  const zoomTX = useSharedValue(0)\n"
    "  const zoomTY = useSharedValue(0)\n"
    "  const zoomBaseScale = useSharedValue(1)\n"
    "  const zoomBaseX = useSharedValue(0)\n"
    "  const zoomBaseY = useSharedValue(0)\n"
    "  const zoomAnimStyle = useAnimatedStyle(() => ({ transform: [{ translateX: zoomTX.value }, { translateY: zoomTY.value }, { scale: zoomScale.value }] }))\n"
    "  const zoomGesture = React.useMemo(() => {\n"
    "    const pinch = Gesture.Pinch()\n"
    "      .onUpdate((e) => { zoomScale.value = Math.max(1, Math.min(zoomBaseScale.value * e.scale, 4)) })\n"
    "      .onEnd(() => { zoomBaseScale.value = zoomScale.value })\n"
    "    const pan = Gesture.Pan()\n"
    "      .onUpdate((e) => { if (zoomScale.value <= 1) return; zoomTX.value = zoomBaseX.value + e.translationX; zoomTY.value = zoomBaseY.value + e.translationY })\n"
    "      .onEnd(() => { zoomBaseX.value = zoomTX.value; zoomBaseY.value = zoomTY.value })\n"
    "    return Gesture.Simultaneous(pinch, pan)\n"
    "  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomScale, zoomTX, zoomTY])\n"
    "  useEffect(() => {\n"
    "    if (!zoomImageUri) return\n"
    "    zoomScale.value = 1; zoomTX.value = 0; zoomTY.value = 0; zoomBaseScale.value = 1; zoomBaseX.value = 0; zoomBaseY.value = 0\n"
    "  }, [zoomBaseScale, zoomBaseX, zoomBaseY, zoomImageUri, zoomScale, zoomTX, zoomTY])\n"
)

# Insert after the existing draft key constant block
insert_after = "const digitsOnly = (s: string) => String(s || '').replace(/\\D+/g, '')"
assert content.count(insert_after) == 1, f'Insert point check fail: {content.count(insert_after)}'
content = content.replace(
    insert_after,
    insert_after + "\n\nfunction CourtRegisterScreen() {// ZOOM_STATE_PLACEHOLDER",
    1
)
# Ugh that's messy. Let me find a better approach - find the function body and insert after first useState

# Revert
content = content.replace(
    insert_after + "\n\nfunction CourtRegisterScreen() {// ZOOM_STATE_PLACEHOLDER",
    insert_after
)

# Better: find a specific useState that only appears once near the top of the component
target_insert = "  const [subCourtList, setSubCourtList] = useState<SubCourt[]>([])"
c = content.count(target_insert)
print(f'Target insert matches: {c}')

# Add zoom state right after subCourtList state
assert c == 1, f'Expected 1, got {c}'
content = content.replace(
    target_insert,
    target_insert + zoom_state_str
)

# 4. Replace <View style={styles.coverPressable}> (wrapping coverImage) with TouchableOpacity
# Use regex to replace all such instances (any indentation)
pattern = r'(<View\s+style=\{styles\.coverPressable\}>\s*<Image\s+source=\{\{\s*uri\s*\}\}\s+style=\{styles\.coverImage\}\s*/>\s*</View>)'
def replace_cover(m):
    original = m.group(1)
    # Replace <View with <TouchableOpacity onPress and </View> with </TouchableOpacity>
    result = original.replace(
        '<View style={styles.coverPressable}>',
        '<TouchableOpacity style={styles.coverPressable} onPress={() => setZoomImageUri(uri)} activeOpacity={0.9}>'
    ).replace('</View>', '</TouchableOpacity>')
    return result

new_content = re.sub(pattern, replace_cover, content, flags=re.DOTALL)
count_replaced = len(re.findall(pattern, content, flags=re.DOTALL))
print(f'Cover image replacements: {count_replaced}')
content = new_content

# 5. Find the end of the JSX return (before the styles.create) and add zoom modal
# Look for end of the return statement - the last closing tag before StyleSheet.create
zoom_modal = (
    "\n      {/* Image Zoom Modal */}\n"
    "      <Modal visible={!!zoomImageUri} transparent animationType=\"fade\" onRequestClose={() => setZoomImageUri(null)}>\n"
    "        <GestureHandlerRootView style={{ flex: 1 }}>\n"
    "          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)' }}>\n"
    "            <Pressable style={StyleSheet.absoluteFillObject} onPressIn={() => setZoomImageUri(null)} />\n"
    "            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }} pointerEvents=\"box-none\">\n"
    "              {!!zoomImageUri && (\n"
    "                <GestureDetector gesture={zoomGesture}>\n"
    "                  <Animated.Image\n"
    "                    source={{ uri: zoomImageUri }}\n"
    "                    style={[{ width: zoomFrameW, height: zoomFrameH }, zoomAnimStyle]}\n"
    "                    resizeMode=\"contain\"\n"
    "                  />\n"
    "                </GestureDetector>\n"
    "              )}\n"
    "            </View>\n"
    "          </View>\n"
    "        </GestureHandlerRootView>\n"
    "      </Modal>\n"
)

# Find the return statement closing - look for the pattern before the main function close
# The return block ends with </ScrollView>\n  )\n}
end_pattern = r'    </ScrollView>\n  \)\n\}'
matches = re.findall(end_pattern, content)
print(f'End pattern matches: {len(matches)}')
# Replace only the last occurrence
last_idx = content.rfind('    </ScrollView>\n  )\n}')
if last_idx != -1:
    content = content[:last_idx] + zoom_modal + '    </ScrollView>\n  )\n}' + content[last_idx + len('    </ScrollView>\n  )\n}'):]
    print('Zoom modal added to courtRegister.tsx')

with open(REGISTER_PATH, 'w', encoding='utf-8') as f:
    f.write(content)
print('courtRegister.tsx done!')
