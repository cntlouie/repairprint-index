import { evaluateFitmentEvidence } from "../src/domain/fitment";
import { demoModels, demoParts } from "../src/lib/demo-data";

const failures: string[] = [];
const modelIds = new Set(demoModels.map((model) => model.id));
const slugs = new Set<string>();

for (const part of demoParts) {
  if (slugs.has(part.slug)) failures.push(`Duplicate part slug: ${part.slug}`);
  slugs.add(part.slug);

  const decision = evaluateFitmentEvidence(part.evidence);
  if (decision.status !== part.fitmentStatus) {
    failures.push(`${part.slug}: stored ${part.fitmentStatus}, evidence computes ${decision.status}`);
  }
  if (part.safetyClass !== "low") failures.push(`${part.slug}: demo public record is not low-risk`);
  if (!part.design.sourceUrl.startsWith("https://")) failures.push(`${part.slug}: source URL must use HTTPS`);
  if (!part.design.creator.trim()) failures.push(`${part.slug}: creator missing`);
  if (!part.design.licenseCode) failures.push(`${part.slug}: licence status missing`);
  for (const modelId of part.modelIds) {
    if (!modelIds.has(modelId)) failures.push(`${part.slug}: unknown model ${modelId}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Content checks passed for ${demoModels.length} demo models and ${demoParts.length} demo parts.`);
