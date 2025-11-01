# Backend Demo Assumptions & Next Steps

## Assumptions
1. Tables `events` and `bookings` exist in Supabase.
2. `events` has columns: `id (int, PK)`, `title`, `description`, `location`, `sport`, `starts_at`, `capacity`, `host_user_id` (optional).
3. `bookings` has columns: `id (int, PK)`, `event_id (int, FK)`, `user_id`.
4. Anonymous key (or service key) has permission to read/write these tables (RLS policies allow it for demo or disabled during development).
5. Datetime stored as text/ISO string or `timestamptz` — Pydantic currently treats it as `str` for simplicity; adjust to `datetime` if preferred.

## How to Adjust
- If your column names differ, update `schemas.py` and the `insert`/`select` payloads in `main.py`.
- Add new endpoints by following the existing pattern: create Pydantic schema -> implement route -> call `sb.table("<table>")` operations.

## Security Hardening (Future)
- Replace anon key usage with per-user JWT from the mobile app; forward `Authorization: Bearer <token>` header.
- Enforce RLS policies for row-level access.
- Restrict CORS origins to known domains / development hosts.
- Store service role key only in secure backend environments (never ship to client).

## Potential Enhancements
- Pagination & filtering for `/events` (use `.range()` and `.eq()` / `.ilike()`).
- Update & delete endpoints for events and bookings.
- Full auth integration (session validation, user profile sync).
- Background tasks (e.g., auto-expire past events) using FastAPI's `BackgroundTasks` or a scheduler.
- WebSocket endpoint for live updates.

## Testing
- Add `pytest` and create tests for each route using FastAPI's `TestClient`.

---
Feel free to ask for any of these enhancements and they can be scaffolded quickly.
