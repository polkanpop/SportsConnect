import { ICONS } from '@/constants/icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';

  // Simple signup form (demo). NOTE: Storing plain passwords is NOT secure.
  // For production, add hashing again (bcrypt/argon2) and stronger validation.

        const SignUpScreen = () => {
          const [accountName, setAccountName] = useState(''); // display name shown publicly
          const [username, setUsername] = useState(''); // unique login handle stored in userlogin.username
          const [email, setEmail] = useState('');
          const [password, setPassword] = useState('');
          const [confirmPassword, setConfirmPassword] = useState('');
          const [passwordVisible, setPasswordVisible] = useState(false);
          const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
          const [agree, setAgree] = useState(false);
          const [loading, setLoading] = useState(false);
          const [fieldErrors, setFieldErrors] = useState<{accountName?: string; username?: string; email?: string; password?: string; confirmPassword?: string; agree?: string}>({});
          const [generalError, setGeneralError] = useState('');
          const [successMessage, setSuccessMessage] = useState('');

          const validate = () => {
            const errs: typeof fieldErrors = {};
            if (!accountName.trim()) errs.accountName = 'Display name is required.';
            if (!username.trim()) errs.username = 'Username is required.';
            else {
              const uname = username.trim();
              if (uname.length < 3) errs.username = 'Min 3 characters.';
              else if (uname.length > 32) errs.username = 'Max 32 characters.';
              else if (!/^[a-zA-Z0-9_]+$/.test(uname)) errs.username = 'Only letters, numbers, underscore.';
            }
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
              // 1. Create auth user (Supabase Auth)
              const { error: authError, data: authData } = await supabase.auth.signUp({ email, password });
              if (authError) {
                setGeneralError(authError.message);
                return;
              }


              // 2. Ensure we have a session (optional convenience)
              let authUserId = authData.user?.id;
              if (!authData.session) {
                const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
                if (!signInErr) authUserId = signInData.user?.id;
              }

              // WARNING: Demo only – plain password stored. Replace with server-side hashing.
              const passwordHash = password;

              // 3. Insert profile row into userinfo (use infoid as canonical key)
              // NEW FLOW: Because schema has users.userid as FK target for both userinfo.userid and userlogin.userid,
              // we must first create a row in users to obtain a userid. The users table requires a role (enum); we assume 'player'.
              // If this value is invalid, fetch allowed roles via: SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='role';
              const { data: usersRow, error: usersErr } = await supabase
                .from('users')
                .insert({ role: 'player' })
                .select()
                .single();
              if (usersErr) {
                const msg = usersErr.message || '';
                if (/permission denied/i.test(msg)) {
                  setGeneralError('Permission denied inserting users. Check table grants/RLS and sequence users_userid_seq privileges.');
                } else if (/invalid input value for enum/i.test(msg)) {
                  setGeneralError('Invalid role enum value. Query allowed roles and adjust signup default.');
                } else if (/duplicate key value violates unique constraint.*users_pkey/i.test(msg)) {
                  setGeneralError('Duplicate key on users.userid. Admin must realign sequence: SELECT setval(\'public.users_userid_seq\',(SELECT max(userid) FROM public.users)+1,false);');
                } else {
                  setGeneralError(msg);
                }
                return;
              }

              const userId = (usersRow as any)?.userid;
              if (!userId) {
                setGeneralError('Failed to retrieve userid from users insert. Verify users table sequence/default.');
                return;
              }

              // Insert profile row into userinfo referencing users.userid
              const { data: userInfoRow, error: userInfoErr } = await supabase
                .from('userinfo')
                .insert({
                  userid: userId,
                  name: accountName,
                  email: email,
                })
                .select()
                .single();
              if (userInfoErr) {
                // Distinguish sequence privilege issue vs generic table issue
                const msg = userInfoErr.message || '';
                if (/permission denied.*userinfo_infoid_seq/i.test(msg) || /sequence.*permission denied/i.test(msg)) {
                  setGeneralError('Permission denied on sequence userinfo_infoid_seq. Run: GRANT USAGE, SELECT ON SEQUENCE public.userinfo_infoid_seq TO anon, authenticated;');
                } else if (/permission denied/i.test(msg)) {
                  setGeneralError('Permission denied inserting userinfo. Ensure table grants + sequence grants + RLS disabled or policy added.');
                } else {
                  setGeneralError(msg);
                }
                return;
              }

              const infoId = (userInfoRow as any)?.infoid; // retained if needed for future features
              if (!infoId) {
                setGeneralError('userinfo insert returned no infoid. Verify PK/sequence configuration.');
                return;
              }

              // 4. Insert credentials/login referencing userinfo.infoid
              // userlogin.userid must reference users.userid, not userinfo.infoid per schema
              const { error: userLoginErr } = await supabase
                .from('userlogin')
                .insert({
                  userid: userId,
                  username: username.trim(),
                  passwordhash: passwordHash,
                  logintype: 'Local', // matches schema default
                });
              if (userLoginErr) {
                const loginMsg = userLoginErr.message || '';
                if (/permission denied.*userlogin_loginid_seq/i.test(loginMsg) || /sequence.*permission denied/i.test(loginMsg)) {
                  setGeneralError('Permission denied on sequence userlogin_loginid_seq. Run: GRANT USAGE, SELECT ON SEQUENCE public.userlogin_loginid_seq TO anon, authenticated;');
                } else if (/permission denied/i.test(loginMsg)) {
                  setGeneralError('Permission denied inserting userlogin. Ensure table + sequence grants and RLS policies.');
                } else if (/duplicate key value violates unique constraint.*userlogin_username_key/i.test(loginMsg)) {
                  setGeneralError('Username already taken. Choose another.');
                } else if (/foreign key/i.test(loginMsg)) {
                  setGeneralError('Foreign key error: userlogin.userid must reference userinfo.infoid.');
                } else {
                  setGeneralError(loginMsg);
                }
                return;
              }

              // 5. Success
              setSuccessMessage('Account created successfully. Redirecting to sign in…');
              setPassword('');
              setConfirmPassword('');
              // Delay briefly to show success message then navigate to login
              setTimeout(() => {
                router.replace('/(auth)/login');
              }, 900);
            } catch (err: any) {
              setGeneralError(err.message || 'Unknown error');
            } finally {
              setLoading(false);
            }
          };

          return (
            <SafeAreaView style={{ flex: 1 }}>
              <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <View style={styles.container}>
                  <View style={styles.headerWrapper}>
                    <Text style={styles.screenTitle}>Sign Up</Text>
                  </View>
                  <View style={styles.formWrapper}>
                    {generalError ? <Text style={styles.feedbackError}>{generalError}</Text> : null}
                    {successMessage ? <Text style={styles.feedbackSuccess}>{successMessage}</Text> : null}
                    {/* Debug info removed */}
                    <Text style={styles.subtitle}>Create your account</Text>

                    {/* Account Name */}
                    <TextInput
                      placeholder="Account Name"
                      placeholderTextColor={COLOR.dark300}
                      value={accountName}
                      onChangeText={t => { setAccountName(t); if (fieldErrors.accountName) setFieldErrors({...fieldErrors, accountName: undefined}); }}
                      autoCapitalize="words"
                      style={styles.input}
                    />
                    {fieldErrors.accountName && <Text style={styles.fieldError}>{fieldErrors.accountName}</Text>}

                    {/* Username (login handle) */}
                    <TextInput
                      placeholder="Username"
                      placeholderTextColor={COLOR.dark300}
                      value={username}
                      onChangeText={t => { setUsername(t); if (fieldErrors.username) setFieldErrors({...fieldErrors, username: undefined}); }}
                      autoCapitalize="none"
                      style={styles.input}
                    />
                    {fieldErrors.username && <Text style={styles.fieldError}>{fieldErrors.username}</Text>}

                    {/* Email */}
                    <TextInput
                      placeholder="Email"
                      placeholderTextColor={COLOR.dark300}
                      value={email}
                      onChangeText={t => { setEmail(t); if (fieldErrors.email) setFieldErrors({...fieldErrors, email: undefined}); }}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      style={styles.input}
                    />
                    {fieldErrors.email && <Text style={styles.fieldError}>{fieldErrors.email}</Text>}

                    {/* Password */}
                    <View style={styles.passwordRow}>
                      <TextInput
                        placeholder="Password"
                        placeholderTextColor={COLOR.dark300}
                        secureTextEntry={!passwordVisible}
                        value={password}
                        onChangeText={t => { setPassword(t); if (fieldErrors.password) setFieldErrors({...fieldErrors, password: undefined}); }}
                        style={styles.passwordInput}
                      />
                      <Pressable onPress={() => setPasswordVisible(p => !p)}>
                        <Image source={passwordVisible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
                      </Pressable>
                    </View>
                    {fieldErrors.password && <Text style={styles.fieldError}>{fieldErrors.password}</Text>}

                    {/* Confirm Password */}
                    <View style={styles.passwordRowConfirm}>
                      <TextInput
                        placeholder="Confirm Password"
                        placeholderTextColor={COLOR.dark300}
                        secureTextEntry={!confirmPasswordVisible}
                        value={confirmPassword}
                        onChangeText={t => { setConfirmPassword(t); if (fieldErrors.confirmPassword) setFieldErrors({...fieldErrors, confirmPassword: undefined}); }}
                        style={styles.passwordInput}
                      />
                      <Pressable onPress={() => setConfirmPasswordVisible(p => !p)}>
                        <Image source={confirmPasswordVisible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
                      </Pressable>
                    </View>
                    {fieldErrors.confirmPassword && <Text style={styles.fieldError}>{fieldErrors.confirmPassword}</Text>}

                    {/* Terms Checkbox */}
                    <Pressable
                      onPress={() => { setAgree(a => !a); if (fieldErrors.agree) setFieldErrors({...fieldErrors, agree: undefined}); }}
                      style={styles.checkboxRow}
                    >
                      <View style={[styles.checkboxBase, agree && styles.checkboxChecked]}>
                        {agree && <Image source={ICONS.checkSmall} style={styles.checkboxTick} />}
                      </View>
                      <Text style={styles.textDark}>
                        I agree with <Text onPress={() => {}} style={styles.termsLink}>Terms of Service</Text>
                      </Text>
                    </Pressable>
                    {fieldErrors.agree && <Text style={styles.fieldErrorBottom}>{fieldErrors.agree}</Text>}

                    {/* Submit Button */}
                    <TouchableOpacity
                      onPress={handleSignUp}
                      disabled={loading}
                      style={[styles.submitButton, loading && styles.submitButtonLoading]}
                    >
                      {loading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.submitButtonText}>Sign Up</Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Footer */}
                  <View style={styles.footerRow}>
                    <Text style={styles.textDark}>Already have an account?</Text>
                    <Pressable onPress={() => router.replace('/(auth)/login')}>
                      <Text style={styles.footerLink}>Sign in</Text>
                    </Pressable>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </SafeAreaView>
          );
        };

        export default SignUpScreen;

