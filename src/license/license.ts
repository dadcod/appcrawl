import { createPublicKey, verify as verifySig } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * AppCrawl licensing (offline, signature-based).
 *
 * The license is a compact token of the form:
 *   base64url(payloadJson).base64url(ed25519Signature)
 *
 * Payload shape:
 *   {
 *     email: string,        // who the license was issued to
 *     tier: "pro",          // always "pro" today; room for future tiers
 *     iat: number,          // issued-at unix seconds
 *     exp: number           // expiry unix seconds (typically iat + 365d)
 *   }
 *
 * The ed25519 public key below is BUNDLED with the CLI. The private
 * key never leaves my machine; it's used by the issuance script when
 * a Gumroad/LemonSqueezy webhook fires. Replacing the public key
 * invalidates every existing license — that's the point.
 *
 * Free tier: no license required, 5 runs/day tracked in
 * ~/.appcrawl/usage.json.
 */

// Ed25519 public key — used to verify license tokens offline.
// The matching private key is kept offline and used by the issuance
// script (scripts/issue-license.mts) when a payment webhook fires.
// Generate a new pair with:
//   node -e "const {generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('ed25519');console.log(publicKey.export({type:'spki',format:'pem'}));console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAI64IQKzdjsMlw7m5w1YpUXI9BJe9dlsfr87HO6Q4tKg=
-----END PUBLIC KEY-----`;

const FREE_TIER_DAILY_LIMIT = 5;

export interface LicenseStatus {
  tier: "free" | "pro";
  email: string | null;
  expiresAt: Date | null;
  source: "env" | "file" | "none";
  reason?: string;
}

/**
 * Resolve the user's licensing state. Checks APPCRAWL_LICENSE env var
 * first, then ~/.appcrawl/license file. Falls back to free tier if
 * neither is present or valid.
 */
export function getLicenseStatus(): LicenseStatus {
  const envToken = process.env.APPCRAWL_LICENSE?.trim();
  if (envToken) {
    const result = verifyLicense(envToken);
    if (result.valid) {
      return {
        tier: "pro",
        email: result.email,
        expiresAt: new Date(result.exp * 1000),
        source: "env",
      };
    }
    return {
      tier: "free",
      email: null,
      expiresAt: null,
      source: "env",
      reason: result.reason,
    };
  }

  const filePath = licenseFilePath();
  if (existsSync(filePath)) {
    const fileToken = readFileSync(filePath, "utf-8").trim();
    const result = verifyLicense(fileToken);
    if (result.valid) {
      return {
        tier: "pro",
        email: result.email,
        expiresAt: new Date(result.exp * 1000),
        source: "file",
      };
    }
    return {
      tier: "free",
      email: null,
      expiresAt: null,
      source: "file",
      reason: result.reason,
    };
  }

  return { tier: "free", email: null, expiresAt: null, source: "none" };
}

/**
 * Persist a license token to ~/.appcrawl/license. Verifies it first
 * so we don't save obvious garbage.
 */
export function saveLicense(token: string): LicenseStatus {
  const result = verifyLicense(token);
  if (!result.valid) {
    throw new Error(`Invalid license: ${result.reason}`);
  }
  const dir = join(homedir(), ".appcrawl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(licenseFilePath(), token.trim(), { mode: 0o600 });
  return {
    tier: "pro",
    email: result.email,
    expiresAt: new Date(result.exp * 1000),
    source: "file",
  };
}

interface VerifyResult {
  valid: boolean;
  email: string;
  tier: "pro";
  iat: number;
  exp: number;
  reason?: string;
}

function verifyLicense(token: string): VerifyResult {
  const fail = (reason: string): VerifyResult => ({
    valid: false,
    email: "",
    tier: "pro",
    iat: 0,
    exp: 0,
    reason,
  });

  const parts = token.split(".");
  if (parts.length !== 2) return fail("malformed token");

  const [payloadB64, sigB64] = parts;
  let payloadJson: string;
  let sigBuf: Buffer;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
    sigBuf = Buffer.from(sigB64, "base64url");
  } catch {
    return fail("malformed base64");
  }

  let publicKey;
  try {
    publicKey = createPublicKey(PUBLIC_KEY_PEM);
  } catch {
    return fail("invalid bundled public key");
  }

  // ed25519 uses null algorithm in Node's verify()
  const isValid = verifySig(null, Buffer.from(payloadB64), publicKey, sigBuf);
  if (!isValid) return fail("signature mismatch");

  let payload: { email?: string; tier?: string; iat?: number; exp?: number };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return fail("malformed payload");
  }

  if (payload.tier !== "pro") return fail("unknown tier");
  if (!payload.email) return fail("missing email");
  if (!payload.exp || !payload.iat) return fail("missing timestamps");

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > payload.exp) return fail(`expired on ${new Date(payload.exp * 1000).toISOString().slice(0, 10)}`);

  return {
    valid: true,
    email: payload.email,
    tier: "pro",
    iat: payload.iat,
    exp: payload.exp,
  };
}

function licenseFilePath(): string {
  return join(homedir(), ".appcrawl", "license");
}

// ---- Free tier usage tracking ---------------------------------------------

interface UsageRecord {
  date: string; // YYYY-MM-DD in user's local time
  count: number;
}

export interface UsageCheckResult {
  allowed: boolean;
  tier: "free" | "pro";
  used: number;
  limit: number;
  resetAt: string; // next midnight ISO
}

/**
 * Check whether the user is allowed to run right now. Pro users are
 * always allowed. Free users get FREE_TIER_DAILY_LIMIT runs per local
 * day, tracked in ~/.appcrawl/usage.json. This function INCREMENTS
 * the counter when it returns allowed=true, so call it exactly once
 * per run.
 */
export function checkAndConsumeUsage(): UsageCheckResult {
  const license = getLicenseStatus();
  if (license.tier === "pro") {
    return {
      allowed: true,
      tier: "pro",
      used: 0,
      limit: Infinity,
      resetAt: "",
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const usagePath = join(homedir(), ".appcrawl", "usage.json");
  let record: UsageRecord = { date: today, count: 0 };

  if (existsSync(usagePath)) {
    try {
      const raw = JSON.parse(readFileSync(usagePath, "utf-8")) as UsageRecord;
      if (raw.date === today) record = raw;
    } catch {
      // Corrupt file — reset it
    }
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const resetAt = tomorrow.toISOString();

  if (record.count >= FREE_TIER_DAILY_LIMIT) {
    return {
      allowed: false,
      tier: "free",
      used: record.count,
      limit: FREE_TIER_DAILY_LIMIT,
      resetAt,
    };
  }

  record.count += 1;
  mkdirSync(join(homedir(), ".appcrawl"), { recursive: true });
  writeFileSync(usagePath, JSON.stringify(record));

  return {
    allowed: true,
    tier: "free",
    used: record.count,
    limit: FREE_TIER_DAILY_LIMIT,
    resetAt,
  };
}
