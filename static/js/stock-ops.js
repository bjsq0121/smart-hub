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

})();
