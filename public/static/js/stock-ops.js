/* ═══════════════════════════════════════
   📈 주식운영 (stock-ops)
   — 별도 파일로 분리. 주식운영 관련 로직은 여기에 추가.
   — 의존: common 함수 (esc, fmtKRW, fmtRel, authHeaders 등)는 app.js에 정의돼 있음.
   — 로드 순서: app.js → stock-ops.js (index.html에서 script 순서)
═══════════════════════════════════════ */

(function () {
  'use strict';

  // ── 상태 ──
  let stockData = { signals: null, alerts: null };
  let stockStageFilter = '';
  let stockDirFilter = '';
  let stockSeverityFilter = '';

  // ── 필터 세터 (전역 노출) ──
  window.setStockStageFilter = (v) => { stockStageFilter = v; renderStockSignals(); updateChipState('stock-ops-pane-signals', 0, v); };
  window.setStockDirFilter = (v) => { stockDirFilter = v; renderStockSignals(); updateChipState('stock-ops-pane-signals', 1, v); };
  window.setStockSeverityFilter = (v) => { stockSeverityFilter = v; renderStockAlerts(); updateChipState('stock-ops-pane-alerts', 0, v); };

  function updateChipState(paneId, groupIdx, activeVal) {
    const pane = document.getElementById(paneId);
    if (!pane) return;
    const groups = pane.querySelectorAll(':scope > div');
    const group = groups[groupIdx];
    if (!group) return;
    group.querySelectorAll('.mode-chip').forEach(btn => {
      const onclick = btn.getAttribute('onclick') || '';
      const match = onclick.match(/\('([^']*)'\)/);
      const val = match ? match[1] : '';
      btn.classList.toggle('active', val === activeVal);
    });
  }

  // ── 데이터 로드 ──
  async function loadStockOps() {
    const ts = document.getElementById('stock-ops-last-update');
    if (ts) ts.textContent = '갱신: ' + new Date().toLocaleTimeString('ko-KR');
    const hdrs = typeof authHeaders === 'function' ? await authHeaders() : {};
    const [sigRes, alertRes] = await Promise.allSettled([
      fetch('/api/stock-signals?limit=50', { headers: hdrs }).then(r => r.json()),
      fetch('/api/stock-alerts?limit=30', { headers: hdrs }).then(r => r.json()),
    ]);
    stockData.signals = sigRes.status === 'fulfilled' ? sigRes.value : { items: [], error: '로드 실패' };
    stockData.alerts = alertRes.status === 'fulfilled' ? alertRes.value : { items: [], error: '로드 실패' };
    renderStockSignals();
    renderStockAlerts();
  }
  window.loadStockOps = loadStockOps;

  // ── 헬퍼 ──
  function _esc(s) { return typeof esc === 'function' ? esc(s) : String(s || ''); }
  function _fmtKRW(n) { return typeof fmtKRW === 'function' ? fmtKRW(n) : Number(n).toLocaleString('ko-KR'); }

  function relTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d)) return '-';
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return '방금';
    if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '시간 전';
    return Math.floor(diff / 86400000) + '일 전';
  }

  function emptyBox(msg) {
    return `<div class="ops-empty">${_esc(msg)}</div>`;
  }

  function scoreBadge(score) {
    const n = Number(score) || 0;
    const color = n >= 8 ? '#34d399' : n >= 6 ? '#fbbf24' : '#f87171';
    return `<span style="color:${color};font-weight:700;">${n}</span>`;
  }

  function stageBadge(stage) {
    if (stage === 'trade_ready') return '<span style="color:#a78bfa;font-size:0.75rem;font-weight:600;">매매준비</span>';
    return '<span style="color:#60a5fa;font-size:0.75rem;">후보</span>';
  }

  function dirBadge(dir) {
    if (dir === 'short') return '<span style="color:#f87171;font-weight:600;">SHORT</span>';
    return '<span style="color:#34d399;font-weight:600;">LONG</span>';
  }

  function severityStyle(sev) {
    if (sev === 'critical') return 'border-left:3px solid #ef4444;background:rgba(239,68,68,0.06);';
    if (sev === 'warning') return 'border-left:3px solid #f59e0b;background:rgba(245,158,11,0.06);';
    return 'border-left:3px solid #3b82f6;background:rgba(59,130,246,0.06);';
  }

  // ── 시그널 렌더 ──
  function renderStockSignals() {
    const el = document.getElementById('stock-signals-content');
    if (!el) return;
    const data = stockData.signals;
    if (!data || data.error) { el.innerHTML = emptyBox(data?.error || '데이터 없음'); return; }
    let items = data.items || [];
    if (!items.length) { el.innerHTML = emptyBox('주식 시그널이 아직 없습니다. Paperclip 에이전트가 분석을 시작하면 여기에 표시됩니다.'); return; }

    if (stockStageFilter) items = items.filter(s => s.stage === stockStageFilter);
    if (stockDirFilter) items = items.filter(s => s.direction === stockDirFilter);

    if (!items.length) {
      el.innerHTML = emptyBox('필터에 해당하는 시그널이 없습니다.');
      return;
    }

    el.innerHTML = `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead><tr>
            <th>종목</th><th>단계</th><th>점수</th><th>방향</th>
            <th>진입가</th><th>손절가</th><th>목표가</th><th>사유</th><th>시간</th>
          </tr></thead>
          <tbody>${items.map((s, i) => {
            const sid = String(s.signalId || s.id || i).replace(/[^a-zA-Z0-9_-]/g, '_');
            return `<tr style="cursor:pointer;" onclick="toggleStockFactors('${sid}')">
              <td style="font-weight:700;color:#e2e8f0;">${_esc(s.symbol)} <span style="font-size:0.65rem;color:#475569;">&#9662;</span></td>
              <td>${stageBadge(s.stage)}</td>
              <td>${scoreBadge(s.score)}</td>
              <td>${dirBadge(s.direction)}</td>
              <td style="text-align:right;">${s.entryPrice ? _fmtKRW(s.entryPrice) : '-'}</td>
              <td style="text-align:right;">${s.stopLoss ? _fmtKRW(s.stopLoss) : '-'}</td>
              <td style="text-align:right;">${s.targetPrice ? _fmtKRW(s.targetPrice) : '-'}</td>
              <td style="max-width:200px;white-space:normal;font-size:0.78rem;color:#94a3b8;">${_esc(s.scoreReason)}</td>
              <td style="font-size:0.75rem;color:#64748b;white-space:nowrap;">${relTime(s.created_at || s.occurredAt)}</td>
            </tr>
            <tr id="stock-factors-${sid}" style="display:none;">
              <td colspan="9" style="padding:12px 16px;background:rgba(255,255,255,0.02);">
                ${renderFactors(s.factors)}
              </td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function renderFactors(factors) {
    if (!factors || typeof factors !== 'object') return '<div style="color:#475569;font-size:0.78rem;">분석 팩터 없음</div>';
    const labels = { trend: '추세', rsi: 'RSI', macd: 'MACD', volume: '거래량', news_sentiment: '뉴스감성', risk_reward: 'R:R', stochastic: '스토캐스틱', bollinger: '볼린저' };
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;">
      ${Object.entries(factors).map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? v : { value: v };
        const scoreColor = (val.score || 0) >= 7 ? '#34d399' : (val.score || 0) >= 4 ? '#fbbf24' : '#f87171';
        return `<div style="padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;">${_esc(labels[k] || k)}</div>
          <div style="font-size:0.85rem;color:#e2e8f0;font-weight:600;">${_esc(String(val.value != null ? val.value : val))}</div>
          ${val.score != null ? `<div style="font-size:0.68rem;color:${scoreColor};">점수 ${val.score}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  window.toggleStockFactors = (id) => {
    const r = document.getElementById('stock-factors-' + id);
    if (r) r.style.display = r.style.display === 'none' ? 'table-row' : 'none';
  };

  // ── 알림 렌더 ──
  function renderStockAlerts() {
    const el = document.getElementById('stock-alerts-content');
    if (!el) return;
    const data = stockData.alerts;
    if (!data || data.error) { el.innerHTML = emptyBox(data?.error || '데이터 없음'); return; }
    let items = data.items || [];
    if (!items.length) { el.innerHTML = emptyBox('주식 알림이 없습니다.'); return; }

    if (stockSeverityFilter) items = items.filter(a => a.severity === stockSeverityFilter);
    if (!items.length) { el.innerHTML = emptyBox('필터에 해당하는 알림이 없습니다.'); return; }

    el.innerHTML = items.map(a => `
      <div style="${severityStyle(a.severity)}border-radius:10px;padding:14px 18px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-weight:700;color:#e2e8f0;font-size:0.9rem;">${_esc(a.title || a.alertType)}</span>
          <span style="font-size:0.72rem;color:#64748b;">${relTime(a.created_at || a.occurredAt)}</span>
        </div>
        ${a.symbol ? `<span style="font-size:0.72rem;color:#60a5fa;background:rgba(96,165,250,0.1);padding:2px 8px;border-radius:6px;margin-bottom:6px;display:inline-block;">${_esc(a.symbol)}</span>` : ''}
        <div style="font-size:0.82rem;color:#94a3b8;line-height:1.5;">${_esc(a.message)}</div>
      </div>
    `).join('');
  }

})();
