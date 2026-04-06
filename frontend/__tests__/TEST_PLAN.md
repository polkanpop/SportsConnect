# SportConnect — Comprehensive Test Plan

> Covers unit, integration, and end-to-end (manual/device) test cases.
> Organised by feature domain. Severity: **P0** = blocker, **P1** = critical, **P2** = nice-to-have.

---

## 1. Authentication (auth)

### 1.1 Phone OTP Login
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| A1 | Enter valid VN phone → receive OTP | Slow 3G network | OTP arrives within 60s, countdown shows | P0 |
| A2 | Enter invalid phone format | N/A | Validation error, no API call | P0 |
| A3 | Enter wrong OTP 5 times | N/A | Account temp-locked, error message | P0 |
| A4 | OTP timeout (60s) → resend | Airplane mode during resend | Error toast, can retry when online | P1 |
| A5 | Phone already registered → login | N/A | Navigates to home, bootstrap loads | P0 |
| A6 | New phone → register flow | N/A | Profile creation screen appears | P0 |

### 1.2 Google Sign-In
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| A7 | Tap Google → auth sheet | No Google Play Services | Graceful error toast | P0 |
| A8 | Complete Google auth | N/A | Token stored, navigate home | P0 |
| A9 | Cancel Google auth midway | N/A | Returns to login, no crash | P1 |
| A10 | Google account already linked | N/A | Login succeeds directly | P0 |

### 1.3 Zalo Sign-In / Link
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| A11 | Tap Zalo login → CCT opens | OPPO/ColorOS device | White overlay visible, no black screen | P0 |
| A12 | Complete Zalo auth → redirect | Network drops during redirect | Overlay hides after timeout, error shown | P0 |
| A13 | Cancel Zalo auth (press back) | N/A | Overlay fades out smoothly (600ms), no black flash | P0 |
| A14 | Link Zalo from account settings | OPPO device, Zalo not installed | CCT opens web auth, Linking listener catches redirect, dismissAuthSession closes CCT | P0 |
| A15 | Unlink Zalo provider | N/A | Provider removed, can re-link | P1 |
| A16 | Zalo CCT stalls (openAuthSessionAsync never resolves) | OPPO/ColorOS | Linking listener catches deep link, dismissAuthSession force-closes CCT | P0 |

### 1.4 Session Management
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| A16 | App killed → reopen | N/A | Session restored from Supabase, no re-login | P0 |
| A17 | Token expired while app in bg | N/A | Auto-refresh or navigate to login | P0 |
| A18 | Sign out | N/A | All caches cleared, navigate to login | P0 |

---

## 2. Home / Dashboard

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| H1 | Open app → home loads | Cold start, first install | Favourites load first (no skeleton), then other data | P0 |
| H2 | Pull-to-refresh | Offline | Toast "No connection", stale data remains | P1 |
| H3 | Tap court card → navigate | N/A | Opens court detail with images/schedule | P0 |
| H4 | Tap event card → navigate | N/A | Opens event booking screen | P0 |
| H5 | 50+ favourite courts | Low-end device (2GB RAM) | No jank, list renders smoothly | P1 |

---

## 3. Map

### 3.1 Markers
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| M1 | Map loads court markers | 200+ courts in view | Markers render without lag | P0 |
| M2 | Event markers proportional to court markers | N/A | Event/TS icons ~0.09 vs court 0.07 (similar size) | P1 |
| M3 | Tap court marker → bottom sheet | N/A | Rich callout with image, tabs, favourite | P0 |
| M4 | Tap event marker → bottom sheet | N/A | Shows title, address, datetime, fee, participants cap | P0 |
| M5 | Tap TS marker → bottom sheet | N/A | Shows title, address, datetime, fee, participants cap | P0 |
| M6 | Switch between Courts/Events/Training tabs | Rapid switching | No stale markers from previous tab | P1 |
| M7 | Pan/zoom triggers bounds reload | Slow connection | Loading indicator, no duplicate pins | P1 |

### 3.2 Navigation
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| M8 | Tap "Navigate" → open external map | No map apps installed | Graceful error | P2 |
| M9 | Distance matrix display | GPS permission denied | Distance shows "—", no crash | P1 |

---

