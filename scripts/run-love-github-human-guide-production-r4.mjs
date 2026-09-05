import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const originalExecFile = childProcess.execFile;
globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ = 0;

function transformArgs(file, args) {
  const npmExecPath = process.env.npm_execpath;
  if (
    file === process.execPath &&
    typeof npmExecPath === 'string' &&
    Array.isArray(args) &&
    args[0] === npmExecPath &&
    args[1] === 'install' &&
    args.includes('--package-lock=false')
  ) {
    globalThis.__KNEEKURA_R4_NPM_CI_INTERCEPTS__ += 1;
    return args
      .filter(arg => arg !== '--package-lock=false')
      .map((arg, index) => index === 1 ? 'ci' : arg);
  }
  return args;
}

function execFileWithLockedTargetInstall(file, args = [], options, callback) {
  return originalExecFile.call(
    childProcess,
    file,
    transformArgs(file, args),
    options,
    callback
  );
}

execFileWithLockedTargetInstall[promisify.custom] = function execFilePromise(
  file,
  args = [],
  options = {}
) {
  return new Promise((resolve, reject) => {
    execFileWithLockedTargetInstall(file, args, options, (error, stdout, stderr) => {
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

childProcess.execFile = execFileWithLockedTargetInstall;
syncBuiltinESMExports();
await import('./validate-love-github-human-guide-production-r4.mjs');