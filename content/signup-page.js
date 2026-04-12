// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[SimpleAuthFlow:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP8_FIND_AND_CLICK' || message.type === 'RESEND_VERIFICATION_EMAIL') {
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step || 8}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK' || message.type === 'RESEND_VERIFICATION_EMAIL') {
        const actionLabel = message.type === 'RESEND_VERIFICATION_EMAIL'
          ? `步骤 ${message.step}：${err.message}`
          : `步骤 8：${err.message}`;
        log(actionLabel, 'error');
        sendResponse({ error: err.message });
        return;
      }

      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 8: return await step8_findAndClick();
        default: throw new Error(`signup-page.js 不处理步骤 ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'RESEND_VERIFICATION_EMAIL':
      return await resendVerificationEmail(message.step, message.payload);
  }
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('步骤 2：正在查找 Register / Sign up 按钮...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        '找不到 Register / Sign up 按钮。' +
        '请在 DevTools 中检查授权页 DOM。URL：' + location.href
      );
    }
  }

  await humanPause(450, 1200);
  reportComplete(2);
  simulateClick(registerBtn);
  log('步骤 2：已点击注册按钮');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('缺少邮箱地址，请先在侧边栏粘贴邮箱。');

  log(`步骤 3：正在填写邮箱：${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('在注册页中找不到邮箱输入框。URL：' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('步骤 3：邮箱已填写');

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('步骤 3：暂未发现密码输入框，先提交邮箱...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      await humanPause(400, 1100);
      simulateClick(submitBtn);
      log('步骤 3：邮箱已提交，正在等待密码输入框...');
      await sleep(2000);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('提交邮箱后找不到密码输入框。URL：' + location.href);
    }
  }

  if (!payload.password) throw new Error('缺少密码，步骤 3 需要提供生成后的密码。');
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('步骤 3：密码已填写');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('步骤 3：表单已提交');
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('缺少验证码。');

  log(`步骤 ${step}：正在填写验证码：${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`步骤 ${step}：检测到单字符验证码输入框，正在逐个填写...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleep(1000);
      reportComplete(step);
      return;
    }
    throw new Error('找不到验证码输入框。URL：' + location.href);
  }

  fillInput(codeInput, code);
  log(`步骤 ${step}：验证码已填写`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`步骤 ${step}：验证码已提交`);
  }
}

async function resendVerificationEmail(step, payload = {}) {
  const { clicks = 2 } = payload;
  let lastClickResult = {
    clicked: false,
    clicks: 0,
    buttonText: '',
    method: 'unknown',
    recoveredByGoingBack: false,
  };

  log(`步骤 ${step}：正在查找重发邮件按钮...`);

  for (let i = 0; i < clicks; i++) {
    const resendBtn = await waitForResendButton(10000);
    const buttonText = String(resendBtn?.textContent || resendBtn?.value || resendBtn?.getAttribute?.('aria-label') || '').trim();
    let method = 'text-match';
    if (resendBtn?.matches?.('button[name="intent"][value="resend"]')) {
      method = 'intent-resend';
    } else if (resendBtn?.matches?.('button[value="resend"]')) {
      method = 'value-resend';
    } else if (resendBtn?.matches?.('button[type="submit"][name="intent"]')) {
      method = 'submit-intent';
    }

    await humanPause(350, 900);
    simulateClick(resendBtn);
    log(`步骤 ${step}：已点击重发邮件按钮（${i + 1}/${clicks}）`);
    lastClickResult = {
      clicked: true,
      clicks: i + 1,
      buttonText,
      method,
      recoveredByGoingBack: false,
    };
    await sleep(700);
  }

  return lastClickResult;
}

