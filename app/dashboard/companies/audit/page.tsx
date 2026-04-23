import { createServerClient } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Company, EnrichmentStatus } from "@/types/database";

export const dynamic = "force-dynamic";

const ALL_STATUSES: EnrichmentStatus[] = [
  "pending",
  "enriching",
  "enriched",
  "failed",
  "skipped",
];

type AuditData = {
  counts: Record<EnrichmentStatus, number>;
  total: number;
  skipReasons: Array<{ reason: string; count: number }>;
  pendingSample: Company[];
  skippedSample: Company[];
  error: string | null;
};

async function fetchAudit(): Promise<AuditData> {
  const empty: AuditData = {
    counts: {
      pending: 0,
      enriching: 0,
      enriched: 0,
      failed: 0,
      skipped: 0,
    },
    total: 0,
    skipReasons: [],
    pendingSample: [],
    skippedSample: [],
    error: null,
  };

  try {
    const supabase = createServerClient();

    const countsEntries = await Promise.all(
      ALL_STATUSES.map(async (status) => {
        const { count } = await supabase
          .from("companies")
          .select("*", { count: "exact", head: true })
          .eq("enrichment_status", status);
        return [status, count ?? 0] as const;
      }),
    );

    const counts = Object.fromEntries(countsEntries) as Record<
      EnrichmentStatus,
      number
    >;
    const total = countsEntries.reduce((a, [, n]) => a + n, 0);

    const { data: skipped } = await supabase
      .from("companies")
      .select("enrichment_error")
      .eq("enrichment_status", "skipped");

    const reasonMap = new Map<string, number>();
    for (const row of skipped ?? []) {
      const raw = row.enrichment_error ?? "unknown";
      const key = raw.startsWith("junk_domain:")
        ? raw.slice("junk_domain:".length)
        : raw;
      reasonMap.set(key, (reasonMap.get(key) ?? 0) + 1);
    }
    const skipReasons = Array.from(reasonMap.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    const [{ data: pendingSample }, { data: skippedSample }] =
      await Promise.all([
        supabase
          .from("companies")
          .select("*")
          .eq("enrichment_status", "pending")
          .order("discovered_at", { ascending: false })
          .limit(20),
        supabase
          .from("companies")
          .select("*")
          .eq("enrichment_status", "skipped")
          .order("discovered_at", { ascending: false })
          .limit(20),
      ]);

    return {
      counts,
      total,
      skipReasons,
      pendingSample: (pendingSample ?? []) as Company[],
      skippedSample: (skippedSample ?? []) as Company[],
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function GatePill({ passed }: { passed: boolean }) {
  return (
    <span
      className={
        passed
          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
          : "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      }
    >
      {passed ? "PASS" : "BELOW THRESHOLD"}
    </span>
  );
}

export default async function AuditPage() {
  const { counts, total, skipReasons, pendingSample, skippedSample, error } =
    await fetchAudit();

  const gatePassed = counts.pending >= 250;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Companies audit
          </h1>
          <p className="text-sm text-muted-foreground">
            Phase 2.5 data quality snapshot
          </p>
        </div>
        <GatePill passed={gatePassed} />
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load audit</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {ALL_STATUSES.map((s) => (
          <Card key={s}>
            <CardHeader className="pb-2">
              <CardTitle className="capitalize">{s}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">
                {counts[s].toLocaleString()}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Phase 2.5 quality gate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              Companies with <code>enrichment_status = &apos;pending&apos;</code>
            </span>
            <span className="font-semibold tabular-nums">
              {counts.pending.toLocaleString()} / 250 minimum
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Total in DB</span>
            <span className="font-semibold tabular-nums">
              {total.toLocaleString()}
            </span>
          </div>
          {!gatePassed && (
            <p className="pt-2 text-sm text-amber-700">
              Below threshold. Expand the Phase 2 crawl (more cities + specialist
              terms like &quot;technical recruitment&quot;, &quot;finance
              recruitment&quot;, &quot;healthcare recruitment&quot;) before
              starting Phase 3.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skipped reasons</CardTitle>
        </CardHeader>
        <CardContent>
          {skipReasons.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No skipped companies yet. Run{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                npm run filter:apply
              </code>
              .
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skipReasons.map((r) => (
                  <TableRow key={r.reason}>
                    <TableCell className="font-mono text-xs">
                      {r.reason}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.count.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SampleCard title="Pending (sample of 20)" rows={pendingSample} />
        <SampleCard title="Skipped (sample of 20)" rows={skippedSample} />
      </div>
    </div>
  );
}

function SampleCard({ title, rows }: { title: string; rows: Company[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Nothing here.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>City</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.domain ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.city ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
