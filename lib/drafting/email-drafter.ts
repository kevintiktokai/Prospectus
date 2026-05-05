// Phase 7 — first-touch email drafting via Claude Sonnet 4.6.
//
// Pipeline per (company, primary contact, primary signal):
//   1. Render system prompt (cold-email principles + voice samples +
//      anti-patterns) — cached so request 2..N hit ~0.1× on the prefix.
//   2. messages.parse against a Zod schema → typed JSON, no fragile
//      regex parsing.
//   3. Validate: subject word count, body word count, forbidden
//      phrases. On fail, retry once with the validation errors fed
//      back to the model.
//   4. Insert email_sequences row (sequence_step=1, status='draft').

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import {
  VOICE_SAMPLES,
  findForbiddenPhrases,
  wordCount,
} from "@/lib/drafting/voice-samples";
import type { Campaign, Company, Contact, Signal } from "@/types/database";

const SONNET_MODEL = "claude-sonnet-4-6";
const SUBJECT_MAX_WORDS = 6;
const BODY_MAX_WORDS = 90;

export const DraftSchema = z.object({
  subject: z
    .string()
    .min(3)
    .max(120)
    .describe(
      `Lowercase, ${SUBJECT_MAX_WORDS} words max. No questions, no clickbait. Reference one specific thing about THIS agency.`,
    ),
  body: z
    .string()
    .min(40)
    .max(900)
    .describe(
      `Under ${BODY_MAX_WORDS} words. One specific observation, one hypothesis, one low-commitment CTA. Plain prose, no greeting line beyond "Hi {firstName},". Sign off "Kev". No filler phrases.`,
    ),
  signal_used: z
    .string()
    .min(5)
    .max(280)
    .describe(
      "Quote the part of the signal you anchored on (the job title, the blog headline, the news event).",
    ),
});

export type Draft = z.infer<typeof DraftSchema>;

function renderVoiceSamples(): string {
  return VOICE_SAMPLES.map(
    (s, i) => `### Sample ${i + 1}\nSubject: ${s.subject}\nBody:\n${s.body}`,
  ).join("\n\n");
}

const SYSTEM_PROMPT = `You write cold outreach emails for LayerSync. The recipient is a decision-maker at a UK recruitment agency.

PRINCIPLES — non-negotiable:
- Relevance > personalization. Anchor every email on a specific observable fact about this company (the signal you're given). Do NOT mention things that are true of any agency.
- One specific observation → one hypothesis about their pain → one low-commitment CTA. That's the entire structure.
- ${BODY_MAX_WORDS} words MAX in the body. Most good emails are 60–80.
- Subject line: lowercase, ${SUBJECT_MAX_WORDS} words max, no question marks, no exclamation marks, no clickbait. Reference one specific thing.
- Greeting is exactly "Hi {firstName}," — that placeholder is filled at send time, leave it literal.
- Sign off "Kev". One line. No title. No company name. No phone number. No "P.S."
- No greeting boilerplate, no "I hope this finds you well", no pleasantries.

ANTI-PATTERNS — these instantly kill a reply:
- "I wanted to reach out…" / "I'm reaching out because…"
- "touching base", "circling back", "synergies", "leverage", "unlock", "empower", "revolutionize", "game-changer"
- "quick 15-min on Tuesday" or any specific calendar invite — too presumptuous on first touch
- Listing features ("our platform does X, Y, Z") — they don't care
- Numbers that sound made up ("save 47% of your time")
- Asking how their day is going

VOICE — match these samples exactly. Same length, same register, same shape:

${renderVoiceSamples()}

OUTPUT STRUCTURE:
- subject: one short, specific phrase. Lowercase.
- body: starts with "Hi {firstName}," on its own line. Then 2–4 sentences. Blank line. "Kev"
- signal_used: quote the exact part of the supplied signal you used as the hook.

Hard rules the validator will reject on:
- Body > ${BODY_MAX_WORDS} words → REJECT
- Subject > ${SUBJECT_MAX_WORDS} words → REJECT
- Any anti-pattern phrase present → REJECT
- Body missing "Hi {firstName}," or missing "Kev" sign-off → REJECT`;

const anthropicClient = (): Anthropic => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
};

function renderUserPrompt(
  campaign: Campaign,
  company: Company,
  contact: Contact,
  signal: Signal,
  retryFeedback?: string,
): string {
  const parts = [
    `## Campaign value prop`,
    campaign.value_prop ?? "(missing)",
    "",
    `## Company`,
    `Name: ${company.name}`,
    `Domain: ${company.domain ?? "—"}`,
    `Sub-industry: ${company.sub_industry ?? "—"}`,
    `Description: ${company.description ?? "—"}`,
    `Services: ${
      Array.isArray(company.services) ? (company.services as string[]).join(", ") : "—"
    }`,
    "",
    `## Recipient`,
    `First name: ${contact.first_name ?? "(unknown)"}`,
    `Last name: ${contact.last_name ?? ""}`,
    `Title: ${contact.title ?? "(unknown)"}`,
    `Seniority: ${contact.seniority ?? "—"}`,
    "",
    `## Primary signal (anchor your hook on this)`,
    `Type: ${signal.type}`,
    `Detected: ${signal.detected_at?.slice(0, 10) ?? "—"}`,
    `Title: ${signal.title ?? "—"}`,
    signal.url ? `URL: ${signal.url}` : "",
    signal.content ? `Content: ${signal.content.slice(0, 600)}` : "",
  ].filter(Boolean);
  if (retryFeedback) {
    parts.push(
      "",
      "## Previous attempt failed validation:",
      retryFeedback,
      "",
      "Fix the listed issues. Keep the structure and voice samples in mind.",
    );
  }
  return parts.join("\n");
}

