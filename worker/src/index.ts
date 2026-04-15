/**
 * AppCrawl license-issuance Worker.
 *
 * Flow:
 *   1. Stripe Payment Link redirects customer to appcrawl.dev/activate.html?session_id=cs_...
 *   2. Browser fetches POST /issue { session_id } against this worker
 *   3. Worker fetches the checkout session from Stripe to confirm it's paid
 *   4. Worker signs an ed25519 license token for the customer's email
 *   5. Worker returns { token, email, expiresAt } — browser displays it
 *
 * Secrets (set with `wrangler secret put`):
 *   - STRIPE_SECRET_KEY  — sk_live_... (or sk_test_... during setup)
 *   - SIGNING_KEY_SEED   — base64url-encoded 32-byte ed25519 seed
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface Env {
  STRIPE_SECRET_KEY: string;
  SIGNING_KEY_SEED: string;
  STRIPE_API_BASE: string;
  LICENSE_TTL_DAYS: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://appcrawl.dev",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/issue" && req.method === "POST") {
      return handleIssue(req, env);
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleIssue(req: Request, env: Env): Promise<Response> {
  let body: { session_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const sessionId = body.session_id?.trim();
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return json({ error: "missing or invalid session_id" }, 400);
  }

  const sessionRes = await fetch(
    `${env.STRIPE_API_BASE}/checkout/sessions/${sessionId}`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
  );

  if (!sessionRes.ok) {
    return json({ error: "stripe lookup failed" }, 502);
  }

  const session = (await sessionRes.json()) as {
    payment_status?: string;
    status?: string;
    customer_details?: { email?: string };
    customer_email?: string;
  };

  const paid = session.payment_status === "paid" || session.status === "complete";
  if (!paid) {
    return json({ error: "session not paid" }, 402);
  }

  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) {
    return json({ error: "no customer email on session" }, 400);
  }

  const ttlDays = parseInt(env.LICENSE_TTL_DAYS, 10) || 365;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlDays * 24 * 60 * 60;
  const token = await signLicense(env.SIGNING_KEY_SEED, { email, tier: "pro", iat, exp });

  return json({
    token,
    email,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
}

async function signLicense(
  seedB64url: string,
  payload: { email: string; tier: "pro"; iat: number; exp: number },
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(new TextEncoder().encode(payloadJson));

  const seed = fromBase64Url(seedB64url);
  if (seed.length !== 32) {
    throw new Error(`expected 32-byte seed, got ${seed.length}`);
  }

  const signature = await ed.signAsync(new TextEncoder().encode(payloadB64), seed);
  return `${payloadB64}.${toBase64Url(signature)}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
