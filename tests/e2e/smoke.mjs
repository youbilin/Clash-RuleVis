import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 4890 + Math.floor(Math.random() * 80);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clash-routedesk-e2e-'));
let server;
let browser;
let serverLog = '';

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务未启动\n${serverLog.slice(-4000)}`);
}

async function main() {
  assert.ok(
    await fs.stat(path.join(repo, 'dist/index.html')).then(() => true).catch(() => false),
    '缺少 dist，请先运行 npm run build',
  );

  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), CRS_DATA_DIR: tempDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  await waitForServer();

  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    const executablePath = process.env.CHROME_PATH;
    assert.ok(executablePath, '未找到 Chrome，请设置 CHROME_PATH');
    browser = await chromium.launch({ executablePath, headless: true });
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${baseUrl}/nodes`, { waitUntil: 'domcontentloaded' });
    await page.locator('.topbar').waitFor();
    await page.locator('.nodes-page').waitFor();
    assert.ok(await page.locator('.import-collapsed').isVisible(), '导入区默认应收起');

    const importNode = async (link, expectedName) => {
      await page.locator('.import-collapsed').click();
      await page.locator('.inline-importer').waitFor();
      await page.locator('.import-tab', { hasText: '节点链接' }).click();
      await page.locator('input[aria-label="节点分享链接"]').fill(link);
      await page.getByRole('button', { name: '添加节点', exact: true }).click();
      await page.locator('.node-row', { hasText: expectedName }).waitFor();
      await page.locator('.import-collapsed').waitFor();
    };

    await importNode(
      'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@relay.example.com:8388#Relay-A',
      'Relay-A',
    );
    await importNode(
      'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@landing.example.com:8389#Landing-B',
      'Landing-B',
    );
    const duplicateStatus = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const data = await response.json();
      const workspace = data.workspace;
      const source = workspace.nodes.find((node) => node.name === 'Relay-A');
      workspace.nodes.push({
        ...structuredClone(source),
        id: crypto.randomUUID(),
        name: 'Relay-A-copy',
        raw: { ...source.raw, name: 'Relay-A-copy' },
        addedAt: new Date().toISOString(),
      });
      const saved = await fetch('/api/workspace', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'clash-route-desk',
        },
        body: JSON.stringify({ workspace, baseRevision: workspace.revision }),
      });
      return saved.status;
    });
    assert.equal(duplicateStatus, 200, '应能写入重复节点测试数据');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.nodes-page').waitFor();

    await page.locator('.node-muted-filter', { hasText: '重复' }).click();
    await page.locator('.node-merge-btn', { hasText: '合并' }).click();
    await page.locator('.modal-title', { hasText: '合并重复节点' }).waitFor();
    await page
      .getByRole('alertdialog', { name: '合并重复节点' })
      .getByRole('button', { name: '合并', exact: true })
      .click();
    await page.locator('.toast-title', { hasText: '重复节点已合并' }).waitFor();
    await page.waitForTimeout(900);
    const nodeNames = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return (await response.json()).workspace.nodes.map((node) => node.name);
    });
    assert.ok(!nodeNames.includes('Relay-A-copy'), '重复节点合并应写入工作区');

    await page.goto(`${baseUrl}/exits`, { waitUntil: 'domcontentloaded' });
    await page.locator('.exits-page').waitFor();
    await page.getByRole('button', { name: /从模板新建/ }).click();
    await page.locator('.template-item', { hasText: '全部节点' }).click();
    await page.locator('.exit-row', { hasText: '全部节点 2' }).waitFor();
    await page.waitForTimeout(900);
    const exitNames = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return (await response.json()).workspace.exits.map((exit) => exit.name);
    });
    assert.ok(exitNames.includes('全部节点 2'), '新建出口应写入工作区');

    await page.goto(`${baseUrl}/chains`, { waitUntil: 'domcontentloaded' });
    await page.locator('.chain-page').waitFor();
    await page.locator('.chain-workspace').waitFor();
    const columns = page.locator('.chain-column');
    await columns.nth(0).getByRole('button', { name: /^Relay-A\s/ }).click();
    await columns.nth(1).getByRole('button', { name: /^Landing-B\s/ }).click();
    await page.locator('.chain-name-slot input').fill('E2E 链路');
    const saveChain = page.getByRole('button', { name: '保存链路' });
    await saveChain.waitFor();
    assert.equal(await saveChain.isDisabled(), false, '填写完整后保存按钮应可用');
    await saveChain.click();
    await page.locator('.chain-existing-row', { hasText: 'E2E 链路' }).waitFor();

    const chainNode = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const data = await response.json();
      return data.workspace.nodes.find((node) => node.name === 'E2E 链路');
    });
    assert.ok(chainNode?.chain, '链式节点应带有 chain 元数据');
    assert.equal(chainNode.raw['dialer-proxy'], 'Relay-A');
    assert.equal(chainNode.raw['name'], 'E2E 链路');

    const saveStatus = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const data = await response.json();
      const workspace = data.workspace;
      const direct = workspace.exits.find((exit) => exit.name === 'DIRECT');
      const matchIndex = workspace.routes.findIndex((route) => route.type === 'MATCH');
      workspace.routes.splice(matchIndex, 0, {
        id: crypto.randomUUID(),
        kind: 'rule',
        type: 'DOMAIN-SUFFIX',
        payload: 'e2e.example',
        exitId: direct.id,
        origin: 'manual',
        enabled: true,
      });
      workspace.routes.splice(matchIndex + 1, 0, {
        id: crypto.randomUUID(),
        kind: 'rule',
        type: 'DOMAIN-SUFFIX',
        payload: 'broken.example',
        exitId: 'missing-exit',
        origin: 'manual',
        enabled: true,
      });
      const saved = await fetch('/api/workspace', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'clash-route-desk',
        },
        body: JSON.stringify({ workspace, baseRevision: workspace.revision }),
      });
      return saved.status;
    });
    assert.equal(saveStatus, 200, '测试规则应写入工作区');

    await page.goto(`${baseUrl}/rulesets`, { waitUntil: 'domcontentloaded' });
    await page.locator('.rules-page').waitFor();
    await page.getByText('e2e.example', { exact: false }).first().waitFor();
    await page.locator('.rule-view-btn', { hasText: '失效 1' }).waitFor();
    await page.locator('.rule-view-btn', { hasText: '清理失效' }).click();
    await page.locator('.modal-title', { hasText: '清理失效目标规则' }).waitFor();
    await page
      .getByRole('alertdialog', { name: '清理失效目标规则' })
      .getByRole('button', { name: '清理', exact: true })
      .click();
    await page.locator('.toast-title', { hasText: '失效规则已清理' }).waitFor();
    await page.waitForTimeout(900);
    const invalidRuleCount = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const data = await response.json();
      return data.workspace.routes.filter((route) => route.payload === 'broken.example').length;
    });
    assert.equal(invalidRuleCount, 0, '失效规则清理应写入工作区');

    await page.goto(`${baseUrl}/export`, { waitUntil: 'domcontentloaded' });
    await page.locator('.export-page').waitFor();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.page-actions button')].find((item) =>
        item.textContent?.includes('导出配置'),
      );
      return button && !button.disabled;
    });
    await page.getByRole('button', { name: '导出配置', exact: true }).click();
    await page.locator('.modal-title', { hasText: '导出完成' }).waitFor({ timeout: 30_000 });

    const exported = await page.evaluate(async () => {
      const response = await fetch('/api/export/preview', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return response.json();
    });
    assert.ok(exported.yaml.includes('dialer-proxy: Relay-A'), '导出 YAML 应使用中转节点作为 dialer-proxy');
    assert.ok(exported.yaml.includes('E2E 链路'), '导出 YAML 应包含链式节点');
    assert.ok(!exported.yaml.includes('relay.example.com/sub'), '导出 YAML 不应包含订阅地址');

    await page.getByRole('button', { name: '完成' }).click();
    await page.locator('.export-history-select > button').click();
    await page.locator('.export-history-option').first().click();
    await page.locator('.export-history-menu-foot .btn-primary').click();
    await page.locator('.modal-title', { hasText: '恢复工作区' }).waitFor();
    await page.getByRole('button', { name: '恢复此快照' }).click();
    await page.locator('.toast-title', { hasText: '工作区已恢复' }).waitFor();

    await page.locator('.kernel-chip').click();
    await page.locator('.drawer').waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出工作区 JSON' }).click();
    const download = await downloadPromise;
    const backupPath = path.join(tempDir, 'backup.json');
    await download.saveAs(backupPath);
    assert.match(download.suggestedFilename(), /\.json$/);
    await page.locator('.settings-backup input[type=file]').setInputFiles(backupPath);
    await page.locator('.modal-title', { hasText: '导入工作区备份' }).waitFor();
    await page
      .getByRole('alertdialog', { name: '导入工作区备份' })
      .getByRole('button', { name: '导入备份' })
      .click();
    await page.locator('.toast-title', { hasText: '工作区备份已导入' }).waitFor();

    await page.goto(`${baseUrl}/chains`, { waitUntil: 'domcontentloaded' });
    await page.locator('.chain-page').waitFor();
    const chainRow = page.locator('.chain-existing-row', { hasText: 'E2E 链路' });
    await chainRow.waitFor();
    await chainRow.locator('.icon-btn.danger').click();
    await page.locator('.modal-title', { hasText: '删除链式节点' }).waitFor();
    await page
      .getByRole('alertdialog', { name: '删除链式节点' })
      .getByRole('button', { name: '删除链路' })
      .click();
    await page.locator('.toast-title', { hasText: '链路已删除' }).waitFor();
    await chainRow.waitFor({ state: 'detached' });
    const remainingNames = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return (await response.json()).workspace.nodes.map((node) => node.name);
    });
    assert.ok(remainingNames.includes('Relay-A') && remainingNames.includes('Landing-B'));
    assert.ok(!remainingNames.includes('E2E 链路'));

    assert.deepEqual(pageErrors, [], `页面出现未处理错误：${pageErrors.join('\n')}`);
    console.log(`E2E smoke passed · ${baseUrl}`);
  } finally {
    await context.close().catch(() => {});
  }
}

try {
  await main();
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
