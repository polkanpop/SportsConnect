import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import '../global.css';

  // Simple signup form (demo). NOTE: Storing plain passwords is NOT secure.
  // For production, add hashing again (bcrypt/argon2) and stronger validation.

        const SignUpScreen = () => {
          const [accountName, setAccountName] = useState('');
          const [email, setEmail] = useState('');
          const [password, setPassword] = useState('');
          const [confirmPassword, setConfirmPassword] = useState('');
          const [passwordVisible, setPasswordVisible] = useState(false);
          const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
          const [agree, setAgree] = useState(false);
          const [loading, setLoading] = useState(false);
          const [fieldErrors, setFieldErrors] = useState<{accountName?: string; email?: string; password?: string; confirmPassword?: string; agree?: string}>({});
          const [generalError, setGeneralError] = useState('');
          const [successMessage, setSuccessMessage] = useState('');

          const validate = () => {
            const errs: typeof fieldErrors = {};
            if (!accountName.trim()) errs.accountName = 'Account name is required.';
            if (!email.trim()) errs.email = 'Email is required.';
            else if (!email.toLowerCase().includes('@gmail.com')) errs.email = 'Email must contain @gmail.com';
            if (password.length < 6) errs.password = 'Minimum 6 characters.';
            if (password !== confirmPassword) errs.confirmPassword = 'Passwords do not match.';
            if (!agree) errs.agree = 'Please accept Terms.';
            setFieldErrors(errs);
            setGeneralError('');
            setSuccessMessage('');
            return Object.keys(errs).length === 0;
          };

          const handleSignUp = async () => {
            if (!validate()) return;
            setLoading(true);
            try {
              const { error, data } = await supabase.auth.signUp({
                email,
                password,
              });
              if (error) {
                setGeneralError(error.message);
                return;
              }
              // If no session (email confirmation may be required), attempt direct sign-in to obtain session
              let authUserId = data.user?.id;
              if (!data.session) {
                const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
                if (signInError) {
                  // Still proceed with insert (will use anon role if grants allow) but warn user
                  setGeneralError(prev => prev || 'Signed up but no active session (email may need verification or missing grants).');
                } else {
                  authUserId = signInData.user?.id;
                }
              }
              // WARNING: Plain password stored for demo only.
              const passwordHash = password; // DO NOT USE IN PRODUCTION
              // Insert into usersignup table (userid auto-increments; do not pass it)
              const { data: signupRow, error: usersignupError } = await supabase
                .from('usersignup')
                .insert({
                  account_name: accountName,
                  username: accountName,
                  passwordhash: passwordHash,
                  signuptype: 'email'
                })
                .select()
                .single();
              if (usersignupError) {
                if (/permission denied/i.test(usersignupError.message)) {
                  setGeneralError('Permission denied for usersignup. Run GRANT statements or disable RLS.');
                } else {
                  setGeneralError(usersignupError.message);
                }
              } else if (signupRow) {
                setSuccessMessage('Account created successfully.');
              }
              // Clear form
              setPassword('');
              setConfirmPassword('');
            } catch (err: any) {
              setGeneralError(err.message || 'Unknown error');
            } finally {
              setLoading(false);
            }
          };

          return (
            <SafeAreaView style={{ flex: 1 }}>
              <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <View className="flex-1 bg-[#f8f8f8] px-7 pt-14">
                  <View className="items-center mb-6">
                    <Text className="text-3xl font-extrabold text-green-700 tracking-wide">Sign Up</Text>
                  </View>

                  <View>
                    {generalError ? <Text className="text-red-600 text-center mb-3 text-sm">{generalError}</Text> : null}
                    {successMessage ? <Text className="text-green-700 text-center mb-3 text-sm">{successMessage}</Text> : null}
                    <Text className="text-sm text-center mb-6 text-green-700">Create your account</Text>

                    {/* Account Name */}
                    <TextInput
                      placeholder="Account Name"
                      placeholderTextColor="#6A6B6B"
                      value={accountName}
                      onChangeText={t => { setAccountName(t); if (fieldErrors.accountName) setFieldErrors({...fieldErrors, accountName: undefined}); }}
                      autoCapitalize="words"
                      className="w-full bg-white rounded-xl py-3 px-4 border border-dark-300 mb-2 text-dark-300"
                    />
                    {fieldErrors.accountName && <Text className="text-red-600 text-xs mb-2">{fieldErrors.accountName}</Text>}
                    {/* Email */}
                    <TextInput
                      placeholder="Email"
                      placeholderTextColor="#6A6B6B"
                      value={email}
                      onChangeText={t => { setEmail(t); if (fieldErrors.email) setFieldErrors({...fieldErrors, email: undefined}); }}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      className="w-full bg-white rounded-xl py-3 px-4 border border-dark-300 mb-2 text-dark-300"
                    />
                    {fieldErrors.email && <Text className="text-red-600 text-xs mb-2">{fieldErrors.email}</Text>}
                    {/* Password */}
                    <View className="w-full mb-2 flex-row items-center bg-white rounded-xl border border-dark-300 pr-3">
                      <TextInput
                        placeholder="Password"
                        placeholderTextColor="#6A6B6B"
                        secureTextEntry={!passwordVisible}
                        value={password}
                        onChangeText={t => { setPassword(t); if (fieldErrors.password) setFieldErrors({...fieldErrors, password: undefined}); }}
                        className="flex-1 py-3 px-4 text-dark-300"
                      />
                      <Pressable onPress={() => setPasswordVisible(p => !p)} className="px-2">
                        <Text className="text-green-700 font-semibold text-xs">{passwordVisible ? 'Hide' : 'Show'}</Text>
                      </Pressable>
                    </View>
                    {fieldErrors.password && <Text className="text-red-600 text-xs mb-2">{fieldErrors.password}</Text>}
                    {/* Confirm Password */}
                    <View className="w-full mb-3 flex-row items-center bg-white rounded-xl border border-dark-300 pr-3">
                      <TextInput
                        placeholder="Confirm Password"
                        placeholderTextColor="#6A6B6B"
                        secureTextEntry={!confirmPasswordVisible}
                        value={confirmPassword}
                        onChangeText={t => { setConfirmPassword(t); if (fieldErrors.confirmPassword) setFieldErrors({...fieldErrors, confirmPassword: undefined}); }}
                        className="flex-1 py-3 px-4 text-dark-300"
                      />
                      <Pressable onPress={() => setConfirmPasswordVisible(p => !p)} className="px-2">
                        <Text className="text-green-700 font-semibold text-xs">{confirmPasswordVisible ? 'Hide' : 'Show'}</Text>
                      </Pressable>
                    </View>
                    {fieldErrors.confirmPassword && <Text className="text-red-600 text-xs mb-2">{fieldErrors.confirmPassword}</Text>}

                    {/* Terms Checkbox */}
                    <Pressable onPress={() => { setAgree(a => !a); if (fieldErrors.agree) setFieldErrors({...fieldErrors, agree: undefined}); }} className="flex-row items-center mb-4">
                      <View className={`w-5 h-5 rounded-md border mr-2 justify-center items-center ${agree ? 'bg-green-700 border-green-700' : 'border-dark-300'}`}>          
                        {agree && <Text className="text-white text-xs font-bold">✓</Text>}
                      </View>
                      <Text className="text-dark-300">I agree with Terms of Service</Text>
                    </Pressable>
                    {fieldErrors.agree && <Text className="text-red-600 text-xs mb-4">{fieldErrors.agree}</Text>}

                    {/* Submit Button */}
                    <TouchableOpacity
                      onPress={handleSignUp}
                      disabled={loading}
                      className={`w-full py-3 rounded-xl shadow-md ${loading ? 'bg-green-800' : 'bg-green-700'}`}
                    >
                      {loading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text className="text-white text-center font-semibold text-lg">Sign Up</Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Footer */}
                  <View className="flex-row gap-1 mt-10 justify-center">
                    <Text className="text-dark-300">Already have an account?</Text>
                    <Pressable onPress={() => {/* navigate to login route here */}}>
                      <Text className="text-green-700 font-bold">Sign in</Text>
                    </Pressable>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </SafeAreaView>
          );
        };

        export default SignUpScreen;