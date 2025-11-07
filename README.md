# SportsConnect - Development and Testing Setup

This document describes how to set up the local development environment for both the Backend (FastAPI) and the Frontend (Expo/React Native), and how to verify everything is working across devices on your local network.

## Prerequisites
- Git, Python 3.10+ (recommended), and pip
- Node.js 18+ and npm
- Expo CLI (via npx) and a mobile device with Expo Go installed (or iOS/Android simulator)
- Both your development machine and your phone on the same Wi‑Fi network

Network and Local IP
Throughout this guide you will need your computer’s local IPv4 address (LAN IP), e.g. 192.168.1.37. On Windows you can find it by running ipconfig and using the IPv4 Address on your active adapter.

## Backend Setup (FastAPI)
Directory layout (relevant paths):
- /backend          -> outer backend folder (contains .env and requirements.txt)
- /backend/backend  -> inner backend app folder (contains the FastAPI app)

1) Configure /backend/.env (outer one)
- Ensure the following variable includes your machine’s local IPv4 address:
  
  `ALLOWED_ORIGINS=http://<YOUR_IPV4>:19000,http://<YOUR_IPV4>:19006,http://localhost:19006,http://localhost:19000`
  
  Notes:
  - Include all origins you intend to use (Expo web, Metro dev server, etc.).
  - Replace <YOUR_IPV4> with your actual local IPv4 address.

2) Create and activate a virtual environment in /backend/backend (inner one)
- Open a terminal at the repository root and run:
  
  Windows (cmd):
    
    `cd backend\backend`
    
    `python -m venv .venv`
    
    `.venv\Scripts\activate`
  
  PowerShell:
    
    `cd backend/backend`
    
    `python -m venv .venv`
    
    `.\.venv\Scripts\Activate.ps1`

  macOS/Linux:

    `cd backend/backend`

    `python3 -m venv .venv`

    `source .venv/bin/activate`

3) Install dependencies
- From /backend/backend with the venv active, install requirements from the INNER backend requirements file (fresh install):
    
    `pip install -r requirements.txt`
  

4) Run the backend server
- From /backend/backend with the venv active:
    
    `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`
- The API should now be reachable on http://<YOUR_IPV4>:8000 and http://localhost:8000 from your PC.

5) Verify the backend from your phone
- Make sure your phone is on the same Wi‑Fi network as your PC.
- Open your mobile browser and visit:
    
    `http://<YOUR_IPV4>:8000/docs`
- If you see the FastAPI docs (Swagger UI with endpoints), the backend is working and accessible on your LAN.

## Frontend Setup (Expo/React Native)
1) Create /frontend/.env
- Create a .env file inside the frontend folder. Use the details shared in #general on Discord.
- The API base URL MUST use your computer’s local IPv4 so the phone can reach it. Example:
    
    `EXPO_PUBLIC_API_BASE_URL="http://<YOUR_IPV4>:8000/api"`
  Replace <YOUR_IPV4> with your actual local IPv4 address (e.g., 192.168.1.37).

2) Install frontend dependencies
- From the repository root:
    
    `cd frontend`
    
    `npm install --legacy-peer-deps`

3) Start the frontend (Expo)
- From /frontend:
    
    `npx expo start -c`
- Use Expo Go on your device (or a simulator) to open the project by scanning the QR code. Ensure the device is on the same Wi‑Fi network as your PC.

## End-to-End Test Checklist
- Backend running at http://<YOUR_IPV4>:8000 (Uvicorn console shows reloads and requests)
- Visit http://<YOUR_IPV4>:8000/docs on your phone → API docs load
- Frontend started via npx expo start -c
- Frontend .env set to EXPO_PUBLIC_API_BASE_URL="http://<YOUR_IPV4>:8000/api"
- In the app, perform an action that hits the API (e.g., signup) and confirm success



## Quick Commands Reference

### Backend
- `cd backend/backend`
- `python -m venv .venv`
- `.venv\Scripts\activate`  (Windows) 
- `source .venv/bin/activate` (macOS/Linux)
- `pip install -r ..\requirements.txt`
- `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`

### Frontend
- `cd frontend`
- `npm install --legacy-peer-deps`
- `npx expo start -c`

 That should be it.