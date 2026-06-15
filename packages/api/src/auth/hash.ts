/**
 * hash.ts — Password hashing and verification using argon2id.
 *
 * Uses @node-rs/argon2 (Rust-backed, no native build step required).
 *
 * ALGORITHM PARAMETERS (OWASP-aligned argon2id defaults):
 *   - memoryCost: 19456 KiB (~19 MiB)  — OWASP minimum for argon2id
 *   - timeCost:   2 iterations         — OWASP minimum
 *   - parallelism: 1 thread
 *   - outputLen:  32 bytes (256 bits)
 *
 * The encoded string format is:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * SECURITY RULES:
 *   - Never log or return the plaintext password.
 *   - Never return the hash to callers outside of verifyCredential.
 *   - hashPassword is exported so test seed helpers can generate real hashes.
 */
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-aligned argon2id parameters.
 *
 * memoryCost is in KiB: 19456 KiB = 19 MiB.
 * OWASP ASVS v4 recommends m >= 19456, t >= 2, p >= 1 for argon2id.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB — 19 MiB
  timeCost: 2,       // iterations
  parallelism: 1,    // threads
  outputLen: 32,     // bytes
} as const;

/**
 * hashPassword — hashes a plaintext password using argon2id.
 *
 * Returns an argon2id encoded string suitable for storage in auth_credential.password_hash.
 * Exported so that test seeds can generate real hashes; NEVER called in the
 * hot request path (use verifyCredential, which calls verifyPassword internally).
 *
 * @param plain - The plaintext password. Never logged or returned.
 * @returns An argon2id encoded string (includes algorithm, params, salt, and hash).
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * verifyPassword — constant-time verification of a plaintext against a stored hash.
 *
 * Uses @node-rs/argon2's built-in constant-time comparison.
 * Returns false on any verification failure (wrong password, malformed hash).
 *
 * NOTE: Never log the result alongside any user identifier beyond a boolean;
 * and never reveal which lookup step failed (handled by verifyCredential's
 * anti-enumeration logic).
 *
 * @param storedHash - The argon2id encoded string from auth_credential.
 * @param plain      - The candidate plaintext password. Never logged.
 * @returns true if the password matches, false otherwise.
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    // Malformed hash or argon2 internal error — treat as verification failure.
    return false;
  }
}

/**
 * DUMMY_HASH — a pre-computed argon2id hash of a fixed dummy password.
 *
 * Used by verifyCredential for anti-enumeration timing equalization:
 * when a user, credential, or membership lookup fails, we still call
 * verifyPassword against this constant hash so that missing-user paths
 * take approximately the same wall-clock time as a real hash comparison.
 *
 * Value: argon2id hash of the string "aeroops-timing-equalization-dummy"
 * with the standard ARGON2_OPTIONS above.
 *
 * This constant is internal; callers must NOT use it to authenticate.
 *
 * IMPORTANT: This is lazily initialized on first use to avoid blocking
 * module load. The init runs once per process lifecycle.
 */
let _dummyHashCache: string | null = null;
const DUMMY_PLAINTEXT = 'aeroops-timing-equalization-dummy-v1';

export async function getDummyHash(): Promise<string> {
  if (_dummyHashCache === null) {
    _dummyHashCache = await hashPassword(DUMMY_PLAINTEXT);
  }
  return _dummyHashCache;
}
