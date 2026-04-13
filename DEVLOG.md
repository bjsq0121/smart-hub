# 개발일지

## 2026-04-13 — 3-Tier 운영 대시보드 재설계

### 한 줄 요약
운영 대시보드를 **감시 후보 → 매매 후보 → 검증 중 → 종료 결과** 4단계 흐름으로 재설계. 신규 kind 없이 기존 signal kind에 `stage`/`factors`/`noTradeReason` 확장, paper_trade·trade_result에 `direction` 추가, 성과 API에 방향별 분리 집계.

### 의사결정 근거

1. **신규 kind 대신 기존 signal 확장** — `candidate`와 `trade_ready`를 별도 kind로 만들면 n8n 워크플로 2개 + 백엔드 라우팅 분기가 늘어남. signal.stage로 충분히 구분 가능하고, 한 API 호출로 전체 파이프라인을 조회할 수 있음.
2. **stage vs status 분리** — `status`(candidate/entered/expired/rejected)는 신호의 생명주기, `stage`(candidate/trade_ready)는 분석 단계. 의미가 다르므로 별도 필드. status에 trade_ready를 끼워넣으면 의미가 오염됨.
3. **direction 3값 (long/short/no_trade)** — no_trade를 숨기면 "왜 이 종목이 안 잡혔지?" 역추적이 불가. 제외 사유(`noTradeReason`)와 함께 표시해서 AI 판단 근거를 투명하게 공개.
4. **factors를 dict pass-through** — 분석 팩터 종류가 늘어날 때마다 normalize 함수를 고치지 않기 위해 dict 그대로 저장. 프론트는 key-value 순회로 렌더링.
5. **성과 방향별 분리는 서버 계산** — trade_results 전체를 클라이언트에 보내서 필터링하면 데이터량 낭비. 서버에서 `_compute_perf_stats()`로 long/short 각각 계산해서 `byDirection`으로 전달.
6. **단계 필터 칩 방식 (탭 분리 아님)** — 6번째 탭을 추가하면 모바일에서 sub-nav가 넘침. 기존 ops-chip 패턴(종목 필터, W/L 필터, 20/50 토글)과 동일하게 칩 행 추가.

### 백엔드 변경 (`app.py`)

**`_normalize_signal` 확장**
```python
# 추가 필드 3개
"stage":         str(payload.get("stage") or "candidate"),       # candidate | trade_ready
"factors":       raw_factors if isinstance(raw_factors, dict) else None,
"noTradeReason": str(payload.get("noTradeReason") or payload.get("no_trade_reason") or ""),
```

**`_normalize_paper_trade` / `_normalize_trade_result` 확장**
```python
"direction": str(payload.get("direction") or "long"),
```

**`/api/signals` — stage 필터 추가**
- `?stage=candidate` / `?stage=trade_ready` 쿼리 파라미터
- Firestore 복합 인덱스 필요: `(stage ASC, created_at DESC)` — 배포 후 에러 발생 시 추가

**`/api/performance` — 방향별 분리 집계**
- 기존 집계 로직을 `_compute_perf_stats(results)` 헬퍼로 추출
- 응답에 `byDirection: { long: {...}, short: {...} }` 추가
- 기존 top-level 필드(total, winRate 등) 그대로 유지 → 하위호환

### 프론트엔드 변경 (`static/app.js`)

**신규 헬퍼 함수**
- `directionBadge(dir)` — long(녹)/short(빨)/no_trade(회) 3값 대응
- `stageBadge(stage)` — candidate(파랑 "감시")/trade_ready(보라 "매매 후보")

**renderSignals() 재작성**
- 단계 필터 칩 4개: 전체 | 감시 후보 | 매매 후보 | 제외
- 테이블 컬럼 변경: 종목 | 단계 | 점수 | 사유 | 진입가 | 손절 | 방향 | 상태 | 생성
- 종목 클릭 시 팩터 확장 행 토글 (trend, RSI, timing, volume, R:R 그리드)
- no_trade 행: opacity 0.6 + `noTradeReason` 인라인 표시

