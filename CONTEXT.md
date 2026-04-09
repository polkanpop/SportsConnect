# SportConnect — Context & Decisions Log

> Update this file whenever you resolve something non-trivial. One line is enough.
> Format: `[YYYY-MM-DD] What was decided and why.`

---

## Project Identity
- App: SportConnect — Vietnamese basketball court booking
- Domain: `sportconnects.org` (Cloudflare DNS)
- Supabase project: `pfhgiyujvxeartkomrpv`
- Firebase project: `sportconnect-c34b9`
- Backend on Render: `sportsconnect-ff00.onrender.com`
- Frontend GitHub: `LeDucTri1484` | Team lead: `polkanpop`

---

## Resolved Decisions (do not re-debate these)

### Infrastructure
- [2026-03] Static pages (privacy, terms, Zalo domain verification) moved to Vercel to fix Google crawler cold-start timeouts on Render.
- [2026-03] Vercel Authentication disabled on static pages — required so Google and Zalo crawlers can reach them without a login wall.
- [2026-03] Zalo domain verification completed via meta tag method (not DNS TXT). File hosted on Vercel at `sportconnects.org`.
- [2026-03] Cloudflare Worker deployed for Zalo OAuth redirect — do not remove or bypass.
- [2026-03] Redis cache via Upstash (`rediss://` — must use TLS scheme, not `redis://`). Backend auto-normalizes on startup.

### Auth
- [2026-03] `logintype` varchar column deprecated and replaced by `user_auth_providers` table. Never reference the old column.
- [2026-03] `email` column in `unverified_users` made nullable — required for phone-only signup flows.
- [2026-03] Phone columns added to `unverified_users`.
- [2026-03] Account merging is **user-initiated only** (Settings → Link Accounts). Never triggered automatically.
- [2026-03] `merge_accounts` PostgreSQL stored procedure covers all related tables. Email/phone stays canonical once set — cannot be overridden by a merge.
- [2026-04] Zalo OAuth geo-blocking fix settled: **frontend fetches the Zalo profile**, not the backend. Backend `/api/auth/zalo` receives token + profile object. Do not attempt to move profile fetch server-side again.
- [2026-04] Firebase OTP: use `verifyPhoneNumber` with `onVerificationStateChanged` callback pattern. `signInWithPhoneNumber` caused `auth/session-expired` on Android due to SMS Retriever API conflict.
- [2026-04] Google OAuth branding verification in progress — users see "unverified" warning during OAuth flow. This is expected until verification clears.

### Database
- [2026-03] Supabase RLS intentionally disabled on all tables except `userlogin`. Access control is enforced in FastAPI routers. Do not enable RLS elsewhere without discussing with team.
- [2026-03] `trg_set_courtbooking_duration` trigger auto-calculates `duration_minutes` — do not compute this manually in application code.

### Frontend Architecture
- [2026-03] Strict top-down data loading: bootstrap everything at app root via `/api/me/dashboard`. No child-level duplicate network calls.
- [2026-03] Favourites load first on Home screen with no skeleton/placeholder — intentional UX decision.
- [2026-03] Language toggle persisted in `AsyncStorage` only (key: `'language'`), not in database. No sync needed.
- [2026-04] Language labels in UI are `"Tiếng Việt"` / `"English"` — not the codes `"vi"` / `"en"`.
- [2026-04] All new UI text must be added to `constants/translations.ts` before shipping. No hardcoded strings.

### Notifications
- [2026-06] Push notification delivery implemented via Expo Push API (`exp.host/--/api/v2/push/send`). Backend `push_service.py` queries `user_devices` for active push tokens and sends after every DB insert. Best-effort: logs errors, never raises. No Firebase needed for push (only for Phone OTP).
- [2026-06] Notification translation system: `message_key` + `message_params` stored alongside legacy `title`/`message` in notifications table. Frontend resolves templates at render time using `resolveMessage()`/`resolveTitle()` helpers against `translations.ts` dictionary. Old records fall back to legacy English text. 14 unique message keys cover court/event/training booking lifecycle.
- [2026-06] SQL migration required: `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message_key text; ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message_params jsonb;`

