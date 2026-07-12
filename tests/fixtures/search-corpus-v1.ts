import type { SearchDocument } from "@/domain/search";

const model = (overrides: Partial<SearchDocument> & Pick<SearchDocument, "entityId" | "brandId" | "brandName" | "brandSlug" | "modelName" | "modelSlug" | "strictKeys" | "looseKeys">): SearchDocument => ({
  entityType: "model",
  componentName: null,
  componentSlug: null,
  componentTerms: [],
  title: `${overrides.brandName} ${overrides.modelName}`,
  subtitle: "Fictional appliance",
  href: `/brands/${overrides.brandSlug}/${overrides.modelSlug}`,
  searchText: `${overrides.brandName} ${overrides.modelName} ${(overrides.strictKeys ?? []).join(" ")}`,
  ...overrides,
});

const part = (overrides: Partial<SearchDocument> & Pick<SearchDocument, "entityId" | "brandId" | "brandName" | "brandSlug" | "modelName" | "modelSlug" | "componentName" | "componentSlug" | "strictKeys" | "looseKeys" | "componentTerms">): SearchDocument => ({
  entityType: "part",
  title: overrides.componentName!,
  subtitle: `${overrides.brandName} ${overrides.modelName}`,
  href: `/parts/${overrides.modelSlug}-${overrides.componentSlug}`,
  searchText: `${overrides.brandName} ${overrides.modelName} ${overrides.componentName} ${overrides.componentTerms.join(" ")} ${overrides.strictKeys.join(" ")}`,
  ...overrides,
});

export const searchCorpusDocuments: SearchDocument[] = [
  model({ entityId: "model-dv-100-dash", brandId: "brand-demo", brandName: "DemoVac", brandSlug: "demovac", modelName: "DV-100 Region A", modelSlug: "dv-100-region-a", strictKeys: ["DV-100"], looseKeys: ["DV100"] }),
  model({ entityId: "model-dv-100-slash", brandId: "brand-demo", brandName: "DemoVac", brandSlug: "demovac", modelName: "DV/100 Region B", modelSlug: "dv-100-region-b", strictKeys: ["DV/100"], looseKeys: ["DV100"] }),
  model({ entityId: "model-cw-020", brandId: "brand-clean", brandName: "CleanWave", brandSlug: "cleanwave", modelName: "CW-020", modelSlug: "cw-020", strictKeys: ["CW-020"], looseKeys: ["CW020"] }),
  part({ entityId: "part-latch", brandId: "brand-demo", brandName: "DemoVac", brandSlug: "demovac", modelName: "DV-100 Region A", modelSlug: "dv-100-region-a", componentName: "Dust-bin latch", componentSlug: "dust-bin-latch", strictKeys: ["006-11475"], looseKeys: ["00611475"], componentTerms: ["dust-bin latch", "bin clip", "dust cup catch"] }),
  part({ entityId: "part-wheel", brandId: "brand-clean", brandName: "CleanWave", brandSlug: "cleanwave", modelName: "CW-020", modelSlug: "cw-020", componentName: "Upper rack wheel", componentSlug: "upper-rack-wheel", strictKeys: ["RACK-042"], looseKeys: ["RACK042"], componentTerms: ["upper rack wheel", "basket roller", "rack wheel"] }),
];

const variants = (expectedEntityId: string, queries: readonly string[]) => queries.map((query) => ({ query, expectedEntityId }));

export const searchCorpusV1 = [
  ...variants("model-dv-100-dash", [
    "DemoVac DV-100", "demovac dv-100", "DEMOVAC DV-100", " DemoVac DV-100 ", "DemoVac   DV-100",
    "DemoVac DV‐100", "DemoVac DV‑100", "DemoVac DV‒100", "DemoVac DV–100", "DemoVac DV—100",
    "demovac   DV-100", "DEMOVAC   dv-100", "DemoVac\tDV-100", "DemoVac\nDV-100", "demovac DV‐100",
    "DEMOVAC DV‑100", " DemoVac   DV‒100 ", "demovac DV–100", "DEMOVAC DV—100", "DemoVac DV-100   ",
  ]),
  ...variants("model-dv-100-slash", [
    "DemoVac DV/100", "demovac dv/100", "DEMOVAC DV/100", " DemoVac DV/100 ", "DemoVac   DV/100",
    "demovac   DV/100", "DEMOVAC   dv/100", "DemoVac\tDV/100", "DemoVac\nDV/100", "DemoVac DV/100   ",
    " DemoVac   DV/100", "demovac DV/100 ", "DEMOVAC DV/100 ", "DemoVac\t\tDV/100", "DemoVac  DV/100",
    "demovac\nDV/100", "DEMOVAC\tDV/100", " DemoVac\nDV/100 ", "DemoVac   dv/100", "demovac DV/100",
  ]),
  ...variants("model-cw-020", [
    "CleanWave CW-020", "cleanwave cw-020", "CLEANWAVE CW-020", " CleanWave CW-020 ", "CleanWave   CW-020",
    "CleanWave CW‐020", "CleanWave CW‑020", "CleanWave CW‒020", "CleanWave CW–020", "CleanWave CW—020",
    "cleanwave   CW-020", "CLEANWAVE   cw-020", "CleanWave\tCW-020", "CleanWave\nCW-020", "cleanwave CW‐020",
    "CLEANWAVE CW‑020", " CleanWave   CW‒020 ", "cleanwave CW–020", "CLEANWAVE CW—020", "CleanWave CW-020   ",
  ]),
  ...variants("part-latch", [
    "006-11475", "00611475", "006 11475", "006/11475", " 006-11475 ",
    "DemoVac 006-11475", "demovac 00611475", "DEMOVAC 006 11475", "DemoVac 006/11475", "DemoVac   006-11475",
    "006‐11475", "006‑11475", "006‒11475", "006–11475", "006—11475",
    "DemoVac 006‐11475", "DemoVac 006‑11475", "DemoVac 006‒11475", "DemoVac 006–11475", "DemoVac 006—11475",
  ]),
  ...variants("part-wheel", [
    "RACK-042", "RACK042", "RACK 042", "RACK/042", " rack-042 ",
    "CleanWave RACK-042", "cleanwave rack042", "CLEANWAVE RACK 042", "CleanWave RACK/042", "CleanWave   RACK-042",
    "RACK‐042", "RACK‑042", "RACK‒042", "RACK–042", "RACK—042",
    "CleanWave RACK‐042", "CleanWave RACK‑042", "CleanWave RACK‒042", "CleanWave RACK–042", "CleanWave RACK—042",
  ]),
] as const;

export const ambiguousSearchCorpusV1 = [
  "DV100", "DV 100", "DV.100", "DV_100", "DemoVac DV100",
  "demovac dv 100", "DEMOVAC DV:100", " DemoVac DV100 ", "DemoVac   DV 100", "demovac DV#100",
] as const;
