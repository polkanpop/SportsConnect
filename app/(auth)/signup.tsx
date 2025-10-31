        import React, { useState } from 'react';
import { Alert, Button, TextInput, View } from 'react-native';
import { supabase } from '../../lib/supabase';

        const SignUpScreen = () => {
          const [email, setEmail] = useState('');
          const [password, setPassword] = useState('');
          const [loading, setLoading] = useState(false);

          const handleSignUp = async () => {
            setLoading(true);
            const { error, data } = await supabase.auth.signUp({
              email,
              password,
            });

            if (error) {
              Alert.alert('Sign Up Error', error.message);
            } else if (data.user && data.session) {
              Alert.alert('Success', 'User signed up and logged in!');
              // Navigate to authenticated part of the app
            } else {
              Alert.alert('Success', 'Check your email for a confirmation link to complete sign up.');
              // User needs to confirm email before session is created
            }
            setLoading(false);
          };

          return (
            <View>
              <TextInput
                placeholder="Email"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <TextInput
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
              />
              <Button title={loading ? 'Loading...' : 'Sign Up'} onPress={handleSignUp} disabled={loading} />
            </View>
          );
        };

        export default SignUpScreen;