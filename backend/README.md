# FastAPI Demo Backend

This folder contains a minimal FastAPI demo server that connects to your existing Supabase project.

Implemented demo endpoints:
1. `GET /health` – simple health/config check
2. `GET /events` – list events (table: `events`)
3. `POST /events` – create an event (table: `events`)
4. `GET /events/{id}` – fetch one event by id
5. `POST /bookings` – create a booking (table: `bookings`)

> NOTE: Table/column names are assumptions. Adjust them to match your Supabase schema.

## 1. Setup (Windows PowerShell)

From the repository root:

```powershell
cd backend
python -m venv .venv
./.venv/Scripts/Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env to add your actual values
notepad .env
```

Fill `.env` with:

```env
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_ANON_KEY=YOUR_ANON_OR_SERVICE_ROLE_KEY
```

## 2. Run the server

```powershell
uvicorn main:app --reload --port 8000
```

Navigate to:
- Swagger UI: http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc

## 3. Example requests

Create an event:
```bash
curl -X POST http://127.0.0.1:8000/events \
	-H "Content-Type: application/json" \
	-d '{"title":"Morning Game","description":"Pickup","sport":"soccer","capacity":10}'
```

List events:
```bash
curl http://127.0.0.1:8000/events
```

Create booking:
```bash
curl -X POST http://127.0.0.1:8000/bookings \
	-H "Content-Type: application/json" \
	-d '{"event_id":1, "user_id":"uuid-or-user-id"}'
```

## 4. Modifying schema

If your Supabase tables have different columns, just edit:
- `schemas.py` (Pydantic models)
- Column lists in `main.py` queries if you limit selected columns

## 5. Adding authentication (future)

For demo simplicity, endpoints use an anon/service key. For protected routes you could:
- Accept a Bearer JWT from the Expo app (Supabase client auth session)
- Validate with Supabase's JWT secret or rely on Row Level Security policies

## 6. Common issues

| Issue | Fix |
|-------|-----|
| Import errors for `supabase` | Ensure virtualenv activated & `pip install -r requirements.txt` |
| 404 on event by id | Verify `id` exists; check table name or `id` column casing |
| 500 Supabase error | Check network, keys, and table RLS policies |

## 7. Next ideas

- Add pagination to `/events`
- Add filtering (sport, date range)
- Integrate auth (user context from JWT)
- Add update/delete endpoints

---

Happy building!
