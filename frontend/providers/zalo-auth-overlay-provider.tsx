/**
 * ZaloAuthOverlayProvider
 *
 * Renders a full-screen white overlay at the ROOT of the view hierarchy — outside the
 * Stack navigator — as a simple absolute-positioned View (NOT a Modal/Dialog).
 *
 * Safety mechanisms (prevent stuck-forever black/white screen):
 *   1. Auto-hide timeout: overlay auto-hides after MAX_OVERLAY_MS (20 s).
 *   2. AppState recovery: when the app resumes from background, if the overlay has
 *      been visible for > RESUME_GRACE_MS (5 s), it auto-hides.
 *   3. No module-level stuck flag: _overlayShowTime resets on hide, and the
 *      AppState listener clears stale overlays even if hide() was never called
 *      (e.g. after activity recreation loses the calling component's state).
 *
 * Placement in _layout.tsx:
 *   GestureHandlerRootView
 *     ZaloAuthOverlayProvider          ← wraps everything
 *       ThemeProvider / Stack / …
 *       {overlay renders AFTER children, highest z-order inside GestureHandlerRootView}
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native'

interface ZaloAuthOverlayContextType {
  show: () => void
  hide: () => void
}

const ZaloAuthOverlayContext = createContext<ZaloAuthOverlayContextType>({
  show: () => {},
  hide: () => {},
})

export function useZaloAuthOverlay() {
  return useContext(ZaloAuthOverlayContext)
}

/** Maximum time the overlay can stay visible before auto-hiding (ms). */
const MAX_OVERLAY_MS = 20_000
/** If the app resumes and the overlay has been visible longer than this, auto-hide. */
const RESUME_GRACE_MS = 5_000

// Module-level state survives provider remounts during activity recreation.
let _overlayVisible = false
let _overlayShowTime = 0 // Date.now() when overlay was last shown

export function ZaloAuthOverlayProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(_overlayVisible)
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (autoHideTimer.current) { clearTimeout(autoHideTimer.current); autoHideTimer.current = null }
  }, [])

  const doHide = useCallback(() => {
    clearTimer()
    _overlayVisible = false
    _overlayShowTime = 0
    setVisible(false)
  }, [clearTimer])

  const show = useCallback(() => {
    clearTimer()
    _overlayVisible = true
    _overlayShowTime = Date.now()
    setVisible(true)
    // Safety: auto-hide after MAX_OVERLAY_MS no matter what.
    autoHideTimer.current = setTimeout(doHide, MAX_OVERLAY_MS)
  }, [clearTimer, doHide])

  // ── AppState recovery ─────────────────────────────────────────────────────
  // When the app comes back to foreground, check if the overlay is stale.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && _overlayVisible && _overlayShowTime > 0) {
        const elapsed = Date.now() - _overlayShowTime
        if (elapsed > RESUME_GRACE_MS) {
          doHide()
        }
      }
    })
    // On mount: if _overlayVisible is stale (e.g. from a previous provider instance
    // that was destroyed during activity recreation), auto-hide immediately.
    if (_overlayVisible && _overlayShowTime > 0 && Date.now() - _overlayShowTime > RESUME_GRACE_MS) {
      doHide()
    }
    return () => sub.remove()
  }, [doHide])

  return (
    <ZaloAuthOverlayContext.Provider value={{ show, hide: doHide }}>
      {children}
      {visible && (
        <View style={styles.overlay} pointerEvents="box-only">
          <ActivityIndicator size="large" color="#0068FF" />
        </View>
      )}
    </ZaloAuthOverlayContext.Provider>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
})
