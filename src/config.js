import 'dotenv/config';
import path from 'node:path';

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;

export function loadConfig() {
  const config = {
    id: env('SSAFY_ID'),
    password: env('SSAFY_PASSWORD'),
    baseUrl: env('SSAFY_BASE_URL', 'https://edu.ssafy.com'),
    loginUrl: env('SSAFY_LOGIN_URL', 'https://edu.ssafy.com/comm/login/SecurityLoginForm.do'),
    loginSelectors: {
      id: env('LOGIN_ID_SELECTOR'),
      password: env('LOGIN_PASSWORD_SELECTOR'),
      submit: env('LOGIN_SUBMIT_SELECTOR'),
    },
    materialsUrl: env('MATERIALS_URL'),
    searchKeyword: env('SEARCH_KEYWORD', '자바전공'),
    titleFilter: new RegExp(env('TITLE_FILTER', '^16기_자바전공_APS'), 'i'),
    debug: false,
    lectureListUrl: env('LECTURE_LIST_URL'),
    ebookLinkPattern: new RegExp(env('EBOOK_LINK_PATTERN', '교안|e-?book|이북|전자책'), 'i'),
    lectureFilter: env('LECTURE_FILTER') ? new RegExp(env('LECTURE_FILTER'), 'i') : null,
    outputDir: path.resolve(env('OUTPUT_DIR', './downloads')),
    headless: env('HEADLESS', 'true').toLowerCase() !== 'false',
    concurrency: Math.max(1, Number.parseInt(env('CONCURRENCY', '6'), 10) || 6),
    browserChannel: env('BROWSER_CHANNEL'),
    browserExecutablePath: env('BROWSER_EXECUTABLE_PATH'),
    authStatePath: path.resolve('.auth/state.json'),
    coursesFile: path.resolve(env('COURSES_FILE', 'courses.json')),
  };

  if (!config.id || !config.password) {
    throw new Error('.env 파일에 SSAFY_ID 와 SSAFY_PASSWORD 를 설정해 주세요. (.env.example 참고)');
  }
  return config;
}
