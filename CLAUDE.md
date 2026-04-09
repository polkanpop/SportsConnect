# CLAUDE.md — SportConnect Project Guide

> Quick-reference for AI coding assistants working on this codebase.

---

## Project Overview

**SportConnect** (`sportconnects.org`) is a Vietnamese basketball court booking app built with React Native (Expo) + FastAPI + Supabase PostgreSQL.

Users can discover courts on a map, book time slots, create/join events and training sessions, and manage payments.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React Native, Expo SDK (managed), TypeScript, NativeWind, Expo Router |
| Backend | FastAPI (Python 3.11), deployed on Render |
| Database | Supabase PostgreSQL (PostGIS enabled), 29+ tables |
| Cache | Redis via Upstash (`rediss://`) |
| Auth | JWT (access 60 min + refresh), 4 providers: Local, Google, Zalo, Phone |
| Maps | Goong Maps (primary, Vietnamese tiles) + Mapbox (secondary) |
| Images | Cloudinary (`dg0rerv5b`) + `expo-image` with disk caching |
| Push | Expo Push API (`exp.host/--/api/v2/push/send`) |
| Voice | Groq (`whisper-large-v3-turbo` STT + `llama-3.1-8b-instant` intent parsing) |
| Email | Mailtrap SMTP (`noreply@sportconnects.org`) |
| DNS/CDN | Cloudflare |

---

## Directory Structure

```
sport_app/
├── backend/backend/app/         # FastAPI application
│   ├── main.py                  # App entry point
│   ├── routers/                 # API route handlers
│   ├── notifications_service.py # Notification creation + push delivery
│   ├── push_service.py          # Expo Push API sender
│   └── ...
├── frontend/
│   ├── app/                     # Expo Router screens
│   │   ├── (auth)/              # Login, signup, OTP flows
│   │   ├── (tabs)/              # Home, Map, Activity, Notification, Settings
│   │   └── event/               # All detail/booking/panel screens
│   ├── components/              # Reusable UI components
│   ├── constants/
│   │   ├── translations.ts      # All EN/VI strings (add new text here)
│   │   ├── colors.ts            # Theme colors
│   │   └── icons.ts             # Icon asset references
│   ├── hooks/                   # React Query hooks + query keys
│   ├── lib/                     # API clients, utilities
│   │   ├── backendApi.ts        # Backend API wrapper + types
│   │   └── imageOptimize.ts     # Cloudinary URL transforms
│   ├── providers/               # Context providers (Language, Theme)
│   └── __tests__/               # Jest test suites
├── CONTEXT.md                   # Decision log + feature status
└── CLAUDE.md                    # This file
```

---

## Key Conventions

### Data Loading
- **Strict top-down**: Bootstrap everything at app root via `/api/me/dashboard`. Child screens read from shared cache.
- No child-level duplicate network calls on launch.
- Favourites load first on Home (no skeleton placeholder).

### Translations (i18n)
- All UI text in `constants/translations.ts` — never hardcode Vietnamese/English in components.
- Use `t('KEY')` from `LanguageContext`. Language stored in `AsyncStorage` key `'language'`, defaults to `'vi'`.
- Notification messages use `message_key` + `message_params` stored in DB, resolved at render time.

### Images
- Use `ExpoImage` (from `expo-image`) with `cachePolicy="disk"` for all remote images.
- Transform URLs via `optimizeRemoteImageUrl()` from `lib/imageOptimize.ts` for Cloudinary optimization.
- Profile pictures stored in Cloudinary folder `profile_pictures`.

### Routing
- File-based routing via Expo Router.
- All new screens go in `app/event/` unless they are tabs or auth flows.
- Auth screens in `app/(auth)/`, tab screens in `app/(tabs)/`.

### API
- Backend prefix: `/api`
- Production base URL: `https://sportsconnect-ff00.onrender.com/api`
- Rate limiting via SlowAPI.
- Caching via Redis (Upstash).

---

## Auth Architecture

| Provider | Flow |
|---|---|
| Local | Username + password, bcrypt + pepper |
| Google | `expo-auth-session` PKCE → backend `/api/auth/google` |
| Zalo | Native SDK → **frontend** fetches profile (geo-blocking fix) → backend `/api/auth/zalo` |
| Phone | Firebase OTP (`verifyPhoneNumber` + `onVerificationStateChanged`) → backend `/api/auth/verify-phone-otp` |

- Account merging: user-initiated only (Settings → Link Accounts), never automatic.
- JWT stored on device, not in Supabase auth.

---

## Notification System

### Push Delivery
- `push_service.py` queries `user_devices` table for active Expo Push Tokens.
- POSTs to `https://exp.host/--/api/v2/push/send` via httpx.
- Best-effort: logs errors, never raises.
- Push tokens registered via `/api/devices` on login, deregistered on logout.

### Translation System
- DB stores `message_key` (e.g., `court_booking_approved`) + `message_params` (e.g., `{"venue": "Court Name"}`).
- Frontend `Notification.tsx` resolves via `resolveMessage(row)` / `resolveTitle(row)`.
- Template syntax: `{{param}}` placeholders in translation strings.
- Old records without `message_key` fall back to legacy English `title`/`message`.

### 14 Message Keys
`court_booking_approved`, `court_booking_submitted`, `court_booking_rejected`, `court_booking_incoming`,
`event_booking_approved`, `event_booking_submitted`, `event_booking_rejected`, `event_booking_incoming`,
`ts_booking_approved`, `ts_booking_submitted`, `ts_booking_rejected`, `ts_booking_incoming`,
`event_created`, `ts_created`

---

## Database Notes

- Supabase RLS OFF on all tables except `userlogin` — security enforced at API layer.
- Key extensions: PostGIS 3.3.7, pgcrypto, uuid-ossp.
- `trg_set_courtbooking_duration` auto-calculates `duration_minutes` — don't compute manually.
- `notifications` table has `message_key text` and `message_params jsonb` columns for translation system.

---

## Performance Patterns

- `ExpoImage` with `cachePolicy="disk"` for all remote images (replaces RN `Image`).
- Cloudinary URL optimization via `optimizeRemoteImageUrl()` for list screen thumbnails.
- Home `loadingFavs` uses only `isLoading` (not `isFetching`) to prevent phantom skeleton flashes.
- Activity tab focus-refetch throttled to 60s to prevent backend spam.
- React Query global defaults: `refetchOnMount: false`, `staleTime` varies by query.

---

## Common Commands

```bash
# Frontend
cd frontend
npx expo start                    # Dev server
npx eas update --branch preview --platform android  # OTA update

# Backend
cd backend/backend
uvicorn app.main:app --reload     # Local dev server

# Deploy
git add -A && git commit -m "msg" && git push  # Then EAS update for frontend
# Backend: push to main → Render auto-deploys
```

---

## Known Quirks

- **Zalo geo-blocking**: Frontend must fetch Zalo profile, not backend. Backend receives pre-fetched profile.
- **Cloudflare Worker** handles Zalo OAuth redirect — do not bypass.
- **Google OAuth** shows "unverified app" warning until branding verification clears.
- **Static pages** (privacy, terms) on Vercel with Authentication disabled (for crawlers).
- **`logintype`** column deprecated — use `user_auth_providers` table instead.
- **`email`** in `unverified_users` is nullable (phone-only signups).
