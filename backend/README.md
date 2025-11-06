# SportsConnect Backend (FastAPI + Supabase)

This backend provides a thin API layer over Supabase for the SportsConnect mobile app.

## Features
- Court info listing (`/api/courtinfo`)
- Notifications listing with optional category filter (`/api/notifications`)
- User profile fetch (`/api/profiles/{user_id}`)
- Favorites list/add/remove (`/api/favorites`) backed by `user_favorites` table
- CORS enabled for Expo development

## Setup

1. Create a Python virtual environment (Windows PowerShell):
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```
2. Install dependencies:
```powershell
pip install -r backend/requirements.txt
```
3. Copy env example and fill in real values (service role key kept secret):
```powershell
Copy-Item backend/.env.example backend/.env
```
Edit `backend/.env` with:
- `SUPABASE_URL` (Project URL)
- `SUPABASE_SERVICE_ROLE_KEY` (Service role key, treat as secret)
- `ALLOWED_ORIGINS` (Comma-separated origins for CORS)

## Run
```powershell
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```
API root: http://localhost:8000
Docs: http://localhost:8000/docs

## Security Notes
- Never expose the service role key to the client. Keep it only in backend `.env`.
- Consider adding a JWT layer or Supabase auth verification (pass access token from client and verify).

## Future Improvements
- Token-based auth dependency to protect write operations.
- Pagination & caching.
- Rate limiting.
- Background tasks for notifications.
