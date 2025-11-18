# SportsConnect

Cross-platform (Android / iOS / Web) sports companion built with Expo SDK 54, Expo Router, Supabase, and React Native.

## 1. System Requirements

| Tool | Recommended |
|------|-------------|
| Node | 18.x or 20.x LTS |
| npm  | 9+ (ships with Node) |
| Expo CLI | `npm i -g expo` (optional) |
| Android Studio / Xcode | For emulators/simulators |

## 2. First-Time Clone Setup (Windows PowerShell friendly)

```powershell
# Clone
git clone <repo-url> SportsConnect
cd SportsConnect

# (Optional) ensure there's no duplicate lowercase folder
Get-ChildItem .. | Select-String sportsconnect | Out-Null

# Clean any previous artifacts if re-cloning locally
Remove-Item -Force -Recurse node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue

# Install dependencies ( need --legacy-peer-deps very important !)
npm install --legacy-peer-deps 

# note : when you reinstall these you will see everything red ( errors) ignore it and just run the below command

# Run a cache-cleared start (tunnel optional)
npx expo start -c --tunnel
```

If you see a QR code, scan with Expo Go (physical device) or press `w`, `a`, `i` for web/Android/iOS.

## 3. Environment Variables

Use Expo public env vars in `.env` or shell: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, etc. Access via the helper `env.ts` (throws if missing).

Example (PowerShell):
```powershell
$env:EXPO_PUBLIC_SUPABASE_URL="https://xxxxx.supabase.co"
$env:EXPO_PUBLIC_SUPABASE_ANON_KEY="anon-key-here"
npx expo start -c --tunnel
```

## 4. Login / Signup Flow

Screens `app/(auth)/login.tsx` and `app/(auth)/signup.tsx` use pure `StyleSheet` (no Tailwind/NativeWind). If converting more screens, follow same pattern:
1. Replace `className="..."` blocks with `styles.*` objects.
2. Map Tailwind spacing: `1 -> 4px`, `2 -> 8px`, `3 -> 12px`, etc.
3. Colors from former Tailwind config: dark300 `#6A6B6B`, green700 `#15803d`.

### Remember Me (Persistent Backend Profile)

The login screen has a "Remember me" checkbox. When checked:
* After successful login, `@backendProfile` (basic user data) is stored AND a flag `@rememberAuth` is set to `true` in `AsyncStorage`.
* On app restart / reload, the AuthProvider reads `@rememberAuth` + `@backendProfile` and treats the user as logged in even without a Supabase session.
* Sign out removes both keys so the next launch returns to the login screen.

Security note: This is a minimal demo (no JWT/token). Do NOT ship storing plaintext credentials. Only profile + a boolean flag are persisted; endpoints are currently public.

To disable: remove references to `@rememberAuth` in `login.tsx` and `auth-providers.tsx`.

## Email Confirmation & SMTP Setup (Supabase)

1. Enable the **Confirm sign-up** flow inside Supabase Auth (`Auth -> Settings -> Email -> Templates`). The app now routes to `/(auth)/confirm-email`, so keep a template such as:

```html
<h2>Confirm your signup</h2>
<p>Follow this link to confirm your user:</p>
<p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>
```

2. Add the waiting page as a redirect target under `Auth -> Settings -> Redirect URLs` so the confirmation link returns to the app after the user clicks it. Examples for development:

```
http://localhost:19006/(auth)/confirm-email
https://your-web-host/(auth)/confirm-email
```

3. Under `Auth -> Settings -> Emails -> SMTP Settings`, toggle **Enable custom SMTP** and configure Resend as the provider (see the Resend SMTP tab in Supabase for guidance). Typical values:

| Field | Value |
| ----- | ----- |
| Sender email | `no-reply@sportsconnect.app` (or your domain) |
| Sender name | `SportConnect` |
| Host | `smtp.resend.com` |
| Port | `465` (TLS) or `587` |
| Username | `resend` |
| Password | your Resend API key |
| Minimum interval | `60` seconds |

4. Save the SMTP settings and confirm the test email appears in your inbox. The frontend stores the pending confirmation address (key `@pendingConfirmEmail`) and displays the new waiting screen until the user verifies that email.

## 5. Remaining NativeWind Usage

Some files still have `className` (e.g. `app/+not-found.tsx`). NativeWind remains enabled via `metro.config.js`. To fully remove it later:
```text
1. Replace className usages with StyleSheet.
2. Delete tailwind.config.js, global.css, nativewind-env.d.ts.
3. Remove withNativeWind wrapper from metro.config.js.
4. Remove 'nativewind' & 'tailwindcss' deps if no longer needed.
5. Drop "nativewind/types" from tsconfig.json types.
```

## 6. Useful Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Launch Expo dev server |
| `npm run reset-project` | (From template) Not used in customized state |
| `npm run lint` | Run Expo ESLint config |

## 7. Troubleshooting

| Issue | Fix |
|-------|-----|
| Stuck metro cache | `npx expo start -c` |
| Env vars not loading | Ensure `EXPO_PUBLIC_*` prefix |
| Babel `.plugins` error returns | Keep `babel.config.js` minimal: only `presets: ['babel-preset-expo']` |
| Styling missing on converted auth screens | Confirm you removed all `className` and applied `styles.*` |

## 8. Tech Stack

Expo SDK 54 · React 19 · React Native 0.81 · Expo Router · Supabase · Reanimated · NativeWind (partial) · TypeScript.

## 9. Contributing

1. Branch off `new_update`.
2. Run lint & manual login/signup checks before PR.
3. Keep dependencies pinned (no caret upgrades unless required).

## 10. License

Internal learning project (no explicit license provided).

---
Happy hacking! 🚀
