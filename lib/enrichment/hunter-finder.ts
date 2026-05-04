// Hunter.io /v2/domain-search wrapper. One call per company domain
// returns a list of {first_name, last_name, position, email, confidence}
// plus the email pattern used by the company. Free tier: 25 searches/mo,
// paid: 500/mo at the cheapest plan — be deliberate about which
// companies to query.

const HUNTER_BASE = "https://api.hunter.io/v2";

export type HunterEmail = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  confidence: number | null;
  linkedin: string | null;
};

export type HunterResult =
  | {
      ok: true;
      domain: string;
      pattern: string | null;
      organization: string | null;
      emails: HunterEmail[];
      remainingCredits: number | null;
    }
  | {
      ok: false;
      domain: string;
      error: string;
      remainingCredits: number | null;
    };

type HunterApiResponse = {
  data?: {
    domain?: string | null;
    organization?: string | null;
    pattern?: string | null;
    emails?: Array<{
      value?: string;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
      seniority?: string | null;
      department?: string | null;
      confidence?: number | null;
      linkedin?: string | null;
    }>;
  };
  meta?: {
    results?: number;
  };
  errors?: Array<{ details?: string; id?: string; code?: number }>;
};

function readRemainingCredits(headers: Headers): number | null {
  const v = headers.get("x-credits-remaining");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function findEmailsForDomain(
  domain: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<HunterResult> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      domain,
      error: "Missing HUNTER_API_KEY",
      remainingCredits: null,
    };
  }

  const url = new URL(`${HUNTER_BASE}/domain-search`);
  url.searchParams.set("domain", domain);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("limit", String(options?.limit ?? 25));
  // Bias toward decision-maker seniority — the API returns these first.
  url.searchParams.set("seniority", "executive,senior");

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: options?.signal,
    });
  } catch (err) {
    return {
      ok: false,
      domain,
      error: err instanceof Error ? err.message : String(err),
      remainingCredits: null,
    };
  }

  const remainingCredits = readRemainingCredits(resp.headers);

  if (!resp.ok) {
    let bodyMessage = `http ${resp.status}`;
    try {
      const j = (await resp.json()) as HunterApiResponse;
      const detail = j.errors?.[0]?.details;
      if (detail) bodyMessage = `http ${resp.status}: ${detail}`;
    } catch {
      /* swallow */
    }
    return { ok: false, domain, error: bodyMessage, remainingCredits };
  }

  const json = (await resp.json()) as HunterApiResponse;
  const data = json.data ?? {};
  const emails: HunterEmail[] = (data.emails ?? [])
    .filter((e): e is NonNullable<typeof e> & { value: string } =>
      Boolean(e?.value),
    )
    .map((e) => ({
      email: e.value.toLowerCase(),
      firstName: e.first_name ?? null,
      lastName: e.last_name ?? null,
      position: e.position ?? null,
      seniority: e.seniority ?? null,
      department: e.department ?? null,
      confidence: typeof e.confidence === "number" ? e.confidence : null,
      linkedin: e.linkedin ?? null,
    }));

  return {
    ok: true,
    domain,
    pattern: data.pattern ?? null,
    organization: data.organization ?? null,
    emails,
    remainingCredits,
  };
}
