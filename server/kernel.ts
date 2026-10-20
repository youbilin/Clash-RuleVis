import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { KernelStatus } from '../shared/types';
import { atomicWriteFile, readJsonFile } from './fsutil';
import { KERNEL_SETTINGS_PATH } from './paths';

const PIPE_ROOT = '\\\\.\\pipe\\';

export interface KernelConnection {
  transport: 'pipe' | 'tcp';
  pipe?: string;
  host?: string;
  port?: number;
  secret: string;
  endpointLabel: string;
}

export interface StoredKernelSettings {
  mode: 'auto' | 'pipe' | 'tcp';
  endpoint?: string;
  secret?: string;
}

export interface VergeInfo {
  dir: string;
  configPath: string;
  profilesPath?: string;
  activeProfileName?: string;
  activeProfileFile?: string;
  controller?: string;
  pipe?: string;
  hasSecret: boolean;
}

export interface MihomoMetadata {
  network?: string;
  type?: string;
  host?: string;
  destinationIP?: string;
  destinationPort?: string;
  sourceIP?: string;
  sourcePort?: string;
  inboundName?: string;
  processPath?: string;
  process?: string;
  specialProxy?: string;
  sniffHost?: string;
  remoteDestination?: string;
  dnsMode?: string;
  uid?: number;
}

export interface MihomoConnection {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  metadata: MihomoMetadata;
}

export interface MihomoConnections {
  downloadTotal: number;
  uploadTotal: number;
  connections: MihomoConnection[];
}

export interface MihomoProxy {
  name: string;
  type: string;
  now?: string | null;
  all?: string[];
  history?: Array<{ time: string; delay: number }>;
}

export interface MihomoProxies {
  proxies: Record<string, MihomoProxy>;
}

export interface MihomoRule {
  index: number;
  type: string;
  payload: string;
  proxy: string;
  size?: number;
  extra?: { hitCount?: number; hitAt?: string; disabled?: boolean };
}

export interface MihomoRules {
  rules: MihomoRule[];
}

export interface MihomoProvider {
  name: string;
  type?: string;
  vehicleType?: string;
  behavior?: string;
  format?: string;
  ruleCount?: number;
  updatedAt?: string;
}

export interface MihomoProviders {
  providers: Record<string, MihomoProvider>;
}

export interface MihomoConfigs {
  port?: number;
  'socks-port'?: number;
  'mixed-port'?: number;
  mode?: string;
  'log-level'?: string;
  tun?: { enable?: boolean };
}

export class KernelError extends Error {
  code: string;
  constructor(message: string, code = 'KERNEL_ERROR') {
    super(message);
    this.code = code;
  }
}

function pipeExists(pipe: string): boolean {
  try {
    return fs.existsSync(pipe);
  } catch {
    return false;
  }
}

function listMihomoPipes(): string[] {
  try {
    return fs
      .readdirSync(PIPE_ROOT)
      .filter((name) => /^(verge-mihomo|mihomo|clash)/i.test(name))
      .map((name) => PIPE_ROOT + name);
  } catch {
    return [];
  }
}

function vergeDirs(): string[] {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const dirs: string[] = [];
  if (appData) {
    dirs.push(
      path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev'),
      path.join(appData, 'top.gydi.clashverge'),
      path.join(appData, 'clash-verge'),
      path.join(appData, 'clash-verge-rev'),
    );
  }
  if (localAppData) {
    dirs.push(path.join(localAppData, 'io.github.clash-verge-rev.clash-verge-rev'));
  }
  return dirs;
}

