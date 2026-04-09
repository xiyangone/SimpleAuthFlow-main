// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[SimpleAuthFlow:bg]';
const BURNER_MAILBOX_URL = 'https://burnermailbox.com/mailbox';
const DEFAULT_VPS_URL = 'http://127.0.0.1:8317/management.html#/oauth';
const BURNER_CHALLENGE_REQUIRED_MESSAGE = 'Burner Mailbox 需要进行安全验证。';
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const RUN_MODE_AUTO = 'auto';
const RUN_MODE_MANUAL = 'manual';
const MANUAL_CODE_LENGTH = 6;
const MANUAL_CODE_PAUSE_ERROR = 'MANUAL_CODE_REQUIRED';

initializeSessionStorageAccess();

let automationWindowId = null;

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  directAuthSuccess: false,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  customPassword: '',
  runMode: RUN_MODE_AUTO,
  manualCodeEntry: null,
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  const merged = { ...DEFAULT_STATE, ...state };
  return {
    ...merged,
    runMode: normalizeRunMode(merged.runMode),
    manualCodeEntry: merged.manualCodeEntry || null,
  };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function ensureAutomationWindowId() {
  if (automationWindowId != null) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      automationWindowId = null;
    }
  }

  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      automationWindowId = tab.windowId;
      return automationWindowId;
    } catch {}
  }

  const win = await chrome.windows.getLastFocused();
  automationWindowId = win.id;
  return automationWindowId;
}

function normalizeVpsUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRunMode(value) {
  return String(value || '').trim() === RUN_MODE_MANUAL ? RUN_MODE_MANUAL : RUN_MODE_AUTO;
}

function isManualRunMode(state) {
  return normalizeRunMode(state?.runMode) === RUN_MODE_MANUAL;
}

function normalizeManualCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, MANUAL_CODE_LENGTH);
}

function buildManualCodeEntry(step) {
  const isLoginStep = Number(step) === 7;
  return {
    step: Number(step),
    codeLength: MANUAL_CODE_LENGTH,
    title: isLoginStep ? '等待输入登录验证码' : '等待输入注册验证码',
    hint: isLoginStep ? '请输入 OpenAI 登录验证码，提交后自动继续。' : '请输入注册验证码，提交后自动继续。',
    submitText: '提交并继续',
  };
}

