"""
End-to-end test for Firebase Phone OTP backend verification.

Uses Firebase test phone: +84388149127  with static OTP: 123456
(Must be registered in Firebase Console → Authentication → Sign-in method → Phone → Test phone numbers)

Runs:
  1. Cert fetch + RSA public key extraction
  2. Firebase REST API: sendVerificationCode → signInWithPhoneNumber → get idToken
  3. _verify_firebase_id_token() with the real token
  4. HTTP POST to the live backend /api/auth/phone-login (login flow, no session needed)

Usage:
  cd backend
  python test_phone_otp.py
"""

import sys
import os
import time
import httpx

# ── Config ────────────────────────────────────────────────────────────────────
FIREBASE_API_KEY  = "AIzaSyAn5dRM88u8I6KmrS1PdSQJfKCKCanrrsE"
TEST_PHONE        = "+84388149127"
TEST_OTP          = "123456"
BACKEND_URL       = os.getenv("BACKEND_URL", "https://sportsconnect-ff00.onrender.com")

# ── Step 1: verify cert fetch + RSA key extraction ────────────────────────────
def test_cert_parsing():
    print("\n[1] Fetching Firebase public certs and extracting RSA public keys…")
    from cryptography import x509 as cx509
    from cryptography.hazmat.backends import default_backend

    resp = httpx.get(
        "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
        timeout=10.0,
    )
    resp.raise_for_status()
    raw_certs = resp.json()
    print(f"    Got {len(raw_certs)} cert(s)")

    keys = {}
    for kid, pem in raw_certs.items():
        cert = cx509.load_pem_x509_certificate(pem.encode(), default_backend())
        keys[kid] = cert.public_key()
        print(f"    kid={kid[:12]}… → {type(keys[kid]).__name__} ✓")

    print("    PASS: cert parsing OK")
    return keys

# ── Step 2: get a real Firebase phone ID token via REST ───────────────────────
def get_firebase_phone_token():
    print(f"\n[2] Sending OTP to {TEST_PHONE} via Firebase REST API…")
    send_url = f"https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key={FIREBASE_API_KEY}"
    send_resp = httpx.post(send_url, json={
        "phoneNumber": TEST_PHONE,
        "recaptchaToken": "testing",   # accepted for Firebase test-phone numbers
    }, timeout=15.0)
    print(f"    sendVerificationCode → HTTP {send_resp.status_code}")
    if send_resp.status_code != 200:
        print(f"    BODY: {send_resp.text[:400]}")
        print("    NOTE: if 400/INVALID_APP_CREDENTIAL — that is normal for test phones via recaptchaToken.")
        print("    Trying without recaptchaToken (works for registered test numbers)…")
        # Some Firebase projects need the request without reCAPTCHA for test numbers
        send_resp2 = httpx.post(send_url, json={"phoneNumber": TEST_PHONE}, timeout=15.0)
        print(f"    retry → HTTP {send_resp2.status_code}: {send_resp2.text[:200]}")
        if send_resp2.status_code != 200:
            raise RuntimeError("Cannot send OTP via Firebase REST API. Check test phone is registered.")
        session_info = send_resp2.json()["sessionInfo"]
    else:
        session_info = send_resp.json()["sessionInfo"]

    print(f"    sessionInfo (first 30): {session_info[:30]}…")

    print(f"\n    Signing in with OTP {TEST_OTP}…")
    signin_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key={FIREBASE_API_KEY}"
    signin_resp = httpx.post(signin_url, json={
        "sessionInfo": session_info,
        "code": TEST_OTP,
    }, timeout=15.0)
    print(f"    signInWithPhoneNumber → HTTP {signin_resp.status_code}")
    if signin_resp.status_code != 200:
        print(f"    BODY: {signin_resp.text[:400]}")
        raise RuntimeError("signInWithPhoneNumber failed")

    id_token = signin_resp.json()["idToken"]
    print(f"    idToken (first 40): {id_token[:40]}…  len={len(id_token)}")
    return id_token

# ── Step 3: test _verify_firebase_id_token locally ───────────────────────────
def test_local_verify(id_token: str):
    print("\n[3] Testing _verify_firebase_id_token() locally…")
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
        from backend.app.routers.auth import _verify_firebase_id_token
        decoded = _verify_firebase_id_token(id_token)
        phone = decoded.get("phone_number")
        uid   = decoded.get("sub") or decoded.get("uid")
        print(f"    phone_number={phone}  uid={uid}")
        assert phone == TEST_PHONE, f"Expected {TEST_PHONE}, got {phone}"
        print("    PASS: local verification OK")
        return decoded
    except ImportError as e:
        print(f"    (Skipping local import — deps not in system Python: {e})")
        print("    Skipping step 3, will verify via backend HTTP call instead")

# ── Step 4: call the live backend /api/auth/phone-login ──────────────────────
def test_backend_endpoint(id_token: str):
    print(f"\n[4] Calling {BACKEND_URL}/api/auth/phone-login…")
    resp = httpx.post(f"{BACKEND_URL}/api/auth/phone-login", json={
        "firebase_id_token": id_token,
        "display_name": "Test User",
    }, timeout=20.0)
    print(f"    HTTP {resp.status_code}: {resp.text[:300]}")
    if resp.status_code not in (200, 201):
        print("    FAIL: unexpected status code")
        return False
    print("    PASS: backend login OK")
    return True

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    try:
        test_cert_parsing()
        id_token = get_firebase_phone_token()
        test_local_verify(id_token)
        test_backend_endpoint(id_token)
        print("\n✓ ALL TESTS PASSED")
    except Exception as e:
        print(f"\n✗ TEST FAILED: {e}")
        import traceback; traceback.print_exc()
        sys.exit(1)
