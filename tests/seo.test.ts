import { describe, expect, it } from "vitest";

import {
  buildCanonicalUrl,
  classifySeoPath,
  evaluateSeoPage,
  evaluateSeoRequestBoundary,
  evaluateSeoRuntime,
  INDEXABLE_TRUST_PATHS,
  parseSiteOrigin,
  type CatalogueSeoFacts,
  type SeoRuntimeDecision,
} from "@/domain/seo";
import { currentSeoPage, currentSeoRuntime, seoMetadata } from "@/lib/seo";

const enabledRuntime: SeoRuntimeDecision = {
  indexingAllowed: true,
  origin: "https://repairprint.example",
  reason: "indexing_enabled",
};

const eligibleFacts: CatalogueSeoFacts = {
  entityType: "part",
  recordState: "published",
  publishedExactModel: true,
  lowRiskSafetyApproved: true,
  qualifyingLiveDesigns: 1,
  visible: {
    creator: true,
    source: true,
    licence: true,
    evidence: true,
    lastCheckedAt: true,
    provenance: true,
  },
  uniqueRepairInformation: true,
};

describe("strict SEO origin policy", () => {
  it.each([
    ["https://repairprint.example", "https://repairprint.example"],
    ["https://repairprint.example/", "https://repairprint.example"],
    ["https://repairprint.example:8443", "https://repairprint.example:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3197/", "http://127.0.0.1:3197"],
    ["http://[::1]:3197", "http://[::1]:3197"],
  ])("accepts the exact origin %s", (value, origin) => {
    expect(parseSiteOrigin(value)).toEqual({ valid: true, origin });
  });

  it.each([
    undefined,
    "",
    " https://repairprint.example",
    "https://repairprint.example ",
    "HTTPS://repairprint.example",
    "http://repairprint.example",
    "ftp://repairprint.example",
    "//repairprint.example",
    "https:repairprint.example",
    "https://user:secret@repairprint.example",
    "https://repairprint.example/path",
    "https://repairprint.example//",
    "https://repairprint.example?preview=1",
    "https://repairprint.example#fragment",
    "https://repairprint.example\\@evil.invalid",
    "https://repairprint.example/%2e%2e/admin",
    "https://repairprint.example.\u000a",
    "https://répairprint.example",
  ])("rejects a missing or hostile configured origin: %s", (value) => {
    expect(parseSiteOrigin(value).valid).toBe(false);
  });

  it("reports credential-bearing origins distinctly", () => {
    expect(parseSiteOrigin("https://admin:secret@repairprint.example"))
      .toEqual({ valid: false, reason: "credentials" });
  });
});

describe("deployment and demo lock", () => {
  it.each([
    [undefined, "production"],
    ["production", "production"],
  ])("allows explicit production only after DEMO_MODE is false (%s / %s)", (deploymentEnvironment, deploymentTarget) => {
    expect(evaluateSeoRuntime({
      demoMode: "false",
      siteUrl: "https://repairprint.example",
      nodeEnvironment: "production",
      noticeChannelConfigured: true,
      deploymentEnvironment,
      deploymentTarget,
    })).toEqual({
      indexingAllowed: true,
      origin: "https://repairprint.example",
      reason: "indexing_enabled",
    });
  });

  it.each([undefined, "true", "FALSE", "0", " false", "false "])(
    "fails closed unless DEMO_MODE is exact false: %s",
    (demoMode) => {
      expect(evaluateSeoRuntime({ demoMode, siteUrl: "https://repairprint.example" }))
        .toMatchObject({ indexingAllowed: false, reason: "demo_locked" });
    },
  );

  it.each([
    ["preview", undefined],
    ["development", undefined],
    ["staging", undefined],
    ["PRODUCTION", undefined],
    ["production", "staging"],
    ["production", "preview"],
    ["production", ""],
    ["production", undefined],
    [undefined, undefined],
  ])("blocks non-production deployment markers (%s / %s)", (deploymentEnvironment, deploymentTarget) => {
    expect(evaluateSeoRuntime({
      demoMode: "false",
      siteUrl: "https://repairprint.example",
      nodeEnvironment: "production",
      noticeChannelConfigured: true,
      deploymentEnvironment,
      deploymentTarget,
    })).toMatchObject({ indexingAllowed: false, reason: "deployment_locked" });
  });

  it("fails closed when the production origin is absent or malformed", () => {
    expect(evaluateSeoRuntime({ demoMode: "false", siteUrl: undefined, nodeEnvironment: "production", noticeChannelConfigured: true, deploymentTarget: "production" }))
      .toEqual({ indexingAllowed: false, origin: null, reason: "invalid_origin" });
    expect(evaluateSeoRuntime({ demoMode: "false", siteUrl: "https://evil.invalid/path", nodeEnvironment: "production", noticeChannelConfigured: true, deploymentTarget: "production" }))
      .toEqual({ indexingAllowed: false, origin: null, reason: "invalid_origin" });
  });

  it("blocks launch when a notice channel has not been explicitly validated", () => {
    expect(evaluateSeoRuntime({
      demoMode: "false",
      siteUrl: "https://repairprint.example",
      nodeEnvironment: "production",
      deploymentTarget: "production",
    })).toMatchObject({ indexingAllowed: false, reason: "launch_prerequisite_locked" });
  });
});

