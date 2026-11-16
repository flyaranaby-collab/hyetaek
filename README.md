# 혜택찾기 — 대한민국 지원사업 통합 검색 플랫폼

정부·지자체·공공기관 지원사업을 한곳에서 검색하고, 내 조건과 자격을 비교하고, 마감 알림을 받는 서비스입니다.

## 구성

```
hyetaek/
├─ data/catalog.mjs     직접 검증한 큐레이션 사업 데이터 (웹앱·서버 공용)
├─ data/logic.mjs       신청 상태 계산 · 자격 비교 로직 (웹앱·서버 공용)
├─ web/template.html    모바일 웹앱 화면
├─ scripts/build-web.mjs 웹앱 빌드 → dist/index.html, server/public/index.html
└─ server/              공공데이터 API 수집 · 검색 API · 마감 알림 · 관리자
```

## 서버 실행 (Windows / Mac / Linux 공통)

1. **Node.js 22.5 이상** 설치 (https://nodejs.org — LTS 버전). 추가 패키지 설치 없이 동작합니다(SQLite 내장).
2. 공공데이터포털(data.go.kr)에서 **「행정안전부_대한민국 공공서비스(혜택) 정보」** 활용신청 → 인증키 발급 (자동승인).
3. `server/.env.example`을 `server/.env`로 복사하고 값 입력:
   - `DATA_GO_KR_KEY` = 발급받은 인증키(Decoding 키)
   - `ADMIN_TOKEN` = 아무도 모를 긴 문자열
4. 실행:
   ```
   cd server
   npm start
   ```
5. 브라우저에서 `http://localhost:8080` (앱), `http://localhost:8080/admin` (관리자)

처음 실행하면 정부24 공공서비스 전체(약 수천~1만 건)를 자동 수집합니다. 이후 매일 `SYNC_HOUR`시에 변경분만 수집하고, 일요일에는 전체 수집으로 종료된 사업을 정리합니다.

## 동작 방식

| 기능 | 내용 |
|---|---|
| 수집 | serviceList(목록) → serviceDetail(상세·구비서류·신청URL) → supportConditions(자격 코드). 일시 오류 3회 재시도, 인증 오류는 즉시 중단, 시간 초과 처리 |
| 변경 이력 | 내용 해시로 변경 감지 → 어떤 필드가 바뀌었는지 이력 저장. 원천에서 사라진 사업은 삭제하지 않고 '종료'로 표시 |
| 안전장치 | 전체 수집 결과가 기존의 80% 미만이면 대량 종료 처리를 건너뜀. 수집 실패해도 기존 데이터로 계속 서비스 |
| 중복 통합 | 이름(연도·괄호 제거)+지역이 같으면 하나로 묶음. 사람이 검증한 큐레이션 데이터가 대표 |
| 금액 | 자유 텍스트에서 금액을 추측하지 않음. 정부24 사업은 '지원 내용 원문 참고'로 표시 |
| 자격 비교 | 나이·소득·직업·자녀·주거·지역·시군 비교. 불명확하면 '가능'이 아니라 '추가 확인 필요' |
| 알림 | 관심 사업 마감 D-7·D-3·D-1·당일, 사업 종료 시 알림함 기록. SMTP 설정 + `npm install nodemailer` 시 이메일 발송 |
| 개인정보 | 회원가입 없음. 기기 임의 ID로만 구독 관리, 이메일은 선택. 프로필은 서버에 저장하지 않음(맞춤 계산만) |
| 보안 | 관리자 토큰(타이밍 안전 비교), 요청 크기 제한, IP별 분당 120회 제한, 경로 탐색 차단, 입력값 검증 |

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/programs?q=&cat=&region=&city=&status=&type=&limit=&offset=` | 검색 (status: open·soon·plan·notice·closed) |
| GET | `/api/programs/:id` | 상세 + 변경 이력 + 통합된 중복 공고 |
| POST | `/api/match` `{profile}` | 맞춤 분류 (high / check / no) |
| GET | `/api/deadlines?days=14` | 마감 임박 |
| POST/DELETE | `/api/subscriptions` `{deviceId, programId, email?}` | 마감 알림 구독 |
| GET | `/api/notifications?deviceId=` | 알림함 |
| POST | `/api/admin/sync?mode=full\|incremental` | 수동 수집 (Bearer ADMIN_TOKEN) |
| GET | `/api/admin/stats`, `/api/admin/sync-log`, `/api/admin/programs` | 관리 현황 |
| PATCH | `/api/admin/programs/:id` `{hidden, verify}` | 숨김·검증 상태 변경 |

## 명령

```
npm test          # 모의 정부24 API로 수집·변경·종료·중복·알림·보안 테스트
npm run sync      # 증분 수집 1회
npm run sync:full # 전체 수집 1회
npm run build:web # data/·web/ 수정 후 웹앱 다시 빌드
```

## 큐레이션 데이터 갱신

`data/catalog.mjs`에 사업을 추가·수정 → `npm run build:web` → 서버 재시작. 각 사업의 `verify`는 공식 페이지에서 직접 확인했으면 `official`, 언론·해설 등 2차 출처면 `secondary`로 둡니다.

## 확인이 필요한 부분

- 실제 인증키로 아직 호출해 보지 않았습니다. 응답 형식은 공공데이터포털 문서 기준으로 맞췄고, 모의 서버로 테스트했습니다. 첫 수집 후 관리자 화면의 수집 기록을 확인하세요.
- 증분 수집의 `cond[수정일시::GTE]` 값 형식(YYYYMMDDHHmmss)은 실제 응답의 수정일시 형식에 맞춰 동작합니다. 만약 증분 수집이 0건만 가져오면 `npm run sync:full`을 쓰세요.
- 배포(외부 접속): 클라우드 서버(예: 네이버클라우드·AWS Lightsail) 또는 Render·Railway 같은 Node 호스팅에 `server/` 폴더를 올리고 위 환경변수를 설정하면 됩니다. HTTPS는 호스팅의 기본 기능이나 Nginx로 붙이세요.