**renderTrades() 수정**
- 방향 컬럼 추가 (종목 다음)

**renderResults() 수정**
- 방향 컬럼 + 방향 필터 칩(Long/Short) 추가
- W/L 필터와 방향 필터 동시 적용 가능

**renderPerf() 확장**
- 기존 전체 성과 카드 아래에 방향별 성과(Long/Short) 카드 섹션 추가

### CSS 변경 (`static/style.css`)

```css
.ops-factors-row td { background: rgba(255,255,255,0.015); }
.ops-table tr.no-trade td { opacity: 0.6; }
.ops-table tr.no-trade:hover td { opacity: 1; }
```

### n8n 계약 확장 (하위호환)

기존 계약에 **선택적** 필드 추가. 안 보내도 기본값으로 동작.

| kind | 필드 | 타입 | 기본값 | 설명 |
|------|------|------|--------|------|
| signal | `stage` | string | `"candidate"` | `candidate` \| `trade_ready` |
| signal | `factors` | dict | `null` | `{trend:{value,score}, rsi:{...}, ...}` |
| signal | `noTradeReason` | string | `""` | direction이 no_trade일 때 사유 |
| signal | `direction` | string | `"long"` | `long` \| `short` \| `no_trade` |
| paper_trade | `direction` | string | `"long"` | `long` \| `short` |
| trade_result | `direction` | string | `"long"` | `long` \| `short` |

**factors dict 예시 (n8n → Smart Hub)**
```json
{
  "trend": { "value": "uptrend", "score": 8 },
  "rsi": { "value": 42, "score": 7 },
  "timing": { "value": "favorable", "score": 6 },
  "volume": { "value": "above_avg", "score": 7 },
  "riskReward": { "value": 2.3, "score": 8 }
}
```

### 하위호환

| 시나리오 | 처리 |
|---------|------|
| stage 없는 기존 signal | `"candidate"` 기본값 → 감시 후보로 표시 |
| direction 없는 paper_trade/trade_result | `"long"` 기본값 |
| factors 없는 signal | 확장 행에 "분석 팩터 없음" |
| byDirection 없는 기존 프론트 | top-level 필드 그대로 → 기존 코드 동작 |
| mock balance | 시스템 탭에만 표시, 신호/검증 탭과 완전 분리 |

### 커밋

```
9ace292 feat: 3-tier 운영 대시보드 — stage/direction/factors 확장, 방향별 성과 분리
ffba86d chore: add gstack skill routing rules to CLAUDE.md
```

### 컷오버 후 검증 체크리스트

1. `kind=signal` + `stage:"trade_ready"` 전송 → 매매 후보 칩 필터 확인
2. `direction:"no_trade"` + `noTradeReason` 전송 → 제외 탭 사유 표시 확인
3. `factors` dict 전송 → 종목 클릭 시 팩터 그리드 확인
4. `kind=paper_trade` + `direction` → 검증 중 탭 방향 컬럼 확인
5. `kind=trade_result` + `direction` → 결과 탭 방향 컬럼 + 방향 필터 확인
6. 성과 탭 → Long/Short 분리 카드 확인
7. stage 없는 기존 signal → "감시" 기본 표시 확인
8. Firestore 인덱스 에러 발생 시 `(stage, created_at)` 복합 인덱스 생성

### 다음 할 일

1. **(블로커) `system-heart` heartbeat 정체 확인** — 아직 미해결
2. n8n signal 워크플로 구축 — `stage`/`factors`/`direction` 포함
3. n8n paper_trade 워크플로에 `direction` 추가
4. 가짜 잔고 4건 정리 (n8n 실데이터 컷오버 후)
5. Firestore 복합 인덱스 배포 (`signals: stage + created_at`)
6. 실데이터 E2E 검증 (체크리스트 8항목)