function getEffectiveVpsUrl(value) {
  return normalizeVpsUrl(value) || DEFAULT_VPS_URL;
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get([
    'seenCodes',
    'seenInbucketMailIds',
    'seenBurnerMailIds',
    'accounts',
    'tabRegistry',
    'vpsUrl',
    'customPassword',
    'runMode',
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    seenBurnerMailIds: prev.seenBurnerMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    customPassword: prev.customPassword || '',
    runMode: normalizeRunMode(prev.runMode),
    manualCodeEntry: null,
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function clearTabRegistration(source) {
  const registry = await getTabRegistry();
  if (registry[source]) {
    delete registry[source];
    await setState({ tabRegistry: registry });
    console.log(LOG_PREFIX, `Tab registration cleared: ${source}`);
  }
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `${source} 页面脚本在 ${timeout / 1000}s 内没有响应，请刷新对应标签页后重试。`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

function isBurnerChallengeError(err) {
  const message = err?.message || String(err || '');
  return message.includes(BURNER_CHALLENGE_REQUIRED_MESSAGE);
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    try {
      const tabId = await getTabId(source);
      const currentTab = await chrome.tabs.get(tabId);
      const sameUrl = currentTab.url === url;
      const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

      const registry = await getTabRegistry();
      if (sameUrl) {
        await chrome.tabs.update(tabId, { active: true });
        console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

        if (shouldReloadOnReuse) {
          if (registry[source]) registry[source].ready = false;
          await setState({ tabRegistry: registry });
          await chrome.tabs.reload(tabId);

          await new Promise((resolve) => {
            const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
            const listener = (tid, info) => {
              if (tid === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }

        if (options.inject) {
          if (registry[source]) registry[source].ready = false;
          await setState({ tabRegistry: registry });
          if (options.injectSource) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (injectedSource) => {
                window.__MULTIPAGE_SOURCE = injectedSource;
              },
              args: [options.injectSource],
            });
          }
          await chrome.scripting.executeScript({
            target: { tabId },
            files: options.inject,
          });
          await new Promise(r => setTimeout(r, 500));
        }

        return tabId;
      }

      if (registry[source]) registry[source].ready = false;
      await setState({ tabRegistry: registry });

      await chrome.tabs.update(tabId, { url, active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

      await new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      if (options.inject) {
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
      }

      await new Promise(r => setTimeout(r, 500));
      return tabId;
    } catch (err) {
      const message = err?.message || String(err);
      if (!options._didRetry && /No tab with id|tab was closed|cannot be edited right now/i.test(message)) {
        console.warn(LOG_PREFIX, `Tab reuse failed for ${source}, clearing stale registration and retrying: ${message}`);
        await clearTabRegistration(source);
        return reuseOrCreateTab(source, url, { ...options, _didRetry: true });
      }
      throw err;
    }
  }

  // Create new tab
  const wid = await ensureAutomationWindowId();
  const tab = await chrome.tabs.create({ url, active: true, windowId: wid });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isManualCodePauseError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === MANUAL_CODE_PAUSE_ERROR;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('未找到用于调试点击的授权页标签。');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('步骤 8 的调试器兜底点击需要有效的按钮坐标。');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `步骤 8 的调试器兜底点击附加失败：${err.message}。` +
      '如果授权页标签已打开 DevTools，请先关闭后再重试。'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;
let autoRunResumeMode = null;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`页面脚本已就绪：${message.source}（标签 ${tabId}）`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`步骤 ${message.step} 已完成`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`步骤 ${message.step} 已被用户停止`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`步骤 ${message.step} 失败：${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('流程已重置', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = normalizeVpsUrl(message.payload.vpsUrl);
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.runMode !== undefined) updates.runMode = normalizeRunMode(message.payload.runMode);
      await setState(updates);
      if (Object.prototype.hasOwnProperty.call(updates, 'runMode')) {
        broadcastDataUpdate({ runMode: updates.runMode });
      }
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'SUBMIT_MANUAL_CODE': {
      return await submitManualCodeAndContinue(message.payload || {});
    }

    case 'FETCH_BURNER_EMAIL': {
      clearStopRequest();
      const email = await fetchBurnerEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'CONTINUE_BURNER_AFTER_CHALLENGE': {
      clearStopRequest();
      const email = await continueBurnerAfterChallenge(message.payload || {});
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `未知的消息类型：${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      } else if (payload.directAuthSuccess) {
        await setState({ directAuthSuccess: true });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('已请求停止，正在取消当前操作...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }
  autoRunResumeMode = null;
  await setState({ manualCodeEntry: null });
  broadcastDataUpdate({ manualCodeEntry: null });

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

async function requestManualCodePause(step) {
  const entry = buildManualCodeEntry(step);
  await setState({ manualCodeEntry: entry });
  await setStepStatus(step, 'stopped');
  await addLog(`步骤 ${step}：等待输入验证码后继续。`, 'warn');
  broadcastDataUpdate({ manualCodeEntry: entry });

  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: {
      phase: 'waiting_manual_code',
      currentRun: autoRunCurrentRun,
      totalRuns: autoRunTotalRuns,
      step,
      manualCodeEntry: entry,
    },
  }).catch(() => {});

  if (autoRunActive) {
    autoRunResumeMode = 'manual_code';
    throw new Error(MANUAL_CODE_PAUSE_ERROR);
  }
}

async function submitManualCodeAndContinue(payload = {}) {
  const state = await getState();
  const step = Number(state.manualCodeEntry?.step || state.currentStep || 0);
  if (step !== 4 && step !== 7) {
    throw new Error('当前没有待填写的人工验证码步骤。');
  }

  const code = normalizeManualCode(payload.code);
  if (code.length !== MANUAL_CODE_LENGTH) {
    throw new Error(`验证码必须是 ${MANUAL_CODE_LENGTH} 位数字。`);
  }

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('授权页标签已关闭，无法填写验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true }).catch(() => {});
  await addLog(`步骤 ${step}：已接收手动验证码，正在继续流程...`);
  await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step,
    source: 'background',
    payload: { code },
  });

  await setState({ manualCodeEntry: null });
  broadcastDataUpdate({ manualCodeEntry: null });

  if (autoRunResumeMode === 'manual_code') {
    await resumeAutoRun();
  }

  return { ok: true, step };
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`步骤 ${step} 开始执行`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`未知步骤：${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`步骤 ${step} 已被用户停止`, 'warn');
      throw err;
    }
    if (isManualCodePauseError(err)) {
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`步骤 ${step} 失败：${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const promise = waitForStepComplete(step, 600000);
  try {
    await executeStep(step);
  } catch (err) {
    if (isManualCodePauseError(err)) {
      await waitForResume();
    } else {
      throw err;
    }
  }
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function probeBurnerMailboxState(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const extractEmail = (value) => normalizeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const findVisibleAction = (pattern) => {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
        const selectors = [
          '.actions .cursor-pointer',
          '.actions div',
          '.actions button',
          '.actions a',
          '.in-app-actions .cursor-pointer',
          '.in-app-actions div',
          '.in-app-actions button',
          '.in-app-actions a',
          '.app-action button',
          '.app-action input[type="submit"]',
          'button',
          '[role="button"]',
          'a',
        ];

        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            if (!isVisible(el)) continue;
            const text = normalizeText(el.textContent || el.value || '');
            if (regex.test(text)) {
              return el;
            }
          }
        }

        return null;
      };
      const text = normalizeText(document.body?.innerText || document.body?.textContent || '');
      const title = normalizeText(document.title);
      const selectors = [
        '#email_id',
        '.actions #email_id',
        '.in-app-actions #email_id',
        '.in-app-actions .block.appearance-none',
        '.in-app-actions .relative .block.appearance-none',
        '.in-app-actions form .block.appearance-none',
        '.actions .block.appearance-none',
      ];
      const hasMailboxEmail = selectors.some(selector =>
        Array.from(document.querySelectorAll(selector)).some(el => /@/.test(normalizeText(el.textContent || el.value || '')))
      ) || Boolean(extractEmail(title));
      const hasMailboxAction = Boolean(document.querySelector('.btn_copy'))
        || Boolean(document.querySelector('form[wire\\:submit\\.prevent="random"] input[type="submit"]'))
        || Boolean(document.querySelector('form[wire\\:submit\\.prevent="random"] button'))
        || Boolean(findVisibleAction(/^(copy|复制)$/i))
        || Boolean(findVisibleAction(/^(refresh|刷新)$/i))
        || Boolean(findVisibleAction(/^(new|新的)$|new email|新邮件/i))
        || Boolean(findVisibleAction(/random|create a random email|随机|创建随机电子邮件/i));
      const successEl = document.querySelector('#challenge-success-text');
      const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="security challenge" i]');
      const challengeInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][type="hidden"]');
      const challengeSuccess = Boolean(successEl && isVisible(successEl))
        || /verification successful|验证成功|验证已成功|正在等待 burnermailbox\.com 响应|等待 burnermailbox\.com 响应/i.test(text);
      const challengeActive = /just a moment/i.test(title)
        || /进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人|ray id/i.test(title)
        || /performing security verification|verifies you are not a bot|verify you are not a bot|security service to protect against malicious bots|ray id|进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人/i.test(text)
        || Boolean(challengeFrame)
        || Boolean(challengeInput)
        || location.href.includes('__cf_chl');

      return {
        url: location.href,
        title,
        ready: hasMailboxEmail || hasMailboxAction,
        challengeActive,
        challengeSuccess,
      };
    },
  }).catch(() => null);

  return result?.[0]?.result || null;
}

async function waitForBurnerMailboxReadyAfterChallenge(timeout = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const alive = await isTabAlive('burner-mail');
    if (!alive) {
      throw new Error('Burner Mailbox 标签页在安全验证期间被关闭。');
    }

    const tabId = await getTabId('burner-mail');
    if (!tabId) {
      throw new Error('安全验证期间无法访问 Burner Mailbox 标签页。');
    }

    const state = await probeBurnerMailboxState(tabId);
    if (state?.ready) {
      return state;
    }

    await sleepWithStop(1000);
  }

  throw new Error('Burner Mailbox 还没有返回邮箱页面。');
}

