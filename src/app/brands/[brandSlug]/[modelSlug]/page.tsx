import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoNotice } from "@/components/DemoNotice";
import { PartCard } from "@/components/PartCard";
import { getModel, getPartsForModel } from "@/lib/catalog";

type Params = Promise<{ brandSlug: string; modelSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { brandSlug, modelSlug } = await params;
  const model = getModel(brandSlug, modelSlug);
  if (!model) return {};
  return {
    title: `${model.brandName} ${model.modelName} printable repair parts`,
    description: model.summary,
    robots: process.env.DEMO_MODE === "false" ? undefined : { index: false, follow: false },
  };
}

export default async function ModelPage({ params }: { params: Params }) {
  const { brandSlug, modelSlug } = await params;
  const model = getModel(brandSlug, modelSlug);
  if (!model) notFound();
  const parts = getPartsForModel(model.id);

  return (
    <div className="shell page-shell">
      <DemoNotice />
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <span>{model.categoryName}</span><span>/</span><span>{model.brandName}</span><span>/</span><strong>{model.modelName}</strong>
      </nav>
      <div className="model-header">
        <div><span className="eyebrow">Exact product model</span><h1>{model.brandName} {model.modelName}</h1><p className="lede narrow">{model.summary}</p></div>
        <dl className="fact-card">
          <div><dt>Model identifiers</dt><dd>{model.identifiers.join(" · ")}</dd></div>
          <div><dt>Region</dt><dd>{model.region}</dd></div>
          <div><dt>Indexed solutions</dt><dd>{parts.length}</dd></div>
        </dl>
      </div>
      <section className="section compact-section">
        <div className="section-heading"><div><span className="eyebrow">Printable solutions</span><h2>Parts indexed for this exact model</h2></div></div>
        <div className="card-grid">{parts.map((part) => <PartCard key={part.id} part={part} />)}</div>
      </section>
    </div>
  );
}
