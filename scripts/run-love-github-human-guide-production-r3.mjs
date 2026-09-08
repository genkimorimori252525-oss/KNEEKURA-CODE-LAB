import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from 'node:worker_threads';

const inheritedR4Wrapper =
  typeof globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ === 'number';

if (inheritedR4Wrapper && isMainThread) {
  const result = await runR3InIsolatedWorker();
  globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ += result.npmCiIntercepts;
} else {
  let npmCiIntercepts = 0;
  if (workerData?.r4Child === true) {
    const originalExecFile = childProcess.execFile;
    function transformArgs(file, args) {
      const npmExecPath = process.env.npm_execpath;
      if (
        file !== process.execPath ||
        typeof npmExecPath !== 'string' ||
        !Array.isArray(args) ||
        args[0] !== npmExecPath
      ) {
        return args;
      }
      let transformed = [...args];
      if (
        transformed[1] === 'install' &&
        transformed.includes('--package-lock=false')
      ) {
        npmCiIntercepts += 1;
        transformed = transformed
          .filter(arg => arg !== '--package-lock=false')
          .map((arg, index) => index === 1 ? 'ci' : arg);
      }
      if (transformed[1] === 'ci') {
        if (!transformed.includes('--include=dev')) transformed.push('--include=dev');
        if (!transformed.includes('--production=false')) transformed.push('--production=false');
      }
      return transformed;
    }
    function lockedNpmEnvironment(options) {
      const env = { ...process.env, ...(options?.env ?? {}) };
      const controlled = new Set([
        'node_env',
        'npm_config_production',
        'npm_config_omit',
        'npm_config_only',
        'npm_config_include'
      ]);
      for (const key of Object.keys(env)) {
        if (controlled.has(key.toLowerCase())) delete env[key];
      }
      return {
        ...env,
        NODE_ENV: 'development',
        NPM_CONFIG_PRODUCTION: 'false',
        NPM_CONFIG_OMIT: '',
        NPM_CONFIG_ONLY: '',
        NPM_CONFIG_INCLUDE: 'dev'
      };
    }
    function execFileWithLockedInstall(file, args = [], options, callback) {
      const transformed = transformArgs(file, args);
      const isNpm = (
        file === process.execPath &&
        typeof process.env.npm_execpath === 'string' &&
        transformed[0] === process.env.npm_execpath
      );
      return originalExecFile.call(
        childProcess,
        file,
        transformed,
        isNpm
          ? { ...(options ?? {}), env: lockedNpmEnvironment(options) }
          : options,
        callback
      );
    }
    execFileWithLockedInstall[promisify.custom] = function execFilePromise(
      file,
      args = [],
      options = {}
    ) {
      return new Promise((resolve, reject) => {
        execFileWithLockedInstall(file, args, options, (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    };
    childProcess.execFile = execFileWithLockedInstall;
  }

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
  await import('./validate-love-github-human-guide-production-r3.mjs');
  if (workerData?.r4Child === true) {
    parentPort?.postMessage({ npmCiIntercepts });
  }
}

function runR3InIsolatedWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { r4Child: true }
    });
    let result = null;
    worker.on('message', value => {
      result = value;
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`R4_NESTED_R3_WORKER_FAILED:${code}`));
        return;
      }
      if (!result || !Number.isInteger(result.npmCiIntercepts)) {
        reject(new Error('R4_NESTED_R3_WORKER_RESULT_MISSING'));
        return;
      }
      resolve(result);
    });
  });
}