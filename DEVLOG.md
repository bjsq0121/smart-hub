# 개발일지

## 2026-04-12 — 운영 대시보드 1차 슬라이스 + 자산 카드 명확화

### 한 줄 요약
기존 알림 페이지 중심 구조를 갈아엎고 **운영 / 리서치 / 도구 / 관리** 4그룹 nav + 운영 대시보드(실시간/운영상태/이벤트 로그)를 1차 슬라이스로 출시. n8n과 양쪽이 합의된 envelope 스키마(`balance/event/workflow_run`) 백엔드 라우팅 + 프론트 자산 카드 4종 + 헤드라인 "총 보유 자산" 추가.

### 의사결정 근거 (시간순)

1. **컬렉션 분리(A안) 채택** — 단일 `notifications`에 모든 걸 우겨넣으면 곧 다시 분리해야 하니, 처음부터 `events` / `balances` / `workflow_runs`로 분리. 리플레이/성과 확장 시점 비용 0으로 만들기 위해.
2. **로그인 후 첫 화면 = 운영** — 매일 보는 게 운영이라서.
3. **알림 페이지 흡수** — 별도 알림 메뉴는 노이즈. 운영 → 이벤트 로그 sub-tab으로 통합.
4. **n8n 위임 계약 통일** — 양쪽이 정확히 같은 값을 쓰는 게 핵심. `signal/heartbeat` 같은 별칭 만들지 말고 백엔드 컬렉션 이름과 일치하는 `event/workflow_run`로 통일.
5. **자산 = 원가 기준만** — `marketValue/평가금액/현재가` 류는 백엔드에서 의도적으로 drop. 1차는 입금/매수 누적 원가로 안정화 후 2차에서 시세 결합.
6. **헤드라인 카드 추가** — 카드 분리만으론 "잔액"이 한눈에 안 보임. `💰 총 보유 자산 (원가 기준)` full-width 헤드라인으로 시각적 우선순위 고정.

### 백엔드 (`app.py`)

신규 엔드포인트
- `POST /webhook/ingest` — 통합 진입점, `kind`로 라우팅 (시크릿 검증)
  - `kind=event` → `events/`
  - `kind=balance` → `events/` + `balances/` (정규화)
  - `kind=workflow_run` → `events/` + `workflow_runs/` (정규화)
- `GET /api/events?limit=&kind=` — 운영 이벤트 로그 / 리플레이 데이터원
- `GET /api/balances/latest` — 최신 + 직전 잔고 (델타 계산용)
- `GET /api/workflows/status?limit=` — 최근 실행 + 워크플로별 마지막 상태 집계

`POST /webhook/notify` 는 호환 유지하면서 `events/`에 미러링.

`IngestEnvelope` 스키마
```python
class IngestEnvelope(BaseModel):
    kind: str   # event | balance | workflow_run
    source: str = "n8n"
    workflow: str = ""
    syncStatus: str = "ok"  # ok | partial | failed
    errorType: str | None = None
    occurredAt: str | None = None
    payload: dict = {}
```

`_normalize_balance` (원가 기준 only)
- `coinCostKRW` = `sum(perCoin[].invested)` — 자동 계산
- `cashKRW` — 페이로드에서 추출 (n8n 신규 필드)
- `totalCostKRW` — 명시 없으면 `coinCost + cash` 자동 합산
- `marketValue` 류는 의도적으로 drop

### 프론트엔드

**탑 nav 재구성** — `data-page=` 단일 평면 → `data-group=` 4그룹 + 그룹별 sub-nav 바
- 로그아웃: `🏠 홈` · `🧰 도구`
- 로그인: `📊 운영` · `🔬 리서치` · `🧰 도구` · `⚙️ 관리`(admin)
- `NAV_GROUPS` 객체로 데이터 드리븐 — 새 sub 추가는 한 줄
- "나중에" 항목은 단일 `page-soon` placeholder를 sub별 메시지로 갈아끼움

**운영 그룹 sub-tab**
- `🟢 실시간` (active)
- `⚙️ 운영상태`
- `📜 이벤트 로그`
- `📈 성과분석` *나중에*
- `⏮ 리플레이` *나중에*

**실시간 카드 레이아웃** (1차 → 2차 → 3차 진화)
1. 1차: `총 투입 원가` / `계좌·자산` / `워크플로` — 잔액이 안 보임
2. 2차: `코인 원가` / `KRW 현금` / `계좌 수` / `워크플로` — 분해됐지만 총합 카드 없음
3. 3차 (현재): **`💰 총 보유 자산 (원가 기준)` 헤드라인** + 분해 4장 + 워크플로
   - 헤드라인은 full-width, 2.4rem 그라데이션 폰트
   - 서브라인 `코인 X + 현금 Y · 직전 대비 ±Z · 시간`
   - 상단 노란 배너로 "원가 기준" 명시 (평가금액 아님)

**알림 페이지 완전 제거** — 약 260줄 알림 JS(필터/페이징/일괄삭제/30초 폴링) 삭제, 운영 → 이벤트 로그가 단일 출처.

### 인프라 / 배포

**컬렉션 4종**
- `events/` — append-only 원장
- `balances/` — 잔고 스냅샷 (원가)
- `workflow_runs/` — 워크플로 실행 상태
- `notifications/` (legacy) — 호환 유지, mirror to events/

