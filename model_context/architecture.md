# SportConnect — Architecture Overview

## Stack Summary
| Layer | Technology | Hosting |
|-------|-----------|---------|
| **Frontend** | React Native + Expo Router (SDK 52) | Expo EAS OTA (preview branch) |
| **Backend** | FastAPI (Python 3.11) | Render Free (Singapore) |
| **Database** | PostgreSQL 15 + PostGIS 3.3.7 | Supabase |
| **Auth** | Supabase Auth + Firebase Phone Auth | Supabase / Firebase |
| **DNS/CDN** | Cloudflare Workers | sportconnects.org |
| **Images** | Cloudinary | dg0rerv5b cloud |
| **Maps** | Mapbox GL (frontend), Goong (geocoding/distance) | — |
| **Voice AI** | expo-speech-recognition (on-device vi-VN) → Groq LLM | Groq Cloud |
| **Push** | expo-notifications + Firebase FCM | Firebase |
| **Email** | Mailtrap (SMTP live.smtp.mailtrap.io:2525) | Mailtrap |
| **Cache** | Upstash Redis | Upstash |
| **Payments** | VNPay + Cash | VNPay |

## URLs
- **API**: `https://sportsconnect-ff00.onrender.com`
- **Domain**: `https://sportconnects.org` (Cloudflare Worker)
- **Supabase**: `https://pfhgiyujvxeartkomrpv.supabase.co`
- **Git**: `https://github.com/polkanpop/SportsConnect` (branch: `midnight1`)

## Frontend Architecture
```
expo-router (file-based routing)
├── app/
│   ├── _layout.tsx          ← Root: GestureHandler > ZaloOverlay > Theme > Lang > Query > Auth > Bootstrap > Voice
│   ├── index.tsx            ← Redirect to (tabs)
│   ├── (auth)/              ← Login, Register, OTP, ForgotPassword
│   ├── (tabs)/              ← Home, Map, CourtList, EventList, TSList, Settings
│   └── event/               ← Detail/booking screens for courts, events, training sessions
├── providers/               ← React context providers (auth, bootstrap, voice, language, query, zalo-overlay)
├── hooks/                   ← React Query hooks, useAuthContext, useVoicePreference
├── lib/                     ← Supabase client, backendApi.ts (all API calls)
├── constants/               ← ICONS, COLORS, translations, API endpoints
└── components/              ← Reusable UI (maps, voice, ui/, social-auth-buttons/)
```

## Backend Architecture
```
backend/app/
├── main.py                  ← FastAPI app, CORS, lifespan
├── routers/                 ← API route modules
│   ├── courts.py            ← /api/courts/* (CRUD, availability, booking)
│   ├── events.py            ← /api/events/* (CRUD, booking)
│   ├── training_sessions.py ← /api/training-sessions/*
│   ├── auth.py              ← /api/auth/* (login, register, OTP, OAuth)
│   ├── user.py              ← /api/user/* (profile, settings)
│   ├── map.py               ← /api/map/* (bounds-based pins)
│   ├── speech.py            ← /api/speech/* (voice booking intent)
│   ├── notifications.py     ← /api/notifications/*
│   └── reviews.py           ← /api/reviews/*
├── services/                ← Business logic, Cloudinary, Firebase, Mailtrap
└── utils/                   ← Auth helpers, Supabase client, Redis
```

## Build & Deploy
```bash
# OTA update (NO native rebuild!)
cd frontend
npx eas update --branch preview --platform android
# ⚠️ HALT immediately after "Published" tick appears!

# Git
git add -A
git commit -m "message"
git push Sportconnect midnight1

# Backend auto-deploys on push to Render
```

## Critical Constraints
- **No native rebuilds** — OTA only via EAS updates
- **Render Free Tier** — 0.1 CPU, 512MB RAM, cold starts after 15min idle
- **@expo/vector-icons Ionicons** — Empty squares on device, use PNG ICONS instead
- **OPPO/ColorOS** — Zalo CCT causes OpenGL surface NULL, needs overlay fade-out
- **EAS update crash** — Copilot crashes after publish tick; halt immediately
