import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('manifest 已升级到 v3.0.1 并声明多邮箱内容脚本', () => {
  const manifest = readJson('manifest.json');

  assert.equal(manifest.version, '3.0.1');

  const scriptBundles = manifest.content_scripts.map((item) => ({
    matches: item.matches,
    js: item.js,
    allFrames: Boolean(item.all_frames),
  }));

  assert.ok(
    scriptBundles.some((item) => item.matches.includes('https://www.2925.com/*') && item.js.includes('content/2925-mail.js')),
    'manifest 缺少 2925 内容脚本声明'
  );
  assert.ok(
    scriptBundles.some((item) => item.matches.includes('https://duckduckgo.com/email/settings/autofill*') && item.js.includes('content/duck-mail.js')),
    'manifest 缺少 Duck 内容脚本声明'
  );
  assert.ok(
    scriptBundles.some((item) => item.matches.includes('https://mail.qq.com/*') && item.js.includes('content/qq-mail.js') && item.allFrames),
    'manifest 缺少 QQ 内容脚本声明'
  );
  assert.ok(
    scriptBundles.some((item) => item.matches.includes('https://mail.163.com/*') && item.js.includes('content/mail-163.js') && item.allFrames),
    'manifest 缺少 163 内容脚本声明'
  );
  assert.ok(
    scriptBundles.some((item) => item.matches.includes('https://burnermailbox.com/mailbox*') && item.js.includes('content/burner-mail.js')),
    'manifest 应继续保留 Burner Mailbox 内容脚本声明'
  );
});

test('侧边栏与后台已接入多邮箱 provider 枚举和通用消息路由', () => {
  const sidepanelHtml = read('sidepanel/sidepanel.html');
  const sidepanelJs = read('sidepanel/sidepanel.js');
  const backgroundJs = read('background.js');

  const requiredHtmlTokens = [
    'select-email-provider',
    'Burner Mailbox',
    '2925 邮箱',
    'QQ 邮箱',
    '163 邮箱',
  ];

  for (const token of requiredHtmlTokens) {
    assert.equal(
      sidepanelHtml.includes(token),
      true,
      `侧边栏 HTML 缺少 provider 标识: ${token}`
    );
  }

  const requiredJsTokens = [
    'EMAIL_PROVIDER_BURNER',
    'EMAIL_PROVIDER_2925',
    'EMAIL_PROVIDER_QQ',
    'EMAIL_PROVIDER_163',
    'FETCH_PROVIDER_EMAIL',
    'CONTINUE_PROVIDER_FETCH',
    'getProviderDisplayName',
  ];

  for (const token of requiredJsTokens) {
    assert.equal(
      sidepanelJs.includes(token),
      true,
      `侧边栏脚本缺少 provider 关键标识: ${token}`
    );
  }

  const requiredBackgroundTokens = [
    'emailProvider',
    'mail2925MainEmail',
    'FETCH_PROVIDER_EMAIL',
    'CONTINUE_PROVIDER_FETCH',
    'getMailConfig',
    'fetchProviderEmail',
    'continueProviderFetch',
    'EMAIL_PROVIDER_BURNER',
    'EMAIL_PROVIDER_2925',
    'EMAIL_PROVIDER_QQ',
    'EMAIL_PROVIDER_163',
  ];

  for (const token of requiredBackgroundTokens) {
    assert.equal(
      backgroundJs.includes(token),
      true,
      `后台脚本缺少 provider 关键标识: ${token}`
    );
  }
});

test('README 与 CHANGELOG 已同步到 v3.0.1 多邮箱说明', () => {
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');

  const requiredReadmeTokens = [
    '2925',
    'Duck',
    'QQ',
    '163',
    'CHANGELOG.md',
    'v3.0.1',
    'Burner Mailbox',
    '自动刷新重试',
    '自动切回邮箱页继续扫描',
    '不会再被新日志强制拉到底部',
  ];

  for (const token of requiredReadmeTokens) {
    assert.equal(
      readme.includes(token),
      true,
      `README 缺少多邮箱 / 版本说明: ${token}`
    );
  }

  const requiredChangelogTokens = [
    '# Changelog',
    'v3.0.1 - 2026-04-12',
    '自动刷新 / 整页重试',
    '自动切回邮箱页继续扫描',
    '2925',
    'Duck',
    'QQ',
    '163',
    'Burner Mailbox',
  ];

  for (const token of requiredChangelogTokens) {
    assert.equal(
      changelog.includes(token),
      true,
      `CHANGELOG 缺少版本记录: ${token}`
    );
  }
});

