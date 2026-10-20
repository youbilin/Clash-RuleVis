export class ApiError extends Error {
  status: number;
  code?: string;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.code = (payload as { code?: string } | null)?.code;
  }
}

let sessionPromise: Promise<void> | null = null;

export async function ensureSession(): Promise<void> {
  if (!sessionPromise) {
    sessionPromise = fetch('/api/bootstrap', {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'clash-route-desk' },
    }).then((response) => {
      if (!response.ok) throw new ApiError(response.status, '无法建立本地会话', null);
    });
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function send<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'clash-route-desk',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, (data as { error?: string }).error || `请求失败 (${response.status})`, data);
  }
  return data as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const retryable = method === 'GET';
  let sessionRetried = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ensureSession();
      return await send<T>(path, options);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401 && !sessionRetried) {
          sessionRetried = true;
          sessionPromise = null;
          continue;
        }
        throw error;
      }
      if (retryable && attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 220 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('本地服务连接失败');
}

export function liveSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/live`;
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
