import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type {
  AppStatus,
  DelayResult,
  ExportPreview,
  ImportSummary,
  InlineRule,
  RefreshSummary,
  RuleSetInspect,
  RuleSetRoute,
  ProxyNode,
  RulesetBehavior,
  RulesetFormat,
  Source,
  Workspace,
} from '../shared/types';
import { WORKSPACE_VERSION } from '../shared/types';
import { nodeDisplayName, insertRouteOrdered, resolveExit } from '../shared/model';
import { DATA_DIR, DIST_DIR, EXPORTS_DIR, SERVER_PORT, ensureDataDirs } from './paths';
import { getWorkspace, initStore, listHistory, readHistory, replaceWorkspace, restoreHistory, updateWorkspace, addHistory, clearHistory, RevisionConflictError } from './store';
import { ensureWorkspaceShape, MANUAL_SOURCE_NAME, MANUAL_SOURCE_NOTE } from './defaults';
import { kernel, getActiveProfile, probeKernel } from './kernel';
import { LiveAggregator } from './aggregator';
import { fetchUrl, parseSubscriptionUserinfo, type FetchOptions } from './fetcher';
import {
  applyParsedConfig,
  parseConfigText,
  suggestPrefix,
  type ParsedConfig,
} from './importer';
import { expandRuleset, inspectRuleSetBuffer, sanitizeFileName, storeRuleSetFile } from './rulesets';
import { buildPreview, exportConfig, ExportValidationError, readExportForHistory } from './exporter';
import { validateConfig } from './mihomo-validator';
import { probeThroughProxy } from './probe';
import { RULE_SETS_DIR } from './paths';
import { fileExists, isPathInside } from './fsutil';
import { redactLog } from './logging';

const APP_VERSION = '0.3.2';
const COOKIE_NAME = 'crs_session';

class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'HTTP_ERROR', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface WsClient {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

function openExternalUrl(target: string): boolean {
  try {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface BootstrapBody {
  name?: string;
  url?: string;
  content?: string;
  prefix?: string;
  keepRules?: boolean;
  proxy?: Record<string, unknown>;
}

interface RuleSetCreateBody {
  name: string;
  sourceType: 'url' | 'file';
  url?: string;
  filePath?: string;
  fileName?: string;
  behavior: RulesetBehavior;
  format: RulesetFormat;
  exitId: string;
  inline: boolean;
  interval?: number;
}

function parseCookies(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function requireString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field}不能为空`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new HttpError(400, `${field}过长`);
  return trimmed;
}

function normalizePrefix(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, '节点前缀格式无效');
  const trimmed = value.trim();
  if (trimmed.length > 24) throw new HttpError(400, '节点前缀不能超过 24 个字符');
  if (/[,\r\n]/.test(trimmed)) throw new HttpError(400, '节点前缀不能包含逗号或换行');
  return trimmed;
}

function normalizeSourceName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const trimmed = value.trim();
  if (trimmed.length > 60) return trimmed.slice(0, 60);
  return trimmed;
}

function validateHttpUrl(value: unknown): string {
  const raw = requireString(value, '地址', 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, '地址格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, '只支持 http / https 地址');
  }
  return parsed.toString();
}

function fetchOptions(timeoutMs = 30_000): FetchOptions {
  const settings = getWorkspace().settings;
  return {
    userAgent: settings.subscriptionUserAgent,
    proxyPort: settings.useProxyForFetch ? kernel.getMixedPort() : undefined,
    timeoutMs,
  };
}

async function recordHistory(
  label: string,
  kind: 'export' | 'manual' | 'restore',
  note: string,
  exportPath?: string,
  fileName?: string,
): Promise<void> {
  try {
    await addHistory({ label, kind, note, exportPath, fileName }, getWorkspace());
  } catch (error) {
    console.warn('[history] 快照写入失败：', redactLog(error));
  }
}

function parsedSummary(parsed: ParsedConfig): string {
  return `${parsed.proxies.length} 个节点 / ${parsed.groups.length} 个策略组 / ${parsed.rules.length} 条规则`;
}

function buildImportSummary(
  workspace: Workspace,
  result: {
    added: number;
    deduped: number;
    groups: number;
    rules: number;
    skippedRules: number;
    warnings: string[];
  },
): ImportSummary {
  return {
    workspace,
    added: result.added,
    deduped: result.deduped,
    groups: result.groups,
    rules: result.rules,
    skippedRules: result.skippedRules,
    warnings: result.warnings,
  };
}

async function importParsed(
  source: Source,
  parsed: ParsedConfig,
  keepRules: boolean,
  historyLabel: string,
): Promise<ImportSummary> {
  const { value, workspace } = await updateWorkspace((draft) => {
    let targetSource = draft.sources.find((item) => item.id === source.id);
    if (targetSource) {
      targetSource.updatedAt = new Date().toISOString();
    } else {
      source.updatedAt = new Date().toISOString();
      draft.sources.push(source);
      targetSource = source;
    }
    return applyParsedConfig({
      workspace: draft,
      source: targetSource,
      parsed,
      isRefresh: false,
      keepRules,
    });
  });
  await recordHistory(historyLabel, 'manual', `导入 ${parsedSummary(parsed)}`);
  return buildImportSummary(workspace, value);
}

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

export async function buildServer(): Promise<{ app: FastifyInstance; aggregator: LiveAggregator }> {
  ensureDataDirs();
  await initStore();
  await kernel.start().catch((error) => {
    console.warn('[kernel] 启动探测失败：', redactLog(error));
  });

  const app = Fastify({ logger: false, bodyLimit: 45 * 1024 * 1024 });
  const sessionToken = randomBytes(32).toString('hex');
  const shareEntries = new Map<string, { yaml: string; expiresAt: number; filePath: string }>();
  const allowedOrigins = new Set([
    `http://127.0.0.1:${SERVER_PORT}`,
    `http://localhost:${SERVER_PORT}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:5180',
    'http://localhost:5180',
    'http://127.0.0.1:5273',
    'http://localhost:5273',
  ]);

  await app.register(fastifyWebsocket);

  const originAllowed = (origin?: string) => !origin || allowedOrigins.has(origin);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      reply.code(403).headers(baseHeaders()).send({ error: '请求来源不被允许' });
      return;
    }
    if (request.url.startsWith('/api/bootstrap')) return;
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (!token || !safeEqual(token, sessionToken)) {
      reply.code(401).headers(baseHeaders()).send({ error: '本地会话已失效，请刷新页面' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ExportValidationError) {
      reply.code(422).headers(baseHeaders()).send({
        error: error.message,
        preview: error.preview,
        validation: error.validation,
      });
      return;
    }
    if (error instanceof HttpError) {
      reply.code(error.status).headers(baseHeaders()).send({
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      reply.code(413).headers(baseHeaders()).send({ error: '请求内容过大' });
      return;
    }
    console.error('[api] 未处理错误：', redactLog(error));
    reply.code(500).headers(baseHeaders()).send({ error: '服务器内部错误' });
  });

  app.get('/api/bootstrap', async (request, reply) => {
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      reply.code(403).send({ error: '请求来源不被允许' });
      return;
    }
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    );
    reply.header('Cache-Control', 'no-store');
    return { ok: true, version: APP_VERSION };
  });

  app.get('/api/status', async (): Promise<AppStatus> => {
    const workspace = getWorkspace();
    const verge = await getActiveProfile().catch(() => null);
    return {
      kernel: kernel.getStatus(),
      version: APP_VERSION,
      dataDir: DATA_DIR,
      exportsDir: EXPORTS_DIR,
      workspace: {
        revision: workspace.revision,
        lastExport: workspace.lastExport,
        counts: {
          sources: workspace.sources.length,
          nodes: workspace.nodes.length,
          exits: workspace.exits.filter((e) => !e.builtin).length,
          routes: workspace.routes.length,
          pending: workspace.routes.filter((r) => r.pending).length,
        },
      },
      vergeProfile: verge?.name,
    };
  });

  app.post('/api/exports/open', async () => {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [EXPORTS_DIR], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (error) {
      throw new HttpError(500, `无法打开导出目录：${(error as Error).message}`);
    }
  });

  app.post('/api/exports/import-to-verge', async (request) => {
    const body = (request.body ?? {}) as { path?: string; open?: boolean };
    const filePath = typeof body.path === 'string' && body.path
      ? body.path
      : getWorkspace().lastExport?.path;
    if (!filePath || !isPathInside(EXPORTS_DIR, filePath)) {
      throw new HttpError(400, '导出文件路径无效');
    }
    let yaml: string;
    try {
      yaml = await fsp.readFile(filePath, 'utf8');
    } catch {
      throw new HttpError(404, '导出文件不存在，请重新导出');
    }
    const token = randomBytes(18).toString('hex');
    const expiresAt = Date.now() + 30 * 60_000;
    for (const [key, entry] of shareEntries) {
      if (entry.expiresAt <= Date.now()) shareEntries.delete(key);
    }
    shareEntries.set(token, { yaml, expiresAt, filePath });
    const url = `http://127.0.0.1:${SERVER_PORT}/share/clash/${token}.yaml`;
    const schemeUrl = `clash://install-config?url=${encodeURIComponent(url)}`;
    return {
      url,
      schemeUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      opened: body.open === false ? false : openExternalUrl(schemeUrl),
    };
  });

