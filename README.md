# Smart Hub

Smart Hub는 개인 운영용 FastAPI 웹 서비스입니다. 가격 검색, 뉴스/부동산 조회, 주식 자동매매 모니터링, 코인 운영 화면을 한 서비스에서 관리합니다.

현재 코인 운영의 주력은 **업비트 TRX 수량 늘리기 및 수익화 전략**입니다. 기존 n8n 코인 시그널 매매 화면과 데이터는 보존되어 있지만 운영 메뉴에서는 TRX 중심 대시보드를 우선 사용합니다.

## 현재 운영 상태

- Production URL: `https://banghub.kr`
- Cloud Run service: `smart-hub-api`
- GCP project: `smarthub-9cd05`
- Current deployed revision after TRX safety patch: `smart-hub-api-00072-2gl`
- Latest TRX-related commits:
  - `f127c03 feat: add trx trade dashboard`
  - `82f9852 fix: route trx private upbit calls through proxy`
  - `29306ba fix: enforce trx strategy budget cap`

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
- TRX 미보유 시 5분봉 RSI(14), 100개 캔들 기준으로 RSI <= 30이면 KRW 현금의 10%를 첫 매수합니다.
- RSI 조건이 24시간 동안 충족되지 않으면 현금의 3%만 정찰병 매수합니다.
- 기존 TRX 보유분이 있으면 첫 진입 로직을 건너뛰고 현재 보유 평단 기준으로 DCA/익절을 관리합니다.
- DCA는 평단이 아니라 `lastDcaPrice` 대비 -2% 하락 시에만 실행합니다.
- DCA 성공 시 `lastDcaPrice`를 새 기준가로 저장하고 `isProfitTaken=false`로 리셋합니다.
- 익절은 평단 대비 +3% 도달 시 보유 수량의 50%만 시장가 매도하고 `isProfitTaken=true`로 저장합니다.
- 한 매수 사이클에서 익절은 1회만 실행됩니다. 다음 DCA 전까지 추가 매도하지 않습니다.
- 매수 전 김치 프리미엄을 계산합니다: `(업비트 TRX / (바이낸스 TRX * 업비트 USDT)) - 1`.
- 김프 5% 이상이거나 바이낸스/USDT 조회 실패 시 매수는 차단합니다. 매도는 김프와 무관하게 실행합니다.
- 1시간 이상 지난 미체결 매수 주문은 자동 취소합니다.
- `settings/coin-autotrade.maxTotalKRW`, `maxPerSymbolKRW` 예산 상한을 TRX DCA에도 적용합니다.

주의:

- 실제 업비트 주문이 발생하는 코드입니다.
- 운영 환경의 업비트 사설 API 호출은 IP 제한 때문에 Upbit proxy를 경유합니다.
- API 키, 프록시 시크릿, 텔레그램 토큰 등 민감값은 README에 적지 않습니다. 다음 보안 작업은 Cloud Run 환경변수의 Secret Manager 이전입니다.

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

TRX 상태와 최근 매매기록은 Firestore `settings/coin-trx-strategy-state`, `coin_trx_strategy_trades`를 확인합니다. 대시보드 API도 직접 확인할 수 있습니다.

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

- `tests.test_coin_trx_strategy`: 10개 통과
- 전체 unittest: 27개 통과
- compileall: 통과

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
