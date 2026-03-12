import React, { useMemo, useState } from 'react'
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { ICONS } from '@/constants/icons'

export type ManagementPanelKey = 'user' | 'event' | 'court'

export default function ManagementPanel(props: {
  active: ManagementPanelKey
  onSelect: (key: ManagementPanelKey) => void
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const {
    active,
    onSelect,
    defaultExpanded = false,
    expanded: expandedProp,
    onExpandedChange,
  } = props
  const [expandedInternal, setExpandedInternal] = useState(defaultExpanded)
  const expanded = typeof expandedProp === 'boolean' ? expandedProp : expandedInternal

  const setExpanded = (next: boolean) => {
    if (typeof expandedProp === 'boolean') {
      onExpandedChange?.(next)
      return
    }
    setExpandedInternal(next)
    onExpandedChange?.(next)
  }

  const items = useMemo(
    () =>
      [
        { key: 'user', label: 'User' },
        { key: 'event', label: 'Event/Training Session' },
        { key: 'court', label: 'Venue & Court' },
      ] as Array<{
        key: ManagementPanelKey
        label: string
        disabled?: boolean
      }>,
    [],
  )

  return (
    <View>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setExpanded(!expanded)}
        style={styles.sectionHeader}
      >
        <Text style={styles.sectionTitle}>Management Panel</Text>
        <Image
          source={expanded ? ICONS.arrowdown : ICONS.smallArrowLeft}
          style={styles.chevron}
          resizeMode="contain"
        />
      </TouchableOpacity>

      {expanded ? (
        <View style={styles.list}>
          {items.map((item) => {
            const selected = item.key === active
            const disabled = !!item.disabled
            return (
              <TouchableOpacity
                key={item.key}
                activeOpacity={0.8}
                disabled={disabled}
                onPress={() => {
                  if (disabled) return
                  onSelect(item.key)
                }}
                style={[
                  styles.row,
                  selected && styles.rowSelected,
                  disabled && styles.rowDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.rowText,
                    selected && styles.rowTextSelected,
                    disabled && styles.rowTextDisabled,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111',
  },
  chevron: {
    width: 18,
    height: 18,
    tintColor: '#111',
  },
  list: {
    backgroundColor: 'transparent',
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 0,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: 'transparent',
  },
  rowSelected: {
    backgroundColor: 'transparent',
  },
  rowDisabled: {
    opacity: 0.45,
  },
  rowText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
  },
  rowTextSelected: {
    color: '#111',
    textDecorationLine: 'underline',
  },
  rowTextDisabled: {
    color: '#111',
  },
})