async function readVergeInfo(): Promise<VergeInfo | null> {
  for (const dir of vergeDirs()) {
    const configPath = path.join(dir, 'config.yaml');
    try {
      await fsp.access(configPath);
    } catch {
      continue;
    }
    try {
      const raw = await fsp.readFile(configPath, 'utf8');
      const config = parseYaml(raw) as Record<string, unknown> | null;
      const info: VergeInfo = {
        dir,
        configPath,
        controller: typeof config?.['external-controller'] === 'string' ? (config['external-controller'] as string) : undefined,
        pipe: typeof config?.['external-controller-pipe'] === 'string' ? (config['external-controller-pipe'] as string) : undefined,
        hasSecret: typeof config?.secret === 'string' && Boolean(config.secret),
      };
      (info as VergeInfo & { secret?: string }).secret = typeof config?.secret === 'string' ? config.secret : '';
      const profilesPath = path.join(dir, 'profiles.yaml');
      try {
        const profilesRaw = await fsp.readFile(profilesPath, 'utf8');
        const profiles = parseYaml(profilesRaw) as {
          current?: string;
          items?: Array<{ uid?: string; name?: string; file?: string; type?: string }>;
        } | null;
        info.profilesPath = profilesPath;
        const active = profiles?.items?.find((item) => item.uid === profiles?.current);
        if (active) {
          info.activeProfileName = active.name || active.uid;
          if (active.file) info.activeProfileFile = path.join(dir, 'profiles', path.basename(active.file));
        }
      } catch {
        // profiles.yaml 不存在时仅保留控制器信息
      }
      return info;
    } catch {
      continue;
    }
  }
  return null;
}

function getConfigSecret(info: VergeInfo | null): string {
  if (!info) return '';
  return (info as VergeInfo & { secret?: string }).secret ?? '';
}

function candidateKey(candidate: KernelConnection): string {
  return candidate.transport === 'pipe' ? `pipe:${candidate.pipe}` : `tcp:${candidate.host}:${candidate.port}`;
}

