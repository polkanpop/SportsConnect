/**
 * FloatingVoiceButton — Draggable 56×56 mic button that triggers voice booking.
 *
 * Features:
 *   - PanResponder-based drag with spring snap to screen edges
 *   - Tap opens voice flow (focus mode → listening → processing → result)
 *   - Pulse animation while listening
 *   - Only renders when voice automation is enabled in settings
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  TouchableWithoutFeedback,
  Vibration,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { COLORS } from '@/constants/colors'
import { useVoiceAutomation } from '@/providers/voice-automation-provider'

const BUTTON_SIZE = 56
const EDGE_PADDING = 12
const TAP_THRESHOLD = 8 // px movement to distinguish tap from drag

export default function FloatingVoiceButton() {
  const { enabled, flowState, startListening, dismiss } = useVoiceAutomation()

  // Don't render if feature is disabled or flow active (overlay handles active states)
  if (!enabled || flowState !== 'idle') return null

  return <DraggableButton onTap={startListening} />
}

// ── Draggable button (extracted to avoid hook rules issues with early return) ─

function DraggableButton({ onTap }: { onTap: () => void }) {
  const { width: screenW, height: screenH } = Dimensions.get('window')

  // Start at bottom-right above tab bar
  const pan = useRef(new Animated.ValueXY({
    x: screenW - BUTTON_SIZE - EDGE_PADDING,
    y: screenH - 180,
  })).current

  const currentPos = useRef({ x: screenW - BUTTON_SIZE - EDGE_PADDING, y: screenH - 180 })
  const dragStart = useRef({ x: 0, y: 0 })
  const totalMovement = useRef(0)

  // Pulse animation
  const pulse = useRef(new Animated.Value(1)).current

  // Track pan offset changes
  useEffect(() => {
    const xId = pan.x.addListener(({ value }) => { currentPos.current.x = value })
    const yId = pan.y.addListener(({ value }) => { currentPos.current.y = value })
    return () => { pan.x.removeListener(xId); pan.y.removeListener(yId) }
  }, [pan])

  const snapToEdge = useCallback((x: number, y: number) => {
    const halfW = screenW / 2
    const targetX = x + BUTTON_SIZE / 2 < halfW
      ? EDGE_PADDING
      : screenW - BUTTON_SIZE - EDGE_PADDING
    const targetY = Math.max(EDGE_PADDING + 40, Math.min(y, screenH - BUTTON_SIZE - 100))

    Animated.spring(pan, {
      toValue: { x: targetX, y: targetY },
      useNativeDriver: false,
      bounciness: 8,
      speed: 12,
    }).start()
  }, [pan, screenW, screenH])

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) =>
      Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4,

    onPanResponderGrant: () => {
      dragStart.current = { ...currentPos.current }
      totalMovement.current = 0
    },
    onPanResponderMove: (_, gs) => {
      totalMovement.current = Math.sqrt(gs.dx * gs.dx + gs.dy * gs.dy)
      pan.setValue({
        x: dragStart.current.x + gs.dx,
        y: dragStart.current.y + gs.dy,
      })
    },
    onPanResponderRelease: (_, gs) => {
      if (totalMovement.current < TAP_THRESHOLD) {
        // It's a tap, not a drag
        Vibration.vibrate(30)
        onTap()
      } else {
        // Snap to edge
        snapToEdge(
          dragStart.current.x + gs.dx,
          dragStart.current.y + gs.dy,
        )
      }
    },
  }), [pan, snapToEdge, onTap])

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.container,
        {
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { scale: pulse },
          ],
        },
      ]}
    >
      <View style={styles.button}>
        <Ionicons name="mic" size={26} color={COLORS.neutral0 ?? '#FFFFFF'} />
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 9999,
    elevation: 10,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: COLORS.brandOrangeDeep ?? '#FF6017',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
})
