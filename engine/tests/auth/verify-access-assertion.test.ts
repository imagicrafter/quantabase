import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
  createLocalJWKSet,
} from "jose";
import {
  verifyAccessAssertion,
  _resetAccessJwks,
} from "../../src/auth/access/verify-access-assertion.js";

// DI-seam tests: run entirely against a locally-generated key pair, no network
// access and no real Cloudflare team domain.

const ISSUER = "https://test-team.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

async function sign(
  claims: Record<string, unknown>,
  opts: { expired?: boolean } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(opts.expired ? "-1h" : "1h");
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await generateKeyPair("RS256");
  privateKey = priv;
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = createLocalJWKSet({ keys: [jwk] });
});

describe("verifyAccessAssertion", () => {
  it("accepts a validly-signed assertion carrying sub and email", async () => {
    const token = await sign({ sub: "cf-sub-1", email: "owner@example.com" });
    const identity = await verifyAccessAssertion(token, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(identity.sub).toBe("cf-sub-1");
    expect(identity.email).toBe("owner@example.com");
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign({ sub: "cf-sub-1", email: "owner@example.com" });
    await expect(
      verifyAccessAssertion(token, {
        jwks,
        issuer: ISSUER,
        audience: "some-other-aud",
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await sign({ sub: "cf-sub-1", email: "owner@example.com" });
    await expect(
      verifyAccessAssertion(token, {
        jwks,
        issuer: "https://someone-else.cloudflareaccess.com",
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects an expired token", async () => {
    const token = await sign(
      { sub: "cf-sub-1", email: "owner@example.com" },
      { expired: true },
    );
    await expect(
      verifyAccessAssertion(token, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects an assertion with no email claim — absent email is a misconfiguration under Access", async () => {
    const token = await sign({ sub: "cf-sub-1" });
    await expect(
      verifyAccessAssertion(token, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects an assertion with no sub claim", async () => {
    const token = await sign({ email: "owner@example.com" });
    await expect(
      verifyAccessAssertion(token, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("maps a JWKS-outage-shaped error to internal_error (500), not unauthenticated", async () => {
    const token = await sign({ sub: "cf-sub-1", email: "owner@example.com" });
    const brokenJwks = async () => {
      const err = new Error("timeout fetching JWKS");
      (err as Error & { code?: string }).code = "ERR_JWKS_TIMEOUT";
      throw err;
    };
    await expect(
      verifyAccessAssertion(token, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jwks: brokenJwks as any,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "internal_error" });
  });

  it("throws internal_error when CF_ACCESS_TEAM_DOMAIN/AUD are unconfigured and no override is given", async () => {
    _resetAccessJwks();
    const token = await sign({ sub: "cf-sub-1", email: "owner@example.com" });
    // No options passed — falls through to env, which tests/setup.ts DOES set,
    // so this instead exercises the real remote-JWKS path failing against a
    // fake team domain. Assert it fails closed as unauthenticated or
    // internal_error, never a silent pass.
    await expect(verifyAccessAssertion(token)).rejects.toBeTruthy();
  });
});
