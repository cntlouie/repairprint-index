import type { Metadata } from "next";

import { AdminWorkspace } from "@/components/AdminWorkspace";

export const metadata: Metadata = {
  title: "Staff editorial workspace — RepairPrint Index",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <p className="eyebrow">Private staff area</p>
        <h1>Editorial workspace</h1>
        <p>Prepare sourced candidates, review every material claim, and publish only after every independent gate passes.</p>
      </header>
      <AdminWorkspace />
    </main>
  );
}