## 4. Court Booking

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| B1 | Select date → see available slots | N/A | Slots reflect backend availability | P0 |
| B2 | Book a 60min slot | N/A | Booking created, appears in My Bookings | P0 |
| B3 | Double-book same slot | Two users simultaneously | One gets conflict error, other succeeds | P0 |
| B4 | Book → pay with VNPay | N/A | Payment URL opens, webhook confirms | P0 |
| B5 | Book → pay with cash | N/A | Booking created as "pending_payment" | P0 |
| B6 | Cancel booking within policy | N/A | Booking cancelled, slot freed | P1 |
| B7 | View booking receipt/details | N/A | All info correct: court, time, price | P1 |

---

## 5. Event Booking

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| E1 | Browse events list | N/A | Image-first cards, sorted by date | P0 |
| E2 | Join event (free) | N/A | Booking created, participant count updates | P0 |
| E3 | Join event (paid) | N/A | Payment flow, then booking | P0 |
| E4 | Event at capacity | N/A | "Full" badge, join button disabled | P0 |
| E5 | Cancel event registration | N/A | Removed from participants | P1 |

---

## 6. Training Session Booking

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| T1 | Browse TS list | N/A | Image-first cards with coach info | P0 |
| T2 | Join training session | N/A | Booking created | P0 |
| T3 | TS at capacity | N/A | Join disabled | P0 |
| T4 | Coach view: see attendees | N/A | List of registered users | P1 |

---

## 7. Voice Booking (BETA)

### 7.1 Permission & Toggle
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| V1 | Enable voice in settings | Mic permission not granted | System permission dialog, only enable if granted | P0 |
| V2 | Enable voice when already authorised | N/A | Skips permission, enables immediately | P0 |
| V3 | Deny mic permission | N/A | Toggle stays off | P0 |
| V4 | Disable voice | N/A | FAB disappears immediately | P0 |

### 7.2 FAB Button
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| V5 | FAB visible on home (logged in) | N/A | Mic icon visible (PNG, not empty square) | P0 |
| V6 | FAB NOT visible on login screen | N/A | Not rendered for unauthenticated users | P0 |
| V7 | Tap FAB → bounce animation | N/A | Scale-down 0.8 then spring back to 1.0 | P1 |
| V8 | Drag FAB to edge | N/A | Snaps to nearest edge with spring | P1 |
| V9 | Tap FAB → focus overlay appears | N/A | Dark overlay fades in (300ms), mic pulsing | P0 |

### 7.3 Voice Flow
| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| V10 | Speak "Đặt sân cầu lông lúc 3 giờ chiều" | Noisy environment | Partial transcript visible, intent parsed | P0 |
| V11 | Intent parsed → result screen | N/A | Shows transcript, intent fields, Apply/Retry buttons | P0 |
| V12 | Tap "Áp dụng" | N/A | Navigates to booking with pre-filled fields | P0 |
| V13 | Tap "Thử lại" | N/A | Back to listening state | P1 |
| V14 | Close overlay (X or Đóng) | N/A | Overlay fades out, returns to previous screen | P0 |
| V15 | Backend Groq API timeout | API unreachable | Error view with retry option, no infinite spinner | P0 |
| V16 | Speak in English | N/A | Falls back gracefully (vi-VN recognizer may garble) | P2 |

---

## 8. Account Settings

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| S1 | View account info | N/A | Name, email, phone displayed correctly | P0 |
| S2 | Change password | N/A | Old + new validated, success toast | P0 |
| S3 | Link Zalo | OPPO device | Overlay shows, CCT opens, no black screen on return | P0 |
| S4 | Unlink provider (last provider) | N/A | Warning dialog, cannot unlink last provider | P0 |
| S5 | BETA badge alignment | N/A | Title text offset with marginTop:4, badge vertically centred | P1 |
| S6 | Change language (EN/VI) | N/A | All strings update, no missing keys | P0 |
| S7 | Change theme (light/dark) | N/A | Colors update, no unreadable text | P1 |
| S8 | Settings search filters rows | N/A | Typing "account" shows only Account row, empty search shows all | P0 |
| S9 | Settings search Vietnamese | N/A | Typing "tài khoản" matches Account row | P1 |
| S10 | Voice toggle ON (mic already granted) | N/A | Enables immediately, no permission dialog | P0 |
| S11 | Voice toggle ON (mic denied) | N/A | Toggle stays off, no snap-back glitch | P0 |
| S12 | Voice toggle OFF then ON again (permission already granted) | N/A | Enables without asking permission again | P0 |

