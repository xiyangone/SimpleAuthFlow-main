// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};
STATUS_ICONS.skipped = '跳';

const RUN_MODE_AUTO = 'auto';
const RUN_MODE_MANUAL = 'manual';
const EMAIL_PROVIDER_BURNER = 'burner_mailbox';
const EMAIL_PROVIDER_2925 = 'mail_2925';
const EMAIL_PROVIDER_QQ = 'qq_mail';
const EMAIL_PROVIDER_163 = 'mail_163';
const MANUAL_CODE_LENGTH = 6;
const DEFAULT_OTP_WAIT_SECONDS = 180;
const MIN_OTP_WAIT_SECONDS = 30;
const MAX_OTP_WAIT_SECONDS = 600;
const AUTO_BUTTON_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const inputVpsUrl = document.getElementById('input-vps-url');
const inputOtpWaitSeconds = document.getElementById('input-otp-wait-seconds');
const otpWaitRow = inputOtpWaitSeconds ? inputOtpWaitSeconds.closest('.data-row') : null;
const inputRunCount = document.getElementById('input-run-count');
const selectRunMode = document.getElementById('select-run-mode');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const emailServiceRow = findDataRowByLabel('邮箱服务');
const selectEmailProvider = document.getElementById('select-email-provider');
const inputAutoSkipFailures = document.getElementById('input-auto-skip-failures');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const btnClearLog = document.getElementById('btn-clear-log');
const btnDownloadLog = ensureDownloadLogButton();
const autoContinueBar = document.getElementById('auto-continue-bar');
const autoContinueHint = document.getElementById('auto-continue-hint');
const stepsProgress = document.getElementById('steps-progress');
const manualCodeModal = document.getElementById('manual-code-modal');
const manualCodeTitle = document.getElementById('manual-code-title');
const manualCodeHint = document.getElementById('manual-code-hint');
const inputManualCode = document.getElementById('input-manual-code');
const btnSubmitManualCode = document.getElementById('btn-submit-manual-code');
const btnCancelManualCode = document.getElementById('btn-cancel-manual-code');
const autoStartModal = document.getElementById('auto-start-modal');
const autoStartTitle = document.getElementById('auto-start-title');
const autoStartMessage = document.getElementById('auto-start-message');
const btnAutoStartClose = document.getElementById('btn-auto-start-close');
const btnAutoStartCancel = document.getElementById('btn-auto-start-cancel');
const btnAutoStartRestart = document.getElementById('btn-auto-start-restart');
const btnAutoStartContinue = document.getElementById('btn-auto-start-continue');

const STEP_DEFAULT_STATUSES = {
  1: 'pending',
  2: 'pending',
  3: 'pending',
  4: 'pending',
  5: 'pending',
  6: 'pending',
  7: 'pending',
  8: 'pending',
  9: 'pending',
};

const WAITING_AUTO_PHASES = new Set([
  'waiting_email',
  'waiting_challenge',
  'waiting_otp_timeout',
  'waiting_manual_code',
]);

let autoContinueMode = 'email';
let currentRunMode = RUN_MODE_AUTO;
let currentEmailProvider = EMAIL_PROVIDER_BURNER;
let latestState = null;
let currentAutoRun = {
  autoRunning: false,
  phase: 'idle',
  currentRun: 0,
  totalRuns: 1,
  attemptRun: 0,
};
let modalChoiceResolver = null;

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

const LEVEL_LABELS = {
  info: '信息',
  warn: '警告',
  error: '错误',
  ok: '成功',
};

function ensureDownloadLogButton() {
  const logHeader = document.querySelector('.log-header');
  if (!logHeader) return null;
  const clearButton = document.getElementById('btn-clear-log');

  let actions = document.getElementById('log-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.id = 'log-actions';
    actions.style.display = 'inline-flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '6px';
    logHeader.appendChild(actions);
  }

  if (clearButton && clearButton.parentElement !== actions) {
    actions.appendChild(clearButton);
  }

  const existing = document.getElementById('btn-download-log');
  if (existing) {
    if (existing.parentElement !== actions) actions.appendChild(existing);
    return existing;
  }

  const button = document.createElement('button');
  button.id = 'btn-download-log';
  button.className = 'btn btn-ghost btn-xs';
  button.title = '下载日志(JSON)';
  button.textContent = '下载';
  actions.appendChild(button);
  return button;
}