### Performance
- [2026-06] List screen images (courtList, eventList, tsList) migrated from RN `Image` to `expo-image` (`ExpoImage`) with `cachePolicy="disk"`, `transition={0}`, and Cloudinary `optimizeRemoteImageUrl()` transforms (600×400, quality 75).
- [2026-06] `cachePolicy="disk"` added to all remote-URI ExpoImage instances across Map, Settings, courtPanel, eventPanel, trainingSessionPanel.
- [2026-06] Home phantom spinner fixed: `loadingFavs` now uses only `isLoading` (not `isFetching`) to prevent skeleton flash on cached data.
- [2026-06] Activity tab focus throttle increased from 5s to 60s. Redundant manual hosting query refetches removed from useFocusEffect (queries handle own staleness via `refetchOnMount: true` + `staleTime: 60s`).

### Maps
- [2026-03] Goong Maps is the primary map provider (Vietnamese tiles). Mapbox (`@rnmapbox/maps`) kept as fallback/secondary. Goong keys: `GOONG_MAPTILES_KEY` (tiles) + `GOONG_GEO_API_KEY` (geocoding) + `GOONG_DISTANCE_API_KEY` (distance matrix).

### Voice Booking
- [2026-04] Groq added for voice booking feature. Two models: `whisper-large-v3-turbo` (STT, Vietnamese) + `llama-3.1-8b-instant` (intent parsing). Primary path: on-device `expo-speech-recognition` → text → backend parse (avoids audio upload costs). Audio upload path is future work.

---

## In Progress / Open Issues

### Zalo Native OAuth
- Native SDK V4 (`react-native-zalo-kit`) is integrated and compiles.
- Target flow: app-to-app (open Zalo app directly, no Chrome/WebView).
- Current state: occasionally opens Chrome instead of Zalo; returns "incompatible" screen on some devices.
- One confirmed working moment (app opened, asked for authorization) was lost — that code was never recovered.
- Temporary workaround: web flow (browser) while native is debugged.
- Bug: when Zalo creates `unverified_users` record, phone is not added → verification status stays false but user can still log in.

### Google OAuth Branding
- Verification submitted, pending Google review.
- Until cleared: users see "unverified app" warning. This is not a bug, do not try to suppress it.

### Firebase OTP
- Test phone numbers configured in Firebase console — use these during development to avoid real SMS costs.
- OTP SMS sender name: set Firebase project public-facing name to "SportConnect" in Firebase Console → Project Settings → General.
- Full branded SMS (Vietnamese template) requires registering with VN carriers (Viettel, Mobifone, Vinaphone) — medium-term task.

---

## Feature Status Snapshot (as of 2026-06)

| Feature | Status |
|---|---|
| Email/password auth | ✅ Done |
| Google OAuth | ✅ Done (branding verification pending) |
| Zalo OAuth | ⚠️ Web flow only; native app-to-app in progress |
| Firebase Phone OTP | ✅ Done (session-expired bug fixed) |
| Account linking/unlinking | ✅ Done |
| Account merging (merge_accounts) | ✅ Done |
| Language toggle EN/VI | ✅ Done |
| Court discovery + map | ✅ Done |
| Court booking | ✅ Done |
| Events (create/join) | ✅ Done |
| Training sessions (create/join) | ✅ Done |
| Push notifications (Expo Push API) | ✅ Done |
| Notification translation (message_key) | ✅ Done |
| Voice booking (on-device STT) | ✅ Done |
| Voice booking (audio upload) | 🔲 Future |
| Payment (VNPay) | 🔲 In progress |
| Reviews + reactions | ✅ Done |
| Court owner registration flow | ✅ Done |
| Image caching (ExpoImage disk) | ✅ Done |
| Firebase OTP SMS branding | 🔲 Pending |
| Google OAuth branding | ⚠️ Verification in progress |

---

## Useful Links

| Resource | URL |
|---|---|
| Supabase dashboard | https://supabase.com/dashboard/project/pfhgiyujvxeartkomrpv |
| Firebase console | https://console.firebase.google.com/project/sportconnect-c34b9 |
| Render dashboard | https://dashboard.render.com |
| Cloudflare dashboard | https://dash.cloudflare.com |
| Cloudinary console | https://cloudinary.com/console (cloud: `dg0rerv5b`) |
| Groq console | https://console.groq.com |
| Mailtrap | https://mailtrap.io |
| Backend API docs | https://sportsconnect-ff00.onrender.com/docs |

---

## Session Notes
> Add a one-liner here at the end of each working session.
> Example: `[2026-04-07] Fixed Zalo profile fetch to happen on frontend. Merged into main.`
