import fs from 'node:fs';
import path from 'node:path';
import { parseShareLink } from '../src/lib/node-link';
import { generateConfig } from '../server/generator';
import type { Workspace } from '../shared/types';

const root = process.cwd();
const fixtureDir = path.join(root, 'fixtures');
const workspace = JSON.parse(
  fs.readFileSync(path.join(root, 'demo/workspace.json'), 'utf8'),
) as Workspace;

fs.mkdirSync(path.join(fixtureDir, 'expected'), { recursive: true });
fs.mkdirSync(path.join(fixtureDir, 'links'), { recursive: true });

const generated = generateConfig(workspace);
fs.writeFileSync(path.join(fixtureDir, 'expected/demo-export.yaml'), generated.yaml);
fs.writeFileSync(
  path.join(fixtureDir, 'expected/demo-export.json'),
  `${JSON.stringify(
    {
      counts: generated.counts,
      issues: generated.issues,
    },
    null,
    2,
  )}\n`,
);

const links = [
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@relay.example.com:8388#Relay-A',
  'ss://aes-128-gcm%3A9NosWuwAmgkVsMlBN0Pvvw%3D%3D@142.91.109.151:23025#ss',
  'ssr://ZXhhbXBsZS5jb206ODM4ODpvcmlnaW46YWVzLTI1Ni1jZmI6cGxhaW46Y0dGemN3Lz9yZW1hcmtzYzNWdWF5QlNaWEJ2Y25R',
  'vmess://eyJ2IjoiMiIsInBzIjoiVG9reW8iLCJhZGQiOiJ2bS5leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsIm5ldCI6IndzIiwidGxzIjoidGxzIn0=',
  'vless://11111111-2222-3333-4444-555555555555@vless.example.com:443?security=tls&type=ws&path=%2Fws#V',
  'trojan://secret@trojan.example.com:443?type=ws&path=%2Fws#T',
  'hysteria2://auth@hy.example.com:8443?sni=front.example.com#H',
  'tuic://uuid-value:pass@tuic.example.com:443?sni=front.example.com#U',
  'socks5://user:pass@127.0.0.1:1080#SOCKS',
];

const parsed = links.map((link) => {
  try {
    return { link, node: parseShareLink(link) };
  } catch (error) {
    return { link, error: (error as Error).message };
  }
});
fs.writeFileSync(path.join(fixtureDir, 'links/parsed.json'), `${JSON.stringify(parsed, null, 2)}\n`);

console.log(`fixtures written to ${fixtureDir}`);
