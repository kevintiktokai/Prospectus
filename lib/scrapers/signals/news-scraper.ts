// Google News RSS — picks up press releases, funding announcements, and
// trade-press mentions. Throttled hard (1 query / 3s) by the
// orchestrator; Google rate-limits aggressively if you don't.
//
// We deliberately don't use a third-party RSS lib — the surface is tiny
// and the format is stable.

const NEWS_USER_AGENT =
  "Mozilla/5.0 (compatible; LayerSyncBot/1.0; +https://layersync.ai/bot)";

export type NewsItem = {
  title: string;
  url: string;
  snippet: string | null;
  publishedAt: string | null;
  source: string | null;
};

export type NewsScrapeResult =
  | { ok: true; items: NewsItem[] }
  | { ok: false; error: string };

function pluck(xml: string, tag: string): string | null {
  // Match a single tag, including any that wrap CDATA.
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  let raw = m[1];
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) raw = cdata[1];
  return raw.replace(/\s+/g, " ").trim() || null;
}

function* iterItems(xml: string): IterableIterator<string> {
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) yield m[0];
}

function parseSourceFromTitle(title: string): {
  cleanTitle: string;
  source: string | null;
} {
  // Google News titles look like: "Headline - Publisher".
  const idx = title.lastIndexOf(" - ");
  if (idx > 10 && idx < title.length - 2) {
    return {
      cleanTitle: title.slice(0, idx).trim(),
      source: title.slice(idx + 3).trim(),
    };
  }
  return { cleanTitle: title, source: null };
}

export async function scrapeNews(
  companyName: string,
  options?: { signal?: AbortSignal },
): Promise<NewsScrapeResult> {
  const query = encodeURIComponent(`"${companyName}"`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-GB&gl=GB&ceid=GB:en`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "user-agent": NEWS_USER_AGENT,
        accept: "application/rss+xml, application/xml, text/xml",
      },
      signal: options?.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!resp.ok) {
    return { ok: false, error: `news rss http ${resp.status}` };
  }

  const xml = await resp.text();

  const items: NewsItem[] = [];
  for (const block of iterItems(xml)) {
    const rawTitle = pluck(block, "title");
    const link = pluck(block, "link");
    const description = pluck(block, "description");
    const pubDate = pluck(block, "pubDate");
    if (!rawTitle || !link) continue;

    const { cleanTitle, source } = parseSourceFromTitle(rawTitle);
    items.push({
      title: cleanTitle.slice(0, 250),
      url: link,
      snippet:
        description?.replace(/<[^>]*>/g, "").slice(0, 280) ?? null,
      publishedAt: pubDate,
      source,
    });
    if (items.length >= 5) break;
  }

  return { ok: true, items };
}
