// Phase 2.5 audit — reports only, writes no state.
//
// Run:  npx tsx scripts/audit-phase-2.ts
//
// Prints a markdown block suitable for pasting under "Phase 2 Audit" in
// BUILD_PROGRESS.md. Shape:
//   * totals & with/without website
//   * counts by city
//   * counts by enrichment_status
//   * counts by (detected) junk reason
//   * duplicate-domain check (should be zero after the Phase 2 crawl)
//   * 30 random-ish sample rows

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createServerClient } from "../lib/supabase/server";
import { classifyJunkDomain, type JunkReason } from "../lib/utils/domain";
import type { Company } from "../types/database";

type Row = Pick<
  Company,
  "id" | "name" | "domain" | "website" | "city" | "enrichment_status"
>;

async function fetchAll(): Promise<Row[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("companies")
      .select("id,name,domain,website,city,enrichment_status")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function tally<T extends string | null>(values: Iterable<T>): Map<T, number> {
  const map = new Map<T, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return map;
}

function topEntries<K>(map: Map<K, number>, n = 20): Array<[K, number]> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function mdTable(header: string[], body: string[][]): string {
  const sep = header.map(() => "---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function pickSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(Math.random() * arr.length));
  return Array.from(picked)
    .sort((a, b) => a - b)
    .map((i) => arr[i]);
}

async function main() {
  const rows = await fetchAll();
  const total = rows.length;

  const withWebsite = rows.filter((r) => r.website && r.domain).length;
  const withoutWebsite = total - withWebsite;

  const byCity = tally(rows.map((r) => r.city ?? "(unknown)"));
  const byStatus = tally(rows.map((r) => r.enrichment_status));

  const junkTally = new Map<JunkReason, number>();
  for (const r of rows) {
    const reason = classifyJunkDomain(r.domain);
    if (reason) junkTally.set(reason, (junkTally.get(reason) ?? 0) + 1);
  }

  // Duplicate-domain check. Should be zero — the unique index enforces it —
  // but we report anyway so the gate is self-contained.
  const domainCount = new Map<string, number>();
  for (const r of rows) {
    if (!r.domain) continue;
    domainCount.set(r.domain, (domainCount.get(r.domain) ?? 0) + 1);
  }
  const duplicates = Array.from(domainCount.entries()).filter(
    ([, c]) => c > 1,
  );

  const pendingRows = rows.filter((r) => r.enrichment_status === "pending");
  const sample = pickSample(pendingRows, 30);

  const lines: string[] = [];
  lines.push(`### Phase 2 Audit — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Total companies: **${total}**`);
  lines.push(`- With website + domain: **${withWebsite}**`);
  lines.push(`- Without website/domain: **${withoutWebsite}**`);
  lines.push(`- Duplicate domains: **${duplicates.length}**`);
  lines.push("");
  lines.push("**By enrichment_status**");
  lines.push("");
  lines.push(
    mdTable(
      ["status", "count"],
      Array.from(byStatus.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k ?? "(null)", String(v)]),
    ),
  );
  lines.push("");
  lines.push("**By city (top 20)**");
  lines.push("");
  lines.push(
    mdTable(
      ["city", "count"],
      topEntries(byCity, 20).map(([k, v]) => [String(k), String(v)]),
    ),
  );
  lines.push("");
  lines.push("**Detected junk domains (will be flipped to `skipped`)**");
  lines.push("");
  if (junkTally.size === 0) {
    lines.push("_None detected._");
  } else {
    lines.push(
      mdTable(
        ["reason", "count"],
        Array.from(junkTally.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, String(v)]),
      ),
    );
  }
  lines.push("");
  if (duplicates.length > 0) {
    lines.push("**Duplicate domains (should be zero)**");
    lines.push("");
    lines.push(
      mdTable(
        ["domain", "count"],
        duplicates.map(([d, c]) => [d, String(c)]),
      ),
    );
    lines.push("");
  }
  lines.push(`**Random sample of 30 \`pending\` rows**`);
  lines.push("");
  lines.push(
    mdTable(
      ["name", "domain", "city"],
      sample.map((r) => [
        r.name,
        r.domain ?? "—",
        r.city ?? "—",
      ]),
    ),
  );
  lines.push("");
  lines.push(
    `_Paste the block above into \`BUILD_PROGRESS.md\` under "Phase 2 Audit"._`,
  );

  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  console.error("[audit] fatal:", err);
  process.exit(1);
});
