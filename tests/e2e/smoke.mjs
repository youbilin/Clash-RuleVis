import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
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

  await fs.writeFile(
    path.join(tempDir, 'kernel.json'),
    JSON.stringify({ mode: 'tcp', endpoint: 'http://127.0.0.1:1', secret: '' }),
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
    await page.goto(`${baseUrl}/live`, { waitUntil: 'domcontentloaded' });
    await page.locator('.live-page').waitFor();
    await page.getByText('Clash Verge 未连接').first().waitFor();
    await page.getByRole('button', { name: '导入订阅' }).click();
    await page.getByRole('dialog', { name: '添加来源' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.modal').waitFor({ state: 'detached' });

    await page.goto(`${baseUrl}/nodes`, { waitUntil: 'domcontentloaded' });
    await page.locator('.topbar').waitFor();
    await page.locator('.nodes-page').waitFor();
    assert.ok(await page.locator('.nodes-add-source').isVisible(), '节点工具栏应有添加来源入口');

    const importNodes = async (links) => {
      await page.locator('.nodes-add-source').click();
      await page.getByRole('dialog', { name: '添加来源' }).waitFor();
      for (let index = 0; index < links.length; index += 1) {
        if (index > 0) await page.locator('.source-row-add').click();
        await page.locator('.source-row-input').nth(index).fill(links[index].link);
      }
      await page.locator('.modal-foot .btn-primary').click();
      await page.locator('.modal').waitFor({ state: 'detached' });
      for (const item of links) {
        await page.locator('.node-row', { hasText: item.name }).waitFor();
      }
    };

    await importNodes([
      { link: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@relay.example.com:8388#Relay-A', name: 'Relay-A' },
      { link: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@landing.example.com:8389#Landing-B', name: 'Landing-B' },
    ]);
    const manualSources = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return (await response.json()).workspace.sources
        .filter((source) => source.type === 'manual')
        .map((source) => source.name)
        .sort();
    });
    assert.deepEqual(manualSources, ['节点链接'], '直链节点应统一归入一个节点链接来源');

    await page.locator('.nodes-add-source').click();
    await page.getByRole('dialog', { name: '添加来源' }).waitFor();
    await page.locator('.source-row-input').evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@paste.example.com:8390#Paste-C');
    await page.locator('.modal').waitFor({ state: 'detached' });
    await page.locator('.node-row', { hasText: 'Paste-C' }).waitFor();

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

    await page.locator('.node-select-btn').click();
    await page.locator('.node-selection-bar').waitFor();
    await page.locator('.node-row', { hasText: 'Relay-A' }).click();
    assert.equal(
      await page.locator('.node-selection-bar .selection-count').innerText(),
      '1',
      '点击节点后应进入已选状态',
    );
    await page.locator('.node-selection-bar').getByRole('button', { name: '完成' }).click();
    await page.locator('.node-selection-bar').waitFor({ state: 'detached' });
    assert.equal(
      await page.locator('.node-row.selected').count(),
      0,
      '完成选择后应清除选中状态',
    );

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

    await page.getByRole('button', { name: '新建出口' }).click();
    const exitDrawer = page.getByRole('dialog', { name: '新建出口' });
    await exitDrawer.waitFor();
    await exitDrawer.locator('input').first().fill('批量出口');
    await exitDrawer.getByRole('button', { name: '批量选节点' }).click();
    const nodePicker = page.getByRole('dialog', { name: '批量选择节点' });
    await nodePicker.waitFor();
    await nodePicker.locator('.node-picker-row', { hasText: 'Relay-A' }).click();
    await nodePicker.locator('.node-picker-row', { hasText: 'Landing-B' }).click();
    await nodePicker.getByRole('button', { name: /添加 2 个节点/ }).click();
    await page.getByRole('dialog', { name: '批量选择节点' }).waitFor({ state: 'detached' });
    await exitDrawer.getByRole('button', { name: '创建出口' }).click();
    await page.locator('.exit-row', { hasText: '批量出口' }).waitFor();
    await page.waitForTimeout(900);
    const bulkExit = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      return (await response.json()).workspace.exits.find((exit) => exit.name === '批量出口');
    });
    assert.equal(bulkExit?.members.filter((member) => member.by === 'node').length, 2, '批量选择应加入两个节点成员');

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
    await page.locator('.modal-title', { hasText: '导出配置' }).waitFor();
    await page.locator('.export-confirm input').fill('e2e-renamed.yaml');
    await page.getByRole('button', { name: '确认导出', exact: true }).click();
    await page.locator('.modal-title', { hasText: '导出完成' }).waitFor({ timeout: 30_000 });
    const exportedPath = await page.locator('.export-success-path code').textContent();
    assert.ok(exportedPath?.endsWith('e2e-renamed.yaml'), '导出应使用确认弹窗中的文件名');

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

    await page.locator('.export-history-select > button').click();
    await page.getByRole('button', { name: '清除历史快照' }).click();
    await page.locator('.modal-title', { hasText: '清除历史快照' }).waitFor();
    await page
      .getByRole('alertdialog', { name: '清除历史快照' })
      .getByRole('button', { name: '清除', exact: true })
      .click();
    await page.locator('.toast-title', { hasText: '历史快照已清除' }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('.export-history-select .number-badge')?.textContent === '0',
    );

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

    await page.goto(`${baseUrl}/nodes`, { waitUntil: 'domcontentloaded' });
    await page.locator('.nodes-page').waitFor();
    const landingRow = page.locator('.node-row', { hasText: 'Landing-B' });
    await landingRow.locator('.node-row-actions .icon-btn.danger').click();
    await page
      .getByRole('alertdialog', { name: '删除节点' })
      .getByRole('button', { name: '删除节点' })
      .click();
    await page.locator('.toast-title', { hasText: '节点已删除' }).waitFor();
    await page.waitForTimeout(700);
    const afterNodeDelete = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const workspace = (await response.json()).workspace;
      return {
        sources: workspace.sources.filter((source) => source.type === 'manual').map((source) => source.name),
        nodes: workspace.nodes.map((node) => node.name),
      };
    });
    assert.ok(afterNodeDelete.sources.includes('节点链接'));
    assert.ok(!afterNodeDelete.nodes.includes('Landing-B'));

    const pasteRow = page.locator('.node-row', { hasText: 'Paste-C' });
    await pasteRow.locator('.node-row-actions .icon-btn.danger').click();
    await page
      .getByRole('alertdialog', { name: '删除节点' })
      .getByRole('button', { name: '删除节点' })
      .click();
    await page.locator('.node-row', { hasText: 'Paste-C' }).waitFor({ state: 'detached' });
    await page.waitForTimeout(700);

    const relayRow = page.locator('.node-row', { hasText: 'Relay-A' });
    await relayRow.locator('.node-row-actions .icon-btn.danger').click();
    await page
      .getByRole('alertdialog', { name: '删除节点' })
      .getByRole('button', { name: '删除节点' })
      .click();
    await page.locator('.node-row', { hasText: 'Relay-A' }).waitFor({ state: 'detached' });
    await page.waitForTimeout(700);
    const afterLastNodeDelete = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const workspace = (await response.json()).workspace;
      return {
        sources: workspace.sources.filter((source) => source.type === 'manual').map((source) => source.name),
        nodes: workspace.nodes.map((node) => node.name),
      };
    });
    assert.equal(afterLastNodeDelete.sources.length, 0, '删除最后一个节点后应同步删除来源');
    assert.ok(!afterLastNodeDelete.nodes.includes('Relay-A'));

    const bulkStatus = await page.evaluate(async () => {
      const response = await fetch('/api/workspace', {
        headers: { 'X-Requested-With': 'clash-route-desk' },
      });
      const workspace = (await response.json()).workspace;
      const exitId = workspace.exits.find((exit) => !exit.builtin)?.id ?? workspace.exits[0].id;
      workspace.routes = Array.from({ length: 300 }, (_, index) => ({
        id: `e2e-bulk-${index}`,
        kind: 'rule',
        type: 'DOMAIN-SUFFIX',
        payload: `bulk-${index}.example.com`,
        exitId,
        origin: 'manual',
        enabled: true,
        pending: false,
      }));
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
    assert.equal(bulkStatus, 200, '应能写入大规则集测试数据');

    await page.goto(`${baseUrl}/rulesets`, { waitUntil: 'domcontentloaded' });
    await page.locator('.rule-row').first().waitFor();
    const virtualizedRows = await page.locator('.rule-row').count();
    assert.ok(virtualizedRows < 100, `大规则集应只渲染可视行，实际 ${virtualizedRows} 行`);
    await page.evaluate(() => {
      const body = document.querySelector('.rule-list-body');
      body.scrollTop = body.scrollHeight;
    });
    await page.locator('.rule-row', { hasText: 'bulk-299.example.com' }).waitFor();

    const orphanPath = path.join(tempDir, 'exports', 'e2e-orphan.yaml');
    await fs.writeFile(orphanPath, 'orphan');
    const cleanup = await page.evaluate(async () => {
      const headers = { 'X-Requested-With': 'clash-route-desk' };
      const stats = await fetch('/api/exports/stats', { headers }).then((response) => response.json());
      const result = await fetch('/api/exports/cleanup', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepDays: 0 }),
      }).then((response) => response.json());
      return { stats, result };
    });
    assert.ok(cleanup.stats.count >= 2, '导出目录统计应包含导出文件和孤儿文件');
    assert.ok(cleanup.result.removed >= 1, '清理应删除未引用的孤儿导出文件');
    assert.equal(await fs.stat(orphanPath).then(() => true).catch(() => false), false);

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
