import Link from "next/link";
import {
  Activity,
  Building2,
  LayoutDashboard,
  Mail,
  MailCheck,
  MessageSquare,
  PenLine,
  Target,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/companies", label: "Companies", icon: Building2 },
  { href: "/dashboard/contacts", label: "Contacts", icon: Users },
  { href: "/dashboard/campaigns", label: "Campaigns", icon: Target },
  { href: "/dashboard/drafts", label: "Drafts", icon: PenLine },
  { href: "/dashboard/sent", label: "Sent", icon: Mail },
  { href: "/dashboard/replies", label: "Replies", icon: MessageSquare },
  { href: "/dashboard/activity", label: "Activity Log", icon: Activity },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex h-14 items-center border-b px-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <MailCheck className="h-4 w-4" />
            LayerSync Outreach
          </Link>
        </div>
        <nav className="flex-1 space-y-1 p-2 text-sm">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2",
                  "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          Phase 1 · foundation
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
