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
