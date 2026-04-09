// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};

const RUN_MODE_AUTO = 'auto';
const RUN_MODE_MANUAL = 'manual';
const MANUAL_CODE_LENGTH = 6;
const AUTO_BUTTON_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const inputVpsUrl = document.getElementById('input-vps-url');
const inputRunCount = document.getElementById('input-run-count');
const selectRunMode = document.getElementById('select-run-mode');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const btnClearLog = document.getElementById('btn-clear-log');
const autoContinueBar = document.getElementById('auto-continue-bar');
const autoContinueHint = document.getElementById('auto-continue-hint');
const stepsProgress = document.getElementById('steps-progress');
const manualCodeModal = document.getElementById('manual-code-modal');
const manualCodeTitle = document.getElementById('manual-code-title');
const manualCodeHint = document.getElementById('manual-code-hint');
const inputManualCode = document.getElementById('input-manual-code');
const btnSubmitManualCode = document.getElementById('btn-submit-manual-code');
const btnCancelManualCode = document.getElementById('btn-cancel-manual-code');

let autoContinueMode = 'email';
let currentRunMode = RUN_MODE_AUTO;

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

function showToast(message, type = 'error', duration = 4000) {
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

function isManualMode(mode = currentRunMode) {
  return normalizeRunMode(mode) === RUN_MODE_MANUAL;
}

function applyRunModeUI(mode) {
  currentRunMode = normalizeRunMode(mode);
  selectRunMode.value = currentRunMode;

  if (isManualMode()) {
    btnFetchEmail.style.display = 'none';
    btnFetchEmail.disabled = true;
    inputEmail.placeholder = '手动模式下请手动粘贴邮箱地址';
  } else {
    btnFetchEmail.style.display = 'inline-flex';
    btnFetchEmail.disabled = false;
    inputEmail.placeholder = '自动从 Burner Mailbox 获取，或手动粘贴';
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

    applyRunModeUI(state.runMode);

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
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');
  const modalVisible = manualCodeModal && manualCodeModal.style.display !== 'none';
  const lockStepButtons = anyRunning || modalVisible;

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;

    if (lockStepButtons) {
      btn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[step - 1];
      const currentStatus = statuses[step];
      btn.disabled = !(prevStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'stopped');
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none' || modalVisible);
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  if (state.manualCodeEntry) {
    const step = Number(state.manualCodeEntry.step || 0);
    displayStatus.textContent = step ? `步骤 ${step} 等待输入验证码` : '等待输入验证码';
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
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = '全部步骤已完成';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `步骤 ${lastCompleted} 已完成`;
  } else {
    displayStatus.textContent = '就绪';
  }
}

function appendLog(entry) {
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
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function persistDraftSettings() {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: {
      vpsUrl: inputVpsUrl.value.trim(),
      customPassword: inputPassword.value,
      runMode: normalizeRunMode(selectRunMode.value),
    },
  });

  await chrome.runtime.sendMessage({
    type: 'SAVE_EMAIL',
    source: 'sidepanel',
    payload: { email: inputEmail.value.trim() },
  });
}

async function fetchBurnerEmail() {
  const defaultLabel = '自动';
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';

  try {
    let response = await chrome.runtime.sendMessage({
      type: 'FETCH_BURNER_EMAIL',
      source: 'sidepanel',
      payload: { generateNew: true },
    });

    if (response?.error && /(security verification required|需要.*安全验证)/i.test(response.error)) {
      const confirmed = window.confirm(
        'Burner Mailbox 需要先完成人机验证。\n\n请切到邮箱页完成验证，完成后点“确定”，我会直接继续获取邮箱，不需要你再点“自动”。'
      );
      if (!confirmed) {
        throw new Error(response.error);
      }

      response = await chrome.runtime.sendMessage({
        type: 'CONTINUE_BURNER_AFTER_CHALLENGE',
        source: 'sidepanel',
        payload: { generateNew: true },
      });
    }

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error('未返回 Burner Mailbox 邮箱地址。');
    }

    inputEmail.value = response.email;
    showToast(`已获取邮箱 ${response.email}`, 'success', 2500);
    return response.email;
  } catch (err) {
    showToast(`自动获取邮箱失败：${err.message}`, 'error');
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

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    await persistDraftSettings();
    if (step === 3) {
      const email = inputEmail.value.trim();
      if (!email) {
        showToast('请先粘贴邮箱地址，或先点击“自动”获取', 'warn');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, email } });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

btnFetchEmail.addEventListener('click', async () => {
  if (isManualMode()) {
    showToast('手动模式下请直接粘贴邮箱地址', 'warn', 2000);
    return;
  }
  await fetchBurnerEmail().catch(() => {});
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
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 运行中...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnAutoContinue.addEventListener('click', async () => {
  if (autoContinueMode === 'email') {
    const email = inputEmail.value.trim();
    if (!email) {
      showToast('请先获取或粘贴 Burner Mailbox 邮箱地址', 'warn');
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
    autoContinueHint.textContent = '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();

    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).catch(() => null);
    applyRunModeUI(state?.runMode);
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
selectRunMode.addEventListener('change', async () => {
  applyRunModeUI(selectRunMode.value);
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

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay).catch(() => {});
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
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
      inputEmail.value = '';
      displayStatus.textContent = '就绪';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      autoContinueMode = 'email';
      autoContinueHint.textContent = '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
      hideManualCodeModal();
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.runMode !== undefined) {
        applyRunModeUI(message.payload.runMode);
      }
      if (message.payload.email !== undefined) {
        inputEmail.value = message.payload.email || '';
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      if (Object.prototype.hasOwnProperty.call(message.payload, 'manualCodeEntry')) {
        if (message.payload.manualCodeEntry) {
          showManualCodeModal(message.payload.manualCodeEntry);
        } else {
          hideManualCodeModal();
        }
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.style.display = 'flex';
          autoContinueMode = 'email';
          autoContinueHint.textContent = '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
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
        case 'waiting_manual_code':
          autoContinueBar.style.display = 'none';
          btnAutoRun.innerHTML = `已暂停${runLabel}`;
          updateStopButtonState(true);
          showManualCodeModal(message.payload.manualCodeEntry || null);
          break;
        case 'running':
          btnAutoRun.innerHTML = `运行中${runLabel}`;
          updateStopButtonState(true);
          autoContinueBar.style.display = 'none';
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = AUTO_BUTTON_HTML;
          autoContinueBar.style.display = 'none';
          autoContinueMode = 'email';
          autoContinueHint.textContent = '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
          updateStopButtonState(false);
          hideManualCodeModal();
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = AUTO_BUTTON_HTML;
          autoContinueBar.style.display = 'none';
          autoContinueMode = 'email';
          autoContinueHint.textContent = '点击“自动”获取 Burner Mailbox 邮箱，或手动粘贴后继续';
          updateStopButtonState(false);
          break;
      }
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
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
});
