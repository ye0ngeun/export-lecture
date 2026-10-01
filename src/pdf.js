import { PDFDocument } from 'pdf-lib';

const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8;
const isPng = (buf) => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

/**
 * 페이지 이미지들을 원본 해상도 그대로 한 장씩 PDF 페이지로 만든다.
 * @param {Buffer[]} images JPEG 또는 PNG 버퍼 (그 외 포맷은 미리 변환해서 넘길 것)
 * @param {string} title PDF 메타데이터 제목
 */
export async function imagesToPdf(images, title) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('export-lecture');

  for (const buf of images) {
    let image;
    if (isJpeg(buf)) image = await pdf.embedJpg(buf);
    else if (isPng(buf)) image = await pdf.embedPng(buf);
    else throw new Error('지원하지 않는 이미지 포맷입니다 (JPEG/PNG만 가능).');

    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return Buffer.from(await pdf.save());
}

export { isJpeg, isPng };