function showToast(message, type = 'error', duration = 4000) {
  if (type === 'error') {
    appendLog({
      timestamp: Date.now(),
      level: 'error',
      message: String(message || '发生错误'),
    });
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

function normalizeRunMode(mode) {
  return String(mode || '').trim() === RUN_MODE_MANUAL ? RUN_MODE_MANUAL : RUN_MODE_AUTO;
}

function normalizeOtpWaitSeconds(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_OTP_WAIT_SECONDS;
  return Math.max(MIN_OTP_WAIT_SECONDS, Math.min(MAX_OTP_WAIT_SECONDS, parsed));
}

function normalizeEmailProvider(value) {
  const normalized = String(value || '').trim();
  if (normalized === EMAIL_PROVIDER_2925 || normalized === EMAIL_PROVIDER_QQ || normalized === EMAIL_PROVIDER_163) {
    return normalized;
  }
  return EMAIL_PROVIDER_BURNER;
}

function findDataRowByLabel(label) {
  return Array.from(document.querySelectorAll('#data-section .data-row')).find((row) => {
    const labelEl = row.querySelector('.data-label');
    return labelEl && labelEl.textContent.trim() === label;
  }) || null;
}

function isManualMode(mode = currentRunMode) {
  return normalizeRunMode(mode) === RUN_MODE_MANUAL;
}

function getProviderDisplayName(provider = currentEmailProvider) {
  switch (normalizeEmailProvider(provider)) {
    case EMAIL_PROVIDER_2925:
      return '2925 邮箱';
    case EMAIL_PROVIDER_QQ:
      return 'QQ 邮箱';
    case EMAIL_PROVIDER_163:
      return '163 邮箱';
    default:
      return 'Burner Mailbox';
  }
}

function getEmailFetchDisplayName(provider = currentEmailProvider) {
  switch (normalizeEmailProvider(provider)) {
    case EMAIL_PROVIDER_2925:
      return '2925 子邮箱';
    case EMAIL_PROVIDER_QQ:
    case EMAIL_PROVIDER_163:
      return 'Duck 私有地址';
    default:
      return 'Burner Mailbox 邮箱';
  }
}

function getEmailPlaceholder(mode = currentRunMode, provider = currentEmailProvider) {
  if (isManualMode(mode)) {
    return '手动模式下请手动粘贴邮箱地址';
  }

  switch (normalizeEmailProvider(provider)) {
    case EMAIL_PROVIDER_2925:
      return '自动识别 2925 主邮箱并生成子邮箱，或手动粘贴';
    case EMAIL_PROVIDER_QQ:
    case EMAIL_PROVIDER_163:
      return '自动从 Duck 生成私有地址，或手动粘贴';
    default:
      return '自动从 Burner Mailbox 获取，或手动粘贴';
  }
}

function getEmailPauseHint(mode = currentRunMode, provider = currentEmailProvider) {
  if (isManualMode(mode)) {
    return '手动模式请粘贴邮箱后点击“继续”';
  }

  switch (normalizeEmailProvider(provider)) {
    case EMAIL_PROVIDER_2925:
      return '点击“自动”识别 2925 主邮箱并生成子邮箱，或手动粘贴后继续';
    case EMAIL_PROVIDER_QQ:
    case EMAIL_PROVIDER_163:
      return '点击“自动”生成 Duck 私有地址，或手动粘贴后继续';
    default:
      return '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
  }
}

function getEmailRequiredWarn(mode = currentRunMode, provider = currentEmailProvider) {
  if (isManualMode(mode)) {
    return '请先粘贴邮箱地址';
  }

  switch (normalizeEmailProvider(provider)) {
    case EMAIL_PROVIDER_2925:
      return '请先获取或粘贴 2925 子邮箱地址';
    case EMAIL_PROVIDER_QQ:
    case EMAIL_PROVIDER_163:
      return '请先获取或粘贴 Duck 私有地址';
    default:
      return '请先获取或粘贴 Burner Mailbox 邮箱地址';
  }
}

function isDoneStatus(status) {
  return status === 'completed' || status === 'skipped';
}

function getStepStatuses(state = latestState) {
  return { ...STEP_DEFAULT_STATUSES, ...(state?.stepStatuses || {}) };
}

function getFirstUnfinishedStep(state = latestState) {
  const statuses = getStepStatuses(state);
  for (let step = 1; step <= 9; step++) {
    if (!isDoneStatus(statuses[step])) {
      return step;
    }
  }
  return null;
}

function hasSavedProgress(state = latestState) {
  return Object.values(getStepStatuses(state)).some((status) => status !== 'pending');
}

function syncLatestState(state) {
  latestState = state ? { ...(latestState || {}), ...state } : latestState;
  const autoRunning = Boolean(latestState?.autoRunning);
  currentAutoRun = {
    autoRunning,
    phase: latestState?.autoRunPhase || 'idle',
    currentRun: Number(latestState?.autoRunCurrentRun || 0),
    totalRuns: Number(latestState?.autoRunTotalRuns || 1),
    attemptRun: Number(latestState?.autoRunAttemptRun || 0),
  };
}

function isAutoRunPausedPhase(phase = currentAutoRun.phase) {
  return currentAutoRun.autoRunning && WAITING_AUTO_PHASES.has(phase);
}

function isAutoRunPausedState(state = latestState) {
  return Boolean(state?.autoRunning) && WAITING_AUTO_PHASES.has(state?.autoRunPhase);
}

function resetActionModalButtons() {
  const buttons = [btnAutoStartCancel, btnAutoStartRestart, btnAutoStartContinue];
  for (const button of buttons) {
    if (!button) continue;
    button.hidden = true;
    button.disabled = false;
    button.onclick = null;
  }
}

function resolveModalChoice(choice) {
  if (autoStartModal) {
    autoStartModal.hidden = true;
  }
  resetActionModalButtons();
  if (modalChoiceResolver) {
    const resolve = modalChoiceResolver;
    modalChoiceResolver = null;
    resolve(choice);
  }
}

function configureActionModalButton(button, action) {
  if (!button) return;
  if (!action) {
    button.hidden = true;
    button.onclick = null;
    return;
  }

  button.hidden = false;
  button.textContent = action.label;
  button.className = `btn ${action.variant || 'btn-outline'} btn-sm`;
  button.onclick = () => resolveModalChoice(action.id ?? null);
}

function openActionModal({ title, message, actions = [] }) {
  if (!autoStartModal) {
    return Promise.resolve(null);
  }

  if (modalChoiceResolver) {
    resolveModalChoice(null);
  }

  autoStartTitle.textContent = title;
  autoStartMessage.textContent = message;
  configureActionModalButton(btnAutoStartCancel, actions[0]);
  configureActionModalButton(btnAutoStartRestart, actions[1]);
  configureActionModalButton(btnAutoStartContinue, actions[2]);
  autoStartModal.hidden = false;

  return new Promise((resolve) => {
    modalChoiceResolver = resolve;
  });
}

function openAutoStartChoiceDialog(startStep) {
  return openActionModal({
    title: '启动自动',
    message: `检测到当前已有流程进度。继续当前会从步骤 ${startStep} 开始自动执行，重新开始会清空当前流程进度并从步骤 1 新开一轮。`,
    actions: [
      { id: null, label: '取消', variant: 'btn-ghost' },
      { id: 'restart', label: '重新开始', variant: 'btn-outline' },
      { id: 'continue', label: '继续当前', variant: 'btn-primary' },
    ],
  });
}

async function openConfirmModal({ title, message, confirmLabel = '确认', confirmVariant = 'btn-primary' }) {
  const choice = await openActionModal({
    title,
    message,
    actions: [
      { id: null, label: '取消', variant: 'btn-ghost' },
      { id: 'confirm', label: confirmLabel, variant: confirmVariant },
    ],
  });
  return choice === 'confirm';
}

async function refreshLatestState() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
  syncLatestState(state);
  return state;
}

function initializeStepActions() {
  document.querySelectorAll('.step-row').forEach((row) => {
    if (row.querySelector('.step-actions')) return;

    const step = Number(row.dataset.step);
    const actions = document.createElement('div');
    actions.className = 'step-actions';

    const skipButton = document.createElement('button');
    skipButton.type = 'button';
    skipButton.className = 'step-skip-btn';
    skipButton.dataset.step = String(step);
    skipButton.title = `跳过步骤 ${step}`;
    skipButton.textContent = '跳';
    skipButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await handleSkipStep(step);
      } catch (err) {
        showToast(`跳过步骤 ${step} 失败：${err.message}`, 'error');
      }
    });

    actions.appendChild(skipButton);
    row.appendChild(actions);
  });
}

