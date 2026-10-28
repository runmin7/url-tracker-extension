// content.js (ISOLATED World)
// 1) 사용자가 등록한 허용 도메인에서만 활성화 (사이드 패널에서 사이트별로 원클릭 추가/제거 가능)
// 2) 모든 프레임(부모 + iframe + 팝업)에서 마우스 오버(Hover) URL 툴팁 표시 및 원클릭 복사
// 3) 페이지 이동 / IFRAME 전환 / 팝업 / Ajax 이벤트 및 호버 정보를 우측 사이드 패널과 하단 퀵 바에 실시간 전달

(function () {
  if (window.__URL_TRACKER_CONTENT_LOADED__) return;
  window.__URL_TRACKER_CONTENT_LOADED__ = true;

  const legacyRoot = document.getElementById('__url_tracker_root__');
  if (legacyRoot) legacyRoot.remove();

  const IS_TOP = window === window.top;
  const DEFAULT_ALLOWED_DOMAINS = [];

  function checkDomainMatch(hostname, domains) {
    if (!hostname) return false;
    const h = String(hostname).toLowerCase();
    for (const raw of domains || []) {
      const d = String(raw || '').trim().toLowerCase();
      if (!d) continue;
      if (d === h) return true;
      if (d.startsWith('*.') && (h === d.slice(2) || h.endsWith('.' + d.slice(2)))) return true;
    }
    return false;
  }

  const state = {
    allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
    domainAllowed: false,
    hoverEnabled: true,
    paused: false,
    preserveLog: false,
    currentHoverInfo: null,
    latestPreviewUrl: window.location.pathname + window.location.search,
    latestPreviewKind: '현재 화면'
  };

  function syncDomainStateToPageHook() {
    state.domainAllowed = checkDomainMatch(window.location.hostname, state.allowedDomains);
    try {
      window.postMessage(
        {
          source: 'URL_TRACKER_CONTENT',
          type: 'SET_DOMAIN_ALLOWED',
          allowed: state.domainAllowed
        },
        '*'
      );
    } catch {}
    if (!state.domainAllowed) {
      hideHoverTooltip(true);
    }
    renderQuickBar();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(
        ['ut_allowedDomains', 'ut_hoverEnabled', 'ut_paused', 'ut_preserveLog'],
        (res) => {
          if (Array.isArray(res.ut_allowedDomains)) {
            state.allowedDomains = res.ut_allowedDomains;
          } else {
            chrome.storage.local.set({ ut_allowedDomains: DEFAULT_ALLOWED_DOMAINS });
          }
          if (typeof res.ut_hoverEnabled === 'boolean') state.hoverEnabled = res.ut_hoverEnabled;
          if (typeof res.ut_paused === 'boolean') state.paused = res.ut_paused;
          if (typeof res.ut_preserveLog === 'boolean') state.preserveLog = res.ut_preserveLog;
          syncDomainStateToPageHook();
          if (!state.hoverEnabled) hideHoverTooltip(true);
          renderQuickBar();
        }
      );
    } catch {}
  }

  function saveSettings(patch) {
    Object.assign(state, patch);
    renderQuickBar();
    try {
      const toStore = {};
      if ('hoverEnabled' in patch) toStore.ut_hoverEnabled = state.hoverEnabled;
      if ('paused' in patch) toStore.ut_paused = state.paused;
      if ('preserveLog' in patch) toStore.ut_preserveLog = state.preserveLog;
      chrome.storage.local.set(toStore);
      chrome.runtime.sendMessage({
        type: 'URL_TRACKER_BROADCAST_SETTINGS',
        settings: patch
      }).catch(() => {});
    } catch {}
  }

  loadSettings();

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------------
  // 마우스 오버(Hover) 툴팁 UI (허용된 도메인에서만 작동)
  // ---------------------------------------------------------------------------
  let hoverHost = null;
  let hoverShadow = null;
  let hoverCardEl = null;
  let hoverHideTimer = null;
  let isMouseInsideTooltip = false;

  function ensureHoverRoot() {
    if (hoverHost && document.documentElement.contains(hoverHost)) return;
    hoverHost = document.createElement('div');
    hoverHost.id = '__url_tracker_hover_root__';
    hoverHost.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    hoverShadow = hoverHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; font-family: 'Pretendard', 'Malgun Gothic', -apple-system, BlinkMacSystemFont, sans-serif; }
      .ut-hover-card {
        position: fixed;
        max-width: 500px;
        min-width: 280px;
        background: rgba(15, 23, 42, 0.97);
        color: #f8fafc;
        border: 1px solid rgba(56, 189, 248, 0.55);
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(15, 23, 42, 0.8);
        padding: 9px 11px;
        font-size: 12px;
        line-height: 1.45;
        pointer-events: auto;
        z-index: 2147483647;
      }
      .ut-hover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding-bottom: 5px;
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      }
      .ut-el-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-weight: 700;
        color: #38bdf8;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ut-el-selector {
        color: #94a3b8;
        font-family: Consolas, Monaco, monospace;
        font-size: 11px;
        font-weight: 400;
      }
      .ut-shortcut-hint {
        font-size: 10px;
        color: #cbd5e1;
        background: rgba(51, 65, 85, 0.8);
        padding: 2px 6px;
        border-radius: 4px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ut-candidate-item {
        background: rgba(30, 41, 59, 0.85);
        border: 1px solid rgba(71, 85, 105, 0.55);
        border-radius: 7px;
        padding: 7px 9px;
        margin-bottom: 6px;
      }
      .ut-candidate-item:last-child { margin-bottom: 0; }
      .ut-candidate-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 4px;
      }
      .ut-kind-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10.5px;
        font-weight: 700;
        background: rgba(14, 165, 233, 0.2);
        color: #7dd3fc;
        border: 1px solid rgba(14, 165, 233, 0.4);
      }
      .ut-kind-tag.verified {
        background: rgba(16, 185, 129, 0.22);
        color: #6ee7b7;
        border-color: rgba(16, 185, 129, 0.45);
      }
      .ut-btn-row {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .ut-copy-btn {
        cursor: pointer;
        border: 1px solid rgba(56, 189, 248, 0.45);
        background: rgba(2, 132, 199, 0.25);
        color: #e0f2fe;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 5px;
        transition: all 0.12s;
      }
      .ut-copy-btn:hover {
        background: #0284c7;
        color: #fff;
      }
      .ut-copy-btn.copied {
        background: #059669 !important;
        border-color: #10b981 !important;
        color: #fff !important;
      }
      .ut-url-box {
        font-family: Consolas, Monaco, 'Courier New', monospace;
        font-size: 12.5px;
        font-weight: 700;
        color: #fde047;
        word-break: break-all;
        padding: 2px 0;
        user-select: all;
      }
      .ut-params-wrap {
        margin-top: 5px;
        padding-top: 5px;
        border-top: 1px dashed rgba(148, 163, 184, 0.2);
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .ut-param-chip {
        font-family: Consolas, Monaco, monospace;
        font-size: 11px;
        background: rgba(15, 23, 42, 0.8);
        border: 1px solid rgba(100, 116, 139, 0.4);
        border-radius: 4px;
        padding: 1px 5px;
        color: #e2e8f0;
        cursor: pointer;
      }
      .ut-param-chip:hover {
        border-color: #38bdf8;
      }
      .ut-param-key { color: #93c5fd; }
      .ut-param-val { color: #fca5a5; }
    `;

    hoverCardEl = document.createElement('div');
    hoverCardEl.className = 'ut-hover-card';
    hoverCardEl.style.display = 'none';

    hoverCardEl.addEventListener('mouseenter', () => {
      isMouseInsideTooltip = true;
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    });

    hoverCardEl.addEventListener('mouseleave', () => {
      isMouseInsideTooltip = false;
      hideHoverTooltip();
    });

    hoverShadow.appendChild(style);
    hoverShadow.appendChild(hoverCardEl);
    (document.documentElement || document.body).appendChild(hoverHost);
  }

  function showHoverTooltip(info) {
    if (!state.domainAllowed || !state.hoverEnabled || !info) return;
    ensureHoverRoot();
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }

    state.currentHoverInfo = info;
    const { element, candidates = [], rect } = info;

    let candidatesHtml = '';
    if (candidates.length > 0) {
      candidatesHtml = candidates
        .map((c, idx) => {
          const paramEntries = Object.entries(c.params || {});
          const paramsHtml =
            paramEntries.length > 0
              ? `<div class="ut-params-wrap">
                  ${paramEntries
                    .slice(0, 8)
                    .map(
                      ([k, v]) =>
                        `<span class="ut-param-chip" data-copy-param="${escapeHtml(
                          `${k}=${v}`
                        )}" title="클릭하여 ${escapeHtml(k)} 복사"><span class="ut-param-key">${escapeHtml(
                          k
                        )}</span>=<span class="ut-param-val">${escapeHtml(
                          String(v).slice(0, 35)
                        )}</span></span>`
                    )
                    .join('')}
                  ${
                    paramEntries.length > 8
                      ? `<span class="ut-param-chip">+${paramEntries.length - 8}개 더</span>`
                      : ''
                  }
                </div>`
              : '';

          return `
            <div class="ut-candidate-item">
              <div class="ut-candidate-top">
                <span class="ut-kind-tag ${c.verified ? 'verified' : ''}">${escapeHtml(
            c.kind
          )}</span>
                <div class="ut-btn-row">
                  <button class="ut-copy-btn" data-copy-url="${escapeHtml(
                    c.displayUrl
                  )}" title="URL 복사">📋 URL 복사</button>
                  ${
                    paramEntries.length > 0
                      ? `<button class="ut-copy-btn" data-copy-params-idx="${idx}" title="파라미터 JSON 복사">📦 파라미터</button>`
                      : ''
                  }
                </div>
              </div>
              <div class="ut-url-box">${escapeHtml(c.displayUrl)}</div>
              ${paramsHtml}
            </div>
          `;
        })
        .join('');
    } else {
      candidatesHtml = `
        <div class="ut-candidate-item">
          <span class="ut-kind-tag">동적 JS 버튼</span>
          <div style="color:#cbd5e1;font-size:11px;margin-top:4px;">
            한 번 클릭하면 호출 URL이 학습되어 다음 호버부터 표시됩니다.
          </div>
        </div>
      `;
    }

    hoverCardEl.innerHTML = `
      <div class="ut-hover-header">
        <div class="ut-el-badge">
          <span>🎯 ${escapeHtml(element?.text || '요소')}</span>
          <span class="ut-el-selector">${escapeHtml(element?.selector || '')}</span>
        </div>
        <span class="ut-shortcut-hint">Alt+C 복사</span>
      </div>
      ${candidatesHtml}
    `;

    hoverCardEl.querySelectorAll('[data-copy-url]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-copy-url');
        await copyToClipboard(url);
        flashButtonCopied(btn, '✅ 복사됨!');
      });
    });

    hoverCardEl.querySelectorAll('[data-copy-params-idx]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-copy-params-idx'));
        const params = candidates[idx]?.params || {};
        await copyToClipboard(JSON.stringify(params, null, 2));
        flashButtonCopied(btn, '✅ 복사됨!');
      });
    });

    hoverCardEl.querySelectorAll('[data-copy-param]').forEach((chip) => {
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = chip.getAttribute('data-copy-param');
        await copyToClipboard(text);
        const orig = chip.innerHTML;
        chip.textContent = '✅ 복사됨';
        setTimeout(() => {
          chip.innerHTML = orig;
        }, 900);
      });
    });

    hoverCardEl.style.display = 'block';

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardRect = hoverCardEl.getBoundingClientRect();

    let top = rect.bottom + 6;
    if (top + cardRect.height > vh - 10) {
      top = Math.max(8, rect.top - cardRect.height - 6);
    }
    let left = rect.left;
    if (left + cardRect.width > vw - 12) {
      left = Math.max(8, vw - cardRect.width - 12);
    }

    hoverCardEl.style.top = `${Math.round(top)}px`;
    hoverCardEl.style.left = `${Math.round(left)}px`;
  }

  function hideHoverTooltip(immediate = false) {
    if (!hoverCardEl) return;
    if (immediate) {
      hoverCardEl.style.display = 'none';
      state.currentHoverInfo = null;
      return;
    }
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (!isMouseInsideTooltip && hoverCardEl) {
        hoverCardEl.style.display = 'none';
        state.currentHoverInfo = null;
      }
    }, 240);
  }

  function flashButtonCopied(btn, label) {
    const orig = btn.textContent;
    btn.classList.add('copied');
    btn.textContent = label;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = orig;
    }, 1000);
  }

  // =========================================================================
  // 우측 하단 가로형 퀵 바 (Quick Bar) - 최상위 프레임(IS_TOP) & 허용 도메인 전용
  // =========================================================================
  let quickBarHost = null;
  let quickBarRoot = null;
  let quickBarEl = null;

  function ensureQuickBar() {
    if (!IS_TOP) return null;
    if (quickBarEl && document.documentElement.contains(quickBarHost)) {
      return quickBarEl;
    }

    quickBarHost = document.createElement('div');
    quickBarHost.id = '__url_tracker_quickbar_root__';
    quickBarHost.style.cssText =
      'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; pointer-events: none;';

    quickBarRoot = quickBarHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Malgun Gothic', sans-serif; }
      .qb-wrap {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 10px;
        width: min(1150px, calc(100vw - 32px));
        min-width: min(760px, calc(100vw - 32px));
        max-width: calc(100vw - 32px);
        padding: 9px 14px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(12px);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 12px 32px rgba(2, 6, 23, 0.55), 0 0 0 1px rgba(56, 189, 248, 0.14);
        font-size: 12px;
        line-height: 1.3;
        user-select: none;
      }
      .qb-brand {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 700;
        color: #e2e8f0;
        white-space: nowrap;
        padding-right: 8px;
        border-right: 1px solid rgba(148, 163, 184, 0.2);
      }
      .qb-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 8px #22c55e;
      }
      .qb-dot.off {
        background: #64748b;
        box-shadow: none;
      }
      .qb-preview {
        flex: 1;
        min-width: 180px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.65);
        border: 1px solid rgba(148, 163, 184, 0.16);
        cursor: pointer;
        overflow: hidden;
        transition: all 0.15s ease;
      }
      .qb-preview:hover {
        border-color: rgba(56, 189, 248, 0.45);
        background: rgba(15, 23, 42, 0.9);
      }
      .qb-preview.copied {
        border-color: rgba(34, 197, 94, 0.6);
        background: rgba(20, 83, 45, 0.35);
      }
      .qb-preview-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(56, 189, 248, 0.16);
        color: #7dd3fc;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .qb-preview-url {
        flex: 1;
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: 11.5px;
        color: #cbd5e1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .qb-preview-url.empty {
        color: #64748b;
        font-family: inherit;
      }
      .qb-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .qb-btn {
        cursor: pointer;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: rgba(30, 41, 59, 0.85);
        color: #cbd5e1;
        font-size: 11.5px;
        font-weight: 600;
        padding: 6px 10px;
        border-radius: 7px;
        white-space: nowrap;
        transition: all 0.15s ease;
      }
      .qb-btn:hover {
        background: rgba(51, 65, 85, 0.95);
        color: #ffffff;
      }
      .qb-btn.active-green {
        background: rgba(22, 163, 74, 0.22);
        border-color: rgba(34, 197, 94, 0.45);
        color: #86efac;
      }
      .qb-btn.active-amber {
        background: rgba(217, 119, 6, 0.22);
        border-color: rgba(245, 158, 11, 0.45);
        color: #fcd34d;
      }
      .qb-btn.primary {
        background: linear-gradient(135deg, rgba(37, 99, 235, 0.9), rgba(14, 165, 233, 0.85));
        border-color: rgba(56, 189, 248, 0.55);
        color: #ffffff;
        font-weight: 700;
        padding: 6px 12px;
      }
      .qb-btn.primary:hover {
        filter: brightness(1.1);
      }
    `;

    quickBarEl = document.createElement('div');
    quickBarEl.className = 'qb-wrap';
    quickBarEl.innerHTML = `
      <div class="qb-brand" title="현재 도메인에서 URL 트래커가 활성화되어 있습니다">
        <span class="qb-dot" data-role="dot"></span>
        <span>URL 트래커</span>
      </div>
      <div class="qb-preview" data-role="preview" title="클릭하면 최근 감지된 URL을 클립보드에 복사합니다">
        <span class="qb-preview-badge" data-role="badge">대기중</span>
        <span class="qb-preview-url empty" data-role="url">버튼에 마우스를 올리거나 메뉴를 클릭하면 URL이 표시됩니다</span>
      </div>
      <div class="qb-actions">
        <button type="button" class="qb-btn" data-role="hover-btn" title="마우스 호버 툴팁 표시 ON/OFF (단축키: Alt+H)">🔍 호버 ON</button>
        <button type="button" class="qb-btn" data-role="preserve-btn" title="화면 이동 시 이전 로그 유지 여부 (Preserve log)">📌 로그보관 OFF</button>
        <button type="button" class="qb-btn primary" data-role="open-btn" title="우측 사이드 패널에서 URL 트래커 열기 (단축키: Alt+Q)">🚀 트래커 열기</button>
      </div>
    `;

    const previewEl = quickBarEl.querySelector('[data-role="preview"]');
    previewEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!state.latestPreviewUrl) return;
      await copyToClipboard(state.latestPreviewUrl);
      const urlSpan = quickBarEl.querySelector('[data-role="url"]');
      const origText = urlSpan.textContent;
      previewEl.classList.add('copied');
      urlSpan.textContent = `✅ 복사완료: ${state.latestPreviewUrl}`;
      setTimeout(() => {
        previewEl.classList.remove('copied');
        urlSpan.textContent = origText;
      }, 1000);
    });

    const hoverBtn = quickBarEl.querySelector('[data-role="hover-btn"]');
    hoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !state.hoverEnabled;
      saveSettings({ hoverEnabled: next });
      if (!next) hideHoverTooltip(true);
    });

    const preserveBtn = quickBarEl.querySelector('[data-role="preserve-btn"]');
    preserveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !state.preserveLog;
      saveSettings({ preserveLog: next });
    });

    const openBtn = quickBarEl.querySelector('[data-role="open-btn"]');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'URL_TRACKER_OPEN_SIDEPANEL' }).catch(() => {});
      } catch {}
    });

    quickBarRoot.appendChild(style);
    quickBarRoot.appendChild(quickBarEl);
    (document.body || document.documentElement).appendChild(quickBarHost);
    return quickBarEl;
  }

  function updateQuickBarPreview(url, kindLabel) {
    if (!url || typeof url !== 'string') return;
    state.latestPreviewUrl = url;
    state.latestPreviewKind = kindLabel || 'URL';
    renderQuickBar();
  }

  function renderQuickBar() {
    if (!IS_TOP) return;
    if (!state.domainAllowed) {
      if (quickBarHost) {
        quickBarHost.style.display = 'none';
      }
      return;
    }

    const bar = ensureQuickBar();
    if (!bar) return;
    quickBarHost.style.display = 'block';

    const dot = bar.querySelector('[data-role="dot"]');
    const badge = bar.querySelector('[data-role="badge"]');
    const urlEl = bar.querySelector('[data-role="url"]');
    const hoverBtn = bar.querySelector('[data-role="hover-btn"]');
    const preserveBtn = bar.querySelector('[data-role="preserve-btn"]');

    if (dot) {
      dot.classList.toggle('off', !state.hoverEnabled && state.paused);
    }

    if (urlEl && badge) {
      if (state.latestPreviewUrl) {
        badge.textContent = state.latestPreviewKind || '최근 URL';
        urlEl.textContent = state.latestPreviewUrl;
        urlEl.classList.remove('empty');
      } else {
        badge.textContent = '대기중';
        urlEl.textContent = '버튼에 마우스를 올리거나 메뉴를 클릭하면 URL이 표시됩니다';
        urlEl.classList.add('empty');
      }
    }

    if (hoverBtn) {
      hoverBtn.textContent = state.hoverEnabled ? '🔍 호버 ON' : '🚫 호버 OFF';
      hoverBtn.classList.toggle('active-green', !!state.hoverEnabled);
    }

    if (preserveBtn) {
      preserveBtn.textContent = state.preserveLog ? '📌 로그보관 ON' : '📌 로그보관 OFF';
      preserveBtn.classList.toggle('active-amber', !!state.preserveLog);
    }
  }

  // 단축키: 허용된 도메인에서만 동작
  window.addEventListener(
    'keydown',
    async (e) => {
      if (!state.domainAllowed) return;
      if (e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
        const firstCandidate = state.currentHoverInfo?.candidates?.[0];
        if (firstCandidate?.displayUrl) {
          e.preventDefault();
          e.stopPropagation();
          await copyToClipboard(firstCandidate.displayUrl);
          if (hoverCardEl && hoverCardEl.style.display !== 'none') {
            const firstBtn = hoverCardEl.querySelector('[data-copy-url]');
            if (firstBtn) flashButtonCopied(firstBtn, '✅ 복사완료!');
          }
        }
      } else if (e.altKey && (e.key === 'h' || e.key === 'H' || e.code === 'KeyH')) {
        e.preventDefault();
        saveSettings({ hoverEnabled: !state.hoverEnabled });
        if (!state.hoverEnabled) hideHoverTooltip(true);
      } else if (e.altKey && (e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ')) {
        e.preventDefault();
        try {
          chrome.runtime.sendMessage({ type: 'URL_TRACKER_OPEN_SIDEPANEL' }).catch(() => {});
        } catch {}
      }
    },
    true
  );

  // page-hook.js 메시지 수신 및 사이드 패널(background.js) 전달
  window.addEventListener('message', (event) => {
    if (!state.domainAllowed) return;
    const data = event.data;
    if (!data || data.source !== 'URL_TRACKER_PAGE_HOOK') return;

    if (data.type === 'HOVER_RESULT') {
      showHoverTooltip(data.payload);
      const firstUrl = data.payload?.candidates?.[0]?.displayUrl;
      if (firstUrl) {
        updateQuickBarPreview(firstUrl, '호버');
      }
      try {
        chrome.runtime.sendMessage({
          type: 'URL_TRACKER_HOVER',
          payload: data.payload
        }).catch(() => {});
      } catch {}
      return;
    }

    if (data.type === 'HOVER_CLEAR') {
      hideHoverTooltip(false);
      return;
    }

    if (data.type === 'TRACKER_EVENT') {
      if (state.paused) return;
      if (data.payload?.displayUrl) {
        updateQuickBarPreview(
          data.payload.displayUrl,
          data.payload.badge || data.payload.method || '호출'
        );
      }
      try {
        chrome.runtime.sendMessage({
          type: 'URL_TRACKER_EVENT',
          payload: data.payload
        }).catch(() => {});
      } catch {}
      return;
    }

    if (data.type === 'TRACKER_EVENT_UPDATE') {
      try {
        chrome.runtime.sendMessage({
          type: 'URL_TRACKER_EVENT_UPDATE',
          payload: data.payload
        }).catch(() => {});
      } catch {}
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'URL_TRACKER_TOGGLE_HOVER') {
      if (!state.domainAllowed) return;
      saveSettings({ hoverEnabled: !state.hoverEnabled });
      if (!state.hoverEnabled) hideHoverTooltip(true);
    } else if (msg?.type === 'URL_TRACKER_QUICKBAR_UPDATE') {
      if (msg.url) {
        updateQuickBarPreview(msg.url, msg.badge || '최근 URL');
      }
    } else if (msg?.type === 'URL_TRACKER_SETTINGS_UPDATED' && msg.settings) {
      if (Array.isArray(msg.settings.allowedDomains)) {
        state.allowedDomains = msg.settings.allowedDomains;
        syncDomainStateToPageHook();
      }
      if (typeof msg.settings.hoverEnabled === 'boolean') {
        state.hoverEnabled = msg.settings.hoverEnabled;
        if (!state.hoverEnabled) hideHoverTooltip(true);
      }
      if (typeof msg.settings.paused === 'boolean') {
        state.paused = msg.settings.paused;
      }
      if (typeof msg.settings.preserveLog === 'boolean') {
        state.preserveLog = msg.settings.preserveLog;
      }
      renderQuickBar();
    }
  });
})();