test('README 已改用真实截图与赞赏二维码素材，并移除本地预览入口', () => {
  const readme = read('README.md');

  const requiredImageTokens = [
    'img/完整自动示例图.png',
    'img/十轮自动.png',
    'img/微信.png',
    'img/支付宝.jpg',
  ];

  for (const token of requiredImageTokens) {
    assert.equal(
      readme.includes(token),
      true,
      `README 缺少真实素材引用: ${token}`
    );
  }

  const requiredReadmeTokens = [
    '赞赏支持',
    '跳过步骤',
    '兜底',
    '继续当前',
    '重新开始',
  ];

  for (const token of requiredReadmeTokens) {
    assert.equal(
      readme.includes(token),
      true,
      `README 缺少本轮能力说明: ${token}`
    );
  }

  assert.equal(
    readme.includes('readme-preview.html'),
    false,
    'README 不应再包含 readme-preview.html'
  );
});

test('readme-preview.html 已删除', () => {
  assert.equal(
    fs.existsSync(path.join(rootDir, 'readme-preview.html')),
    false,
    'readme-preview.html 这轮应已删除'
  );
});

test('侧边栏静态结构已接入兜底开关、Auto 启动弹窗与跳过步骤挂载点', () => {
  const sidepanelHtml = read('sidepanel/sidepanel.html');
  const sidepanelJs = read('sidepanel/sidepanel.js');
  const sidepanelCss = read('sidepanel/sidepanel.css');

  const requiredHtmlTokens = [
    'input-auto-skip-failures',
    'auto-start-modal',
    'btn-auto-start-restart',
    'btn-auto-start-continue',
    'btn-auto-start-cancel',
  ];

  for (const token of requiredHtmlTokens) {
    assert.equal(
      sidepanelHtml.includes(token),
      true,
      `侧边栏 HTML 缺少结构标识: ${token}`
    );
  }

  const requiredJsTokens = [
    'autoRunSkipFailures',
    'STATUS_ICONS.skipped',
    'SKIP_STEP',
    'TAKEOVER_AUTO_RUN',
    'handleSkipStep',
    'maybeTakeoverAutoRun',
    'openAutoStartChoiceDialog',
    'step-skip-btn',
  ];

  for (const token of requiredJsTokens) {
    assert.equal(
      sidepanelJs.includes(token),
      true,
      `侧边栏脚本缺少跳过 / 兜底 / 启动弹窗标识: ${token}`
    );
  }

  const requiredCssTokens = [
    '.step-row.skipped',
    '.step-skip-btn',
    '#auto-start-modal',
  ];

  for (const token of requiredCssTokens) {
    assert.equal(
      sidepanelCss.includes(token),
      true,
      `侧边栏样式缺少跳过 / 弹窗样式标识: ${token}`
    );
  }
});

test('后台协议已支持跳过步骤、接管自动流程、继续当前与兜底设置', () => {
  const backgroundJs = read('background.js');

  const requiredTokens = [
    'SKIP_STEP',
    'TAKEOVER_AUTO_RUN',
    'autoRunSkipFailures',
    "mode: 'restart' | 'continue'",
    "status: 'skipped'",
    'skipStep(step)',
    'autoRunLoop(totalRuns, options',
    'mode === \'continue\'',
    'mode === \'restart\'',
  ];

  for (const token of requiredTokens) {
    assert.equal(
      backgroundJs.includes(token),
      true,
      `后台脚本缺少跳过 / 兜底 / 启动模式标识: ${token}`
    );
  }
});
