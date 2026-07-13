import type { Metadata } from "next";

import { AdminWorkspace } from "@/components/AdminWorkspace";
import { currentSeoPage, seoMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return { title: "Staff editorial workspace — RepairPrint Index", ...seoMetadata(currentSeoPage("/admin")) };
}

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <p className="eyebrow">Private staff area</p>
        <h1>Editorial workspace</h1>
        <p>Prepare sourced candidates, review every material claim, and publish only after every independent gate passes.</p>
      </header>
      <AdminWorkspace />
    </div>
  );
}
