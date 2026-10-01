#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { launchBrowser, createLoggedInContext } from './browser.js';
import { saveEbookAsPdf, trackPageImages } from './ebook.js';
import { runMaterials, runSync } from './materials.js';
import { evaluateSafe } from './evaluate.js';
import { isPageImageUrl, parsePageImageUrl, sanitizeFileName } from './pattern.js';

const HELP = `
사용법: npm start -- [옵션]

모드 (하나 선택)
  --sync              courses.json 규칙대로 새로 올라온 교안만 각 폴더에 저장 (npm run sync)
  --materials         학습자료에서 검색 → 제목 필터에 맞는 교안을 전부 PDF 로 저장
                        --keyword <검색어>   (기본: .env SEARCH_KEYWORD, 자바전공)
                        --title <정규식>     (기본: .env TITLE_FILTER, ^16기_자바전공_APS)
                        --dry-run            받지 않고 대상 목록만 출력
  --url <주소>        e-book 뷰어 주소를 직접 지정 (여러 번 사용 가능)
  --urls <파일>       뷰어 주소 목록 파일 (한 줄에 "주소 [제목]", # 주석 가능)
  --discover          .env 의 LECTURE_LIST_URL 페이지에서 교안 링크를 찾아 전부 받기
  --watch             브라우저 창을 띄우고 자동 로그인 → 내가 여는 교안을 자동 저장

기타
  --headed            브라우저 창을 띄워서 실행 (디버깅용)
  --folder <이름>      downloads 아래 이 이름의 폴더에 저장 (예: --folder 프론트엔드)
  --force             이미 받은 교안도 다시 받기
  --logout            저장된 로그인 세션 삭제 후 다시 로그인
  --debug             목록/상세 화면을 downloads/_debug 에 HTML·스크린샷으로 저장
  -h, --help          도움말
`;

/** 한 줄에 "주소 [제목]" 형식. 제목을 적으면 PDF 파일 이름으로 쓴다. */
async function readUrlFile(file) {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [url, ...title] = line.split(/\s+/);
      return { url, title: title.join(' ') };
    });
}

async function openAndSave(context, config, { url, title }, { force }) {
  const page = await context.newPage();
  const seen = trackPageImages(page);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await saveEbookAsPdf(page, context, config, { seen, force, titleHint: title });
  } finally {
    await page.close();
  }
}

async function runUrls(context, config, urls, opts) {
  let ok = 0;
  for (const [i, entry] of urls.entries()) {
    console.log(`\n[${i + 1}/${urls.length}] ${entry.url}`);
    try {
      await openAndSave(context, config, entry, opts);
      ok += 1;
    } catch (err) {
      console.error(`❌ ${err.message}`);
    }
  }
  console.log(`\n완료: ${ok}/${urls.length}`);
}

