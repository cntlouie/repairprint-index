import type { Metadata } from "next";

import {
  evaluateSeoPage,
  evaluateSeoRuntime,
  type CatalogueSeoFacts,
  type SeoPageDecision,
  type SeoRuntimeDecision,
} from "@/domain/seo";
import { resolveNoticeChannel } from "@/domain/notice-channel";

type Environment = Readonly<Record<string, string | undefined>>;

export function currentSeoRuntime(environment: Environment = process.env): SeoRuntimeDecision {
  return evaluateSeoRuntime({
    demoMode: environment.DEMO_MODE,
    siteUrl: environment.NEXT_PUBLIC_SITE_URL,
    nodeEnvironment: environment.NODE_ENV,
    noticeChannelConfigured: resolveNoticeChannel(environment.NOTICE_CONTACT_URL).configured,
    deploymentEnvironment: environment.VERCEL_ENV,
    deploymentTarget: environment.REPAIRPRINT_DEPLOYMENT_ENV,
  });
}

export function currentSeoPage(
  path: string,
  options: Readonly<{
    catalogue?: CatalogueSeoFacts;
    hasQueryParameters?: boolean;
    environment?: Environment;
  }> = {},
): SeoPageDecision {
  return evaluateSeoPage({
    runtime: currentSeoRuntime(options.environment),
    path,
    hasQueryParameters: options.hasQueryParameters,
    catalogue: options.catalogue,
  });
}

/** Convert the shared decision to the small Next Metadata fragment every page uses. */
export function seoMetadata(decision: SeoPageDecision): Pick<Metadata, "alternates" | "robots"> {
  return {
    ...(decision.canonicalUrl ? { alternates: { canonical: decision.canonicalUrl } } : {}),
    robots: decision.index
      ? { index: true, follow: true }
      : { index: false, follow: decision.follow, nocache: true, noarchive: true },
  };
}
