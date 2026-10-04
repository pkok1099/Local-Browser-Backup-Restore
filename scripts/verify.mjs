import { spawn } from 'node:child_process';
import process from 'node:process';

const npmExecPath = process.env.npm_execpath;

function prefixLines(stream, label, output) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) output.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) output.write(`[${label}] ${pending}\n`);
  });
}

function runNpmScript(name) {
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32'
      ? 'npm.cmd'
      : 'npm';
  const args = npmExecPath ? [npmExecPath, 'run', name] : ['run', name];
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });

  prefixLines(child.stdout, name, process.stdout);
  prefixLines(child.stderr, `${name}:stderr`, process.stderr);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ name, exitCode });
    };

    child.once('error', (error) => {
      process.stderr.write(`[${name}] Could not start: ${error.message}\n`);
      finish(1);
    });
    child.once('close', (code) => finish(code ?? 1));
  });
}

const results = await Promise.all(
  ['lint', 'typecheck', 'format:check', 'test'].map(runNpmScript)
);
const failures = results.filter(({ exitCode }) => exitCode !== 0);

if (failures.length > 0) {
  console.error(
    `[verify] Failed: ${failures.map(({ name, exitCode }) => `${name} (exit ${exitCode})`).join(', ')}`
  );
  process.exitCode = failures[0].exitCode;
} else {
  console.log(
    '[verify] Passed: lint, typecheck, format check, and Node tests.'
  );
}
