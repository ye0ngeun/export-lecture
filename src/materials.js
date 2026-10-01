import fs from 'node:fs/promises';
import path from 'node:path';
import { saveEbookAsPdf, trackContextRequests, trackPageImages } from './ebook.js';
import { evaluateSafe } from './evaluate.js';
import { isPageImageUrl, sanitizeFileName } from './pattern.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

// 상세 페이지에서 e-book 뷰어를 여는 버튼 글자
const EBOOK_BUTTON_PATTERN = /교재\s*보기|교안|e-?book|이북|전자책|열람|뷰어|바로\s*보기|교재/i;

async function dumpDebug(page, config, name) {
  if (!config.debug) return;
  const dir = path.join(config.outputDir, '_debug');
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, sanitizeFileName(name));
  await fs.writeFile(`${base}.html`, await page.content()).catch(() => {});
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  console.log(`   🐞 디버그 저장: ${base}.html / .png`);
}

/** 학습자료 페이지로 이동한다. 주소를 모르면 메뉴의 "학습자료" 링크를 따라간다. */
async function gotoMaterials(page, config) {
  if (config.materialsUrl) {
    await page.goto(config.materialsUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);
    return;
  }
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const link = page.locator('a', { hasText: /^\s*학습자료\s*$/ }).first();
  const href = await link.getAttribute('href').catch(() => null);
  if (href && !href.startsWith('javascript') && href !== '#') {
    await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' });
  } else {
    // 드롭다운 메뉴 안에 숨어 있으면 상위 메뉴에 마우스를 올린 뒤 클릭
    await page.locator('a', { hasText: /^\s*강의실\s*$/ }).first().hover().catch(() => {});
    await link.click({ timeout: 10_000 });
  }
  await settle(page);
  config.materialsUrl = page.url();
  console.log(`📂 학습자료 페이지: ${config.materialsUrl}`);
}

/** 키워드 검색창에 검색어를 넣고 검색한다. */
async function search(page, keyword) {
  if (!keyword) return;
  const candidates = [
    'input[placeholder*="키워드"]',
    'input[placeholder*="검색"]',
    'input[type="search"]',
    'input[name*="keyword" i]',
    'input[name*="search" i]',
  ];
  let input = null;
  for (const selector of candidates) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) { input = loc; break; }
  }
  if (!input) throw new Error('학습자료 페이지에서 검색창을 찾지 못했습니다. (--debug 로 화면을 저장해 보내 주세요)');

  await input.fill(keyword);
  const button = page.locator('button, a, input[type="button"], input[type="submit"]', { hasText: /^\s*검색\s*$/ }).first();
  if (await button.isVisible().catch(() => false)) await button.click();
  else await input.press('Enter');
  await settle(page);
  await sleep(500);
}

/**
 * 현재 화면에서 제목이 필터와 맞는 항목들을 찾아 data-export-item 표시를 붙이고 제목 목록을 돌려준다.
 * 같은 제목이 설명 줄에 한 번 더 나오므로 처음 나온 것만 쓴다.
 */
async function markItems(page, filter) {
  return evaluateSafe(page, ({ src, flags }) => {
    const re = new RegExp(src, flags);
    const clean = (t) => t.replace(/\s+/g, ' ').replace(/\s*교재\s*$/, '').trim();
    document.querySelectorAll('[data-export-item]').forEach((el) => el.removeAttribute('data-export-item'));

    const matches = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (['SCRIPT', 'STYLE', 'INPUT', 'OPTION'].includes(el.tagName)) return false;
      return re.test(clean(el.textContent || ''));
    });
    // 가장 안쪽 요소만 (자식 중에 또 맞는 게 있으면 제외)
    const innermost = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));

    const titles = [];
    for (const el of innermost) {
      const title = clean(el.textContent || '');
      if (titles.includes(title)) continue;
      el.setAttribute('data-export-item', String(titles.length));
      titles.push(title);
    }
    return titles;
  }, { src: filter.source, flags: filter.flags });
}

/** 다음 목록으로 넘어간다: "더보기" 버튼 또는 페이지 번호/다음 버튼. 넘어갔으면 true. */
async function nextListPage(page, currentPageNumber) {
  const more = page.locator('button, a', { hasText: /^\s*(더\s*보기|more)\s*\+?\s*$/i }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await settle(page);
    return true;
  }
  const next = String(currentPageNumber + 1);
  const pager = page.locator(
    '[class*="paging" i] a, [class*="pagination" i] a, [class*="pager" i] a, [class*="paging" i] button, [class*="pagination" i] button'
  );
  const numbered = pager.filter({ hasText: new RegExp(`^\\s*${next}\\s*$`) }).first();
  if (await numbered.isVisible().catch(() => false)) {
    await numbered.click();
    await settle(page);
    return true;
  }
  // 번호가 안 보이면(10페이지 단위 묶음) "다음" 버튼
  const nextButton = page.locator(
    '[class*="next" i]:not([class*="disabled" i]), a[title*="다음"], button[title*="다음"], a:has-text("다음"), a:has-text(">")'
  ).first();
  if (await nextButton.isVisible().catch(() => false)) {
    const before = await page.content();
    await nextButton.click();
    await settle(page);
    return (await page.content()) !== before;
  }
  return false;
}

