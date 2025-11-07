import { StyleSheet, Text, View } from 'react-native'
import React from 'react'
import { useLocalSearchParams } from 'expo-router'

const details = () => {
    const {id} = useLocalSearchParams();
  return (
    <View>
      <Text>event details: {id}</Text>
    </View>
  )
}

export default details;

const styles = StyleSheet.create({})