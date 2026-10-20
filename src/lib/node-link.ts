export type ShareNodeType = 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic' | 'socks5';

export interface ParsedShareNode {
  type: ShareNodeType;
  server: string;
  port: number;
  name?: string;
  uuid?: string;
  username?: string;
  password?: string;
  cipher?: string;
  tls: boolean;
  sni?: string;
  network: 'tcp' | 'ws' | 'grpc';
  path?: string;
  host?: string;
  service?: string;
  flow?: string;
  extras: Record<string, unknown>;
  warnings: string[];
}

export class NodeLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeLinkError';
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBase64Text(value: string): string {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new NodeLinkError('链接中的 Base64 数据无法解析');
  }
}

function parseHostPort(value: string): { server: string; port: number } {
  const input = value.trim();
  let host = '';
  let portText = '';
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end < 0) throw new NodeLinkError('节点地址格式不正确');
    host = input.slice(1, end);
    portText = input.slice(end + 1).replace(/^:/, '');
  } else {
    const colon = input.lastIndexOf(':');
    if (colon <= 0) throw new NodeLinkError('节点地址缺少端口');
    host = input.slice(0, colon);
    portText = input.slice(colon + 1);
  }
  const port = Number(portText);
  if (!host.trim()) throw new NodeLinkError('节点地址为空');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NodeLinkError('节点端口无效');
  return { server: host.trim(), port };
}

function parsePortFromUrl(url: URL): number {
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NodeLinkError('节点链接缺少有效端口');
  }
  return port;
}

