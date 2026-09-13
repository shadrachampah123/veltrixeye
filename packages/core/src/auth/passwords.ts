import argon2 from 'argon2';

/**
 * Password hashing — Argon2id (OWASP-recommended parameters).
 * The hash string is self-describing (parameters encoded in the PHC string),
 * so future parameter upgrades verify old hashes correctly.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/** Constant-time verification performed by argon2.verify. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed stored hash — treat as auth failure, never throw.
    return false;
  }
}