/** 목록 페이지에서 교안 링크를 하나씩 눌러 열리는 뷰어(팝업 또는 같은 탭)를 저장한다. */
async function runDiscover(context, page, config, opts) {
  if (!config.lectureListUrl) {
    throw new Error('--discover 를 쓰려면 .env 에 LECTURE_LIST_URL 을 설정해 주세요.');
  }
  await page.goto(config.lectureListUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // 교안 버튼 후보: 텍스트가 EBOOK_LINK_PATTERN 과 맞는 a / button / onclick 요소
  const markCandidates = async () => evaluateSafe(page, ({ linkSrc, linkFlags, filterSrc, filterFlags }) => {
    const linkRe = new RegExp(linkSrc, linkFlags);
    const filterRe = filterSrc ? new RegExp(filterSrc, filterFlags) : null;
    const nodes = Array.from(document.querySelectorAll('a, button, [onclick], [role="button"]'));
    const picked = [];
    for (const el of nodes) {
      const label = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('alt') || ''}`;
      if (!linkRe.test(label)) continue;
      const row = el.closest('tr, li, .item, .card, .list-item, [class*="row"]') || el.parentElement;
      // 행 텍스트에서 버튼 글자("교안 보기" 등)는 빼고 강의 제목만 남긴다.
      const rowText = (row?.textContent || label).replace(el.textContent || '', ' ').replace(/\s+/g, ' ').trim()
        || label.replace(/\s+/g, ' ').trim();
      if (filterRe && !filterRe.test(rowText)) continue;
      if (picked.some((p) => p.el.contains(el) || el.contains(p.el))) continue;
      picked.push({ el, rowText });
    }
    return picked.map(({ el, rowText }, i) => {
      el.setAttribute('data-export-lecture', String(i));
      return rowText.slice(0, 100);
    });
  }, {
    linkSrc: config.ebookLinkPattern.source,
    linkFlags: config.ebookLinkPattern.flags,
    filterSrc: config.lectureFilter?.source ?? '',
    filterFlags: config.lectureFilter?.flags ?? '',
  });

  const titles = await markCandidates();
  if (titles.length === 0) {
    throw new Error('목록에서 교안 링크를 찾지 못했습니다. EBOOK_LINK_PATTERN / LECTURE_FILTER 를 확인하거나 --watch 모드를 사용해 주세요.');
  }
  console.log(`🔎 교안 후보 ${titles.length}개 발견`);

  let ok = 0;
  for (const [i, title] of titles.entries()) {
    console.log(`\n[${i + 1}/${titles.length}] ${title}`);
    try {
      // 같은 탭 이동 후 돌아왔을 수 있으므로 매번 다시 표시한다.
      if (!(await page.locator(`[data-export-lecture="${i}"]`).count())) await markCandidates();
      const seenSame = trackPageImages(page);
      const popupPromise = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
      await page.locator(`[data-export-lecture="${i}"]`).click();
      const popup = await popupPromise;

      if (popup) {
        const seen = trackPageImages(popup);
        try {
          await popup.waitForLoadState('domcontentloaded');
          await saveEbookAsPdf(popup, context, config, { seen, titleHint: title, ...opts });
        } finally {
          await popup.close().catch(() => {});
        }
      } else {
        await saveEbookAsPdf(page, context, config, { seen: seenSame, titleHint: title, ...opts });
      }
      ok += 1;
    } catch (err) {
      console.error(`❌ ${err.message}`);
    } finally {
      page.removeAllListeners('request');
      // 같은 탭에서 뷰어로 이동했으면 목록으로 돌아온다.
      if (page.url() !== config.lectureListUrl) {
        await page.goto(config.lectureListUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      }
    }
  }
  console.log(`\n완료: ${ok}/${titles.length}`);
}

/** 창을 띄워 두고, 사용자가 여는 모든 e-book 뷰어를 감지해서 자동 저장한다. */
async function runWatch(context, page, config, opts) {
  const handled = new Set();
  let queue = Promise.resolve();

  const attach = (target) => {
    const seen = new Set();
    target.on('request', (request) => {
      const url = request.url();
      if (!isPageImageUrl(url)) return;
      const template = parsePageImageUrl(url);
      if (!template) return;
      seen.add(url);
      if (handled.has(template.prefix)) return;
      handled.add(template.prefix);
      // 뷰어가 페이지 수 표시를 그릴 시간을 조금 준 뒤 순서대로 처리
      queue = queue
        .then(() => new Promise((r) => setTimeout(r, 2000)))
        .then(() => saveEbookAsPdf(target, context, config, { seen, ...opts }))
        .catch((err) => {
          handled.delete(template.prefix);
          console.error(`❌ ${err.message}`);
        });
    });
  };

  context.pages().forEach(attach);
  context.on('page', attach);

  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  console.log('\n👀 감시 모드: 브라우저 창에서 자바 교안(e-book)을 열기만 하면 자동으로 PDF 로 저장됩니다.');
  console.log('   끝내려면 브라우저 창을 닫거나 Ctrl+C 를 누르세요.\n');

  await new Promise((resolve) => {
    context.browser()?.on('disconnected', resolve);
    process.on('SIGINT', resolve);
  });
  await queue;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', multiple: true },
      urls: { type: 'string' },
      discover: { type: 'boolean' },
      materials: { type: 'boolean' },
      sync: { type: 'boolean' },
      keyword: { type: 'string' },
      title: { type: 'string' },
      'dry-run': { type: 'boolean' },
      debug: { type: 'boolean' },
      folder: { type: 'string' },
      watch: { type: 'boolean' },
      headed: { type: 'boolean' },
      force: { type: 'boolean' },
      logout: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const urls = [
    ...(values.url ?? []).map((url) => ({ url, title: '' })),
    ...(values.urls ? await readUrlFile(values.urls) : []),
  ];
  if (values.help || (!urls.length && !values.discover && !values.watch && !values.materials && !values.sync)) {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  if (values.logout) await fs.rm(config.authStatePath, { force: true });
  if (values.keyword) config.searchKeyword = values.keyword;
  if (values.title) config.titleFilter = new RegExp(values.title, 'i');
  config.debug = Boolean(values.debug);
  if (values.folder) config.outputDir = path.join(config.outputDir, sanitizeFileName(values.folder));

  const interactive = Boolean(values.watch || values.headed);
  const browser = await launchBrowser(config, { headless: interactive ? false : config.headless });
  const opts = { force: Boolean(values.force) };

  try {
    const { context, page } = await createLoggedInContext(browser, config, { interactive });
    if (values.watch) await runWatch(context, page, config, opts);
    else if (values.sync) await runSync(context, page, config, { ...opts, dryRun: Boolean(values['dry-run']) });
    else if (values.materials) await runMaterials(context, page, config, { ...opts, dryRun: Boolean(values['dry-run']) });
    else if (values.discover) await runDiscover(context, page, config, opts);
    else await runUrls(context, config, urls, opts);
    await context.storageState({ path: config.authStatePath }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exitCode = 1;
});
