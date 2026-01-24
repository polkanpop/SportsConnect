import { StyleSheet, Text, View, Image, TouchableOpacity } from 'react-native';
import React, { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ICONS } from '../../constants/icons';

const CreationInfo = () => {
  const router = useRouter();
  const { type, detailsId } = useLocalSearchParams<{ type: string; detailsId?: string }>();

  const title = type === 'event' ? 'Event Created Successfully !' : 'Session Created Successfully !';

  const handleBackToHome = () => {
    router.replace('/(tabs)/Home');
  };

  const handleSeeDetails = () => {
    const id = typeof detailsId === 'string' ? detailsId : ''
    if (!id) return
    router.replace({ pathname: '/event/details', params: { id } })
  }

  return (
    <View style={styles.container}>
      <Image source={ICONS.createSuccessful} style={styles.icon} />
      <Text style={styles.title}>{title}</Text>

      {detailsId ? (
        <TouchableOpacity style={styles.detailsButton} onPress={handleSeeDetails}>
          <Text style={styles.detailsButtonText}>See details</Text>
        </TouchableOpacity>
      ) : null}

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
    width: '80%',
    maxWidth: 360,
    alignItems: 'center',
  },
  detailsButton: {
    backgroundColor: '#fff',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: '#222',
    marginTop: 18,
    marginBottom: 12,
    width: '80%',
    maxWidth: 360,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  detailsButtonText: {
    color: '#222',
    fontSize: 18,
    fontWeight: 'bold',
  },
});