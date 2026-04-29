// Phase 3 — fetches a company website with headless Chromium and returns a
// shape that the enricher can hand to Claude. Aggressively defensive: every
// failure mode (timeout, 404, Cloudflare block, JS-only page, missing nav)
// is caught and surfaced via a typed result rather than thrown.
//
// Usage:
//   const result = await scrapeWebsite("https://example.com");
//   if (result.ok) { ... result.data.homepage.title ... }

import type { BrowserContext, Page } from "playwright";
import {
  closeBrowser as closeSharedBrowser,
  newContext,
  SCRAPER_TIMEOUT_MS,
} from "@/lib/scrapers/_browser";

const PAGE_TIMEOUT_MS = SCRAPER_TIMEOUT_MS;
const BODY_CHAR_LIMIT = 5_000;

// Routes we consider for the "deeper context" pages. Order matters — first
// match wins per category.
const SUBPAGE_HINTS = {
  about: ["/about", "/about-us", "/who-we-are"],
  team: ["/team", "/our-team", "/people", "/leadership"],
  services: [
    "/services",
    "/what-we-do",
    "/expertise",
    "/sectors",
    "/specialisms",
  ],
};

type SubPageKey = keyof typeof SUBPAGE_HINTS;

export type PageContent = {
  url: string;
  title: string | null;
  metaDescription: string | null;
  headings: { h1: string[]; h2: string[] };
  bodyText: string;
};

export type ScrapeResult =
  | {
      ok: true;
      data: {
        homepage: PageContent;
        aboutPage: PageContent | null;
        teamPage: PageContent | null;
        servicesPage: PageContent | null;
      };
    }
  | {
      ok: false;
      error:
        | "timeout"
        | "navigation_failed"
        | "blocked"
        | "no_content"
        | "browser_failed"
        | "unknown";
      message: string;
    };

export async function closeBrowser(): Promise<void> {
  await closeSharedBrowser();
}

function clean(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

async function extractPageContent(
  page: Page,
  url: string,
): Promise<PageContent> {
  // Run extraction in a single evaluate to minimise round-trips.
  const raw = await page.evaluate((bodyLimit: number) => {
    const head = document.querySelector("head");
    const title = document.title || null;
    const metaDescEl = head?.querySelector(
      'meta[name="description"], meta[property="og:description"]',
    );
    const metaDescription =
      (metaDescEl as HTMLMetaElement | null)?.content ?? null;

    const headings = (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => (el.textContent ?? "").trim())
        .filter(Boolean)
        .slice(0, 20);

    // Strip script/style/noscript before grabbing body text.
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (clone) {
      clone
        .querySelectorAll("script, style, noscript, svg")
        .forEach((n) => n.remove());
    }
    const bodyText = (clone?.innerText ?? "").slice(0, bodyLimit * 4);

    return {
      title,
      metaDescription,
      h1: headings("h1"),
      h2: headings("h2"),
      bodyText,
    };
  }, BODY_CHAR_LIMIT);

  return {
    url,
    title: clean(raw.title) || null,
    metaDescription: clean(raw.metaDescription) || null,
    headings: {
      h1: raw.h1.map(clean).filter(Boolean),
      h2: raw.h2.map(clean).filter(Boolean),
    },
    bodyText: clean(raw.bodyText).slice(0, BODY_CHAR_LIMIT),
  };
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, {
    timeout: PAGE_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
}

// Pick the best sub-page link per category by scanning the homepage's anchors.
// Returns absolute URLs, deduped by path, max one per category.
async function findSubPages(
  page: Page,
  homeOrigin: string,
): Promise<Partial<Record<SubPageKey, string>>> {
  const links = await page.$$eval("a[href]", (anchors) =>
    anchors
      .map((a) => (a as HTMLAnchorElement).href)
      .filter(
        (href) => typeof href === "string" && href.startsWith("http"),
      ),
  );

  const out: Partial<Record<SubPageKey, string>> = {};
  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    // Same-origin only — agency sub-pages live on the same host.
    if (parsed.origin !== homeOrigin) continue;
    const path = parsed.pathname.toLowerCase();
    for (const key of Object.keys(SUBPAGE_HINTS) as SubPageKey[]) {
      if (out[key]) continue;
      if (SUBPAGE_HINTS[key].some((hint) => path.startsWith(hint))) {
        out[key] = parsed.toString();
      }
    }
  }
  return out;
}

function classifyError(err: unknown): ScrapeResult {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("timeout")) {
    return { ok: false, error: "timeout", message };
  }
  if (
    lower.includes("net::err_") ||
    lower.includes("dns") ||
    lower.includes("ssl")
  ) {
    return { ok: false, error: "navigation_failed", message };
  }
  if (lower.includes("403") || lower.includes("cloudflare")) {
    return { ok: false, error: "blocked", message };
  }
  return { ok: false, error: "unknown", message };
}

export async function scrapeWebsite(websiteUrl: string): Promise<ScrapeResult> {
  if (!websiteUrl) {
    return { ok: false, error: "navigation_failed", message: "no url" };
  }

  let context: BrowserContext;
  try {
    context = await newContext();
  } catch (err) {
    return {
      ok: false,
      error: "browser_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const page = await context.newPage();

  try {
    await navigate(page, websiteUrl);
  } catch (err) {
    await context.close().catch(() => {});
    return classifyError(err);
  }

  let homepage: PageContent;
  let homeOrigin: string;
  try {
    homepage = await extractPageContent(page, page.url());
    homeOrigin = new URL(page.url()).origin;
  } catch (err) {
    await context.close().catch(() => {});
    return classifyError(err);
  }

  if (!homepage.title && !homepage.bodyText) {
    await context.close().catch(() => {});
    return {
      ok: false,
      error: "no_content",
      message: "homepage produced no title or body text",
    };
  }

  // Discover sub-pages, then fetch each. One failure does not abort the run.
  const subPaths = await findSubPages(page, homeOrigin).catch(
    () => ({}) as Partial<Record<SubPageKey, string>>,
  );
  const aboutPage = await fetchSubPage(context, subPaths.about);
  const teamPage = await fetchSubPage(context, subPaths.team);
  const servicesPage = await fetchSubPage(context, subPaths.services);

  await context.close().catch(() => {});

  return {
    ok: true,
    data: { homepage, aboutPage, teamPage, servicesPage },
  };
}

async function fetchSubPage(
  context: BrowserContext,
  url: string | undefined,
): Promise<PageContent | null> {
  if (!url) return null;
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    await navigate(page, url);
    return await extractPageContent(page, page.url());
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
