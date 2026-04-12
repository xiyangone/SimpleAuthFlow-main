// content/mail-163.js — 163 邮箱验证码轮询

const MAIL163_PREFIX = '[SimpleAuthFlow:mail-163]';
const isTopFrame163 = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame163 ? 'top' : 'child');

if (!isTopFrame163) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {
  let seenCodes = new Set();

  async function loadSeenCodes() {
    try {
      const data = await chrome.storage.session.get('seenCodes');
      if (data.seenCodes && Array.isArray(data.seenCodes)) {
        seenCodes = new Set(data.seenCodes);
      }
    } catch (err) {
      console.warn(MAIL163_PREFIX, 'Session storage unavailable, using in-memory seen codes:', err?.message || err);
    }
  }

  loadSeenCodes();

  async function persistSeenCodes() {
    try {
      await chrome.storage.session.set({ seenCodes: [...seenCodes] });
    } catch (err) {
      console.warn(MAIL163_PREFIX, 'Could not persist seen codes, continuing in-memory only:', err?.message || err);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'POLL_EMAIL') {
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
      log(`步骤 ${message.step}：163 邮箱轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  });

  function findMailItems() {
    return document.querySelectorAll('div[sign="letter"]');
  }

  function getCurrentMailIds() {
    const ids = new Set();
    findMailItems().forEach((item) => {
      const id = item.getAttribute('id') || '';
      if (id) ids.add(id);
    });
    return ids;
  }

  function normalizeMinuteTimestamp(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    const date = new Date(timestamp);
    date.setSeconds(0, 0);
    return date.getTime();
  }

  function parseMail163Timestamp(rawText) {
    const text = (rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
    if (match) {
      const [, year, month, day, hour, minute] = match;
      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        0,
        0
      ).getTime();
    }

    match = text.match(/\b(\d{1,2}):(\d{2})\b/);
    if (match) {
      const [, hour, minute] = match;
      const now = new Date();
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        Number(hour),
        Number(minute),
        0,
        0
      ).getTime();
    }

    return null;
  }

  function getMailTimestamp(item) {
    const candidates = [];
    const timeCell = item.querySelector('.e00[title], [title*="年"][title*=":"]');
    if (timeCell?.getAttribute('title')) candidates.push(timeCell.getAttribute('title'));
    if (timeCell?.textContent) candidates.push(timeCell.textContent);

    const titledNodes = item.querySelectorAll('[title]');
    titledNodes.forEach((node) => {
      const title = node.getAttribute('title');
      if (title) candidates.push(title);
    });

    for (const candidate of candidates) {
      const parsed = parseMail163Timestamp(candidate);
      if (parsed) return parsed;
    }

    return null;
  }

  async function handlePollEmail(step, payload) {
    const {
      senderFilters = [],
      subjectFilters = [],
      maxAttempts = 20,
      intervalMs = 3000,
      excludeCodes = [],
      filterAfterTimestamp = 0,
    } = payload;
    const excludedCodeSet = new Set(excludeCodes.filter(Boolean));
    const filterAfterMinute = normalizeMinuteTimestamp(Number(filterAfterTimestamp) || 0);

    log(`步骤 ${step}：开始轮询 163 邮箱（最多 ${maxAttempts} 次）`);
    if (filterAfterMinute) {
      log(`步骤 ${step}：只检查 ${new Date(filterAfterMinute).toLocaleString('zh-CN', { hour12: false })} 及之后的邮件`);
    }

    try {
      const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"]', 5000);
      inboxLink.click();
      log(`步骤 ${step}：已点击收件箱`);
    } catch {
      log(`步骤 ${step}：未找到收件箱入口，继续尝试后续流程...`, 'warn');
    }

    let items = [];
    for (let i = 0; i < 20; i += 1) {
      items = findMailItems();
      if (items.length > 0) break;
      await sleep(500);
    }

    if (items.length === 0) {
      await refreshInbox();
      await sleep(2000);
      items = findMailItems();
    }

    if (items.length === 0) {
      throw new Error('163 邮箱列表未加载完成，请确认当前已打开收件箱。');
    }

    log(`步骤 ${step}：邮件列表已加载，共 ${items.length} 封邮件`);

    const existingMailIds = getCurrentMailIds();
    log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 封旧邮件快照`);

    const fallbackAfter = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`步骤 ${step}：正在轮询 163 邮箱，第 ${attempt}/${maxAttempts} 次`);

      if (attempt > 1) {
        await refreshInbox();
        await sleep(1000);
      }

      const allItems = findMailItems();
      const useFallback = attempt > fallbackAfter;

      for (const item of allItems) {
        const id = item.getAttribute('id') || '';
        const mailTimestamp = getMailTimestamp(item);
        const mailMinute = normalizeMinuteTimestamp(mailTimestamp || 0);
        const passesTimeFilter = !filterAfterMinute || (mailMinute && mailMinute >= filterAfterMinute);
        const shouldBypassOldSnapshot = Boolean(filterAfterMinute && passesTimeFilter && mailMinute > 0);

        if (!passesTimeFilter) continue;
        if (!useFallback && !shouldBypassOldSnapshot && existingMailIds.has(id)) continue;

        const senderEl = item.querySelector('.nui-user');
        const sender = senderEl ? senderEl.textContent.toLowerCase() : '';

        const subjectEl = item.querySelector('span.da0');
        const subject = subjectEl ? subjectEl.textContent : '';

        const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

        const senderMatch = senderFilters.some((filter) => sender.includes(filter.toLowerCase()) || ariaLabel.includes(filter.toLowerCase()));
        const subjectMatch = subjectFilters.some((filter) => subject.toLowerCase().includes(filter.toLowerCase()) || ariaLabel.includes(filter.toLowerCase()));

        if (senderMatch || subjectMatch) {
          const code = extractVerificationCode(`${subject} ${ariaLabel}`);
          if (code && excludedCodeSet.has(code)) {
            log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
          } else if (code && !seenCodes.has(code)) {
            seenCodes.add(code);
            persistSeenCodes();
            const source = useFallback && existingMailIds.has(id) ? '回退匹配邮件' : '新邮件';
            const timeLabel = mailTimestamp ? `，时间：${new Date(mailTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
            log(`步骤 ${step}：已找到验证码：${code}（来源：${source}${timeLabel}）`, 'ok');

            await deleteEmail(item, step);
            await sleep(1000);

            return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
          } else if (code && seenCodes.has(code)) {
            log(`步骤 ${step}：跳过已处理过的验证码：${code}`, 'info');
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
      `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 163 邮箱中找到新的匹配邮件。请手动检查收件箱。`
    );
  }

  async function deleteEmail(item, step) {
    try {
      log(`步骤 ${step}：正在删除邮件...`);

      item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(300);

      const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"]');
      if (trashIcon) {
        trashIcon.click();
        log(`步骤 ${step}：已点击删除图标`, 'ok');
        await sleep(1500);

        const stillExists = document.getElementById(item.id);
        if (!stillExists || stillExists.style.display === 'none') {
          log(`步骤 ${step}：邮件已成功删除`);
        } else {
          log(`步骤 ${step}：邮件可能尚未删除，列表中仍可见`, 'warn');
        }
        return;
      }

      log(`步骤 ${step}：未找到删除图标，尝试使用复选框加工具栏删除...`);
      const checkbox = item.querySelector('[sign="checkbox"], .nui-chk');
      if (checkbox) {
        checkbox.click();
        await sleep(300);

        const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
        for (const btn of toolbarBtns) {
          if (btn.textContent.replace(/\s/g, '').includes('删除')) {
            btn.closest('.nui-btn').click();
            log(`步骤 ${step}：已点击工具栏删除`, 'ok');
            await sleep(1500);
            return;
          }
        }
      }

      log(`步骤 ${step}：无法删除邮件（未找到删除按钮）`, 'warn');
    } catch (err) {
      log(`步骤 ${step}：删除邮件失败：${err.message}`, 'warn');
    }
  }

  async function refreshInbox() {
    const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
    for (const btn of toolbarBtns) {
      if (btn.textContent.replace(/\s/g, '') === '刷新') {
        btn.closest('.nui-btn').click();
        await sleep(800);
        return;
      }
    }

    const shouXinBtns = document.querySelectorAll('.ra0');
    for (const btn of shouXinBtns) {
      if (btn.textContent.replace(/\s/g, '').includes('收信')) {
        btn.click();
        await sleep(800);
        return;
      }
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
}