function fragmentName(url: URL): string | undefined {
  const name = safeDecode(url.hash.replace(/^#/, '')).trim();
  return name || undefined;
}

function buildName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNetwork(value: string | null, warnings: string[]): 'tcp' | 'ws' | 'grpc' {
  const network = (value ?? 'tcp').toLowerCase();
  if (network === 'ws' || network === 'websocket') return 'ws';
  if (network === 'grpc') return 'grpc';
  if (network && network !== 'tcp' && network !== 'none') {
    warnings.push(`传输方式 ${network} 暂不在手动表单中，已按 TCP 填充，请核对配置。`);
  }
  return 'tcp';
}

function isEnabled(value: string | null): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function realityExtras(url: URL): { extras: Record<string, unknown>; warnings: string[] } {
  const extras: Record<string, unknown> = {};
  const warnings: string[] = [];
  const publicKey = url.searchParams.get('pbk');
  const shortId = url.searchParams.get('sid');
  const fingerprint = url.searchParams.get('fp');
  extras['reality-opts'] = {
    ...(publicKey ? { 'public-key': publicKey } : {}),
    ...(shortId ? { 'short-id': shortId } : {}),
  };
  extras['client-fingerprint'] = fingerprint || 'chrome';
  if (!publicKey) warnings.push('Reality 链接缺少 public-key，导入后需要在节点配置中补充。');
  return { extras, warnings };
}

function parseShadowsocks(text: string): ParsedShareNode {
  const body = text.slice('ss://'.length);
  const hashIndex = body.indexOf('#');
  const name = hashIndex >= 0 ? safeDecode(body.slice(hashIndex + 1)) || undefined : undefined;
  let main = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
  const queryIndex = main.indexOf('?');
  const query = queryIndex >= 0 ? new URLSearchParams(main.slice(queryIndex + 1)) : null;
  main = queryIndex >= 0 ? main.slice(0, queryIndex) : main;

  const at = main.lastIndexOf('@');
  let userPart = '';
  let hostPart = '';
  if (at >= 0) {
    userPart = main.slice(0, at);
    hostPart = main.slice(at + 1);
  } else {
    const decoded = decodeBase64Text(main);
    const decodedAt = decoded.lastIndexOf('@');
    if (decodedAt < 0) throw new NodeLinkError('Shadowsocks 链接缺少节点地址');
    userPart = decoded.slice(0, decodedAt);
    hostPart = decoded.slice(decodedAt + 1);
  }

  let cipher = '';
  let password = '';
  const decodedUserPart = safeDecode(userPart);
  if (decodedUserPart.includes(':')) {
    const colon = decodedUserPart.indexOf(':');
    cipher = decodedUserPart.slice(0, colon);
    password = decodedUserPart.slice(colon + 1);
  } else {
    const decoded = decodeBase64Text(decodedUserPart);
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new NodeLinkError('Shadowsocks 用户信息格式不正确');
    cipher = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
  }
  const { server, port } = parseHostPort(hostPart);
  if (!cipher || !password) throw new NodeLinkError('Shadowsocks 链接缺少加密方式或密码');

  const warnings: string[] = [];
  const extras: Record<string, unknown> = {};
  if (query?.get('plugin')) {
    warnings.push('链接包含 Shadowsocks 插件参数；基本连接信息已填充，插件请使用 YAML 粘贴导入。');
  }

  return {
    type: 'ss',
    name,
    server,
    port,
    cipher,
    password,
    tls: false,
    network: 'tcp',
    extras,
    warnings,
  };
}

function parseSsr(text: string): ParsedShareNode {
  const payload = text.slice('ssr://'.length).split('#')[0].trim();
  const decoded = decodeBase64Text(payload);
  const [main, queryText] = decoded.split('/?');
  const parts = (main ?? '').split(':');
  if (parts.length < 6) throw new NodeLinkError('SSR 链接字段不完整');
  const [server, portText, protocol, cipher, obfs, encodedPassword] = parts;
  const port = Number(portText);
  if (!server?.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NodeLinkError('SSR 链接缺少有效的服务器或端口');
  }
  if (!cipher || !encodedPassword) throw new NodeLinkError('SSR 链接缺少加密方式或密码');
  const query = new URLSearchParams(queryText ?? '');
  const decodeParam = (name: string): string | undefined => {
    const raw = query.get(name);
    if (!raw) return undefined;
    try {
      return decodeBase64Text(raw);
    } catch {
      return raw;
    }
  };
  const extras: Record<string, unknown> = {
    protocol: protocol || 'origin',
    obfs: obfs || 'plain',
  };
  const protocolParam = decodeParam('protoparam');
  const obfsParam = decodeParam('obfsparam');
  if (protocolParam) extras['protocol-param'] = protocolParam;
  if (obfsParam) extras['obfs-param'] = obfsParam;
  return {
    type: 'ssr',
    name: decodeParam('remarks'),
    server: server.trim(),
    port,
    cipher,
    password: decodeBase64Text(encodedPassword),
    tls: false,
    network: 'tcp',
    extras,
    warnings: [],
  };
}

function parseSocks5(text: string): ParsedShareNode {
  let url: URL;
  try {
    url = new URL(text.replace(/^socks:\/\//i, 'socks5://'));
  } catch {
    throw new NodeLinkError('SOCKS5 链接格式不正确');
  }
  const server = url.hostname.replace(/^\[|\]$/g, '');
  if (!server) throw new NodeLinkError('SOCKS5 链接缺少服务器地址');
  const port = parsePortFromUrl(url);
  return {
    type: 'socks5',
    name: fragmentName(url),
    server,
    port,
    username: safeDecode(url.username) || undefined,
    password: safeDecode(url.password) || undefined,
    tls: false,
    network: 'tcp',
    extras: {},
    warnings: [],
  };
}

function parseVmess(text: string): ParsedShareNode {
  const payload = text.slice('vmess://'.length).split('#')[0];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(decodeBase64Text(payload)) as Record<string, unknown>;
  } catch {
    throw new NodeLinkError('VMess 链接内容无法解析，请确认链接完整');
  }
  const server = typeof json.add === 'string' ? json.add.trim() : '';
  const port = Number(json.port);
  const uuid = typeof json.id === 'string' ? json.id.trim() : '';
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NodeLinkError('VMess 链接缺少有效的服务器或端口');
  }
  if (!uuid) throw new NodeLinkError('VMess 链接缺少 UUID');
  const warnings: string[] = [];
  const network = readNetwork(typeof json.net === 'string' ? json.net : null, warnings);
  const path = typeof json.path === 'string' ? json.path : undefined;
  const host = typeof json.host === 'string' ? json.host : undefined;
  const tls = String(json.tls ?? '').toLowerCase() === 'tls';
  const serializedType = typeof json.type === 'string' ? json.type.toLowerCase() : '';
  if (serializedType && serializedType !== 'none') {
    warnings.push(`VMess 头部类型 ${json.type} 未在表单中展示，已忽略。`);
  }
  const extras: Record<string, unknown> = {};
  const alterId = Number(json.aid ?? 0);
  if (Number.isFinite(alterId) && alterId > 0) extras.alterId = alterId;

  return {
    type: 'vmess',
    name: buildName(json.ps),
    server,
    port,
    uuid,
    tls,
    sni: typeof json.sni === 'string' && json.sni ? json.sni : undefined,
    network,
    path: network === 'ws' ? path || '/' : undefined,
    host: network === 'ws' ? host : undefined,
    service: network === 'grpc' ? path : undefined,
    extras,
    warnings,
  };
}

function parseUrlNode(
  text: string,
  type: 'vless' | 'trojan' | 'hysteria2' | 'tuic',
): ParsedShareNode {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new NodeLinkError('节点链接格式不正确');
  }
  const server = url.hostname.replace(/^\[|\]$/g, '');
  if (!server) throw new NodeLinkError('节点链接缺少服务器地址');
  const port = parsePortFromUrl(url);
  const warnings: string[] = [];
  const uuid = safeDecode(url.username);
  const password = safeDecode(url.password);
  const sni =
    url.searchParams.get('sni') ??
    url.searchParams.get('servername') ??
    url.searchParams.get('peer') ??
    undefined;
  const security = (url.searchParams.get('security') ?? '').toLowerCase();
  const extra: Record<string, unknown> = {};
  if (isEnabled(url.searchParams.get('allowInsecure')) || isEnabled(url.searchParams.get('insecure'))) {
    extra['skip-cert-verify'] = true;
  }

  if (type === 'vless') {
    if (!uuid) throw new NodeLinkError('VLESS 链接缺少 UUID');
    const network = readNetwork(url.searchParams.get('type'), warnings);
    const tls = security === 'tls' || security === 'reality';
    if (security === 'reality') {
      const reality = realityExtras(url);
      Object.assign(extra, reality.extras);
      warnings.push(...reality.warnings);
    }
    return {
      type,
      name: fragmentName(url),
      server,
      port,
      uuid,
      tls,
      sni,
      network,
      path: network === 'ws' ? url.searchParams.get('path') || '/' : undefined,
      host: network === 'ws' ? url.searchParams.get('host') ?? undefined : undefined,
      service:
        network === 'grpc'
          ? url.searchParams.get('serviceName') ?? url.searchParams.get('service') ?? undefined
          : undefined,
      flow: url.searchParams.get('flow') ?? undefined,
      extras: extra,
      warnings,
    };
  }

  if (type === 'trojan') {
    const passwordValue = password ? `${uuid}:${password}` : uuid;
    if (!passwordValue) throw new NodeLinkError('Trojan 链接缺少密码');
    const network = readNetwork(url.searchParams.get('type'), warnings);
    return {
      type,
      name: fragmentName(url),
      server,
      port,
      password: passwordValue,
      tls: security !== 'none',
      sni,
      network,
      path: network === 'ws' ? url.searchParams.get('path') || '/' : undefined,
      host: network === 'ws' ? url.searchParams.get('host') ?? undefined : undefined,
      service:
        network === 'grpc'
          ? url.searchParams.get('serviceName') ?? url.searchParams.get('service') ?? undefined
          : undefined,
      extras: extra,
      warnings,
    };
  }

  if (type === 'hysteria2') {
    const passwordValue = password ? `${uuid}:${password}` : uuid;
    if (!passwordValue) throw new NodeLinkError('Hysteria2 链接缺少认证密码');
    const obfs = url.searchParams.get('obfs');
    if (obfs) {
      extra.obfs = obfs;
      const obfsPassword = url.searchParams.get('obfs-password');
      if (obfsPassword) extra['obfs-password'] = obfsPassword;
      else warnings.push('Hysteria2 启用了 obfs，但链接没有提供 obfs-password。');
    }
    if (url.searchParams.get('mport') || url.searchParams.get('ports')) {
      warnings.push('链接包含端口跳跃参数，表单仅保留单一端口。');
    }
    return {
      type,
      name: fragmentName(url),
      server,
      port,
      password: passwordValue,
      tls: true,
      sni,
      network: 'tcp',
      extras: extra,
      warnings,
    };
  }

  if (!uuid) throw new NodeLinkError('TUIC 链接缺少 UUID');
  if (!password) throw new NodeLinkError('TUIC 链接缺少密码');
  return {
    type,
    name: fragmentName(url),
    server,
    port,
    uuid,
    password,
    tls: true,
    sni,
    network: 'tcp',
    extras: extra,
    warnings,
  };
}

export function parseShareLink(input: string): ParsedShareNode {
  const text = input.trim().replace(/^['"]|['"]$/g, '');
  if (!text) throw new NodeLinkError('请粘贴节点分享链接');
  if (/[\r\n]/.test(text)) throw new NodeLinkError('一次只能识别一个节点链接');
  if (/\s/.test(text.split('#')[0])) throw new NodeLinkError('链接中间含有空白字符，请检查是否被换行截断');
  const lower = text.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    throw new NodeLinkError('这是订阅或网页链接，请切换到「订阅」标签导入');
  }
  if (lower.startsWith('ssr://')) return parseSsr(text);
  if (lower.startsWith('ss://')) return parseShadowsocks(text);
  if (lower.startsWith('vmess://')) return parseVmess(text);
  if (lower.startsWith('vless://')) return parseUrlNode(text, 'vless');
  if (lower.startsWith('trojan://')) return parseUrlNode(text, 'trojan');
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) {
    return parseUrlNode(text.replace(/^hy2:\/\//i, 'hysteria2://'), 'hysteria2');
  }
  if (lower.startsWith('tuic://')) return parseUrlNode(text, 'tuic');
  if (lower.startsWith('socks5://') || lower.startsWith('socks://')) return parseSocks5(text);
  throw new NodeLinkError('暂不支持该链接协议；支持 ss / ssr / vmess / vless / trojan / hysteria2 / tuic / socks5');
}

export function shareNodeDisplayName(node: ParsedShareNode): string {
  return node.name || `${node.type.toUpperCase()} ${node.server}`;
}

export function shareNodeToProxy(node: ParsedShareNode): Record<string, unknown> {
  const proxy: Record<string, unknown> = {
    ...node.extras,
    name: shareNodeDisplayName(node),
    type: node.type,
    server: node.server,
    port: node.port,
  };

  if (node.type === 'ss') {
    proxy.cipher = node.cipher;
    proxy.password = node.password;
  } else if (node.type === 'ssr') {
    proxy.cipher = node.cipher;
    proxy.password = node.password;
  } else if (node.type === 'socks5') {
    if (node.username) proxy.username = node.username;
    if (node.password) proxy.password = node.password;
  } else if (node.type === 'vmess') {
    proxy.uuid = node.uuid;
    proxy.cipher = 'auto';
  } else if (node.type === 'vless') {
    proxy.uuid = node.uuid;
    if (node.flow) proxy.flow = node.flow;
  } else if (node.type === 'trojan') {
    proxy.password = node.password;
  } else if (node.type === 'hysteria2') {
    proxy.password = node.password;
  } else if (node.type === 'tuic') {
    proxy.uuid = node.uuid;
    proxy.password = node.password;
  }

  if (node.type !== 'ss' && node.type !== 'ssr' && node.type !== 'socks5' && node.tls) proxy.tls = true;
  if (node.sni) {
    if (node.type === 'hysteria2' || node.type === 'tuic') proxy.sni = node.sni;
    else if (node.type !== 'ss' && node.type !== 'ssr' && node.type !== 'socks5') proxy.servername = node.sni;
  }

  if (node.type !== 'hysteria2' && node.type !== 'tuic' && node.network !== 'tcp') {
    proxy.network = node.network;
    if (node.network === 'ws') {
      proxy['ws-opts'] = {
        path: node.path || '/',
        ...(node.host ? { headers: { Host: node.host } } : {}),
      };
    }
    if (node.network === 'grpc') {
      proxy['grpc-opts'] = { 'grpc-service-name': node.service || '' };
    }
  }
  return proxy;
}
