// content/2925-mail.js — 2925 邮箱主邮箱识别与验证码轮询

const MAIL_2925_PREFIX = '[SimpleAuthFlow:mail-2925]';
const isTopFrame2925 = window === window.top;

const {
  build2925MessageFromRowSnapshot = () => null,
  detect2925MainEmailFromPageSnapshot = () => null,
  extractVerificationCode = () => null,
  select2925VerificationMessage = () => null,
} = globalThis.MultiPage2925Mail || {};

console.log(MAIL_2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame2925 ? 'top' : 'child');

let seen2925Codes = new Set();

async function loadSeen2925Codes() {
  try {
    const data = await chrome.storage.session.get('seen2925Codes');
    if (data.seen2925Codes && Array.isArray(data.seen2925Codes)) {
      seen2925Codes = new Set(data.seen2925Codes);
    }
  } catch (err) {
    console.warn(MAIL_2925_PREFIX, 'Session storage unavailable, using in-memory 2925 seen codes:', err?.message || err);
  }
}

loadSeen2925Codes();

async function persistSeen2925Codes() {
  try {
    await chrome.storage.session.set({ seen2925Codes: [...seen2925Codes] });
  } catch (err) {
    console.warn(MAIL_2925_PREFIX, 'Could not persist 2925 seen codes, continuing in-memory only:', err?.message || err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POLL_EMAIL' && message.type !== 'FETCH_2925_MAIN_EMAIL') {
    return;
  }

  if (!isTopFrame2925) {
    sendResponse({ ok: false, reason: 'wrong-frame' });
    return;
  }

  resetStopState();
  const handler = message.type === 'FETCH_2925_MAIN_EMAIL'
    ? handleFetch2925MainEmail()
    : handlePoll2925Mail(message.step, message.payload || {});

  handler.then((result) => {
    sendResponse(result);
  }).catch((err) => {
    if (isStopError(err)) {
      log(`步骤 ${message.step || '2925'}：已被用户停止。`, 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }

    sendResponse({ error: err.message });
  });

  return true;
});

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getElementText(el) {
  return normalizeText(
    el?.innerText
    || el?.textContent
    || el?.getAttribute?.('title')
    || el?.getAttribute?.('aria-label')
    || ''
  );
}

async function waitForCondition(predicate, timeout, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const value = predicate();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(150);
  }

  throw new Error(errorMessage);
}

function getInboxRowElements() {
  return Array.from(document.querySelectorAll('tr.read-mail, tr.unread-mail, tr'))
    .filter((row) => isVisible(row) && row.cells && row.cells.length >= 6 && getElementText(row));
}

function extractRowSubject(row) {
  const title = getElementText(row.querySelector('.mail-content-title'));
  const preview = getElementText(row.querySelector('.mail-content-text'));
  return normalizeText(`${title} ${preview}`);
}

function extractRowTimestampText(row) {
  return getElementText(row.querySelector('.date-time-text'));
}

function getRawTextContent(el) {
  return normalizeText(el?.textContent || '');
}

function extractRowSender(row) {
  return getElementText(
    row.querySelector('td.sender .ivu-tooltip-rel')
    || row.querySelector('td.sender')
  );
}

function extractRowSenderDetail(row) {
  return getRawTextContent(row.querySelector('td.sender .ivu-tooltip-inner'));
}

function collectRowSnapshots() {
  return getInboxRowElements().map((row) => ({
    preview: getElementText(row.querySelector('.mail-content-text')),
    rawText: getRawTextContent(row),
    sender: extractRowSender(row),
    senderDetail: extractRowSenderDetail(row),
    subject: extractRowSubject(row),
    timestampText: extractRowTimestampText(row),
  }));
}

function getRefreshControl() {
  return Array.from(document.querySelectorAll('div.tool-common, button, [role="button"], span'))
    .filter(isVisible)
    .find((el) => getElementText(el) === '刷新');
}

function getInboxTab() {
  return Array.from(document.querySelectorAll('li, div, span, a'))
    .filter(isVisible)
    .find((el) => getElementText(el) === '收件箱');
}

function collectVisibleTextsFromSelectors(selectors = []) {
  const seen = new Set();
  const texts = [];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisible(element)) continue;

      const text = getElementText(element);
      if (!text || seen.has(text)) continue;

      seen.add(text);
      texts.push(text);
    }
  }

  return texts;
}

