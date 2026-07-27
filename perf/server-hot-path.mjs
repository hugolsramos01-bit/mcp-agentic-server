import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const scenarios = [
  'structured-small',
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
    console.log(`\n--- Scenario: ${scenario} ---`);
    const proc = spawn(process.execPath, [join(__dirname, '_server-hot-path-executor.mjs'), scenario], {
      stdio: 'inherit'
    });
    
    await new Promise((resolve) => {
      proc.on('close', resolve);
    });
  }
}

run().catch(console.error);
