import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ID_SELECTORS = [
  '#userId', 'input[name="userId"]', '#loginId', 'input[name="loginId"]',
  'input[type="email"]', 'input[name*="id" i]:not([type="hidden"])', 'input[type="text"]',
];
const PASSWORD_SELECTORS = ['#userPwd', 'input[name="userPwd"]', 'input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]', '.btn-login', '#btnLogin',
  'a:has-text("로그인")', 'button:has-text("로그인")',
];

export async function launchBrowser(config, { headless = config.headless } = {}) {
  const launchOptions = { headless };
  if (config.browserChannel) launchOptions.channel = config.browserChannel;
  if (config.browserExecutablePath) launchOptions.executablePath = config.browserExecutablePath;
  return chromium.launch(launchOptions);
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function isLoggedIn(page, config) {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const onLoginPage = /login/i.test(page.url());
  const hasPasswordField = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  return !onLoginPage && !hasPasswordField;
}

async function login(page, config, { interactive }) {
  console.log('🔐 로그인 중...');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const idInput = config.loginSelectors.id
    ? page.locator(config.loginSelectors.id).first()
    : await firstVisible(page, ID_SELECTORS);
  const pwInput = config.loginSelectors.password
    ? page.locator(config.loginSelectors.password).first()
    : await firstVisible(page, PASSWORD_SELECTORS);

  if (!idInput || !pwInput) {
    throw new Error(
      '로그인 입력칸을 찾지 못했습니다. .env 의 LOGIN_ID_SELECTOR / LOGIN_PASSWORD_SELECTOR 를 지정해 주세요.'
    );
  }

  await idInput.fill(config.id);
  await pwInput.fill(config.password);

  const submit = config.loginSelectors.submit
    ? page.locator(config.loginSelectors.submit).first()
    : await firstVisible(page, SUBMIT_SELECTORS);

  // 로그인 실패 시 alert 가 뜨는 사이트가 많으므로 메시지를 잡아서 보여준다.
  let alertMessage = '';
  const onDialog = async (dialog) => {
    alertMessage = dialog.message();
    await dialog.dismiss().catch(() => {});
  };
  page.on('dialog', onDialog);

  if (submit) await submit.click();
  else await pwInput.press('Enter');

  // 캡차/추가 인증이 있으면 창을 띄운 상태(interactive)에서 직접 처리할 시간을 준다.
  const timeout = interactive ? 180_000 : 30_000;
  if (interactive) console.log('   (추가 인증이 뜨면 브라우저 창에서 직접 완료해 주세요)');
  try {
    await page.waitForFunction(
      () => !document.querySelector('input[type="password"]') ||
        !document.querySelector('input[type="password"]').offsetParent,
      null,
      { timeout, polling: 500 }
    );
  } catch {
    page.off('dialog', onDialog);
    throw new Error(`로그인에 실패했습니다.${alertMessage ? ` 사이트 메시지: "${alertMessage}"` : ''}`);
  }
  page.off('dialog', onDialog);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  console.log('✅ 로그인 성공');
}

/**
 * 저장된 세션(.auth/state.json)이 유효하면 재사용하고, 아니면 .env 계정으로 로그인한다.
 */
export async function createLoggedInContext(browser, config, { interactive = false } = {}) {
  const hasState = await fs.access(config.authStatePath).then(() => true, () => false);
  const contextOptions = { acceptDownloads: true, viewport: { width: 1440, height: 900 } };

  if (hasState) {
    const context = await browser.newContext({ ...contextOptions, storageState: config.authStatePath });
    const page = await context.newPage();
    if (await isLoggedIn(page, config)) {
      console.log('✅ 저장된 로그인 세션을 재사용합니다.');
      return { context, page };
    }
    await context.close();
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await login(page, config, { interactive });
  await fs.mkdir(path.dirname(config.authStatePath), { recursive: true });
  await context.storageState({ path: config.authStatePath });
  return { context, page };
}
