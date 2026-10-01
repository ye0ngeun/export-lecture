# export-lecture

SSAFY(edu.ssafy.com) 강의 교안(HTML e-book)을 **자동 로그인 → 페이지 이미지 수집 → PDF 저장**까지 한 번에 처리하는 도구입니다.
예전에 브라우저 콘솔에 스니펫을 붙여넣고 "PDF로 인쇄"를 누르던 작업을 자동화했습니다.

> 본인 계정으로 볼 권한이 있는 교안을 **개인 학습용**으로 보관할 때만 사용하세요. 받은 파일을 다시 배포하면 안 됩니다.

## 동작 방식

1. `.env`에 적어 둔 아이디/비밀번호로 로그인합니다. 로그인 세션은 `.auth/state.json`에 저장해 두고, 다음 실행 때 다시 씁니다.
2. e-book 뷰어를 열고, 뷰어가 불러오는 `.../page-xxxx-0001.jpg` 형태의 이미지 주소 규칙을 찾습니다. 스니펫과 같은 방식이고, iframe 안의 뷰어도 찾습니다.
3. `.label-page`의 `n / 전체` 표시에서 전체 페이지 수를 읽습니다. 표시가 없으면 404가 날 때까지 받습니다.
4. 로그인한 세션 그대로 전체 페이지를 병렬로 받아 원본 해상도 그대로 PDF로 합칩니다. WebP는 JPEG로 바꿔서 넣습니다.
5. 이미 받은 교안은 `downloads/.manifest.json`에 기록해 두고, 다음 실행 때 건너뜁니다.

## 설치

Node.js 18 이상이 필요합니다.

```bash
npm install
npm run setup          # Playwright용 Chromium 설치 (BROWSER_CHANNEL=chrome 을 쓰면 생략 가능)
cp .env.example .env   # 그다음 SSAFY_ID / SSAFY_PASSWORD 입력
```

`.env`는 `.gitignore`에 들어 있어서 커밋되지 않습니다.

## 사용법

### ⭐ 새 교안 받기 (평소엔 이것만)

```bash
npm run sync             # 새로 올라온 교안만 받기
npm run sync -- --dry-run  # 받지 않고 뭐가 새로 올라왔는지만 보기
```

`courses.json`의 규칙대로 학습자료 전체를 훑어서, 아직 안 받은 교안만 `downloads/<폴더>/`에 저장합니다.
`downloads/` 바로 밑에 예전 방식으로 받아 둔 PDF가 있으면 규칙에 맞는 폴더로 먼저 옮깁니다.

```json
{
  "search": "자바전공",
  "courses": [
    { "folder": "알고리즘", "title": "^16기_자바전공_APS" },
    { "folder": "프론트엔드", "title": "^\\d+_자바전공_" },
    { "folder": "AI", "title": "^\\d+-\\d+_", "search": "" }
  ]
}
```

- 위에서부터 차례로 보고 처음 맞는 규칙의 폴더에 넣습니다.
- 새 과정이 생기면 한 줄을 추가하세요. 검색어가 다르면 그 줄에 `"search": "..."`를 넣으면 됩니다.
- `"search": ""`이면 검색 없이 전체 목록을 훑습니다. AI 과정처럼 제목에 공통 단어가 없을 때 씁니다.

### 0) 학습자료에서 한 번에 받기

강의실 > 학습자료 페이지에서 검색하고, 제목이 조건과 맞는 교안을 전부 받습니다.

```bash
npm run materials -- --dry-run   # 받을 목록만 먼저 확인
npm run materials                # 실제로 받기
```

기본값은 `.env`에서 바꿀 수 있습니다.

```env
SEARCH_KEYWORD=자바전공          # 학습자료 검색창에 넣을 검색어
TITLE_FILTER=^16기_자바전공_APS  # 이 정규식과 맞는 제목만 (^ 는 "~로 시작")
```

한 번만 다르게 받고 싶으면 명령줄에서 바꿉니다.

```bash
npm run materials -- --title "^16기_자바전공_(?!APS)"   # APS가 아닌 자바전공 교안
npm run materials -- --title "^16기_자바전공"           # 16기 자바전공 전부
```

