import fs from 'node:fs/promises';
import path from 'node:path';

const file = path.resolve('src/human-experience/standalone-explorer.mjs');
let text = (await fs.readFile(file, 'utf8')).replace(/\r\n?/g, '\n');

function replaceOnce(needle, replacement, label) {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: expected exactly one match`);
  }
  text = text.slice(0, first) + replacement + text.slice(first + needle.length);
}

replaceOnce(
  "import crypto from 'node:crypto';\n",
  "import crypto from 'node:crypto';\nimport fs from 'node:fs/promises';\n",
  'fs import'
);

replaceOnce(
  "export async function buildStandaloneHumanExplorerShell() {\n  let viteBuild;",
  "export async function buildStandaloneHumanExplorerShell() {\n  const prebuilt = await readAdjacentPrebuiltHumanExplorerShell();\n  if (prebuilt) return prebuilt;\n\n  let viteBuild;",
  'prebuilt shell fast path'
);

replaceOnce(
  "\nfunction normalizeBuildOutputs(result) {",
  `\nasync function readAdjacentPrebuiltHumanExplorerShell() {\n  const url = new URL('./prebuilt-human-explorer-shell.json', import.meta.url);\n  let raw;\n  try {\n    raw = await fs.readFile(url, 'utf8');\n  } catch (error) {\n    if (error?.code === 'ENOENT') return null;\n    throw new TypeError(\n      'prebuilt Human Explorer shell could not be read: ' +\n      String(error?.message ?? error)\n    );\n  }\n  let shell;\n  try {\n    shell = JSON.parse(raw);\n  } catch (error) {\n    throw new TypeError(\n      'prebuilt Human Explorer shell is not valid JSON: ' +\n      String(error?.message ?? error)\n    );\n  }\n  if (\n    !shell ||\n    shell.schema !== HUMAN_EXPLORER_STANDALONE_SHELL_SCHEMA ||\n    shell.renderer !== 'HUMAN_EXPLORER_V2' ||\n    typeof shell.html !== 'string' ||\n    shell.digest !== digestBytes(shell.html)\n  ) {\n    throw new TypeError('prebuilt Human Explorer shell failed identity validation');\n  }\n  return deepFreeze(shell);\n}\n\nfunction normalizeBuildOutputs(result) {`,
  'prebuilt shell loader helper'
);

await fs.writeFile(file, text, 'utf8');