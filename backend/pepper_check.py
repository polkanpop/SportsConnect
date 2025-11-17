import os
import hashlib
import secrets
from dotenv import load_dotenv
import bcrypt

# Load the .env that sits alongside this script (backend/.env)
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

def _norm(val: str) -> str:
	return (val or "").strip().strip('"').strip("'")

PASSWORD_PEPPER = _norm(os.getenv("PASSWORD_PEPPER", ""))
REFRESH_TOKEN_PEPPER = _norm(os.getenv("REFRESH_TOKEN_PEPPER", ""))

pw = "MyS3cret!"
print("Loaded PASSWORD_PEPPER:", bool(PASSWORD_PEPPER))
print("Loaded REFRESH_TOKEN_PEPPER:", bool(REFRESH_TOKEN_PEPPER))

# ---------------- Password Pepper Checks ----------------
print("\n== Password Pepper Tests ==")
h_no_pepper = bcrypt.hashpw(pw.encode(), bcrypt.gensalt())
h_with_pepper = bcrypt.hashpw((pw + PASSWORD_PEPPER).encode(), bcrypt.gensalt())

print("Hash no-pepper  :", h_no_pepper.decode())
print("Hash with-pepper:", h_with_pepper.decode())
print("verify no-pepper w/o pepper:", bcrypt.checkpw(pw.encode(), h_no_pepper))
print("verify no-pepper with pepper:", bcrypt.checkpw((pw + PASSWORD_PEPPER).encode(), h_no_pepper))
print("verify with-pepper w/o pepper:", bcrypt.checkpw(pw.encode(), h_with_pepper))
print("verify with-pepper with pepper:", bcrypt.checkpw((pw + PASSWORD_PEPPER).encode(), h_with_pepper))

# ---------------- Refresh Token Pepper Checks ----------------
print("\n== Refresh Token Pepper Tests ==")

def hash_refresh_token(token: str, pepper: str) -> str:
	h = hashlib.sha256()
	h.update(token.encode())
	h.update(pepper.encode())
	return h.hexdigest()

refresh_token = secrets.token_urlsafe(32)
hash_with = hash_refresh_token(refresh_token, REFRESH_TOKEN_PEPPER)
hash_without = hash_refresh_token(refresh_token, "")

print("Sample refresh token        :", refresh_token)
print("Hash with REFRESH_TOKEN_PEPPER:", hash_with)
print("Hash without pepper           :", hash_without)
print("Hashes differ (expected)      :", hash_with != hash_without)

# Determinism check (recompute should match)
recalc = hash_refresh_token(refresh_token, REFRESH_TOKEN_PEPPER)
print("Deterministic recompute match :", recalc == hash_with)

# Negative checks
mutated_token = refresh_token + "x"
mutated_hash = hash_refresh_token(mutated_token, REFRESH_TOKEN_PEPPER)
print("Different token -> different hash:", mutated_hash != hash_with)

mutated_pepper = REFRESH_TOKEN_PEPPER + "x"
mutated_pepper_hash = hash_refresh_token(refresh_token, mutated_pepper)
print("Different pepper -> different hash:", mutated_pepper_hash != hash_with)

if not PASSWORD_PEPPER:
	print("WARNING: PASSWORD_PEPPER is empty; password peppering inactive.")
if not REFRESH_TOKEN_PEPPER:
	print("WARNING: REFRESH_TOKEN_PEPPER is empty; refresh token peppering inactive.")

print("\nAll tests complete.")