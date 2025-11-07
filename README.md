# SportsConnect

Cross-platform (Android / iOS / Web) sports companion built with Expo SDK 54, Expo Router, Supabase, and React Native.

> Backend Added: A FastAPI service (folder `backend/`) now provides REST endpoints over Supabase (courtinfo, notifications, favorites, profiles). Frontend still uses Supabase directly for auth; you can progressively migrate data reads to the backend.

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

Backend extra var (optional for API usage from the app):
`EXPO_PUBLIC_BACKEND_URL` – base URL of FastAPI (e.g. `http://localhost:8000` or your LAN IP like `http://192.168.1.42:8000`). If omitted, helper falls back to `http://localhost:8000`.

Example (PowerShell):
```powershell
$env:EXPO_PUBLIC_SUPABASE_URL="https://xxxxx.supabase.co"
$env:EXPO_PUBLIC_SUPABASE_ANON_KEY="anon-key-here"
$env:EXPO_PUBLIC_BACKEND_URL="http://localhost:8000"
npx expo start -c --tunnel
```

## 4. Login / Signup Flow

Screens `app/(auth)/login.tsx` and `app/(auth)/signup.tsx` use pure `StyleSheet` (no Tailwind/NativeWind). If converting more screens, follow same pattern:
1. Replace `className="..."` blocks with `styles.*` objects.
2. Map Tailwind spacing: `1 -> 4px`, `2 -> 8px`, `3 -> 12px`, etc.
3. Colors from former Tailwind config: dark300 `#6A6B6B`, green700 `#15803d`.

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

Backend: FastAPI · httpx · Pydantic · Uvicorn.

### 8.1 Backend Setup (FastAPI)

```powershell
# From project root (Windows PowerShell)
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
Copy-Item backend/.env.example backend/.env
# Edit backend/.env with your real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: http://localhost:8000/health  
API docs (Swagger): http://localhost:8000/docs

`backend/.env` required keys:
```
SUPABASE_URL="# your https://<id>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="# service role key (keep secret)"
ALLOWED_ORIGINS="http://localhost:8081,http://localhost:19006"
```
Add your LAN IP origins if using a physical device (e.g. `http://192.168.1.42:8081`).

### 8.2 Backend Endpoints
Prefix: `/api`

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/courtinfo` | GET | None | List courts |
| `/api/courtinfo/{id}` | GET | None | Single court |
| `/api/notifications` | GET | None | List notifications (filters: `user_id`, `notificationtype`) |
| `/api/favorites` | GET | Bearer JWT | List favorites for current user |
| `/api/favorites` | POST | Bearer JWT | Add favorite (body `{ courtinfoid }`) |
| `/api/favorites/{courtinfoid}` | DELETE | Bearer JWT | Remove favorite |
| `/api/profiles/{user_id}` | GET | None | Fetch profile by user id (UUID) |
| `/api/profiles/{user_id}` | PATCH | Bearer JWT | Update own profile fields |
| `/api/courtbookings` | GET | None | List court bookings (filters: `userid`, `status`, pagination `limit`/`offset`) |
| `/api/courtbookings/{courtbookingid}` | GET | None | Single court booking |
| `/api/courtbookings` | POST | Bearer JWT | Create court booking (auto inject `userid` from token) |
| `/api/eventbookings` | GET | None | List event bookings (filters: `userid`, `status`, pagination) |
| `/api/eventbookings/{eventbookingid}` | GET | None | Single event booking |
| `/api/eventbookings` | POST | Bearer JWT | Create event booking (auto inject `userid`) |
| `/api/trainingsessions` | GET | None | List training sessions (filters: `coachid`, `status`, pagination) |
| `/api/trainingsessions/{sessionid}` | GET | None | Single training session |
| `/api/history?userid={id}` | GET | None | Aggregated bookings/sessions for user |
| `/api/userinfo` | GET | None | Raw userinfo table rows (optional `userid`) |
| `/api/userlogin` | GET | None | Raw userlogin rows (optional `userid`) |
| `/api/users` | GET | None | Raw users rows |
| `/api/usersignup` | GET | None | Raw usersignup rows |

### 8.3 Frontend Consumption
Use the helper `lib/backendApi.ts` added to wrap fetch calls:
```ts
import { fetchCourts, fetchNotifications, fetchFavorites } from '@/lib/backendApi';
```
Set `EXPO_PUBLIC_BACKEND_URL` to reach backend from device; on phone use LAN IP not localhost.

### 8.4 Auth Strategy
Login / signup continue to use Supabase client-side with the anon key. The backend now expects a Supabase access token (`session.access_token`) in the `Authorization: Bearer <token>` header for any state-changing or user-bound endpoints (favorites, profile PATCH). The token is verified using the shared HS256 secret (service role / anon). Future upgrade: switch to JWKS verification for key rotation.

Frontend change: update any calls to favorites/profile update to send `Authorization` instead of `X-User-Id`.

#### 8.4.1 JWKS Verification
The backend attempts JWKS fetch from `SUPABASE_URL/auth/v1/certs` to verify RS256/RS512 tokens first. If unavailable (default Supabase often uses HS256 only) it falls back to HS256 with anon/service role key. You can rotate keys later without changing mobile code.

Auth env variables:
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...   # optional override
```

### 8.5 Health Check Integration
Root layout now pings backend every 30s; if unreachable a red banner appears (bottom of screen). To customize interval edit `app/_layout.tsx`.

### 8.6 Troubleshooting Backend
| Symptom | Cause | Fix |
|--------|-------|-----|
| 500 on `/api/notifications` | Wrong order column or RLS block | Add policy / adjust column to `created_at` |
| 404 `/api/profiles` | Missing `/{user_id}` part | Call `/api/profiles/<uuid>` |
| 307 redirects | Trailing slash route | Use slashless endpoints now provided |
| CORS errors | Origin not whitelisted | Append origin to `ALLOWED_ORIGINS` |
| Mobile can't reach `localhost` | Using device not emulator | Use LAN IP & set `EXPO_PUBLIC_BACKEND_URL` |

### 8.7 Optional Concurrent Run
Backend script already present:
```powershell
npm run backend
```
Run Expo and backend in separate terminals.

## 9. Frontend Types
A new file `types/backend.ts` centralizes TypeScript interfaces for backend responses (CourtInfo, Notification, FavoriteRow, ProfileRow, Bookings, Sessions, History). Prefer importing from there rather than redefining shapes.

## 10. Contributing

1. Branch off `new_update`.
2. Run lint & manual login/signup checks before PR.
3. Keep dependencies pinned (no caret upgrades unless required).

## 11. License

Internal learning project (no explicit license provided).

---
Happy hacking! 🚀

## 12. Pagination & Creation
Bookings and training session endpoints now support `limit` (1-200) and `offset` (>=0). Creation endpoints for court and event bookings accept JSON and inject the authenticated user id if `userid` not supplied.

Example list page:
```
GET /api/courtbookings?userid=5&limit=20&offset=0
```

Example creation:
```
POST /api/eventbookings
Authorization: Bearer <access_token>
{
	"eventid": 42,
	"status": "Upcoming",
	"message": "League Finals",
	"date": "2025-11-12",
	"time": "18:00"
}
```

## 13. Favorites Hook
Use `useFavorites()` for optimistic UI favorites toggling.
```tsx
const { isFavorite, toggle } = useFavorites();
<Pressable onPress={() => toggle(court.courtinfoid)}>
	<Text>{isFavorite(court.courtinfoid) ? '★' : '☆'}</Text>
</Pressable>
```