async function waitForResendButton(timeout = 10000) {
  const selector = 'button[name="intent"][value="resend"], button[value="resend"], button[type="submit"][name="intent"]';
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const directMatch = Array.from(document.querySelectorAll(selector)).find(btn => {
      const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      return !disabled && isElementVisible(btn);
    });
    if (directMatch) return directMatch;

    const textMatch = Array.from(document.querySelectorAll('button, [role="button"]')).find(btn => {
      const text = btn.textContent || '';
      const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      return !disabled && isElementVisible(btn) && /resend|send again|重新发送电子邮件|重新发送/i.test(text);
    });
    if (textMatch) return textMatch;

    await sleep(250);
  }

  throw new Error('在验证页面中找不到重发邮件按钮。URL：' + location.href);
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('登录时缺少邮箱地址。');

  log(`步骤 6：正在使用 ${email} 登录...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('在登录页中找不到邮箱输入框。URL：' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('步骤 6：邮箱已填写');

  // Submit email
  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('步骤 6：邮箱已提交');
  }

  const passwordInput = await waitForLoginPasswordField();
  if (passwordInput) {
    log('步骤 6：已发现密码输入框，正在填写密码...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('步骤 6：密码已提交，接下来可能需要验证码（步骤 7）');
    }
    return;
  }

  // No password field — OTP flow
  log('步骤 6：未发现密码输入框，可能走 OTP 流程或自动跳转。');
  reportComplete(6, { needsOTP: true });
}

async function waitForLoginPasswordField(timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const passwordInput = findVisiblePasswordInput();
    if (passwordInput) {
      return passwordInput;
    }

    await sleep(250);
  }

  log(`步骤 6：${Math.round(timeout / 1000)} 秒内未出现密码输入框。`, 'warn');
  return null;
}

function findVisiblePasswordInput() {
  const inputs = document.querySelectorAll('input[type="password"]');
  for (const input of inputs) {
    if (isElementVisible(input)) {
      return input;
    }
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('步骤 8：正在查找 OAuth 授权确认页中的“继续”按钮...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(250);

  const rect = getSerializableRect(continueBtn);
  log('步骤 8：已找到“继续”按钮，并准备好调试器点击坐标。');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('在 OAuth 授权确认页中找不到“继续”按钮。URL：' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('“继续”按钮保持禁用状态过久。URL：' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('滚动后“继续”按钮没有可点击尺寸。URL：' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('缺少姓名数据。');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('缺少生日或年龄数据。');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`步骤 5：正在填写姓名：${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('找不到姓名输入框。URL：' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`步骤 5：姓名已填写：${fullName}`);

  let birthdayMode = false;
  let dropdownMode = false;
  let dropdownButtons = [];
  let ageInput = null;
  const birthdayDropdownSelector = 'button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]';

  function readDropdownLabelText(button) {
    const labelledIds = (button.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean);
    const labelledText = labelledIds
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ');

    return [
      button.getAttribute('aria-label') || '',
      labelledText,
      button.previousElementSibling?.textContent || '',
      button.parentElement?.textContent || '',
    ].join(' ');
  }

  function readBirthdayDropdownButtons() {
    const fieldset = Array.from(document.querySelectorAll('fieldset')).find((fs) => {
      const legend = fs.querySelector('legend');
      return legend && /birthday|date\s+of\s+birth|出生|生日/i.test(legend.textContent || '');
    });

    if (fieldset) {
      const fieldsetButtons = Array.from(fieldset.querySelectorAll(birthdayDropdownSelector)).filter(isElementVisible);
      if (fieldsetButtons.length >= 3) return fieldsetButtons;
    }

    const visibleButtons = Array.from(document.querySelectorAll(birthdayDropdownSelector)).filter(isElementVisible);
    const labelledButtons = visibleButtons.filter((button) => {
      const normalized = String(readDropdownLabelText(button) || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return /birthday|date of birth|出生|生日|(^| )year( |$)|(^| )month( |$)|(^| )day( |$)|年份|月份|日期|日|月/.test(normalized);
    });
    if (labelledButtons.length >= 3) return labelledButtons;

    const formButtons = nameInput?.closest?.('form')
      ? Array.from(nameInput.closest('form').querySelectorAll(birthdayDropdownSelector)).filter(isElementVisible)
      : [];
    if (formButtons.length >= 3) return formButtons;

    return visibleButtons.length === 3 ? visibleButtons : [];
  }

  for (let i = 0; i < 100; i++) {
    ageInput = document.querySelector('input[name="age"]');

    // Some pages include a hidden birthday input even though the real UI is "age".
    // In that case we must prioritize filling age to satisfy required validation.
    if (ageInput) break;

    const birthdayButtons = readBirthdayDropdownButtons();
    if (birthdayButtons.length >= 3) {
      dropdownMode = true;
      dropdownButtons = birthdayButtons;
      break;
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const hiddenBirthday = document.querySelector('input[name="birthday"]');

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  function normalizeText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function monthTextCandidates(monthValue) {
    const monthIndex = Number(monthValue) - 1;
    const monthLong = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const monthAliases = [
      ['jan'],
      ['feb'],
      ['mar'],
      ['apr'],
      ['may'],
      ['jun'],
      ['jul'],
      ['aug'],
      ['sep', 'sept'],
      ['oct'],
      ['nov'],
      ['dec'],
    ];
    const candidates = [
      String(monthValue),
      String(monthValue).padStart(2, '0'),
      `${Number(monthValue)}月`,
    ];
    if (monthIndex >= 0 && monthIndex < 12) {
      candidates.push(monthLong[monthIndex], ...monthAliases[monthIndex]);
    }
    return candidates.map(normalizeText);
  }

  function extractNumberishValue(text) {
    const match = normalizeText(text).match(/^(\d{1,4})(?:\s*(?:月|日|号|年))?$/);
    return match ? Number(match[1]) : Number.NaN;
  }

  async function waitForVisibleListbox(button, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      throwIfStopped();

      const controlsId = button.getAttribute('aria-controls');
      if (controlsId) {
        const controlled = document.getElementById(controlsId);
        if (controlled && controlled.getAttribute('role') === 'listbox' && isElementVisible(controlled)) {
          return controlled;
        }
      }

      const visibleListboxes = Array.from(document.querySelectorAll('[role="listbox"]'))
        .filter((el) => isElementVisible(el) && el.querySelector('[role="option"]'));
      if (visibleListboxes.length === 1) {
        return visibleListboxes[0];
      }

      const labelledBy = button.getAttribute('aria-labelledby');
      if (labelledBy) {
        const match = visibleListboxes.find((listbox) => {
          const popupLabel = normalizeText(listbox.getAttribute('aria-labelledby') || '');
          return popupLabel && popupLabel === normalizeText(labelledBy);
        });
        if (match) return match;
      }

      await sleep(100);
    }

    throw new Error('等待生日下拉列表框超时。URL：' + location.href);
  }

  function detectDropdownKindFromLabel(button) {
    const nearbyText = readDropdownLabelText(button);
    const normalized = normalizeText(nearbyText);
    if (/(^| )year( |$)|年份|年(?!龄)/i.test(normalized)) return 'year';
    if (/(^| )month( |$)|月份|月/i.test(normalized)) return 'month';
    if (/(^| )day( |$)|日期|日/i.test(normalized)) return 'day';
    return null;
  }

  function detectDropdownKindFromOptions(options) {
    const optionValues = options
      .map((opt) => normalizeText(opt.getAttribute('data-key') || opt.textContent || ''))
      .filter(Boolean);
    if (!optionValues.length) return null;

    if (optionValues.some((value) => /^(19|20)\d{2}(?:年)?$/.test(value))) {
      return 'year';
    }

    if (optionValues.some((value) => /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/.test(value))) {
      return 'month';
    }

    if (optionValues.some((value) => /^\d{1,2}\s*月$/.test(value))) {
      return 'month';
    }

    if (optionValues.some((value) => /^\d{1,2}\s*(?:日|号)$/.test(value))) {
      return 'day';
    }

    const numericValues = optionValues
      .map((value) => extractNumberishValue(value))
      .filter((value) => !Number.isNaN(value));

    if (numericValues.length === optionValues.length && numericValues.length) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      if (min >= 1 && max <= 12 && optionValues.length <= 12) return 'month';
      if (min >= 1 && max <= 31 && optionValues.length >= 28) return 'day';
    }

    return null;
  }

  async function inferDropdownKind(button) {
    const labeledKind = detectDropdownKindFromLabel(button);
    if (labeledKind) return labeledKind;

    simulateClick(button);
    await sleep(250);
    const listbox = await waitForVisibleListbox(button);
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    const detectedKind = detectDropdownKindFromOptions(options);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleep(150);
    return detectedKind;
  }

  async function mapBirthdayButtons(buttons) {
    const mapping = {};
    for (const button of buttons) {
      const kind = await inferDropdownKind(button);
      if (kind && !mapping[kind]) {
        mapping[kind] = button;
      }
    }
    return mapping;
  }

  function optionMatchesValue(option, kind, value) {
    const optionKey = normalizeText(option.getAttribute('data-key') || '');
    const optionText = normalizeText(option.textContent || '');
    const numericValue = Number(value);

    if (kind === 'year') {
      return optionKey === String(value) || optionText === String(value) || extractNumberishValue(optionKey) === numericValue || extractNumberishValue(optionText) === numericValue;
    }

    if (kind === 'month') {
      const monthCandidates = new Set(monthTextCandidates(value));
      if (monthCandidates.has(optionKey) || monthCandidates.has(optionText)) return true;
    }

    if (kind === 'day' || kind === 'month') {
      if (extractNumberishValue(optionKey) === numericValue || extractNumberishValue(optionText) === numericValue) {
        return true;
      }
    }

    return false;
  }

  async function selectDropdownOption(button, kind, value) {
    simulateClick(button);
    await sleep(250);
    const listbox = await waitForVisibleListbox(button);
    await sleep(100);

    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    const target = options.find((option) => optionMatchesValue(option, kind, value));
    if (!target) {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      throw new Error(`找不到 ${kind} 对应值“${value}”的下拉选项。`);
    }

    await humanPause(150, 350);
    simulateClick(target);
    await sleep(300);
  }

  let dropdownFilled = false;
  if (dropdownMode) {
    if (!hasBirthdayData) {
      throw new Error('检测到生日下拉框，但未提供生日数据。');
    }

    try {
      log('步骤 5：检测到生日下拉框，正在填写生日...');
      const birthdayButtonsByKind = await mapBirthdayButtons(dropdownButtons);
      const yearButton = birthdayButtonsByKind.year;
      const monthButton = birthdayButtonsByKind.month;
      const dayButton = birthdayButtonsByKind.day;

      if (!yearButton || !monthButton || !dayButton) {
        throw new Error('无法将生日下拉框映射到年 / 月 / 日字段。');
      }

      await humanPause(450, 1100);
      await selectDropdownOption(yearButton, 'year', year);
      await humanPause(250, 650);
      await selectDropdownOption(monthButton, 'month', month);
      await humanPause(250, 650);
      await selectDropdownOption(dayButton, 'day', day);
      log(`步骤 5：生日已填写：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

      const hiddenBirthday = document.querySelector('input[name="birthday"]');
      if (hiddenBirthday) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        fillInput(hiddenBirthday, dateStr);
        log(`步骤 5：隐藏生日输入已同步：${dateStr}`);
      }
      dropdownFilled = true;
    } catch (err) {
      log(`步骤 5：生日下拉框填写失败，改用兜底方案。${err.message}`, 'warn');
      const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
      const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
      const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
      const hiddenBirthday = document.querySelector('input[name="birthday"]');
      birthdayMode = Boolean((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday);
    }
  }

  if (!dropdownFilled && birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('检测到生日字段，但未提供生日数据。');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    if (yearSpinner && monthSpinner && daySpinner) {
      log('步骤 5：检测到生日微调按钮，正在填写生日...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);

        document.execCommand?.('selectAll', false, null);
        await sleep(50);

        if (typeof InputEvent === 'function') {
          const clearEvents = [
            new InputEvent('beforeinput', { inputType: 'deleteContentBackward', data: null, bubbles: true }),
            new InputEvent('input', { inputType: 'deleteContentBackward', data: null, bubbles: true }),
          ];
          for (const event of clearEvents) {
            el.dispatchEvent(event);
          }
        }

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          if (typeof InputEvent === 'function') {
            el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          }
          await sleep(50);
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Digit${char}`, bubbles: true }));
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur?.();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`步骤 5：生日已填写：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      const hiddenBirthday = document.querySelector('input[type="hidden"][name="birthday"]');
      if (hiddenBirthday) {
        hiddenBirthday.value = dateStr;
        hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
        log(`步骤 5：隐藏生日输入已设置：${dateStr}`);
      }
    } else {
      const hiddenBirthday = document.querySelector('input[name="birthday"]');
      if (hiddenBirthday) {
        hiddenBirthday.value = dateStr;
        hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
        log(`步骤 5：已通过隐藏输入设置生日：${dateStr}`);
      } else {
        log('步骤 5：警告 - 找不到生日字段，可能需要调整选择器。', 'warn');
      }
    }
  } else if (!dropdownFilled && ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('检测到年龄字段，但未提供年龄数据。');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`步骤 5：年龄已填写：${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      fillInput(hiddenBirthday, dateStr);
      log(`步骤 5：隐藏生日输入已设置（年龄模式）：${dateStr}`);
    }
  } else if (!dropdownFilled) {
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`步骤 5：已通过隐藏输入设置生日：${dateStr}`);
    } else {
      log('步骤 5：警告 - 找不到生日字段，可能需要调整选择器。', 'warn');
    }
  }

  const consentCheckbox = document.querySelector('input[name="allCheckboxes"], input#_r_h_-allCheckboxes');
  if (consentCheckbox && !consentCheckbox.checked) {
    await humanPause(300, 800);

    const consentLabel = consentCheckbox.closest('label')
      || document.querySelector('label[for="_r_h_-allCheckboxes"]')
      || consentCheckbox.parentElement;

    if (consentLabel) {
      simulateClick(consentLabel);
    } else {
      consentCheckbox.click();
    }

    await sleep(300);
    if (!consentCheckbox.checked) {
      consentCheckbox.checked = true;
      consentCheckbox.dispatchEvent(new Event('input', { bubbles: true }));
      consentCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    log('步骤 5：已勾选同意复选框');
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(5);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log('步骤 5：已点击“完成帐户创建”');
  }
}
