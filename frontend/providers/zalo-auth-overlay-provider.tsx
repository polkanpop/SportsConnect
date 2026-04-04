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

export function ZaloAuthOverlayProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false)

  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => setVisible(false), [])

  return (
    <ZaloAuthOverlayContext.Provider value={{ show, hide }}>
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
    // High elevation so Android draws this on top of the reconstructed surface
    elevation: 20,
    zIndex: 9999,
  },
})