/** 검색 결과 전체를 넘겨 가며 필터에 맞는 제목과 그 제목이 있는 목록 위치(몇 번째 페이지)를 모은다. */
async function collectItems(page, config) {
  await gotoMaterials(page, config);
  await search(page, config.searchKeyword);
  await dumpDebug(page, config, '01_목록');

  const items = [];
  for (let listPage = 1; listPage <= 100; listPage += 1) {
    for (const title of await markItems(page, config.titleFilter)) {
      if (!items.some((it) => it.title === title)) items.push({ title, listPage });
    }
    if (!(await nextListPage(page, listPage))) break;
  }
  return items;
}

/** 목록을 처음부터 다시 열어 해당 항목이 보이는 상태로 만든다. */
async function revealItem(page, config, item) {
  await page.goto(config.materialsUrl, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await search(page, config.searchKeyword);
  for (let listPage = 1; listPage <= item.listPage; listPage += 1) {
    const titles = await markItems(page, config.titleFilter);
    const index = titles.indexOf(item.title);
    if (index >= 0) return page.locator(`[data-export-item="${index}"]`);
    if (!(await nextListPage(page, listPage))) break;
  }
  throw new Error('목록에서 항목을 다시 찾지 못했습니다.');
}

/** 페이지(또는 팝업)에 e-book 페이지 이미지가 나타났는지 잠시 기다려 본다. */
async function waitForViewer(target, seen, ms) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (seen.size > 0) return true;
    const found = await evaluateSafe(
      target, () => performance.getEntriesByType('resource').map((e) => e.name)
    ).catch(() => []);
    if (found.some(isPageImageUrl)) return true;
    await sleep(500);
  }
  return false;
}

/** 클릭 한 번으로 팝업이 뜨거나, 같은 탭이 이동하거나, 파일 다운로드가 시작될 수 있다. */
async function clickAndFollow(page, context, locator) {
  const before = page.url();
  const seenSame = trackPageImages(page);
  // 팝업 / 다운로드 / 같은 탭 이동 / 뷰어 이미지 로딩 중 먼저 일어나는 것을 기다린다.
  const outcome = Promise.race([
    context.waitForEvent('page', { timeout: 8_000 }).then((p) => ({ popup: p }), () => null),
    page.waitForEvent('download', { timeout: 8_000 }).then((d) => ({ download: d }), () => null),
    page.waitForURL((url) => url.toString() !== before, { timeout: 8_000, waitUntil: 'commit' }).then(() => ({}), () => null),
    page.waitForRequest((req) => isPageImageUrl(req.url()), { timeout: 8_000 }).then(() => ({}), () => null),
  ]);
  await locator.click();
  const { popup = null, download = null } = (await outcome) ?? {};
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    // 뷰어는 계속 통신하는 경우가 많아 networkidle 을 오래 기다리지 않는다.
    await popup.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  } else {
    await settle(page);
  }
  return { popup, download, seenSame };
}

async function saveDownload(download, config, title) {
  const ext = path.extname(download.suggestedFilename()) || '.pdf';
  const outPath = path.join(config.outputDir, `${sanitizeFileName(title)}${ext}`);
  await download.saveAs(outPath);
  console.log(`💾 첨부파일 저장: ${outPath}`);
}

/**
 * 상세 페이지의 eBook 링크들에 data-export-ebook 표시를 붙이고 각 링크 글자를 돌려준다.
 * SSAFY 상세 화면은 "eBook(1)" 제목 아래에 <a href="#none"><span class="file-name">제목</span></a> 형태.
 */
async function markEbookLinks(detail) {
  return evaluateSafe(detail, () => {
    document.querySelectorAll('[data-export-ebook]').forEach((el) => el.removeAttribute('data-export-ebook'));
    const clickable = (el) => el.closest('a, button, [onclick], [role="button"]') || el;
    // "eBook(1)", "첨부파일(2)" 같은 구역 제목 중 문서 순서상 바로 앞의 것이 eBook 이면 eBook 링크로 본다.
    const fileNames = Array.from(document.querySelectorAll('.file-name'));
    const headers = Array.from(document.querySelectorAll('body *')).filter((el) =>
      el.children.length === 0 &&
      !el.closest('.file-name') &&
      /^\s*[^()]{1,20}\(\s*\d+\s*\)\s*$/.test(el.textContent || ''));
    const sectionOf = (el) => {
      let last = null;
      for (const h of headers) {
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = h;
      }
      return last ? last.textContent : '';
    };
    let picked = fileNames.filter((el) => /e-?book/i.test(sectionOf(el)));
    if (picked.length === 0) picked = fileNames;

    const titles = [];
    picked.forEach((el, i) => {
      clickable(el).setAttribute('data-export-ebook', String(i));
      titles.push((el.textContent || '').replace(/\s+/g, ' ').trim());
    });
    return titles;
  });
}