async function continueBurnerAfterChallenge(options = {}) {
  const { generateNew = true } = options;

  await addLog('Burner Mailbox: 正在等待人机验证页面结束...', 'info');
  await waitForBurnerMailboxReadyAfterChallenge(45000);
  await addLog('Burner Mailbox: 人机验证已通过，继续获取邮箱...', 'info');
  return await fetchBurnerEmail({ generateNew });
}

async function waitForBurnerChallengeResolution(contextLabel = 'Burner Mailbox') {
  let challengeResolved = false;

  while (!challengeResolved) {
    await addLog(`${contextLabel}: 检测到 Burner Mailbox 人机验证。请在邮箱页完成验证后点击“继续”`, 'warn');
    autoRunResumeMode = 'challenge';
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN_STATUS',
      payload: {
        phase: 'waiting_challenge',
        currentRun: Math.max(1, autoRunCurrentRun || 1),
        totalRuns: Math.max(1, autoRunTotalRuns || 1),
      },
    }).catch(() => {});
    await waitForResume();

    await addLog('Burner Mailbox: 正在等待人机验证页面结束...', 'info');
    try {
      await waitForBurnerMailboxReadyAfterChallenge(45000);
      challengeResolved = true;
      autoRunResumeMode = null;
    } catch (waitErr) {
      await addLog(`Burner Mailbox 人机验证还没有完成：${waitErr.message}`, 'warn');
    }
  }
}

