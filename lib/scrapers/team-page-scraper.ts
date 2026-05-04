// Team / about page scraping: pulls text + mailto links from the
// most-likely "people" pages, then asks Haiku to structure them into
// {first_name, last_name, title, email?} rows.
//
// We deliberately let Claude extract — name + title parsing across
// agency websites varies wildly (cards, tables, paragraphs, modals)
// and a model handles the variance for ~$0.001/page.

import type { BrowserContext } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { newContext, SCRAPER_TIMEOUT_MS } from "@/lib/scrapers/_browser";

const TEAM_PATHS = [
  "/team",
  "/our-team",
  "/people",
  "/leadership",
  "/about",
  "/about-us",
  "/who-we-are",
  "/meet-the-team",
];

const HAIKU_MODEL = "claude-haiku-4-5";
const PAGE_BODY_LIMIT = 8_000;

const PersonSchema = z.object({
  first_name: z.string().min(1).max(80),
  last_name: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  email: z.string().email().nullable(),
});

export const TeamExtractionSchema = z.object({
  people: z.array(PersonSchema).max(60),
});

export type ExtractedPerson = z.infer<typeof PersonSchema>;

const SYSTEM_PROMPT = `Extract every named person from a UK recruitment agency's team / about page.

Rules:
- One row per individual. Skip generic mentions ("our team", "our consultants").
- "first_name" / "last_name" are the literal name as printed. If only one name appears, use it as first_name and leave last_name as the empty string.
- "title" is the role as written on the page (e.g. "Managing Director", "Senior Recruitment Consultant"). Trim trailing punctuation. If no title is given, use "Unknown".
- "email" is included ONLY if an email is visibly associated with that person on the page. Otherwise null. Never invent or guess emails.
- Skip people who are clearly not staff (testimonial authors, candidates, blog post authors with bylines but no role on this team).

If the page text is empty or not a team page, return { "people": [] }.`;

export type TeamScrapeResult =
  | {
      ok: true;
      indexUrl: string;
      people: ExtractedPerson[];
      mailtoEmails: string[];
    }
  | { ok: false; error: string };

async function findTeamUrl(
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

    // Match in priority order — /team beats /about.
    for (const target of TEAM_PATHS) {
      for (const href of candidates) {
        let parsed: URL;
        try {
          parsed = new URL(href);
        } catch {
          continue;
        }
        if (parsed.origin !== origin) continue;
        const path = parsed.pathname.toLowerCase().replace(/\/$/, "");
        if (path === target || path.startsWith(target + "/")) {
          return parsed.toString();
        }
      }
    }
  } finally {
    await home.close().catch(() => {});
  }
  return null;
}

async function extractPageText(
  context: BrowserContext,
  url: string,
): Promise<{ text: string; mailtos: string[] } | null> {
  const page = await context.newPage();
  try {
    await page.goto(url, {
      timeout: SCRAPER_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const result = await page.evaluate((bodyLimit: number) => {
      const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
      if (clone) {
        clone
          .querySelectorAll("script, style, noscript, svg")
          .forEach((n) => n.remove());
      }
      const text = (clone?.innerText ?? "").slice(0, bodyLimit * 4);

      const mailtos = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]'),
      )
        .map((a) => a.href.replace(/^mailto:/i, "").split("?")[0].trim())
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

      return { text, mailtos };
    }, PAGE_BODY_LIMIT);

    return {
      text: result.text.replace(/\s+/g, " ").trim().slice(0, PAGE_BODY_LIMIT),
      mailtos: Array.from(new Set(result.mailtos.map((m) => m.toLowerCase()))),
    };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

const anthropicClient = (): Anthropic => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
};

export async function extractPeopleFromText(
  client: Anthropic,
  pageUrl: string,
  pageText: string,
): Promise<ExtractedPerson[]> {
  if (!pageText) return [];

  const response = await client.messages.parse({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `URL: ${pageUrl}\n\nPAGE TEXT:\n${pageText}`,
      },
    ],
    output_config: { format: zodOutputFormat(TeamExtractionSchema) },
  });

  if (!response.parsed_output) return [];
  return response.parsed_output.people;
}

export async function scrapeTeamPage(
  websiteUrl: string,
  client?: Anthropic,
): Promise<TeamScrapeResult> {
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
    const indexUrl =
      (await findTeamUrl(context, origin)) ?? `${origin}/team`;
    const page = await extractPageText(context, indexUrl);
    if (!page || !page.text) {
      return { ok: true, indexUrl, people: [], mailtoEmails: [] };
    }

    const ai = client ?? anthropicClient();
    const people = await extractPeopleFromText(ai, indexUrl, page.text);
    return {
      ok: true,
      indexUrl,
      people,
      mailtoEmails: page.mailtos,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close().catch(() => {});
  }
}
