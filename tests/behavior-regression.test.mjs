import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function extractFunction(source, name) {
  const tokens = [`async function ${name}`, `function ${name}`];
  let start = -1;
  for (const token of tokens) {
    start = source.indexOf(token);
    if (start !== -1) {
      break;
    }
  }

  if (start === -1) {
    throw new Error(`Could not find function ${name}`);
  }

  let bodyStart = -1;
  let parenDepth = 0;
  let inSingleHead = false;
  let inDoubleHead = false;
  let inTemplateHead = false;
  let inLineCommentHead = false;
  let inBlockCommentHead = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineCommentHead) {
      if (char === '\n') {
        inLineCommentHead = false;
      }
      continue;
    }

    if (inBlockCommentHead) {
      if (prev === '*' && char === '/') {
        inBlockCommentHead = false;
      }
      continue;
    }

    if (!inSingleHead && !inDoubleHead && !inTemplateHead) {
      if (char === '/' && next === '/') {
        inLineCommentHead = true;
        index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockCommentHead = true;
        index += 1;
        continue;
      }
    }

    if (char === "'" && !inDoubleHead && !inTemplateHead && prev !== '\\') {
      inSingleHead = !inSingleHead;
      continue;
    }
    if (char === '"' && !inSingleHead && !inTemplateHead && prev !== '\\') {
      inDoubleHead = !inDoubleHead;
      continue;
    }
    if (char === '`' && !inSingleHead && !inDoubleHead && prev !== '\\') {
      inTemplateHead = !inTemplateHead;
      continue;
    }

    if (inSingleHead || inDoubleHead || inTemplateHead) {
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '{' && parenDepth === 0) {
      bodyStart = index;
      break;
    }
  }

  if (bodyStart === -1) {
    throw new Error(`Could not find body for function ${name}`);
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (prev === '*' && char === '/') {
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (char === '/' && next === '/') {
        inLineComment = true;
        index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
    }

    if (char === "'" && !inDouble && !inTemplate && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle && !inTemplate && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }
    if (char === '`' && !inSingle && !inDouble && prev !== '\\') {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingle || inDouble || inTemplate) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not extract function ${name}`);
}

function loadFunction(relativePath, name, context = {}) {
  const source = read(relativePath);
  const functionSource = extractFunction(source, name);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    Error,
    Array,
    Object,
    RegExp,
    String,
    Number,
    Boolean,
    Set,
    Map,
    ...context,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource}\nglobalThis.__loaded = ${name};`, sandbox);
  return sandbox.__loaded;
}

await test('2925 可恢复失败不应首错即停', async () => {
  const logs = [];
  let refreshAttempts = 0;

  const handlePoll2925Mail = loadFunction('content/2925-mail.js', 'handlePoll2925Mail', {
    ensureMailListPage: async () => [],
    isRecoverableMailListError: (error) => /访问邮件列表失败/.test(String(error?.message || error || '')),
    log: (message, level = 'info') => {
      logs.push({ message, level });
    },
    collectMessagesForTarget: () => [],
    findMatching2925VerificationResult: async () => null,
    refreshInbox: async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) {
        throw new Error('访问邮件列表失败，请点击刷新');
      }
    },
    sleep: async () => {},
    seen2925Codes: new Set(),
    persistSeen2925Codes: async () => {},
  });

  await assert.rejects(
    () => handlePoll2925Mail(4, {
      targetEmail: 'demochild@2925.com',
      maxAttempts: 2,
      intervalMs: 0,
    }),
    /暂未找到当前子邮箱/
  );

  assert.equal(refreshAttempts, 2);
  assert.equal(
    logs.some((entry) => entry.level === 'warn' && /访问邮件列表失败/.test(entry.message)),
    true
  );
});

await test('重发 helper 应返回结构化点击结果', async () => {
  const resendButton = { textContent: '重新发送电子邮件' };
  let clickedButton = null;

  const resendVerificationEmail = loadFunction('content/signup-page.js', 'resendVerificationEmail', {
    log: () => {},
    waitForResendButton: async () => resendButton,
    humanPause: async () => {},
    simulateClick: (button) => {
      clickedButton = button;
    },
    sleep: async () => {},
  });

  const result = await resendVerificationEmail(4, { clicks: 1 });

  assert.equal(clickedButton, resendButton);
  assert.equal(result.clicked, true);
  assert.equal(result.clicks, 1);
  assert.equal(result.buttonText, '重新发送电子邮件');
  assert.equal(typeof result.method, 'string');
  assert.equal(result.method.length > 0, true);
});

