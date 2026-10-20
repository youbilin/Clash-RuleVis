import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const url = process.env.DOCS_URL || 'http://127.0.0.1:4781';
const videoDir = path.resolve('data/docs-video');
await fs.rm(videoDir, { recursive: true, force: true });
await fs.mkdir(videoDir, { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
}

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
  colorScheme: 'light',
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await page.goto(`${url}/chains`, { waitUntil: 'domcontentloaded' });
await page.locator('.chain-workspace').waitFor();
await page.waitForTimeout(1200);

const columns = page.locator('.chain-column');
await columns.nth(0).locator('.chain-node').filter({ hasText: 'DEMO-东京 01' }).click();
await page.waitForTimeout(550);
await columns.nth(1).locator('.chain-node').filter({ hasText: 'DEMO-洛杉矶 01' }).click();
await page.waitForTimeout(650);
await page.locator('.chain-name-slot input').pressSequentially('东京中转 · 美国落地', { delay: 75 });
await page.waitForTimeout(1400);
await context.close();
await browser.close();

const files = await fs.readdir(videoDir);
const video = files.find((file) => file.endsWith('.webm'));
if (!video) throw new Error('未生成录屏文件');
console.log(path.join(videoDir, video));
