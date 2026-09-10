import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'scripts', 'validate-kneekura-code-lab-host-bridge-three-engine.mjs');
const needle = "assert.equal(execution.status, 'SUCCESS');";
const source = await fs.readFile(target, 'utf8');
if (source.split(needle).length !== 2) {
  throw new Error('three-engine acceptance status assertion shape changed');
}
const diagnostic = [
  "process.stdout.write('HOST_BRIDGE_ENGINE_OUTCOMES ' + JSON.stringify(",
  "  execution.outcomes.map(row => ({",
  "    engine_id: row.engine_id,",
  "    status: row.status,",
  "    claim_level: row.claim_level,",
  "    claim_satisfied: row.claim_satisfied,",
  "    error_code: row.error?.code ?? null,",
  "    error_message: row.error?.message ?? null",
  "  }))",
  ") + '\\n');",
  ''
].join('\n');
await fs.writeFile(target, source.replace(needle, diagnostic + needle), 'utf8');
process.stdout.write('Host Bridge three-engine acceptance diagnostics instrumented.\n');