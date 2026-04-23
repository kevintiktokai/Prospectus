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
import type { Company } from "@/types/database";

export const dynamic = "force-dynamic";

type Stats = {
  companies: number;
  contacts: number;
  signals: number;
  emailsSent: number;
};

type SourceCount = { source: string; count: number };

async function fetchOverview(): Promise<{
  stats: Stats;
  recentCompanies: Company[];
  sourceCounts: SourceCount[];
  error: string | null;
}> {
  try {
    const supabase = createServerClient();

    const [companies, contacts, signals, emailsSent, recent, sources] =
      await Promise.all([
        supabase.from("companies").select("*", { count: "exact", head: true }),
        supabase.from("contacts").select("*", { count: "exact", head: true }),
        supabase.from("signals").select("*", { count: "exact", head: true }),
        supabase
          .from("email_sequences")
          .select("*", { count: "exact", head: true })
          .eq("status", "sent"),
        supabase
          .from("companies")
          .select("*")
          .order("discovered_at", { ascending: false })
          .limit(20),
        supabase.from("companies").select("source"),
      ]);

    const sourceCounts = new Map<string, number>();
    for (const row of sources.data ?? []) {
      const key = row.source ?? "unknown";
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    }

    return {
      stats: {
        companies: companies.count ?? 0,
        contacts: contacts.count ?? 0,
        signals: signals.count ?? 0,
        emailsSent: emailsSent.count ?? 0,
      },
      recentCompanies: (recent.data ?? []) as Company[],
      sourceCounts: Array.from(sourceCounts.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      error: null,
    };
  } catch (err) {
    return {
      stats: { companies: 0, contacts: 0, signals: 0, emailsSent: 0 },
      recentCompanies: [],
      sourceCounts: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export default async function OverviewPage() {
  const { stats, recentCompanies, sourceCounts, error } = await fetchOverview();

  const cards = [
    { label: "Companies", value: stats.companies },
    { label: "Contacts", value: stats.contacts },
    { label: "Signals", value: stats.signals },
    { label: "Emails sent", value: stats.emailsSent },
  ];

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          UK Recruitment Agencies v1 · pipeline snapshot
        </p>
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Supabase not connected</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Counts default to zero until env vars are set and the migration has
            run. Error: {error}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="pb-2">
              <CardTitle>{c.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">
                {c.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recently discovered companies</CardTitle>
          </CardHeader>
          <CardContent>
            {recentCompanies.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No companies yet. Run{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  npx tsx scripts/crawl-uk-recruitment.ts
                </code>
                .
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead className="text-right">Discovered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentCompanies.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.domain ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.city ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {new Date(c.discovered_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Companies by source</CardTitle>
          </CardHeader>
          <CardContent>
            {sourceCounts.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No data yet.
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {sourceCounts.map((s) => (
                  <li
                    key={s.source}
                    className="flex items-center justify-between"
                  >
                    <span className="text-muted-foreground">{s.source}</span>
                    <span className="font-semibold tabular-nums">
                      {s.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
