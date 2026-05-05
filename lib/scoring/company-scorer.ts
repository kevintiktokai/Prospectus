// Phase 6 — fit scoring + primary signal selection.
//
// For each enriched company with signals, send (campaign ICP +
// company profile + signals) to Haiku and get back:
//   { score: 0-100, reasoning, primary_signal_id, primary_signal_reason }
//
// The campaign ICP block is identical across every scoring call, so
// we wrap it as a cached system prompt — same caching pattern as the
// enricher in Phase 3, ~0.1× cost on the static prefix after the
// first request.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import type { Campaign, Company, Signal } from "@/types/database";

const HAIKU_MODEL = "claude-haiku-4-5";

export const ScoringSchema = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Fit score 0-100. Use the full range, not just 70-80."),
  reasoning: z
    .string()
    .min(20)
    .max(400)
    .describe("Two or three sentences. Cite specifics from the profile."),
  primary_signal_id: z
    .string()
    .uuid()
    .nullable()
    .describe("ID of the single best outreach hook. Null if no signal is good."),
  primary_signal_reason: z
    .string()
    .min(10)
    .max(200)
    .nullable()
    .describe(
      "One sentence on why this signal is the strongest hook for a cold email.",
    ),
});

export type Scoring = z.infer<typeof ScoringSchema>;

const SYSTEM_PROMPT = `You score UK recruitment agencies for fit against the LayerSync ICP and pick the single best outreach hook.

ICP recap (you'll receive the campaign description verbatim too):
  - UK-based independent recruitment agencies
  - 10–30 employees, owner-operated
  - Currently scaling, with consultants drowning in repetitive sourcing / reporting / candidate-care work

How to score:
  - 90–100: bullseye. Owner-operated, 10–30 staff, active hiring or growth signals, no AI competitor positioning.
  - 70–89: strong fit with one weakness (e.g. employee count unknown, signals are weak but plausible).
  - 50–69: tangential. Could work but not a priority — wrong size band, generic services, weak signals.
  - 25–49: poor fit. Wrong vertical, too large/small, or competitor signals.
  - 0–24: disqualified. Job board, .gov.uk, dead site, or AI-recruitment competitor.

Penalize hard:
  - Mentions of "AI recruitment", "AI-powered", "AI agents", "automated sourcing" in their OWN services — they're competitors, not customers.
  - Pure executive-search firms with <10 staff — wrong unit economics.
  - 100+ employee firms — they buy ATS/CRM not custom agents.

Reward:
  - Recent hiring of resourcers / consultants (the role-keyword in job_post signals)
  - Blog or news content about scaling, growth, expansion
  - Specialism in tech, finance, or healthcare verticals
  - Independent / owner-operated framing

For primary signal:
  - Pick the SINGLE strongest hook from the supplied signals. Prefer recent + specific (a job_post with a role and headcount > a generic blog post about market trends > funding > leadership change).
  - Use the EXACT id from the input. Do not invent UUIDs.
  - Set both primary_signal_id and primary_signal_reason to null if no signal is genuinely useful for a cold email.

Use the full 0–100 range. A bell-curve distribution is expected — most companies are 40–70, only a handful should hit 85+.`;

const anthropicClient = (): Anthropic => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
};

function renderProfile(c: Company): string {
  return [
    `Name: ${c.name}`,
    `Domain: ${c.domain ?? "—"}`,
    `City: ${c.city ?? "—"}`,
    `Sub-industry: ${c.sub_industry ?? "—"}`,
    `Employees (est.): ${c.employee_estimate ?? "—"}`,
    `Description: ${c.description ?? "—"}`,
    `Services: ${
      Array.isArray(c.services) && c.services.length > 0
        ? (c.services as string[]).join(", ")
        : "—"
    }`,
    `Tech-stack signals: ${
      Array.isArray(c.tech_stack) && c.tech_stack.length > 0
        ? (c.tech_stack as string[]).join(", ")
        : "—"
    }`,
  ].join("\n");
}

function renderSignals(signals: Signal[]): string {
  if (signals.length === 0) return "(no signals)";
  return signals
    .map((s) => {
      const date = s.detected_at?.slice(0, 10) ?? "—";
      const title = s.title ?? "(no title)";
      const snippet = s.content ? ` — ${s.content.slice(0, 200)}` : "";
      return `- id=${s.id} type=${s.type} (${date}): ${title}${snippet}`;
    })
    .join("\n");
}

