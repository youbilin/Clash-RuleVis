import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoData = path.join(repo, '.demo-data');
const demoPort = process.env.DEMO_PORT || '4781';

await fs.access(path.join(repo, 'dist/index.html')).catch(() => {
  console.error('缺少 dist，请先运行 npm run build');
  process.exit(1);
});

await fs.rm(demoData, { recursive: true, force: true });
await fs.mkdir(demoData, { recursive: true });
await fs.copyFile(path.join(repo, 'demo/workspace.json'), path.join(demoData, 'workspace.json'));

console.log(`\n  演示地址：http://127.0.0.1:${demoPort}`);
console.log('  使用独立数据目录 .demo-data，不会修改 data/。按 Ctrl+C 停止。\n');

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: demoPort, CRS_DATA_DIR: demoData },
  stdio: 'inherit',
  windowsHide: true,
});

const stop = () => {
  child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