폴더를 나눠서 받으려면 `--folder`를 붙입니다. `downloads/<폴더>/`에 저장되고, 그 폴더에 이미 있는 교안은 건너뜁니다.

```bash
# 프론트엔드: "07_자바전공_ajax_1001_2" 처럼 숫자로 시작하는 자바전공 교안
npm run materials -- --title "^\d+_자바전공_" --folder 프론트엔드
```

동작 순서는 학습자료 페이지 → 검색 → 목록 전체 페이지 확인 → 제목 클릭 → (상세 화면이면 "교재" 버튼 클릭) → 뷰어 → PDF입니다.
이미 받은 제목은 건너뜁니다. 잘 안 되면 `--debug`를 붙여서 실행하고 `downloads/_debug/`의 HTML과 스크린샷을 보내 주세요.

### 1) 감시 모드

```bash
npm run watch
```

브라우저 창이 뜨고 자동으로 로그인됩니다. 그 창에서 자바 교안을 **열기만 하면** 프로그램이 알아서 감지해서 `downloads/`에 PDF로 저장합니다.
교안을 하나씩 열어 두기만 하면 되고, 스니펫을 붙여넣거나 인쇄 버튼을 누를 필요가 없습니다. 끝낼 때는 창을 닫거나 `Ctrl+C`를 누르세요.

### 2) 목록 자동 탐색: 완전 자동

`.env`에 교안 목록 페이지 주소를 넣고 실행합니다.

```env
LECTURE_LIST_URL=https://edu.ssafy.com/...(자바 과목 교안 목록 페이지)
EBOOK_LINK_PATTERN=교안|e-?book|이북|전자책   # 교안 여는 버튼에 적힌 글자
LECTURE_FILTER=자바|Java|JAVA                 # 이 글자가 들어간 행만
```

```bash
npm start -- --discover
```

목록에서 조건에 맞는 버튼을 하나씩 누르고, 팝업이든 같은 탭이든 열린 뷰어를 저장합니다. 파일 이름은 목록에 적힌 강의 제목을 씁니다.

### 3) 뷰어 주소 목록

```bash
npm start -- --url "https://edu.ssafy.com/.../viewer?..."
npm start -- --urls urls.txt
```

`urls.txt`에는 한 줄에 `주소 [제목]` 형식으로 적습니다. 제목은 PDF 파일 이름이 됩니다.

```
# 자바 교안
https://edu.ssafy.com/....  Java 1일차 객체지향
https://edu.ssafy.com/....  Java 2일차 상속
```

### 옵션

| 옵션 | 설명 |
| --- | --- |
| `--headed` | 브라우저 창을 띄워서 실행합니다. 동작을 눈으로 확인할 때 씁니다. |
| `--force` | 이미 받은 교안도 다시 받습니다. |
| `--logout` | 저장된 세션을 지우고 다시 로그인합니다. |
| `--debug` | 목록/상세 화면을 `downloads/_debug/`에 HTML과 스크린샷으로 저장합니다. |

## 문제 해결

- **로그인 입력칸을 찾지 못함**: 로그인 페이지의 입력칸 셀렉터를 `.env`의 `LOGIN_ID_SELECTOR`, `LOGIN_PASSWORD_SELECTOR`, `LOGIN_SUBMIT_SELECTOR`에 지정하세요. 크롬 개발자도구에서 입력칸을 우클릭한 뒤 Copy selector로 복사할 수 있습니다.
- **캡차나 추가 인증이 뜸**: `--headed` 또는 `npm run watch`로 실행하면 창에서 직접 인증을 마칠 때까지 3분 동안 기다립니다. 한 번 성공하면 세션이 저장됩니다.
- **`--discover`에서 교안을 못 찾음**: 사이트 구조에 따라 버튼 글자가 다를 수 있습니다. `EBOOK_LINK_PATTERN`을 조정하거나 감시 모드를 쓰세요.
- **페이지 이미지 주소를 찾지 못함**: 뷰어의 이미지 이름 규칙이 바뀐 경우입니다. `src/pattern.js`의 `PAGE_IMAGE_PATTERN`을 수정하세요.

## 개발

```bash
npm test
```