function renderCampaign(campaign: Campaign): string {
  return [
    `Campaign: ${campaign.name}`,
    `ICP: ${campaign.icp_description ?? "—"}`,
    `Value prop: ${campaign.value_prop ?? "—"}`,
  ].join("\n");
}

export async function scoreCompany(
  client: Anthropic,
  campaign: Campaign,
  company: Company,
  signals: Signal[],
): Promise<Scoring> {
  const userText = [
    "## Campaign",
    renderCampaign(campaign),
    "",
    "## Company profile",
    renderProfile(company),
    "",
    "## Signals",
    renderSignals(signals),
  ].join("\n");

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
    output_config: { format: zodOutputFormat(ScoringSchema) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Haiku returned no parsed output (stop_reason=${response.stop_reason})`,
    );
  }

  // Defensive: if Claude returns a primary_signal_id, ensure it's
  // actually one of the signal IDs we sent. Hallucinated UUIDs get
  // discarded silently.
  const result = response.parsed_output;
  if (result.primary_signal_id) {
    const allowed = new Set(signals.map((s) => s.id));
    if (!allowed.has(result.primary_signal_id)) {
      result.primary_signal_id = null;
      result.primary_signal_reason = null;
    }
  }

  return result;
}

export type ScoreOutcome =
  | {
      ok: true;
      company_id: string;
      score: number;
      primary_signal_id: string | null;
      cache: { reads: number; writes: number };
    }
  | { ok: false; company_id: string; error: string };

export async function scoreAndPersist(
  campaign: Campaign,
  company: Company,
  client?: Anthropic,
): Promise<ScoreOutcome> {
  const supabase = createServerClient();

  // Pull signals for this company. We cap at 25 — past that the
  // input grows for marginal benefit.
  const { data: signalsData, error: signalsErr } = await supabase
    .from("signals")
    .select("*")
    .eq("company_id", company.id)
    .order("detected_at", { ascending: false })
    .limit(25);
  if (signalsErr) {
    return {
      ok: false,
      company_id: company.id,
      error: `fetch signals: ${signalsErr.message}`,
    };
  }
  const signals = (signalsData ?? []) as Signal[];

  // Build the request, score, persist.
  const ai = client ?? anthropicClient();
  let scoring: Scoring;
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
        {
          role: "user",
          content: [
            "## Campaign",
            renderCampaign(campaign),
            "",
            "## Company profile",
            renderProfile(company),
            "",
            "## Signals",
            renderSignals(signals),
          ].join("\n"),
        },
      ],
      output_config: { format: zodOutputFormat(ScoringSchema) },
    });
    cacheReads = response.usage.cache_read_input_tokens ?? 0;
    cacheWrites = response.usage.cache_creation_input_tokens ?? 0;
    if (!response.parsed_output) {
      throw new Error(`no parsed_output (stop_reason=${response.stop_reason})`);
    }
    scoring = response.parsed_output;
    if (scoring.primary_signal_id) {
      const allowed = new Set(signals.map((s) => s.id));
      if (!allowed.has(scoring.primary_signal_id)) {
        scoring.primary_signal_id = null;
        scoring.primary_signal_reason = null;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logActivity(
      "score_company_failed",
      "company",
      company.id,
      { domain: company.domain },
      "error",
      message,
    );
    return { ok: false, company_id: company.id, error: message };
  }

  // Persist score
  const { error: updateErr } = await supabase
    .from("companies")
    .update({ score: scoring.score })
    .eq("id", company.id);
  if (updateErr) {
    return {
      ok: false,
      company_id: company.id,
      error: `update score: ${updateErr.message}`,
    };
  }

  // Reset existing primary, then mark the chosen one.
  await supabase
    .from("signals")
    .update({ is_primary: false })
    .eq("company_id", company.id)
    .eq("is_primary", true);

  if (scoring.primary_signal_id) {
    await supabase
      .from("signals")
      .update({ is_primary: true })
      .eq("id", scoring.primary_signal_id);
  }

  await logActivity("score_company_succeeded", "company", company.id, {
    score: scoring.score,
    primary_signal_id: scoring.primary_signal_id,
    reasoning: scoring.reasoning.slice(0, 200),
    cache_reads: cacheReads,
    cache_writes: cacheWrites,
  });

  return {
    ok: true,
    company_id: company.id,
    score: scoring.score,
    primary_signal_id: scoring.primary_signal_id,
    cache: { reads: cacheReads, writes: cacheWrites },
  };
}
