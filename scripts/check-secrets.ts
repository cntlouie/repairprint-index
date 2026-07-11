import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type SecretPattern = { label: string; pattern: RegExp };

const secretPatterns: SecretPattern[] = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "Stripe live secret", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

const forbiddenEnvironmentFiles = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
]);

let files: string[];
try {
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  if (resolve(gitRoot).toLowerCase() !== resolve(process.cwd()).toLowerCase()) {
    throw new Error("current folder is not the Git root");
  }

  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  console.error("Secret checks require this folder to be an isolated Git repository.");
  process.exit(1);
}

if (files.length === 0) {
  console.error("Secret checks found no tracked or unignored source files to scan.");
  process.exit(1);
}

const findings: string[] = [];

for (const relativePath of files) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const fileName = basename(normalizedPath).toLowerCase();

  if (forbiddenEnvironmentFiles.has(fileName) || (fileName.startsWith(".env.") && fileName !== ".env.example")) {
    findings.push(`${normalizedPath}: environment file must not be committed`);
    continue;
  }

  let contents: string;
  try {
    contents = readFileSync(join(process.cwd(), relativePath), "utf8");
  } catch {
    continue;
  }

  if (contents.includes("\u0000")) continue;

  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(contents)) findings.push(`${normalizedPath}: possible ${label}`);
  }
}

if (findings.length > 0) {
  console.error("Secret checks failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret checks passed for ${files.length} tracked or unignored files.`);
