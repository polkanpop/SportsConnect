# SportsConnect Backend

This directory now contains only the Python FastAPI backend for the SportsConnect project. All duplicated Expo / React Native frontend files have been removed. The active frontend lives in the separate `frontend/` directory at the repo root.

## Overview

FastAPI service that exposes REST endpoints over Supabase tables (courts, notifications, favorites, profiles, bookings, training sessions, history, raw user tables). Intended for secure, server-side logic and consolidation of data access previously done directly from the mobile/web client.

Backend code path: `backend/backend/app/` (nested path retained for now). Entry module: `backend/backend/app/main.py`.

## Quick Start (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r backend\backend\requirements.txt
# Copy & edit environment file if you have an example (create manually otherwise)
New-Item -ItemType File .env -Force | Out-Null
# Populate .env with required keys below
uvicorn backend.backend.app.main:app --reload --host  --port 8000
```

Visit:
* Swagger / OpenAPI docs: http://localhost:8000/docs
* Redoc: http://localhost:8000/redoc
* Health: http://localhost:8000/health (if implemented)

## Environment Variables (.env)

```
SUPABASE_URL="https://<project>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="<service--key>"   # keep secret
SUPABASE_ANON_KEY="<anon-key>"                   # optional if validating anon tokens
ALLOWED_ORIGINS="http://localhost:8081,http://localhost:19006"
REDIS_URL="redis://localhost:6379/0"             # Redis cache (host, port, db). Add password if needed.
UPSTASH_REDIS_URL="rediss://default:<token>@<host>.upstash.io:6379" # optional alias used if REDIS_URL is absent
PASSWORD_PEPPER="<random-long-base64>"           # Server-side secret appended to user password before bcrypt
REFRESH_TOKEN_PEPPER="<random-long-base64>"      # Server-side secret mixed into refresh token hash

### Pepper Guidance

Passwords are now hashed as `bcrypt(password + PASSWORD_PEPPER)`. On first successful login of an older account (unpeppered bcrypt or plaintext/SHA256 legacy) the backend transparently upgrades the stored hash to the peppered bcrypt form. Refresh tokens are never stored in plaintext; a deterministic SHA256 hash of `refresh_token || REFRESH_TOKEN_PEPPER` is stored for lookup & revocation.

Rotation strategy (zero-downtime):
1. Add a second variable (e.g. `PASSWORD_PEPPER_NEXT`) and modify code to accept either current or next pepper during verify (not yet implemented).
2. Force rehash on successful login using NEXT pepper.
3. After majority migrated, remove old pepper & variable.

Pepper length: use 32+ random bytes, base64 encode. Example generation:
```powershell
python - <<'PY'
import os, base64; print(base64.urlsafe_b64encode(os.urandom(48)).decode())
PY
```
Keep peppers out of version control; rotate if leaked.
```
Add additional origins for real devices (e.g. `http://192.168.1.<X>:8081`).

### Caching

The backend uses `fastapi-cache2` with a Redis backend (see `main.py`).

Configuration:
* `REDIS_URL` format: `redis://[:password@]host:port/db` (e.g. `redis://:mypw@redis:6379/2`).
* Upstash Redis should use TLS: `rediss://default:<token>@<host>.upstash.io:6379`.
* Default if unset: `redis://localhost:6379/0`.
* Keys are prefixed with `sportsconnect-cache` so multiple services can share the same Redis instance safely.

Local Docker example:
```powershell
docker run -d --name sportsconnect-redis -p 6379:6379 redis:7
```

Then add to `.env`:
```
REDIS_URL="redis://localhost:6379/0"
```

To flush cache (careful in shared environments):
```powershell
docker exec -it sportsconnect-redis redis-cli FLUSHDB
```

## Auth

Endpoints requiring user context expect an `Authorization: Bearer <supabase-access-token>` header. Token verification supports JWKS (if available) or falls back to HS256 using the service role / anon key.

### Password Reset (New Feature)

Current implementation (Nov 2025) adds two endpoints under the existing `/userlogin` router:

```
POST /api/userlogin/forgot-password   { identifier }   # email OR username
POST /api/userlogin/reset-password    { token, newPassword }
```

Flow:
1. Client calls `forgot-password` with email or username.
2. Backend looks up the account; if found, generates a one-time token (in-memory) and logs the email reset link. (If SMTP env vars are later provided, sending can be enabled.)
3. User taps the link directing to frontend `/newpassword?token=...` screen, submits new password.
4. Backend validates token + expiry (default 60 minutes) and updates `userlogin.passwordhash` using peppered bcrypt.

Environment variables controlling reset flow:
```
PASSWORD_RESET_EXP_MINUTES="60"                   # Token validity
PASSWORD_RESET_BASE_URL="https://app.local/(auth)/newpassword"  # Base link used in emails
```

