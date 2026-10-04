// Constant-time string comparison for shared secrets (CRON_SECRET, the
// service-role key in X-Service-Key). A plain === returns as soon as one
// character differs, so response timing can leak a secret's prefix.
//
// An empty value never matches: an unset secret must fail closed, never let
// an empty bearer through.
export function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