describe("canonical route grammar", () => {
  it.each([
    ["/", "home"],
    ["/methodology", "trust"],
    ["/notice", "trust"],
    ["/brands/renderworks/rx-100", "model"],
    ["/parts/render-rx100-latch-r1", "part"],
    ["/search", "search"],
    ["/request-part", "form"],
    ["/contribution-privacy", "contribution_privacy"],
    ["/designs/thin-record", "thin_design"],
    ["/admin/cases", "admin"],
    ["/api/v1/search", "api"],
    ["/preview/case", "preview"],
    ["/something-else", "unknown"],
  ])("classifies %s as %s", (path, kind) => {
    expect(classifySeoPath(path)).toBe(kind);
  });

  it.each([
    "",
    "parts/latch",
    "//evil.invalid/path",
    "/parts/UPPERCASE",
    "/parts/two--hyphens",
    "/parts/trailing/",
    "/brands/brand/",
    "/brands/brand/model/extra",
    "/parts/../admin",
    "/parts/%2e%2e/admin",
    "/parts/latch?filter=1",
    "/parts/latch#fragment",
    "/parts/latch\\admin",
    "/parts/non-ascii-é",
    "/parts/control\u0000",
  ])("rejects a hostile or non-canonical path: %s", (path) => {
    expect(classifySeoPath(path)).toBe("invalid");
    expect(buildCanonicalUrl("https://repairprint.example", path)).toBeNull();
  });

  it("builds only absolute, queryless canonical URLs", () => {
    expect(buildCanonicalUrl("https://repairprint.example", "/"))
      .toBe("https://repairprint.example/");
    expect(buildCanonicalUrl("https://repairprint.example/", "/parts/exact-latch"))
      .toBe("https://repairprint.example/parts/exact-latch");
    expect(buildCanonicalUrl("https://repairprint.example/path", "/parts/exact-latch"))
      .toBeNull();
    expect(buildCanonicalUrl("https://repairprint.example", "/search")).toBeNull();
  });
});

describe("shared request-level crawler boundary", () => {
  it("keeps parameterized catalogue requests noindex-follow before content facts load", () => {
    expect(evaluateSeoRequestBoundary(enabledRuntime, "/parts/renderworks-rx-100-latch", true))
      .toEqual({ follow: true, reason: "parameterized", routeKind: "part" });
  });

  it("blocks private routes and defers clean catalogue routes to their content facts", () => {
    expect(evaluateSeoRequestBoundary(enabledRuntime, "/api/v1/search", false))
      .toEqual({ follow: false, reason: "private_route", routeKind: "api" });
    expect(evaluateSeoRequestBoundary(enabledRuntime, "/api/admin/submissions/id/media", true))
      .toEqual({ follow: false, reason: "private_route", routeKind: "api" });
    expect(evaluateSeoRequestBoundary(enabledRuntime, "/parts/renderworks-rx-100-latch", false)).toBeNull();
  });
});

