import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const inheritedR4Wrapper =
  typeof globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ === 'number';

if (!inheritedR4Wrapper) {
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function spawnSyncWithDomSpill(file, args = [], options = {}) {
    if (!Array.isArray(args) || !args.includes('--dump-dom')) {
      return originalSpawnSync(file, args, options);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kneekura-r3-chrome-stdout-'));
    const outputPath = path.join(root, 'dom.txt');
    let fd = null;
    try {
      fd = fs.openSync(outputPath, 'w');
      const result = originalSpawnSync(file, args, {
        ...options,
        stdio: ['ignore', fd, 'pipe']
      });
      fs.closeSync(fd);
      fd = null;
      const stdout = typeof options.encoding === 'string'
        ? fs.readFileSync(outputPath, options.encoding)
        : fs.readFileSync(outputPath);
      return { ...result, stdout };
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  syncBuiltinESMExports();
}

await import('./validate-love-github-human-guide-production-r3.mjs');