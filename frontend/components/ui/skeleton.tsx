import React from 'react'
import { type DimensionValue, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { COLORS } from '@/constants/colors'
import { MotiView } from 'moti'

export function SkeletonPulse(props: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <MotiView
      from={{ opacity: 0.65 }}
      animate={{ opacity: 1 }}
      transition={{ type: 'timing', duration: 900, loop: true }}
      style={props.style as any}
    >
      {props.children}
    </MotiView>
  )
}

export function SkeletonBox(props: {
  style?: StyleProp<ViewStyle>
  width?: DimensionValue
  height: number
  radius?: number
}) {
  const { style, width = '100%', height, radius = 8 } = props
  return (
    <View
      style={[
        styles.base,
        { width, height, borderRadius: radius },
        style,
      ]}
    />
  )
}

export function SkeletonLine(props: {
  width?: DimensionValue
  height?: number
  style?: StyleProp<ViewStyle>
}) {
  const { width = '100%', height = 12, style } = props
  return <SkeletonBox width={width} height={height} radius={6} style={style} />
}

export function SkeletonCard(props: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.card, props.style]}>
      <View style={styles.cardInner}>
        <SkeletonLine width={'70%'} height={16} />
        <SkeletonLine width={'52%'} height={12} style={{ marginTop: 8 }} />
        <View style={styles.tagsRow}>
          <SkeletonBox width={64} height={18} radius={9} />
          <SkeletonBox width={72} height={18} radius={9} />
        </View>
      </View>
    </View>
  )
}

export function SkeletonList(props: { count?: number; style?: StyleProp<ViewStyle> }) {
  const count = typeof props.count === 'number' ? props.count : 6
  return (
    <SkeletonPulse style={props.style}>
      <View>
        {Array.from({ length: count }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </View>
    </SkeletonPulse>
  )
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: COLORS.neutral325,
  },
  card: {
    backgroundColor: COLORS.neutral0,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.neutral350,
  },
  cardInner: {
    flex: 1,
  },
  tagsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
})
