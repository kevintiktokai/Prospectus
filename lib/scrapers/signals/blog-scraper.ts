// Blog post discovery — finds an agency's blog/news/insights index page,
// then extracts up to 5 most recent posts. Best-effort: most recruitment
// sites use slightly different markup, so the heuristic is "look for
// repeated article-like blocks within a list/grid container."

import type { BrowserContext } from "playwright";
import { newContext, SCRAPER_TIMEOUT_MS } from "@/lib/scrapers/_browser";

const BLOG_PATHS = [
  "/blog",
  "/news",
  "/insights",
  "/resources",
  "/articles",
  "/thinking",
];

export type BlogPost = {
  title: string;
  url: string;
  snippet: string | null;
  publishedAt: string | null;
};

export type BlogScrapeResult =
  | { ok: true; indexUrl: string; posts: BlogPost[] }
  | { ok: false; error: string };

function normaliseUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

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
      if (parsed.origin !== origin) continue;
      const path = parsed.pathname.toLowerCase().replace(/\/$/, "");
      if (BLOG_PATHS.some((p) => path === p || path.startsWith(p + "/"))) {
        return parsed.toString();
      }
    }
  } finally {
    await home.close().catch(() => {});
  }
  // Fallback: try /blog directly even if the homepage didn't link to it.
  return null;
}

async function extractPosts(
  context: BrowserContext,
  indexUrl: string,
): Promise<BlogPost[]> {
  const page = await context.newPage();
  try {
    await page.goto(indexUrl, {
      timeout: SCRAPER_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const raw = await page.evaluate(() => {
      // Strategy: find anchors whose own text or nearest heading is a
      // plausible blog post title (longer than 12 chars, fewer than 200),
      // and whose URL has a deeper path than the index. Group by
      // unique URL to dedupe nav repetition.
      function nearestHeading(el: Element): string | null {
        let cursor: Element | null = el;
        for (let i = 0; i < 3 && cursor; i++) {
          const h = cursor.querySelector("h1, h2, h3, h4");
          if (h && (h.textContent?.trim().length ?? 0) > 12) {
            return h.textContent!.trim();
          }
          cursor = cursor.parentElement;
        }
        return null;
      }

      function nearbySnippet(el: Element): string | null {
        let cursor: Element | null = el.parentElement;
        for (let i = 0; i < 3 && cursor; i++) {
          const p = cursor.querySelector("p");
          const text = p?.textContent?.trim();
          if (text && text.length > 30) return text.slice(0, 280);
          cursor = cursor.parentElement;
        }
        return null;
      }

      function nearbyDate(el: Element): string | null {
        let cursor: Element | null = el.parentElement;
        for (let i = 0; i < 4 && cursor; i++) {
          const t = cursor.querySelector("time");
          if (t) {
            const dt = (t as HTMLTimeElement).getAttribute("datetime");
            const text = t.textContent?.trim() ?? null;
            return dt || text;
          }
          cursor = cursor.parentElement;
        }
        return null;
      }

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      const seen = new Map<string, { title: string; snippet: string | null; date: string | null }>();
      const indexPath = location.pathname.replace(/\/$/, "");

      for (const a of anchors) {
        const href = a.href;
        if (!href || !href.startsWith(location.origin)) continue;
        try {
          const u = new URL(href);
          // Skip the index page itself + anchors.
          const p = u.pathname.replace(/\/$/, "");
          if (p === indexPath || u.hash) continue;
          // Must be deeper than index path.
          if (!p.startsWith(indexPath + "/")) continue;
        } catch {
          continue;
        }

        const ownText = a.textContent?.trim() ?? "";
        const title =
          ownText.length > 12 && ownText.length < 200
            ? ownText
            : nearestHeading(a);
        if (!title) continue;

        if (!seen.has(href)) {
          seen.set(href, {
            title,
            snippet: nearbySnippet(a),
            date: nearbyDate(a),
          });
        }
      }

      return Array.from(seen.entries()).map(([url, v]) => ({
        url,
        title: v.title,
        snippet: v.snippet,
        date: v.date,
      }));
    });

    const cleaned: BlogPost[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const url = normaliseUrl(r.url, indexUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      cleaned.push({
        title: r.title.replace(/\s+/g, " ").trim().slice(0, 250),
        url,
        snippet: r.snippet?.replace(/\s+/g, " ").trim().slice(0, 280) ?? null,
        publishedAt: r.date,
      });
      if (cleaned.length >= 5) break;
    }

    return cleaned;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeBlog(
  websiteUrl: string,
): Promise<BlogScrapeResult> {
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
      // Last-ditch: try /blog directly.
      indexUrl = `${origin}/blog`;
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
