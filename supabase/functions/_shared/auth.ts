/**
 * Caller authorization helper.
 *
 * Each business-action edge function (plan-logistics, generate-schedule,
 * record-quality, crisis-alert) is gated on the caller's user_profiles.role.
 *
 * Accepts either:
 *   - a real user JWT (looked up via supabase.auth.getUser → user_profiles.role)
 *   - the project service_role key (treated as universal admin — used by
 *     internal smoke tests and trusted edge-to-edge calls)
 *
 * Returns the role string ("Owner" / "Manager" / "Merchandiser" /
 * "QC Inspector" / "Viewer" / "Supplier" / "SERVICE_ROLE"), or null when
 * the auth header is absent or invalid.
 */

export const SERVICE_ROLE_SENTINEL = "SERVICE_ROLE";

export interface CallerIdentity {
  role: string | null;
  user_id: string | null;
  is_service_role: boolean;
}

/**
 * Decode the role claim from a Supabase JWT without verifying the signature.
 * Safe to use only AFTER Supabase's gateway has verified the token (verify_jwt = true).
 * Returns null if the JWT can't be parsed.
 */
function readRoleClaim(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
    const decoded = JSON.parse(atob(padded));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

export async function getCallerIdentity(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  authHeader: string | null,
  serviceRoleKey: string,
): Promise<CallerIdentity> {
  if (!authHeader) return { role: null, user_id: null, is_service_role: false };

  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return { role: null, user_id: null, is_service_role: false };

  // Service-role bypass:
  //   (a) exact env match — current canonical path
  //   (b) JWT's "role" claim equals "service_role" — handles dual-key formats
  //       (legacy JWT vs the new sb_secret_…)
  if (jwt === serviceRoleKey || readRoleClaim(jwt) === "service_role") {
    return { role: SERVICE_ROLE_SENTINEL, user_id: null, is_service_role: true };
  }

  // Real user JWT: resolve to user_profiles.role
  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return { role: null, user_id: null, is_service_role: false };
    }
    const { data: profile, error: profErr } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (profErr || !profile) {
      return { role: null, user_id: userData.user.id, is_service_role: false };
    }
    return { role: profile.role as string, user_id: userData.user.id, is_service_role: false };
  } catch {
    return { role: null, user_id: null, is_service_role: false };
  }
}

/** True if the caller is allowed; service role is always allowed. */
export function callerHasRole(identity: CallerIdentity, allowedRoles: string[]): boolean {
  if (identity.is_service_role) return true;
  return identity.role !== null && allowedRoles.includes(identity.role);
}

export function unauthorizedResponse(identity: CallerIdentity, required: string[]): {
  error: string;
  status: number;
} {
  if (!identity.role) return { error: "missing or invalid Authorization header", status: 401 };
  return {
    error: `caller role "${identity.role}" not authorized; requires one of: ${required.join(", ")}`,
    status: 403,
  };
}
