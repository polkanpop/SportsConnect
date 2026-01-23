import { StyleSheet, Text, View, Image, TouchableOpacity } from 'react-native';
import React, { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ICONS } from '../../constants/icons';

const CreationInfo = () => {
  const router = useRouter();
  const { type } = useLocalSearchParams<{ type: string }>();

  const title = type === 'event' ? 'Event Created Successfully !' : 'Session Created Successfully !';

  const handleBackToHome = () => {
    router.replace('/(tabs)/Home');
  };

  return (
    <View style={styles.container}>
      <Image source={ICONS.createSuccessful} style={styles.icon} />
      <Text style={styles.title}>{title}</Text>
      <TouchableOpacity style={styles.button} onPress={handleBackToHome}>
        <Text style={styles.buttonText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  );
};

export default CreationInfo;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 20,
  },
  icon: {
    width: 120,
    height: 120,
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10,
    color: '#28a745',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#FF5733',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});