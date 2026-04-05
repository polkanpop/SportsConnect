/**
 * ZaloAuthOverlayProvider
 *
 * Renders a full-screen white overlay at the ROOT of the view hierarchy — outside the
 * Stack navigator — so it survives the Android surface reconstruction that occurs on
 * OPPO/ColorOS (and similar) when Chrome Custom Tab closes.
 *
 * Architecture:
 *   - show()  → called just before openAuthSessionAsync
 *   - hide()  → called ONLY inside a useEffect on the DESTINATION screen, after that
 *               screen's first render has committed to the native layer.
 *               This guarantees the overlay covers the ~300 ms surface-reconstruction
 *               window even on slow OPPO devices where AppState + requestAnimationFrame
 *               fire before the surface is actually ready to draw.
 *
 * Placement in _layout.tsx:
 *   GestureHandlerRootView
 *     ZaloAuthOverlayProvider          ← wraps everything
 *       ThemeProvider / Stack / …
 *       {overlay renders AFTER children, highest z-order inside GestureHandlerRootView}
 */
import React, { createContext, useCallback, useContext, useState } from 'react'
import { ActivityIndicator, Modal, StyleSheet, View } from 'react-native'

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

// Module-level flag so the overlay state survives provider remounts (e.g. if
// _layout.tsx re-renders and unmounts/remounts the provider during app resume).
let _overlayVisible = false

export function ZaloAuthOverlayProvider({ children }: { children: React.ReactNode }) {
  // Initialise from the module-level flag so a remounted provider stays in sync.
  const [visible, setVisible] = useState(_overlayVisible)

  const show = useCallback(() => {
    _overlayVisible = true
    setVisible(true)
  }, [])

  const hide = useCallback(() => {
    _overlayVisible = false
    setVisible(false)
  }, [])

  return (
    <ZaloAuthOverlayContext.Provider value={{ show, hide }}>
      {children}
      {/*
       * Using a Modal (Android Dialog window) instead of a plain View so that the
       * overlay lives in its OWN native window — completely separate from the app's
       * main ViewRootImpl surface. This means it survives the OPPO/ColorOS surface
       * reconstruction that occurs when Chrome Custom Tab closes, even during the
       * ~800 ms gap where the main surface is dead and no React View can paint.
       *
       * When CCT is in the foreground it covers the Dialog (which waits behind
       * it). When CCT finishes and the app's Activity returns to the foreground
       * the Dialog is immediately visible — no surface relayout needed.
       */}
      <Modal
        visible={visible}
        transparent={false}
        animationType="none"
        statusBarTranslucent={true}
        onRequestClose={() => { /* ignore hardware back while overlay is shown */ }}
      >
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#0068FF" />
        </View>
      </Modal>
    </ZaloAuthOverlayContext.Provider>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
})
