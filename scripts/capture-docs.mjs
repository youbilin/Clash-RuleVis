import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const url = process.env.DOCS_URL || 'http://127.0.0.1:4781';
const outputDir = path.resolve('docs/assets');
await fs.mkdir(outputDir, { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
}

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

const shot = async (name) => {
  await page.screenshot({ path: path.join(outputDir, name), animations: 'disabled' });
  console.log('captured', name);
};

try {
  await page.goto(`${url}/chains`, { waitUntil: 'domcontentloaded' });
  await page.locator('.chain-workspace').waitFor();
  const columns = page.locator('.chain-column');
  await columns.nth(0).locator('.chain-node').filter({ hasText: 'DEMO-东京 01' }).click();
  await columns.nth(1).locator('.chain-node').filter({ hasText: 'DEMO-洛杉矶 01' }).click();
  await page.locator('.chain-name-slot input').fill('东京中转 · 美国落地');
  await page.waitForTimeout(450);
  await shot('chain-builder.png');

  await page.goto(`${url}/nodes`, { waitUntil: 'domcontentloaded' });
  await page.locator('.nodes-page').waitFor();
  await page.waitForTimeout(350);
  await shot('nodes.png');

  await page.locator('.nodes-add-source').click();
  await page.getByRole('dialog', { name: '添加来源' }).waitFor();
  await page.locator('.source-row-input').first().fill('https://example.com/sub?token=demo');
  await page.locator('.source-row-add').click();
  await page.locator('.source-row-input').nth(1).fill(
    'proxies:\n  - name: 演示节点\n    type: vmess\n    server: demo.example.com\n    port: 443',
  );
  await page.locator('.source-row-add').click();
  await page.locator('.source-row-input').nth(2).fill(
    'ss://YWVzLTI1Ni1nY206ZGVtby1wYXNzd29yZA==@demo.example.com:8388#演示节点\nvless://00000000-0000-0000-0000-000000000000@demo.example.com:443?security=tls#演示节点 2',
  );
  await page.waitForTimeout(400);
  await shot('import-sources.png');
  await page.locator('.modal-foot .btn-ghost').click();

  await page.goto(`${url}/rulesets`, { waitUntil: 'domcontentloaded' });
  await page.locator('.rules-page').waitFor();
  await page.waitForTimeout(300);
  await shot('rules.png');

  await page.goto(`${url}/export`, { waitUntil: 'domcontentloaded' });
  await page.locator('.yaml-panel').waitFor();
  await page.waitForTimeout(700);
  await shot('export.png');
} finally {
  await context.close();
  await browser.close();
}
