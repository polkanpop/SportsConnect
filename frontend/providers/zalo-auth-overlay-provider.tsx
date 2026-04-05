/**
 * ZaloAuthOverlayProvider
 *
 * Renders a full-screen white overlay at the ROOT of the view hierarchy — outside the
 * Stack navigator — as a simple absolute-positioned View (NOT a Modal/Dialog).
 *
 * Previous iterations used an Android Modal (Dialog window) to survive surface
 * reconstruction on OPPO/ColorOS. However, the extra Dialog window causes OPPO to
 * cascade-destroy VRI surfaces for 12+ seconds, permanently breaking React rendering
 * and leaving the user stuck on a black screen forever.
 *
 * A plain View is part of the main Activity surface. It won't survive the ~1-2 s
 * surface reconstruction gap, but:
 *   1. It does NOT create extra windows for OPPO to kill (no stuck-forever bug).
 *   2. The native android:windowBackground=white (already in styles.xml) covers the
 *      gap once a native build is installed.
 *   3. A brief white flash during CCT close is cosmetic; stuck-forever is a showstopper.
 *
 * Placement in _layout.tsx:
 *   GestureHandlerRootView
 *     ZaloAuthOverlayProvider          ← wraps everything
 *       ThemeProvider / Stack / …
 *       {overlay renders AFTER children, highest z-order inside GestureHandlerRootView}
 */
import React, { createContext, useCallback, useContext, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'

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
       * Simple absolute-positioned View overlay — part of the main Activity surface.
       * No Modal/Dialog window = no extra VRI for OPPO to kill = no stuck-forever bug.
       */}
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