  app.post('/api/open-url', async (request) => {
    const body = (request.body ?? {}) as { url?: unknown };
    const url = validateHttpUrl(body.url);
    return { ok: openExternalUrl(url) };
  });

  app.get('/share/clash/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const token = file.endsWith('.yaml') ? file.slice(0, -5) : file;
    const entry = shareEntries.get(token);
    if (!entry || entry.expiresAt <= Date.now() || !/^[a-f0-9]{36}$/i.test(token)) {
      reply.code(404).type('text/plain; charset=utf-8').send('分享链接已失效');
      return;
    }
    reply
      .header('Content-Type', 'text/yaml; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(entry.yaml);
  });

  app.get('/api/live', async () => aggregator.getSnapshot());

  app.get('/api/workspace', async () => ({ workspace: getWorkspace() }));

  app.post('/api/workspace/import', async (request) => {
    const body = request.body as {
      backup?: { workspace?: Workspace; workspaceVersion?: number };
      workspace?: Workspace;
    };
    const candidate = body.backup?.workspace ?? body.workspace ?? (body as unknown as Workspace);
    if (!candidate || typeof candidate !== 'object') throw new HttpError(400, '备份文件无效');
    const declaredVersion = Number(body.backup?.workspaceVersion ?? candidate.version ?? WORKSPACE_VERSION);
    if (declaredVersion > WORKSPACE_VERSION) {
      throw new HttpError(400, `备份版本 ${declaredVersion} 高于当前工作区版本 ${WORKSPACE_VERSION}，请升级工具后再导入`);
    }
    if (!Array.isArray(candidate.sources) || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.exits) || !Array.isArray(candidate.routes)) {
      throw new HttpError(400, '备份数据结构无效');
    }
    const undoEntry = await addHistory(
      { label: '导入工作区前的快照', kind: 'manual', note: '导入备份前自动创建' },
      getWorkspace(),
    );
    const next = ensureWorkspaceShape(structuredClone(candidate));
    const workspace = await replaceWorkspace(next);
    await addHistory(
      { label: '导入工作区备份', kind: 'restore', note: new Date().toISOString() },
      workspace,
    );
    return { workspace, undoEntry };
  });

  app.put('/api/workspace', async (request, reply) => {
    const body = request.body as { workspace?: Workspace; baseRevision?: number };
    if (!body?.workspace || typeof body.workspace !== 'object') {
      throw new HttpError(400, '工作区数据无效');
    }
    const next = body.workspace;
    if (!Array.isArray(next.sources) || !Array.isArray(next.nodes) || !Array.isArray(next.exits) || !Array.isArray(next.routes)) {
      throw new HttpError(400, '工作区数据结构无效');
    }
    try {
      const workspace = await replaceWorkspace(next, body.baseRevision);
      return { workspace };
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        reply.code(409);
        return { error: '工作区已在其他窗口或后台任务中更新，请重新加载', workspace: error.current };
      }
      throw error;
    }
  });

  app.get('/api/kernel/settings', async () => {
    const settings = kernel.getSettings();
    return {
      mode: settings.mode,
      endpoint: settings.endpoint ?? '',
      hasSecret: Boolean(settings.secret),
      status: kernel.getStatus(),
    };
  });

  app.put('/api/kernel/settings', async (request) => {
    const body = request.body as { mode?: string; endpoint?: string; secret?: string };
    const mode = body.mode === 'pipe' || body.mode === 'tcp' ? body.mode : 'auto';
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (mode !== 'auto' && !endpoint) throw new HttpError(400, '手动模式需要填写控制器地址');
    if (/[\r\n]/.test(endpoint)) throw new HttpError(400, '控制器地址格式无效');
    const current = kernel.getSettings();
    const secret =
      typeof body.secret === 'string'
        ? body.secret.trim()
        : current.secret;
    await kernel.saveSettings({ mode, endpoint: endpoint || undefined, secret });
    return { status: kernel.getStatus(), settings: await kernel.getSettings() };
  });

  app.post('/api/kernel/test', async (request) => {
    const body = request.body as { mode?: string; endpoint?: string; secret?: string };
    const mode = body.mode === 'pipe' || body.mode === 'tcp' ? body.mode : 'auto';
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const secret = typeof body.secret === 'string' ? body.secret.trim() : kernel.getSettings().secret;
    const result = await probeKernel({ mode, endpoint: endpoint || undefined, secret });
    return result;
  });

  app.post('/api/kernel/rediscover', async () => {
    await kernel.discover(true);
    return { status: kernel.getStatus() };
  });

  app.post('/api/probe', async (request) => {
    const body = request.body as { host?: string; port?: number };
    const host = requireString(body.host, '域名', 253);
    const port = Number(body.port ?? 443);
    const mixedPort = kernel.getMixedPort();
    if (!mixedPort) throw new HttpError(409, '尚未取得内核混合端口，无法探测');
    try {
      await probeThroughProxy(host, port, mixedPort);
      return { ok: true, message: '探测连接已发起，请稍后查看连接流' };
    } catch (error) {
      throw new HttpError(502, `探测失败：${(error as Error).message}`);
    }
  });

  app.post('/api/delay', async (request) => {
    const body = request.body as { names?: unknown; url?: string };
    if (!Array.isArray(body.names) || !body.names.length) throw new HttpError(400, '请选择要测速的节点');
    const names = [...new Set(body.names.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())))].slice(0, 40);
    const url = typeof body.url === 'string' && body.url ? validateHttpUrl(body.url) : getWorkspace().settings.testUrl;
    const results: DelayResult[] = new Array(names.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < names.length) {
        const index = cursor++;
        const name = names[index];
        try {
          const delay = await kernel.testNode(name, url);
          results[index] = { name, delay: delay ?? undefined };
        } catch (error) {
          results[index] = { name, error: (error as Error).message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
    return { results };
  });

  app.post('/api/delay/group', async (request, reply) => {
    const body = request.body as { name?: string; url?: string };
    const name = requireString(body.name, '出口名称', 200);
    const url = typeof body.url === 'string' && body.url ? validateHttpUrl(body.url) : getWorkspace().settings.testUrl;
    try {
      const delays = await kernel.testGroup(name, url);
      return { delays };
    } catch (error) {
      reply.code(502);
      return { error: (error as Error).message };
    }
  });

  app.post('/api/sources/subscription', async (request) => {
    const body = request.body as BootstrapBody;
    const url = validateHttpUrl(body.url);
    const fallbackName = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '订阅';
      }
    })();
    const name = normalizeSourceName(body.name, fallbackName);
    const prefix = normalizePrefix(body.prefix, suggestPrefix(name));
    const keepRules = body.keepRules === true;
    let fetched;
    try {
      fetched = await fetchUrl(url, fetchOptions(30_000));
    } catch (error) {
      throw new HttpError(502, (error as Error).message);
    }
    let parsed: ParsedConfig;
    try {
      parsed = parseConfigText(fetched.text);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const source: Source = {
      id: randomUUID(),
      type: 'subscription',
      name,
      url,
      prefix,
      keepRules,
      updatedAt: new Date().toISOString(),
      userinfo: parseSubscriptionUserinfo(fetched.headers['subscription-userinfo']),
    };
    return importParsed(source, parsed, keepRules, `导入订阅 · ${name}`);
  });

  app.post('/api/sources/file', async (request) => {
    const body = request.body as BootstrapBody;
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) throw new HttpError(400, '文件内容为空');
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new HttpError(413, '文件过大（上限 20MB）');
    const name = normalizeSourceName(body.name, '本地配置');
    const prefix = normalizePrefix(body.prefix, '');
    const keepRules = body.keepRules === true;
    let parsed: ParsedConfig;
    try {
      parsed = parseConfigText(content);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const source: Source = {
      id: randomUUID(),
      type: 'file',
      name,
      prefix,
      keepRules,
      updatedAt: new Date().toISOString(),
    };
    return importParsed(source, parsed, keepRules, `导入文件 · ${name}`);
  });

  app.post('/api/sources/paste', async (request) => {
    const body = request.body as BootstrapBody;
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) throw new HttpError(400, '粘贴内容为空');
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new HttpError(413, '内容过大（上限 20MB）');
    const name = normalizeSourceName(body.name, '粘贴配置');
    const prefix = normalizePrefix(body.prefix, '');
    const keepRules = body.keepRules === true;
    let parsed: ParsedConfig;
    try {
      parsed = parseConfigText(content);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const source: Source = {
      id: randomUUID(),
      type: 'paste',
      name,
      prefix,
      keepRules,
      updatedAt: new Date().toISOString(),
    };
    return importParsed(source, parsed, keepRules, `粘贴导入 · ${name}`);
  });

  app.post('/api/sources/manual', async (request) => {
    const body = request.body as BootstrapBody;
    if (!body.proxy || typeof body.proxy !== 'object') throw new HttpError(400, '节点数据无效');
    const proxy = body.proxy;
    if (typeof proxy.type !== 'string' || typeof proxy.server !== 'string' || !proxy.name) {
      throw new HttpError(400, '节点缺少类型、地址或名称');
    }
    const parsed: ParsedConfig = {
      proxies: [proxy],
      groups: [],
      rules: [],
      providers: {},
      warnings: [],
    };
    const existing = getWorkspace().sources.find((item) => item.type === 'manual');
    const source: Source = existing
      ? { ...existing }
      : {
          id: randomUUID(),
          type: 'manual',
          name: MANUAL_SOURCE_NAME,
          prefix: '',
          keepRules: false,
          updatedAt: new Date().toISOString(),
          note: MANUAL_SOURCE_NOTE,
        };
    return importParsed(source, parsed, false, '添加手动节点');
  });

  app.post('/api/sources/verge', async (request) => {
    const body = request.body as BootstrapBody;
    const profile = await getActiveProfile();
    if (!profile) throw new HttpError(404, '未找到 Clash Verge 当前生效的配置文件');
    let content: string;
    try {
      content = await fsp.readFile(profile.filePath, 'utf8');
    } catch (error) {
      throw new HttpError(500, `读取 Verge 配置失败：${(error as Error).message}`);
    }
    let parsed: ParsedConfig;
    try {
      parsed = parseConfigText(content);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const keepRules = body.keepRules !== false;
    const existing = getWorkspace().sources.find((s) => s.type === 'verge');
    if (existing) {
      if (body.prefix !== undefined) {
        await updateWorkspace((draft) => {
          const target = draft.sources.find((s) => s.id === existing.id);
          if (target) {
            target.prefix = normalizePrefix(body.prefix, '');
            target.keepRules = keepRules;
          }
        });
      }
      const { value, workspace } = await updateWorkspace((draft) => {
        const target = draft.sources.find((s) => s.id === existing.id)!;
        target.updatedAt = new Date().toISOString();
        target.keepRules = keepRules;
        return applyParsedConfig({
          workspace: draft,
          source: target,
          parsed,
          isRefresh: true,
          keepRules,
        });
      });
      await recordHistory('从 Verge 重新导入', 'manual', `已更新 ${value.changed} 个节点，新增 ${value.added} 个`);
      return {
        ...buildImportSummary(workspace, value),
        removed: value.removed,
        changed: value.changed,
      } satisfies RefreshSummary;
    }
    const source: Source = {
      id: randomUUID(),
      type: 'verge',
      name: normalizeSourceName(body.name, profile.name),
      prefix: normalizePrefix(body.prefix, ''),
      keepRules,
      updatedAt: new Date().toISOString(),
      note: profile.filePath,
    };
    return importParsed(source, parsed, keepRules, '从 Verge 当前配置导入');
  });

  app.patch('/api/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; prefix?: string; keepRules?: boolean };
    const { workspace } = await updateWorkspace((draft) => {
      const source = draft.sources.find((s) => s.id === id);
      if (!source) throw new HttpError(404, '来源不存在');
      if (body.name !== undefined) source.name = normalizeSourceName(body.name, source.name);
      if (body.prefix !== undefined) source.prefix = normalizePrefix(body.prefix, '');
      if (typeof body.keepRules === 'boolean') source.keepRules = body.keepRules;
    });
    return { workspace };
  });

  app.post('/api/sources/:id/refresh', async (request) => {
    const { id } = request.params as { id: string };
    const source = getWorkspace().sources.find((s) => s.id === id);
    if (!source) throw new HttpError(404, '来源不存在');
    let content = '';
    let userinfo: Source['userinfo'];
    if (source.type === 'subscription') {
      if (!source.url) throw new HttpError(400, '该订阅没有可刷新的地址');
      let fetched;
      try {
        fetched = await fetchUrl(source.url, fetchOptions(30_000));
      } catch (error) {
        throw new HttpError(502, (error as Error).message);
      }
      content = fetched.text;
      userinfo = parseSubscriptionUserinfo(fetched.headers['subscription-userinfo']);
    } else if (source.type === 'verge') {
      const profile = await getActiveProfile();
      if (!profile) throw new HttpError(404, '未找到 Clash Verge 当前配置文件');
      content = await fsp.readFile(profile.filePath, 'utf8');
    } else {
      throw new HttpError(400, '该来源不支持刷新，请重新导入');
    }
    let parsed: ParsedConfig;
    try {
      parsed = parseConfigText(content);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const { value, workspace } = await updateWorkspace((draft) => {
      const target = draft.sources.find((s) => s.id === id)!;
      target.updatedAt = new Date().toISOString();
      if (userinfo) target.userinfo = userinfo;
      return applyParsedConfig({
        workspace: draft,
        source: target,
        parsed,
        isRefresh: true,
        keepRules: target.keepRules,
      });
    });
    await recordHistory(`刷新来源 · ${source.name}`, 'manual', `新增 ${value.added}，消失 ${value.removed}，变化 ${value.changed}`);
    return {
      ...buildImportSummary(workspace, value),
      removed: value.removed,
      changed: value.changed,
    } satisfies RefreshSummary;
  });

  app.delete('/api/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { value, workspace } = await updateWorkspace((draft) => {
      const source = draft.sources.find((s) => s.id === id);
      if (!source) throw new HttpError(404, '来源不存在');
      draft.sources = draft.sources.filter((s) => s.id !== id);
      draft.nodes = draft.nodes.filter((n) => n.sourceId !== id);
      draft.routes = draft.routes.filter((r) => r.sourceId !== id);
      const sourceExits = draft.exits.filter((e) => e.sourceId === id);
      const referenced = new Set<string>([
        ...draft.routes.map((r) => r.exitId),
        ...draft.exits.flatMap((e) => e.members.filter((m) => m.by === 'exit').map((m) => m.value)),
      ]);
      let removedExits = 0;
      for (const exit of sourceExits) {
        if (referenced.has(exit.id)) {
          exit.sourceId = undefined;
        } else {
          draft.exits = draft.exits.filter((e) => e.id !== exit.id);
          removedExits += 1;
        }
      }
      return { name: source.name, nodes: sourceExits.length, exits: removedExits };
    });
    await recordHistory(`删除来源 · ${value.name}`, 'manual', '已移除来源节点、来源规则与未被引用的出口');
    return { workspace };
  });

  app.post('/api/chains', async (request) => {
    const body = request.body as { relayNodeId?: string; landingNodeId?: string; name?: string };
    const relayNodeId = requireString(body.relayNodeId, '中转节点', 120);
    const landingNodeId = requireString(body.landingNodeId, '落地节点', 120);
    const requestedName = requireString(body.name, '节点名称', 120).trim();
    if (relayNodeId === landingNodeId) throw new HttpError(400, '中转和落地不能是同一个节点');
    if (/[\r\n,]/.test(requestedName)) throw new HttpError(400, '节点名称不能包含换行或逗号');
    const { value, workspace } = await updateWorkspace((draft) => {
      const relay = draft.nodes.find((node) => node.id === relayNodeId);
      const landing = draft.nodes.find((node) => node.id === landingNodeId);
      if (!relay || !landing) throw new HttpError(404, '节点不存在');
      if (relay.chain || landing.chain) throw new HttpError(400, '链式节点不能再次作为中转或落地');
      if (!relay.enabled) throw new HttpError(400, '中转节点已禁用');
      if (!landing.enabled) throw new HttpError(400, '落地节点已禁用');
      const sourcesById = new Map(draft.sources.map((source) => [source.id, source]));
      const duplicate = draft.nodes.some(
        (node) =>
          nodeDisplayName(node, sourcesById.get(node.sourceId)).toLowerCase() === requestedName.toLowerCase(),
      );
      if (duplicate) throw new HttpError(400, `节点名「${requestedName}」已存在`);
      if (draft.exits.some((exit) => exit.name.toLowerCase() === requestedName.toLowerCase())) {
        throw new HttpError(400, `节点名「${requestedName}」与出口重名`);
      }
      if (['DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE', 'REJECT-DROP'].includes(requestedName.toUpperCase())) {
        throw new HttpError(400, `节点名「${requestedName}」与内置出站冲突`);
      }
      const relayName = nodeDisplayName(relay, sourcesById.get(relay.sourceId));
      const landingName = nodeDisplayName(landing, sourcesById.get(landing.sourceId));
      let chainSource = draft.sources.find((source) => source.type === 'chain');
      if (!chainSource) {
        chainSource = {
          id: randomUUID(),
          type: 'chain',
          name: '链式代理',
          prefix: '',
          keepRules: false,
          updatedAt: new Date().toISOString(),
          note: '由链路编辑器生成',
        };
        draft.sources.push(chainSource);
      }
      const raw = structuredClone(landing.raw) as Record<string, unknown>;
      raw.name = requestedName;
      raw['dialer-proxy'] = relayName;
      const node: ProxyNode = {
        id: randomUUID(),
        sourceId: chainSource.id,
        name: requestedName,
        raw,
        tags: ['链式'],
        enabled: true,
        addedAt: new Date().toISOString(),
        chain: { relayNodeId, landingNodeId },
      };
      draft.nodes.push(node);
      return { nodeId: node.id, relayName, landingName };
    });
    await recordHistory(`链式代理 · ${requestedName}`, 'manual', `${value.relayName} → ${value.landingName}`);
    return { workspace, nodeId: value.nodeId };
  });

  app.delete('/api/chains/:nodeId', async (request) => {
    const { nodeId } = request.params as { nodeId: string };
    const { value, workspace } = await updateWorkspace((draft) => {
      const node = draft.nodes.find((item) => item.id === nodeId && item.chain);
      if (!node) throw new HttpError(404, '链路节点不存在');
      const sourceId = node.sourceId;
      const removedRoutes = draft.routes.filter(
        (route) => route.kind === 'rule' && route.targetNodeId === nodeId,
      ).length;
      draft.nodes = draft.nodes.filter((item) => item.id !== nodeId);
      draft.routes = draft.routes.filter(
        (route) => !(route.kind === 'rule' && route.targetNodeId === nodeId),
      );
      const source = draft.sources.find((item) => item.id === sourceId && item.type === 'chain');
      if (source && !draft.nodes.some((item) => item.sourceId === sourceId)) {
        draft.sources = draft.sources.filter((item) => item.id !== sourceId);
      }
      return { name: node.name, removedRoutes };
    });
    await recordHistory(`删除链路 · ${value.name}`, 'manual', `同时移除 ${value.removedRoutes} 条目标规则`);
    return { workspace, removedRoutes: value.removedRoutes };
  });

  app.patch('/api/nodes/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; tags?: string[]; region?: string; enabled?: boolean };
    const { workspace } = await updateWorkspace((draft) => {
      const node = draft.nodes.find((n) => n.id === id);
      if (!node) throw new HttpError(404, '节点不存在');
      if (body.name !== undefined) node.name = requireString(body.name, '节点名称', 120);
      if (Array.isArray(body.tags)) {
        node.tags = [...new Set(body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))];
      }
      if (body.region !== undefined) node.region = typeof body.region === 'string' && body.region.trim() ? body.region.trim() : undefined;
      if (typeof body.enabled === 'boolean') node.enabled = body.enabled;
      node.updatedAt = new Date().toISOString();
    });
    return { workspace };
  });

  app.post('/api/nodes/bulk', async (request) => {
    const body = request.body as { ids?: string[]; enabled?: boolean; addTags?: string[] };
    if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, '请选择节点');
    const ids = new Set(body.ids.filter((v): v is string => typeof v === 'string'));
    const addTags = Array.isArray(body.addTags)
      ? [...new Set(body.addTags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
      : [];
    const { workspace } = await updateWorkspace((draft) => {
      for (const node of draft.nodes) {
        if (!ids.has(node.id)) continue;
        if (typeof body.enabled === 'boolean') node.enabled = body.enabled;
        if (addTags.length) node.tags = [...new Set([...node.tags, ...addTags])];
        node.updatedAt = new Date().toISOString();
      }
    });
    return { workspace };
  });

  app.post('/api/rule-sets/inspect', async (request) => {
    const body = request.body as { url?: string; fileName?: string; dataBase64?: string };
    if (body.url) {
      const url = validateHttpUrl(body.url);
      let fetched;
      try {
        fetched = await fetchUrl(url, fetchOptions(20_000));
      } catch (error) {
        throw new HttpError(502, (error as Error).message);
      }
      if (fetched.buffer.length > 20 * 1024 * 1024) throw new HttpError(413, '规则集文件过大');
      const inspect = inspectRuleSetBuffer(fetched.buffer, { url });
      return { ...inspect, sourceValue: url };
    }
    if (typeof body.dataBase64 === 'string' && body.dataBase64) {
      const base64 = body.dataBase64.replace(/^data:[^;]*;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length) throw new HttpError(400, '文件内容为空');
      if (buffer.length > 10 * 1024 * 1024) throw new HttpError(413, '文件过大（上限 10MB）');
      const fileName = sanitizeFileName(body.fileName ?? 'ruleset.txt');
      const storedPath = await storeRuleSetFile(buffer, fileName);
      const inspect = inspectRuleSetBuffer(buffer, { fileName });
      return {
        ...inspect,
        sourceType: 'file',
        sourceValue: storedPath,
        storedPath,
        fileName,
      } satisfies RuleSetInspect;
    }
    throw new HttpError(400, '请提供规则集地址或文件');
  });

  app.post('/api/rule-sets/create', async (request) => {
    const body = request.body as RuleSetCreateBody;
    const name = requireString(body.name, '规则集名称', 80);
    const behavior = body.behavior;
    const format = body.format;
    if (!['domain', 'ipcidr', 'classical'].includes(behavior)) throw new HttpError(400, 'behavior 无效');
    if (!['yaml', 'text', 'mrs'].includes(format)) throw new HttpError(400, 'format 无效');
    const exitId = requireString(body.exitId, '出口', 80);
    if (!getWorkspace().exits.some((e) => e.id === exitId)) throw new HttpError(400, '目标出口不存在');
    let buffer: Buffer;
    let sourceValue: string;
    let sourceFileName: string | undefined;
    let sourceType: 'url' | 'file';
    if (body.sourceType === 'url') {
      const url = validateHttpUrl(body.url);
      let fetched;
      try {
        fetched = await fetchUrl(url, fetchOptions(20_000));
      } catch (error) {
        throw new HttpError(502, (error as Error).message);
      }
      buffer = fetched.buffer;
      sourceValue = url;
      sourceType = 'url';
    } else {
      const filePath = requireString(body.filePath, '规则集文件', 512);
      if (!isPathInside(RULE_SETS_DIR, filePath)) throw new HttpError(400, '规则集文件路径无效');
      if (!(await fileExists(filePath))) throw new HttpError(404, '规则集文件不存在');
      buffer = await fsp.readFile(filePath);
      sourceValue = filePath;
      sourceType = 'file';
      sourceFileName = body.fileName ?? path.basename(filePath);
    }
    if (buffer.length > 20 * 1024 * 1024) throw new HttpError(413, '规则集文件过大');

    let inlineRules: InlineRule[] | undefined;
    if (body.inline) {
      if (format === 'mrs') throw new HttpError(400, 'MRS 是二进制格式，不能内联展开');
      let expanded: InlineRule[];
      try {
        expanded = expandRuleset(buffer, behavior, format);
      } catch (error) {
        throw new HttpError(422, (error as Error).message);
      }
      if (!expanded.length) throw new HttpError(422, '规则集内容为空或格式无法识别');
      if (expanded.length > 500) throw new HttpError(422, `内联规则过多（${expanded.length} 条），请改用 provider`);
      inlineRules = expanded;
    }
    const inspect = inspectRuleSetBuffer(buffer, {
      fileName: sourceFileName,
      url: sourceType === 'url' ? sourceValue : undefined,
    });
    const route: RuleSetRoute = {
      id: randomUUID(),
      kind: 'ruleset',
      name,
      behavior,
      format,
      source: {
        type: sourceType,
        value: sourceValue,
        fileName: sourceFileName,
        size: buffer.length,
      },
      inline: body.inline,
      inlineRules,
      ruleCount: inspect.ruleCount ?? inlineRules?.length,
      exitId,
      enabled: true,
      interval: typeof body.interval === 'number' ? Math.max(60, Math.round(body.interval)) : 86400,
      updatedAt: new Date().toISOString(),
      origin: 'manual',
    };
    const { workspace } = await updateWorkspace((draft) => {
      draft.routes = insertRouteOrdered(draft.routes, route);
    });
    await recordHistory(`添加规则集 · ${name}`, 'manual', inspect.ruleCount ? `${inspect.ruleCount} 条规则` : '二进制规则集');
    return { workspace, route };
  });

  app.post('/api/rule-sets/create-batch', async (request) => {
    const body = request.body as {
      items?: Array<{
        name?: string;
        providerName?: string;
        url?: string;
        behavior?: RulesetBehavior;
        format?: RulesetFormat;
      }>;
      exitId?: string;
      interval?: number;
    };
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, '请选择要添加的规则集');
    if (body.items.length > 80) throw new HttpError(400, '一次最多添加 80 个规则集');
    const exitId = requireString(body.exitId, '出口', 80);
    if (!getWorkspace().exits.some((exit) => exit.id === exitId)) throw new HttpError(400, '目标出口不存在');
    const urlSlug = (value: string): string => {
      try {
        const segment = new URL(value).pathname.split('/').filter(Boolean).pop() ?? '';
        return segment.replace(/\.mrs$/i, '').toLowerCase();
      } catch {
        return '';
      }
    };
    const items = body.items.map((item) => {
      const name = requireString(item.name, '规则集名称', 80);
      const url = validateHttpUrl(item.url);
      const behavior = item.behavior;
      const format = item.format ?? 'mrs';
      if (!['domain', 'ipcidr', 'classical'].includes(behavior as string)) throw new HttpError(400, '规则集 behavior 无效');
      if (!['mrs', 'yaml', 'text'].includes(format)) throw new HttpError(400, '规则集 format 无效');
      const providerName = typeof item.providerName === 'string' && item.providerName.trim()
        ? item.providerName.trim().slice(0, 80)
        : urlSlug(url) || name;
      return { name, providerName, url, behavior: behavior as RulesetBehavior, format };
    });
    const interval = typeof body.interval === 'number' ? Math.max(60, Math.round(body.interval)) : 86400;
    const now = new Date().toISOString();
    const skipped: string[] = [];
    const { value, workspace } = await updateWorkspace((draft) => {
      const existingProvider = new Set(
        draft.routes
          .filter((route): route is RuleSetRoute => route.kind === 'ruleset')
          .map((route) => (route.providerName || route.name).toLowerCase()),
      );
      const existingSlugs = new Set(
        draft.routes
          .filter((route): route is RuleSetRoute => route.kind === 'ruleset' && route.source.type === 'url')
          .map((route) => urlSlug(route.source.value))
          .filter(Boolean),
      );
      const created: string[] = [];
      for (const item of items) {
        const providerKey = item.providerName.toLowerCase();
        const slug = urlSlug(item.url);
        if (existingProvider.has(providerKey) || (slug && existingSlugs.has(slug))) {
          skipped.push(item.name);
          continue;
        }
        existingProvider.add(providerKey);
        if (slug) existingSlugs.add(slug);
        const route: RuleSetRoute = {
          id: randomUUID(),
          kind: 'ruleset',
          name: item.name,
          providerName: item.providerName,
          behavior: item.behavior,
          format: item.format,
          source: { type: 'url', value: item.url },
          inline: false,
          exitId,
          enabled: true,
          interval,
          updatedAt: now,
          origin: 'catalog',
        };
        draft.routes = insertRouteOrdered(draft.routes, route);
        created.push(route.id);
      }
      return created;
    });
    if (value.length) {
      await recordHistory(
        '添加内置规则集',
        'manual',
        `新增 ${value.length} 个规则集${skipped.length ? `，已存在 ${skipped.length} 个` : ''}`,
      );
    }
    return { workspace, added: value.length, skipped };
  });

  app.post('/api/rule-sets/:id/refresh', async (request) => {
    const { id } = request.params as { id: string };
    const current = getWorkspace().routes.find((r): r is RuleSetRoute => r.kind === 'ruleset' && r.id === id);
    if (!current) throw new HttpError(404, '规则集不存在');
    let buffer: Buffer;
    if (current.source.type === 'url') {
      let fetched;
      try {
        fetched = await fetchUrl(current.source.value, fetchOptions(20_000));
      } catch (error) {
        throw new HttpError(502, (error as Error).message);
      }
      buffer = fetched.buffer;
    } else {
      if (!isPathInside(RULE_SETS_DIR, current.source.value)) throw new HttpError(400, '规则集文件路径无效');
      try {
        buffer = await fsp.readFile(current.source.value);
      } catch {
        throw new HttpError(404, '规则集文件不存在');
      }
    }
    const inspect = inspectRuleSetBuffer(buffer, {
      fileName: current.source.fileName,
      url: current.source.type === 'url' ? current.source.value : undefined,
    });
    let inlineRules: InlineRule[] | undefined;
    if (current.inline) {
      inlineRules = expandRuleset(buffer, current.behavior, current.format);
      if (!inlineRules.length) throw new HttpError(422, '规则集内容为空或格式无法识别');
      if (inlineRules.length > 500) throw new HttpError(422, `内联规则过多（${inlineRules.length} 条）`);
    }
    const { value, workspace } = await updateWorkspace((draft) => {
      const route = draft.routes.find((r): r is RuleSetRoute => r.kind === 'ruleset' && r.id === id);
      if (!route) throw new HttpError(404, '规则集不存在');
      route.ruleCount = inspect.ruleCount ?? inlineRules?.length;
      route.inlineRules = inlineRules;
      route.updatedAt = new Date().toISOString();
      route.source.size = buffer.length;
      return route;
    });
    await recordHistory(`刷新规则集 · ${current.name}`, 'manual', inspect.ruleCount ? `${inspect.ruleCount} 条规则` : '已更新');
    return { workspace, route: value };
  });

  app.delete('/api/rule-sets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { workspace } = await updateWorkspace((draft) => {
      draft.routes = draft.routes.filter((r) => !(r.kind === 'ruleset' && r.id === id));
    });
    return { workspace };
  });

  app.get('/api/export/preview', async (): Promise<ExportPreview> => buildPreview(getWorkspace()));

  app.post('/api/export/validate', async () => {
    const preview = await buildPreview(getWorkspace());
    return { validation: await validateConfig(preview.yaml) };
  });

  app.post('/api/export', async (request) => {
    const body = (request.body ?? {}) as { fileName?: unknown };
    return exportConfig(typeof body.fileName === 'string' ? body.fileName : undefined);
  });

  app.get('/api/history', async () => ({ entries: await listHistory() }));

  app.delete('/api/history', async () => ({ cleared: await clearHistory() }));

  app.post('/api/history/snapshot', async (request) => {
    const body = (request.body ?? {}) as { label?: string; note?: string };
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 120)
      : '手动快照';
    const note = typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 400)
      : '用户手动创建的工作区快照';
    const entry = await addHistory({ label, kind: 'manual', note }, getWorkspace());
    return { entry };
  });

  app.get('/api/history/:id/summary', async (request) => {
    const { id } = request.params as { id: string };
    const data = await readHistory(id);
    if (!data) throw new HttpError(404, '历史记录不存在');
    const count = (workspace: Workspace) => ({
      sources: workspace.sources.length,
      nodes: workspace.nodes.length,
      exits: workspace.exits.filter((exit) => !exit.builtin).length,
      rules: workspace.routes.length,
    });
    return { summary: { snapshot: count(data.workspace), current: count(getWorkspace()) } };
  });

  app.get('/api/history/:id/export', async (request) => {
    const { id } = request.params as { id: string };
    const data = await readHistory(id);
    if (!data) throw new HttpError(404, '历史记录不存在');
    const yaml = await readExportForHistory(data.entry);
    if (!yaml) throw new HttpError(404, '该历史记录没有可查看的 YAML 文件');
    return { entry: data.entry, yaml };
  });

  app.post('/api/history/:id/restore', async (request) => {
    const { id } = request.params as { id: string };
    const result = await restoreHistory(id);
    if (!result) throw new HttpError(404, '历史记录不存在');
    return { workspace: result.workspace, undoEntry: result.undoEntry };
  });

  app.get('/api/exits/:id/resolution', async (request) => {
    const { id } = request.params as { id: string };
    const workspace = getWorkspace();
    const exit = workspace.exits.find((e) => e.id === id);
    if (!exit) throw new HttpError(404, '出口不存在');
    const resolution = resolveExit(exit, {
      nodes: workspace.nodes,
      exits: workspace.exits,
      sources: workspace.sources,
    });
    return {
      memberNames: resolution.memberNames,
      nodeIds: resolution.nodes.map((n) => n.id),
      allNodeIds: resolution.allNodeIds,
      missing: resolution.missing,
      displayNames: resolution.nodes.map((n) => nodeDisplayName(n, workspace.sources.find((s) => s.id === n.sourceId))),
    };
  });

  const aggregator = new LiveAggregator(() => getWorkspace().settings.retentionMinutes);
  const wsClients = new Set<WsClient>();

  app.get('/ws/live', { websocket: true }, (socket, request: FastifyRequest) => {
    const origin = request.headers.origin;
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (!originAllowed(origin) || !token || !safeEqual(token, sessionToken)) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const client = socket as unknown as WsClient;
    wsClients.add(client);
    try {
      client.send(JSON.stringify({ type: 'live', data: aggregator.getSnapshot() }));
    } catch {
      wsClients.delete(client);
    }
    client.on('close', () => wsClients.delete(client));
    client.on('error', () => wsClients.delete(client));
  });

  aggregator.start((snapshot) => {
    if (!wsClients.size) return;
    const message = JSON.stringify({ type: 'live', data: snapshot });
    for (const client of wsClients) {
      if (client.readyState !== 1) continue;
      try {
        client.send(message);
      } catch {
        wsClients.delete(client);
      }
    }
  });

  if (fs.existsSync(DIST_DIR)) {
    await app.register(fastifyStatic, { root: DIST_DIR, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return { app, aggregator };
}
