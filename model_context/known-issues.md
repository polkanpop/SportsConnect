# Known Issues, Fixes & Device-Specific Workarounds

## Zalo Black Screen (OPPO/ColorOS)

**Symptom**: After Zalo OAuth via Chrome Custom Tab, the app shows a black screen for 1-2 seconds on return.

**Root Cause**: Chrome Custom Tab is a separate Android Activity. When it's active, the React Native OpenGL surface is released (`SkiaOpenGLPipeline::setSurface: surface=NULL`). On return, surface recreation briefly fails (`OpenGLRenderer: Unable to match the desired swap behavior`). The overlay (a React View on the same OpenGL surface) also goes black.

**Fix**:
1. `ZaloAuthOverlayProvider` renders a white `Animated.View` covering the entire screen
2. `show()` sets opacity to 1 instantly before opening CCT
3. `doHide()` uses `Animated.timing` fade-out (600ms) so the surface has time to stabilize
4. `handleLinkZalo` in accountSettings adds 800ms `setTimeout` before calling `overlay.hide()`

**Files**: `providers/zalo-auth-overlay-provider.tsx`, `app/event/accountSettings.tsx`

---

## Ionicons Empty Squares

**Symptom**: `@expo/vector-icons` Ionicons render as empty red/white squares on physical devices after OTA update.

**Root Cause**: The Ionicons font may not load properly in EAS OTA updates, especially with the new React Native Bridgeless architecture.

**Fix**: Replace all `<Ionicons>` with `<Image source={ICONS.xxx}>` using PNG icons from `constants/icons.ts`. Apply `tintColor` for color control.

**Files**: `components/voice/FloatingVoiceButton.tsx`, `components/voice/VoiceFocusOverlay.tsx`

---

## Voice FAB on Auth Pages

**Symptom**: Mic button appears on login/register screens.

**Root Cause**: `FloatingVoiceButton` and `VoiceFocusOverlay` are rendered in `_layout.tsx` outside the `<Stack>` navigator, making them visible on all screens including `(auth)` group.

**Fix**: Added `useAuthContext().isLoggedIn` check in `FloatingVoiceButton`. Returns `null` when not logged in.

---

## Map Marker Size Imbalance

**Symptom**: Event/training markers 2x larger than court markers on the map.

**Root Cause**: Court markers use SDF at `iconSize: 0.07`, while event/TS use PNG at `iconSize: 0.14`.

**Fix**: Normalized event/TS markers to `iconSize: 0.09` for visual proportionality.

**File**: `components/maps/DynamicMap.tsx`

---

## Render Cold Starts

**Symptom**: First API call after 15min idle takes 10-30 seconds.

**Root Cause**: Render Free tier spins down after inactivity.

**Mitigation**: Frontend shows loading states. Backend pre-warms on Supabase connection. Consider health-check pinger if critical.

---

## EAS Update Crash

**Symptom**: VS Code Copilot agent crashes after EAS update "Published" tick appears.

**Workaround**: Halt the EAS update command immediately after the published tick appears. Do NOT wait for the command to fully complete.

---

## BETA Badge Alignment

**Symptom**: "BETA" text badge slightly misaligned with the label text.

**Fix**: Set `lineHeight: 13`, `includeFontPadding: false` on the BETA Text element for tighter vertical alignment on Android.

**File**: `app/event/accountSettings.tsx` (VoiceToggleSection)