export function buildCandidates(
  settings: StoredKernelSettings,
  verge: VergeInfo | null,
  pipes: string[] = listMihomoPipes(),
): KernelConnection[] {
  const candidates: KernelConnection[] = [];
  const add = (candidate: KernelConnection) => {
    if (candidates.some((c) => candidateKey(c) === candidateKey(candidate))) return;
    candidates.push(candidate);
  };

  const configSecret = getConfigSecret(verge);
  const manualSecret = settings.secret ?? '';
  const secretFor = (explicit?: string) => explicit || manualSecret || configSecret;

  const manualEndpoint = settings.endpoint?.trim() ?? '';
  const parseManual = (): KernelConnection | null => {
    if (!manualEndpoint) return null;
    if (manualEndpoint.startsWith('\\\\.\\pipe\\') || manualEndpoint.startsWith('//./pipe/')) {
      return {
        transport: 'pipe',
        pipe: manualEndpoint.replace(/^\/\/\.\/pipe\//, PIPE_ROOT),
        secret: secretFor(),
        endpointLabel: '命名管道',
      };
    }
    const [host, portRaw] = manualEndpoint.replace(/^https?:\/\//, '').split(':');
    const port = Number(portRaw || 9090);
    if (!host || !Number.isFinite(port)) return null;
    return { transport: 'tcp', host, port, secret: secretFor(), endpointLabel: `${host}:${port}` };
  };

  if (settings.mode === 'tcp' || settings.mode === 'pipe') {
    const manual = parseManual();
    if (manual) add(manual);
    return candidates;
  }

  const manual = parseManual();
  if (manual) add(manual);

  if (verge?.controller) {
    const [host, portRaw] = verge.controller.split(':');
    const port = Number(portRaw);
    if (host && Number.isFinite(port)) {
      add({ transport: 'tcp', host, port, secret: secretFor(), endpointLabel: verge.controller });
    }
  }
  if (verge?.pipe && pipeExists(verge.pipe)) {
    add({ transport: 'pipe', pipe: verge.pipe, secret: secretFor(), endpointLabel: '命名管道' });
  }
  for (const pipe of pipes) {
    add({ transport: 'pipe', pipe, secret: secretFor(), endpointLabel: '命名管道' });
  }
  for (const port of [9097, 9090]) {
    add({ transport: 'tcp', host: '127.0.0.1', port, secret: secretFor(), endpointLabel: `127.0.0.1:${port}` });
  }
  return candidates;
}

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  connection: KernelConnection,
  requestPath: string,
  options: { method?: string; timeout?: number; body?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (connection.secret) headers.Authorization = `Bearer ${connection.secret}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    const requestOptions: http.RequestOptions = {
      method: options.method ?? 'GET',
      path: requestPath,
      headers,
      timeout: options.timeout ?? 5000,
    };
    if (connection.transport === 'pipe') {
      requestOptions.socketPath = connection.pipe;
    } else {
      requestOptions.host = connection.host;
      requestOptions.port = connection.port;
    }
    const req = http.request(requestOptions, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => {
      req.destroy(new KernelError('内核请求超时', 'KERNEL_TIMEOUT'));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function parseBody<T>(res: RawResponse): T {
  if (res.status === 401 || res.status === 403) {
    throw new KernelError('内核密钥无效', 'KERNEL_AUTH');
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = res.body.slice(0, 180);
    try {
      const parsed = JSON.parse(res.body) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // 非 JSON 错误体直接截断展示
    }
    throw new KernelError(`内核返回 ${res.status}${detail ? `：${detail}` : ''}`, 'KERNEL_HTTP');
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new KernelError('内核返回了无法解析的数据', 'KERNEL_PARSE');
  }
}

async function testConnection(connection: KernelConnection): Promise<string> {
  const res = await rawRequest(connection, '/version', { timeout: 1200 });
  const data = parseBody<{ version?: string }>(res);
  return data.version ?? 'unknown';
}

export class Kernel {
  private connection: KernelConnection | null = null;
  private status: KernelStatus = { connected: false, discovering: true };
  private settings: StoredKernelSettings = { mode: 'auto' };
  private verge: VergeInfo | null = null;
  private mixedPort: number | undefined;
  private mode = '';
  private retryTimer: NodeJS.Timeout | null = null;
  private discovering: Promise<void> | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.settings = (await readJsonFile<StoredKernelSettings>(KERNEL_SETTINGS_PATH)) ?? { mode: 'auto' };
    await this.discover();
    this.scheduleRetry();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  getStatus(): KernelStatus {
    return { ...this.status };
  }

  getVerge(): VergeInfo | null {
    return this.verge;
  }

  getSettings(): StoredKernelSettings {
    return this.settings;
  }

  getMixedPort(): number | undefined {
    return this.mixedPort;
  }

  async saveSettings(next: StoredKernelSettings): Promise<void> {
    this.settings = next;
    await atomicWriteFile(KERNEL_SETTINGS_PATH, JSON.stringify(next, null, 2));
    await this.discover(true);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (!this.connection) await this.discover();
      else await this.refreshStatus().catch(() => {});
      this.scheduleRetry();
    }, this.connection ? 10_000 : 5_000);
    this.retryTimer.unref?.();
  }

  async refreshStatus(): Promise<void> {
    if (!this.connection) return;
    const res = await rawRequest(this.connection, '/configs', { timeout: 3000 });
    const configs = parseBody<MihomoConfigs>(res);
    this.mode = configs.mode ?? this.mode;
    this.mixedPort = configs['mixed-port'] || configs.port || this.mixedPort;
    this.status = {
      ...this.status,
      connected: true,
      mode: this.mode,
      mixedPort: this.mixedPort,
      lastSeenAt: Date.now(),
      error: undefined,
    };
  }

  async discover(force = false): Promise<void> {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      this.status = { ...this.status, discovering: true, error: undefined };
      this.verge = await readVergeInfo().catch(() => null);
      const pipes = listMihomoPipes();
      const candidates = buildCandidates(this.settings, this.verge, pipes);
      let lastError = '';
      for (const candidate of candidates) {
        try {
          const version = await testConnection(candidate);
          this.connection = candidate;
          this.mode = '';
          this.mixedPort = undefined;
          await this.refreshStatus().catch(() => {});
          this.status = {
            connected: true,
            discovering: false,
            transport: candidate.transport,
            endpoint: candidate.endpointLabel,
            version,
            mode: this.mode || undefined,
            mixedPort: this.mixedPort,
            lastSeenAt: Date.now(),
          };
          console.info(`[kernel] 已连接 ${version} · ${candidate.endpointLabel}`);
          return;
        } catch (error) {
          const err = error as KernelError;
          lastError =
            err.code === 'KERNEL_AUTH'
              ? '密钥无效'
              : err.code === 'KERNEL_TIMEOUT'
                ? '连接超时'
                : '未发现可用的外部控制器';
        }
      }
      this.connection = null;
      this.status = {
        connected: false,
        discovering: false,
        error: lastError || '未发现 mihomo 外部控制器',
      };
      if (force) console.info('[kernel] 重新探测失败：', this.status.error);
    })().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  async request<T>(
    requestPath: string,
    options: { method?: string; timeout?: number; body?: string } = {},
  ): Promise<T> {
    const connection = this.connection;
    if (!connection) throw new KernelError('内核未连接', 'KERNEL_OFFLINE');
    try {
      const res = await rawRequest(connection, requestPath, options);
      const data = parseBody<T>(res);
      this.status.lastSeenAt = Date.now();
      return data;
    } catch (error) {
      const err = error as KernelError;
      if (err.code !== 'KERNEL_HTTP' && err.code !== 'KERNEL_AUTH') {
        this.status = { ...this.status, connected: false, error: '内核连接中断' };
        this.connection = null;
        void this.discover();
      } else if (err.code === 'KERNEL_AUTH') {
        this.status = { ...this.status, connected: false, error: '内核密钥无效' };
      }
      throw error;
    }
  }

  getConnections(): Promise<MihomoConnections> {
    return this.request<MihomoConnections>('/connections', { timeout: 5000 });
  }

  getProxies(): Promise<MihomoProxies> {
    return this.request<MihomoProxies>('/proxies', { timeout: 5000 });
  }

  getRules(): Promise<MihomoRules> {
    return this.request<MihomoRules>('/rules', { timeout: 6000 });
  }

  getRuleProviders(): Promise<MihomoProviders> {
    return this.request<MihomoProviders>('/providers/rules', { timeout: 6000 });
  }

  async testNode(name: string, url: string, timeout = 4000): Promise<number | null> {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    const data = await this.request<{ delay?: number }>(
      `/proxies/${encodeURIComponent(name)}/delay?${query.toString()}`,
      { timeout: timeout + 3000 },
    );
    return data.delay ?? null;
  }

  async testGroup(name: string, url: string, timeout = 4000): Promise<Record<string, number>> {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    return this.request<Record<string, number>>(
      `/group/${encodeURIComponent(name)}/delay?${query.toString()}`,
      { timeout: timeout + 4000 },
    );
  }
}

export async function probeKernel(settings: StoredKernelSettings): Promise<{ ok: boolean; version?: string; connection?: string; error?: string }> {
  const verge = await readVergeInfo().catch(() => null);
  const candidates = buildCandidates(settings, verge);
  for (const candidate of candidates) {
    try {
      const version = await testConnection(candidate);
      return { ok: true, version, connection: candidate.endpointLabel };
    } catch (error) {
      const err = error as KernelError;
      if (err.code === 'KERNEL_AUTH') return { ok: false, error: '密钥无效' };
    }
  }
  return { ok: false, error: '无法连接，请检查控制器地址与密钥' };
}

export async function getActiveProfile(): Promise<{ name: string; filePath: string; verceDir: string } | null> {
  const verge = await readVergeInfo();
  if (!verge?.activeProfileFile) return null;
  try {
    await fsp.access(verge.activeProfileFile);
    return {
      name: verge.activeProfileName || 'Clash Verge 当前配置',
      filePath: verge.activeProfileFile,
      verceDir: verge.dir,
    };
  } catch {
    return null;
  }
}

export const kernel = new Kernel();
