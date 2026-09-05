import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const originalSpawnSync = childProcess.spawnSync;

childProcess.spawnSync = function spawnSyncWithDomSpill(
  file,
  args = [],
  options = {}
) {
  const isChromeDomDump =
    Array.isArray(args) && args.includes('--dump-dom');
  if (!isChromeDomDump) {
    return originalSpawnSync(file, args, options);
  }

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kneekura-r1-chrome-stdout-')
  );
  const outputPath = path.join(root, 'dom.txt');
  let outputFd = null;
  try {
    outputFd = fs.openSync(outputPath, 'w');
    const result = originalSpawnSync(file, args, {
      ...options,
      stdio: ['ignore', outputFd, 'pipe']
    });
    fs.closeSync(outputFd);
    outputFd = null;

    const encoding =
      typeof options.encoding === 'string'
        ? options.encoding
        : null;
    const stdout = encoding
      ? fs.readFileSync(outputPath, encoding)
      : fs.readFileSync(outputPath);
    return {
      ...result,
      stdout
    };
  } finally {
    if (outputFd !== null) {
      try {
        fs.closeSync(outputFd);
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
};

syncBuiltinESMExports();
await import('./validate-love-github-human-guide-production-r1.mjs');