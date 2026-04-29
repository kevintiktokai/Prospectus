// Phase 3 — Claude Haiku 4.5 enrichment.
//
// Pipeline per company:
//   1. scrapeWebsite (Playwright)
//   2. messages.parse against a Zod schema → typed JSON, no fragile regex
//   3. update companies row + log activity
//
// The system prompt is identical across every call, so it sits before the
// last cache breakpoint. Subsequent calls hit cache on system tokens
// (~0.1× cost). The varying scraped text goes in the user message AFTER
// the breakpoint so it doesn't poison the cache.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import {
  scrapeWebsite,
  type ScrapeResult,
  type PageContent,
} from "@/lib/scrapers/website-scraper";
import type { Company } from "@/types/database";

const HAIKU_MODEL = "claude-haiku-4-5";

const SUB_INDUSTRIES = [
  "tech",
  "finance",
  "healthcare",
  "exec_search",
  "generalist",
  "other",
] as const;

export const ExtractionSchema = z.object({
  description: z
    .string()
    .min(20)
    .max(600)
    .describe("Two to three sentences describing what the agency does."),
  services: z
    .array(z.string().min(2).max(80))
    .max(15)
    .describe("Service names as offered by the agency, deduped."),
  sub_industry: z
    .enum(SUB_INDUSTRIES)
    .describe(
      "Best-fit category. Pick 'generalist' only if there is no clear specialism.",
    ),
  employee_estimate: z
    .number()
    .int()
    .nullable()
    .describe(
      "Best estimate of headcount. Null if there's no reasonable signal.",
    ),
  tech_stack_signals: z
    .array(z.string().min(2).max(60))
    .max(12)
    .describe(
      "Tools / CRMs / platforms mentioned (Bullhorn, Vincere, JobAdder, LinkedIn Recruiter, etc).",
    ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You extract structured facts about UK recruitment agencies from their own website copy.

Rules:
- Be specific to THIS agency. Do not write generic recruitment-industry boilerplate.
- "description" is 2–3 sentences. State what they do, who they serve, and any specialism. No marketing fluff.
- "services" lists the actual service names the site uses (e.g. "Permanent Placement", "Contract Recruitment", "Executive Search"). Drop duplicates. Skip empty.
- "sub_industry" picks the closest match from the enum. Use "generalist" only when the site has no clear vertical focus.
- "employee_estimate" is your best guess from explicit numbers, team-page headcount, or "we're a team of N" language. Use null if there is no reasonable signal — do NOT guess from office size or city.
- "tech_stack_signals" is tools / CRMs / platforms NAMED on the site (Bullhorn, Vincere, JobAdder, LinkedIn Recruiter, Salesforce, HubSpot, Sense, etc). Empty list is fine.

If the input text is mostly empty or clearly not an agency website, return short fields with low confidence and "generalist" sub_industry.`;

const anthropicClient = (): Anthropic => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
};

function renderPage(label: string, page: PageContent | null): string {
  if (!page) return "";
  const headings = [
    ...page.headings.h1.map((h) => `# ${h}`),
    ...page.headings.h2.map((h) => `## ${h}`),
  ]
    .join("\n")
    .trim();
  return [
    `--- ${label} (${page.url}) ---`,
    page.title ? `TITLE: ${page.title}` : "",
    page.metaDescription ? `META: ${page.metaDescription}` : "",
    headings ? `HEADINGS:\n${headings}` : "",
    page.bodyText ? `BODY:\n${page.bodyText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserMessage(
  company: Pick<Company, "name" | "website">,
  scrape: Extract<ScrapeResult, { ok: true }>["data"],
): string {
  const parts = [
    `Company: ${company.name}`,
    `Website: ${company.website ?? "(missing)"}`,
    "",
    renderPage("HOMEPAGE", scrape.homepage),
    renderPage("ABOUT", scrape.aboutPage),
    renderPage("TEAM", scrape.teamPage),
    renderPage("SERVICES / WHAT-WE-DO", scrape.servicesPage),
  ];
  return parts.filter(Boolean).join("\n\n");
}

export async function extractWithClaude(
  client: Anthropic,
  company: Pick<Company, "name" | "website">,
  scrape: Extract<ScrapeResult, { ok: true }>["data"],
): Promise<Extraction> {
  const userText = buildUserMessage(company, scrape);

  // Prompt caching: the system prompt is identical across all enrichments,
  // so we mark the system block ephemeral. Tools/system render before
  // messages — caching system gives ~90% input savings on the static prefix.
  const response = await client.messages.parse({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userText }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Haiku returned no parsed output (stop_reason=${response.stop_reason})`,
    );
  }

  return response.parsed_output;
}