export type ValidationFailure = {
  reason: string;
  details: string[];
};

export function validateDraft(draft: Draft): ValidationFailure | null {
  const issues: string[] = [];

  if (wordCount(draft.subject) > SUBJECT_MAX_WORDS) {
    issues.push(
      `Subject is ${wordCount(draft.subject)} words; max is ${SUBJECT_MAX_WORDS}.`,
    );
  }
  if (draft.subject !== draft.subject.toLowerCase()) {
    issues.push("Subject must be all lowercase.");
  }
  if (/[?!]/.test(draft.subject)) {
    issues.push("Subject must not contain ? or !.");
  }

  const bodyWords = wordCount(draft.body);
  if (bodyWords > BODY_MAX_WORDS) {
    issues.push(`Body is ${bodyWords} words; max is ${BODY_MAX_WORDS}.`);
  }
  if (!/Hi\s+\{firstName\},/.test(draft.body)) {
    issues.push('Body must contain "Hi {firstName}," literally.');
  }
  if (!/\bKev\b/.test(draft.body)) {
    issues.push('Body must end with the "Kev" sign-off.');
  }
  const forbidden = findForbiddenPhrases(draft.body);
  if (forbidden.length > 0) {
    issues.push(`Forbidden phrase(s) present: ${forbidden.join(", ")}.`);
  }

  return issues.length === 0 ? null : { reason: "validator_failed", details: issues };
}

async function generateDraft(
  client: Anthropic,
  campaign: Campaign,
  company: Company,
  contact: Contact,
  signal: Signal,
  retryFeedback?: string,
): Promise<{ draft: Draft; cacheReads: number; cacheWrites: number }> {
  const response = await client.messages.parse({
    model: SONNET_MODEL,
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
        content: renderUserPrompt(campaign, company, contact, signal, retryFeedback),
      },
    ],
    output_config: { format: zodOutputFormat(DraftSchema) },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Sonnet returned no parsed output (stop_reason=${response.stop_reason})`,
    );
  }

  return {
    draft: response.parsed_output,
    cacheReads: response.usage.cache_read_input_tokens ?? 0,
    cacheWrites: response.usage.cache_creation_input_tokens ?? 0,
  };
}

export type DraftOutcome =
  | {
      ok: true;
      contact_id: string;
      sequence_id: string;
      draft: Draft;
      cache: { reads: number; writes: number };
      retried: boolean;
    }
  | {
      ok: false;
      contact_id: string;
      stage: "fetch" | "generate" | "validate" | "persist";
      error: string;
    };

// Skips when the contact already has a draft (sequence_step=1) for
// the same campaign — keeps the script idempotent.
async function alreadyHasDraft(
  contactId: string,
  campaignId: string,
): Promise<boolean> {
  const supabase = createServerClient();
  const { data } = await supabase
    .from("email_sequences")
    .select("id")
    .eq("contact_id", contactId)
    .eq("campaign_id", campaignId)
    .eq("sequence_step", 1)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

export async function draftFirstTouch(
  campaign: Campaign,
  company: Company,
  contact: Contact,
  signal: Signal,
  client?: Anthropic,
): Promise<DraftOutcome> {
  if (await alreadyHasDraft(contact.id, campaign.id)) {
    return {
      ok: false,
      contact_id: contact.id,
      stage: "persist",
      error: "already_drafted",
    };
  }

  const ai = client ?? anthropicClient();

  let attempt: { draft: Draft; cacheReads: number; cacheWrites: number };
  try {
    attempt = await generateDraft(ai, campaign, company, contact, signal);
  } catch (err) {
    return {
      ok: false,
      contact_id: contact.id,
      stage: "generate",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let validation = validateDraft(attempt.draft);
  let retried = false;
  if (validation) {
    retried = true;
    const feedback = validation.details.map((d) => `- ${d}`).join("\n");
    try {
      const second = await generateDraft(
        ai,
        campaign,
        company,
        contact,
        signal,
        feedback,
      );
      attempt = {
        draft: second.draft,
        cacheReads: attempt.cacheReads + second.cacheReads,
        cacheWrites: attempt.cacheWrites + second.cacheWrites,
      };
      validation = validateDraft(attempt.draft);
    } catch (err) {
      return {
        ok: false,
        contact_id: contact.id,
        stage: "generate",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (validation) {
    await logActivity(
      "draft_validation_failed",
      "contact",
      contact.id,
      {
        company_id: company.id,
        issues: validation.details,
        subject: attempt.draft.subject,
      },
      "error",
      validation.details.join(" | "),
    );
    return {
      ok: false,
      contact_id: contact.id,
      stage: "validate",
      error: validation.details.join(" | "),
    };
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("email_sequences")
    .insert({
      contact_id: contact.id,
      campaign_id: campaign.id,
      signal_id: signal.id,
      sequence_step: 1,
      subject: attempt.draft.subject,
      body: attempt.draft.body,
      status: "draft",
    })
    .select("id")
    .single();

  if (error || !data) {
    await logActivity(
      "draft_persist_failed",
      "contact",
      contact.id,
      { company_id: company.id },
      "error",
      error?.message ?? "unknown",
    );
    return {
      ok: false,
      contact_id: contact.id,
      stage: "persist",
      error: error?.message ?? "unknown",
    };
  }

  await logActivity("draft_created", "email_sequence", data.id, {
    contact_id: contact.id,
    company_id: company.id,
    signal_id: signal.id,
    retried,
    cache_reads: attempt.cacheReads,
    cache_writes: attempt.cacheWrites,
    subject: attempt.draft.subject,
  });

  return {
    ok: true,
    contact_id: contact.id,
    sequence_id: data.id,
    draft: attempt.draft,
    cache: { reads: attempt.cacheReads, writes: attempt.cacheWrites },
    retried,
  };
}