describe("one metadata and sitemap eligibility policy", () => {
  it("indexes the homepage and every approved trust page with a self-canonical URL", () => {
    for (const path of ["/", ...INDEXABLE_TRUST_PATHS]) {
      expect(evaluateSeoPage({ runtime: enabledRuntime, path })).toEqual({
        canonicalUrl: path === "/"
          ? "https://repairprint.example/"
          : `https://repairprint.example${path}`,
        follow: true,
        index: true,
        reason: "indexable",
        routeKind: path === "/" ? "home" : "trust",
        sitemapEligible: true,
      });
    }
  });

  it("indexes an eligible exact-model or canonical-part page", () => {
    const model = evaluateSeoPage({
      runtime: enabledRuntime,
      path: "/brands/renderworks/rx-100",
      catalogue: { ...eligibleFacts, entityType: "model" },
    });
    const part = evaluateSeoPage({
      runtime: enabledRuntime,
      path: "/parts/renderworks-rx-100-latch",
      catalogue: eligibleFacts,
    });
    expect(model).toMatchObject({ index: true, sitemapEligible: true, reason: "indexable" });
    expect(part).toMatchObject({ index: true, sitemapEligible: true, reason: "indexable" });
  });

  it.each([
    ["/search", "excluded_route", true],
    ["/request-part", "excluded_route", true],
    ["/contribution-privacy", "excluded_route", true],
    ["/designs/thin-record", "excluded_route", true],
    ["/admin", "private_route", false],
    ["/api/v1/search", "private_route", false],
    ["/preview/candidate", "private_route", false],
    ["/unknown", "private_route", false],
  ])("keeps %s out of indexes and the sitemap", (path, reason, follow) => {
    expect(evaluateSeoPage({ runtime: enabledRuntime, path })).toMatchObject({
      canonicalUrl: null,
      follow,
      index: false,
      reason,
      sitemapEligible: false,
    });
  });

  it("never indexes a parameterized version of an otherwise eligible page", () => {
    expect(evaluateSeoPage({
      runtime: enabledRuntime,
      path: "/parts/renderworks-rx-100-latch",
      hasQueryParameters: true,
      catalogue: eligibleFacts,
    })).toMatchObject({
      canonicalUrl: null,
      follow: true,
      index: false,
      reason: "parameterized",
      sitemapEligible: false,
    });
  });

  it("lets the runtime crawler lock override every otherwise indexable page", () => {
    for (const reason of ["demo_locked", "deployment_locked", "invalid_origin"] as const) {
      const decision = evaluateSeoPage({
        runtime: { indexingAllowed: false, origin: null, reason },
        path: "/parts/renderworks-rx-100-latch",
        catalogue: eligibleFacts,
      });
      expect(decision).toMatchObject({ canonicalUrl: null, follow: false, index: false, reason });
    }
  });

  it.each([
    [undefined, "missing_catalogue_facts"],
    [{ ...eligibleFacts, entityType: "model" }, "entity_kind_mismatch"],
    [{ ...eligibleFacts, publishedExactModel: false }, "unpublished_record"],
    [{ ...eligibleFacts, recordState: "candidate" }, "candidate_record"],
    [{ ...eligibleFacts, recordState: "disputed" }, "disputed_record"],
    [{ ...eligibleFacts, recordState: "rejected" }, "rejected_record"],
    [{ ...eligibleFacts, recordState: "unavailable" }, "unavailable_record"],
    [{ ...eligibleFacts, recordState: "archived" }, "archived_record"],
    [{ ...eligibleFacts, lowRiskSafetyApproved: false }, "safety_ineligible"],
    [{ ...eligibleFacts, qualifyingLiveDesigns: 0 }, "empty_catalogue_page"],
    [{ ...eligibleFacts, qualifyingLiveDesigns: 1.5 }, "empty_catalogue_page"],
    [{ ...eligibleFacts, visible: { ...eligibleFacts.visible, evidence: false } }, "missing_visible_facts"],
    [{ ...eligibleFacts, uniqueRepairInformation: false }, "thin_content"],
  ] as const)("excludes an ineligible catalogue fact set: %s", (catalogue, reason) => {
    expect(evaluateSeoPage({
      runtime: enabledRuntime,
      path: "/parts/renderworks-rx-100-latch",
      catalogue,
    })).toMatchObject({
      canonicalUrl: null,
      follow: true,
      index: false,
      reason,
      sitemapEligible: false,
    });
  });
});

describe("Next metadata adapter", () => {
  const productionEnvironment = {
    DEMO_MODE: "false",
    NEXT_PUBLIC_SITE_URL: "https://repairprint.example",
    NOTICE_CONTACT_URL: "https://notices.example/report",
    REPAIRPRINT_DEPLOYMENT_ENV: "production",
    VERCEL_ENV: "production",
    NODE_ENV: "production",
  };

  it("reads provider deployment state without adding an indexing fallback", () => {
    expect(currentSeoRuntime(productionEnvironment)).toMatchObject({ indexingAllowed: true });
    expect(currentSeoRuntime({ ...productionEnvironment, REPAIRPRINT_DEPLOYMENT_ENV: "staging" }))
      .toMatchObject({ indexingAllowed: false, reason: "deployment_locked" });
    expect(currentSeoRuntime({ ...productionEnvironment, NOTICE_CONTACT_URL: "" }))
      .toMatchObject({ indexingAllowed: false, reason: "launch_prerequisite_locked" });
    expect(currentSeoRuntime({ ...productionEnvironment, NODE_ENV: undefined }))
      .toMatchObject({ indexingAllowed: false, reason: "deployment_locked" });
    expect(currentSeoRuntime({
      ...productionEnvironment,
      REPAIRPRINT_DEPLOYMENT_ENV: undefined,
      VERCEL_TARGET_ENV: "production",
      DEPLOYMENT_ENV: "production",
    })).toMatchObject({ indexingAllowed: false, reason: "deployment_locked" });
  });

  it("emits an absolute canonical only for an indexable decision", () => {
    const page = currentSeoPage("/privacy", { environment: productionEnvironment });
    expect(seoMetadata(page)).toEqual({
      alternates: { canonical: "https://repairprint.example/privacy" },
      robots: { index: true, follow: true },
    });

    const search = currentSeoPage("/search", { environment: productionEnvironment });
    expect(seoMetadata(search)).toEqual({
      robots: { index: false, follow: true, nocache: true, noarchive: true },
    });
  });
});
