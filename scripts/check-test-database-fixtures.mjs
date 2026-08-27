import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const violations = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".test.ts")) continue;

    const source = readFileSync(entryPath, "utf8");
    const lines = source.split(/\r?\n/);
    if (/\b(?:openTestDatabase|openRawTestDatabase)\b/.test(source)) {
      const closeIndex = source.search(/\bcloseTestDatabases\s*\(/);
      const removeIndex = source.search(/\b(?:fs\.)?rmSync\s*\(/);
      if (closeIndex < 0) {
        violations.push(`${path.relative(projectRoot, entryPath)}: add closeTestDatabases() before removing temporary files`);
      } else if (removeIndex >= 0 && closeIndex > removeIndex) {
        violations.push(`${path.relative(projectRoot, entryPath)}: closeTestDatabases() must precede rmSync()`);
      }
    }
    const sourceFile = ts.createSourceFile(entryPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function inspect(node) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Database") {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        violations.push(`${path.relative(projectRoot, entryPath)}:${line}: use openRawTestDatabase() instead of new Database()`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(sourceFile);
    lines.forEach((line, index) => {
      if (/\binitDatabase\b/.test(line)) {
        violations.push(`${path.relative(projectRoot, entryPath)}:${index + 1}`);
      }
    });
  }
}

visit(sourceRoot);

if (violations.length > 0) {
  console.error("Test database fixture check failed. Use the tracked database helpers from test-utils/database.ts:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Test database fixture check passed: test files do not open databases directly.");
