// NeverBounce single-email verify wrapper. Their batch endpoint takes
// a job-creation + polling cycle that's worth using for tens of
// thousands of emails — but for our scale (a few hundred unverified
// emails per run), per-email verification is simpler, costs the same
// per credit, and avoids the polling complexity.
//
// API: GET https://api.neverbounce.com/v4/single/check
//
// We persist `email_verified = true` only for `result === "valid"`.
// "catchall", "unknown", "disposable" stay unverified — the
// catch-all rate at small recruitment agencies is high; treating those
// as "verified" would burn sender reputation.

const NEVERBOUNCE_BASE = "https://api.neverbounce.com/v4";

export type VerificationStatus =
  | "valid"
  | "invalid"
  | "disposable"
  | "catchall"
  | "unknown"
  | "error";

export type VerificationResult = {
  email: string;
  status: VerificationStatus;
  flags: string[];
  raw: unknown;
};

type SingleCheckResponse = {
  status: string;
  result?: string;
  flags?: string[];
  message?: string;
  credits_info?: {
    paid_credits_remaining?: number;
    free_credits_remaining?: number;
  };
};

export async function verifyEmail(
  email: string,
  options?: { signal?: AbortSignal },
): Promise<VerificationResult> {
  const apiKey = process.env.NEVERBOUNCE_API_KEY;
  if (!apiKey) {
    return {
      email,
      status: "error",
      flags: [],
      raw: { error: "Missing NEVERBOUNCE_API_KEY" },
    };
  }

  const url = new URL(`${NEVERBOUNCE_BASE}/single/check`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("email", email);
  url.searchParams.set("address_info", "0");

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: options?.signal,
    });
  } catch (err) {
    return {
      email,
      status: "error",
      flags: [],
      raw: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!resp.ok) {
    return {
      email,
      status: "error",
      flags: [],
      raw: { http: resp.status },
    };
  }

  const json = (await resp.json()) as SingleCheckResponse;
  if (json.status !== "success") {
    return {
      email,
      status: "error",
      flags: [],
      raw: json,
    };
  }

  const result = (json.result ?? "unknown").toLowerCase();
  const status: VerificationStatus =
    result === "valid"
      ? "valid"
      : result === "invalid"
        ? "invalid"
        : result === "disposable"
          ? "disposable"
          : result === "catchall"
            ? "catchall"
            : "unknown";

  return {
    email,
    status,
    flags: json.flags ?? [],
    raw: json,
  };
}

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";

// Verify every contact for a company that has an email and isn't yet
// verified. Returns counts. Throttled at 200ms between calls — per
// NeverBounce their docs, single-check has no per-second cap stated
// but we want to stay courteous.
export async function verifyContactsForCompany(
  companyId: string,
): Promise<{ checked: number; valid: number; invalid: number; other: number }> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, email")
    .eq("company_id", companyId)
    .eq("email_verified", false)
    .not("email", "is", null);

  if (error) throw new Error(`fetch contacts: ${error.message}`);

  const tally = { checked: 0, valid: 0, invalid: 0, other: 0 };
  for (const row of data ?? []) {
    if (!row.email) continue;
    const result = await verifyEmail(row.email);
    tally.checked += 1;
    const verified = result.status === "valid";
    if (verified) tally.valid += 1;
    else if (result.status === "invalid") tally.invalid += 1;
    else tally.other += 1;

    await supabase
      .from("contacts")
      .update({
        email_verified: verified,
        email_verification_status: result.status,
        email_verified_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    await new Promise((r) => setTimeout(r, 200));
  }

  await logActivity("emails_verified", "company", companyId, tally);
  return tally;
}
