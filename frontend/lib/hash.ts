// lib/hash.ts
// Deterministic SHA-256 hashing for passwords before sending to backend.
// NOTE: This is only a transport obfuscation layer. Real security should hash & salt server-side (e.g., bcrypt/argon2) and never rely on client hashing alone.

import * as Crypto from 'expo-crypto';

/**
 * Hash a raw password string using SHA-256.
 * Returns a hex digest (lowercase) suitable for equality comparison on server.
 */
export async function hashPassword(raw: string): Promise<string> {
  if (typeof raw !== 'string') return '';
  return await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    raw,
    { encoding: Crypto.CryptoEncoding.HEX }
  );
}
