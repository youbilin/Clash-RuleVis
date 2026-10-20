import { ProxyAgent, fetch } from 'undici';

export interface FetchOptions {
  userAgent: string;
  proxyPort?: number;
  timeoutMs?: number;
}

export interface FetchResult {
  buffer: Buffer;
  text: string;
  headers: Record<string, string>;
  finalUrl: string;
  status: number;
}

const DEFAULT_TIMEOUT = 20_000;

function decodeText(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function attempt(
  url: string,
  options: FetchOptions,
  useProxy: boolean,
): Promise<FetchResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
  };
  let dispatcher: ProxyAgent | undefined;
  if (useProxy && options.proxyPort) {
    dispatcher = new ProxyAgent(`http://127.0.0.1:${options.proxyPort}`);
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      dispatcher,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('响应内容为空');
    return {
      buffer,
      text: decodeText(buffer),
      headers: Object.fromEntries(response.headers.entries()),
      finalUrl: response.url || url,
      status: response.status,
    };
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
}

export async function fetchUrl(url: string, options: FetchOptions): Promise<FetchResult> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 http / https 地址');
  }
  let directError: Error | null = null;
  try {
    return await attempt(url, options, false);
  } catch (error) {
    directError = error as Error;
  }
  if (options.proxyPort) {
    try {
      return await attempt(url, options, true);
    } catch (proxyError) {
      throw new Error(
        `下载失败：直连 ${directError.message}；经内核代理 ${(proxyError as Error).message}`,
      );
    }
  }
  throw new Error(`下载失败：${directError.message}`);
}

export interface SubscriptionUserinfo {
  used: number;
  total: number;
  expire?: number;
}

export function parseSubscriptionUserinfo(headerValue?: string): SubscriptionUserinfo | undefined {
  if (!headerValue) return undefined;
  const values = new Map<string, number>();
  for (const part of headerValue.split(';')) {
    const [key, value] = part.split('=').map((s) => s?.trim());
    if (!key || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) values.set(key.toLowerCase(), parsed);
  }
  const upload = values.get('upload') ?? 0;
  const download = values.get('download') ?? 0;
  const total = values.get('total') ?? 0;
  if (!total && !upload && !download) return undefined;
  const expire = values.get('expire');
  return {
    used: upload + download,
    total,
    expire: expire && expire > 0 ? expire : undefined,
  };
}
