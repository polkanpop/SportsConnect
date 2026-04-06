/**
 * ZaloAuthOverlayProvider
 *
 * Renders a full-screen white overlay at the ROOT of the view hierarchy — outside the
 * Stack navigator — as a simple absolute-positioned View (NOT a Modal/Dialog).
 *
 * Safety mechanisms (prevent stuck-forever black/white screen):
 *   1. Auto-hide timeout: overlay auto-hides after MAX_OVERLAY_MS (30 s).
 *   2. Busy lock: while a Zalo auth flow is active, AppState recovery will NOT
 *      auto-hide the overlay — only the explicit hide() call or the absolute
 *      safety timer will dismiss it.
 *   3. AppState recovery: when the app resumes AND no flow is busy AND the overlay
 *      has been visible for > RESUME_GRACE_MS (8 s), it auto-hides.
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

/** Absolute maximum time the overlay can stay visible before auto-hiding (ms). */
const MAX_OVERLAY_MS = 30_000
/** If the app resumes, no flow is busy, and overlay has been visible longer than this, auto-hide. */
const RESUME_GRACE_MS = 8_000

// Module-level state survives provider remounts during activity recreation.
let _overlayVisible = false
let _overlayShowTime = 0
let _flowBusy = false // true while a Zalo auth flow is in-progress

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
    _flowBusy = false
    setVisible(false)
  }, [clearTimer])

  const show = useCallback(() => {
    clearTimer()
    _flowBusy = true
    _overlayVisible = true
    _overlayShowTime = Date.now()
    setVisible(true)
    // Safety: auto-hide after MAX_OVERLAY_MS no matter what.
    autoHideTimer.current = setTimeout(doHide, MAX_OVERLAY_MS)
  }, [clearTimer, doHide])

  // ── AppState recovery ─────────────────────────────────────────────────────
  // When the app comes back to foreground, check if the overlay is stale.
  // Skip auto-hide while a flow is actively busy (prevents premature dismiss).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && _overlayVisible && _overlayShowTime > 0 && !_flowBusy) {
        const elapsed = Date.now() - _overlayShowTime
        if (elapsed > RESUME_GRACE_MS) {
          doHide()
        }
      }
    })
    // On mount: if _overlayVisible is stale AND no flow is busy, auto-hide immediately.
    if (_overlayVisible && !_flowBusy && _overlayShowTime > 0 && Date.now() - _overlayShowTime > RESUME_GRACE_MS) {
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
