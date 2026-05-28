# Smart Hub

Smart Hub는 개인 운영용 FastAPI 웹 서비스입니다. 가격 검색, 뉴스/부동산 조회, 주식 자동매매 모니터링, 코인 운영 화면을 한 서비스에서 관리합니다.

현재 코인 운영의 주력은 **업비트 TRX 수량 늘리기 및 수익화 전략**입니다. 기존 n8n 코인 시그널 매매 화면과 데이터는 보존되어 있지만 운영 메뉴에서는 TRX 중심 대시보드를 우선 사용합니다.

## 현재 운영 상태

- Production URL: `https://banghub.kr`
- Cloud Run service: `smart-hub-api`
- GCP project: `smarthub-9cd05`
- Current deployed revision after TRX harvest/buyback patch: `smart-hub-api-00078-54s`
- Latest TRX-related commits:
  - `ff4cf5b feat: add trx harvest buyback safeguards`
  - `22c0bd5 fix: protect manual trx holdings`
  - `fa4e2f8 feat: add dynamic trx grid strategy`

## TRX 전략 요약

구현 위치:

- Strategy: `smart_hub/coin_trx_strategy.py`
- Coin API/routes: `smart_hub/coin.py`
- Frontend: `static/js/coin-ops.js`
- Tests: `tests/test_coin_trx_strategy.py`

전략 규칙:

- 60초마다 FastAPI 백그라운드 태스크가 실행됩니다.
- 상태는 Firestore `settings/coin-trx-strategy-state`에 저장합니다.
- 매매기록은 Firestore `coin_trx_strategy_trades`에 저장합니다.
- 기본값은 안전 모드입니다. `TRX_STRATEGY_DRY_RUN=true`, `LIVE_TRADING_ENABLED=false`가 기본이며, 실제 주문은 `TRX_STRATEGY_DRY_RUN=false`와 `LIVE_TRADING_ENABLED=true`가 모두 명시된 경우에만 실행됩니다.
- TRX 미보유 시 5분봉 RSI(14), 100개 캔들 기준으로 RSI <= 30이면 KRW 현금의 10%를 첫 매수합니다.
- RSI 조건이 24시간 동안 충족되지 않으면 현금의 3%만 정찰병 매수합니다.
- 기존 TRX 보유분이 있으면 첫 진입 로직은 건너뛰지만, 기존 보유분은 보호 물량으로 취급해 자동 매도하지 않습니다.
- DCA는 평단이 아니라 `lastDcaPrice`와 현재가 기준으로 실행합니다.
- 5분봉 최근 흐름을 상승/횡보/하락으로 나눠 3단 지정가 간격을 동적으로 조절합니다.
  - 상승: `현재가 -0.2%`, `-0.6%`, `-1.2%`
  - 횡보: `현재가 -0.4%`, `-1.0%`, `-1.8%`
  - 하락: `현재가 -0.8%`, `-1.8%`, `-3.0%`
- 3단 지정가 주문이 체결되면 체결 주문가로 `lastDcaPrice`를 갱신하고 `isProfitTaken=false`, `profitTakeStage=0`으로 리셋합니다.
- 봇이 신규로 매수/체결한 TRX만 `botInventoryTRX`, `botInventoryCostKRW`로 따로 추적합니다.
- 이미 열린 TRX 매수 주문이 있으면 중복 지정가 주문을 만들지 않습니다.
- 단, 열린 매수 주문 가격이 새 3단 가격과 다르고 10분 이상 지났으면 취소 후 새 가격으로 재배치합니다.
- 전략 모드는 `ACCUMULATE`, `HARVEST`, `DEFENSIVE`, `PAUSED`로 저장합니다.
  - `ACCUMULATE`: 수량 증가와 buyback을 우선합니다.
  - `HARVEST`: 봇 재고가 수익권이면 일부 익절합니다.
  - `DEFENSIVE`: 급락, 높은 예산 사용률, 봇 재고 손실 시 신규 매수를 줄이거나 멈춥니다.
  - `PAUSED`: 예산 소진, 잔고 불일치, 보안 설정 미충족 등 수동 확인이 필요한 상태입니다.
