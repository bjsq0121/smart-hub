/* ═══════════════════════════════════════
   📈 주식운영 (stock-ops)
   — 별도 파일로 분리. 주식운영 관련 로직은 여기에 추가.
   — 의존: app.js 공용 함수 (esc, fmtKRW, fmtRel, emptyState, diagnose,
           stageBadge, directionBadge, itemStatusBadge, authHeaders)
   — 로드 순서: app.js → stock-ops.js
═══════════════════════════════════════ */

(function () {
  'use strict';

  /* ── 상태 ── */
  let stockData = { signals: null, alerts: null };
  let stockStageFilter = '';
  let stockDirFilter = '';
  let stockSeverityFilter = '';
  let stockAutoRefreshTimer = null;
  let stockCountdownTimer = null;
  let stockLastLoadTime = null;
  let stockCountdown = 0;
  const STOCK_REFRESH_MS = 15_000; // 15초

  // 새 데이터 감지용 — 이전 로드의 ID 세트
  let prevSignalIds = new Set();
  let prevAlertIds = new Set();
  let newSignalIds = new Set();
  let newAlertIds = new Set();

  /* ── CSS 주입 (하이라이트 애니메이션) ── */
  const style = document.createElement('style');
  style.textContent = `
    @keyframes stk-new-glow {
      0%   { background: rgba(52,211,153,0.15); }
      100% { background: transparent; }
    }
    .stk-new-row { animation: stk-new-glow 3s ease-out; }
    .stk-new-alert { animation: stk-new-glow 3s ease-out; }
    @keyframes stk-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.3; }
    }
    .stk-live-dot {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: #34d399;
      animation: stk-pulse 1.5s infinite;
      margin-right: 6px; vertical-align: middle;
    }
    .stk-toast {
      position: fixed; top: 70px; right: 24px; z-index: 9999;
      background: linear-gradient(135deg, rgba(52,211,153,0.95), rgba(96,165,250,0.95));
      color: #fff; font-weight: 700; font-size: 0.85rem;
      padding: 10px 20px; border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      transition: opacity 0.5s, transform 0.5s;
      transform: translateX(0);
    }
    .stk-toast.hide { opacity: 0; transform: translateX(100px); pointer-events: none; }
  `;
  document.head.appendChild(style);

  /* ── 토스트 알림 ── */
  function showToast(msg) {
    let toast = document.getElementById('stk-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'stk-toast';
      toast.className = 'stk-toast hide';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('hide');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hide'), 4000);
  }

  /* ── 필터 세터 (전역) ── */
  window.setStockStageFilter = (v) => { stockStageFilter = v; renderStockSignals(); };
  window.setStockDirFilter   = (v) => { stockDirFilter = v; renderStockSignals(); };
  window.setStockSeverityFilter = (v) => { stockSeverityFilter = v; renderStockAlerts(); };

  /* ── 데이터 로드 ── */
  async function loadStockOps() {
    stockLastLoadTime = Date.now();
    const ts = document.getElementById('stock-ops-last-update');

    const hdrs = typeof authHeaders === 'function' ? await authHeaders() : {};
    const [sigRes, alertRes] = await Promise.allSettled([
      fetch('/api/stock-signals?limit=50', { headers: hdrs }).then(r => r.json()),
      fetch('/api/stock-alerts?limit=30', { headers: hdrs }).then(r => r.json()),
    ]);
    stockData.signals = sigRes.status === 'fulfilled' ? sigRes.value : { items: [], error: '로드 실패' };
    stockData.alerts  = alertRes.status === 'fulfilled' ? alertRes.value : { items: [], error: '로드 실패' };

    // 새 데이터 감지
    const curSigIds = new Set((stockData.signals.items || []).map(s => s.signalId || s.id));
    const curAlertIds = new Set((stockData.alerts.items || []).map(a => a.id));
    newSignalIds = new Set();
    newAlertIds = new Set();
    let newCount = 0;
    if (prevSignalIds.size > 0) {
      curSigIds.forEach(id => { if (!prevSignalIds.has(id)) { newSignalIds.add(id); newCount++; } });
    }
    if (prevAlertIds.size > 0) {
      curAlertIds.forEach(id => { if (!prevAlertIds.has(id)) { newAlertIds.add(id); newCount++; } });
    }
    prevSignalIds = curSigIds;
    prevAlertIds = curAlertIds;

    if (newCount > 0) {
      showToast(`새 데이터 ${newCount}건 수신`);
    }

    // 타임스탬프 + 라이브 인디케이터
    if (ts) ts.innerHTML = `<span class="stk-live-dot"></span>LIVE · 갱신 <span id="stk-countdown">${STOCK_REFRESH_MS / 1000}</span>초`;

    renderStockSignals();
    renderStockAlerts();
    renderStockPerf();
    startStockAutoRefresh();
    startCountdown();
  }
  window.loadStockOps = loadStockOps;

  /* ── 자동 새로고침 ── */
  function startStockAutoRefresh() {
    if (stockAutoRefreshTimer) clearInterval(stockAutoRefreshTimer);
    stockAutoRefreshTimer = setInterval(() => {
      const page = document.getElementById('page-stock-ops');
      if (page && page.classList.contains('active')) loadStockOps();
    }, STOCK_REFRESH_MS);
  }

  /* ── 카운트다운 표시 ── */
  function startCountdown() {
    stockCountdown = STOCK_REFRESH_MS / 1000;
    if (stockCountdownTimer) clearInterval(stockCountdownTimer);
    stockCountdownTimer = setInterval(() => {
      stockCountdown--;
      const el = document.getElementById('stk-countdown');
      if (el) el.textContent = Math.max(stockCountdown, 0);
      if (stockCountdown <= 0) clearInterval(stockCountdownTimer);
    }, 1000);
  }

  /* ── factors 토글 ── */
  window.toggleStockFactors = (id) => {
    const r = document.getElementById('stk-factors-' + id);
    if (r) r.style.display = r.style.display === 'none' ? 'table-row' : 'none';
  };

  /* ── 팩터 렌더 ── */
  function renderFactors(factors) {
    if (!factors || typeof factors !== 'object')
      return '<div style="color:#475569;font-size:0.78rem;">분석 팩터 없음</div>';
    const labels = {
      trend:'추세', rsi:'RSI', macd:'MACD', volume:'거래량',
      news_sentiment:'뉴스감성', risk_reward:'R:R',
      stochastic:'스토캐스틱', bollinger:'볼린저', timing:'진입 타이밍',
    };
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;">
      ${Object.entries(factors).map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? v : { value: v };
        const scoreColor = (val.score || 0) >= 7 ? '#34d399' : (val.score || 0) >= 4 ? '#fbbf24' : '#f87171';
        return `<div style="padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;">${esc(labels[k] || k)}</div>
          <div style="font-size:0.85rem;color:#e2e8f0;font-weight:600;">${esc(String(val.value != null ? val.value : '-'))}</div>
          ${val.score != null ? `<div style="font-size:0.68rem;color:${scoreColor};">점수 ${val.score}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  /* ══════════════════════════════════
     1. 시그널 탭
  ══════════════════════════════════ */
  function renderStockSignals() {
    const el = document.getElementById('stock-signals-content'); if (!el) return;
    const d = stockData.signals || {};
    const diag = diagnose(d);
    if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
    let allItems = d.items || [];
    if (!allItems.length) {
      el.innerHTML = emptyState('noData', '주식 시그널이 아직 없습니다.\nPaperclip 에이전트가 분석을 시작하면 여기에 표시됩니다.');
      return;
    }

    const cntCandidate = allItems.filter(s => (s.stage || 'candidate') === 'candidate').length;
    const cntReady     = allItems.filter(s => s.stage === 'trade_ready').length;
    const cntLong      = allItems.filter(s => s.direction === 'long').length;
    const cntShort     = allItems.filter(s => s.direction === 'short').length;

    let items = allItems;
    if (stockStageFilter) items = items.filter(s => s.stage === stockStageFilter);
    if (stockDirFilter) items = items.filter(s => s.direction === stockDirFilter);

    const stageHtml = `<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
      <button class="ops-chip${!stockStageFilter?' active':''}" onclick="setStockStageFilter('')">전체 (${allItems.length})</button>
      <button class="ops-chip${stockStageFilter==='candidate'?' active':''}" onclick="setStockStageFilter('candidate')" style="color:#60a5fa;">후보 (${cntCandidate})</button>
      <button class="ops-chip${stockStageFilter==='trade_ready'?' active':''}" onclick="setStockStageFilter('trade_ready')" style="color:#a78bfa;">매매준비 (${cntReady})</button>
    </div>`;

    const dirHtml = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
      <button class="ops-chip${!stockDirFilter?' active':''}" onclick="setStockDirFilter('')">전체 방향</button>
      <button class="ops-chip${stockDirFilter==='long'?' active':''}" onclick="setStockDirFilter('long')" style="color:#34d399;">Long (${cntLong})</button>
      <button class="ops-chip${stockDirFilter==='short'?' active':''}" onclick="setStockDirFilter('short')" style="color:#f87171;">Short (${cntShort})</button>
    </div>`;

    if (!items.length) {
      el.innerHTML = stageHtml + dirHtml + emptyState('noData', '필터에 해당하는 시그널이 없습니다.');
      return;
    }

    el.innerHTML = stageHtml + dirHtml + `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead><tr><th>종목</th><th>단계</th><th>점수</th><th>사유</th><th>진입가</th><th>손절</th><th>목표가</th><th>방향</th><th>상태</th><th>생성</th><th></th></tr></thead>
          <tbody>${items.map((s, idx) => {
            const scoreCls = s.score >= 8 ? 'color:#34d399' : s.score >= 6 ? 'color:#fbbf24' : 'color:#f87171';
            const sid = String(s.signalId || s.id || idx).replace(/[^a-zA-Z0-9_-]/g, '_');
            const isNew = newSignalIds.has(s.signalId || s.id);
            const isTradeable = s.direction && s.direction !== 'no_trade';
            const tradeBtnHtml = isTradeable
              ? `<button type="button" class="stk-signal-trade-btn px-2 py-0.5 rounded border border-slate-700 text-slate-400 text-[10px] hover:border-violet-500/40 hover:text-violet-300 transition-colors" data-symbol="${esc(s.symbol)}" data-direction="${esc(s.direction)}" onclick="event.stopPropagation();">매매</button>`
              : (s.direction === 'no_trade' ? `<span style="font-size:0.65rem;color:#475569;" title="${esc(s.noTradeReason || '비매매')}">—</span>` : '');
            return `<tr class="${isNew ? 'stk-new-row' : ''}" style="cursor:pointer;" onclick="toggleStockFactors('${sid}')">
              <td style="font-weight:700;color:#e2e8f0;">${isNew ? '<span style="color:#34d399;font-size:0.65rem;margin-right:4px;">NEW</span>' : ''}${esc(s.symbol)} <span style="font-size:0.65rem;color:#475569;">&#9662;</span></td>
              <td>${stageBadge(s.stage || 'candidate')}</td>
              <td style="${scoreCls};font-weight:700;">${s.score}</td>
              <td style="color:#94a3b8;font-size:0.78rem;max-width:240px;white-space:normal;">${esc(s.scoreReason || '')}</td>
              <td>${s.entryPrice ? fmtKRW(s.entryPrice) : '-'}</td>
              <td>${s.stopLoss ? fmtKRW(s.stopLoss) : '-'}</td>
              <td>${s.targetPrice ? fmtKRW(s.targetPrice) : '-'}</td>
              <td>${directionBadge(s.direction)}</td>
              <td>${itemStatusBadge(s.status)}</td>
              <td style="font-size:0.72rem;color:#475569;">${fmtRel(s.created_at)}</td>
              <td style="text-align:center;">${tradeBtnHtml}</td>
            </tr>
            <tr class="ops-factors-row" id="stk-factors-${sid}" style="display:none;">
              <td colspan="11" style="padding:10px 16px;">${renderFactors(s.factors)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;

    // 시그널 "매매" 버튼 클릭 바인딩
    el.querySelectorAll('.stk-signal-trade-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const symbol = btn.dataset.symbol;
        const direction = btn.dataset.direction;
        const side = direction === 'long' ? 'buy' : direction === 'short' ? 'sell' : 'buy';
        // 1) 매매 서브탭으로 전환
        if (typeof setStockOpsPane === 'function') setStockOpsPane('trade');
        // 2) 매매 패널에 symbol + side 자동 채움 + 시세 호출
        // setStockOpsPane('trade')가 loadStockTrade를 트리거하므로 약간의 지연 후 채움
        setTimeout(() => {
          if (typeof fillStockOrderForm === 'function') {
            window.fillStockOrderForm(symbol, side, 0);
          }
        }, 100);
      });
    });
  }

  /* ══════════════════════════════════
     2. 알림 탭
  ══════════════════════════════════ */
  function renderStockAlerts() {
    const el = document.getElementById('stock-alerts-content'); if (!el) return;
    const d = stockData.alerts || {};
    const diag = diagnose(d);
    if (diag) { el.innerHTML = emptyState(diag, d.error); return; }
    let allItems = d.items || [];
    if (!allItems.length) {
      el.innerHTML = emptyState('noData', '주식 알림이 없습니다.\n긴급 시장 이벤트, 리스크 경고 등이 여기에 표시됩니다.');
      return;
    }

    const cntInfo     = allItems.filter(a => a.severity === 'info').length;
    const cntWarning  = allItems.filter(a => a.severity === 'warning').length;
    const cntCritical = allItems.filter(a => a.severity === 'critical').length;

    let items = allItems;
    if (stockSeverityFilter) items = items.filter(a => a.severity === stockSeverityFilter);

    const filterHtml = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
      <button class="ops-chip${!stockSeverityFilter?' active':''}" onclick="setStockSeverityFilter('')">전체 (${allItems.length})</button>
      <button class="ops-chip${stockSeverityFilter==='info'?' active':''}" onclick="setStockSeverityFilter('info')" style="color:#3b82f6;">정보 (${cntInfo})</button>
      <button class="ops-chip${stockSeverityFilter==='warning'?' active':''}" onclick="setStockSeverityFilter('warning')" style="color:#f59e0b;">주의 (${cntWarning})</button>
      <button class="ops-chip${stockSeverityFilter==='critical'?' active':''}" onclick="setStockSeverityFilter('critical')" style="color:#ef4444;">긴급 (${cntCritical})</button>
    </div>`;

    if (!items.length) {
      el.innerHTML = filterHtml + emptyState('noData', '필터에 해당하는 알림이 없습니다.');
      return;
    }

    const severityIcon = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
    const severityBorder = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };

    el.innerHTML = filterHtml + items.map(a => {
      const bc = severityBorder[a.severity] || '#64748b';
      const isNew = newAlertIds.has(a.id);
      return `<div class="${isNew ? 'stk-new-alert' : ''}" style="border-left:3px solid ${bc};background:${bc}0a;border-radius:10px;padding:14px 18px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-weight:700;color:#e2e8f0;font-size:0.9rem;">${isNew ? '<span style="color:#34d399;font-size:0.7rem;margin-right:6px;">NEW</span>' : ''}${severityIcon[a.severity] || ''} ${esc(a.title || a.alertType || '알림')}</span>
          <span style="font-size:0.72rem;color:#64748b;">${fmtRel(a.created_at)}</span>
        </div>
        ${a.symbol ? `<span style="font-size:0.72rem;color:#60a5fa;background:rgba(96,165,250,0.1);padding:2px 8px;border-radius:6px;margin-bottom:6px;display:inline-block;">${esc(a.symbol)}</span>` : ''}
        <div style="font-size:0.82rem;color:#94a3b8;line-height:1.5;">${esc(a.message || '')}</div>
      </div>`;
    }).join('');
  }

  /* ══════════════════════════════════
     3. 성과 탭
  ══════════════════════════════════ */
  function renderStockPerf() {
    const el = document.getElementById('stock-perf-content'); if (!el) return;
    const signals = (stockData.signals?.items || []);
    if (!signals.length) {
      el.innerHTML = emptyState('noData', '시그널 데이터가 축적되면 성과 분석이 표시됩니다.\n최소 5건 이상의 시그널이 필요합니다.');
      return;
    }

    const total = signals.length;
    const readyCount = signals.filter(s => s.stage === 'trade_ready').length;
    const avgScore = (signals.reduce((sum, s) => sum + (Number(s.score) || 0), 0) / total).toFixed(1);
    const longCount = signals.filter(s => s.direction === 'long').length;
    const shortCount = signals.filter(s => s.direction === 'short').length;
    const symbols = [...new Set(signals.map(s => s.symbol))];

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;">
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">총 시그널</div>
          <div style="font-size:1.4rem;font-weight:700;color:#e2e8f0;">${total}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;">
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">매매준비</div>
          <div style="font-size:1.4rem;font-weight:700;color:#a78bfa;">${readyCount}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;">
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">평균 점수</div>
          <div style="font-size:1.4rem;font-weight:700;color:${avgScore >= 7 ? '#34d399' : avgScore >= 5 ? '#fbbf24' : '#f87171'};">${avgScore}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;">
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">Long / Short</div>
          <div style="font-size:1.4rem;font-weight:700;"><span style="color:#34d399;">${longCount}</span> <span style="color:#64748b;font-size:0.9rem;">/</span> <span style="color:#f87171;">${shortCount}</span></div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;">
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">분석 종목</div>
          <div style="font-size:1.4rem;font-weight:700;color:#60a5fa;">${symbols.length}</div>
        </div>
      </div>
      <div style="color:#64748b;font-size:0.78rem;text-align:center;">
        종목별 상세 성과 분석은 매매 결과 데이터 축적 후 추가됩니다.
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════
     4. 매매 탭 — KIS 실계좌 readonly + paper 매매
        - 실계좌(잔고/보유) 30초 폴링
        - 페이퍼 포지션 + 주문 패널
        - 자산 카드 규칙: 동등 가중, 헤드라인 금지, "총 보유 자산" 금지
  ══════════════════════════════════════════════════════════════ */

  const tradeState = {
    account: null,        // /api/stock/account/balance 응답
    accountErr: null,     // {status, detail}
    holdings: null,       // /api/stock/account/holdings 응답
    holdingsErr: null,
    positions: null,      // /api/stock/paper/positions
    positionsErr: null,
    orders: null,         // /api/stock/paper/orders
    ordersErr: null,
    form: { symbol: '', side: 'buy', qty: '', priceType: 'market', limitPrice: '', clientNote: '', symbolName: '' },
    pending: null,        // {confirmToken, preview, payload, expiresAt}
    submitting: false,
    pollingTimer: null,
    quotePollingTimer: null,
    // 검색/시세/한도 (Phase 3)
    search: {
      q: '',                // 현재 쿼리
      items: [],            // [{code,name,market,rank}]
      open: false,          // 드롭다운 오픈 여부
      activeIdx: -1,        // 키보드 선택 index
      debounceTimer: null,
      loading: false,
    },
    quote: null,            // {symbol,name,price,prevClose,changeAmount,changePct,open,high,low,volume,marketHours,stale,cached,timestamp}
    quoteErr: null,
    quoteSymbol: '',        // 마지막으로 조회한 symbol (중복 호출 방지)
    dailyStats: null,       // {count,amountKRW,caps,remaining,singleOrder}
    dailyStatsErr: null,
    recentSymbols: null,    // [{symbol,symbolName,lastTradedAt,side}] — /api/stock/paper/recent-symbols
  };
  const TRADE_POLL_MS = 30_000;
  const QUOTE_POLL_MS = 10_000;
  const SEARCH_DEBOUNCE_MS = 200;

  const ERR_TXT = {
    confirm_token_missing: '확인 세션이 없습니다. 다시 시도해주세요.',
    confirm_token_invalid: '확인 세션이 유효하지 않습니다. 다시 시도해주세요.',
    confirm_token_expired: '확인 세션이 만료되었습니다(60초). 다시 시도해주세요.',
    confirm_token_mismatch: '주문 내용이 변경되었습니다. 다시 확인해주세요.',
    confirm_token_user_mismatch: '계정 정보가 일치하지 않습니다.',
    market_closed: '장 마감 시간입니다. 평일 09:00~15:30에만 주문 가능.',
    price_fetch_failed: '현재가 조회에 실패했습니다. 잠시 후 재시도.',
    order_amount_exceeded: '단건 주문 한도(1억원)를 초과했습니다.',
    daily_limit_exceeded: '오늘 paper 주문 건수 한도(50건)를 초과했습니다.',
    daily_amount_exceeded: '오늘 paper 주문 금액 한도(10억원)를 초과했습니다.',
    quote_fetch_failed: '시세 조회 실패',
    search_failed: '종목 검색 실패',
    daily_stats_unavailable: '한도 조회 불가',
    naver_upstream: '검색 서버 응답 없음',
  };
  function mapErr(detail) {
    if (!detail) return '알 수 없는 오류';
    const s = String(detail);
    if (ERR_TXT[s]) return ERR_TXT[s];
    if (s.startsWith('insufficient_position')) return '보유 수량보다 많이 매도할 수 없습니다.';
    if (s.startsWith('position_update_failed')) return '포지션 업데이트 실패. 잠시 후 재시도.';
    if (s.startsWith('confirm_token_')) return '확인 세션 오류. 다시 시도해주세요.';
    return s;
  }

  async function apiFetch(url, opts) {
    const hdrs = typeof authHeaders === 'function' ? await authHeaders() : {};
    const init = Object.assign({}, opts || {});
    init.headers = Object.assign({}, hdrs, (opts && opts.headers) || {});
    if (init.body && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const r = await fetch(url, init);
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { ok: r.ok, status: r.status, body: body || {} };
  }

  /* ── 검색/시세/한도 API 헬퍼 (Phase 3) ── */
  async function fetchSymbolSearch(q) {
    if (!q || !q.trim()) return { items: [] };
    const r = await apiFetch('/api/stock/search?q=' + encodeURIComponent(q.trim()) + '&limit=10');
    if (!r.ok) {
      console.warn('[stock-trade] search_failed', r.status, r.body && r.body.detail);
      return { items: [], error: (r.body && r.body.detail) || 'search_failed' };
    }
    return r.body || { items: [] };
  }

  async function fetchQuote(symbol) {
    if (!symbol || !/^\d{5,6}$/.test(symbol)) return { ok: false, error: 'invalid_symbol' };
    const r = await apiFetch('/api/stock/quote?symbol=' + encodeURIComponent(symbol));
    if (!r.ok) {
      return { ok: false, status: r.status, error: (r.body && r.body.detail) || 'quote_fetch_failed' };
    }
    return r.body || { ok: false };
  }

  async function fetchDailyStats() {
    const r = await apiFetch('/api/stock/paper/daily-stats');
    if (!r.ok) {
      return { ok: false, status: r.status, error: (r.body && r.body.detail) || 'daily_stats_unavailable' };
    }
    return r.body || { ok: false };
  }

  /* ── 최근 거래 종목 로드 ── */
  async function fetchRecentSymbols() {
    const r = await apiFetch('/api/stock/paper/recent-symbols?limit=10');
    if (!r.ok) {
      console.warn('[stock-trade] recent-symbols fetch failed', r.status);
      tradeState.recentSymbols = [];
      return;
    }
    tradeState.recentSymbols = (r.body && r.body.items) || [];
  }

  /* ── 시세 미리보기 로드/갱신 ── */
  async function refreshQuote(force) {
    const sym = tradeState.form.symbol;
    if (!/^\d{5,6}$/.test(sym)) {
      tradeState.quote = null; tradeState.quoteErr = null; tradeState.quoteSymbol = '';
      renderQuotePreview();
      return;
    }
    // 동일 symbol 재조회는 폴링 주기에만 허용
    if (!force && tradeState.quoteSymbol === sym && tradeState.quote) {
      // noop — 폴링이 부르면 force=true
    }
    const res = await fetchQuote(sym);
    tradeState.quoteSymbol = sym;
    if (res.ok === false) {
      tradeState.quoteErr = res.error || 'quote_fetch_failed';
      // stale 캐시 fallback이 없고 서버가 503으로 떨어지면 기존 quote는 유지하지 않음
      if (res.status === 503) tradeState.quote = null;
    } else {
      tradeState.quote = res; // {ok, symbol, name, price, ...}
      tradeState.quoteErr = null;
      // 종목명 폼 옆 라벨에도 반영
      if (res.name) tradeState.form.symbolName = res.name;
    }
    renderQuotePreview();
    renderEstimate();
  }

  async function refreshDailyStats() {
    const r = await fetchDailyStats();
    if (r.ok === false) {
      tradeState.dailyStats = null;
      tradeState.dailyStatsErr = r.error || 'daily_stats_unavailable';
    } else {
      tradeState.dailyStats = r;
      tradeState.dailyStatsErr = null;
    }
    renderLimitBars();
    renderEstimate();
  }

  /* ── 데이터 로드 ── */
  async function loadStockTrade() {
    const el = document.getElementById('stock-trade-content');
    if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.innerHTML = '<div class="text-slate-500 text-sm py-6 text-center">로딩 중...</div>';
    }

    const [accRes, hldRes, posRes, ordRes, dsRes] = await Promise.allSettled([
      apiFetch('/api/stock/account/balance'),
      apiFetch('/api/stock/account/holdings'),
      apiFetch('/api/stock/paper/positions'),
      apiFetch('/api/stock/paper/orders?limit=20'),
      apiFetch('/api/stock/paper/daily-stats'),
    ]);

    function unpack(res) {
      if (res.status !== 'fulfilled') return { err: { detail: '네트워크 오류' }, body: null };
      const r = res.value;
      if (!r.ok) return { err: { status: r.status, detail: r.body.detail || r.body.error || ('HTTP ' + r.status) }, body: null };
      return { err: null, body: r.body };
    }

    const acc = unpack(accRes);
    tradeState.account = acc.body;
    tradeState.accountErr = acc.err;

    const hld = unpack(hldRes);
    tradeState.holdings = hld.body;
    tradeState.holdingsErr = hld.err;

    const pos = unpack(posRes);
    tradeState.positions = pos.body;
    tradeState.positionsErr = pos.err;

    const ord = unpack(ordRes);
    tradeState.orders = ord.body;
    tradeState.ordersErr = ord.err;

    const ds = unpack(dsRes);
    if (ds.err) {
      tradeState.dailyStats = null;
      tradeState.dailyStatsErr = ds.err.detail || 'daily_stats_unavailable';
    } else {
      tradeState.dailyStats = ds.body;
      tradeState.dailyStatsErr = null;
    }

    renderStockTrade();
    startTradePolling();
    // 첫 진입 시 현재 symbol 있으면 시세 즉시 로드
    if (tradeState.form.symbol) refreshQuote(true);
    // 최근 거래 종목 로드 (비동기, 블로킹 아님)
    fetchRecentSymbols().then(() => {
      const bar = document.getElementById('stk-recent-symbols');
      if (bar) bar.innerHTML = renderRecentSymbolsBar();
      // 칩 클릭 바인딩 (비동기 로드 후)
      document.querySelectorAll('.stk-recent-chip').forEach(chip => {
        chip.onclick = () => {
          tradeState.form.symbol = chip.dataset.symbol || '';
          if (chip.dataset.name) tradeState.form.symbolName = chip.dataset.name;
          renderStockTrade();
          if (/^\d{5,6}$/.test(chip.dataset.symbol)) refreshQuote(true);
        };
      });
    });
  }
  window.loadStockTrade = loadStockTrade;

  function startTradePolling() {
    if (tradeState.pollingTimer) clearInterval(tradeState.pollingTimer);
    tradeState.pollingTimer = setInterval(() => {
      const pane = document.getElementById('stock-ops-pane-trade');
      if (!pane || !pane.classList.contains('active')) return;
      // 모달 떠 있을 땐 폴링 스킵
      const modal = document.getElementById('stk-order-modal');
      if (modal && !modal.classList.contains('hidden')) return;
      refreshAccountAndPositions();
    }, TRADE_POLL_MS);

    // 시세 10초 폴링 (패널 보일 때 + symbol 유효 + 모달 닫혀있을 때만)
    if (tradeState.quotePollingTimer) clearInterval(tradeState.quotePollingTimer);
    tradeState.quotePollingTimer = setInterval(() => {
      const pane = document.getElementById('stock-ops-pane-trade');
      if (!pane || !pane.classList.contains('active')) return;
      const modal = document.getElementById('stk-order-modal');
      if (modal && !modal.classList.contains('hidden')) return;
      if (!/^\d{5,6}$/.test(tradeState.form.symbol)) return;
      refreshQuote(true);
    }, QUOTE_POLL_MS);
  }

  async function refreshAccountAndPositions() {
    const [accRes, hldRes, posRes] = await Promise.allSettled([
      apiFetch('/api/stock/account/balance'),
      apiFetch('/api/stock/account/holdings'),
      apiFetch('/api/stock/paper/positions'),
    ]);
    const u = (res) => {
      if (res.status !== 'fulfilled') return { err: { detail: '네트워크 오류' }, body: null };
      const r = res.value;
      if (!r.ok) return { err: { status: r.status, detail: r.body.detail || r.body.error || ('HTTP ' + r.status) }, body: null };
      return { err: null, body: r.body };
    };
    const a = u(accRes); tradeState.account = a.body; tradeState.accountErr = a.err;
    const h = u(hldRes); tradeState.holdings = h.body; tradeState.holdingsErr = h.err;
    const p = u(posRes); tradeState.positions = p.body; tradeState.positionsErr = p.err;
    renderStockTrade();
  }

  async function refreshPaperAll() {
    const [posRes, ordRes] = await Promise.allSettled([
      apiFetch('/api/stock/paper/positions'),
      apiFetch('/api/stock/paper/orders?limit=20'),
    ]);
    const u = (res) => {
      if (res.status !== 'fulfilled') return { err: { detail: '네트워크 오류' }, body: null };
      const r = res.value;
      if (!r.ok) return { err: { status: r.status, detail: r.body.detail || r.body.error || ('HTTP ' + r.status) }, body: null };
      return { err: null, body: r.body };
    };
    const p = u(posRes); tradeState.positions = p.body; tradeState.positionsErr = p.err;
    const o = u(ordRes); tradeState.orders = o.body; tradeState.ordersErr = o.err;
    renderStockTrade();
  }

  /* ── 렌더 ── */
  function renderStockTrade() {
    const el = document.getElementById('stock-trade-content');
    if (!el) return;
    el.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div>${renderLiveSection()}</div>
        <div>${renderPaperSection()}</div>
      </div>
      <div id="stk-recent-symbols" class="mb-1">${renderRecentSymbolsBar()}</div>
      <div id="stk-quote-preview" class="mb-3">${renderQuotePreviewHtml()}</div>
      <div class="mb-6">${renderOrderPanel()}</div>
      <div>${renderOrderHistory()}</div>
    `;
    bindFormHandlers();
  }

  function sectionHeader(label, kind) {
    const tone = kind === 'live'
      ? 'border-sky-500/30 bg-sky-500/8 text-sky-300'
      : 'border-violet-500/30 bg-violet-500/8 text-violet-300';
    return `<div class="flex items-center gap-2 mb-3">
      <span class="inline-flex items-center px-2 py-0.5 rounded-md border ${tone} text-[11px] font-semibold uppercase tracking-wider">${label}</span>
    </div>`;
  }

  /* ── 4-1. 실계좌 (KIS live) ── */
  function renderLiveSection() {
    const head = sectionHeader('실계좌 · KIS', 'live');

    if (tradeState.accountErr) {
      const e = tradeState.accountErr;
      const isEnv = e.status === 503;
      const detail = isEnv
        ? '실계좌 연동 미설정 (KIS_ACCOUNT_NO/KIS_ACCOUNT_PROD env 필요)'
        : (mapErr(e.detail) || '실계좌 조회 실패');
      return head + `
        <div class="rounded-xl border border-dashed border-slate-700/60 bg-slate-800/20 px-4 py-5 text-sm text-slate-400">
          <div class="font-semibold text-slate-300 mb-1">${isEnv ? '실계좌 연동 미설정' : '실계좌 조회 실패'}</div>
          <div class="text-xs text-slate-500">${esc(detail)}</div>
          <div class="text-xs text-slate-600 mt-2">페이퍼 매매는 정상 동작합니다.</div>
        </div>`;
    }

    const acc = (tradeState.account && tradeState.account.account) || null;
    if (!acc) {
      if (tradeState.holdingsErr) {
        // balance OK 인데 holdings 별도 실패 — 거의 발생 안 하지만 방어.
        console.warn('[stock-trade] holdings 누락', tradeState.holdingsErr);
      }
      return head + emptyState('noData', 'KIS 잔고 데이터 없음');
    }

    const cash = acc.cashKRW;
    const evalA = acc.totalEvalKRW;
    const stockEval = acc.stockEvalKRW;
    const orderable = acc.orderableKRW;
    const cost = acc.totalCostKRW;
    const pnlKRW = acc.totalPnlKRW;
    const pnlPct = acc.totalPnlPct;

    const fmt = (v) => (v == null || isNaN(v)) ? '<span class="text-slate-600">—</span>' : esc(fmtKRW(v));
    const pnlCls = pnlKRW > 0 ? 'text-emerald-400' : pnlKRW < 0 ? 'text-rose-400' : 'text-slate-400';

    // 동등 가중 카드 4개. 모두 text-sm, 헤드라인 없음, "총 보유 자산" 라벨 없음.
    const cards = [
      { label: '예수금', value: fmt(cash) },
      { label: '주문가능', value: fmt(orderable) },
      { label: '평가', value: fmt(stockEval), sub: cost != null ? `원가 ${fmt(cost)}` : '' },
      { label: '합계', value: fmt(evalA) },
    ];

    let pnlRow = '';
    if (pnlKRW != null) {
      pnlRow = `<div class="mt-3 flex items-center gap-3 text-xs">
        <span class="text-slate-500">평가손익</span>
        <span class="${pnlCls} font-semibold">${pnlKRW >= 0 ? '+' : ''}${esc(fmtKRW(pnlKRW))}</span>
        ${pnlPct != null ? `<span class="${pnlCls}">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>` : ''}
      </div>`;
    }

    const cardsHtml = `<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
      ${cards.map(c => `
        <div class="rounded-lg border border-slate-700/50 bg-slate-800/30 p-3">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">${esc(c.label)}</div>
          <div class="text-sm font-medium text-slate-200">${c.value}</div>
          ${c.sub ? `<div class="text-[10px] text-slate-500 mt-0.5">${c.sub}</div>` : ''}
        </div>`).join('')}
    </div>${pnlRow}
    <div class="mt-2 text-[10px] text-slate-600">계좌 ${esc(acc.accountNo || '—')} · 갱신 ${tradeState.account.updatedAt ? esc(fmtRel(tradeState.account.updatedAt)) : '—'}${tradeState.account.cached ? ' (캐시)' : ''}</div>`;

    // 보유 종목
    const holdings = (tradeState.holdings && tradeState.holdings.holdings) || [];
    let table;
    if (tradeState.holdingsErr) {
      table = `<div class="mt-4 rounded-lg border border-dashed border-slate-700/60 bg-slate-800/20 px-3 py-3 text-xs text-slate-500">보유 종목 조회 실패: ${esc(mapErr(tradeState.holdingsErr.detail))}</div>`;
    } else if (!holdings.length) {
      table = `<div class="mt-4 text-xs text-slate-500 px-1">보유 종목 없음</div>`;
    } else {
      table = `<div class="mt-4 overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-slate-500">
            <tr class="border-b border-slate-700/40">
              <th class="text-left py-1.5 px-2">종목</th>
              <th class="text-right py-1.5 px-2">수량</th>
              <th class="text-right py-1.5 px-2">평단</th>
              <th class="text-right py-1.5 px-2">현재가</th>
              <th class="text-right py-1.5 px-2">평가</th>
              <th class="text-right py-1.5 px-2">손익</th>
            </tr>
          </thead>
          <tbody>${holdings.map(h => renderHoldingRow(h, 'live')).join('')}</tbody>
        </table>
      </div>`;
    }

    return head + cardsHtml + table;
  }

  function renderHoldingRow(h, kind) {
    const sym = h.symbol || '';
    const name = h.name || '';
    const qty = h.qty;
    const avg = h.avgCost;
    const cur = h.currentPrice;
    const eval_ = h.evalAmount;
    const pnlKRW = h.pnlKRW;
    const pnlPct = h.pnlPct;
    const ph = (v, fmt) => (v == null || isNaN(v)) ? '<span class="text-slate-600">—</span>' : (fmt ? fmt(v) : esc(String(v)));
    const pnlCls = pnlKRW > 0 ? 'text-emerald-400' : pnlKRW < 0 ? 'text-rose-400' : 'text-slate-500';

    // 라이브 행은 클릭 시 매매 패널에 자동 채움 (sell 기본). 페이퍼 행도 동일.
    const sideOnClick = kind === 'live' ? 'sell' : 'sell';
    const onclick = `window.fillStockOrderForm('${esc(sym)}','${sideOnClick}',${qty || 0})`;

    return `<tr class="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer" onclick="${onclick}">
      <td class="py-1.5 px-2">
        <div class="text-slate-200">${esc(name || sym)}</div>
        <div class="text-[10px] text-slate-500">${esc(sym)}${kind === 'paper' ? ' <span class="ml-1 px-1 rounded bg-violet-500/15 text-violet-300">paper</span>' : ''}</div>
      </td>
      <td class="py-1.5 px-2 text-right text-slate-300">${ph(qty)}</td>
      <td class="py-1.5 px-2 text-right text-slate-400">${ph(avg, fmtKRW)}</td>
      <td class="py-1.5 px-2 text-right text-slate-300">${ph(cur, fmtKRW)}</td>
      <td class="py-1.5 px-2 text-right text-slate-300">${ph(eval_, fmtKRW)}</td>
      <td class="py-1.5 px-2 text-right">
        <div class="${pnlCls}">${pnlKRW != null ? (pnlKRW >= 0 ? '+' : '') + fmtKRW(pnlKRW) : '—'}</div>
        <div class="${pnlCls} text-[10px]">${pnlPct != null ? (pnlPct >= 0 ? '+' : '') + Number(pnlPct).toFixed(2) + '%' : ''}</div>
      </td>
    </tr>`;
  }

  /* ── 4-2. 페이퍼 포지션 ── */
  function renderPaperSection() {
    const head = sectionHeader('페이퍼 포지션', 'paper');
    if (tradeState.positionsErr) {
      return head + `<div class="rounded-xl border border-dashed border-slate-700/60 bg-slate-800/20 px-4 py-5 text-sm text-slate-400">
        <div class="font-semibold text-slate-300 mb-1">페이퍼 포지션 조회 실패</div>
        <div class="text-xs text-slate-500">${esc(mapErr(tradeState.positionsErr.detail))}</div>
      </div>`;
    }
    const positions = (tradeState.positions && tradeState.positions.positions) || [];

    // 페이퍼 합계 계산 (헤드라인 아님 — 카드도 동등 가중)
    const totalEval = positions.reduce((s, p) => s + (Number(p.evalAmount) || 0), 0);
    const totalCost = positions.reduce((s, p) => s + ((Number(p.avgCost) || 0) * (Number(p.qty) || 0)), 0);
    const totalPnl = positions.reduce((s, p) => s + (Number(p.pnlKRW) || 0), 0);

    const fmt = (v) => (v == null || isNaN(v)) ? '<span class="text-slate-600">—</span>' : esc(fmtKRW(v));
    const pnlCls = totalPnl > 0 ? 'text-emerald-400' : totalPnl < 0 ? 'text-rose-400' : 'text-slate-400';

    const cards = [
      { label: '포지션 수', value: `<span class="text-sm text-slate-200">${positions.length}</span>` },
      { label: '원가', value: fmt(totalCost) },
      { label: '평가', value: fmt(totalEval) },
      { label: '손익', value: `<span class="${pnlCls}">${totalPnl >= 0 ? '+' : ''}${esc(fmtKRW(totalPnl))}</span>` },
    ];

    const cardsHtml = `<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
      ${cards.map(c => `
        <div class="rounded-lg border border-slate-700/50 bg-slate-800/30 p-3">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">${esc(c.label)}</div>
          <div class="text-sm font-medium text-slate-200">${c.value}</div>
        </div>`).join('')}
    </div>`;

    let table;
    if (!positions.length) {
      table = `<div class="mt-4 text-xs text-slate-500 px-1">페이퍼 포지션 없음. 아래 매매 패널에서 시작.</div>`;
    } else {
      table = `<div class="mt-4 overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="text-slate-500">
            <tr class="border-b border-slate-700/40">
              <th class="text-left py-1.5 px-2">종목</th>
              <th class="text-right py-1.5 px-2">수량</th>
              <th class="text-right py-1.5 px-2">평단</th>
              <th class="text-right py-1.5 px-2">현재가</th>
              <th class="text-right py-1.5 px-2">평가</th>
              <th class="text-right py-1.5 px-2">손익</th>
            </tr>
          </thead>
          <tbody>${positions.map(p => renderHoldingRow(p, 'paper')).join('')}</tbody>
        </table>
      </div>`;
    }

    return head + cardsHtml + table;
  }

  /* ── 4-2.4. 최근 거래 종목 태그 바 ── */
  function renderRecentSymbolsBar() {
    const items = tradeState.recentSymbols;
    if (items === null) return ''; // 아직 로드 안 됨
    if (!items.length) {
      return `<div class="text-[10px] text-slate-600 mb-2">최근 거래 없음</div>`;
    }
    const chips = items.map(it => {
      const name = it.symbolName || it.symbol;
      // side에 따라 미세한 색상 구분 (매우 약하게)
      const bgCls = it.side === 'buy'
        ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300/80'
        : it.side === 'sell'
        ? 'bg-rose-500/8 border-rose-500/20 text-rose-300/80'
        : 'bg-slate-700/40 border-slate-700 text-slate-400';
      return `<button type="button" class="stk-recent-chip inline-flex items-center px-2 py-0.5 rounded border ${bgCls} text-[10px] whitespace-nowrap hover:brightness-125 transition-all"
        data-symbol="${esc(it.symbol)}" data-side="${esc(it.side || '')}" data-name="${esc(it.symbolName || '')}">
        ${esc(name)}${it.symbolName ? ` <span class="ml-1 text-slate-500 font-mono">${esc(it.symbol)}</span>` : ''}
      </button>`;
    }).join('');
    return `<div class="flex gap-1.5 mb-2 overflow-x-auto scrollbar-none">${chips}</div>`;
  }

  /* ── 4-2.5. 시세 미리보기 카드 ── */
  function renderQuotePreviewHtml() {
    const sym = tradeState.form.symbol;
    if (!/^\d{5,6}$/.test(sym)) {
      return ''; // symbol 확정 전에는 미표시 (UI 조용)
    }
    const q = tradeState.quote;
    const err = tradeState.quoteErr;

    // 실패 + 캐시도 없을 때
    if (!q && err) {
      return `<div class="rounded-lg border border-dashed border-slate-700/60 bg-slate-800/20 px-3 py-2 text-xs text-slate-500 flex items-center gap-2">
        <span class="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 text-[10px]">시세</span>
        <span>시세 조회 실패 · ${esc(mapErr(err))}</span>
        <span class="text-slate-700">${esc(sym)}</span>
      </div>`;
    }
    if (!q) {
      return `<div class="rounded-lg border border-dashed border-slate-700/60 bg-slate-800/20 px-3 py-2 text-xs text-slate-500 flex items-center gap-2">
        <span class="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 text-[10px]">시세</span>
        <span class="text-slate-600">—</span>
        <span class="text-slate-700">${esc(sym)}</span>
      </div>`;
    }
    const chg = Number(q.changeAmount) || 0;
    const chgPct = (q.changePct != null) ? Number(q.changePct) : null;
    const chgCls = chg > 0 ? 'text-emerald-400' : chg < 0 ? 'text-rose-400' : 'text-slate-400';
    const ph = (v, fmt) => (v == null || isNaN(v)) ? '<span class="text-slate-600">—</span>' : (fmt ? fmt(v) : esc(String(v)));
    const badges = [];
    if (q.marketHours) {
      badges.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/8 text-emerald-300 text-[10px]">장중</span>`);
    } else {
      badges.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 text-[10px]">장외</span>`);
    }
    if (q.cached) {
      badges.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 text-[10px]">캐시</span>`);
    }
    if (q.stale) {
      badges.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/8 text-amber-300 text-[10px]">지연</span>`);
    }

    // 동등 가중 미니 필드 6개: 현재/전일대비/시/고/저/전일종가 + 거래량 (절제)
    return `<div class="rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-mono text-slate-300">${esc(q.symbol || sym)}</span>
          <span class="text-slate-400">${esc(q.name || '')}</span>
          ${badges.join(' ')}
        </div>
        <div class="flex items-center gap-3">
          <span><span class="text-slate-500">현재</span> <span class="text-slate-200">${ph(q.price, fmtKRW)}</span></span>
          <span class="${chgCls}">${chg >= 0 ? '+' : ''}${ph(chg, fmtKRW)}${chgPct != null ? ` (${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : ''}</span>
        </div>
        <div class="flex items-center gap-3 text-slate-500">
          <span>시 <span class="text-slate-300">${ph(q.open, fmtKRW)}</span></span>
          <span>고 <span class="text-slate-300">${ph(q.high, fmtKRW)}</span></span>
          <span>저 <span class="text-slate-300">${ph(q.low, fmtKRW)}</span></span>
          <span>전일 <span class="text-slate-300">${ph(q.prevClose, fmtKRW)}</span></span>
          <span>거래 <span class="text-slate-300">${ph(q.volume, (v) => Number(v).toLocaleString())}</span></span>
        </div>
      </div>
    </div>`;
  }

  function renderQuotePreview() {
    const el = document.getElementById('stk-quote-preview');
    if (el) el.innerHTML = renderQuotePreviewHtml();
  }

  /* ── 예상 체결금액 계산 + 한도 게이지 렌더 ── */
  function computeEstimate() {
    const f = tradeState.form;
    const qty = Number(f.qty);
    if (!Number.isInteger(qty) || qty < 1) return null;
    let price = 0;
    if (f.priceType === 'limit') {
      price = Number(f.limitPrice) || 0;
    } else {
      price = (tradeState.quote && Number(tradeState.quote.price)) || 0;
    }
    if (!(price > 0)) return null;
    return { amount: qty * price, price };
  }

  function renderEstimate() {
    const el = document.getElementById('stk-estimate');
    if (!el) return;
    const est = computeEstimate();
    const singleCap = (tradeState.dailyStats && tradeState.dailyStats.singleOrder && tradeState.dailyStats.singleOrder.maxAmountKRW) || 100000000;
    if (!est) {
      el.innerHTML = `<span class="text-slate-600">예상 금액 —</span>`;
      return;
    }
    const over = est.amount > singleCap;
    el.innerHTML = `
      <span class="text-slate-500">예상 금액</span>
      <span class="${over ? 'text-rose-400' : 'text-slate-300'} font-mono">${esc(fmtKRW(est.amount))}</span>
      ${over ? '<span class="text-[10px] text-rose-400">단건 한도 초과</span>' : ''}
    `;
  }

  function renderLimitBars() {
    const el = document.getElementById('stk-limit-bars');
    if (!el) return;
    if (tradeState.dailyStatsErr || !tradeState.dailyStats) {
      el.innerHTML = `<div class="text-[10px] text-slate-500">일일 한도: ${esc(mapErr(tradeState.dailyStatsErr || 'daily_stats_unavailable'))}</div>`;
      return;
    }
    const ds = tradeState.dailyStats;
    const usedCount = Number(ds.count) || 0;
    const capCount = (ds.caps && Number(ds.caps.count)) || 50;
    const usedAmt = Number(ds.amountKRW) || 0;
    const capAmt = (ds.caps && Number(ds.caps.amountKRW)) || 1_000_000_000;

    // 이번 주문 예측 부분
    const est = computeEstimate();
    const predCount = usedCount + (est ? 1 : 0);
    const predAmt = usedAmt + (est ? est.amount : 0);

    const cntBase = Math.min(100, (usedCount / capCount) * 100);
    const cntPred = Math.min(100, (predCount / capCount) * 100) - cntBase;
    const amtBase = Math.min(100, (usedAmt / capAmt) * 100);
    const amtPred = Math.min(100, (predAmt / capAmt) * 100) - amtBase;

    const cntOver = predCount > capCount;
    const amtOver = predAmt > capAmt;

    const bar = (baseW, predW, over, usedText, capText, label) => `
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500 w-8">${esc(label)}</span>
        <div class="relative flex-1 h-1.5 rounded bg-slate-800 overflow-hidden">
          <div class="absolute inset-y-0 left-0 bg-slate-500/60" style="width:${baseW.toFixed(1)}%"></div>
          ${predW > 0 ? `<div class="absolute inset-y-0 bg-${over ? 'rose' : 'amber'}-500/60" style="left:${baseW.toFixed(1)}%;width:${Math.max(0, predW).toFixed(1)}%"></div>` : ''}
        </div>
        <span class="text-[10px] text-slate-500 whitespace-nowrap">${esc(usedText)} / ${esc(capText)}</span>
      </div>`;

    el.innerHTML = `
      <div class="flex flex-col gap-1">
        ${bar(cntBase, cntPred, cntOver, String(usedCount) + '건', String(capCount) + '건', '건수')}
        ${bar(amtBase, amtPred, amtOver, fmtKRW(usedAmt), fmtKRW(capAmt), '금액')}
      </div>`;
  }

  /* ── autocomplete 드롭다운 렌더 ── */
  function renderSearchDropdown() {
    const host = document.getElementById('stk-search-dropdown');
    if (!host) return;
    const s = tradeState.search;
    if (!s.open || !s.items.length) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    host.innerHTML = s.items.map((it, idx) => {
      const active = idx === s.activeIdx;
      return `<div class="stk-search-row px-2 py-1.5 cursor-pointer text-xs flex items-center gap-2 ${active ? 'bg-violet-500/15' : 'hover:bg-slate-800/60'}"
        data-code="${esc(it.code)}" data-name="${esc(it.name)}" data-idx="${idx}">
        <span class="text-slate-200 flex-1 truncate">${esc(it.name || '')}</span>
        <span class="font-mono text-slate-500">${esc(it.code || '')}</span>
        <span class="text-[10px] text-slate-600">${esc(it.market || '')}</span>
      </div>`;
    }).join('');
    // row 클릭
    host.querySelectorAll('.stk-search-row').forEach(r => {
      r.onmousedown = (e) => {
        // mousedown으로 blur 전에 동작 (input blur → close 순서 회피)
        e.preventDefault();
        const code = r.dataset.code;
        const name = r.dataset.name;
        selectSearchItem(code, name);
      };
    });
  }

  function selectSearchItem(code, name) {
    tradeState.form.symbol = code || '';
    tradeState.form.symbolName = name || '';
    tradeState.search.open = false;
    tradeState.search.activeIdx = -1;
    // input 값 반영 (재렌더 피해 성능 이점)
    const input = document.getElementById('stk-form-symbol');
    if (input) input.value = code || '';
    const nameLabel = document.getElementById('stk-form-symbol-name');
    if (nameLabel) nameLabel.textContent = name || '';
    renderSearchDropdown();
    refreshQuote(true);
  }

  /* ── 4-3. 매매 패널 ── */
  function renderOrderPanel() {
    const f = tradeState.form;
    const sideBtn = (val, label, color) => {
      const active = f.side === val;
      const activeCls = color === 'rose'
        ? 'bg-rose-500/20 border-rose-500/60 text-rose-200'
        : 'bg-emerald-500/20 border-emerald-500/60 text-emerald-200';
      const idleCls = 'border-slate-700 text-slate-400 hover:text-slate-200';
      return `<button type="button" data-side="${val}" class="stk-side-btn px-3 py-1.5 rounded-lg border text-xs font-semibold ${active ? activeCls : idleCls}">${label}</button>`;
    };
    const ptBtn = (val, label) => {
      const active = f.priceType === val;
      const activeCls = 'bg-violet-500/20 border-violet-500/60 text-violet-200';
      const idleCls = 'border-slate-700 text-slate-400 hover:text-slate-200';
      return `<button type="button" data-pt="${val}" class="stk-pt-btn px-3 py-1.5 rounded-lg border text-xs font-semibold ${active ? activeCls : idleCls}">${label}</button>`;
    };
    return `${sectionHeader('매매 패널 (Paper)', 'paper')}
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-4">
      <div class="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <div class="md:col-span-1 relative">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-2">
            <span>종목</span>
            <span id="stk-form-symbol-name" class="text-[10px] normal-case tracking-normal text-slate-400 truncate max-w-[120px]">${esc(f.symbolName || '')}</span>
          </div>
          <input id="stk-form-symbol" type="text" autocomplete="off" maxlength="16" placeholder="005930 또는 종목명"
            value="${esc(f.symbol)}"
            class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm font-mono focus:outline-none focus:border-violet-500/60" />
          <div id="stk-search-dropdown" class="hidden absolute z-20 left-0 right-0 mt-1 rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-lg max-h-64 overflow-auto"></div>
        </div>
        <div class="md:col-span-1">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">방향</div>
          <div class="flex gap-2">
            ${sideBtn('buy', '매수', 'emerald')}
            ${sideBtn('sell', '매도', 'rose')}
          </div>
        </div>
        <div class="md:col-span-1">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">수량</div>
          <input id="stk-form-qty" type="number" min="1" step="1" placeholder="0"
            value="${esc(String(f.qty || ''))}"
            class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm focus:outline-none focus:border-violet-500/60" />
        </div>
        <div class="md:col-span-1">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">호가</div>
          <div class="flex gap-2">
            ${ptBtn('market', '시장가')}
            ${ptBtn('limit', '지정가')}
          </div>
        </div>
        <div class="md:col-span-1">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">지정가</div>
          <input id="stk-form-limit" type="number" min="0" step="1" placeholder="${f.priceType === 'limit' ? '필수' : '—'}"
            value="${esc(String(f.limitPrice || ''))}"
            ${f.priceType === 'limit' ? '' : 'disabled'}
            class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm focus:outline-none focus:border-violet-500/60 disabled:opacity-40" />
        </div>
      </div>
      <div class="mt-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">메모 (선택)</div>
        <input id="stk-form-note" type="text" maxlength="200" placeholder=""
          value="${esc(f.clientNote)}"
          class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm focus:outline-none focus:border-violet-500/60" />
      </div>
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div id="stk-limit-bars" class="text-[10px] text-slate-500">${esc(tradeState.dailyStatsErr ? ('일일 한도: ' + mapErr(tradeState.dailyStatsErr)) : '')}</div>
        </div>
        <div class="md:text-right">
          <div id="stk-estimate" class="text-xs flex items-center gap-2 md:justify-end"></div>
        </div>
      </div>
      <div class="mt-3 flex items-center justify-between gap-3">
        <div id="stk-form-error" class="text-xs text-rose-400 min-h-[1rem]"></div>
        <div class="flex gap-2">
          <button id="stk-form-clear" type="button" class="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs hover:bg-slate-800">초기화</button>
          <button id="stk-form-prepare" type="button" class="px-4 py-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 text-violet-300 text-xs font-semibold hover:bg-violet-500/25">확인</button>
        </div>
      </div>
    </div>`;
  }

  /* ── 4-4. 주문 내역 ── */
  function renderOrderHistory() {
    const head = `<div class="flex items-center justify-between mb-3">
      <span class="inline-flex items-center px-2 py-0.5 rounded-md border border-violet-500/30 bg-violet-500/8 text-violet-300 text-[11px] font-semibold uppercase tracking-wider">최근 주문 · Paper · 20건</span>
      <button id="stk-orders-refresh" type="button" class="px-3 py-1 rounded-lg border border-slate-700 text-slate-400 text-xs hover:bg-slate-800">새로고침</button>
    </div>`;
    if (tradeState.ordersErr) {
      return head + `<div class="rounded-xl border border-dashed border-slate-700/60 bg-slate-800/20 px-4 py-3 text-xs text-slate-500">주문 내역 조회 실패: ${esc(mapErr(tradeState.ordersErr.detail))}</div>`;
    }
    const items = (tradeState.orders && tradeState.orders.items) || [];
    if (!items.length) {
      return head + `<div class="text-xs text-slate-500 px-1">주문 내역 없음.</div>`;
    }
    return head + `<div class="overflow-x-auto rounded-xl border border-slate-700/50 bg-slate-800/30">
      <table class="w-full text-xs">
        <thead class="text-slate-500 bg-slate-800/40">
          <tr>
            <th class="text-left py-2 px-3">시각</th>
            <th class="text-left py-2 px-3">종목</th>
            <th class="text-left py-2 px-3">종목명</th>
            <th class="text-left py-2 px-3">방향</th>
            <th class="text-right py-2 px-3">수량</th>
            <th class="text-right py-2 px-3">체결가</th>
            <th class="text-left py-2 px-3">호가</th>
            <th class="text-left py-2 px-3">상태</th>
            <th class="text-left py-2 px-3">메모</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(o => {
            const sideCls = o.side === 'buy' ? 'text-emerald-400' : o.side === 'sell' ? 'text-rose-400' : 'text-slate-400';
            const nm = o.symbolName || '';
            return `<tr class="border-t border-slate-800/60">
              <td class="py-1.5 px-3 text-slate-500">${esc(fmtRel(o.createdAt || o.occurredAt))}</td>
              <td class="py-1.5 px-3 font-mono text-slate-300">${esc(o.symbol || '—')}</td>
              <td class="py-1.5 px-3 text-slate-400">${nm ? esc(nm) : '<span class="text-slate-600">—</span>'}</td>
              <td class="py-1.5 px-3 ${sideCls} font-semibold">${o.side === 'buy' ? '매수' : o.side === 'sell' ? '매도' : '—'}</td>
              <td class="py-1.5 px-3 text-right text-slate-300">${o.qty != null ? esc(String(o.qty)) : '—'}</td>
              <td class="py-1.5 px-3 text-right text-slate-300">${o.fillPrice != null ? esc(fmtKRW(o.fillPrice)) : '—'}</td>
              <td class="py-1.5 px-3 text-slate-400">${esc(o.priceType || '—')}${o.priceType === 'limit' && o.limitPrice ? ' ' + esc(fmtKRW(o.limitPrice)) : ''}</td>
              <td class="py-1.5 px-3">${itemStatusBadge(o.status)}</td>
              <td class="py-1.5 px-3 text-slate-500">${esc(o.clientNote || '')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  /* ── 폼 핸들러 ── */
  function bindFormHandlers() {
    const f = tradeState.form;

    // 최근 거래 종목 칩 클릭
    document.querySelectorAll('.stk-recent-chip').forEach(chip => {
      chip.onclick = () => {
        const symbol = chip.dataset.symbol || '';
        const name = chip.dataset.name || '';
        f.symbol = symbol;
        if (name) f.symbolName = name;
        renderStockTrade();
        if (/^\d{5,6}$/.test(symbol)) refreshQuote(true);
      };
    });

    document.querySelectorAll('.stk-side-btn').forEach(b => {
      b.onclick = () => { f.side = b.dataset.side; renderStockTrade(); };
    });
    document.querySelectorAll('.stk-pt-btn').forEach(b => {
      b.onclick = () => { f.priceType = b.dataset.pt; renderStockTrade(); };
    });
    const sym = document.getElementById('stk-form-symbol');
    const qty = document.getElementById('stk-form-qty');
    const lim = document.getElementById('stk-form-limit');
    const note = document.getElementById('stk-form-note');

    // 종목코드/종목명 autocomplete
    if (sym) {
      sym.oninput = (e) => {
        const raw = e.target.value;
        // 숫자 6자리면 코드로 확정 (기존 동작 유지) — 다만 이름 검색도 허용해야 하므로 strip 안 함
        tradeState.form.symbol = raw;
        // 코드 확정되면 name 초기화 (autocomplete 선택 전)
        if (!/^\d{5,6}$/.test(raw)) {
          // 검색 모드
          const q = raw.trim();
          tradeState.search.q = q;
          if (tradeState.search.debounceTimer) clearTimeout(tradeState.search.debounceTimer);
          if (!q) {
            tradeState.search.items = [];
            tradeState.search.open = false;
            renderSearchDropdown();
            return;
          }
          tradeState.search.debounceTimer = setTimeout(async () => {
            const res = await fetchSymbolSearch(q);
            // 사용자 쿼리가 바뀌었으면 무시 (race)
            if (tradeState.search.q !== q) return;
            tradeState.search.items = (res && res.items) || [];
            tradeState.search.activeIdx = -1;
            tradeState.search.open = tradeState.search.items.length > 0;
            renderSearchDropdown();
          }, SEARCH_DEBOUNCE_MS);
        } else {
          // 6자리 숫자 직접 입력 — 드롭다운 닫고 이름 라벨은 확정 시점에 채움
          tradeState.search.open = false;
          renderSearchDropdown();
        }
      };
      sym.onkeydown = (e) => {
        const s = tradeState.search;
        if (e.key === 'Escape') {
          s.open = false; renderSearchDropdown(); return;
        }
        if (s.open && s.items.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); s.activeIdx = (s.activeIdx + 1) % s.items.length; renderSearchDropdown(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); s.activeIdx = (s.activeIdx - 1 + s.items.length) % s.items.length; renderSearchDropdown(); return; }
          if (e.key === 'Enter') {
            e.preventDefault();
            const idx = s.activeIdx >= 0 ? s.activeIdx : 0;
            const it = s.items[idx];
            if (it) selectSearchItem(it.code, it.name);
            return;
          }
        } else if (e.key === 'Enter') {
          // 직접 입력 후 Enter → symbol 확정, 시세 조회
          const raw = sym.value.trim();
          if (/^\d{5,6}$/.test(raw)) {
            tradeState.form.symbol = raw;
            refreshQuote(true);
          }
        }
      };
      sym.onblur = () => {
        // 외부 클릭 처리 — mousedown preventDefault로 row 클릭은 이미 처리됨
        setTimeout(() => {
          tradeState.search.open = false;
          renderSearchDropdown();
          // blur 시 symbol 확정되어 있으면 시세 조회
          const raw = (tradeState.form.symbol || '').trim();
          if (/^\d{5,6}$/.test(raw)) {
            refreshQuote(true);
          }
        }, 120);
      };
      sym.onfocus = () => {
        if (tradeState.search.items.length && tradeState.search.q) {
          tradeState.search.open = true;
          renderSearchDropdown();
        }
      };
    }
    if (qty) qty.oninput = (e) => { f.qty = e.target.value; renderEstimate(); renderLimitBars(); };
    if (lim) lim.oninput = (e) => { f.limitPrice = e.target.value; renderEstimate(); renderLimitBars(); };
    if (note) note.oninput = (e) => { f.clientNote = e.target.value; };

    const clearBtn = document.getElementById('stk-form-clear');
    if (clearBtn) clearBtn.onclick = () => {
      tradeState.form = { symbol: '', side: 'buy', qty: '', priceType: 'market', limitPrice: '', clientNote: '', symbolName: '' };
      tradeState.quote = null; tradeState.quoteErr = null; tradeState.quoteSymbol = '';
      tradeState.search.items = []; tradeState.search.open = false; tradeState.search.q = '';
      renderStockTrade();
    };
    const prepBtn = document.getElementById('stk-form-prepare');
    if (prepBtn) prepBtn.onclick = onPrepareClick;
    const refreshBtn = document.getElementById('stk-orders-refresh');
    if (refreshBtn) refreshBtn.onclick = refreshPaperAll;

    // 최초/재렌더 직후 현재 상태 한번 반영
    renderEstimate();
    renderLimitBars();
    renderSearchDropdown();
  }

  // 외부에서 종목 행 클릭 시 폼 자동 채움
  window.fillStockOrderForm = function (symbol, side, qty) {
    const sym = String(symbol || '');
    tradeState.form.symbol = sym;
    tradeState.form.side = (side === 'sell' || side === 'buy') ? side : 'buy';
    if (qty && Number(qty) > 0) tradeState.form.qty = String(qty);
    tradeState.form.priceType = 'market';
    tradeState.form.limitPrice = '';
    // 기존 holdings/positions 에서 name 찾아서 미리 채우기
    const findName = () => {
      const h = ((tradeState.holdings && tradeState.holdings.holdings) || []).find(x => x.symbol === sym);
      if (h && h.name) return h.name;
      const p = ((tradeState.positions && tradeState.positions.positions) || []).find(x => x.symbol === sym);
      if (p && p.name) return p.name;
      return '';
    };
    tradeState.form.symbolName = findName();
    renderStockTrade();
    // 폼 영역으로 스크롤
    const panel = document.getElementById('stk-form-symbol');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 시세 즉시 조회
    if (/^\d{5,6}$/.test(sym)) refreshQuote(true);
  };

  /* ── prepare → 모달 ── */
  function setFormError(msg) {
    const el = document.getElementById('stk-form-error');
    if (el) el.textContent = msg || '';
  }
  function validateForm() {
    const f = tradeState.form;
    if (!/^\d{5,6}$/.test(f.symbol)) return '종목코드는 5~6자리 숫자여야 합니다. (검색 결과를 선택해주세요)';
    if (!['buy', 'sell'].includes(f.side)) return '방향을 선택해주세요.';
    const q = Number(f.qty);
    if (!Number.isInteger(q) || q < 1) return '수량은 1 이상의 정수.';
    if (q > 10000) return '수량은 10,000주를 초과할 수 없습니다.';
    if (!['market', 'limit'].includes(f.priceType)) return '호가 유형을 선택해주세요.';
    if (f.priceType === 'limit') {
      const lp = Number(f.limitPrice);
      if (!(lp > 0)) return '지정가는 양수여야 합니다.';
    }
    // 한도 가드 (프론트 차단은 soft — 백엔드가 최종)
    const est = computeEstimate();
    const singleCap = (tradeState.dailyStats && tradeState.dailyStats.singleOrder && tradeState.dailyStats.singleOrder.maxAmountKRW) || 100000000;
    if (est && est.amount > singleCap) return '단건 주문 한도(1억원)를 초과했습니다.';
    if (est && tradeState.dailyStats && tradeState.dailyStats.caps) {
      const capCount = Number(tradeState.dailyStats.caps.count) || 50;
      const capAmt = Number(tradeState.dailyStats.caps.amountKRW) || 1_000_000_000;
      const usedCount = Number(tradeState.dailyStats.count) || 0;
      const usedAmt = Number(tradeState.dailyStats.amountKRW) || 0;
      if (usedCount + 1 > capCount) return '오늘 paper 주문 건수 한도(50건)를 초과합니다.';
      if (usedAmt + est.amount > capAmt) return '오늘 paper 주문 금액 한도(10억원)를 초과합니다.';
    }
    return null;
  }

  async function onPrepareClick() {
    setFormError('');
    const err = validateForm();
    if (err) { setFormError(err); return; }
    const f = tradeState.form;
    const payload = {
      symbol: f.symbol,
      side: f.side,
      qty: Number(f.qty),
      priceType: f.priceType,
      limitPrice: f.priceType === 'limit' ? Number(f.limitPrice) : null,
      clientNote: f.clientNote || '',
    };
    const btn = document.getElementById('stk-form-prepare');
    if (btn) { btn.disabled = true; btn.textContent = '확인 중...'; }
    const r = await apiFetch('/api/stock/paper/order/prepare', { method: 'POST', body: payload });
    if (btn) { btn.disabled = false; btn.textContent = '확인'; }
    if (!r.ok) {
      setFormError(mapErr(r.body.detail || r.body.error || ('HTTP ' + r.status)));
      return;
    }
    tradeState.pending = {
      confirmToken: r.body.confirmToken,
      preview: r.body.preview || {},
      payload,
      expiresAt: Date.now() + ((r.body.expiresIn || 60) * 1000),
    };
    openOrderModal();
  }

  function openOrderModal() {
    const modal = document.getElementById('stk-order-modal');
    const body = document.getElementById('stk-order-modal-body');
    const errEl = document.getElementById('stk-order-modal-error');
    const okBtn = document.getElementById('stk-order-modal-ok');
    const cancelBtn = document.getElementById('stk-order-modal-cancel');
    const check = document.getElementById('stk-order-confirm-check');
    if (!modal || !body || !okBtn || !cancelBtn || !check) return;

    const p = tradeState.pending;
    const pv = p.preview || {};
    const sideLabel = p.payload.side === 'buy' ? '매수' : '매도';
    const sideCls = p.payload.side === 'buy' ? 'text-emerald-400' : 'text-rose-400';
    const ptLabel = p.payload.priceType === 'limit' ? `지정가 ${esc(fmtKRW(p.payload.limitPrice))}` : '시장가';
    const fill = pv.estimatedFillPrice;
    const total = pv.estimatedTotal;
    const name = pv.name || '';
    const mh = pv.marketHours;

    body.innerHTML = `
      <div class="flex justify-between"><span class="text-slate-500">종목</span><span class="text-slate-200 font-mono">${esc(p.payload.symbol)}${name ? ' · ' + esc(name) : ''}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">방향</span><span class="${sideCls} font-semibold">${sideLabel}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">수량</span><span class="text-slate-200">${esc(String(p.payload.qty))}주</span></div>
      <div class="flex justify-between"><span class="text-slate-500">호가</span><span class="text-slate-300">${ptLabel}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">예상 체결가</span><span class="text-slate-200">${fill != null ? esc(fmtKRW(fill)) : '<span class="text-slate-600">—</span>'}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">예상 금액</span><span class="text-slate-200">${total != null ? esc(fmtKRW(total)) : '<span class="text-slate-600">—</span>'}</span></div>
      ${mh === false ? '<div class="text-[11px] text-amber-400 mt-1">장 마감 — 실행 시 거부됩니다.</div>' : ''}
      <div class="text-[10px] text-slate-600 mt-1">paper 주문 · 확인 세션 60초</div>
    `;
    errEl.classList.add('hidden'); errEl.textContent = '';
    check.checked = false;
    okBtn.disabled = true;
    check.onchange = () => { okBtn.disabled = !check.checked; };
    cancelBtn.onclick = closeOrderModal;
    okBtn.onclick = onConfirmOrder;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeOrderModal() {
    const modal = document.getElementById('stk-order-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    tradeState.pending = null;
  }

  async function onConfirmOrder() {
    const errEl = document.getElementById('stk-order-modal-error');
    const okBtn = document.getElementById('stk-order-modal-ok');
    if (!tradeState.pending) {
      if (errEl) { errEl.textContent = '확인 세션이 없습니다.'; errEl.classList.remove('hidden'); }
      return;
    }
    if (Date.now() > tradeState.pending.expiresAt) {
      if (errEl) { errEl.textContent = '확인 세션이 만료되었습니다(60초). 모달 닫고 다시 시도.'; errEl.classList.remove('hidden'); }
      return;
    }
    const p = tradeState.pending;
    const body = Object.assign({}, p.payload, { confirmToken: p.confirmToken });
    if (okBtn) { okBtn.disabled = true; okBtn.textContent = '실행 중...'; }
    const r = await apiFetch('/api/stock/paper/order', { method: 'POST', body });
    if (okBtn) { okBtn.textContent = '실행'; }
    if (!r.ok || r.body.ok === false) {
      const msg = mapErr(r.body.detail || r.body.error || ('HTTP ' + r.status));
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      if (okBtn) okBtn.disabled = false;
      return;
    }
    // 성공
    showToast(`주문 실행: ${p.payload.side === 'buy' ? '매수' : '매도'} ${p.payload.symbol} ${p.payload.qty}주`);
    closeOrderModal();
    // 폼 초기화 (수량/메모만 비움, 종목/방향은 유지하면 연속 매매 편함 — 여기선 수량만 초기화)
    tradeState.form.qty = '';
    tradeState.form.clientNote = '';
    tradeState.form.limitPrice = '';
    await refreshPaperAll();
    // 실잔고도 갱신
    refreshAccountAndPositions();
    // 일일 한도 갱신
    refreshDailyStats();
    // 최근 거래 종목 갱신
    fetchRecentSymbols().then(() => {
      const bar = document.getElementById('stk-recent-symbols');
      if (bar) bar.innerHTML = renderRecentSymbolsBar();
      document.querySelectorAll('.stk-recent-chip').forEach(chip => {
        chip.onclick = () => {
          tradeState.form.symbol = chip.dataset.symbol || '';
          if (chip.dataset.name) tradeState.form.symbolName = chip.dataset.name;
          renderStockTrade();
          if (/^\d{5,6}$/.test(chip.dataset.symbol)) refreshQuote(true);
        };
      });
    });
  }

})();
