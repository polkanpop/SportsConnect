# Authentication & OAuth Configuration

## Auth Providers

### 1. Phone OTP (Firebase)
- **Service**: Firebase Authentication (Blaze plan)
- **Project**: sportconnect-c34b9
- **3 Apps**: Android (`com.group5.sportconnect`), iOS, Web
- **Test Numbers**: +84 388 149 127 / +84 999 999 999 (code: 123456)
- **Flow**: Phone → Firebase OTP → Verify → Backend creates/fetches user → Supabase session

### 2. Google Sign-In
- **Service**: Google Cloud Console OAuth 2.0
- **Android Client ID**: Configured in `app.json` → `android.googleServicesFile`
- **Flow**: Google popup → ID token → Backend verifies → Supabase session

### 3. Zalo OAuth
- **App ID**: 959402498466634174
- **Package**: com.group5.sportconnect
- **Callback**: `https://sportconnects.org/zalo-callback` (Cloudflare Worker)
- **Deep Link**: `sportconnect://zalo-code`
- **Flow**:
  1. Frontend generates PKCE (code_verifier + code_challenge)
  2. Opens Chrome Custom Tab → `oauth.zaloapp.com/v4/permission`
  3. Zalo redirects → Cloudflare Worker → `sportconnect://zalo-code?code=...`
  4. Frontend exchanges code for access_token via backend
  5. Backend fetches Zalo profile → creates/links Supabase user

### 4. Local (Email/Password)
- **Hash**: bcrypt + server-side pepper
- **Email Verification**: Mailtrap SMTP → `https://sportsconnect-ff00.onrender.com/api/auth/verify-email?token=...`
- **Password Reset**: Same domain, deep link redirect `sportconnect://newpassword`

## Token Management
- **Access Token**: Short-lived JWT in memory
- **Refresh Token**: Stored in `user_tokens` table with device fingerprint + expiry
- **Peppers**: `PASSWORD_PEPPER`, `REFRESH_TOKEN_PEPPER` in Render env

## Zalo CCT Overlay (OPPO Fix)
When Chrome Custom Tab is active on OPPO/ColorOS devices, the Android OpenGL surface
gets destroyed (`setSurface: surface=NULL`). On return, surface recreation briefly fails
causing a black flash. The `ZaloAuthOverlayProvider` renders a white `Animated.View`
overlay with 600ms fade-out to mask this transition.

## Cloudflare Worker (sportconnects.org)
Located at `cloudflare-worker/worker.js`:
- `/` → Landing page HTML
- `/privacy`, `/terms` → Legal pages
- `/zalo-callback?code=...&state=...` → Redirects to `sportconnect://zalo-code?code=...&state=...`
- `/zalo-proxy/me` → Proxies `graph.zalo.me/v2.0/me` with access_token
- `/icon.png` → SVG app icon
