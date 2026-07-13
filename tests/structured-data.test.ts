import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JsonLd } from "@/components/JsonLd";
import {
  assertSupportedStructuredData,
  buildBreadcrumbListStructuredData,
  buildCollectionPageStructuredData,
  buildCreativeWorkStructuredData,
  buildWebSiteStructuredData,
  serializeJsonLd,
  UnsupportedStructuredDataError,
  type SupportedStructuredData,
} from "@/domain/seo";

const origin = "https://repairprint.example";
const breadcrumbs = [
  { name: "RepairPrint Index", url: `${origin}/` },
  { name: "RenderWorks RX-100", url: `${origin}/brands/renderworks/rx-100` },
  { name: "Dust-bin latch", url: `${origin}/parts/renderworks-rx-100-dust-bin-latch` },
] as const;

describe("supported structured-data builders", () => {
  it("builds the real homepage search action against the canonical origin", () => {
    expect(buildWebSiteStructuredData({
      name: "RepairPrint Index",
      origin,
      description: "Evidence-backed exact-model printable repairs.",
    })).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "RepairPrint Index",
      url: `${origin}/`,
      description: "Evidence-backed exact-model printable repairs.",
      potentialAction: {
        "@type": "SearchAction",
        target: `${origin}/search?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    });
  });

  it("keeps visible breadcrumbs and JSON-LD names, order and URLs identical", () => {
    const data = buildBreadcrumbListStructuredData(breadcrumbs);
    const items = data.itemListElement as Array<Record<string, unknown>>;
    expect(items.map(({ position, name, item }) => ({ position, name, item }))).toEqual([
      { position: 1, name: breadcrumbs[0].name, item: breadcrumbs[0].url },
      { position: 2, name: breadcrumbs[1].name, item: breadcrumbs[1].url },
      { position: 3, name: breadcrumbs[2].name, item: breadcrumbs[2].url },
    ]);

    const markup = renderToStaticMarkup(React.createElement(Breadcrumbs, { items: breadcrumbs }));
    expect(markup).toContain(`<a href="${breadcrumbs[0].url}">${breadcrumbs[0].name}</a>`);
    expect(markup).toContain(`<a href="${breadcrumbs[1].url}">${breadcrumbs[1].name}</a>`);
    expect(markup).toContain(`<span aria-current="page">${breadcrumbs[2].name}</span>`);
    expect(extractJsonLd(markup)).toEqual(data);
  });

  it("builds a CollectionPage only from its canonical visible collection", () => {
    const collection = buildCollectionPageStructuredData({
      name: "RenderWorks RX-100 printable repair parts",
      url: `${origin}/brands/renderworks/rx-100`,
      description: "Published solutions for this exact model.",
      dateModified: "2026-07-12T06:00:00Z",
      items: [breadcrumbs[2]],
    });
    expect(collection).toMatchObject({
      "@type": "CollectionPage",
      name: "RenderWorks RX-100 printable repair parts",
      url: `${origin}/brands/renderworks/rx-100`,
      dateModified: "2026-07-12T06:00:00Z",
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 1,
      },
    });
  });

  it("supports a launch-sized exact-model collection without applying the breadcrumb depth limit", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      name: `Visible repair part ${index + 1}`,
      url: `${origin}/parts/visible-repair-part-${index + 1}`,
    }));
    const collection = buildCollectionPageStructuredData({
      name: "Launch-sized exact model",
      url: `${origin}/brands/renderworks/rx-100`,
      items,
    });
    expect((collection.mainEntity as Record<string, unknown>).numberOfItems).toBe(100);
    expect(() => buildCollectionPageStructuredData({
      name: "Unbounded exact model",
      url: `${origin}/brands/renderworks/rx-100`,
      items: Array.from({ length: 251 }, (_, index) => ({ name: `Part ${index}`, url: `${origin}/parts/part-${index}` })),
    })).toThrow(/one and 250/u);
  });

  it("does not label a work as a 3DModel unless that type was explicitly selected", () => {
    expect(() => buildCreativeWorkStructuredData({
      name: "Dust-bin latch revision r1",
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
      encodingFormat: ["STL"],
    })).toThrow(UnsupportedStructuredDataError);

    expect(buildCreativeWorkStructuredData({
      type: "3DModel",
      name: "Dust-bin latch revision r1",
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
      identifier: "fit_render_live_r1",
      creator: "Render Fixture Creator",
      licence: "CC-BY-4.0",
      datePublished: "2026-07-12",
      dateModified: "2026-07-12T06:00:00Z",
      about: "RenderWorks RX-100 dust-bin latch revision r1",
      encodingFormat: ["STL"],
    })).toMatchObject({
      "@type": "3DModel",
      creator: { "@type": "Person", name: "Render Fixture Creator" },
      encodingFormat: ["STL"],
    });
  });
});

describe("JSON-LD script safety", () => {
  it("escapes script-closing text, markup delimiters and JavaScript separators", () => {
    const hostileName = "Latch </script><script>globalThis.injected=true</script> & \u2028 \u2029 end";
    const data = buildCreativeWorkStructuredData({
      name: hostileName,
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
    });
    const serialized = serializeJsonLd(data);
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("&");
    expect(serialized).not.toContain("\u2028");
    expect(serialized).not.toContain("\u2029");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
    expect((JSON.parse(serialized) as { name: string }).name).toBe(hostileName);

    const markup = renderToStaticMarkup(React.createElement(JsonLd, { data, id: "part-json-ld" }));
    expect(markup.match(/<script/gu)).toHaveLength(1);
    expect(markup).not.toContain("globalThis.injected=true</script><script>");
    expect(extractJsonLd(markup)).toEqual(data);
  });

  it("escapes hostile stored text independently in visible crumbs and JSON-LD", () => {
    const hostileItems = [
      breadcrumbs[0],
      {
        name: "Latch </script><script>alert(1)</script>",
        url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
      },
    ];
    const markup = renderToStaticMarkup(React.createElement(Breadcrumbs, { items: hostileItems }));
    expect(markup).toContain("Latch &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
    expect(markup.match(/<script/gu)).toHaveLength(1);
  });

  it("rejects cyclic and custom-prototype values before serialization", () => {
    const cyclic = buildCreativeWorkStructuredData({
      name: "Latch",
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
    }) as Record<string, unknown>;
    cyclic.creator = cyclic;
    expect(() => serializeJsonLd(cyclic)).toThrow(/cycle/u);

    const custom = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: "Latch",
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
    });
    expect(() => serializeJsonLd(custom)).toThrow(/custom object prototype/u);
  });
});

describe("structured-data fact and property allowlist", () => {
  const creativeWork = buildCreativeWorkStructuredData({
    name: "Dust-bin latch revision r1",
    url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
    creator: "Render Fixture Creator",
    licence: "CC-BY-4.0",
  });

  it.each([
    "aggregateRating",
    "review",
    "offers",
    "availability",
    "manufacturer",
    "sponsor",
    "endorsement",
    "faq",
    "isBasedOn",
  ])("rejects unsupported or manufactured property %s", (property) => {
    expect(() => serializeJsonLd({ ...creativeWork, [property]: "fabricated" }))
      .toThrow(new RegExp(property, "u"));
  });

  it.each(["HowTo", "FAQPage", "Product", "Review", "AggregateRating"])(
    "rejects unsupported schema type %s",
    (type) => {
      expect(() => serializeJsonLd({
        "@context": "https://schema.org",
        "@type": type,
        name: "Unsupported",
        url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
      })).toThrow(/unsupported schema type/u);
    },
  );

  it("rejects unsupported nested search-action properties", () => {
    const website = buildWebSiteStructuredData({ name: "RepairPrint Index", origin });
    expect(() => serializeJsonLd({
      ...website,
      potentialAction: {
        ...(website.potentialAction as Record<string, unknown>),
        rawSearchText: "RX-100",
      },
    })).toThrow(/rawSearchText/u);
  });

  it.each([
    `${origin}/parts/latch?tracking=private`,
    `${origin}/parts/latch#fragment`,
    "https://evil.invalid/parts/latch",
    "https://user:secret@repairprint.example/parts/latch",
    `${origin}/parts/%2e%2e/admin`,
  ])("rejects a non-canonical breadcrumb URL: %s", (url) => {
    expect(() => buildBreadcrumbListStructuredData([
      breadcrumbs[0],
      { name: "Unsafe", url },
    ])).toThrow(UnsupportedStructuredDataError);
  });

  it("rejects ordinary JSON-LD that bypasses the supported builders", () => {
    const unsupported = {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: "Latch",
      url: `${origin}/parts/renderworks-rx-100-dust-bin-latch`,
      price: 9.99,
    };
    expect(() => assertSupportedStructuredData(unsupported)).toThrow(/price/u);
  });
});

function extractJsonLd(markup: string): SupportedStructuredData {
  const match = markup.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/u);
  if (!match?.[1]) throw new Error(`JSON-LD script was not found in ${markup}.`);
  return JSON.parse(match[1]) as SupportedStructuredData;
}
