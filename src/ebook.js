import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateSafe } from './evaluate.js';
import { imagesToPdf, isJpeg, isPng } from './pdf.js';
import { isPageImageUrl, parsePageImageUrl, parseTotalPages, sanitizeFileName } from './pattern.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const progress = (text) => {
  if (process.stdout.isTTY) process.stdout.write(`\r   ${text}`);
};
const endProgress = () => {
  if (process.stdout.isTTY) process.stdout.write('\n');
};

/** 페이지(와 그 안의 모든 iframe)에서 발생하는 페이지 이미지 요청을 기록한다. */
export function trackPageImages(page) {
  const seen = new Set();
  page.on('request', (request) => {
    if (isPageImageUrl(request.url())) seen.add(request.url());
  });
  return seen;
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function evaluateInFrames(page, fn) {
  const results = [];
  for (const frame of page.frames()) {
    try {
      // 로딩 중인 frame 에서 evaluate 가 오래 걸리는 경우가 있어 시간 제한을 둔다.
      results.push(await withTimeout(evaluateSafe(frame, fn), 5_000));
    } catch {
      // 이미 사라졌거나 응답 없는 frame
    }
  }
  return results;
}

/** 브라우저 컨텍스트 전체(팝업 포함)의 요청을 팝업이 열리는 순간부터 기록한다. */
export function trackContextRequests(context) {
  const pageImages = new Set();
  const imageLike = new Set();
  const onRequest = (request) => {
    const url = request.url();
    if (isPageImageUrl(url)) pageImages.add(url);
    if (request.resourceType() === 'image' || /\.(jpe?g|png|webp|gif|svg)(?:[?#]|$)/i.test(url)) imageLike.add(url);
  };
  context.on('request', onRequest);
  return { pageImages, imageLike, dispose: () => context.off('request', onRequest) };
}

/** 뷰어에서 페이지 이미지를 못 찾았을 때 원인 파악용 정보를 남긴다. */
async function dumpViewerFailure(page, config, imageLike) {
  const dir = path.join(config.outputDir, '_debug');
  await fs.mkdir(dir, { recursive: true });
  const fromFrames = (await evaluateInFrames(page, () => [
    ...performance.getEntriesByType('resource').map((e) => e.name),
    ...Array.from(document.images).map((img) => img.currentSrc || img.src),
    ...Array.from(document.querySelectorAll('canvas')).map(() => '(canvas 요소 있음)'),
  ])).flat();
  const lines = [
    `뷰어 주소: ${page.url()}`,
    `프레임: ${page.frames().map((f) => f.url()).join('\n        ')}`,
    '',
    '[불러온 이미지/리소스]',
    ...new Set([...(imageLike ?? []), ...fromFrames]),
  ];
  const base = path.join(dir, '03_뷰어_실패');
  await fs.writeFile(`${base}.txt`, lines.join('\n'));
  await page.screenshot({ path: `${base}.png` }).catch(() => {});
  return base;
}

/** 스니펫과 같은 방식: 네트워크 기록 + performance 엔트리 + <img> 에서 샘플 주소를 찾는다. */
async function findSampleImageUrl(page, seen) {
  const fromNetwork = [...seen];
  const fromFrames = (await evaluateInFrames(page, () => [
    ...performance.getEntriesByType('resource').map((e) => e.name),
    ...Array.from(document.images).map((img) => img.currentSrc || img.src).filter(Boolean),
  ])).flat();
  return [...fromNetwork, ...fromFrames].find(isPageImageUrl) ?? null;
}

async function detectTotalPages(page) {
  const labels = await evaluateInFrames(page, () => document.querySelector('.label-page')?.textContent || '');
  for (const label of labels) {
    const total = parseTotalPages(label);
    if (total) return total;
  }
  return null;
}

async function detectTitle(page) {
  const titles = await evaluateInFrames(page, () => document.title || '');
  return titles.find((t) => t && !/^ssafy$/i.test(t.trim())) || titles[0] || '';
}

async function fetchWithRetry(request, url, referer, retries = 3) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await request.get(url, { headers: { referer }, timeout: 60_000 });
      lastStatus = res.status();
      if (res.ok()) return { body: await res.body(), status: lastStatus };
      if (lastStatus === 404) break; // 없는 페이지 → 재시도 무의미
    } catch {
      lastStatus = 0;
    }
    await sleep(500 * attempt);
  }
  return { body: null, status: lastStatus };
}

/** 지정된 페이지 번호들을 동시성 제한을 두고 내려받는다. */
async function downloadPages(context, template, referer, pageNumbers, concurrency, onProgress) {
  const results = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < pageNumbers.length) {
      const n = pageNumbers[cursor++];
      results.set(n, await fetchWithRetry(context.request, template.urlFor(n), referer));
      onProgress?.();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** 브라우저 안에서 WebP 등을 JPEG 로 변환 (pdf-lib 은 JPEG/PNG 만 지원) */
async function toEmbeddable(context, buf) {
  if (isJpeg(buf) || isPng(buf)) return buf;
  const page = await context.newPage();
  try {
    const base64 = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:application/octet-stream;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    }, buf.toString('base64'));
    return Buffer.from(base64, 'base64');
  } finally {
    await page.close();
  }
}

