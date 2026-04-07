# SportConnect — Copilot Instructions

## What this project is
SportConnect (`sportconnects.org`) is a Vietnamese basketball court booking app.
Users can discover courts, book slots, create/join events and training sessions, and manage payments.
Live APK exists. Team repo: `polkanpop` (leader), `LeDucTri1484` (Tri).

---

## Stack

### Frontend
- **React Native** via **Expo SDK** + **EAS** (managed workflow)
- **TypeScript**, **NativeWind** (Tailwind for RN), **Expo Router** (file-based routing)
- State: no global store — strict top-down data loading bootstrapped at app root (`/api/me/dashboard`)
- Maps: **Goong Maps** (primary, Vietnamese tile service) + **Mapbox** (`@rnmapbox/maps`)
- i18n: custom `translations.ts` dictionary + `LanguageContext` provider, persisted in `AsyncStorage` key `'language'`, defaults to Vietnamese (`'vi'`)
- Push notifications: `expo-notifications` + FCM
- Voice booking: `expo-speech-recognition` (on-device STT) → backend LLM parse

### Backend
- **FastAPI** (Python 3.11) deployed on **Render** (`sportsconnect-ff00.onrender.com`)
- API prefix: `/api`
- Caching: **Redis** via Upstash (`rediss://`)
- Rate limiting: **SlowAPI**
- Email: **Mailtrap** SMTP (`noreply@sportconnects.org`)
- Voice: **Groq** — `whisper-large-v3-turbo` (STT) + `llama-3.1-8b-instant` (intent parsing)
- Image storage: **Cloudinary** (`dg0rerv5b`, folder `profile_pictures`)

### Database
- **Supabase** PostgreSQL (`pfhgiyujvxeartkomrpv.supabase.co`)
- 29 tables, PostGIS enabled
- RLS disabled on all tables except `userlogin` — security enforced at API layer
- Key extensions: PostGIS 3.3.7, pgcrypto, uuid-ossp

### Infrastructure
- **Cloudflare** DNS + page rules for `sportconnects.org`
- **Cloudflare Worker** for Zalo OAuth redirect handling
- Static pages (privacy, terms, Zalo domain verification) hosted on **Vercel** with Vercel Authentication disabled (required for Google/Zalo crawlers)

---

## Auth Architecture

Four providers, all tracked in `user_auth_providers` table (`provider` column: `Local`, `Google`, `Zalo`, `Phone`).

| Provider | How it works |
|---|---|
| Local | username + password, bcrypt + pepper |
| Google | OAuth via `expo-auth-session` PKCE, backend `/api/auth/google` |
| Zalo | Native SDK (`react-native-zalo-kit`) → **frontend** fetches profile (not backend) to avoid geo-blocking; backend `/api/auth/zalo` receives token + profile |
| Phone | Firebase Phone OTP (`verifyPhoneNumber` + `onVerificationStateChanged`), backend `/api/auth/verify-phone-otp` |

**Account merging**: user-initiated only via Settings → Link Accounts. Never automatic. Uses `merge_accounts` PostgreSQL stored procedure. Email/phone stays canonical — cannot be overridden once set.

**JWT**: access token (60 min) + refresh token. Stored on device, not in Supabase auth.

---

## Database Key Tables

```
users              — central user table, role: player/coach/organizer/courtowner
userinfo           — name, contactnumber (unique), email (unique), pfp
userlogin          — username, passwordhash, logintype
user_auth_providers — multi-provider auth (userid + provider + provider_uid)
unverified_users   — email nullable, phone columns added
user_tokens        — refresh tokens with device_fingerprint
user_devices       — push_token (unique), platform, token_type

courts             — location (geography), address, status enum
courtinfo          — name, description, cover_image
playingcourt       — bookable unit, part: full/half_a/half_b, allow_half_booking
courtavailability  — date + time slots
courtbooking       — duration_minutes (60-180), status: pending/approved/rejected/missed

events             — linked to courtbooking
trainingsessions   — linked to courtbooking
eventbooking / tsbookings / servicebooking
payments           — method: vnpay/cash
notifications      — category: court/event/training, data: jsonb
reviews + review_reactions
favouritecourts
```

