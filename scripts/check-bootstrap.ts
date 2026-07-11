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
requireText(".gitignore", ".env*", "all local environment files must be ignored");
requireText(".gitignore", "!.env.example", "the safe environment template must remain tracked");
requireText(
  "docs/ENVIRONMENT_INVENTORY.md",
  "GitHub marks it **Not enforced**",
  "unenforced branch protection must remain an explicit blocker",
);
requireText(
  "docs/ENVIRONMENT_INVENTORY.md",
  "branch preview URL still pending",
  "pending preview evidence must remain explicit",
);

if (failures.length > 0) {
  console.error("Bootstrap checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Bootstrap checks passed: CI, demo defaults, environment inventory, and ignore rules are locked.");