// ── 이미 받은 e-book 기록 (같은 교안을 다시 받지 않도록) ──────────────────
async function readManifest(outputDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(outputDir, '.manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function writeManifest(outputDir, manifest) {
  await fs.writeFile(path.join(outputDir, '.manifest.json'), JSON.stringify(manifest, null, 2));
}

async function uniquePath(dir, baseName) {
  for (let i = 1; ; i += 1) {
    const candidate = path.join(dir, i === 1 ? `${baseName}.pdf` : `${baseName} (${i}).pdf`);
    if (!(await fs.access(candidate).then(() => true, () => false))) return candidate;
  }
}

/**
 * e-book 뷰어가 열린 페이지에서 전체 페이지 이미지를 받아 PDF 로 저장한다.
 * @param {import('playwright').Page} page e-book 뷰어 페이지
 * @param {Set<string>} seen trackPageImages(page) 결과
 * @returns {Promise<string|null>} 저장된 PDF 경로 (건너뛰면 null)
 */
export async function saveEbookAsPdf(
  page, context, config, { seen = new Set(), imageLike = null, titleHint = '', force = false } = {}
) {
  // 1) 뷰어가 첫 페이지 이미지를 불러올 때까지 기다린다.
  console.log(`   🔍 뷰어에서 페이지 이미지 찾는 중... (최대 30초)  ${page.url()}`);
  let sampleUrl = null;
  for (let waited = 0; waited < 30_000 && !sampleUrl; waited += 1000) {
    sampleUrl = await findSampleImageUrl(page, seen);
    if (!sampleUrl) await sleep(1000);
  }
  if (!sampleUrl) {
    const base = await dumpViewerFailure(page, config, imageLike);
    throw new Error(
      `뷰어에서 페이지 이미지 주소를 찾지 못했습니다: ${page.url()}\n` +
      `   원인 파악용 파일: ${base}.txt / .png  (이 txt 파일 내용을 보내 주세요)`
    );
  }
  console.log(`   ✔ 이미지 규칙 발견: ${sampleUrl.replace(/[?#].*$/, '')}`);

  const template = parsePageImageUrl(sampleUrl);
  if (!template) throw new Error(`페이지 이미지 번호 규칙을 해석하지 못했습니다: ${sampleUrl}`);

  await fs.mkdir(config.outputDir, { recursive: true });
  const manifest = await readManifest(config.outputDir);
  if (!force && manifest[template.prefix]) {
    console.log(`⏭️  이미 받은 교안입니다: ${manifest[template.prefix]}`);
    return null;
  }

  const title = sanitizeFileName(titleHint || (await detectTitle(page)));
  const referer = page.url();
  let total = await detectTotalPages(page);
  console.log(`📘 ${title}  (${total ? `${total}페이지` : '페이지 수 자동 탐색'})`);

  // 2) 페이지 이미지 다운로드
  const images = [];
  const failed = [];
  if (total) {
    let done = 0;
    const numbers = Array.from({ length: total }, (_, i) => i + 1);
    const results = await downloadPages(context, template, referer, numbers, config.concurrency, () => {
      done += 1;
      progress(`다운로드 ${done}/${total}`);
    });
    endProgress();
    for (const n of numbers) {
      const { body } = results.get(n);
      if (body) images.push(body);
      else failed.push(n);
    }
  } else {
    // 전체 페이지 수를 모르면 404 가 나올 때까지 묶음 단위로 받는다.
    let next = 1;
    let reachedEnd = false;
    while (!reachedEnd && next < 5000) {
      const numbers = Array.from({ length: config.concurrency }, (_, i) => next + i);
      const results = await downloadPages(context, template, referer, numbers, config.concurrency);
      for (const n of numbers) {
        const { body } = results.get(n);
        if (!body) { reachedEnd = true; break; }
        images.push(body);
      }
      next += numbers.length;
      progress(`다운로드 ${images.length}페이지`);
    }
    endProgress();
    total = images.length;
  }

  if (images.length === 0) throw new Error('받은 페이지가 없습니다. 로그인 세션 또는 권한을 확인해 주세요.');
  if (failed.length) console.warn(`⚠️  실패한 페이지: ${failed.join(', ')} (나머지 페이지로 PDF 생성)`);

  // 3) PDF 생성
  const embeddable = [];
  for (const img of images) embeddable.push(await toEmbeddable(context, img));
  const pdfBuffer = await imagesToPdf(embeddable, title);
  const outPath = await uniquePath(config.outputDir, title);
  await fs.writeFile(outPath, pdfBuffer);

  // 일부 페이지가 빠졌으면 기록하지 않아서 다음 실행 때 다시 받도록 한다.
  if (failed.length === 0) {
    manifest[template.prefix] = path.basename(outPath);
    await writeManifest(config.outputDir, manifest);
  }
  console.log(`💾 저장 완료: ${outPath} (${images.length}페이지)`);
  return outPath;
}