- 익절은 계좌 전체 평단이 아니라 봇 신규 매수분 평균가 대비 +1.2%, +2.0%, +3.0%에서 각각 봇 재고의 20%, 25%, 25%를 매도합니다.
- 익절 후 실현 수익 일부는 `profitReserveKRW`로 확정하고, 매도 대금 일부는 `buybackBudgetKRW`로 남겨 더 낮은 가격에서 재매수합니다.
- Buyback은 `lastProfitSellPrice` 대비 약 -0.8% 이상 눌렸고 김프/급락/예산 필터를 통과할 때만 실행합니다.
- 봇 신규 재고가 0이면 계좌 전체 TRX가 수익권이어도 매도하지 않습니다.
- 실제 TRX 잔고보다 `botInventoryTRX`가 크면 봇 재고 매도도 차단합니다.
- 3차 익절 후 `isProfitTaken=true`로 저장하며, 다음 DCA 전까지 추가 익절하지 않습니다.
- 매수 전 김치 프리미엄을 계산합니다: `(업비트 TRX / (바이낸스 TRX * 업비트 USDT)) - 1`.
- 김프 5% 이상이거나 바이낸스/USDT 조회 실패 시 매수는 차단합니다. 매도는 김프와 무관하게 실행합니다.
- 최근 1시간 약 -3% 또는 4시간 약 -5% 급락으로 판단되면 신규 매수를 중단하고 `DEFENSIVE`로 전환합니다.
- 예산 사용률이 높아질수록 DCA 금액을 축소합니다. 60% 이상은 40%, 80% 이상은 20% 수준으로 줄이며 90% 이상은 신규 매수를 차단합니다.
- 1시간 이상 지난 미체결 매수 주문은 자동 취소합니다.
- `settings/coin-autotrade.maxTotalKRW`, `maxPerSymbolKRW` 예산 상한을 TRX DCA에도 적용합니다.
  - `maxTotalKRW`는 기존 수동 보유분 원가가 아니라 TRX 전략 매매기록의 순투입금(봇 매수금액 - 봇 매도금액) 기준입니다.

주의:

- 실제 업비트 주문이 발생할 수 있는 코드입니다. 실주문 전 반드시 DRY_RUN 로그를 먼저 확인합니다.
- 운영 환경의 업비트 사설 API 호출은 IP 제한 때문에 Upbit proxy를 경유합니다.
- `UPBIT_PROXY_URL`, `UPBIT_PROXY_SECRET`, API 키, 텔레그램 토큰 등 민감값은 코드에 하드코딩하지 않습니다. 환경변수 또는 Secret Manager로만 주입합니다.
- 프록시 URL/SECRET이 없으면 private Upbit 호출은 fail-closed로 실패합니다.

## 운영 화면 사용법

1. `https://banghub.kr` 접속
2. 코인 운영 메뉴 진입
3. TRX 수량 늘리기 카드에서 상태 확인
4. TRX 매매기록/대시보드에서 다음 항목 확인
   - 현재 TRX 보유 수량
   - 평단
   - 최근 매수/매도/취소 기록
   - 추정 실현손익
   - `lastDcaPrice`
   - `isProfitTaken`
   - `pendingDcaOrderUuid`
   - `botInventoryTRX`
   - `botInventoryCostKRW`
   - `manualProtectedTRX`
   - `strategyMode`
   - `riskState`
   - `profitReserveKRW`
   - `buybackBudgetKRW`
   - `realizedProfitKRW`
   - `nextBuybackPrice`
   - `lastError`

비상 중단은 코인 운영 메뉴의 비상 정지를 사용합니다. 이 설정은 `settings/coin-autotrade.enabled=false`로 반영되며 TRX 전략 루프도 enabled checker를 통해 멈춥니다.

## 회사에서 이어서 확인할 것

출근 후 먼저 아래 순서로 확인합니다.

```bash
git pull
git log --oneline -5
git status --short
```

운영 리비전과 에러 로그:

```bash
gcloud run services describe smart-hub-api \
  --region asia-northeast3 \
  --project smarthub-9cd05 \
  --format='value(status.latestReadyRevisionName,status.traffic[0].percent)'

gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="smart-hub-api" AND severity>=ERROR' \
  --project smarthub-9cd05 \
  --limit 50
```

TRX 상태와 최근 매매기록은 Firestore `settings/coin-trx-strategy-state`, `coin_trx_strategy_trades`를 확인합니다. 특히 이어서 볼 때는 아래를 먼저 확인합니다.

