import test from 'node:test';
import assert from 'node:assert/strict';
import { isPageImageUrl, parsePageImageUrl, parseTotalPages, sanitizeFileName } from '../src/pattern.js';

test('페이지 이미지 주소를 인식한다', () => {
  assert.ok(isPageImageUrl('https://cdn.example.com/book/page-abc-0001.jpg'));
  assert.ok(isPageImageUrl('https://cdn.example.com/book/page-x_y-0123.webp?v=3'));
  assert.ok(!isPageImageUrl('https://cdn.example.com/book/cover.jpg'));
});

test('샘플 주소에서 n페이지 주소를 만든다', () => {
  const t = parsePageImageUrl('https://cdn.example.com/book/page-abc-0001.jpg?token=1');
  assert.equal(t.urlFor(42), 'https://cdn.example.com/book/page-abc-0042.jpg?token=1');
  assert.equal(t.urlFor(313), 'https://cdn.example.com/book/page-abc-0313.jpg?token=1');
});

test('전체 페이지 수와 파일 이름을 처리한다', () => {
  assert.equal(parseTotalPages(' 3 / 313 '), 313);
  assert.equal(parseTotalPages(''), null);
  assert.equal(sanitizeFileName('Java: 객체/클래스?'), 'Java_ 객체_클래스_');
});
