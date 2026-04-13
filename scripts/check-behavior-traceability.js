import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const docsPath = path.join(repoRoot, 'docs', 'BEHAVIOR-TAGS.md');
const testRoot = path.join(repoRoot, 'test');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    if (entry.isFile() && full.endsWith('.test.js')) files.push(full);
  }
  return files;
}

function extractBehaviorIds(text) {
  const ids = new Set();
  const regex = /\bBEH-[A-Z0-9-]+\b/g;
  for (const match of text.matchAll(regex)) ids.add(match[0]);
  return ids;
}

if (!fs.existsSync(docsPath)) {
  console.error(`Traceability doc not found: ${docsPath}`);
  process.exit(1);
}
if (!fs.existsSync(testRoot)) {
  console.error(`Test directory not found: ${testRoot}`);
  process.exit(1);
}

const docText = fs.readFileSync(docsPath, 'utf8');
const requiredIds = [...extractBehaviorIds(docText)].sort();
if (requiredIds.length === 0) {
  console.error('No behavior IDs found in docs/BEHAVIOR-TAGS.md');
  process.exit(1);
}

const testFiles = walk(testRoot);
const testText = testFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const coveredIds = extractBehaviorIds(testText);

const missing = requiredIds.filter((id) => !coveredIds.has(id));
if (missing.length > 0) {
  console.error('Behavior traceability check failed.');
  console.error('Missing behavior IDs in test tags:');
  for (const id of missing) console.error(`- ${id}`);
  process.exit(1);
}

console.log(`Behavior traceability check passed (${requiredIds.length} IDs covered).`);
