// Careers / open-roles discovery. The "agency hiring 3 resourcers" hook
// in the campaign value-prop hinges on this — finding the careers page
// and the actual roles listed on it.
//
// Many recruitment agencies use Workable, Greenhouse, Bullhorn, or a
// rolled-their-own /careers page. We accept any of these via the same
// path-prefix heuristic, then pull anchor + heading text from the index.

import type { BrowserContext } from "playwright";
import { newContext, SCRAPER_TIMEOUT_MS } from "@/lib/scrapers/_browser";

const CAREERS_PATHS = [
  "/careers",
  "/jobs",
  "/work-with-us",
  "/join-us",
  "/our-jobs",
  "/vacancies",
  "/work-for-us",
];

export type JobPost = {
  title: string;
  url: string;
  snippet: string | null;
  location: string | null;
};

export type CareersScrapeResult =
  | { ok: true; indexUrl: string; posts: JobPost[] }
  | { ok: false; error: string };

async function findIndexUrl(
  context: BrowserContext,
  origin: string,
): Promise<string | null> {
  const home = await context.newPage();
  try {
    await home.goto(origin, {
      timeout: SCRAPER_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const candidates = await home.$$eval("a[href]", (anchors) =>
      anchors
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h): h is string => typeof h === "string" && h.startsWith("http")),
    );

    for (const href of candidates) {
      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      const path = parsed.pathname.toLowerCase().replace(/\/$/, "");
      const sameOrigin = parsed.origin === origin;
      const isAts =
        parsed.hostname.endsWith(".workable.com") ||
        parsed.hostname.endsWith(".greenhouse.io") ||
        parsed.hostname.endsWith(".lever.co") ||
        parsed.hostname.endsWith(".bullhornreach.com") ||
        parsed.hostname.endsWith(".myworkdayjobs.com");
      if (
        (sameOrigin &&
          CAREERS_PATHS.some(
            (p) => path === p || path.startsWith(p + "/"),
          )) ||
        isAts
      ) {
        return parsed.toString();
      }
    }
  } finally {
    await home.close().catch(() => {});
  }
  return null;
}

async function extractPosts(
  context: BrowserContext,
  indexUrl: string,
): Promise<JobPost[]> {
  const page = await context.newPage();
  try {
    await page.goto(indexUrl, {
      timeout: SCRAPER_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const raw = await page.evaluate(() => {
      // Job titles are typically short, capitalised, and contain a role
      // keyword. Anchors are the most reliable container — every job
      // platform wraps the title in an <a>.
      const ROLE_KEYWORDS =
        /\b(consultant|recruiter|resourcer|engineer|developer|manager|director|analyst|advisor|partner|associate|head of|lead|specialist|administrator|account|sales|marketing)\b/i;

      function nearbyText(el: Element, sel: string): string | null {
        let cursor: Element | null = el.parentElement;
        for (let i = 0; i < 4 && cursor; i++) {
          const t = cursor.querySelector(sel);
          const text = t?.textContent?.trim();
          if (text && text.length > 2) return text.slice(0, 200);
          cursor = cursor.parentElement;
        }
        return null;
      }

      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]"),
      );
      const seen = new Map<
        string,
        { title: string; location: string | null; snippet: string | null }
      >();

      for (const a of anchors) {
        const href = a.href;
        if (!href || !href.startsWith("http")) continue;
        const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length < 4 || text.length > 120) continue;
        if (!ROLE_KEYWORDS.test(text)) continue;

        if (!seen.has(href)) {
          seen.set(href, {
            title: text,
            location: nearbyText(a, '[class*="location" i], [class*="loc" i]'),
            snippet: nearbyText(a, "p"),
          });
        }
      }

      return Array.from(seen.entries()).map(([url, v]) => ({
        url,
        title: v.title,
        location: v.location,
        snippet: v.snippet,
      }));
    });

    const cleaned: JobPost[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      cleaned.push({
        title: r.title.slice(0, 200),
        url: r.url,
        location: r.location?.slice(0, 120) ?? null,
        snippet: r.snippet?.replace(/\s+/g, " ").trim().slice(0, 280) ?? null,
      });
      if (cleaned.length >= 10) break;
    }

    return cleaned;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeCareers(
  websiteUrl: string,
): Promise<CareersScrapeResult> {
  let context: BrowserContext;
  try {
    context = await newContext();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    await context.close().catch(() => {});
    return { ok: false, error: "invalid website url" };
  }

  try {
    let indexUrl = await findIndexUrl(context, origin);
    if (!indexUrl) {
      indexUrl = `${origin}/careers`;
    }
    const posts = await extractPosts(context, indexUrl);
    return { ok: true, indexUrl, posts };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close().catch(() => {});
  }
}
