import AppleSignInButton from "@/components/social-auth-buttons/apple/expo-apple-sign-in-button";
import GoogleSignInButton from "@/components/social-auth-buttons/google/google-sign-in-button";
import { ICONS } from "@/constants/icons";
import { supabase } from "@/lib/supabase";
import { Link, Stack, router } from "expo-router";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

// Restored unified login: identifier can be email OR username, resolves to email then authenticates.
export default function LoginScreen() {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [identifier, setIdentifier] = useState(""); // email or username
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const looksLikeEmail = (v: string) => /^[^@]+@[^@]+\.[^@]+$/.test(v);

  // Resolve identifier to email. If already email, return normalized. If username, lookup userlogin -> userinfo.
  const resolveEmailFromIdentifier = async (value: string): Promise<string | null> => {
    const id = value.trim();
    if (!id) return null;
    if (looksLikeEmail(id)) return id.toLowerCase();
    const { data: loginRow, error: loginErr } = await supabase
      .from('userlogin')
      .select('loginid, userid, username')
      .ilike('username', id)
      .maybeSingle(); // avoid throwing on 0 matches
    if (loginErr || !loginRow) return null;
  const userid: number = (loginRow as any).userid;
    const { data: infoRow, error: infoErr } = await supabase
      .from('userinfo')
      .select('email')
      .eq('userid', userid)
      .maybeSingle();
    if (infoErr || !infoRow?.email) return null;
  const email = (infoRow as any).email?.toLowerCase();
  return email || null;
  };

  // Check if an email exists locally (in userinfo) to differentiate not found vs wrong password
  const emailExistsLocally = async (email: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('userinfo')
      .select('userid')
      .ilike('email', email)
      .maybeSingle();
    if (error) return false;
    return !!data;
  };

  // Simplified classification: remove any explicit email confirmation messaging per design.
  const classifyAuthError = (raw: string, wasUsername: boolean) => {
    if (/rate limit/i.test(raw)) return 'Too many attempts. Please wait and try again.';
    if (/invalid login credentials/i.test(raw)) {
      return wasUsername ? 'Incorrect password for that username.' : 'Incorrect password.';
    }
    if (/user not found/i.test(raw)) return 'Account not found.';
    // Suppress 'email not confirmed' specifics intentionally.
    return 'Login failed.';
  };

  const handleLogin = async () => {
    setErrorMsg(null);
    // Clear previous state
    if (!identifier.trim() || !password) {
      setErrorMsg('Enter identifier and password.');
      return;
    }
    setLoading(true);
    try {
      const isUsername = !looksLikeEmail(identifier.trim());
      const email = await resolveEmailFromIdentifier(identifier);
      if (!email) {
        setErrorMsg('Account not found.');
        return;
      }
      // If we resolved via username we already proved existence; avoid second query that can fail and misclassify
      let localEmailExists = true;
      if (!isUsername) {
        // Only check existence again when identifier is an email (to distinguish wrong password vs not found)
        localEmailExists = await emailExistsLocally(email);
      }
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Treat all unconfirmed email cases as generic incorrect password
        if (/email not confirmed/i.test(error.message)) {
          setErrorMsg(isUsername ? 'Incorrect password for that username.' : 'Incorrect password.');
          return;
        }
        if (/invalid login credentials/i.test(error.message)) {
          // refine invalid credentials based on local existence
          if (localEmailExists) {
            setErrorMsg(isUsername ? 'Incorrect password for that username.' : 'Incorrect password.');
          } else {
            setErrorMsg('Account not found.');
          }
        } else {
          setErrorMsg(classifyAuthError(error.message, isUsername));
        }
        return;
      }
      if (!data?.user) {
        setErrorMsg('No user returned.');
        return;
      }
      setPassword('');
      router.replace('/(tabs)/Home');
    } catch (e: any) {
      setErrorMsg('Unexpected error.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.logoWrapper}>
          <Image source={ICONS.app_icon} style={styles.logo} />
          <Text style={styles.appTitle}>SportConnect</Text>
        </View>

        <View style={styles.formWrapper}>
          <Text style={styles.formTitle}>Login</Text>

          <TextInput
            placeholder="Email or Username"
            placeholderTextColor={COLORS.dark300}
            value={identifier}
            onChangeText={(t) => { setIdentifier(t); if (errorMsg) setErrorMsg(null); }}
            autoCapitalize="none"
            style={styles.input}
          />

          <View style={styles.passwordRow}>
            <TextInput
              placeholder="Password"
              placeholderTextColor="#6A6B6B"
              secureTextEntry={!passwordVisible}
              value={password}
              onChangeText={setPassword}
              style={styles.passwordInput}
            />
            <Pressable onPress={() => setPasswordVisible(!passwordVisible)}>
              <Image source={passwordVisible ? ICONS.notEye : ICONS.eye} style={styles.eyeIcon} />
            </Pressable>
          </View>

          <View style={styles.optionsRow}>
            <Pressable onPress={() => setRememberMe(!rememberMe)} style={styles.rememberMePressable}>
              <View style={[styles.checkboxBase, rememberMe && styles.checkboxChecked]}>
                {rememberMe && (<Image source={ICONS.checkSmall} style={styles.checkboxTick} />)}
              </View>
              <Text style={styles.textDark}>Remember me</Text>
            </Pressable>
            <Pressable>
              <Text style={styles.forgotPassword}>Forgot Password ?</Text>
            </Pressable>
          </View>

          {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

          <TouchableOpacity disabled={loading} onPress={handleLogin} style={[styles.loginButton, loading && { opacity: 0.7 }]}>
            <Text style={styles.loginButtonText}>{loading ? 'Signing in...' : 'Login'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, styles.mr3]} />
          <Text style={styles.dividerText}>Or Login with</Text>
          <View style={[styles.dividerLine, styles.ml3]} />
        </View>

        <View style={styles.socialRow}>
          <GoogleSignInButton />
          <AppleSignInButton />
        </View>

        <TouchableOpacity onPress={async () => {
          const { error } = await supabase.auth.signInAnonymously();
          if (!error) router.replace('/(tabs)/Home');
        }}>
          <Text style={styles.quickAccessText}>Quick Access to Home</Text>
        </TouchableOpacity>

        <View style={styles.signupRow}>
          <Text style={styles.textDark}>Don't have an account?</Text>
          <Link href="/(auth)/signup"><Text style={styles.signUpLink}>Sign up</Text></Link>
        </View>
      </View>
    </>
  );
}

// Color tokens derived from Tailwind + custom config
const COLORS = {
  dark300: '#6A6B6B',
  green700: '#15803d',
  green800: '#166534',
  white: '#ffffff',
  blue600: '#2563eb',
  red600: '#dc2626',
  bg: '#f8f8f8'
};

// Spacing scale: Tailwind unit *4 => px
// shadow-md approximation for RN
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 28, // px-7
    paddingTop: 80, // pt-20
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 32, // mb-8
  },
  logo: { width: 80, height: 80 }, // w-20 h-20
  appTitle: {
    fontSize: 36, // text-4xl
    fontWeight: '800', // font-extrabold
    color: COLORS.green700, // text-green-700
    marginTop: 8, // mt-2
    letterSpacing: 0.5, // tracking-wide (approx)
  },
  formWrapper: {},
  formTitle: {
    fontSize: 30, // text-3xl (~30)
    fontWeight: '700', // font-bold
    color: COLORS.dark300,
    marginBottom: 24, // mb-6
    textAlign: 'center',
  },
  input: {
    width: '100%',
    backgroundColor: COLORS.white,
    borderRadius: 12, // rounded-xl
    paddingVertical: 12, // py-3
    paddingHorizontal: 16, // px-4
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginBottom: 16, // mb-4
    color: COLORS.dark300,
  },
  passwordRow: {
    width: '100%',
    marginBottom: 20, // mb-5
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.dark300,
    paddingRight: 12, // pr-3
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12, // py-3
    paddingHorizontal: 16, // px-4
    color: COLORS.dark300,
  },
  eyeIcon: { width: 24, height: 24, tintColor: COLORS.dark300 }, // w-6 h-6 tint-dark-300
  optionsRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32, // mb-8
  },
  rememberMePressable: { flexDirection: 'row', alignItems: 'center' },
  checkboxBase: {
    width: 20,
    height: 20,
    borderRadius: 6, // rounded-md
    borderWidth: 1,
    borderColor: COLORS.dark300,
    marginRight: 8, // mr-2
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: COLORS.green700,
    borderColor: COLORS.green700,
  },
  checkboxTick: { width: 20, height: 20, tintColor: COLORS.white }, // w-5 h-5 tint-white
  textDark: { color: COLORS.dark300 },
  forgotPassword: { color: COLORS.green700, fontWeight: '600' }, // font-semibold
  loginButton: {
    backgroundColor: COLORS.green700,
    width: '100%',
    paddingVertical: 12,
    borderRadius: 12,
    // shadow-md approximation
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 4,
  },
  loginButtonText: {
    color: COLORS.white,
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 18, // text-lg
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginTop: 32, // mt-8
    marginBottom: 12, // mb-3
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.dark300, opacity: 0.3 },
  dividerText: { color: COLORS.dark300, fontSize: 14 }, // text-sm
  mr3: { marginRight: 12 },
  ml3: { marginLeft: 12 },
  socialRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    marginBottom: 32, // mb-8
    // gap-3 simulated via children adding marginRight if needed (handled in button components if required)
  },
  quickAccessText: {
    textDecorationLine: 'underline',
    color: COLORS.blue600,
    fontSize: 16, // text-base
    marginBottom: 20, // mb-5
    textAlign: 'center',
  },
  signupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 4, // gap-1 (RN may ignore; optional)
    marginBottom: 40, // mb-10
  },
  signUpLink: {
    color: COLORS.green700,
    fontWeight: '700', // font-bold
  },
  errorText: {
    color: COLORS.red600,
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
  },
  // Removed debug/raw error styles
});

