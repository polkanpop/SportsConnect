SportConnect — Chat Summary
Project Stack
React Native (Expo/EAS) frontend + FastAPI (Python) backend on Render, Supabase DB, Cloudflare DNS at sportconnects.org, Cloudinary for images, Goong Maps.

Features Completed ✅
Language Toggle (EN/VI)

LanguageContext provider reading from AsyncStorage key 'language', defaults to Vietnamese ('vi')
Toggle in Settings AND sticky button top-right of Login screen
Login screen policy/terms links switch language based on selection
Labels: "Tiếng Việt" / "English" (not "vi"/"en")
Translation coverage: venue tags (indoor/outdoor), days of week (Hai/Ba/Tư/...), activity tabs

Account Linking / Unlinking (Settings)

Google & Zalo shown as linkable providers
When linked: clicking reveals an X button via slide animation (not visible by default)
Unlink confirmation before removing
Merging accounts: unique constraint–aware logic, simplified merge (no deep merge), email/phone stays canonical

Account Settings UI Refactor

Email/phone fields disabled if already set (safety policy — can't override)
Merge flow: verify both sides before merging

Map

Court filter icons changed to black (was grey)
Filter expand already correct

Activity Screen

Hosting tab: completed banner color fixed (was dark green, should match Booking tab)
Booking tab: status-aware display

UI/UX Fine-tuning

Social auth button icons resized (Google/Zalo size sync)
Star icon → star_cal.png
Language toggle not persisted in DB, AsyncStorage only


Major Ongoing Battle: Zalo OAuth ❌
This consumed most of the chat. Current state as of last messages:

Native SDK V4 integrated (ZaloKit found, compiled in)
Flow attempted: app-to-app (open Zalo app directly, no Chrome, no WebView)
Persistent issue: still opening Chrome instead of Zalo app, or returning "incompatible" screen
Backend: POST /api/auth/zalo exists, Zalo env vars (ZALO_APP_ID, ZALO_APP_SECRET) added to Render
Cloudflare Worker deployed for redirect handling
Known working moment: at ~13:00 one session it briefly launched Zalo and asked for authorization but returned a secret key error — that exact code was lost
Current workaround agreed: temporarily revert to web flow (open browser) while native is debugged
User creation on Zalo link: creates unverified_users record but doesn't add phone → status stuck as false, still logs in (bug)


OTP (Phone Auth) Issues ❌

Firebase phone auth blocking (quota/billing hit temporarily)
OTP expiring immediately on verify
AUTO_VERIFIED path fires too early, sends invalid Firebase token to backend
Fix attempted: add useRef guard isProcessing to prevent double-fire


Copilot Memory Notes (from your session memory)

Strict top-down data loading — bootstrap at app root, no child-level duplicate network calls
Favourites load first on Home, no skeleton/placeholder for favourites
Full-save release flow: stage → commit → push → eas update
Repo memory file: /memories/repo/sport_app_architecture.md