function applyRunModeUI(mode, provider = currentEmailProvider) {
  currentRunMode = normalizeRunMode(mode);
  currentEmailProvider = normalizeEmailProvider(provider);
  selectRunMode.value = currentRunMode;
  if (selectEmailProvider) {
    selectEmailProvider.value = currentEmailProvider;
  }
  if (emailServiceRow) {
    emailServiceRow.style.display = isManualMode() ? 'none' : '';
  }
  if (otpWaitRow) {
    otpWaitRow.style.display = isManualMode() ? 'none' : '';
  }

  if (isManualMode()) {
    btnFetchEmail.style.display = 'none';
    btnFetchEmail.disabled = true;
  } else {
    btnFetchEmail.style.display = 'inline-flex';
    btnFetchEmail.disabled = false;
    btnFetchEmail.title = `按当前邮箱服务自动获取${getEmailFetchDisplayName(currentEmailProvider)}`;
  }

  inputEmail.placeholder = getEmailPlaceholder(currentRunMode, currentEmailProvider);
  if (autoContinueMode === 'email' || autoContinueBar.style.display === 'none') {
    autoContinueHint.textContent = getEmailPauseHint(currentRunMode, currentEmailProvider);
  }
}

function showManualCodeModal(entry = null) {
  if (!manualCodeModal) return;
  manualCodeTitle.textContent = entry?.title || '等待输入验证码';
  manualCodeHint.textContent = entry?.hint || '请输入验证码，提交后自动继续。';
  btnSubmitManualCode.textContent = entry?.submitText || '提交并继续';
  inputManualCode.value = '';
  manualCodeModal.style.display = 'flex';
  inputManualCode.focus();
}