Persistence Upgrade (recommended for production): create table to store tokens instead of in-memory dict (survives restarts and enables audit):
```sql
create table if not exists password_reset_tokens (
  resetid bigint generated always as identity primary key,
  userid int not null references users(userid) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used boolean not null default false,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_password_reset_tokens_userid on password_reset_tokens(userid);
```

Suggested backend changes when migrating from in-memory to table:
* Replace `_reset_tokens` dict lookups with `rest_select` on `password_reset_tokens`.
* On issuance: `rest_insert` new row with `token_hash` & `expires_at`.
* On success: `rest_update` row setting `used=true, used_at=now()` and optionally scramble hash.
* Add periodic cleanup job (cron or scheduled task) to delete rows where `expires_at < now() - interval '7 days'` AND `used=true`.

Security Notes:
* Always return generic `{status:"ok"}` from `forgot-password` to avoid user enumeration.
* Require minimum password length (currently 8) and reuse existing pepper variable.
* Consider adding rate limiting per IP/identifier for reset requests.
* When persistence is enabled, consider tracking `request_ip`, `user_agent` for audit.


## Endpoint Summary (Prefix `/api`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/courtinfo | None | List courts |
| GET | /api/courtinfo/{id} | None | Retrieve a court |
| GET | /api/notifications | None | List notifications (filters: `user_id`, `notificationtype`) |
| GET | /api/favorites | Bearer | List current user's favorites |
| POST | /api/favorites | Bearer | Add a favorite (`{ courtinfoid }`) |
| DELETE | /api/favorites/{courtinfoid} | Bearer | Remove favorite |
| GET | /api/profiles/{user_id} | None | Fetch profile by UUID |
| PATCH | /api/profiles/{user_id} | Bearer | Update your profile |
| GET | /api/courtbookings | None | List bookings (filters & pagination) |
| GET | /api/courtbookings/{courtbookingid} | None | Single booking |
| POST | /api/courtbookings | Bearer | Create booking (auto inject user) |
| GET | /api/events | None | List events (filters: organizerid, status, courtbookingid) |
| GET | /api/events/{eventid} | None | Single event |
| POST | /api/events | Bearer | Create event (validated ownership & duplicate check) |
| POST | /api/events/create_with_info | Bearer | Atomic create of event + eventinfo (monetization logic) |
| GET | /api/eventinfo | None | List event info rows (filter: eventid) |
| GET | /api/eventinfo/{eventinfoid} | None | Single event info |
| POST | /api/eventinfo | Bearer | Create event info (requires existing event) |
| GET | /api/eventbookings | None | List event bookings |
| GET | /api/eventbookings/{eventbookingid} | None | Single event booking |
| POST | /api/eventbookings | Bearer | Create event booking |
| GET | /api/trainingsessions | None | List training sessions |
| GET | /api/trainingsessions/{sessionid} | None | Single session |
| GET | /api/history?userid=<id> | None | Aggregated user history |
| GET | /api/userinfo | None | Raw userinfo rows |
| GET | /api/userlogin | None | Raw userlogin rows |
| GET | /api/users | None | Raw users rows |


## Pagination

Endpoints supporting pagination accept `limit` (1-200) and `offset` (>=0). Example:

```
GET /api/courtbookings?userid=5&limit=20&offset=0
```

## Event Creation Flow

Events are tied 1:1 to an existing court booking. A user must first create a court booking (owning the `courtbookingid`) and then create an event referencing that booking.

Key validation rules enforced by backend:
* You must own the referenced `courtbookingid`.
* Only one event may exist per `courtbookingid`.
* Optional `time` must lie within the booking's `[start_timestamp, end_timestamp]` window. If omitted, booking start time is used.
* Default `status` is `upcoming`.

Monetization logic (in combined endpoint):
* Provide `monetize: true` to enable payment fields.
* Required when monetized: `entry_fee` (numeric), `payment_methods` (array or string among `cash`, `vnpay`, `both`).
* When monetized, `support_payment_method` is derived (`cash` | `vnpay` | `both`).
* When not monetized, `support_payment_method` is `null` and `entry_fee` may be omitted.
* `numberofpeople` starts at `0`; `join_status` starts `true` and will be flipped to `false` later once `numberofpeople == participants_cap`.

### Simple Event Creation

```
POST /api/events
Authorization: Bearer <token>
{
  "courtbookingid": 101,
  "time": "2025-11-26T09:30:00",
  "status": "upcoming"
}
```

Response:
```
{
  "eventid": 55,
  "time": "2025-11-26T09:30:00",
  "courtbookingid": 101,
  "status": "upcoming",
  "organizerid": 7
}
```