export type EnrichOutcome =
  | {
      ok: true;
      company_id: string;
      extraction: Extraction;
      cache: { reads: number; writes: number };
    }
  | {
      ok: false;
      company_id: string;
      stage: "scrape" | "extract" | "persist";
      error: string;
    };

export async function enrichCompany(
  company: Pick<Company, "id" | "name" | "website" | "domain">,
  client?: Anthropic,
): Promise<EnrichOutcome> {
  const supabase = createServerClient();

  // Mark in-flight so concurrent runners don't double-process. The
  // .eq('enrichment_status', 'pending') guard makes this an atomic claim:
  // only one worker wins.
  const claim = await supabase
    .from("companies")
    .update({ enrichment_status: "enriching", enrichment_error: null })
    .eq("id", company.id)
    .eq("enrichment_status", "pending")
    .select("id")
    .maybeSingle();

  if (!claim.data) {
    // Already claimed or moved past pending — caller should skip silently.
    return {
      ok: false,
      company_id: company.id,
      stage: "persist",
      error: "not_pending",
    };
  }

  if (!company.website) {
    await markFailed(company.id, "no_website");
    return {
      ok: false,
      company_id: company.id,
      stage: "scrape",
      error: "no_website",
    };
  }

  // Step 1: scrape
  const scrape = await scrapeWebsite(company.website);
  if (!scrape.ok) {
    await markFailed(company.id, `scrape:${scrape.error}:${scrape.message}`);
    await logActivity(
      "enrich_scrape_failed",
      "company",
      company.id,
      {
        domain: company.domain,
        error: scrape.error,
        message: scrape.message,
      },
      "error",
      `${scrape.error}: ${scrape.message}`,
    );
    return {
      ok: false,
      company_id: company.id,
      stage: "scrape",
      error: `${scrape.error}: ${scrape.message}`,
    };
  }

  // Step 2: extract via Claude. One retry on parse failure.
  const ai = client ?? anthropicClient();
  let extraction: Extraction;
  let cacheReads = 0;
  let cacheWrites = 0;
  try {
    const response = await ai.messages.parse({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: buildUserMessage(company, scrape.data) },
      ],
      output_config: { format: zodOutputFormat(ExtractionSchema) },
    });
    cacheReads = response.usage.cache_read_input_tokens ?? 0;
    cacheWrites = response.usage.cache_creation_input_tokens ?? 0;
    if (!response.parsed_output) {
      throw new Error(`no parsed_output (stop_reason=${response.stop_reason})`);
    }
    extraction = response.parsed_output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(company.id, `extract:${message}`);
    await logActivity(
      "enrich_extract_failed",
      "company",
      company.id,
      { domain: company.domain, message },
      "error",
      message,
    );
    return {
      ok: false,
      company_id: company.id,
      stage: "extract",
      error: message,
    };
  }

  // Step 3: persist
  const { error: updateErr } = await supabase
    .from("companies")
    .update({
      description: extraction.description,
      services: extraction.services,
      sub_industry: extraction.sub_industry,
      employee_estimate: extraction.employee_estimate,
      tech_stack: extraction.tech_stack_signals,
      enrichment_status: "enriched",
      enrichment_error: null,
      last_enriched_at: new Date().toISOString(),
    })
    .eq("id", company.id);

  if (updateErr) {
    await markFailed(company.id, `persist:${updateErr.message}`);
    return {
      ok: false,
      company_id: company.id,
      stage: "persist",
      error: updateErr.message,
    };
  }

  await logActivity("enrich_company_succeeded", "company", company.id, {
    domain: company.domain,
    sub_industry: extraction.sub_industry,
    services_count: extraction.services.length,
    employee_estimate: extraction.employee_estimate,
    cache_reads: cacheReads,
    cache_writes: cacheWrites,
  });

  return {
    ok: true,
    company_id: company.id,
    extraction,
    cache: { reads: cacheReads, writes: cacheWrites },
  };
}

async function markFailed(id: string, reason: string): Promise<void> {
  const supabase = createServerClient();
  await supabase
    .from("companies")
    .update({
      enrichment_status: "failed",
      enrichment_error: reason.slice(0, 500),
      last_enriched_at: new Date().toISOString(),
    })
    .eq("id", id);
}