async function fetchBurnerEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Burner Mailbox：正在打开邮箱（${generateNew ? '生成新邮箱' : '复用当前邮箱'}）...`);
  const tabId = await reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL, {
    reloadIfSameUrl: generateNew,
  });

  let result = null;
  let previousEmail = '';

  try {
    const prepared = await sendToContentScript('burner-mail', {
      type: 'PREPARE_BURNER_EMAIL',
      source: 'background',
      payload: { generateNew },
    });

    if (prepared?.email && !generateNew) {
      result = { email: prepared.email, generated: false };
    }

    previousEmail = prepared?.previousEmail || '';

    if (!result && generateNew) {
      try {
        await sendToContentScript('burner-mail', {
          type: 'CLICK_RANDOM_BURNER_EMAIL',
          source: 'background',
          payload: { previousEmail },
        });
      } catch (err) {
        await addLog(`Burner Mailbox 随机邮箱点击导致消息通道中断，正在等待页面稳定：${err.message}`, 'warn');
      }

      for (let attempt = 1; attempt <= 24; attempt++) {
        await sleepWithStop(500);
        await reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL);

        const readResult = await sendToContentScript('burner-mail', {
          type: 'READ_BURNER_EMAIL',
          source: 'background',
          payload: { previousEmail },
        }).catch(() => null);

        if (readResult?.email && (readResult.changed || !previousEmail)) {
          result = { email: readResult.email, generated: true };
          break;
        }
      }
    }
  } catch (err) {
    if (isBurnerChallengeError(err)) {
      throw err;
    }
    await addLog(`Burner Mailbox 内容脚本流程失败，改用页面脚本兜底：${err.message}`, 'warn');
  }

  if (result?.error || !result?.email) {
    const fallback = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (shouldGenerateNew, prevEmail) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const extractEmail = (value) => normalizeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const findByText = (selectors, pattern) => {
          const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (!isVisible(el)) continue;
              const text = normalizeText(el.textContent || el.value || '');
              if (regex.test(text)) return el;
            }
          }
          return null;
        };
        const detectChallenge = () => {
          const title = normalizeText(document.title);
          const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || '');
          const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="security challenge" i]');
          const challengeInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][type="hidden"]');
          const successEl = document.querySelector('#challenge-success-text');
          const successVisible = !!successEl && isVisible(successEl);
          if (successVisible) {
            return false;
          }
          return /just a moment/i.test(title)
            || /进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人|ray id/i.test(title)
            || /performing security verification|verifies you are not a bot|verify you are not a bot|security service to protect against malicious bots|ray id|进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人/i.test(bodyText)
            || !!challengeFrame
            || !!challengeInput
            || location.href.includes('__cf_chl');
        };
        const readVisibleEmail = () => {
          const selectors = [
            '#email_id',
            '.actions #email_id',
            '.in-app-actions #email_id',
            '.in-app-actions .block.appearance-none',
            '.actions .block.appearance-none',
          ];
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              const email = extractEmail(el.textContent || el.value || '');
              if (email) return email;
            }
          }
          return '';
        };
        const readAnyEmail = () => {
          return readVisibleEmail()
            || extractEmail(document.title)
            || extractEmail(document.body?.textContent || '');
        };

        if (detectChallenge()) {
          return { challengeRequired: true };
        }

        const previousEmailValue = prevEmail || readAnyEmail();
        if (previousEmailValue && !shouldGenerateNew) {
          return { email: previousEmailValue, generated: false };
        }

        const newButton = findByText(
          ['.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
          /^(new|新的)$|new email|新邮件/i
        );
        if (!newButton) {
          return { error: '兜底流程未找到 Burner Mailbox 的 New 按钮。' };
        }

        newButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(900);

        const randomButton = findByText(
          [
            'form[wire\\:submit\\.prevent="random"] input[type="submit"]',
            'form[wire\\:submit\\.prevent="random"] button',
            '.app-action input[type="submit"]',
            '.app-action button',
          ],
          /random|create a random email|随机|创建随机电子邮件/i
        );
        if (!randomButton) {
          return { error: '兜底流程未找到 Burner Mailbox 的随机邮箱按钮。' };
        }

        randomButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        for (let i = 0; i < 80; i++) {
          if (detectChallenge()) {
            return { challengeRequired: true };
          }
          const current = readVisibleEmail() || readAnyEmail();
          const copyButton = findByText(
            ['.btn_copy', '.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
            /^(copy|复制)$/i
          );
          if (current && current !== previousEmailValue) {
            if (copyButton) {
              copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return { email: current, generated: true };
          }
          await sleep(250);
        }

        const current = readVisibleEmail() || readAnyEmail();
        if (current) {
          return { email: current, generated: current !== previousEmailValue };
        }

        return { error: '兜底流程等待 Burner Mailbox 邮箱结果超时。' };
      },
      args: [generateNew, previousEmail],
    });

    result = fallback?.[0]?.result || null;
  }

  if (result?.challengeRequired) {
    throw new Error(`${BURNER_CHALLENGE_REQUIRED_MESSAGE} 请在邮箱标签页完成验证后再继续。`);
  }
  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('未返回 Burner Mailbox 邮箱地址。');
  }

  await setEmailState(result.email);
  await addLog(`Burner Mailbox：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
  return result.email;
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('自动运行已在进行中', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  let successfulRuns = 0;
  let failedRun = null;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Reset everything at the start of each run (keep VPS/password settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      customPassword: prevState.customPassword,
      runMode: normalizeRunMode(prevState.runMode),
      manualCodeEntry: null,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);

    await addLog(`=== 自动运行 ${run}/${totalRuns}：阶段 1，获取 OAuth 链接并打开注册页 ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(1, 2000);
      await executeStepAndWait(2, 2000);

      let emailReady = false;
      while (!emailReady) {
        try {
          const burnerEmail = await fetchBurnerEmail({ generateNew: true });
          await addLog(`=== 第 ${run}/${totalRuns} 轮：Burner 邮箱已就绪：${burnerEmail} ===`, 'ok');
          emailReady = true;
          autoRunResumeMode = null;
        } catch (err) {
          if (isBurnerChallengeError(err)) {
            await waitForBurnerChallengeResolution(`Run ${run}/${totalRuns}`);
            continue;
          }

          await addLog(`Burner Mailbox 自动获取失败：${err.message}`, 'warn');
          break;
        }
      }

      if (!emailReady) {
        await addLog(`=== 第 ${run}/${totalRuns} 轮已暂停：请获取 Burner Mailbox 邮箱或手动粘贴后继续 ===`, 'warn');
        autoRunResumeMode = 'email';
        chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        await waitForResume();

        const resumedState = await getState();
        if (!resumedState.email) {
          await addLog('无法继续：缺少邮箱地址。', 'error');
          break;
        }
        autoRunResumeMode = null;
      }

      await addLog(`=== 第 ${run}/${totalRuns} 轮：阶段 2，注册、验证、登录并完成流程 ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await executeStepAndWait(3, 3000);
      await executeStepAndWait(4, 2000);
      await executeStepAndWait(5, 3000);
      await executeStepAndWait(6, 3000);
      await executeStepAndWait(7, 2000);
      await executeStepAndWait(8, 2000);
      await executeStepAndWait(9, 1000);

      successfulRuns = run;
      await addLog(`=== 第 ${run}/${totalRuns} 轮已完成 ===`, 'ok');

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`第 ${run}/${totalRuns} 轮已被用户停止`, 'warn');
      } else {
        failedRun = run;
        await addLog(`第 ${run}/${totalRuns} 轮失败：${err.message}`, 'error');
      }
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break; // Stop on error
    }
  }

  const completedRuns = successfulRuns;
  if (stopRequested) {
    await addLog(`=== 已停止，完成 ${completedRuns}/${autoRunTotalRuns} 轮 ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (failedRun !== null) {
    await addLog(`=== 运行失败，已完成 ${completedRuns}/${autoRunTotalRuns} 轮 ===`, 'error');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== 全部 ${autoRunTotalRuns} 轮已成功完成 ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else {
    await addLog(`=== 已停止，完成 ${completedRuns}/${autoRunTotalRuns} 轮 ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  autoRunActive = false;
  await setState({ autoRunning: false });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  if (autoRunResumeMode === 'email') {
    const state = await getState();
    if (!state.email) {
      await addLog('无法继续：缺少邮箱地址。请先在侧边栏粘贴邮箱。', 'error');
      return;
    }
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
    autoRunResumeMode = null;
  }
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'running', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  const vpsUrl = getEffectiveVpsUrl(state.vpsUrl);
  await addLog('步骤 1：正在打开 VPS 面板...');
  await reuseOrCreateTab('vps-panel', vpsUrl, {
    inject: ['content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }
  await addLog('步骤 2：正在打开授权链接...');
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先在侧边栏粘贴邮箱。');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email: state.email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `步骤 3：正在填写邮箱 ${state.email}，密码为${state.customPassword ? '自定义' : '自动生成'}（${password.length} 个字符）`
  );
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (Burner Mailbox polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  return { source: 'burner-mail', url: BURNER_MAILBOX_URL, label: 'Burner Mailbox' };
}

function isNoMatchingEmailError(error) {
  const message = error?.message || String(error || '');
  return message.includes('No matching verification email found') || message.includes('No new matching email found');
}

async function openMailTab(mail) {
  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }
}

async function clickResendOnSignupPage(step, clicks = 1) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    await addLog(`步骤 ${step}：授权页标签已关闭，跳过预先重发验证码。`, 'warn');
    return false;
  }

  await chrome.tabs.update(signupTabId, { active: true });
  try {
    await sendToContentScript('signup-page', {
      type: 'RESEND_VERIFICATION_EMAIL',
      step,
      source: 'background',
      payload: { clicks },
    });
    return true;
  } catch (err) {
    await addLog(`步骤 ${step}：预先重发验证码已跳过：${err.message}`, 'warn');
    return false;
  }
}

async function requestVerificationEmailResend(step, clicks = 2) {
  const clicked = await clickResendOnSignupPage(step, clicks);
  if (!clicked) {
    throw new Error('授权页标签已关闭，无法请求重新发送验证码。');
  }
}

async function pollVerificationCodeWithRetry(step, state, options) {
  const {
    filterAfterTimestamp,
    senderFilters,
    subjectFilters,
    targetEmail,
    successLogMessage,
    failureLabel,
  } = options;

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);

  const maxResendRounds = 3;

  for (let round = 0; round <= maxResendRounds; round++) {
    await addLog(`步骤 ${step}：正在打开 ${mail.label}...`);
    await openMailTab(mail);

    let foundCode = null;
    try {
      const result = await sendToContentScript(mail.source, {
        type: 'POLL_EMAIL',
        step,
        source: 'background',
        payload: {
          filterAfterTimestamp,
          senderFilters,
          subjectFilters,
          targetEmail,
          maxAttempts: 2,
          intervalMs: 4000,
        },
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.code) {
        if (result.emailTimestamp) {
          await setState({ lastEmailTimestamp: result.emailTimestamp });
        }
        await addLog(successLogMessage(result.code), 'ok');
        foundCode = result.code;
      }
    } catch (err) {
      if (isBurnerChallengeError(err)) {
        await waitForBurnerChallengeResolution(`Step ${step}`);
        round -= 1;
        continue;
      }
      if (!isNoMatchingEmailError(err)) {
        throw err;
      }
    }

    if (foundCode) {
      return foundCode;
    }

    if (round === maxResendRounds) {
      throw new Error(`${failureLabel}，且已重发 3 轮。`);
    }

    await addLog(`步骤 ${step}：4 秒内没有新邮件，正在请求重发两次（${round + 1}/${maxResendRounds}）...`, 'warn');
    await requestVerificationEmailResend(step, 2);
    await humanStepDelay(500, 1100);
  }

  throw new Error(failureLabel);
}

async function executeStep4(state) {
  if (isManualRunMode(state)) {
    await requestManualCodePause(4);
    return;
  }

  await clickResendOnSignupPage(4, 1);
  const code = await pollVerificationCodeWithRetry(4, state, {
    filterAfterTimestamp: state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    targetEmail: state.email,
    successLogMessage: (value) => `步骤 4：已获取验证码：${value}`,
    failureLabel: '未收到注册验证码邮件',
  });

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
    await sendToContentScript('signup-page', {
      type: 'FILL_CODE',
      step: 4,
      source: 'background',
      payload: { code },
    });
  } else {
    throw new Error('注册页标签已关闭，无法填写验证码。');
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }
  if (!state.email) {
    throw new Error('缺少邮箱，请先完成步骤 3。');
  }

  await addLog('步骤 6：正在打开 OAuth 链接进行登录...');
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (Burner Mailbox polls, then fills in auth page)
// ============================================================

async function executeStep7(state) {
  if (isManualRunMode(state)) {
    await requestManualCodePause(7);
    return;
  }

  await clickResendOnSignupPage(7, 1);
  const code = await pollVerificationCodeWithRetry(7, state, {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    targetEmail: state.email,
    successLogMessage: (value) => `步骤 7：已获取登录验证码：${value}`,
    failureLabel: '未收到登录验证码邮件',
  });

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
    await sendToContentScript('signup-page', {
      type: 'FILL_CODE',
      step: 7,
      source: 'background',
      payload: { code },
    });
  } else {
    throw new Error('授权页标签已关闭，无法填写验证码。');
  }
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }

  await addLog('步骤 8：正在设置 localhost 回调监听...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    let monitorTimer = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
    };

    const finalizeStep8 = async (payload = {}) => {
      if (resolved) return;
      resolved = true;
      cleanupListener();
      clearTimeout(timeout);

      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        await addLog(`步骤 8：已捕获 localhost 回调地址：${payload.localhostUrl}`, 'ok');
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      } else if (payload.successPage) {
        await setState({ directAuthSuccess: true });
        await addLog('步骤 8：检测到授权成功页面，步骤 8 和步骤 9 将直接视为完成。', 'ok');
        await setStepStatus(9, 'completed');
      }

      await setStepStatus(8, 'completed');
      notifyStepComplete(8, {
        ...payload,
        directAuthSuccess: Boolean(payload.successPage && !payload.localhostUrl),
      });
      resolve();
    };

    const timeout = setTimeout(() => {
      cleanupListener();
      reject(new Error('120 秒内未捕获到 localhost 回调，步骤 8 的点击可能被拦截。'));
    }, 120000);

    webNavListener = (details) => {
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        finalizeStep8({ localhostUrl: details.url }).catch(reject);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('步骤 8：已切换到授权页，准备执行调试器点击...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('步骤 8：已重新打开授权页标签，准备执行调试器点击...');
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('步骤 8：调试器点击已发送，正在等待回调跳转...');

          monitorTimer = setInterval(() => {
            if (resolved) return;

            (async () => {
              try {
                const currentTab = await chrome.tabs.get(signupTabId);
                const currentUrl = currentTab?.url || '';
                if (currentUrl.startsWith('http://localhost')) {
                  await finalizeStep8({ localhostUrl: currentUrl });
                  return;
                }

                const probe = await chrome.scripting.executeScript({
                  target: { tabId: signupTabId },
                  func: () => {
                    const bodyText = document.body?.innerText || '';
                    const headingText = Array.from(document.querySelectorAll('h1, h2')).map(el => el.textContent || '').join(' ');
                    return {
                      url: location.href,
                      successPage: /authentication successful!?/i.test(bodyText) || /authentication successful!?/i.test(headingText),
                    };
                  },
                }).catch(() => null);

                const result = probe?.[0]?.result;
                const probedUrl = result?.url || currentUrl;
                if (probedUrl.startsWith('http://localhost')) {
                  await finalizeStep8({ localhostUrl: probedUrl, successPage: Boolean(result?.successPage) });
                  return;
                }

                if (result?.successPage) {
                  await finalizeStep8({ successPage: true, localhostUrl: probedUrl.startsWith('http://localhost') ? probedUrl : null });
                }
              } catch {}
            })();
          }, 700);
        }
      } catch (err) {
        clearTimeout(timeout);
        cleanupListener();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (state.directAuthSuccess && !state.localhostUrl) {
    await addLog('步骤 9：已跳过，因为步骤 8 已直接进入授权成功页面。', 'ok');
    await setStepStatus(9, 'completed');
    notifyStepComplete(9, { skipped: true, directAuthSuccess: true });
    return;
  }

  if (!state.localhostUrl) {
    throw new Error('缺少 localhost 回调地址，请先完成步骤 8。');
  }
  const vpsUrl = getEffectiveVpsUrl(state.vpsUrl);

  await addLog('步骤 9：正在打开 VPS 面板...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab
    const wid = await ensureAutomationWindowId();
    const tab = await chrome.tabs.create({ url: vpsUrl, active: true, windowId: wid });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog('步骤 9：正在填写回调地址...');
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