await test('重发成功后应记录成功并切回邮箱标签', async () => {
  const logs = [];
  const updates = [];

  const clickResendOnSignupPage = loadFunction('background.js', 'clickResendOnSignupPage', {
    getTabId: async (source) => {
      if (source === 'signup-page') return 41;
      if (source === 'mail-2925') return 73;
      return null;
    },
    getState: async () => ({ emailProvider: 'mail_2925' }),
    getMailConfig: () => ({ source: 'mail-2925', label: '2925 邮箱' }),
    sendToContentScript: async () => ({
      clicked: true,
      clicks: 1,
      buttonText: '重新发送电子邮件',
      method: 'intent-resend',
    }),
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      tabs: {
        update: async (tabId, options) => {
          updates.push({ tabId, options });
        },
      },
    },
  });

  const result = await clickResendOnSignupPage(4, 1);

  assert.equal(result.clicked, true);
  assert.equal(updates.some((entry) => entry.tabId === 41 && entry.options.active === true), true);
  assert.equal(updates.some((entry) => entry.tabId === 73 && entry.options.active === true), true);
  assert.equal(logs.some((entry) => /已点击.*重新发送/.test(entry.message)), true);
  assert.equal(logs.some((entry) => /已切回 2925 邮箱/.test(entry.message)), true);
});

await test('等待日志应拆成开始等待和等待结束两段', async () => {
  const logs = [];
  let pollRound = 0;

  const pollVerificationCodeWithRetry = loadFunction('background.js', 'pollVerificationCodeWithRetry', {
    getMailConfig: () => ({ source: 'mail-2925', label: '2925 邮箱' }),
    getOtpPollingConfig: () => ({ waitSeconds: 24, maxAttempts: 6, resendEveryAttempts: 3 }),
    openMailTab: async () => {},
    sendToContentScript: async () => {
      pollRound += 1;
      if (pollRound === 1) {
        return { error: '暂未找到' };
      }
      return { code: '246810', emailTimestamp: 12345 };
    },
    isBurnerChallengeError: () => false,
    isNoMatchingEmailError: (err) => /暂未找到/.test(err.message),
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    requestVerificationEmailResend: async () => ({
      clicked: true,
      buttonText: '重新发送电子邮件',
      method: 'intent-resend',
    }),
    humanStepDelay: async (min, max, onSelected) => {
      if (typeof onSelected === 'function') {
        await onSelected(512);
      }
      return 512;
    },
    setState: async () => {},
    OTP_POLL_INTERVAL_MS: 4000,
    autoRunActive: false,
    requestOtpTimeoutPause: async () => {},
  });

  const code = await pollVerificationCodeWithRetry(4, { emailProvider: 'mail_2925' }, {
    filterAfterTimestamp: 0,
    senderFilters: [],
    subjectFilters: [],
    targetEmail: 'demochild@2925.com',
    excludeCodes: [],
    successLogMessage: (value) => `步骤 4：已获取验证码：${value}`,
    failureLabel: '未收到注册验证码邮件',
  });

  assert.equal(code, '246810');
  assert.equal(logs.some((entry) => /开始等待 512ms/.test(entry.message)), true);
  assert.equal(logs.some((entry) => /等待结束.*开始下一轮邮箱扫描/.test(entry.message)), true);
});

await test('日志区仅在原本贴底时才自动吸附到底部', async () => {
  const createAppendLog = (logArea) => loadFunction('sidepanel/sidepanel.js', 'appendLog', {
    LEVEL_LABELS: { info: '信息' },
    logArea,
    escapeHtml: (text) => String(text),
    document: {
      createElement: () => ({ className: '', innerHTML: '' }),
    },
  });

  const farFromBottom = {
    scrollTop: 24,
    scrollHeight: 500,
    clientHeight: 120,
    appendChild: () => {},
  };
  createAppendLog(farFromBottom)({
    timestamp: Date.now(),
    level: 'info',
    message: '步骤 4：测试日志',
  });
  assert.equal(farFromBottom.scrollTop, 24);

  const nearBottom = {
    scrollTop: 382,
    scrollHeight: 500,
    clientHeight: 120,
    appendChild: () => {},
  };
  createAppendLog(nearBottom)({
    timestamp: Date.now(),
    level: 'info',
    message: '步骤 7：测试日志',
  });
  assert.equal(nearBottom.scrollTop, 500);
});
