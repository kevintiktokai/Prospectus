import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function Stub({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-6 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This view lights up in {phase}.
        </CardContent>
      </Card>
    </div>
  );
}