**Key triggers**: `trg_set_courtbooking_duration` (auto-calc duration), `trg_review_reaction_counts`, `trg_reviews_eligibility`

---

## Routing (Expo Router)

```
app/
  (auth)/       login, signup, forgotpassword, newpassword, phone-otp, verified, waiting
  (tabs)/       Home, Map, Activity, Notification, Settings
  event/        courtBooking, courtList, courtPanel, courtRegister,
                eventBooking, eventCreate, eventList, eventPanel,
                trainingSessionPanel, tsBooking, tsCreate, tsList,
                accountSettings, history, invoice, profile, reviewForm, ...
  zalo-code.tsx  Zalo OAuth deep-link handler
```

---

## Conventions

- All new screen files go in `app/event/` unless they are tabs or auth flows
- No child-level duplicate network calls — bootstrap everything at root via `/api/me/dashboard`
- Favourites load first on Home screen, no skeleton for favourites
- Language strings: always add to `constants/translations.ts`, never hardcode Vietnamese/English in components
- Language labels: `"Tiếng Việt"` / `"English"` (not `"vi"` / `"en"` in UI)
- Translation coverage required: venue tags (indoor/outdoor), days of week (Hai/Ba/Tư...), activity tabs, all new UI text
- Images: always go through Cloudinary; use `imageOptimize.ts` helpers
- Push tokens registered via `/api/devices` on login, deregistered on logout
- Full-save release flow: `stage → commit → push → eas update`
- Backend env changes → redeploy on Render (no hot-reload)

---

## Environment Variables

### Frontend (`EXPO_PUBLIC_*`)
```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
EXPO_PUBLIC_API_BASE_URL        (prod: https://sportsconnect-ff00.onrender.com/api)
EXPO_PUBLIC_ZALO_APP_ID         (959402498466634174)
EXPO_PUBLIC_GOONG_MAPTILES_KEY
EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN
EXPO_PUBLIC_AUTO_EMAIL_LOGIN    (true/false)
```

### Backend (Render env)
```
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET
ZALO_APP_ID / ZALO_APP_SECRET
FIREBASE_SERVICE_ACCOUNT_JSON   (base64-encoded)
GROQ_API_KEY
CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET / CLOUDINARY_CLOUD_NAME
REDIS_URL / UPSTASH_REDIS_URL   (rediss:// for Upstash)
SMTP_HOST / SMTP_USERNAME / SMTP_PASSWORD
GOONG_DISTANCE_API_KEY / GOONG_GEO_API_KEY
PASSWORD_PEPPER / REFRESH_TOKEN_PEPPER
ACCESS_TOKEN_MINUTES            (60)
```

---

## Firebase Project
- Project ID: `sportconnect-c34b9`
- Used for: Phone OTP only
- OTP fix: use `verifyPhoneNumber` with `onVerificationStateChanged` (not `signInWithPhoneNumber`) to handle Android SMS Retriever API and avoid `auth/session-expired`
- Test phone numbers configured in Firebase console

---

## Known Quirks / Non-obvious Things

- Zalo geo-blocking: Zalo's token exchange API is blocked outside Vietnam in production. Fix: **frontend fetches the Zalo profile**, sends token + profile object to backend. Do not move profile fetch to backend.
- Zalo domain verification: done via meta tag at `sportconnects.org` (static page on Vercel). File: `zalo_verifierSFMEA8g60mrrfAeWfu4mUKUlatwhsKOXCpCq.html`
- Google OAuth branding: verification pending — app shows "unverified" warning to users during OAuth
- Static pages (privacy, terms) live on Vercel, **not** on Render. Vercel Authentication must stay disabled.
- Cloudflare Worker handles Zalo redirect; do not bypass it
- Supabase RLS is intentionally off (except `userlogin`). All access control is in FastAPI routers.
- `email` column in `unverified_users` is nullable (phone-only signups)
- `logintype` varchar was replaced by `user_auth_providers` table — do not reference the old column
