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

async function fetchOverview(): Promise<{
  stats: Stats;
  recentCompanies: Company[];
  error: string | null;
}> {
  try {
    const supabase = createServerClient();

    const [companies, contacts, signals, emailsSent, recent] =
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
      ]);

    return {
      stats: {
        companies: companies.count ?? 0,
        contacts: contacts.count ?? 0,
        signals: signals.count ?? 0,
        emailsSent: emailsSent.count ?? 0,
      },
      recentCompanies: (recent.data ?? []) as Company[],
      error: null,
    };
  } catch (err) {
    return {
      stats: { companies: 0, contacts: 0, signals: 0, emailsSent: 0 },
      recentCompanies: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export default async function OverviewPage() {
  const { stats, recentCompanies, error } = await fetchOverview();

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

      <Card>
        <CardHeader>
          <CardTitle>Recently discovered companies</CardTitle>
        </CardHeader>
        <CardContent>
          {recentCompanies.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No companies yet. Scrapers come online in Phase 2.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
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
                    <TableCell className="text-muted-foreground">
                      {c.source}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.enrichment_status}
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
    </div>
  );
}
