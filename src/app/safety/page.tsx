import type { Metadata } from "next";
import Link from "next/link";

import { PolicyStatus } from "@/components/PolicyStatus";
import { trustPageMetadata } from "@/lib/trust-metadata";

export function generateMetadata(): Metadata {
  return trustPageMetadata("/safety", "Safety policy", "RepairPrint's low-risk v0 safety boundary and urgent-review process.");
}

export default function SafetyPage() {
  return (
    <div className="shell page-shell policy-page">
      <span className="eyebrow">V0 safety boundary</span>
      <h1>Low-risk external parts only</h1>
      <p className="lede narrow">A fitment badge is not a safety certification or guarantee. Printed parts vary with material, orientation, calibration, ageing, environment, and use.</p>
      <PolicyStatus scope="v0 safety screening policy" />

      <h2>Potentially publishable after review</h2>
      <p>Cosmetic covers, cable guides, low-load clips, latches, knobs, buttons, feet, retainers, and external hose or dust adapters may be indexed only when failure is limited to inconvenience and the independent review remains current.</p>

      <h2>Kept private during v0</h2>
      <p>Repeated-load or moving parts, wheel supports, structural brackets, and uses involving meaningful heat, water, chemicals, or ultraviolet exposure require a later specialist process. A good fit does not make them publishable.</p>

      <h2>Blocked</h2>
      <p>RepairPrint does not publish parts involving mains electricity, insulation, batteries, charging, motors, impellers, gas, fuel, flame, pressure, hazardous chemicals, brakes, steering, lifting, restraint, guards, protective equipment, medical or mobility devices, alarms, fire safety, child safety, structural or overhead loads, food contact, or infant use.</p>

      <h2>If a safety concern is reported</h2>
      <p>A credible high-severity concern places the affected fitment on immediate hold, removes it from recommendations and indexing, preserves evidence privately, and triggers review of related model, design, component, and source edges. See <Link href="/notice">urgent safety and notice reporting</Link>.</p>
      <p>This operating draft is not a regulatory approval, product certification, or legal opinion. Qualified safety and legal review remain launch gates.</p>
    </div>
  );
}