**Firestore rules**
```
events/balances/workflow_runs:
  allow read: if request.auth != null;
  allow write: if false;   // 백엔드 Admin SDK만
```

**`firebase.json`**
- `/api/**` rewrite 추가 — Cloud Run smart-hub-api로 포워딩
- 기존 `/webhook/**` 그대로

**배포 사이클**
- Cloud Run revision: `smart-hub-api-00018-68g` (env 보존 위해 `gcloud run deploy --image`만 사용)
- Hosting + Firestore rules: `firebase deploy --only hosting,firestore:rules`
- Kind 통일 검증: `signal/heartbeat`은 400, `event/balance/workflow_run`은 200 — 라이브 확인 완료
- 실제 잔고 라운드트립: BTC 4.75M + ETH 5.4M + 현금 25만 → Firestore에 `coinCostKRW=10150000, cashKRW=250000, totalCostKRW=10400000` 저장 확인

### 디버깅한 것 (중요한 것만)

- **메뉴 클릭이 다 안 먹던 버그** — `[data-page="news"]`, `[data-page="unit"]` 셀렉터가 nav 재구성 후 null이 돼서 `.addEventListener` 호출이 `TypeError` → 그 아래 모든 JS 죽음. 두 셀렉터 제거 + 단위 변환기는 즉시 IIFE 초기화로 변경, 관리 → 초대 관리는 `NAV_GROUPS.admin.subs.invite.onActivate`로 재연결.
- **배포 안 되어 있던 거** — git push만 하고 hosting/Cloud Run 재배포 안 한 상태에서 "메뉴 안 됨" 신고. 진단: 헤드리스 브라우저로 로컬 vs 라이브 비교, 라이브 `app.js`가 옛 `AUTH_PAGES = ['ainews', 'stock', 'notify', 'admin']`이었음. firebase deploy로 해결.
- **`/api/**` 404** — `firebase.json`에 rewrite가 빠져 있어서 정적 파일로 fall through. 추가하고 재배포.

### n8n에 넘길 최종 계약

```
POST https://banghub.kr/webhook/ingest
Headers: X-Webhook-Secret: <WEBHOOK_SECRET>

Body:
{
  "kind": "balance" | "event" | "workflow_run",
  "source": "n8n",
  "workflow": "<workflow_id>",
  "syncStatus": "ok" | "partial" | "failed",
  "errorType": null | "auth" | "rate_limit" | "parse" | "network" | "unknown",
  "occurredAt": "<ISO8601>",
  "payload": { ... kind 별 ... }
}
```

balance payload (1차 v1)
```json
{
  "accountId": "upbit_main",
  "accountCount": 2,
  "cashKRW": 250000,
  "perCoin": [
    { "symbol": "BTC", "qty": 0.05, "avgCost": 95000000, "invested": 4750000 },
    { "symbol": "ETH", "qty": 1.2,  "avgCost": 4500000,  "invested": 5400000 }
  ]
}
```
- `totalCostKRW`, `coinCostKRW` 안 보내도 됨 — 백엔드 자동 계산
- `marketValue/현재가/평가손익` 절대 보내지 말 것 — drop됨
- 잔고 v1 호출/파싱/전송 분리 구조로 만들면 이후 신호 데이터(`kind=event`)도 같은 envelope 재사용

### 1차 슬라이스 vs 2차

**1차 (출시 완료)**
- 운영/리서치/도구/관리 4그룹 nav
- 운영 sub: 실시간 / 운영상태 / 이벤트 로그
- balance / event / workflow_run 라우팅
- 원가 기준 자산 카드 (헤드라인 + 분해)

**2차 (placeholder만)**
- 성과분석 — 신호↔잔고 매칭(`signalId`) 필요
- 리플레이 — 시점 기반 재생, signal 컬렉션 도입
- 시세 결합 (`marketValue`) — 원가 기준 안정화 후

### 커밋 (오늘)
```
5947f7d feat: 운영 실시간에 '총 보유 자산 (원가 기준)' 헤드라인 카드 추가
ecad7a2 feat: 운영 실시간 카드 자산/현금/계좌 분리 + 원가 기준 명시
47525a9 chore: firebase.json 에 /api/** rewrite 추가
88d2e30 fix: nav 재구성 후 끊긴 [data-page=...] 리스너 정리
4ecf05f refactor: 상단 nav 4그룹(운영/리서치/도구/관리) + 그룹별 sub-nav
9b171b9 refactor: 알림센터 JS 완전 제거 → 운영 대시보드로 흡수
9a37179 feat: 운영 대시보드 + 보안 수정 (에러 메시지/화이트리스트 rules)
```

### 다음 할 일 (제안 순서)
1. n8n 잔고 v1 워크플로를 신규 envelope으로 컷오버 + `cashKRW` 채우기
2. 첫 실데이터로 헤드라인 카드 + 분해 카드 시각 검증
3. 워크플로 종료 시점에 `kind=workflow_run` 한 번씩 쏘게 해서 운영상태 탭 채우기
4. 이벤트 로그 탭에 raw 페이로드 토글/검색 기능 (지금은 단순 리스트만)
5. 2차 진입 시점에 `signals/` 컬렉션 + `kind=signal` 추가 — 같은 envelope 그대로 확장
