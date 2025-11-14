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
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"   # keep secret
SUPABASE_ANON_KEY="<anon-key>"                   # optional if validating anon tokens
ALLOWED_ORIGINS="http://localhost:8081,http://localhost:19006"
```
Add additional origins for real devices (e.g. `http://192.168.1.<X>:8081`).

## Auth

Endpoints requiring user context expect an `Authorization: Bearer <supabase-access-token>` header. Token verification supports JWKS (if available) or falls back to HS256 using the service role / anon key.

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

## Creation Example

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
