import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  authorizeStaff,
  type AuthAssuranceLevel,
  type StaffAction,
  type StaffIdentity,
} from "@/domain/authorization";

export interface VerifiedStaffToken {
  authUserId: string;
  email: string;
  assuranceLevel: AuthAssuranceLevel;
}

export class StaffAuthorizationError extends Error {
  constructor(
    public readonly code:
      | "AUTH_REQUIRED"
      | "TOKEN_INVALID"
      | "STAFF_NOT_FOUND"
      | "STAFF_INACTIVE"
      | "MFA_REQUIRED"
      | "FORBIDDEN",
    public readonly status: 401 | 403,
  ) {
    super(code);
  }
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifySupabaseAccessToken(
  token: string,
  supabaseUrl = requiredEnvironment("SUPABASE_URL"),
): Promise<VerifiedStaffToken> {
  const normalizedUrl = supabaseUrl.replace(/\/$/, "");
  const jwksUrl = `${normalizedUrl}/auth/v1/.well-known/jwks.json`;
  const jwks = jwksByUrl.get(jwksUrl) ?? createRemoteJWKSet(new URL(jwksUrl));
  jwksByUrl.set(jwksUrl, jwks);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${normalizedUrl}/auth/v1`,
      audience: "authenticated",
    });
    return staffTokenFromClaims(payload);
  } catch {
    throw new StaffAuthorizationError("TOKEN_INVALID", 401);
  }
}

export function staffTokenFromClaims(payload: JWTPayload): VerifiedStaffToken {
  if (
    typeof payload.sub !== "string" ||
    typeof payload.email !== "string" ||
    payload.role !== "authenticated" ||
    payload.is_anonymous === true
  ) {
    throw new StaffAuthorizationError("TOKEN_INVALID", 401);
  }
  const aal = payload.aal ?? "aal1";
  if (aal !== "aal1" && aal !== "aal2") {
    throw new StaffAuthorizationError("TOKEN_INVALID", 401);
  }
  return { authUserId: payload.sub, email: payload.email, assuranceLevel: aal };
}

export async function requireStaffAuthorization(
  authorizationHeader: string | null,
  action: StaffAction,
  dependencies: {
    verifyToken?: (token: string) => Promise<VerifiedStaffToken>;
    findStaffByAuthUserId: (authUserId: string) => Promise<StaffIdentity | null>;
  },
): Promise<StaffIdentity> {
  const token = bearerToken(authorizationHeader);
  const verified = await (dependencies.verifyToken ?? verifySupabaseAccessToken)(token);
  const staff = await dependencies.findStaffByAuthUserId(verified.authUserId);
  if (!staff) throw new StaffAuthorizationError("STAFF_NOT_FOUND", 403);

  const decision = authorizeStaff(staff, verified.assuranceLevel, action);
  if (!decision.allowed) throw new StaffAuthorizationError(decision.code, 403);
  return staff;
}

function bearerToken(header: string | null): string {
  if (!header?.startsWith("Bearer ") || header.length <= 7) {
    throw new StaffAuthorizationError("AUTH_REQUIRED", 401);
  }
  return header.slice(7);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for staff authentication.`);
  return value;
}