function hideManualCodeModal() {
  if (!manualCodeModal) return;
  manualCodeModal.style.display = 'none';
  inputManualCode.value = '';
}

function normalizeManualCodeInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, MANUAL_CODE_LENGTH);
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    syncLatestState(state);

    applyRunModeUI(state.runMode, state.emailProvider);

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    }
    inputOtpWaitSeconds.value = String(normalizeOtpWaitSeconds(state.otpWaitSeconds));
    if (inputAutoSkipFailures) {
      inputAutoSkipFailures.checked = Boolean(state.autoRunSkipFailures);
    }

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    if (state.manualCodeEntry) {
      showManualCodeModal(state.manualCodeEntry);
    } else {
      hideManualCodeModal();
    }

    updateStatusDisplay(state);
    updateProgressCounter();
    applyAutoRunStatusPayload({
      phase: state.autoRunPhase || (state.autoRunning ? 'running' : 'stopped'),
      currentRun: state.autoRunCurrentRun || 0,
      totalRuns: state.autoRunTotalRuns || 1,
      attemptRun: state.autoRunAttemptRun || 0,
      manualCodeEntry: state.manualCodeEntry || null,
      hint: getEmailPauseHint(state.runMode, state.emailProvider),
    }, { fromRestore: true });
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach((row) => {
    if (row.classList.contains('completed') || row.classList.contains('skipped')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach((row) => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else if (row.classList.contains('skipped')) statuses[step] = 'skipped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');
  const manualModalVisible = manualCodeModal && manualCodeModal.style.display !== 'none';
  const actionModalVisible = autoStartModal && !autoStartModal.hidden;
  const lockStepButtons = anyRunning || manualModalVisible || actionModalVisible;

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    const skipBtn = document.querySelector(`.step-skip-btn[data-step="${step}"]`);
    if (!btn) continue;

    if (lockStepButtons) {
      btn.disabled = true;
      if (skipBtn) skipBtn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
      if (skipBtn) skipBtn.disabled = statuses[step] === 'running' || isDoneStatus(statuses[step]);
    } else {
      const prevStatus = statuses[step - 1];
      const currentStatus = statuses[step];
      btn.disabled = !(isDoneStatus(prevStatus) || currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'stopped' || currentStatus === 'skipped');
      if (skipBtn) {
        skipBtn.disabled = !isDoneStatus(prevStatus) || currentStatus === 'running' || isDoneStatus(currentStatus);
      }
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none' || manualModalVisible || isAutoRunPausedPhase());
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;
  syncLatestState(state);

  statusBar.className = 'status-bar';

  if (state.manualCodeEntry) {
    const step = Number(state.manualCodeEntry.step || 0);
    displayStatus.textContent = step ? `步骤 ${step} 等待输入验证码` : '等待输入验证码';
    statusBar.classList.add('stopped');
    return;
  }

  if (isAutoRunPausedState(state)) {
    displayStatus.textContent = '自动流程已暂停';
    statusBar.classList.add('stopped');
    return;
  }

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `步骤 ${running[0]} 执行中...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `步骤 ${failed[0]} 失败`;
    statusBar.classList.add('failed');
    return;
  }

  const stopped = Object.entries(state.stepStatuses).find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = `步骤 ${stopped[0]} 已停止`;
    statusBar.classList.add('stopped');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => isDoneStatus(s))
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = state.stepStatuses[9] === 'skipped' ? '全部步骤已跳过/完成' : '全部步骤已完成';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = state.stepStatuses[lastCompleted] === 'skipped'
      ? `步骤 ${lastCompleted} 已跳过`
      : `步骤 ${lastCompleted} 已完成`;
  } else {
    displayStatus.textContent = '就绪';
  }
}

function appendLog(entry) {
  const distanceFromBottom = Number(logArea.scrollHeight || 0) - Number(logArea.scrollTop || 0) - Number(logArea.clientHeight || 0);
  const shouldStickToBottom = distanceFromBottom <= 24;
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const levelLabel = LEVEL_LABELS[entry.level] || entry.level;
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = String(entry.message || '').match(/(?:Step|步骤)\s*(\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  if (shouldStickToBottom) {
    logArea.scrollTop = logArea.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildLogExportFileName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `simpleauthflow-logs-${yyyy}${mm}${dd}-${hh}${mi}${ss}.json`;
}

async function downloadLogsAsJson() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    const logs = Array.isArray(state?.logs) ? state.logs : [];
    const payload = {
      exportedAt: new Date().toISOString(),
      count: logs.length,
      logs,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildLogExportFileName();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast(`日志已下载（${logs.length} 条）`, 'success', 2200);
  } catch (err) {
    showToast(`下载日志失败：${err.message}`, 'warn', 2600);
  }
}

async function persistDraftSettings() {
  const otpWaitSeconds = normalizeOtpWaitSeconds(inputOtpWaitSeconds.value);
  inputOtpWaitSeconds.value = String(otpWaitSeconds);
  const emailProvider = normalizeEmailProvider(selectEmailProvider?.value);
  const autoRunSkipFailures = Boolean(inputAutoSkipFailures?.checked);
  if (selectEmailProvider) {
    selectEmailProvider.value = emailProvider;
  }
  currentEmailProvider = emailProvider;

  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: {
      vpsUrl: inputVpsUrl.value.trim(),
      customPassword: inputPassword.value,
      runMode: normalizeRunMode(selectRunMode.value),
      otpWaitSeconds,
      emailProvider,
      autoRunSkipFailures,
    },
  });

  if (latestState) {
    latestState.autoRunSkipFailures = autoRunSkipFailures;
  }

  await chrome.runtime.sendMessage({
    type: 'SAVE_EMAIL',
    source: 'sidepanel',
    payload: { email: inputEmail.value.trim() },
  });
}

async function fetchProviderEmail() {
  const defaultLabel = '自动';
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';
  const provider = normalizeEmailProvider(selectEmailProvider?.value);

  try {
    let response = await chrome.runtime.sendMessage({
      type: 'FETCH_PROVIDER_EMAIL',
      source: 'sidepanel',
      payload: { generateNew: true, provider },
    });

    if (provider === EMAIL_PROVIDER_BURNER && response?.error && /(security verification required|需要.*安全验证)/i.test(response.error)) {
      const confirmed = window.confirm(
        'Burner Mailbox 需要先完成人机验证。\n\n请切到邮箱页完成验证，完成后点“确定”，我会直接继续获取邮箱，不需要你再点“自动”。'
      );
      if (!confirmed) {
        throw new Error(response.error);
      }

      response = await chrome.runtime.sendMessage({
        type: 'CONTINUE_PROVIDER_FETCH',
        source: 'sidepanel',
        payload: { generateNew: true, provider },
      });
    }

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error(`未返回${getEmailFetchDisplayName(provider)}。`);
    }

    inputEmail.value = response.email;
    showToast(`已获取${getEmailFetchDisplayName(provider)} ${response.email}`, 'success', 2500);
    return response.email;
  } catch (err) {
    showToast(`自动获取${getEmailFetchDisplayName(provider)}失败：${err.message}`, 'error');
    throw err;
  } finally {
    if (!isManualMode()) {
      btnFetchEmail.disabled = false;
      btnFetchEmail.textContent = defaultLabel;
    }
  }
}

function syncPasswordToggleLabel() {
  btnTogglePassword.textContent = inputPassword.type === 'password' ? '显示' : '隐藏';
}

function applyAutoRunStatusPayload(payload = {}, options = {}) {
  const { fromRestore = false } = options;
  const phase = payload.phase || 'idle';
  const currentRun = Number(payload.currentRun || 0);
  const totalRuns = Number(payload.totalRuns || 1);
  const attemptRun = Number(payload.attemptRun || 0);
  currentAutoRun = {
    autoRunning: phase !== 'complete' && phase !== 'stopped' && phase !== 'idle',
    phase,
    currentRun,
    totalRuns,
    attemptRun,
  };

  if (latestState) {
    latestState.autoRunning = currentAutoRun.autoRunning;
    latestState.autoRunPhase = phase;
    latestState.autoRunCurrentRun = currentRun;
    latestState.autoRunTotalRuns = totalRuns;
    latestState.autoRunAttemptRun = attemptRun;
  }

  const runLabel = totalRuns > 1 && currentRun > 0 ? ` (${currentRun}/${totalRuns})` : '';
  switch (phase) {
    case 'waiting_email':
      autoContinueBar.style.display = 'flex';
      autoContinueMode = 'email';
      autoContinueHint.textContent = payload?.hint || getEmailPauseHint(currentRunMode, currentEmailProvider);
      btnAutoRun.innerHTML = `已暂停${runLabel}`;
      updateStopButtonState(true);
      hideManualCodeModal();
      break;
    case 'waiting_challenge':
      autoContinueBar.style.display = 'flex';
      autoContinueMode = 'challenge';
      autoContinueHint.textContent = 'Burner Mailbox 需要先完成人机验证。请在邮箱页完成验证后点击“继续”';
      btnAutoRun.innerHTML = `已暂停${runLabel}`;
      updateStopButtonState(true);
      hideManualCodeModal();
      break;
    case 'waiting_otp_timeout':
      autoContinueBar.style.display = 'flex';
      autoContinueMode = 'otp_timeout';
      autoContinueHint.textContent = payload.hint || '验证码等待超时，点击“继续”后再次轮询并重发。';
      btnAutoRun.innerHTML = `已暂停${runLabel}`;
      updateStopButtonState(true);
      hideManualCodeModal();
      break;
    case 'waiting_manual_code':
      autoContinueBar.style.display = 'none';
      btnAutoRun.innerHTML = `已暂停${runLabel}`;
      updateStopButtonState(true);
      showManualCodeModal(payload.manualCodeEntry || null);
      break;
    case 'retrying':
    case 'running':
      btnAutoRun.disabled = true;
      inputRunCount.disabled = true;
      btnAutoRun.innerHTML = phase === 'retrying' ? `重试中${runLabel}` : `运行中${runLabel}`;
      updateStopButtonState(true);
      autoContinueBar.style.display = 'none';
      if (!payload.manualCodeEntry) {
        hideManualCodeModal();
      }
      break;
    case 'complete':
    case 'stopped':
    case 'idle':
    default:
      btnAutoRun.disabled = false;
      inputRunCount.disabled = false;
      btnAutoRun.innerHTML = AUTO_BUTTON_HTML;
      autoContinueBar.style.display = 'none';
      autoContinueMode = 'email';
      autoContinueHint.textContent = getEmailPauseHint(currentRunMode, currentEmailProvider);
      updateStopButtonState(false);
      if (!fromRestore || !payload.manualCodeEntry) {
        hideManualCodeModal();
      }
      break;
  }

  updateButtonStates();
}

async function maybeTakeoverAutoRun(actionLabel) {
  const state = await refreshLatestState().catch(() => latestState);
  if (!isAutoRunPausedState(state)) {
    return true;
  }

  const confirmed = await openConfirmModal({
    title: '接管自动',
    message: `当前自动流程已暂停。若继续${actionLabel}，将停止自动流程并切换为手动控制。是否继续？`,
    confirmLabel: '确认接管',
    confirmVariant: 'btn-primary',
  });
  if (!confirmed) {
    return false;
  }

  await chrome.runtime.sendMessage({ type: 'TAKEOVER_AUTO_RUN', source: 'sidepanel', payload: {} });
  return true;
}

async function handleSkipStep(step) {
  if (!(await maybeTakeoverAutoRun(`跳过步骤 ${step}`))) {
    return;
  }

  const confirmed = await openConfirmModal({
    title: '跳过步骤',
    message: `这不会真正执行步骤 ${step}，只会直接跳过该步骤并放行后续步骤。是否继续？`,
    confirmLabel: `跳过步骤 ${step}`,
    confirmVariant: 'btn-primary',
  });
  if (!confirmed) {
    return;
  }

  await persistDraftSettings();
  const response = await chrome.runtime.sendMessage({
    type: 'SKIP_STEP',
    source: 'sidepanel',
    payload: { step },
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  showToast(`步骤 ${step} 已跳过`, 'success', 2200);
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    try {
      const step = Number(btn.dataset.step);
      if (!(await maybeTakeoverAutoRun(`执行步骤 ${step}`))) {
        return;
      }
      await persistDraftSettings();
      if (step === 3) {
        const email = inputEmail.value.trim();
        if (!email) {
          showToast(getEmailRequiredWarn(), 'warn');
          return;
        }
        await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, email } });
      } else {
        await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
      }
    } catch (err) {
      showToast(`执行步骤失败：${err.message}`, 'error');
    }
  });
});

btnFetchEmail.addEventListener('click', async () => {
  if (isManualMode()) {
    showToast('手动模式下请直接粘贴邮箱地址', 'warn', 2000);
    return;
  }
  await fetchProviderEmail().catch(() => {});
});

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  hideManualCodeModal();
  showToast('正在停止当前流程...', 'warn', 2000);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value, 10) || 1;
  await persistDraftSettings();
  const state = await refreshLatestState().catch(() => latestState);
  let mode = 'restart';

  if (hasSavedProgress(state)) {
    const startStep = getFirstUnfinishedStep(state) || 1;
    const choice = await openAutoStartChoiceDialog(startStep);
    if (!choice) {
      return;
    }
    mode = choice === 'continue' && getFirstUnfinishedStep(state) ? 'continue' : 'restart';
  }

  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 运行中...';
  await chrome.runtime.sendMessage({
    type: 'AUTO_RUN',
    source: 'sidepanel',
    payload: {
      totalRuns,
      mode,
      autoRunSkipFailures: Boolean(inputAutoSkipFailures?.checked),
    },
  });
});

btnAutoContinue.addEventListener('click', async () => {
  if (autoContinueMode === 'email') {
    const email = inputEmail.value.trim();
    if (!email) {
      showToast(getEmailRequiredWarn(), 'warn');
      return;
    }
    await persistDraftSettings();
    autoContinueBar.style.display = 'none';
    autoContinueMode = 'email';
    await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel', payload: { email } });
    return;
  }

  autoContinueBar.style.display = 'none';
  autoContinueMode = 'email';
  await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel', payload: {} });
});

btnSubmitManualCode.addEventListener('click', async () => {
  const code = normalizeManualCodeInput(inputManualCode.value);
  inputManualCode.value = code;
  if (code.length !== MANUAL_CODE_LENGTH) {
    showToast(`验证码必须是 ${MANUAL_CODE_LENGTH} 位数字`, 'warn', 2000);
    inputManualCode.focus();
    return;
  }

  btnSubmitManualCode.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'SUBMIT_MANUAL_CODE',
      source: 'sidepanel',
      payload: { code },
    });
    hideManualCodeModal();
  } catch (err) {
    showToast(`提交验证码失败：${err.message}`, 'error');
  } finally {
    btnSubmitManualCode.disabled = false;
  }
});

btnCancelManualCode.addEventListener('click', () => {
  hideManualCodeModal();
});

if (btnAutoStartClose) {
  btnAutoStartClose.addEventListener('click', () => resolveModalChoice(null));
}

if (autoStartModal) {
  autoStartModal.addEventListener('click', (event) => {
    if (event.target === autoStartModal) {
      resolveModalChoice(null);
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && autoStartModal && !autoStartModal.hidden) {
    resolveModalChoice(null);
  }
});

inputManualCode.addEventListener('input', () => {
  inputManualCode.value = normalizeManualCodeInput(inputManualCode.value);
});

inputManualCode.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    btnSubmitManualCode.click();
  }
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('确认重置全部步骤和数据吗？')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = '等待中...';
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = '等待中...';
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = '就绪';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    btnAutoRun.innerHTML = AUTO_BUTTON_HTML;
    autoContinueBar.style.display = 'none';
    hideManualCodeModal();
    autoContinueMode = 'email';
    autoContinueHint.textContent = getEmailPauseHint(currentRunMode, currentEmailProvider);
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();

    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).catch(() => null);
    applyRunModeUI(state?.runMode, state?.emailProvider);
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

if (btnDownloadLog) {
  btnDownloadLog.addEventListener('click', async () => {
    await downloadLogsAsJson();
  });
}

// Save settings on change
selectRunMode.addEventListener('change', async () => {
  applyRunModeUI(selectRunMode.value, selectEmailProvider?.value);
  await persistDraftSettings();
});

if (selectEmailProvider) {
  selectEmailProvider.addEventListener('change', async () => {
    selectEmailProvider.value = normalizeEmailProvider(selectEmailProvider.value);
    applyRunModeUI(currentRunMode, selectEmailProvider.value);
    await persistDraftSettings();
  });
}

inputOtpWaitSeconds.addEventListener('input', () => {
  inputOtpWaitSeconds.value = String(normalizeOtpWaitSeconds(inputOtpWaitSeconds.value));
});

inputOtpWaitSeconds.addEventListener('change', async () => {
  inputOtpWaitSeconds.value = String(normalizeOtpWaitSeconds(inputOtpWaitSeconds.value));
  await persistDraftSettings();
});

inputEmail.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email: inputEmail.value.trim() } });
});

inputVpsUrl.addEventListener('change', async () => {
  await persistDraftSettings();
});

inputPassword.addEventListener('change', async () => {
  await persistDraftSettings();
});

if (inputAutoSkipFailures) {
  inputAutoSkipFailures.addEventListener('change', async () => {
    await persistDraftSettings();
  });
}

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then((state) => {
        syncLatestState(state);
        updateStatusDisplay(state);
      }).catch(() => {});
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncLatestState(state);
          syncPasswordField(state);
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
          if (!state.manualCodeEntry) {
            hideManualCodeModal();
          }
        }).catch(() => {});
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = '等待中...';
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = '等待中...';
      displayLocalhostUrl.classList.remove('has-value');
      if (!isManualMode()) {
        inputEmail.value = '';
      }
      displayStatus.textContent = '就绪';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      autoContinueMode = 'email';
      autoContinueHint.textContent = getEmailPauseHint(currentRunMode, currentEmailProvider);
      hideManualCodeModal();
      if (latestState) {
        latestState.stepStatuses = { ...STEP_DEFAULT_STATUSES };
        latestState.autoRunning = false;
        latestState.autoRunPhase = 'idle';
      }
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      latestState = latestState || {};
      if (message.payload.emailProvider !== undefined) {
        latestState.emailProvider = message.payload.emailProvider;
        applyRunModeUI(currentRunMode, message.payload.emailProvider);
      }
      if (message.payload.runMode !== undefined) {
        latestState.runMode = message.payload.runMode;
        applyRunModeUI(message.payload.runMode, message.payload.emailProvider ?? currentEmailProvider);
      }
      if (message.payload.otpWaitSeconds !== undefined) {
        latestState.otpWaitSeconds = message.payload.otpWaitSeconds;
        inputOtpWaitSeconds.value = String(normalizeOtpWaitSeconds(message.payload.otpWaitSeconds));
      }
      if (message.payload.autoRunSkipFailures !== undefined && inputAutoSkipFailures) {
        latestState.autoRunSkipFailures = Boolean(message.payload.autoRunSkipFailures);
        inputAutoSkipFailures.checked = Boolean(message.payload.autoRunSkipFailures);
      }
      if (message.payload.email !== undefined) {
        latestState.email = message.payload.email || '';
        inputEmail.value = message.payload.email || '';
      }
      if (message.payload.password !== undefined) {
        latestState.password = message.payload.password || '';
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.oauthUrl) {
        latestState.oauthUrl = message.payload.oauthUrl;
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        latestState.localhostUrl = message.payload.localhostUrl;
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      if (Object.prototype.hasOwnProperty.call(message.payload, 'manualCodeEntry')) {
        latestState.manualCodeEntry = message.payload.manualCodeEntry || null;
        if (message.payload.manualCodeEntry) {
          showManualCodeModal(message.payload.manualCodeEntry);
        } else {
          hideManualCodeModal();
        }
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      applyAutoRunStatusPayload(message.payload);
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
initializeStepActions();
resetActionModalButtons();
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
});
