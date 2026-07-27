import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const scenarios = [
  'structured-small',
  'native-structured-small',
  'text-json-small',
  'structured-large',
  'text-error',
  'structured-error',
  'plain-text-success',
  'structured-with-meta-card',
];

async function run() {
  console.log("Starting Server Hot Path Benchmarks");
  for (const scenario of scenarios) {
    const proc = spawn(process.execPath, [join(__dirname, '_server-hot-path-executor.mjs'), scenario], {
      stdio: 'inherit'
    });
    
    await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${scenario} exited with code ${code}`));
        }
      });
    });
  }
}

run().catch(console.error);
