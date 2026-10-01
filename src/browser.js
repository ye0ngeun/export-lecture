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

/** 비밀번호 칸과 같은 폼 안에서 아이디 칸을 찾는다 (검색창 등을 잘못 잡지 않도록). */
async function findIdNextToPassword(page, pwInput) {
  const marked = await pwInput.evaluate((pw) => {
    const scope = pw.closest('form') || pw.parentElement?.parentElement?.parentElement || document;
    const inputs = Array.from(scope.querySelectorAll('input'));
    const candidates = inputs.filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'tel'].includes(type) && el.offsetParent !== null;
    });
    // 비밀번호 칸 바로 앞에 있는 입력칸을 우선
    const before = candidates.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pick = before[before.length - 1] || candidates[0];
    if (!pick) return false;
    pick.setAttribute('data-export-login-id', '1');
    return true;
  });
  return marked ? page.locator('[data-export-login-id="1"]') : null;
}

async function saveLoginFailure(page, config) {
  const base = path.join(path.dirname(config.authStatePath), 'login-failed');
  await fs.mkdir(path.dirname(base), { recursive: true });
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${base}.html`, await page.content().catch(() => '')).catch(() => {});
  return `${base}.png`;
}

const isLoginUrl = (url, config) => {
  try {
    return new URL(url).pathname === new URL(config.loginUrl).pathname || /login/i.test(new URL(url).pathname);
  } catch {
    return true;
  }
};

async function login(page, config, { interactive }) {
  console.log('🔐 로그인 중...');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const pwInput = config.loginSelectors.password
    ? page.locator(config.loginSelectors.password).first()
    : await firstVisible(page, PASSWORD_SELECTORS);
  const idInput = config.loginSelectors.id
    ? page.locator(config.loginSelectors.id).first()
    : (await firstVisible(page, ID_SELECTORS.slice(0, 4))) ?? (pwInput && (await findIdNextToPassword(page, pwInput)));

  if (!idInput || !pwInput) {
    const shot = await saveLoginFailure(page, config);
    throw new Error(
      `로그인 입력칸을 찾지 못했습니다 (현재 주소: ${page.url()}).\n` +
      `   화면: ${shot}\n` +
      '   .env 의 LOGIN_ID_SELECTOR / LOGIN_PASSWORD_SELECTOR 를 지정하거나 위 화면을 보내 주세요.'
    );
  }

  await idInput.fill(config.id);
  await pwInput.fill(config.password);

  const submit = config.loginSelectors.submit
    ? page.locator(config.loginSelectors.submit).first()
    : await firstVisible(page, SUBMIT_SELECTORS);

  // 사이트가 띄우는 alert/confirm 은 모두 "확인"으로 넘긴다.
  // (예: "다른 곳에서 로그인 중입니다. 계속하시겠습니까?" 를 취소하면 로그인이 안 됨)
  const messages = [];
  const onDialog = async (dialog) => {
    messages.push(dialog.message());
    console.log(`   💬 사이트 메시지: ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);

  if (submit) await submit.click();
  else await pwInput.press('Enter');

  // 캡차/추가 인증이 있으면 창을 띄운 상태(interactive)에서 직접 처리할 시간을 준다.
  const timeout = interactive ? 180_000 : 30_000;
  if (interactive) console.log('   (추가 인증이 뜨면 브라우저 창에서 직접 완료해 주세요)');

  // 로그인 페이지를 벗어났거나, 비밀번호 칸이 사라지면 성공으로 본다.
  let success = false;
  for (let waited = 0; waited < timeout; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isLoginUrl(page.url(), config)) { success = true; break; }
    const pwVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => true);
    if (!pwVisible) { success = true; break; }
  }
  page.off('dialog', onDialog);

  if (!success) {
    const shot = await saveLoginFailure(page, config);
    throw new Error(
      `로그인에 실패했습니다 (현재 주소: ${page.url()}).` +
      (messages.length ? `\n   사이트 메시지: ${messages.map((m) => `"${m}"`).join(', ')}` : '') +
      `\n   실패 화면: ${shot}` +
      (interactive ? '' : '\n   --headed 를 붙여서 실행하면 브라우저 창으로 과정을 직접 볼 수 있습니다.')
    );
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  console.log('✅ 로그인 성공');
}

/**
 * 저장된 세션(.auth/state.json)이 유효하면 재사용하고, 아니면 .env 계정으로 로그인한다.
 */
export async function createLoggedInContext(browser, config, { interactive = false } = {}) {
  const hasState = await fs.access(config.authStatePath).then(() => true, () => false);
  // 창 없는(headless) 모드의 User-Agent 에는 "HeadlessChrome" 이 들어가서 일부 사이트가 막는다.
  const probe = await browser.newPage();
  const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
  await probe.close();
  const contextOptions = { acceptDownloads: true, viewport: { width: 1440, height: 900 }, userAgent, locale: 'ko-KR' };

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
