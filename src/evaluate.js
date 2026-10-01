/**
 * page.evaluate 대신 쓰는 안전한 버전.
 *
 * 일부 사이트(전자정부 프레임워크 등)는 전역 `Map` 을 자체 함수로 덮어쓴다.
 * 그러면 Playwright 가 인자/결과를 주고받을 때 "refs.set is not a function" 오류가 난다.
 * 인자는 코드 문자열에 JSON 으로 박아 넣고, 결과도 JSON 문자열로만 돌려받아 이를 피한다.
 *
 * @param {import('playwright').Page | import('playwright').Frame} target
 * @param {(arg: any) => any} fn 브라우저 안에서 실행할 함수 (바깥 변수 참조 불가)
 * @param {any} [arg] JSON 으로 표현 가능한 값
 */
export async function evaluateSafe(target, fn, arg = null) {
  const expression = `(async () => {
    const result = await (${fn.toString()})(${JSON.stringify(arg)});
    // Prototype.js 류가 붙이는 Array.prototype.toJSON 은 배열을 이중 인코딩하므로 잠시 치운다.
    const toJSON = Array.prototype.toJSON;
    if (toJSON) delete Array.prototype.toJSON;
    try {
      return JSON.stringify(result === undefined ? null : result);
    } finally {
      if (toJSON) Array.prototype.toJSON = toJSON;
    }
  })()`;
  return JSON.parse(await target.evaluate(expression));
}
