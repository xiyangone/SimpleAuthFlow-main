// content/qq-mail.js — QQ 邮箱验证码轮询

const QQ_MAIL_PREFIX = '[SimpleAuthFlow:qq-mail]';
const isTopFrameQq = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrameQq ? 'top' : 'child');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POLL_EMAIL') {
    return;
  }

  if (!isTopFrameQq) {
    sendResponse({ ok: false, reason: 'wrong-frame' });
    return;
  }

  resetStopState();
  handlePollEmail(message.step, message.payload || {}).then((result) => {
    sendResponse(result);
  }).catch((err) => {
    if (isStopError(err)) {
      log(`步骤 ${message.step}：已被用户停止。`, 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }
    log(`步骤 ${message.step}：QQ 邮箱轮询失败：${err.message}`, 'warn');
    sendResponse({ error: err.message });
  });
  return true;
});

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach((item) => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

async function handlePollEmail(step, payload) {
  const { senderFilters = [], subjectFilters = [], maxAttempts = 20, intervalMs = 3000, excludeCodes = [] } = payload;
  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));

  log(`步骤 ${step}：开始轮询 QQ 邮箱（最多 ${maxAttempts} 次，每 ${intervalMs / 1000} 秒一次）`);

  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`步骤 ${step}：QQ 邮箱列表已加载`);
  } catch {
    throw new Error('邮件列表未加载完成，请确认 QQ 邮箱已打开收件箱。');
  }

  const existingMailIds = getCurrentMailIds();
  log(`步骤 ${step}：已将当前 ${existingMailIds.size} 封邮件标记为旧邮件快照`);

  const fallbackAfter = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(`步骤 ${step}：正在轮询 QQ 邮箱，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(800);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');
    const useFallback = attempt > fallbackAfter;

    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');
      if (!useFallback && existingMailIds.has(mailId)) continue;

      const sender = (item.querySelector('.cmp-account-nick')?.textContent || '').toLowerCase();
      const subject = (item.querySelector('.mail-subject')?.textContent || '').toLowerCase();
      const digest = item.querySelector('.mail-digest')?.textContent || '';

      const senderMatch = senderFilters.some((filter) => sender.includes(filter.toLowerCase()));
      const subjectMatch = subjectFilters.some((filter) => subject.includes(filter.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(`${subject} ${digest}`);
        if (code) {
          if (excludedCodeSet.has(code)) {
            log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
            continue;
          }
          const source = useFallback && existingMailIds.has(mailId) ? '回退首封匹配邮件' : '新邮件';
          log(`步骤 ${step}：已找到验证码：${code}（来源：${source}）`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now(), mailId };
        }
      }
    }

    if (attempt === fallbackAfter + 1) {
      log(`步骤 ${step}：连续 ${fallbackAfter} 次未发现新邮件，开始回退到首封匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未找到新的匹配邮件。请手动检查 QQ 邮箱，邮件可能延迟到达或进入垃圾箱。`
  );
}

async function refreshInbox() {
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleep(500);
    return;
  }

  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    await sleep(500);
    return;
  }

  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    await sleep(500);
  }
}

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}
