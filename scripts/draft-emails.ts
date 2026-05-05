// Phase 7 batch runner. For each (high-scoring company, primary
// contact with verified email, primary signal), generate a first-touch
// draft and queue it for review at /dashboard/drafts.
//
// Resumable via the `alreadyHasDraft` guard inside draftFirstTouch.
//
// Run:  npm run draft:emails
//       npm run draft:emails -- --limit 30
//       npm run draft:emails -- --min-score 70 --concurrency 3
//       npm run draft:emails -- --campaign <id>

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import pLimit from "p-limit";
import Anthropic from "@anthropic-ai/sdk";

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { draftFirstTouch } from "../lib/drafting/email-drafter";
import type {
  Campaign,
  Company,
  Contact,
  Signal,
} from "../types/database";

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function fetchActiveCampaign(idHint?: string): Promise<Campaign> {
  const supabase = createServerClient();
  if (idHint) {
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", idHint)
      .maybeSingle();
    if (error) throw new Error(`fetch campaign: ${error.message}`);
    if (!data) throw new Error(`campaign not found: ${idHint}`);
    return data as Campaign;
  }
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fetch campaign: ${error.message}`);
  if (!data) throw new Error("no active campaign found");
  return data as Campaign;
}

type Triple = { company: Company; contact: Contact; signal: Signal };

async function fetchTargets(opts: {
  minScore: number;
  limit: number | null;
}): Promise<Triple[]> {
  const supabase = createServerClient();

  const { data: companies, error: companiesErr } = await supabase
    .from("companies")
    .select("*")
    .eq("enrichment_status", "enriched")
    .gte("score", opts.minScore)
    .order("score", { ascending: false, nullsFirst: false });
  if (companiesErr) {
    throw new Error(`fetch companies: ${companiesErr.message}`);
  }

  const triples: Triple[] = [];
  for (const c of (companies ?? []) as Company[]) {
    if (opts.limit && triples.length >= opts.limit) break;

    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("company_id", c.id)
      .eq("is_primary_contact", true)
      .eq("email_verified", true)
      .limit(1)
      .maybeSingle();
    if (!contact) continue;

    const { data: signal } = await supabase
      .from("signals")
      .select("*")
      .eq("company_id", c.id)
      .eq("is_primary", true)
      .limit(1)
      .maybeSingle();
    if (!signal) continue;

    triples.push({
      company: c,
      contact: contact as Contact,
      signal: signal as Signal,
    });
  }

  return triples;
}

async function main() {
  const minScore = Math.max(0, Number(parseFlag("min-score") ?? 70));
  const limit = Number(parseFlag("limit") ?? 0) || null;
  const concurrency = Math.max(1, Number(parseFlag("concurrency") ?? 3));
  const campaignIdFlag = parseFlag("campaign");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
  }

  const startedAt = Date.now();
  const campaign = await fetchActiveCampaign(campaignIdFlag);
  console.log(`[draft] campaign: ${campaign.name} (${campaign.id})`);

  const triples = await fetchTargets({ minScore, limit });
  console.log(
    `[draft] ${triples.length} eligible (score >= ${minScore}, primary contact verified, primary signal set)`,
  );

  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tally = {
    drafted: 0,
    skipped: 0,
    failed: 0,
    retries: 0,
    cacheReads: 0,
    cacheWrites: 0,
  };

  const limiter = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    triples.map(({ company, contact, signal }) =>
      limiter(async () => {
        const result = await draftFirstTouch(
          campaign,
          company,
          contact,
          signal,
          ai,
        );
        processed += 1;
        if (result.ok) {
          tally.drafted += 1;
          if (result.retried) tally.retries += 1;
          tally.cacheReads += result.cache.reads;
          tally.cacheWrites += result.cache.writes;
        } else if (result.error === "already_drafted") {
          tally.skipped += 1;
        } else {
          tally.failed += 1;
        }
        if (processed % 10 === 0) {
          console.log(
            `[draft] ${processed}/${triples.length} — drafted=${tally.drafted} skipped=${tally.skipped} failed=${tally.failed}`,
          );
        }
      }),
    ),
  );

  const ms = Date.now() - startedAt;
  await logActivity("draft_batch_completed", "campaign", campaign.id, {
    ...tally,
    duration_ms: ms,
    concurrency,
    min_score: minScore,
  });

  console.log("");
  console.log("[draft] summary");
  console.log(`  eligible:        ${triples.length}`);
  console.log(`  drafted:         ${tally.drafted}`);
  console.log(`  retries needed:  ${tally.retries}`);
  console.log(`  skipped (dup):   ${tally.skipped}`);
  console.log(`  failed:          ${tally.failed}`);
  console.log(`  cache reads:     ${tally.cacheReads.toLocaleString()} tokens`);
  console.log(`  cache writes:    ${tally.cacheWrites.toLocaleString()} tokens`);
  console.log(`  duration:        ${(ms / 1000).toFixed(1)}s`);
  console.log("");
  console.log(`Review at /dashboard/drafts before sending anywhere.`);
}

main().catch((err) => {
  console.error("[draft] fatal:", err);
  process.exit(1);
});
