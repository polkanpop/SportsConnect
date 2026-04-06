# External Services & API Keys

> All secrets are stored in Render environment variables. Never hardcode.

## Supabase
- **URL**: `https://pfhgiyujvxeartkomrpv.supabase.co`
- **Env vars**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`
- **Frontend uses**: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`

## Cloudinary (Image Storage)
- **Cloud Name**: dg0rerv5b
- **Folder**: profile_pictures
- **Env vars**: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Usage**: Profile pictures, court images, event images upload/serve

## Goong (Maps/Geocoding — Vietnam)
- **Env vars**: `GOONG_DISTANCE_API_KEY`, `GOONG_GEO_API_KEY`
- **Frontend**: `EXPO_PUBLIC_GOONG_MAPTILES_KEY`
- **Usage**: Distance matrix calculation, reverse geocoding, address search

## Mapbox
- **Frontend**: `EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN`
- **Usage**: Map rendering via `@rnmapbox/maps`, court/event/TS markers,
  SDF markers (courts, dynamic color) + PNG markers (events/training sessions)

## Groq (Voice AI)
- **Base URL**: `https://api.groq.com/openai/v1`
- **Env var**: `GROQ_API_KEY`
- **Models**:
  - `whisper-large-v3-turbo` — Speech-to-Text ($0.04/hr, 400K audio-sec/hr)
  - `llama-3.1-8b-instant` — Intent parsing (560 tok/sec, 131K context)
- **Architecture**: expo-speech-recognition (on-device vi-VN) → text → backend Groq parse

## Firebase (Phone Auth + Push)
- **Project**: sportconnect-c34b9
- **Env var**: `FIREBASE_SERVICE_ACCOUNT_JSON` (base64-encoded)
- **Usage**: Phone OTP auth, FCM push notifications

## Mailtrap (Email)
- **SMTP**: live.smtp.mailtrap.io:2525
- **Sender**: noreply@sportconnects.org
- **Env vars**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER`
- **Usage**: Email verification, password reset

## Upstash Redis (Cache)
- **Env var**: `REDIS_URL`
- **Usage**: Backend caching, rate limiting

## VNPay (Payments)
- **Env vars**: `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_RETURN_URL`
- **Usage**: Online payment for court/event/TS bookings

## Render (Backend Hosting)
- **URL**: `https://sportsconnect-ff00.onrender.com`
- **Plan**: Free (0.1 CPU, 512MB RAM, Singapore region)
- **Root Dir**: `backend`
- **Start Command**: `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT`
- **Python**: 3.11.10
- **Auto-deploy**: On git push to `midnight1` branch

## Cloudflare (DNS + Worker)
- **Domain**: sportconnects.org
- **DNS**: A record → 216.198.79.1 (Proxied), www CNAME → Vercel
- **Page Rule**: www → non-www 301 redirect
- **Worker**: Handles landing page, Zalo callback redirect, Zalo proxy
- **TXT**: Zalo domain verification record present
