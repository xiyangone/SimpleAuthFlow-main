// content/duck-mail.js — DuckDuckGo 私有地址生成

console.log('[SimpleAuthFlow:duck-mail] Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FETCH_DUCK_EMAIL') return;

  resetStopState();
  fetchDuckEmail(message.payload || {}).then((result) => {
    sendResponse(result);
  }).catch((err) => {
    if (isStopError(err)) {
      log('Duck 邮箱：已被用户停止。', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }
    sendResponse({ error: err.message });
  });

  return true;
});

async function fetchDuckEmail(payload = {}) {
  const { generateNew = true } = payload;

  log(`Duck 邮箱：正在${generateNew ? '生成' : '读取'}私有地址...`);

  await waitForElement(
    'input.AutofillSettingsPanel__PrivateDuckAddressValue, button.AutofillSettingsPanel__GeneratorButton',
    15000
  );

  const getAddressInput = () => document.querySelector('input.AutofillSettingsPanel__PrivateDuckAddressValue');
  const getGeneratorButton = () => document.querySelector('button.AutofillSettingsPanel__GeneratorButton')
    || Array.from(document.querySelectorAll('button')).find((btn) => /generate private duck address/i.test(btn.textContent || ''));
  const readEmail = () => {
    const value = getAddressInput()?.value?.trim() || '';
    return value.includes('@duck.com') ? value : '';
  };

  const waitForEmailValue = async (previousValue = '') => {
    for (let i = 0; i < 100; i += 1) {
      const nextValue = readEmail();
      if (nextValue && nextValue !== previousValue) {
        return nextValue;
      }
      await sleep(150);
    }
    throw new Error('等待 Duck 私有地址出现超时。');
  };

  const currentEmail = readEmail();
  if (currentEmail && !generateNew) {
    log(`Duck 邮箱：已发现现有地址 ${currentEmail}`);
    return { email: currentEmail, generated: false };
  }

  await humanPause(500, 1300);
  const generatorButton = getGeneratorButton();
  if (!generatorButton) {
    if (currentEmail) {
      log(`Duck 邮箱：正在复用现有地址 ${currentEmail}`, 'warn');
      return { email: currentEmail, generated: false };
    }
    throw new Error('未找到“生成 Duck 私有地址”按钮。');
  }

  generatorButton.click();
  log('Duck 邮箱：已点击“生成 Duck 私有地址”按钮');

  const nextEmail = await waitForEmailValue(currentEmail);
  log(`Duck 邮箱：地址已就绪 ${nextEmail}`, 'ok');
  return { email: nextEmail, generated: true };
}
