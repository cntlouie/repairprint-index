import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures: string[] = [];

function read(relativePath: string): string {
  try {
    return readFileSync(join(root, relativePath), "utf8");
  } catch {
    failures.push(`${relativePath} is missing or unreadable`);
    return "";
  }
}

function requireText(relativePath: string, text: string, label: string): void {
  const contents = read(relativePath);
  if (!contents.includes(text)) failures.push(`${relativePath}: ${label}`);
}

requireText(".env.example", "DEMO_MODE=true", "DEMO_MODE must default to true");
requireText(".github/workflows/ci.yml", "branches: [main]", "CI must run on main");
requireText(".github/workflows/ci.yml", "pull_request:", "CI must run on pull requests");
requireText(".github/workflows/ci.yml", "run: npm ci", "CI must use the lockfile");
requireText(".github/workflows/ci.yml", "run: npm run check", "CI must run the complete gate");
requireText(".github/workflows/ci.yml", 'DEMO_MODE: "true"', "CI must remain in demo mode");
requireText(".github/workflows/ci.yml", "postgres:17-alpine", "CI must run the PostgreSQL 17 service");
requireText(
  ".github/workflows/ci.yml",
  "DATABASE_TEST_URL: postgres://repairprint:repairprint@127.0.0.1:5432/repairprint_test",
  "CI must point the database gate at its isolated test service",
);
requireText(".gitignore", ".env*", "all local environment files must be ignored");
requireText(".gitignore", "!.env.example", "the safe environment template must remain tracked");
requireText(
  "docs/ENVIRONMENT_INVENTORY.md",
  "Enforced classic `main` rule currently applies to one branch",
  "enforced main branch protection evidence must remain explicit",
);
requireText(
  "docs/ENVIRONMENT_INVENTORY.md",
  "GitHub Actions `verify` check",
  "the named required CI check must remain explicit",
);
requireText(
  "docs/ENVIRONMENT_INVENTORY.md",
  "Vercel Authentication blocks unauthenticated crawlers",
  "preview crawler protection evidence must remain explicit",
);
requireText(
  "docs/DATA_DICTIONARY.md",
  "Migration integrity",
  "the database data dictionary must remain tracked",
);
requireText(
  "docs/DATABASE_RECOVERY.md",
  "Restore drill",
  "database recovery and restore notes must remain tracked",
);

if (failures.length > 0) {
  console.error("Bootstrap checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Bootstrap checks passed: CI, demo defaults, environment inventory, and ignore rules are locked.");
