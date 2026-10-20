import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeLinkError, parseShareLink } from '../../src/lib/node-link';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

test('parses Shadowsocks SIP002 and legacy links', () => {
  const sip = parseShareLink(`ss://${b64('aes-256-gcm:pass:word')}@example.com:8388#%F0%9F%87%AF%F0%9F%87%B5%20JP`);
  assert.equal(sip.type, 'ss');
  assert.equal(sip.cipher, 'aes-256-gcm');
  assert.equal(sip.password, 'pass:word');
  assert.equal(sip.server, 'example.com');
  assert.equal(sip.port, 8388);
  assert.equal(sip.name, '🇯🇵 JP');

  const legacy = parseShareLink(`ss://${b64('chacha20-ietf-poly1305:pw@legacy.example:443')}#Legacy`);
  assert.equal(legacy.cipher, 'chacha20-ietf-poly1305');
  assert.equal(legacy.server, 'legacy.example');
  assert.equal(legacy.port, 443);
});

test('parses VMess JSON links', () => {
  const payload = b64(JSON.stringify({
    v: '2', ps: 'Tokyo', add: 'vm.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555',
    aid: '0', scy: 'auto', net: 'ws', host: 'cdn.example.com', path: '/ws', tls: 'tls', sni: 'edge.example.com',
  }));
  const node = parseShareLink(`vmess://${payload}`);
  assert.equal(node.type, 'vmess');
  assert.equal(node.name, 'Tokyo');
  assert.equal(node.server, 'vm.example.com');
  assert.equal(node.network, 'ws');
  assert.equal(node.path, '/ws');
  assert.equal(node.host, 'cdn.example.com');
  assert.equal(node.tls, true);
  assert.equal(node.sni, 'edge.example.com');
});

test('parses VLESS with Reality, Trojan, Hysteria2 and TUIC', () => {
  const vless = parseShareLink('vless://11111111-2222-3333-4444-555555555555@vless.example:443?security=reality&type=grpc&serviceName=svc&sni=front.example&pbk=public&sid=abcd&fp=chrome&flow=xtls-rprx-vision#V');
  assert.equal(vless.type, 'vless');
  assert.equal(vless.network, 'grpc');
  assert.equal(vless.service, 'svc');
  assert.equal(vless.flow, 'xtls-rprx-vision');
  assert.equal(vless.tls, true);
  assert.deepEqual(vless.extras['reality-opts'], { 'public-key': 'public', 'short-id': 'abcd' });

  const trojan = parseShareLink('trojan://secret@trojan.example:443?type=ws&path=%2Fws&host=cdn.example&sni=front.example#T');
  assert.equal(trojan.type, 'trojan');
  assert.equal(trojan.password, 'secret');
  assert.equal(trojan.network, 'ws');
  assert.equal(trojan.path, '/ws');
  assert.equal(trojan.tls, true);
  assert.equal(trojan.sni, 'front.example');

  const hy2 = parseShareLink('hysteria2://auth@hy.example:8443?sni=front.example&insecure=1&obfs=salamander&obfs-password=secret#H');
  assert.equal(hy2.type, 'hysteria2');
  assert.equal(hy2.password, 'auth');
  assert.equal(hy2.port, 8443);
  assert.equal(hy2.extras['skip-cert-verify'], true);
  assert.equal(hy2.extras.obfs, 'salamander');

  const tuic = parseShareLink('tuic://uuid-value:pass@tuic.example:443?sni=front.example#U');
  assert.equal(tuic.type, 'tuic');
  assert.equal(tuic.uuid, 'uuid-value');
  assert.equal(tuic.password, 'pass');
  assert.equal(tuic.tls, true);
});

test('rejects unsupported or invalid links', () => {
  assert.throws(() => parseShareLink('https://example.com/sub'), NodeLinkError);
  assert.throws(() => parseShareLink('socks5://host:1080'), NodeLinkError);
  assert.throws(() => parseShareLink('vmess://not-base64'), NodeLinkError);
  assert.throws(() => parseShareLink('ss://bad'), NodeLinkError);
});

test('builds Clash proxy payloads from parsed links', async () => {
  const { shareNodeToProxy } = await import('../../src/lib/node-link');
  const vless = parseShareLink('vless://uuid@vless.example:443?security=reality&type=grpc&serviceName=svc&sni=front.example&pbk=public&sid=abcd#Node');
  const proxy = shareNodeToProxy(vless);
  assert.equal(proxy.name, 'Node');
  assert.equal(proxy.type, 'vless');
  assert.equal(proxy['reality-opts'] && (proxy['reality-opts'] as Record<string, unknown>)['public-key'], 'public');
  assert.deepEqual(proxy['grpc-opts'], { 'grpc-service-name': 'svc' });
  assert.equal(proxy.servername, 'front.example');

  const hy2 = shareNodeToProxy(parseShareLink('hysteria2://auth@hy.example:8443?sni=front.example#H'));
  assert.equal(hy2.type, 'hysteria2');
  assert.equal(hy2.password, 'auth');
  assert.equal(hy2.sni, 'front.example');
  assert.equal(hy2.network, undefined);
});