---

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
8f8b071 refactor: 자산 카드를 동등 3장(현금/코인/합계)으로 재정렬
a4bab79 docs: 2026-04-12 개발일지 추가
5947f7d feat: 운영 실시간에 '총 보유 자산 (원가 기준)' 헤드라인 카드 추가
ecad7a2 feat: 운영 실시간 카드 자산/현금/계좌 분리 + 원가 기준 명시
47525a9 chore: firebase.json 에 /api/** rewrite 추가
88d2e30 fix: nav 재구성 후 끊긴 [data-page=...] 리스너 정리
4ecf05f refactor: 상단 nav 4그룹(운영/리서치/도구/관리) + 그룹별 sub-nav
9b171b9 refactor: 알림센터 JS 완전 제거 → 운영 대시보드로 흡수
9a37179 feat: 운영 대시보드 + 보안 수정 (에러 메시지/화이트리스트 rules)
```

### 추가 — 자산 카드 레이아웃 3차 반복 (`8f8b071`)
헤드라인 카드(`💰 총 보유 자산`, 2.4rem 그라데이션)를 추가했더니 사용자가
"평가금액 같은 인상" + "분해 카드가 묻힘"이라고 즉시 피드백. 한 턴 만에 다시 갈아엎음.
- `.ops-card-headline` / `.ops-card-value-xl` 제거
- 동등 3장으로 통일: `💵 KRW 현금` / `📊 코인 원가` / `🟰 합계 (원가 기준)`
- 모두 같은 폰트 크기(1.4rem). 합계 카드만 보라 보더(`.ops-card-sum`)로 살짝 차이
- `총 보유 자산` 라벨은 평가금액 오해 부르므로 폐기 → `합계 (원가 기준)`
- 계좌 수/sync/시각은 카드 아래 한 줄 메타(`.ops-meta-line`)로 강등

**교훈:** "강조 = 압도"가 아님. 같은 폰트 크기 + 미세한 보더 차이로도 충분히 합계임을 표시할 수 있음.
헤드라인 카드는 평가금액(시세 반영) UI에서나 어울림. 원가 기준이면 동등 카드가 정직.

### 운영 DB 상태 진단 (세션 끝 무렵)
사용자가 "왜 내 운영잔고랑 다를까?" 질문 → Firestore 직접 inspect.

**`balances/` 4건 모두 내가 검증용으로 직접 ingest한 가짜:**
- `verify` / `local-test` / `manual-test` source — n8n 실데이터 없음
- 가장 최근(`DMkpWVNF…`): BTC 0.05 + ETH 1.2 + 현금 25만 = 10,400,000 (mock)
- n8n 잔고 v1 워크플로가 새 envelope으로 아직 컷오버 안 된 상태

**`events/` 17건 중 발견:**
- `source: system-heart`로 1분 간격 heartbeat가 이미 돌고 있음 (workflow 필드 비어 있음)
- 내가 만든 게 아님. 사용자가 만든 n8n cron 또는 다른 시스템.
- 동작 자체는 정상 — 운영 → 이벤트 로그 탭에 분당 1건씩 쌓임
- 정체 미파악, 사용자 확인 필요

**현재 옵션:**
- A. 가짜 잔고 4건 삭제 (Firestore 휴지통 없음 → 비가역)
- B. 그대로 두고 n8n 컷오버 후 새 데이터로 덮음
- C. `/api/balances/latest`에 `?source=n8n` 필터 추가
- 사용자 결정 대기 중 (다음 세션 안건)

### 다음 할 일 (제안 순서, 우선순위 갱신)
1. **(블로커) `system-heart` heartbeat 정체 확인** — 사용자가 만든 거인지, 어디서 도는지
2. **n8n 잔고 v1 워크플로를 신규 envelope으로 컷오버 + `cashKRW` 채우기**
3. 가짜 잔고 4건 정리 (위 옵션 A/B/C 중 선택 후)
4. 첫 실데이터로 자산 카드 + 코인별 표 시각 검증
5. 워크플로 종료 시점에 `kind=workflow_run` 한 번씩 쏘게 해서 운영상태 탭 채우기
6. 이벤트 로그 탭에 raw 페이로드 토글/검색 (지금은 단순 리스트)
7. 2차 진입 시점에 `signals/` 컬렉션 + `kind=signal` 추가