// Shared color tokens (matching login.tsx local definition)
const COLOR = {
  dark300: '#6A6B6B',
  green700: '#15803d',
  green800: '#166534',
  white: '#ffffff',
  red600: '#dc2626',
  bg: '#f8f8f8'
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLOR.bg,
    paddingHorizontal: 28, // px-7
    paddingTop: 80, // unify with login (pt-20)
  },
  headerWrapper: {
    alignItems: 'center',
    marginBottom: 24, // mb-6
  },
  screenTitle: {
    fontSize: 30, // text-3xl
    fontWeight: '800', // font-extrabold
    color: COLOR.green700,
    letterSpacing: 0.5, // tracking-wide approx
  },
  formWrapper: {},
  feedbackError: {
    color: COLOR.red600,
    textAlign: 'center',
    marginBottom: 12, // mb-3
    fontSize: 14, // text-sm
  },
  feedbackSuccess: {
    color: COLOR.green700,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 32, // increased spacing below subtitle (was mb-6 -> now mb-8)
    color: COLOR.green700,
  },
  input: {
    width: '100%',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLOR.dark300,
    marginBottom: 8, // mb-2
    color: COLOR.dark300,
  },
  fieldError: {
    color: COLOR.red600,
    fontSize: 12, // text-xs
    marginBottom: 8, // mb-2
  },
  passwordRow: {
    width: '100%',
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLOR.dark300,
    paddingRight: 12, // pr-3
  },
  passwordRowConfirm: {
    width: '100%',
    marginBottom: 12, // mb-3
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLOR.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLOR.dark300,
    paddingRight: 12,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    color: COLOR.dark300,
  },
  eyeIcon: { width: 24, height: 24, tintColor: COLOR.dark300 },
  fieldErrorBottom: {
    color: COLOR.red600,
    fontSize: 12,
    marginBottom: 8, // mb-2 (for agree differs slightly after checkbox)
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16, // mb-4
  },
  checkboxBase: {
    width: 20,
    height: 20,
    borderRadius: 6, // rounded-md
    borderWidth: 1,
    borderColor: COLOR.dark300,
    marginRight: 8, // mr-2
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: COLOR.green700,
    borderColor: COLOR.green700,
  },
  checkboxTick: {
    width: 20,
    height: 20,
    tintColor: COLOR.white, // icon tint
  },
  textDark: { color: COLOR.dark300 },
  submitButton: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLOR.green700,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 4,
    marginTop: 4,
  },
  submitButtonLoading: { backgroundColor: COLOR.green800 },
  submitButtonText: {
    color: COLOR.white,
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 18,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40, // mt-10
    columnGap: 4, // gap-1 (RN experimental)
  },
  footerLink: {
    color: COLOR.green700,
    fontWeight: '700',
    marginLeft: 4,
  },
  termsLink: {
    color: COLOR.green700,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});