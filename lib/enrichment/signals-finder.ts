// Signals orchestrator. Runs blog + careers + news for a single
// company, deduplicates against existing signals via the partial
// unique index from migration 0003, and updates last_signals_scan_at.
//
// The news scraper is throttled at the call site (1 query / 3s) — the
// website-based scrapers can run concurrently because each site is
// different and Playwright shares the browser pool.

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import { scrapeBlog, type BlogPost } from "@/lib/scrapers/signals/blog-scraper";
import {
  scrapeCareers,
  type JobPost,
} from "@/lib/scrapers/signals/careers-scraper";
import { scrapeNews, type NewsItem } from "@/lib/scrapers/signals/news-scraper";
import type { Company, SignalType } from "@/types/database";

export type SignalsScanOutcome = {
  company_id: string;
  blog: { ok: boolean; count: number; error?: string };
  careers: { ok: boolean; count: number; error?: string };
  news: { ok: boolean; count: number; error?: string };
  total_inserted: number;
};

type SignalRow = {
  company_id: string;
  type: SignalType;
  title: string;
  url: string | null;
  content: string | null;
  detected_at: string;
};

function parseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function blogToRow(post: BlogPost, companyId: string): SignalRow {
  return {
    company_id: companyId,
    type: "blog_post",
    title: post.title,
    url: post.url,
    content: post.snippet,
    detected_at: parseDate(post.publishedAt) ?? new Date().toISOString(),
  };
}

function jobToRow(post: JobPost, companyId: string): SignalRow {
  return {
    company_id: companyId,
    type: "job_post",
    title: post.title,
    url: post.url,
    content: [post.location, post.snippet].filter(Boolean).join(" — ") || null,
    detected_at: new Date().toISOString(),
  };
}

function newsToRow(item: NewsItem, companyId: string): SignalRow {
  return {
    company_id: companyId,
    type: "news",
    title: item.title,
    url: item.url,
    content: [item.source, item.snippet].filter(Boolean).join(" — ") || null,
    detected_at: parseDate(item.publishedAt) ?? new Date().toISOString(),
  };
}

async function persistSignals(rows: SignalRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const supabase = createServerClient();
  // The partial unique index `idx_signals_dedupe` will reject duplicate
  // (company_id, type, url) tuples — we use upsert with ignoreDuplicates
  // so re-runs are idempotent and we get the new-insert count back.
  const { data, error } = await supabase
    .from("signals")
    .upsert(rows, {
      onConflict: "company_id,type,url",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) {
    // Fall back to per-row insert with ON CONFLICT DO NOTHING semantics
    // via individual try/catch — Supabase's onConflict needs the index
    // name in some setups; this is the safety net.
    let inserted = 0;
    for (const row of rows) {
      const { error: e } = await supabase.from("signals").insert(row);
      if (!e) inserted += 1;
    }
    return inserted;
  }
  return data?.length ?? 0;
}

export async function findSignals(
  company: Pick<Company, "id" | "name" | "website" | "domain">,
): Promise<SignalsScanOutcome> {
  const outcome: SignalsScanOutcome = {
    company_id: company.id,
    blog: { ok: false, count: 0 },
    careers: { ok: false, count: 0 },
    news: { ok: false, count: 0 },
    total_inserted: 0,
  };

  const allRows: SignalRow[] = [];

  // Run web scrapers in parallel — each opens its own context.
  const tasks: Array<Promise<void>> = [];

  if (company.website) {
    tasks.push(
      (async () => {
        const result = await scrapeBlog(company.website!);
        if (!result.ok) {
          outcome.blog = { ok: false, count: 0, error: result.error };
          return;
        }
        const rows = result.posts.map((p) => blogToRow(p, company.id));
        allRows.push(...rows);
        outcome.blog = { ok: true, count: rows.length };
      })(),
    );

    tasks.push(
      (async () => {
        const result = await scrapeCareers(company.website!);
        if (!result.ok) {
          outcome.careers = { ok: false, count: 0, error: result.error };
          return;
        }
        const rows = result.posts.map((p) => jobToRow(p, company.id));
        allRows.push(...rows);
        outcome.careers = { ok: true, count: rows.length };
      })(),
    );
  } else {
    outcome.blog = { ok: false, count: 0, error: "no_website" };
    outcome.careers = { ok: false, count: 0, error: "no_website" };
  }

  await Promise.all(tasks);

  // News runs after — it's serialised across all companies in the
  // batch (orchestrator caller enforces 3s gap), so we keep it
  // sequential per company to match.
  const news = await scrapeNews(company.name);
  if (!news.ok) {
    outcome.news = { ok: false, count: 0, error: news.error };
  } else {
    const rows = news.items.map((i) => newsToRow(i, company.id));
    allRows.push(...rows);
    outcome.news = { ok: true, count: rows.length };
  }

  outcome.total_inserted = await persistSignals(allRows);

  // Stamp last_signals_scan_at regardless of partial failure so the
  // batch runner can skip this row next time. Errors live in the
  // activity log.
  const supabase = createServerClient();
  await supabase
    .from("companies")
    .update({ last_signals_scan_at: new Date().toISOString() })
    .eq("id", company.id);

  await logActivity("signals_scan_completed", "company", company.id, {
    domain: company.domain,
    blog: outcome.blog,
    careers: outcome.careers,
    news: outcome.news,
    inserted: outcome.total_inserted,
  });

  return outcome;
}