---

## 9. Notifications

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| N1 | Receive push notification | App in background | System notification appears | P0 |
| N2 | Tap notification → navigate | N/A | Opens correct screen (booking/event/etc.) | P0 |
| N3 | 100+ notifications | N/A | List scrolls smoothly, unread badge accurate | P1 |
| N4 | Delete all notifications | N/A | Confirmation dialog, then clear | P1 |

---

## 10. Search

| # | Case | Harsh condition | Expected | Sev |
|---|------|-----------------|----------|-----|
| SR1 | Search "cầu lông" | N/A | Courts with badminton type appear | P0 |
| SR2 | Search with special chars | N/A | No crash, empty or filtered results | P1 |
| SR3 | Search debounce | Rapid typing | Only 1 API call after pause | P1 |
| SR4 | Search settings page | N/A | Matching settings options highlighted | P2 |

---

## 11. Offline / Network Edge Cases

| # | Case | Expected | Sev |
|---|------|----------|-----|
| O1 | Open app with no internet | Cached data shown, offline banner | P0 |
| O2 | Lose connection mid-booking | Error toast, booking not created | P0 |
| O3 | Slow 2G connection | Loading states visible, no timeout crash | P1 |
| O4 | Switch WiFi → mobile mid-session | Requests retry seamlessly | P1 |
| O5 | Airplane mode toggle | Reconnects, refetches stale data | P1 |

---

## 12. Device-Specific / Performance

| # | Case | Expected | Sev |
|---|------|----------|-----|
| D1 | OPPO/ColorOS (Zalo CCT) | Linking listener fallback catches deep link, dismissAuthSession closes CCT, no black screen | P0 |
| D2 | Low-end 2GB RAM device | No OOM crash, lists virtualised | P0 |
| D3 | Android 10 (API 29) | All features work, permissions handled | P1 |
| D4 | Android 14 (API 34) | New permission model respected | P1 |
| D5 | Screen rotation during booking | Layout adapts or locked portrait | P2 |
| D6 | Split screen / multi-window | App doesn't crash | P2 |
| D7 | Font scale 200% (accessibility) | Text doesn't overflow, buttons tappable | P1 |

---

## 13. Venue Management (Provider role)

| # | Case | Expected | Sev |
|---|------|----------|-----|
| VM1 | Register venue with all fields | Venue created, appears on map | P0 |
| VM2 | Upload court images | Images appear in gallery | P0 |
| VM3 | Set availability schedule | Slots appear for booking | P0 |
| VM4 | View incoming bookings | List of bookings with status | P0 |
| VM5 | Approve/reject booking | Status updates for user | P0 |

---

## Running Tests

```bash
# Unit tests (node environment)
cd frontend
npm test

# Watch mode during development
npm run test:watch

# Specific test file
npx jest __tests__/hooks/query-keys.test.ts
npx jest __tests__/auth/zalo-auth-flow.test.ts
npx jest __tests__/auth/pkce-helpers.test.ts
npx jest __tests__/hooks/voice-toggle-permission.test.ts
npx jest __tests__/settings/settings-search.test.ts
```

## Test Files

| File | Coverage Area |
|------|---------------|
| `constants/colors.test.ts` | Color constants exported |
| `constants/env.test.ts` | Environment variables |
| `constants/icons.test.ts` | Icon assets exported |
| `constants/translations.test.ts` | Translation keys |
| `hooks/query-keys.test.ts` | React Query key generators |
| `hooks/voice-preference-logic.test.ts` | Voice preference module contract |
| `hooks/voice-toggle-permission.test.ts` | Voice toggle permission flow logic |
| `auth/zalo-auth-flow.test.ts` | Zalo CCT + Linking listener fallback |
| `auth/pkce-helpers.test.ts` | PKCE code_verifier/challenge/state |
| `settings/settings-search.test.ts` | Settings search filtering |

## Test Coverage Target

- **Constants / pure logic**: 90%+ line coverage
- **Hooks**: 70%+ (limited by React hook constraints in node env)
- **Components**: Manual device testing (see sections 1-13 above)
- **E2E**: Manual checklist per release (see test matrix)
