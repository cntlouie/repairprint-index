import { normalizeIdentifier, normalizeSearchQuery } from "@/domain/normalization";
import type { Route } from "next";
import { demoModels, demoParts } from "./demo-data";
import type { CatalogModel, CatalogPart, SearchResult } from "./catalog-types";

export function listModels(): CatalogModel[] {
  return demoModels;
}

export function listRecentParts(): CatalogPart[] {
  return [...demoParts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getModel(brandSlug: string, modelSlug: string): CatalogModel | undefined {
  return demoModels.find((model) => model.brandSlug === brandSlug && model.modelSlug === modelSlug);
}

export function getPartsForModel(modelId: string): CatalogPart[] {
  return demoParts.filter((part) => part.modelIds.includes(modelId));
}

export function getPart(slug: string): CatalogPart | undefined {
  return demoParts.find((part) => part.slug === slug);
}

export function getModelsForPart(part: CatalogPart): CatalogModel[] {
  return demoModels.filter((model) => part.modelIds.includes(model.id));
}

export function searchCatalog(rawQuery: string): SearchResult[] {
  const query = normalizeSearchQuery(rawQuery);
  if (query.length < 2) return [];

  const identifierQuery = normalizeIdentifier(query);
  const textQuery = query.toLocaleLowerCase("en");
  const results: SearchResult[] = [];

  for (const model of demoModels) {
    const exactIdentifier = model.identifiers.some(
      (identifier) => normalizeIdentifier(identifier) === identifierQuery,
    );
    const nameMatch = `${model.brandName} ${model.modelName}`
      .toLocaleLowerCase("en")
      .includes(textQuery);

    if (exactIdentifier || nameMatch) {
      results.push({
        type: "model",
        title: `${model.brandName} ${model.modelName}`,
        subtitle: `${model.categoryName} · ${model.region}`,
        href: `/brands/${model.brandSlug}/${model.modelSlug}` as Route,
        matchReason: exactIdentifier ? "Exact model identifier" : "Model name",
        rank: exactIdentifier ? 100 : 75,
      });
    }
  }

  for (const part of demoParts) {
    const exactOem = part.oemPartNumbers.some(
      (number) => normalizeIdentifier(number) === identifierQuery,
    );
    const textMatch = `${part.name} ${part.componentName}`
      .toLocaleLowerCase("en")
      .includes(textQuery);

    if (exactOem || textMatch) {
      results.push({
        type: "part",
        title: part.name,
        subtitle: part.oemPartNumbers.length > 0 ? `OEM ${part.oemPartNumbers.join(", ")}` : part.componentName,
        href: `/parts/${part.slug}` as Route,
        matchReason: exactOem ? "Exact OEM part number" : "Component name",
        rank: exactOem ? 98 : 65,
      });
    }
  }

  return results.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
}
