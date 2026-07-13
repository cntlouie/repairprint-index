import "server-only";

import { areSafeSourceMetadataFields, isSafeSourceMetadataPayload, selectAllowedSourceFields } from "@/domain/source-policy";
import { sourceContentChecksum } from "@/domain/source-ingestion";

export interface SourceAdapterRecord {
  readonly externalId: string;
  readonly contentChecksum: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly retrievedAt: Date;
}

export interface SourceAdapter {
  readonly platform: string;
  readonly version: string;
  readonly requestedFields: readonly string[];
  fetchCandidate(externalId: string): Promise<SourceAdapterRecord>;
}

export class FixtureThingiverseAdapter implements SourceAdapter {
  readonly platform = "thingiverse";
  readonly version = "thingiverse-fixture-v1";
  readonly requestedFields = Object.freeze(["external_id", "landing_page_url", "title", "creator", "license", "source_revision"]);

  constructor(
    private readonly fixtures: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    allowedFields: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!areSafeSourceMetadataFields(allowedFields)) throw new SourceAdapterError("SOURCE_POLICY_FIELD_FORBIDDEN");
    this.allowedFields = Object.freeze([...allowedFields]);
  }

  private readonly allowedFields: readonly string[];

  async fetchCandidate(externalId: string): Promise<SourceAdapterRecord> {
    const fixture = this.fixtures[externalId];
    if (!fixture) throw new SourceAdapterError("SOURCE_FIXTURE_NOT_FOUND");
    const payload = selectAllowedSourceFields(fixture, this.allowedFields);
    if (!isSafeSourceMetadataPayload(payload)) throw new SourceAdapterError("SOURCE_POLICY_FIELD_FORBIDDEN");
    return {
      externalId,
      contentChecksum: sourceContentChecksum(payload),
      payload,
      retrievedAt: this.now(),
    };
  }
}

export class SourceAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SourceAdapterError";
  }
}

export function loadSourceAdapterMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "disabled" | "fixture" {
  const mode = environment.SOURCE_ADAPTER_MODE ?? "disabled";
  if (mode === "disabled") return mode;
  if (mode === "fixture" && (environment.DEMO_MODE === "true" || environment.NODE_ENV === "test")) return mode;
  throw new SourceAdapterError("SOURCE_ADAPTER_CONFIGURATION_BLOCKED");
}
