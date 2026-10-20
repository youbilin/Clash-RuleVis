import { buildServer } from './app';
import { kernel } from './kernel';
import { SERVER_HOST, SERVER_PORT } from './paths';
import { redactLog } from './logging';

const { app, aggregator } = await buildServer();

try {
  await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
  const status = kernel.getStatus();
  console.log(`\n  Clash RuleVis · 本地路由工作台`);
  console.log(`  http://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(
    status.connected
      ? `  内核已连接 · ${status.version ?? ''} · ${status.endpoint ?? ''}`
      : `  内核未连接 · ${status.error ?? ''}（界面仍可编辑）`,
  );
  console.log('');
} catch (error) {
  console.error('启动失败：', redactLog(error));
  process.exit(1);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  aggregator.stop();
  kernel.stop();
  await app.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
