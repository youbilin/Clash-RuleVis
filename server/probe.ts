import net from 'node:net';

export async function probeThroughProxy(
  host: string,
  port: number,
  mixedPort: number,
  timeoutMs = 5000,
): Promise<void> {
  if (!/^[a-zA-Z0-9._:[\]-]+$/.test(host) || host.length > 253) {
    throw new Error('主机名格式无效');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口无效');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: mixedPort });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      if (chunk.toString('latin1').includes('\r\n\r\n')) finish();
    });
    socket.on('timeout', () => finish(new Error('探测超时')));
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('连接被关闭'));
    });
  });
}
