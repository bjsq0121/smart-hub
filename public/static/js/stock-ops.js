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
          <thead><tr><th>종목</th><th>단계</th><th>점수</th><th>사유</th><th>진입가</th><th>손절</th><th>목표가</th><th>방향</th><th>상태</th><th>생성</th></tr></thead>
          <tbody>${items.map((s, idx) => {
            const scoreCls = s.score >= 8 ? 'color:#34d399' : s.score >= 6 ? 'color:#fbbf24' : 'color:#f87171';
            const sid = String(s.signalId || s.id || idx).replace(/[^a-zA-Z0-9_-]/g, '_');
            const isNew = newSignalIds.has(s.signalId || s.id);
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
            </tr>
            <tr class="ops-factors-row" id="stk-factors-${sid}" style="display:none;">
              <td colspan="10" style="padding:10px 16px;">${renderFactors(s.factors)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
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
    form: { symbol: '', side: 'buy', qty: '', priceType: 'market', limitPrice: '', clientNote: '' },
    pending: null,        // {confirmToken, preview, payload, expiresAt}
    submitting: false,
    pollingTimer: null,
  };
  const TRADE_POLL_MS = 30_000;

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

  /* ── 데이터 로드 ── */
  async function loadStockTrade() {
    const el = document.getElementById('stock-trade-content');
    if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.innerHTML = '<div class="text-slate-500 text-sm py-6 text-center">로딩 중...</div>';
    }

    const [accRes, hldRes, posRes, ordRes] = await Promise.allSettled([
      apiFetch('/api/stock/account/balance'),
      apiFetch('/api/stock/account/holdings'),
      apiFetch('/api/stock/paper/positions'),
      apiFetch('/api/stock/paper/orders?limit=20'),
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

    renderStockTrade();
    startTradePolling();
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
        <div class="md:col-span-1">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 mb-1">종목코드</div>
          <input id="stk-form-symbol" type="text" inputmode="numeric" maxlength="6" placeholder="005930"
            value="${esc(f.symbol)}"
            class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm font-mono focus:outline-none focus:border-violet-500/60" />
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
            return `<tr class="border-t border-slate-800/60">
              <td class="py-1.5 px-3 text-slate-500">${esc(fmtRel(o.createdAt || o.occurredAt))}</td>
              <td class="py-1.5 px-3 font-mono text-slate-300">${esc(o.symbol || '—')}</td>
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
    if (sym) sym.oninput = (e) => { f.symbol = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = f.symbol; };
    if (qty) qty.oninput = (e) => { f.qty = e.target.value; };
    if (lim) lim.oninput = (e) => { f.limitPrice = e.target.value; };
    if (note) note.oninput = (e) => { f.clientNote = e.target.value; };

    const clearBtn = document.getElementById('stk-form-clear');
    if (clearBtn) clearBtn.onclick = () => {
      tradeState.form = { symbol: '', side: 'buy', qty: '', priceType: 'market', limitPrice: '', clientNote: '' };
      renderStockTrade();
    };
    const prepBtn = document.getElementById('stk-form-prepare');
    if (prepBtn) prepBtn.onclick = onPrepareClick;
    const refreshBtn = document.getElementById('stk-orders-refresh');
    if (refreshBtn) refreshBtn.onclick = refreshPaperAll;
  }

  // 외부에서 종목 행 클릭 시 폼 자동 채움
  window.fillStockOrderForm = function (symbol, side, qty) {
    tradeState.form.symbol = String(symbol || '');
    tradeState.form.side = (side === 'sell' || side === 'buy') ? side : 'buy';
    if (qty && Number(qty) > 0) tradeState.form.qty = String(qty);
    tradeState.form.priceType = 'market';
    tradeState.form.limitPrice = '';
    renderStockTrade();
    // 폼 영역으로 스크롤
    const panel = document.getElementById('stk-form-symbol');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /* ── prepare → 모달 ── */
  function setFormError(msg) {
    const el = document.getElementById('stk-form-error');
    if (el) el.textContent = msg || '';
  }
  function validateForm() {
    const f = tradeState.form;
    if (!/^\d{5,6}$/.test(f.symbol)) return '종목코드는 5~6자리 숫자여야 합니다.';
    if (!['buy', 'sell'].includes(f.side)) return '방향을 선택해주세요.';
    const q = Number(f.qty);
    if (!Number.isInteger(q) || q < 1) return '수량은 1 이상의 정수.';
    if (q > 10000) return '수량은 10,000주를 초과할 수 없습니다.';
    if (!['market', 'limit'].includes(f.priceType)) return '호가 유형을 선택해주세요.';
    if (f.priceType === 'limit') {
      const lp = Number(f.limitPrice);
      if (!(lp > 0)) return '지정가는 양수여야 합니다.';
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
  }

})();
