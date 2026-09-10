import fs from 'node:fs/promises';
import childProcess from 'node:child_process';

const FILE = 'mcp/src/production-backend.mjs';
let text = (await fs.readFile(FILE, 'utf8')).replace(/\r\n?/g, '\n');

function replaceOnce(before, after, label) {
  const first = text.indexOf(before);
  const last = text.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  text = text.slice(0, first) + after + text.slice(first + before.length);
}

replaceOnce(
  'targetSnapshotId: session.snapshot.snapshot_id,',
  'targetSnapshotId: session.materialized.snapshotIdentity.snapshot_id,',
  'exact snapshot access'
);

replaceOnce(
  "      ledger,\n      sourceReadBytesByTask: new Map(),",
  "      ledger,\n      sourceReadBytesByTask: new Map(),\n      engineResults: new Map(),",
  'engine result cache state'
);

replaceOnce(
  "    runners[engineId] = envelope => runProductionEngine(session, engineId, envelope);",
  "    runners[engineId] = async envelope => {\n      const cached = session.engineResults.get(engineId);\n      if (cached) return cached;\n      const result = await runProductionEngine(session, engineId, envelope);\n      session.engineResults.set(engineId, result);\n      return result;\n    };",
  'completed engine replay cache'
);

replaceOnce(
  "  const attempt = createEngineAttemptContext(\n    session.plan.runId,\n    engineId,\n    ENGINE_ORDINAL[engineId]\n  );",
  "  const attemptOrdinal = session.plan.requestedEngines.length === 1\n    ? 1\n    : ENGINE_ORDINAL[engineId];\n  const attempt = createEngineAttemptContext(\n    session.plan.runId,\n    engineId,\n    attemptOrdinal\n  );",
  'direct versus all-mode attempt ordinal'
);

await fs.writeFile(FILE, text, 'utf8');
childProcess.execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
await fs.rm('scripts/apply-host-bridge-step3-hotfix.mjs');
await fs.rm('.github/workflows/host-bridge-step3-hotfix.yml');