// Social URLs and job boards sometimes show up as a business "website" on
// Google Places. We dedupe on domain, so these need to be filtered before
// they poison the companies table.

const SOCIAL_HOSTS = new Set([
  "linkedin.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
]);

const JOB_BOARDS = new Set([
  "indeed.com",
  "indeed.co.uk",
  "reed.co.uk",
  "totaljobs.com",
  "cv-library.co.uk",
  "jobsite.co.uk",
  "monster.co.uk",
  "monster.com",
  "glassdoor.co.uk",
  "glassdoor.com",
  "linkedin.com/jobs",
]);

export function extractDomain(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(withProto);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export function normalizeDomain(
  url: string | null | undefined,
): string | null {
  const d = extractDomain(url);
  if (!d) return null;
  return d.trim().toLowerCase();
}

export function isSocialDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return SOCIAL_HOSTS.has(domain);
}

export function isJobBoardDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return JOB_BOARDS.has(domain);
}

// Public-sector / government domains aren't agencies we can sell to.
// Matches ".gov.uk" and any subdomain of it.
export function isGovUkDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return domain === "gov.uk" || domain.endsWith(".gov.uk");
}

export type JunkReason =
  | "no_domain"
  | "social_url"
  | "job_board"
  | "gov_uk";

// Single entry point for the Phase 2.5 filter pass + any future writer that
// wants the same screening. Order of checks matches reporting priority.
export function classifyJunkDomain(
  domain: string | null | undefined,
): JunkReason | null {
  if (!domain) return "no_domain";
  if (isSocialDomain(domain)) return "social_url";
  if (isJobBoardDomain(domain)) return "job_board";
  if (isGovUkDomain(domain)) return "gov_uk";
  return null;
}