function collectPreferredMainEmailTexts() {
  const selectors = [
    'header',
    'aside',
    '.header',
    '.top',
    '.top-bar',
    '.toolbar',
    '.sidebar',
    '.userinfo',
    '.user-info',
    '.account',
    '.account-info',
    '.mail-account',
    '.mail-user',
    '[class*="user"]',
    '[class*="account"]',
    '[class*="email"]',
    '[class*="mail"]',
    '[title*="@2925.com"]',
    '[aria-label*="@2925.com"]',
  ];

  return collectVisibleTextsFromSelectors(selectors)
    .filter((text) => text.includes('@2925.com') || /当前|账号|邮箱/.test(text));
}

function collectFallbackMainEmailTexts() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return bodyText ? [bodyText] : [];
}

function buildMainEmailSnapshot() {
  return {
    fallbackTexts: collectFallbackMainEmailTexts(),
    preferredTexts: collectPreferredMainEmailTexts(),
  };
}

function has2925MailboxShell() {
  if (!location.hash.startsWith('#/mailList')) {
    return false;
  }

  return Boolean(
    getRefreshControl()
    || getInboxTab()
    || document.querySelector('table')
    || collectPreferredMainEmailTexts().length > 0
  );
}

function hasMailListFailureNotice() {
  const bodyText = normalizeText(document.body?.innerText || '');
  if (!bodyText) {
    return false;
  }

  return [
    '访问邮件列表失败',
    '邮件列表失败',
    '点击刷新',
    '加载失败',
  ].some((keyword) => bodyText.includes(keyword));
}

function isRecoverableMailListState() {
  if (!location.hash.startsWith('#/mailList')) {
    return false;
  }

  return hasMailListFailureNotice() || (has2925MailboxShell() && getInboxRowElements().length === 0);
}

function isRecoverableMailListError(error) {
  const message = normalizeText(error?.message || error || '');
  return Boolean(message) && (
    message.includes('访问邮件列表失败')
    || message.includes('邮件列表失败')
    || message.includes('邮件列表暂未就绪')
    || message.includes('未检测到 2925 主邮箱')
  );
}

async function recoverMailListSurface(reason = '邮件列表暂未就绪') {
  const refreshControl = getRefreshControl();
  if (refreshControl) {
    log(`2925 邮箱：${reason}，已点击刷新继续等待...`, 'warn');
    await humanPause(120, 260);
    simulateClick(refreshControl);
    await sleep(1200);
    return 'refresh';
  }

  log(`2925 邮箱：${reason}，准备整页刷新后继续等待...`, 'warn');
  location.reload();
  await sleep(1600);
  return 'reload';
}

async function ensureMailListPage() {
  if (!location.hash.startsWith('#/mailList')) {
    location.hash = '#/mailList';
    await sleep(700);
  }

  const startedAt = Date.now();
  let shellSeenAt = 0;
  let recoveryAttempts = 0;

  while (Date.now() - startedAt < 10000) {
    throwIfStopped();

    const rows = getInboxRowElements();
    if (rows.length > 0) {
      return rows;
    }

    const inboxTab = getInboxTab();
    if (inboxTab) {
      simulateClick(inboxTab);
    }

    if (hasMailListFailureNotice() && recoveryAttempts < 2) {
      recoveryAttempts += 1;
      await recoverMailListSurface('检测到访问邮件列表失败');
      continue;
    }

    if (has2925MailboxShell()) {
      if (!shellSeenAt) {
        shellSeenAt = Date.now();
      }

      if (Date.now() - shellSeenAt >= 1500 && recoveryAttempts < 2) {
        recoveryAttempts += 1;
        await recoverMailListSurface('邮件列表暂未显示');
        shellSeenAt = Date.now();
        continue;
      }
    } else {
      shellSeenAt = 0;
    }

    await sleep(250);
  }

  if (isRecoverableMailListState()) {
    throw new Error('2925 邮件列表暂未就绪，请继续刷新后重试。');
  }

  throw new Error('未检测到 2925 主邮箱，请先登录 2925 邮箱并打开收件箱页面。');
}

async function refreshInbox() {
  try {
    await ensureMailListPage();
  } catch (err) {
    if (!isRecoverableMailListError(err)) {
      throw err;
    }
  }

  const refreshControl = getRefreshControl();
  if (refreshControl) {
    await humanPause(120, 260);
    simulateClick(refreshControl);
    await sleep(1200);
  } else if (isRecoverableMailListState()) {
    await recoverMailListSurface('邮件列表暂未就绪');
  } else {
    throw new Error('未检测到 2925 主邮箱，请先登录 2925 邮箱并打开收件箱页面。');
  }

  try {
    await ensureMailListPage();
  } catch (err) {
    if (!isRecoverableMailListError(err)) {
      throw err;
    }
  }
}

