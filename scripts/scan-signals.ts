// Phase 4 batch runner. Selects every enriched company that hasn't
// been scanned yet (last_signals_scan_at IS NULL) and runs the
// orchestrator. Resumable — re-running picks up where it stopped.
//
// Throttling: blog + careers run via the shared Playwright pool with
// configurable concurrency (default 3). News is serialised globally
// across the batch with a hard 3s gap to stay under Google's RSS
// rate limits.
//
// Run:  npm run scan:signals
//       npm run scan:signals -- --limit 50
//       npm run scan:signals -- --concurrency 2
//       npm run scan:signals -- --rescan         # ignore last_signals_scan_at

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import pLimit from "p-limit";

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { findSignals } from "../lib/enrichment/signals-finder";
import { closeBrowser } from "../lib/scrapers/_browser";
import type { Company } from "../types/database";

type Row = Pick<Company, "id" | "name" | "website" | "domain">;

const NEWS_THROTTLE_MS = 3000;

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function fetchTargets(opts: {
  limit: number | null;
  rescan: boolean;
}): Promise<Row[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const remaining = opts.limit ? Math.max(0, opts.limit - rows.length) : pageSize;
    if (opts.limit && remaining <= 0) break;
    const cap = Math.min(pageSize, remaining || pageSize);
    let query = supabase
      .from("companies")
      .select("id,name,website,domain")
      .eq("enrichment_status", "enriched")
      .not("website", "is", null);
    if (!opts.rescan) {
      query = query.is("last_signals_scan_at", null);
    }
    const { data, error } = await query
      .order("score", { ascending: false, nullsFirst: false })
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
  const concurrency = Math.max(1, Number(parseFlag("concurrency") ?? 3));
  const rescan = hasFlag("rescan");

  const startedAt = Date.now();
  const rows = await fetchTargets({ limit, rescan });
  console.log(
    `[signals] ${rows.length} target companies, concurrency=${concurrency}, rescan=${rescan}`,
  );

  const tally = {
    scanned: 0,
    inserted: 0,
    blogOk: 0,
    careersOk: 0,
    newsOk: 0,
    errors: 0,
  };

  // Throttle the news scraper globally so we never exceed the budget,
  // independent of Playwright concurrency.
  let nextNewsAllowedAt = 0;
  async function throttleNews(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, nextNewsAllowedAt - now);
    nextNewsAllowedAt = (now + wait) + NEWS_THROTTLE_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const limiter = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        await throttleNews();
        try {
          const out = await findSignals(row);
          tally.scanned += 1;
          tally.inserted += out.total_inserted;
          if (out.blog.ok) tally.blogOk += 1;
          if (out.careers.ok) tally.careersOk += 1;
          if (out.news.ok) tally.newsOk += 1;
        } catch (err) {
          tally.errors += 1;
          await logActivity(
            "signals_scan_error",
            "company",
            row.id,
            { domain: row.domain, name: row.name },
            "error",
            err instanceof Error ? err.message : String(err),
          );
        }
        processed += 1;
        if (processed % 10 === 0) {
          console.log(
            `[signals] ${processed}/${rows.length} — inserted=${tally.inserted} errors=${tally.errors}`,
          );
        }
      }),
    ),
  );

  const ms = Date.now() - startedAt;
  await closeBrowser();

  await logActivity("signals_batch_completed", null, null, {
    scanned: tally.scanned,
    inserted: tally.inserted,
    blog_ok: tally.blogOk,
    careers_ok: tally.careersOk,
    news_ok: tally.newsOk,
    errors: tally.errors,
    duration_ms: ms,
    concurrency,
    rescan,
  });

  console.log("");
  console.log("[signals] summary");
  console.log(`  scanned:        ${tally.scanned}`);
  console.log(`  inserted rows:  ${tally.inserted}`);
  console.log(`  blog ok:        ${tally.blogOk}`);
  console.log(`  careers ok:     ${tally.careersOk}`);
  console.log(`  news ok:        ${tally.newsOk}`);
  console.log(`  errors:         ${tally.errors}`);
  console.log(`  duration:       ${(ms / 1000).toFixed(1)}s`);
}

main().catch(async (err) => {
  console.error("[signals] fatal:", err);
  await closeBrowser();
  process.exit(1);
});
