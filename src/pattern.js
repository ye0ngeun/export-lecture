// 뷰어가 불러오는 페이지 이미지 주소 규칙: .../page-<무언가>-0001.jpg
export const PAGE_IMAGE_PATTERN = /\/page-[^/?#]*-\d{4}\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;

export function isPageImageUrl(url) {
  return PAGE_IMAGE_PATTERN.test(url);
}

/**
 * 샘플 이미지 주소 하나로부터 n페이지 주소를 만들어내는 템플릿을 얻는다.
 * @returns {{ prefix: string, width: number, ext: string, tail: string, urlFor: (n: number) => string } | null}
 */
export function parsePageImageUrl(sampleUrl) {
  const match = sampleUrl.match(/^(.*?)(\d{4})(\.(?:jpe?g|png|webp))([?#].*)?$/i);
  if (!match) return null;
  const [, prefix, number, ext, tail = ''] = match;
  const width = number.length;
  return {
    prefix,
    width,
    ext,
    tail,
    urlFor: (n) => `${prefix}${String(n).padStart(width, '0')}${ext}${tail}`,
  };
}

/** ".label-page" 같은 "3 / 313" 텍스트에서 전체 페이지 수 추출 */
export function parseTotalPages(label) {
  const match = (label || '').match(/\/\s*(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function sanitizeFileName(name) {
  return (name || 'SSAFY_ebook')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'SSAFY_ebook';
}
