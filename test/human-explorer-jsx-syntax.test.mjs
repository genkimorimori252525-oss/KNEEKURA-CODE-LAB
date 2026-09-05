import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('@typescript/typescript6');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const relativePath of [
  'packages/human-explorer/src/App.jsx',
  'packages/human-explorer/src/HumanGuidePanel.jsx',
  'packages/human-explorer/src/main.jsx'
]) {
  test(`Human Explorer JSX parses: ${relativePath}`, () => {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const parsed = ts.createSourceFile(
      relativePath.replace(/\.jsx$/, '.tsx'),
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const diagnostics = parsed.parseDiagnostics.map(diagnostic => {
      const position = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `${relativePath}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    assert.deepEqual(diagnostics, []);
  });
}
