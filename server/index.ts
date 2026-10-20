import { buildServer } from './app';
import { kernel } from './kernel';
import { SERVER_HOST, SERVER_PORT } from './paths';

const { app, aggregator } = await buildServer();

try {
  await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
  const status = kernel.getStatus();
  console.log(`\n  路由台 · Clash Route Desk`);
  console.log(`  http://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(
    status.connected
      ? `  内核已连接 · ${status.version ?? ''} · ${status.endpoint ?? ''}`
      : `  内核未连接 · ${status.error ?? ''}（界面仍可编辑）`,
  );
  console.log('');
} catch (error) {
  console.error('启动失败：', (error as Error).message);
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