function collectMessagesForTarget(targetEmail) {
  return collectRowSnapshots()
    .slice(0, 10)
    .map((snapshot) => build2925MessageFromRowSnapshot(snapshot, {
      referenceDate: new Date(),
      targetEmail,
    }))
    .filter((message) => message.matchedEmail || extractVerificationCode(message.combinedText));
}

async function findMatching2925VerificationResult({
  allowExistingMessages = true,
  existingMessageIds = [],
  filterAfterTimestamp = 0,
  senderFilters = [],
  subjectFilters = [],
  targetEmail = '',
  timeoutMs = 2500,
}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();

    const messages = collectMessagesForTarget(targetEmail);
    const result = select2925VerificationMessage(messages, {
      allowExistingMessages,
      existingMessageIds,
      filterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail,
    });

    if (result?.code) return result;

    await sleep(250);
  }

  return null;
}

async function handleFetch2925MainEmail() {
  await ensureMailListPage();

  let snapshot = buildMainEmailSnapshot();
  let detected = detect2925MainEmailFromPageSnapshot(snapshot);

  if (!detected?.email) {
    log('2925 邮箱：首次识别主邮箱失败，准备刷新收件箱后重试...', 'warn');
    await refreshInbox();
    snapshot = buildMainEmailSnapshot();
    detected = detect2925MainEmailFromPageSnapshot(snapshot);
  }

  if (!detected?.email) {
    throw new Error('当前页面未识别到可用的 2925 主邮箱，请确认页面已完全加载后重试。');
  }

  return {
    ok: true,
    detectionMode: detected.detectionMode || (detected.preferred ? 'preferred' : 'fallback'),
    domain: detected.domain,
    email: detected.email,
    localPart: detected.localPart,
  };
}

async function handlePoll2925Mail(step, payload = {}) {
  const fallbackAfter = 3;
  const {
    filterAfterTimestamp = 0,
    intervalMs = 3000,
    maxAttempts = 20,
    senderFilters = [],
    subjectFilters = [],
    targetEmail = '',
    excludeCodes = [],
  } = payload;
  const excludedCodeSet = new Set((excludeCodes || []).filter(Boolean));

  if (!targetEmail) {
    throw new Error('未找到当前子邮箱，请先执行步骤 3 生成 2925 子邮箱。');
  }

  await ensureMailListPage();
  log(`步骤 ${step}：开始轮询 2925 收件箱（目标邮箱：${targetEmail}）`, 'info');
  const existingMessageIds = new Set(
    collectMessagesForTarget(targetEmail).map((message) => message.messageId).filter(Boolean)
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allowExistingMessages = attempt > fallbackAfter;
    log(`步骤 ${step}：正在轮询 2925 收件箱，第 ${attempt}/${maxAttempts} 次`, 'info');
    try {
      await refreshInbox();
    } catch (err) {
      if (isRecoverableMailListError(err)) {
        log(`步骤 ${step}：2925 邮件列表暂不可用，继续等待后重试：${err.message}`, 'warn');
        if (attempt < maxAttempts) {
          await sleep(intervalMs);
          continue;
        }
        break;
      }
      throw err;
    }

    const result = await findMatching2925VerificationResult({
      allowExistingMessages,
      existingMessageIds: [...existingMessageIds],
      filterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail,
      timeoutMs: 2500,
    });

    if (result?.code) {
      if (excludedCodeSet.has(result.code)) {
        log(`步骤 ${step}：跳过排除的 2925 验证码：${result.code}`, 'info');
        continue;
      }
      if (seen2925Codes.has(result.code)) {
        log(`步骤 ${step}：跳过已处理过的 2925 验证码：${result.code}`, 'info');
      } else {
        seen2925Codes.add(result.code);
        await persistSeen2925Codes();
        log(`步骤 ${step}：已找到验证码 ${result.code}`, 'ok');
        return { ok: true, ...result };
      }
    }

    if (attempt === fallbackAfter + 1) {
      log(`步骤 ${step}：连续 ${fallbackAfter} 次未发现新邮件，开始回退检查旧的匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  if (step === 7 && filterAfterTimestamp > 0) {
    throw new Error('2925 收件箱中未找到比上一次更新更新的验证码邮件，请稍后重试。');
  }

  throw new Error('2925 收件箱中暂未找到当前子邮箱的验证码邮件。');
}
