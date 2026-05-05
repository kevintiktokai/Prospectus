// Phase 6 batch runner. Scores every enriched company against the
// active campaign. Resumable via --rescore-since /
// --only-pending-score.
//
// Run:  npm run score:companies
//       npm run score:companies -- --limit 50
//       npm run score:companies -- --rescore        # rescore everything
//       npm run score:companies -- --campaign <id>  # non-default campaign

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import pLimit from "p-limit";
import Anthropic from "@anthropic-ai/sdk";

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { scoreAndPersist } from "../lib/scoring/company-scorer";
import type { Campaign, Company } from "../types/database";

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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
  if (!data) throw new Error("no active campaign found — seed one first");
  return data as Campaign;
}

async function fetchTargets(opts: {
  limit: number | null;
  rescore: boolean;
}): Promise<Company[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Company[] = [];
  for (;;) {
    const remaining = opts.limit ? Math.max(0, opts.limit - rows.length) : pageSize;
    if (opts.limit && remaining <= 0) break;
    const cap = Math.min(pageSize, remaining || pageSize);
    let query = supabase
      .from("companies")
      .select("*")
      .eq("enrichment_status", "enriched");
    if (!opts.rescore) {
      query = query.is("score", null);
    }
    const { data, error } = await query
      .order("discovered_at", { ascending: true })
      .range(from, from + cap - 1);
    if (error) throw new Error(`fetch companies: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Company[]));
    if (data.length < cap) break;
    from += cap;
  }
  return rows;
}

async function main() {
  const limit = Number(parseFlag("limit") ?? 0) || null;
  const concurrency = Math.max(1, Number(parseFlag("concurrency") ?? 5));
  const rescore = hasFlag("rescore");
  const campaignIdFlag = parseFlag("campaign");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
  }

  const startedAt = Date.now();
  const campaign = await fetchActiveCampaign(campaignIdFlag);
  console.log(`[score] campaign: ${campaign.name} (${campaign.id})`);

  const rows = await fetchTargets({ limit, rescore });
  console.log(
    `[score] ${rows.length} target companies, concurrency=${concurrency}, rescore=${rescore}`,
  );

  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tally = {
    scored: 0,
    failed: 0,
    cacheReads: 0,
    cacheWrites: 0,
    distribution: { "<25": 0, "25-49": 0, "50-69": 0, "70-89": 0, "90+": 0 },
  };

  const limiter = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        const result = await scoreAndPersist(campaign, row, ai);
        processed += 1;
        if (result.ok) {
          tally.scored += 1;
          tally.cacheReads += result.cache.reads;
          tally.cacheWrites += result.cache.writes;
          const s = result.score;
          if (s >= 90) tally.distribution["90+"] += 1;
          else if (s >= 70) tally.distribution["70-89"] += 1;
          else if (s >= 50) tally.distribution["50-69"] += 1;
          else if (s >= 25) tally.distribution["25-49"] += 1;
          else tally.distribution["<25"] += 1;
        } else {
          tally.failed += 1;
        }
        if (processed % 10 === 0) {
          console.log(
            `[score] ${processed}/${rows.length} — scored=${tally.scored} failed=${tally.failed}`,
          );
        }
      }),
    ),
  );

  const ms = Date.now() - startedAt;
  await logActivity("score_batch_completed", "campaign", campaign.id, {
    ...tally,
    duration_ms: ms,
    concurrency,
    rescore,
  });

  console.log("");
  console.log("[score] summary");
  console.log(`  scored:           ${tally.scored}`);
  console.log(`  failed:           ${tally.failed}`);
  console.log(`  distribution:`);
  console.log(`    <25:            ${tally.distribution["<25"]}`);
  console.log(`    25–49:          ${tally.distribution["25-49"]}`);
  console.log(`    50–69:          ${tally.distribution["50-69"]}`);
  console.log(`    70–89:          ${tally.distribution["70-89"]}`);
  console.log(`    90+:            ${tally.distribution["90+"]}`);
  console.log(`  cache reads:      ${tally.cacheReads.toLocaleString()} tokens`);
  console.log(`  cache writes:     ${tally.cacheWrites.toLocaleString()} tokens`);
  console.log(`  duration:         ${(ms / 1000).toFixed(1)}s`);
  const seventyPlus =
    tally.distribution["70-89"] + tally.distribution["90+"];
  console.log(`  score >=70:       ${seventyPlus} (gate: ≥50)`);
}

main().catch((err) => {
  console.error("[score] fatal:", err);
  process.exit(1);
});