/** 상세 페이지의 링크 하나를 눌러 뷰어를 열고 PDF 로 저장한다. */
async function openEbookFromDetail(detail, context, config, locator, title, opts) {
  // 팝업이 열리는 순간의 요청부터 놓치지 않도록 클릭 전에 기록을 시작한다.
  const tracker = trackContextRequests(context);
  try {
    const result = await clickAndFollow(detail, context, locator);
    if (result.download) return saveDownload(result.download, config, title);
    const viewer = result.popup ?? detail;
    if (result.popup) console.log('   🪟 뷰어 창 열림');
    try {
      await saveEbookAsPdf(viewer, context, config, {
        seen: tracker.pageImages, imageLike: tracker.imageLike, titleHint: title, ...opts,
      });
    } finally {
      if (result.popup) await result.popup.close().catch(() => {});
    }
    // 같은 탭에서 뷰어로 넘어갔으면 상세 페이지로 돌아온다.
    if (!result.popup) await detail.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  } finally {
    tracker.dispose();
  }
}


/** 항목 하나 처리: 제목 클릭 → (뷰어 바로 열림 | 상세 페이지 → eBook 링크) → PDF 저장 */
async function saveItem(page, context, config, item, opts) {
  const target = await revealItem(page, config, item);
  const first = await clickAndFollow(page, context, target);
  if (first.download) return saveDownload(first.download, config, item.title);

  const detail = first.popup ?? page;
  const seen = first.popup ? trackPageImages(first.popup) : first.seenSame;

  try {
    if (await waitForViewer(detail, seen, 3_000)) {
      await saveEbookAsPdf(detail, context, config, { seen, titleHint: item.title, ...opts });
      return;
    }

    await dumpDebug(detail, config, `02_상세_${item.title}`);
    const ebookTitles = await markEbookLinks(detail);

    if (ebookTitles.length === 0) {
      // .file-name 이 없는 화면이면 버튼 글자로 찾아 본다.
      const button = detail
        .locator('a, button, [onclick], [role="button"]', { hasText: EBOOK_BUTTON_PATTERN })
        .filter({ hasNotText: /다시\s*보기|목록|이전|다음/ })
        .first();
      if (!(await button.isVisible().catch(() => false))) {
        throw new Error('상세 페이지에서 eBook 링크를 찾지 못했습니다. (--debug 로 화면을 저장해 보내 주세요)');
      }
      await openEbookFromDetail(detail, context, config, button, item.title, opts);
      return;
    }

    if (ebookTitles.length > 1) console.log(`   eBook ${ebookTitles.length}개`);
    for (const [i, ebookTitle] of ebookTitles.entries()) {
      // eBook 이 하나면 학습자료 제목을, 여러 개면 각 eBook 이름을 파일 이름으로 쓴다 (여러 개면 "학습자료 제목 - eBook 이름").
      const title = ebookTitles.length === 1 ? item.title : `${item.title} - ${ebookTitle || i + 1}`;
      if (!(await detail.locator(`[data-export-ebook="${i}"]`).count())) await markEbookLinks(detail);
      await openEbookFromDetail(detail, context, config, detail.locator(`[data-export-ebook="${i}"]`), title, opts);
    }
  } finally {
    if (first.popup) await first.popup.close().catch(() => {});
    page.removeAllListeners('request');
  }
}

/** 학습자료 모드: 검색 → 제목 필터 → 전부 PDF 저장 */
export async function runMaterials(context, page, config, opts) {
  console.log(`🔎 학습자료 검색: "${config.searchKeyword}"  /  제목 필터: ${config.titleFilter}`);
  const items = await collectItems(page, config);
  if (items.length === 0) {
    throw new Error('조건에 맞는 학습자료가 없습니다. 검색어/제목 필터를 확인하거나 --debug 로 화면을 저장해 보내 주세요.');
  }
  console.log(`📋 대상 ${items.length}개`);
  items.forEach((it, i) => console.log(`   ${String(i + 1).padStart(2)}. ${it.title}`));
  if (opts.dryRun) return;

  let ok = 0;
  for (const [i, item] of items.entries()) {
    console.log(`\n[${i + 1}/${items.length}] ${item.title}`);
    const existing = path.join(config.outputDir, `${sanitizeFileName(item.title)}.pdf`);
    if (!opts.force && (await fs.access(existing).then(() => true, () => false))) {
      console.log('⏭️  이미 받은 교안입니다.');
      ok += 1;
      continue;
    }
    try {
      await saveItem(page, context, config, item, { force: opts.force });
      ok += 1;
    } catch (err) {
      console.error(`❌ ${err.message}`);
    }
  }
  console.log(`\n완료: ${ok}/${items.length}  →  ${config.outputDir}`);
}
