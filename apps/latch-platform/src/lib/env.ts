/**
 * A secret from the environment with a dev-only fallback. Long-lived secrets
 * (signing keys, the Vault master key) must never silently fall back to a
 * public default in production — fail closed instead.
 */
export function secretEnv(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set in production`);
  }
  return devFallback;
}