### Atomic Event + Info Creation (Recommended)

```
POST /api/events/create_with_info
Authorization: Bearer <token>
{
  "courtbookingid": 101,
  "time": "2025-11-26T09:30:00",
  "title": "Morning Pickup Basketball",
  "description": "Casual full-court run. Bring your A game!",
  "participants_cap": 10,
  "monetize": true,
  "entry_fee": 30000,
  "payment_methods": ["cash", "vnpay"]
}
```

Response:
```
{
  "event": {
    "eventid": 55,
    "time": "2025-11-26T09:30:00",
    "courtbookingid": 101,
    "status": "upcoming",
    "organizerid": 7
  },
  "eventinfo": {
    "eventinfoid": 88,
    "eventid": 55,
    "numberofpeople": 0,
    "description": "Casual full-court run. Bring your A game!",
    "title": "Morning Pickup Basketball",
    "entry_fee": 30000,
    "support_payment_method": "both",
    "participants_cap": 10,
    "join_status": true
  }
}
```

### Non-Monetized Variant

```
POST /api/events/create_with_info
Authorization: Bearer <token>
{
  "courtbookingid": 102,
  "title": "Free Tennis Rally",
  "participants_cap": 4,
  "monetize": false
}
```

Response will have `entry_fee: null` and `support_payment_method: null`.

### Frontend Submission Outline

1. Fetch user court bookings: `GET /api/courtbookings?userid=<currentUserId>`.
2. Let user pick a booking (expandable list UI).
3. Collect form fields: title, description, participants_cap, monetize flag.
4. If monetized: entry fee input + payment method toggles (cash / vnpay).
5. POST to `/api/events/create_with_info` with bearer token.
6. On success, navigate to event detail screen using returned `event.eventid`.

Error handling guidelines:
* 403 → booking not owned; show message "You must select one of your bookings.".
* 409 → duplicate event; offer to view existing event instead of creating.
* 422 → validation issue; display server detail inline near form fields.

### Updating Number of People & Join Status (Future)

Later when implementing event bookings, increment `eventinfo.numberofpeople` and set `join_status=false` if it reaches `participants_cap`. This can be done with a PATCH on `eventinfo` filtered by `eventid`.


## CORS

If you see CORS errors from the frontend, append its origin to `ALLOWED_ORIGINS` and restart Uvicorn.

## Next Improvement Ideas

1. Flatten directory: move `backend/backend/app` → `backend/app` and `requirements.txt` → `backend/requirements.txt`.
2. Add basic pytest suite (e.g. health & one endpoint).
3. Introduce rate limiting (e.g. slowapi) for write endpoints.
4. Replace HS256 fallback with mandatory JWKS once Supabase enables RS256.
5. Add startup sequence alignment health check (see below).

## Sequence Alignment (Prevent Overwrites)

If you imported seed data manually, make sure the underlying Postgres sequences advance past the current max primary key to avoid accidental overwrites (especially now that inserts are strict).

Run in Supabase SQL editor once after seeding:

```sql
-- Court bookings: next value should be max(courtbookingid)+1 (existing max assumed 30)
select setval('courtbooking_courtbookingid_seq', (select coalesce(max(courtbookingid),0)+1 from courtbooking), false);

-- Payments: advance sequence (existing max assumed 31)
select setval('payments_paymentid_seq', (select coalesce(max(paymentid),0)+1 from payments), false);
```

Verify:
```sql
select max(courtbookingid) as max_id, nextval('courtbooking_courtbookingid_seq') as next_after_fix from courtbooking;
select max(paymentid) as max_id, nextval('payments_paymentid_seq') as next_after_fix from payments;
```

Notes:
* Passing `false` as third arg means the sequence returns the exact value you set on the first `nextval` after the fix (so if max was 30, `nextval` returns 31).
* If you use `true`, `nextval` will advance again (return 32 in that example). Use `false` for intuitive "next = max+1".
* After alignment, inserts will append without touching existing seed rows because the backend now uses strict inserts (no upsert merge).

Optional RPC helper (create once) to align a sequence generically:
```sql
create or replace function ensure_sequence(seq regclass, tbl text, pk text)
returns bigint language plpgsql as $$
declare m bigint;
begin
  execute format('select max(%I) from %I', pk, tbl) into m;
  if m is null then m := 0; end if;
  perform setval(seq::text, m+1, false);
  return m+1;
end;$$;
```
Call via PostgREST:
`POST /rest/v1/rpc/ensure_sequence { "seq":"courtbooking_courtbookingid_seq", "tbl":"courtbooking", "pk":"courtbookingid" }`

---

## Contributing

Branch from the working backend branch, keep dependencies pinned in `requirements.txt`, and include tests for any new routers.

---
Backend ready. 🚀
