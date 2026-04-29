// Phase 3 batch runner. Resumable: only touches enrichment_status='pending'
// rows, and the enricher uses an atomic claim transition so concurrent runs
// don't double-process. Concurrency 5 — well within Anthropic Haiku rate
// limits and pleasant for target sites.
//
// Run:  npm run enrich:companies
//       npm run enrich:companies -- --limit 50    # only N rows
//       npm run enrich:companies -- --concurrency 3

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import pLimit from "p-limit";
import Anthropic from "@anthropic-ai/sdk";

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { enrichCompany } from "../lib/enrichment/company-enricher";
import { closeBrowser } from "../lib/scrapers/website-scraper";
import type { Company } from "../types/database";

type Row = Pick<Company, "id" | "name" | "website" | "domain">;

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function fetchPending(limit: number | null): Promise<Row[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const remaining = limit ? Math.max(0, limit - rows.length) : pageSize;
    if (limit && remaining <= 0) break;
    const cap = Math.min(pageSize, remaining || pageSize);
    const { data, error } = await supabase
      .from("companies")
      .select("id,name,website,domain")
      .eq("enrichment_status", "pending")
      .not("website", "is", null)
      .order("discovered_at", { ascending: true })
      .range(from, from + cap - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < cap) break;
    from += cap;
  }
  return rows;
}

async function main() {
  const limit = Number(parseFlag("limit") ?? 0) || null;
  const concurrency = Number(parseFlag("concurrency") ?? 5);

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
  }

  const startedAt = Date.now();
  const rows = await fetchPending(limit);
  console.log(
    `[enrich] ${rows.length} pending companies, concurrency=${concurrency}`,
  );

  // One Anthropic client shared across all calls — keeps the HTTP
  // connection pool warm and lets the SDK retry transparently.
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tally = {
    enriched: 0,
    failed: 0,
    skipped: 0,
    cacheReads: 0,
    cacheWrites: 0,
  };

  const limiter = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        const result = await enrichCompany(row, ai);
        processed += 1;

        if (result.ok) {
          tally.enriched += 1;
          tally.cacheReads += result.cache.reads;
          tally.cacheWrites += result.cache.writes;
        } else if (result.error === "not_pending") {
          tally.skipped += 1;
        } else {
          tally.failed += 1;
        }

        if (processed % 10 === 0) {
          console.log(
            `[enrich] ${processed}/${rows.length} — enriched=${tally.enriched} failed=${tally.failed} skipped=${tally.skipped}`,
          );
        }
      }),
    ),
  );

  const ms = Date.now() - startedAt;
  await closeBrowser();

  await logActivity("enrich_batch_completed", null, null, {
    scanned: rows.length,
    enriched: tally.enriched,
    failed: tally.failed,
    skipped: tally.skipped,
    cache_read_tokens: tally.cacheReads,
    cache_write_tokens: tally.cacheWrites,
    duration_ms: ms,
    concurrency,
  });

  console.log("");
  console.log("[enrich] summary");
  console.log(`  scanned:        ${rows.length}`);
  console.log(`  enriched:       ${tally.enriched}`);
  console.log(`  failed:         ${tally.failed}`);
  console.log(`  skipped:        ${tally.skipped}`);
  console.log(`  cache reads:    ${tally.cacheReads.toLocaleString()} tokens`);
  console.log(`  cache writes:   ${tally.cacheWrites.toLocaleString()} tokens`);
  console.log(`  duration:       ${(ms / 1000).toFixed(1)}s`);
  if (rows.length > 0) {
    const ratio = ((tally.enriched / rows.length) * 100).toFixed(1);
    console.log(`  enriched rate:  ${ratio}% (gate: ≥70%)`);
  }
}

main().catch(async (err) => {
  console.error("[enrich] fatal:", err);
  await closeBrowser();
  process.exit(1);
});
