// Phase 2.5 filter pass — flips junk-domain rows from 'pending' to
// 'skipped' and records the reason in enrichment_error. Idempotent:
// re-running won't re-flip already-skipped rows.
//
// Run:  npx tsx scripts/apply-filter-pass.ts
//       npx tsx scripts/apply-filter-pass.ts --dry-run   (no writes)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { classifyJunkDomain } from "../lib/utils/domain";
import type { Company } from "../types/database";

type Row = Pick<Company, "id" | "name" | "domain">;

async function fetchPending(): Promise<Row[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("companies")
      .select("id,name,domain")
      .eq("enrichment_status", "pending")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = Date.now();
  const supabase = createServerClient();

  const rows = await fetchPending();
  console.log(`[filter] scanning ${rows.length} pending companies`);

  const buckets = { no_domain: 0, social_url: 0, job_board: 0, gov_uk: 0 };
  let flipped = 0;
  let errors = 0;

  for (const row of rows) {
    const reason = classifyJunkDomain(row.domain);
    if (!reason) continue;
    buckets[reason] += 1;

    if (dryRun) continue;

    const { error } = await supabase
      .from("companies")
      .update({
        enrichment_status: "skipped",
        enrichment_error: `junk_domain:${reason}`,
      })
      .eq("id", row.id)
      .eq("enrichment_status", "pending");

    if (error) {
      errors += 1;
      await logActivity(
        "filter_pass_error",
        "company",
        row.id,
        { reason, domain: row.domain, name: row.name },
        "error",
        error.message,
      );
      continue;
    }

    flipped += 1;
    await logActivity(
      "filter_pass_skipped",
      "company",
      row.id,
      { reason, domain: row.domain, name: row.name },
      "warning",
    );
  }

  const ms = Date.now() - startedAt;

  await logActivity(
    dryRun ? "filter_pass_dry_run" : "filter_pass_completed",
    null,
    null,
    {
      scanned: rows.length,
      flipped: dryRun ? 0 : flipped,
      would_flip: dryRun ? buckets : undefined,
      buckets,
      errors,
      duration_ms: ms,
    },
  );

  console.log("");
  console.log("[filter] summary");
  console.log(`  scanned:      ${rows.length}`);
  console.log(`  no_domain:    ${buckets.no_domain}`);
  console.log(`  social_url:   ${buckets.social_url}`);
  console.log(`  job_board:    ${buckets.job_board}`);
  console.log(`  gov_uk:       ${buckets.gov_uk}`);
  console.log(
    `  ${dryRun ? "would flip:   " : "flipped:      "}${
      dryRun
        ? Object.values(buckets).reduce((a, b) => a + b, 0)
        : flipped
    }`,
  );
  console.log(`  errors:       ${errors}`);
  console.log(`  duration:     ${(ms / 1000).toFixed(1)}s`);
  if (dryRun) console.log("  (dry run — no writes)");
}

main().catch((err) => {
  console.error("[filter] fatal:", err);
  process.exit(1);
});