- `botInventoryTRX`: 봇이 새로 산 매도 가능 TRX 수량입니다. 이 값이 0이면 기존 보유분은 팔지 않습니다.
- `botInventoryCostKRW`: 봇 신규 재고 원가입니다.
- `profitReserveKRW`: 익절 후 수익으로 확정한 금액입니다.
- `buybackBudgetKRW`: 더 낮은 가격에서 TRX를 다시 사기 위해 남겨둔 금액입니다.
- `lastProfitSellPrice`, `lastProfitSellAt`: 마지막 익절 매도 기준입니다.
- `realizedProfitKRW`: 봇 재고 매도로 누적 확정한 손익입니다.
- `totalBotBuyTRX`, `totalBotSellTRX`: 봇 신규 매수/매도 누적 수량입니다.
- `accumulationScore`: 현재 봇 재고 평균가 대비 평가 수익률 기반 점수입니다.
- `strategyMode`: 현재 전략 모드입니다.
- `pendingDcaOrders`: 현재 열려 있는 3단 매수 주문입니다.
- `profitTakeStage`: 봇 신규 재고 기준 익절 단계입니다.
- `lastError`: 전략 루프의 마지막 오류입니다.

대시보드 API도 직접 확인할 수 있습니다.

```bash
curl -I https://banghub.kr/
```

인증 쿠키가 있는 브라우저에서는 코인 운영 메뉴에서 `/api/coin/trx-strategy/dashboard?limit=100` 응답이 화면에 표시됩니다.

## 로컬 개발

### 설치

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 실행

```bash
uvicorn app:app --reload
```

브라우저에서 `http://localhost:8000`으로 접속합니다.

### 테스트

```bash
venv/bin/python -m unittest discover -s tests -v
venv/bin/python -m compileall smart_hub tests/test_coin_trx_strategy.py
```

현재 TRX 안전 패치 후 확인된 결과:

- `tests.test_coin_trx_strategy`: 26개 통과
- compileall: 통과

## 2026-05-27 작업 메모

- 기존 수동/기존 보유 TRX는 자동 매도 금지로 변경했습니다.
- 봇이 새로 체결한 매수분만 `botInventoryTRX`, `botInventoryCostKRW`로 추적하고, 익절은 이 봇 신규 재고만 대상으로 합니다.
- 현재 운영 배포 리비전은 `smart-hub-api-00078-54s`이며 100% 트래픽을 받고 있습니다.
- GitHub 기준 최신 커밋은 `ff4cf5b feat: add trx harvest buyback safeguards`입니다.
- 로컬 검증:
  - `python3 -m unittest tests.test_coin_trx_strategy`
  - `python3 -m compileall smart_hub tests/test_coin_trx_strategy.py`
- 배포 검증:
  - `gcloud run services describe smart-hub-api --region asia-northeast3 --project smarthub-9cd05 --format='value(status.latestReadyRevisionName,status.traffic[0].percent)'`
  - `curl -I https://banghub.kr/`

이어받을 때 핵심은 Firestore `settings/coin-trx-strategy-state`에서 `botInventoryTRX`가 0이면 기존 보유분은 매도되지 않는다는 점입니다. 현재 미체결 3단 매수 주문이 체결되면 그 체결분부터 봇 신규 재고가 됩니다.

## 배포

기본 배포 스크립트:

```bash
./deploy.sh
```

배포 후 반드시 확인할 것:

- Cloud Run 최신 리비전이 Ready 상태인지
- 새 리비전이 100% 트래픽을 받는지
- `severity>=ERROR` 로그가 없는지
- 60초 이상 기다린 뒤 TRX 상태 문서와 최근 매매기록이 의도대로 유지되는지
- `banghub.kr` 코인 운영 대시보드가 200 응답을 받는지

## 프로젝트 구조

```text
smart-hub/
├── app.py                         # FastAPI 앱 조립 및 공통 라우팅
├── smart_hub/
│   ├── coin.py                    # 코인 운영 API, 설정, 대시보드
│   ├── coin_trx_strategy.py       # TRX DCA/익절 전략
│   ├── stock.py                   # 주식 운영 API
│   └── ...
├── static/js/
│   ├── coin-ops.js                # 코인 운영 화면
│   ├── stock-ops.js               # 주식 운영 화면
│   └── common.js
├── tests/
│   ├── test_coin_trx_strategy.py
│   └── test_stock_autotrade.py
├── public/                        # Firebase Hosting 배포 산출물
├── firestore.rules
├── deploy.sh
└── requirements.txt
```

## 남은 작업

- Cloud Run 환경변수에 직접 들어간 민감값을 Secret Manager로 이전
- TRX 매수/매도 발생 시 텔레그램 알림 추가
- 매매기록 대시보드에 누적 보유 수량 변화 그래프 보강
- 현재 TRX 전략이 안정화된 뒤 다른 코인 전략을 같은 구조로 점진 추가
