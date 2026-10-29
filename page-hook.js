// page-hook.js (MAIN World)
// 웹 애플리케이션(JSP, jQuery, DataTables, jqGrid, iframe, 일반 MPA/SPA)의 모든 네트워크 호출·페이지 이동 인터셉트
// 및 버튼/링크 마우스 오버(Hover) 시 정적/동적 URL·파라미터 프리뷰 분석 엔진

(function () {
  if (window.__URL_TRACKER_HOOKED__) return;
  window.__URL_TRACKER_HOOKED__ = true;

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
  let isDomainAllowed = checkDomainMatch(window.location.hostname, DEFAULT_ALLOWED_DOMAINS);

  const IS_TOP = window === window.top;
  const IS_POPUP_WINDOW = (() => {
    try {
      return Boolean(window.top && window.top.opener);
    } catch {
      return Boolean(window.opener);
    }
  })();
  const FRAME_NAME = (() => {
    try {
      if (IS_TOP) return IS_POPUP_WINDOW ? `POPUP (${window.name || '팝업창'})` : 'MAIN (최상위 창)';
      return window.frameElement?.id
        ? `iframe#${window.frameElement.id}`
        : window.name
        ? `iframe[${window.name}]`
        : 'iframe';
    } catch {
      return window.name ? `iframe[${window.name}]` : 'iframe';
    }
  })();

  // ---------------------------------------------------------------------------
  // 1. 상태 저장소: 네이티브 이벤트 리스너, 최근 클릭 컨텍스트, 학습된 요소별 실측 URL
  // ---------------------------------------------------------------------------
  const nativeListeners = new WeakMap(); // Element -> Array<{ type, listener }>
  const learnedElementUrls = new Map(); // selectorKey -> Array<{ url, method, kind, params, timestamp }>
  const CLICK_LEARN_WINDOW_MS = 5000; // 클릭 후 이 시간 안에 발생한 호출을 클릭 요소의 실측 URL로 학습 (확인창·느린 응답 대비)
  // 같은 종류 요소(같은 핸들러·같은 목록)끼리 공유하는 실측 URL 패턴
  // 예: /popup/employee/NX/23456 을 클릭 실측 → /popup/employee/NX/{attr:data-empno} 로 저장 → 다른 행 호버 시 그 행 값으로 채움
  const learnedUrlPatterns = new Map(); // patternGroupKey -> Array<{ template, kind, method }>
  const MAX_PATTERNS_PER_GROUP = 3;
  let lastClickContext = null;
  let lastHoveredEl = null;
  let scriptFunctionCache = null;
  let lastScriptCount = 0;

  // Element.prototype.addEventListener 후킹 (window의 unload 등 비-Element 이벤트는 건드리지 않아 Permissions policy 경고 방지)
  const origAddEventListener = EventTarget.prototype.addEventListener;
  const origElementAddEventListener =
    (typeof Element !== 'undefined' && Element.prototype.addEventListener) || origAddEventListener;

  // content.js로부터 허용 도메인 여부 실시간 동기화 수신 (CustomEvent 사용으로 기존 페이지의 window.onmessage 리스너 간섭 원천 차단)
  origAddEventListener.call(
    window,
    '__url_tracker_set_domain__',
    (e) => {
      try {
        const data = typeof e?.detail === 'string' ? JSON.parse(e.detail) : e?.detail;
        if (data && typeof data.allowed === 'boolean') {
          isDomainAllowed = data.allowed;
        }
      } catch {}
    },
    true
  );

  if (typeof Element !== 'undefined' && Element.prototype) {
    Element.prototype.addEventListener = function (type, listener, options) {
      try {
        if (
          this instanceof Element &&
          (type === 'click' || type === 'dblclick' || type === 'submit') &&
          typeof listener === 'function'
        ) {
          let list = nativeListeners.get(this);
          if (!list) {
            list = [];
            nativeListeners.set(this, list);
          }
          if (!list.some((item) => item.listener === listener && item.type === type)) {
            list.push({ type, listener });
          }
        }
      } catch {}
      return origElementAddEventListener.call(this, type, listener, options);
    };
  }

  // ---------------------------------------------------------------------------
  // 2. 유틸리티: URL 정규화, 쿼리/바디 파라미터 파싱, 호출 스택(JSP/JS 줄번호) 추출
  // ---------------------------------------------------------------------------
  function toFullUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) return trimmed;
    try {
      return new URL(trimmed, window.location.href).href;
    } catch {
      return trimmed;
    }
  }

  function toDisplayPath(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith('/')) return trimmed;
    try {
      const u = new URL(trimmed, window.location.href);
      if (u.origin === window.location.origin) {
        return u.pathname + u.search + u.hash;
      }
      return u.href;
    } catch {
      return trimmed;
    }
  }

  function parseQueryParams(urlStr) {
    const params = {};
    if (!urlStr || typeof urlStr !== 'string') return params;
    try {
      const qIdx = urlStr.indexOf('?');
      if (qIdx === -1) return params;
      const queryPart = urlStr.slice(qIdx + 1).split('#')[0];
      const sp = new URLSearchParams(queryPart);
      for (const [k, v] of sp.entries()) {
        if (k in params) {
          params[k] = Array.isArray(params[k]) ? [...params[k], v] : [params[k], v];
        } else {
          params[k] = v;
        }
      }
    } catch {}
    return params;
  }

  function parseBodyParams(body) {
    if (!body) return {};
    try {
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            return JSON.parse(trimmed);
          } catch {}
        }
        const sp = new URLSearchParams(trimmed);
        const obj = {};
        let hasKey = false;
        for (const [k, v] of sp.entries()) {
          hasKey = true;
          obj[k] = v;
        }
        return hasKey ? obj : { _raw: trimmed.slice(0, 500) };
      }
      if (body instanceof URLSearchParams) {
        const obj = {};
        for (const [k, v] of body.entries()) obj[k] = v;
        return obj;
      }
      if (body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body.entries()) {
          obj[k] = v instanceof File ? `[File: ${v.name} (${v.size}B)]` : v;
        }
        return obj;
      }
      if (typeof body === 'object') {
        return JSON.parse(JSON.stringify(body));
      }
    } catch {}
    return {};
  }

  function extractFormParams(form) {
    const params = {};
    if (!form || !(form instanceof HTMLFormElement)) return params;
    try {
      const fd = new FormData(form);
      for (const [k, v] of fd.entries()) {
        params[k] = v instanceof File ? `[File: ${v.name}]` : v;
      }
      // disabled나 name 없는 주요 id 필드도 보완
      const inputs = form.querySelectorAll('input[name], select[name], textarea[name]');
      inputs.forEach((inp) => {
        const name = inp.getAttribute('name');
        if (name && !(name in params)) {
          params[name] = inp.value ?? '';
        }
      });
    } catch {}
    return params;
  }

  function getCallerSource() {
    try {
      const stack = new Error().stack || '';
      const lines = stack.split('\n').slice(1);
      for (const line of lines) {
        if (
          line.includes('page-hook.js') ||
          line.includes('content.js') ||
          line.includes('jquery') ||
          line.includes('chrome-extension://')
        ) {
          continue;
        }
        const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
        if (match) {
          const u = new URL(match[1]);
          return `${u.pathname}:${match[2]}`;
        }
      }
    } catch {}
    return '';
  }

  function getElementDescriptor(el) {
    if (!el || !(el instanceof Element)) return null;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? '.' +
          el.className
            .trim()
            .split(/\s+/)
            .filter((c) => !c.startsWith('url-tracker-'))
            .slice(0, 2)
            .join('.')
        : '';
    let selector = `${tag}${id}${cls}`;
    const tableRowInfo = getDataTableRowContext(el);
    if (tableRowInfo) {
      const tblId = tableRowInfo.table.id ? `#${tableRowInfo.table.id}` : '.dataTable';
      const rowNum =
        typeof tableRowInfo.tr.sectionRowIndex === 'number'
          ? tableRowInfo.tr.sectionRowIndex + 1
          : '';
      selector = `${tag} (DataTables ${tblId}${rowNum ? ` ${rowNum}행` : ''})`;
    }

    let text = '';
    if (tag === 'input' || tag === 'button') {
      text = el.innerText || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || '';
    } else {
      text = el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text && el.querySelector('img')) {
      text = el.querySelector('img').getAttribute('alt') || el.querySelector('img').getAttribute('title') || '이미지 버튼';
    }
    if (text.length > 45) text = text.slice(0, 45) + '…';

    // 학습 캐시 키에는 클래스를 넣지 않는다: 클릭 후 on/active 같은 상태 클래스가 바뀌면 같은 요소를 다른 요소로 인식하기 때문
    const keySelector = tableRowInfo ? selector : `${tag}${id}`;
    const uniqueKey = `${window.location.pathname}::${keySelector}::${text.slice(0, 30)}`;
    return {
      tag,
      id: el.id || '',
      selector,
      text: text || selector,
      onclick: el.getAttribute('onclick') || '',
      uniqueKey
    };
  }

  // DataTables 테이블/행/셀 컨텍스트 판별
  function isDataTableElement(table) {
    if (!table || table.tagName !== 'TABLE') return false;
    if (table.classList.contains('dataTable')) return true;
    if (table.closest('.dataTables_wrapper')) return true;
    try {
      const jq = window.jQuery || window.$;
      if (jq?.fn?.dataTable?.isDataTable?.(table)) return true;
    } catch {}
    return false;
  }

  function getDataTableRowContext(target) {
    if (!target || !(target instanceof Element)) return null;
    const tr = target.tagName === 'TR' ? target : target.closest('tbody tr');
    if (!tr) return null;
    const tbody = tr.parentElement;
    if (!tbody || tbody.tagName !== 'TBODY') return null;
    const table = tbody.closest('table');
    if (!isDataTableElement(table)) return null;
    if (
      tr.classList.contains('dataTables_empty') ||
      tr.querySelector('td.dataTables_empty')
    ) {
      return null;
    }
    const td = target.tagName === 'TD' ? target : target.closest('td');
    return { table, tbody, tr, td };
  }

  function getDataTableApi(table) {
    try {
      const jq = window.jQuery || window.$;
      if (!jq || !table) return null;
      if (typeof jq(table).DataTable === 'function') {
        return jq(table).DataTable();
      }
      if (typeof jq(table).dataTable === 'function') {
        return jq(table).dataTable().api?.() || null;
      }
    } catch {}
    return null;
  }

  function getAllDataTableApis() {
    const apis = [];
    try {
      const jq = window.jQuery || window.$;
      if (jq?.fn?.dataTable?.tables) {
        const list = jq.fn.dataTable.tables({ api: true });
        if (list && typeof list.toArray === 'function') {
          list.toArray().forEach(( idxOrApi ) => {
            if (idxOrApi && typeof idxOrApi.row === 'function') apis.push(idxOrApi);
          });
        }
      }
      if (apis.length === 0 && jq) {
        document.querySelectorAll('table.dataTable').forEach((tbl) => {
          const api = getDataTableApi(tbl);
          if (api) apis.push(api);
        });
      }
    } catch {}
    return apis;
  }

  function findActionableElement(target) {
    if (!target || !(target instanceof Element)) return null;
    if (target.closest('#__url_tracker_root__, #__url_tracker_hover_root__')) return null;

    // 1) 링크, 버튼, 인라인 onclick, DataTables 버튼(.dt-button) 등 명시적 컨트롤 우선
    const actionable = target.closest(
      'a, button, input[type="button"], input[type="submit"], input[type="reset"], [onclick], [role="button"], .dt-button, .btn, li > a'
    );
    if (actionable) return actionable;

    // 2) jqGrid 행
    const jqRow = target.closest('tr.jqgrow');
    if (jqRow) return jqRow;

    // 3) DataTables 목록 행 (tbody tr)
    const dtCtx = getDataTableRowContext(target);
    if (dtCtx) {
      return dtCtx.tr;
    }

    // 4) jQuery(직접/위임)나 네이티브 클릭 이벤트가 걸려있는 상위 요소 탐색 (최대 5단계)
    let cur = target;
    let depth = 0;
    while (cur && cur !== document.body && depth < 5) {
      if (hasDirectClickListener(cur) || hasDelegatedClickListener(cur)) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function hasDirectClickListener(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.hasAttribute('onclick')) return true;
    if (nativeListeners.has(el)) return true;
    try {
      const jq = window.jQuery || window.$;
      if (jq) {
        const ev = jq._data ? jq._data(el, 'events') : jq(el).data?.('events');
        if (ev && (ev.click || ev.dblclick)) {
          if (
            (Array.isArray(ev.click) && ev.click.some((h) => !h.selector)) ||
            (Array.isArray(ev.dblclick) && ev.dblclick.some((h) => !h.selector))
          ) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  }

  function hasDelegatedClickListener(el) {
    if (!el || !(el instanceof Element)) return false;
    try {
      const jq = window.jQuery || window.$;
      if (!jq) return false;
      const getEv = (node) => (jq._data ? jq._data(node, 'events') : jq(node).data?.('events'));
      let ancestor = el.parentElement;
      while (ancestor) {
        const ev = getEv(ancestor);
        if (ev) {
          for (const type of ['click', 'dblclick']) {
            if (Array.isArray(ev[type])) {
              for (const h of ev[type]) {
                if (h.selector && el.matches(h.selector)) return true;
              }
            }
          }
        }
        ancestor = ancestor.parentElement;
      }
      const docEv = getEv(document);
      if (docEv) {
        for (const type of ['click', 'dblclick']) {
          if (Array.isArray(docEv[type])) {
            for (const h of docEv[type]) {
              if (h.selector && el.matches(h.selector)) return true;
            }
          }
        }
      }
    } catch {}
    return false;
  }

  // ---------------------------------------------------------------------------
  // 3. 이벤트 브로드캐스트 (page-hook.js -> content.js, CustomEvent + JSON 문자열 사용으로 MAIN ↔ ISOLATED 월드 간 안전한 전달 및 페이지 window.onmessage 무간섭)
  // ---------------------------------------------------------------------------
  function dispatchToContent(type, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent('__url_tracker_from_page__', {
          detail: JSON.stringify({ type, payload })
        })
      );
    } catch {}
  }

  function emitTrackerEvent(payload) {
    if (!isDomainAllowed) return null;
    try {
      const activeClick =
        lastClickContext && Date.now() - lastClickContext.timestamp < CLICK_LEARN_WINDOW_MS
          ? lastClickContext
          : null;

      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        timeStr: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
        frameName: FRAME_NAME,
        isPopupWindow: IS_POPUP_WINDOW,
        pageUrl: window.location.pathname + window.location.search,
        caller: getCallerSource(),
        clickContext: activeClick
          ? {
              text: activeClick.text,
              selector: activeClick.selector,
              onclick: activeClick.onclick
            }
          : null,
        ...payload
      };

      // 클릭한 요소와 실측 호출 URL을 학습 캐시에 저장 (이후 마우스 오버 시 즉시 표시)
      if (activeClick?.uniqueKey && entry.displayUrl) {
        const list = learnedElementUrls.get(activeClick.uniqueKey) || [];
        const existingIdx = list.findIndex(
          (x) => x.displayUrl === entry.displayUrl && x.kind === entry.kind
        );
        const item = {
          displayUrl: entry.displayUrl,
          fullUrl: entry.fullUrl,
          method: entry.method || 'GET',
          kind: entry.kind,
          params: { ...(entry.queryParams || {}), ...(entry.bodyParams || {}) },
          timestamp: Date.now()
        };
        if (existingIdx >= 0) {
          list[existingIdx] = item;
        } else {
          list.unshift(item);
        }
        learnedElementUrls.set(activeClick.uniqueKey, list.slice(0, 5));
      }

      // 클릭 요소의 값(속성·행 데이터·onclick 인자 등)이 URL에 들어있으면 같은 종류 요소용 패턴으로 저장
      // (부가 기능이므로 실패해도 아래 이벤트 전달은 계속되도록 별도 try)
      try {
        if (activeClick?.patternGroupKey && entry.displayUrl) {
          const template = buildUrlTemplate(entry.displayUrl, activeClick.elementValues);
          if (template) {
            const patterns = (learnedUrlPatterns.get(activeClick.patternGroupKey) || []).filter(
              (p) => p.template !== template
            );
            patterns.unshift({ template, kind: entry.kind, method: entry.method || 'GET' });
            learnedUrlPatterns.set(activeClick.patternGroupKey, patterns.slice(0, MAX_PATTERNS_PER_GROUP));
          }
        }
      } catch {}

      dispatchToContent('TRACKER_EVENT', entry);

      // 커서가 아직 클릭한 요소 위에 있으면 방금 학습한 URL로 호버 결과를 즉시 다시 보냄 (벗어났다 돌아오지 않아도 이력에 반영)
      if (activeClick?.uniqueKey && entry.displayUrl && lastHoveredEl) {
        const hoverDesc = getElementDescriptor(lastHoveredEl);
        if (hoverDesc?.uniqueKey === activeClick.uniqueKey) {
          const info = inspectElementOnHover(lastHoveredEl);
          if (info) dispatchToContent('HOVER_RESULT', { ...info, isRefresh: true });
        }
      }
      return entry.id;
    } catch {
      return null;
    }
  }

  function emitTrackerUpdate(id, updates) {
    if (!isDomainAllowed || !id) return;
    dispatchToContent('TRACKER_EVENT_UPDATE', { id, ...updates });
  }

  // ---------------------------------------------------------------------------
  // 4. 클릭 캡처 & 각종 네비게이션/Ajax 인터셉터
  // ---------------------------------------------------------------------------
  origAddEventListener.call(
    window,
    'mousedown',
    (e) => {
      if (!isDomainAllowed) return;
      const el = findActionableElement(e.target);
      if (el) {
        const desc = getElementDescriptor(el);
        if (desc) {
          lastClickContext = buildClickContext(el, desc);
        }
      }
    },
    true
  );

  origAddEventListener.call(
    window,
    'click',
    (e) => {
      if (!isDomainAllowed) return;
      const el = findActionableElement(e.target);
      if (!el) return;
      const desc = getElementDescriptor(el);
      if (desc) {
        lastClickContext = buildClickContext(el, desc);
      }

      // 일반 <a href="..."> 링크 클릭 감지
      const anchor = el.tagName === 'A' ? el : el.closest('a');
      if (anchor) {
        const rawHref = anchor.getAttribute('href') || '';
        if (
          rawHref &&
          rawHref !== '#' &&
          !rawHref.startsWith('#') &&
          !/^javascript:/i.test(rawHref)
        ) {
          const targetAttr = anchor.getAttribute('target') || '_self';
          const isNamedTarget =
            Boolean(targetAttr) && !['_self', '_blank', '_top', '_parent'].includes(targetAttr);
          const isIframeTarget =
            (isNamedTarget && isExistingIframeTarget(targetAttr)) ||
            (!IS_TOP && (targetAttr === '_self' || !targetAttr));
          const isPopupTarget =
            targetAttr === '_blank' || (isNamedTarget && !isExistingIframeTarget(targetAttr));

          emitTrackerEvent({
            kind: isPopupTarget ? 'POPUP' : isIframeTarget ? 'IFRAME_NAV' : 'PAGE_MOVE',
            badge: isPopupTarget
              ? `팝업 링크 (${targetAttr})`
              : isIframeTarget
              ? `IFRAME 링크 (${targetAttr !== '_self' ? targetAttr : FRAME_NAME})`
              : '링크 이동',
            method: 'GET',
            displayUrl: toDisplayPath(rawHref),
            fullUrl: toFullUrl(rawHref),
            queryParams: parseQueryParams(rawHref),
            bodyParams: {},
            targetWindow: targetAttr
          });
        }
      }
    },
    true
  );

  // 4-1. XMLHttpRequest 후킹 ($.ajax, jqGrid, .load 등 모두 포함)
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url, ...rest) {
      if (isDomainAllowed) {
        try {
          Object.defineProperty(this, '__ut_method', {
            value: (method || 'GET').toUpperCase(),
            configurable: true,
            writable: true
          });
          Object.defineProperty(this, '__ut_url', {
            value: typeof url === 'string' ? url : String(url || ''),
            configurable: true,
            writable: true
          });
        } catch {}
      }
      return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.send = function (body) {
      if (!isDomainAllowed) {
        return origSend.call(this, body);
      }
      try {
        const rawUrl = this.__ut_url || '';
        if (rawUrl && !rawUrl.startsWith('chrome-extension://')) {
          const method = this.__ut_method || 'GET';
          const queryParams = parseQueryParams(rawUrl);
          const bodyParams = parseBodyParams(body);
          const startTime = performance.now();

          const entryId = emitTrackerEvent({
            kind: 'AJAX',
            badge: `AJAX (${method})`,
            method,
            displayUrl: toDisplayPath(rawUrl),
            fullUrl: toFullUrl(rawUrl),
            queryParams,
            bodyParams,
            status: '진행중…'
          });

          if (entryId) {
            origAddEventListener.call(this, 'loadend', () => {
              const duration = Math.round(performance.now() - startTime);
              emitTrackerUpdate(entryId, {
                status: `${this.status || 0} (${duration}ms)`,
                statusCode: this.status || 0,
                duration
              });
            });
          }
        }
      } catch {}
      return origSend.call(this, body);
    };
  }

  // 4-2. window.fetch 후킹
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (!isDomainAllowed) {
        return origFetch.apply(this, arguments);
      }
      let entryId = null;
      const startTime = performance.now();
      try {
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.href
            : input?.url || '';
        const method = (init?.method || input?.method || 'GET').toUpperCase();
        if (rawUrl && !rawUrl.startsWith('chrome-extension://')) {
          entryId = emitTrackerEvent({
            kind: 'AJAX',
            badge: `FETCH (${method})`,
            method,
            displayUrl: toDisplayPath(rawUrl),
            fullUrl: toFullUrl(rawUrl),
            queryParams: parseQueryParams(rawUrl),
            bodyParams: parseBodyParams(init?.body),
            status: '진행중…'
          });
        }
      } catch {}

      return origFetch.apply(this, arguments).then(
        (res) => {
          if (entryId) {
            const duration = Math.round(performance.now() - startTime);
            emitTrackerUpdate(entryId, {
              status: `${res.status} (${duration}ms)`,
              statusCode: res.status,
              duration
            });
          }
          return res;
        },
        (err) => {
          if (entryId) {
            emitTrackerUpdate(entryId, {
              status: '실패 (Error)',
              statusCode: 0
            });
          }
          throw err;
        }
      );
    };
  }

  // target 속성이 페이지 내 실제 존재하는 iframe(또는 frame)인지 판별 (존재하지 않으면 window.open 팝업창 타겟)
  function isExistingIframeTarget(targetAttr) {
    if (!targetAttr || typeof targetAttr !== 'string') return false;
    const t = targetAttr.trim();
    if (!t || ['_self', '_blank', '_top', '_parent'].includes(t)) return false;
    try {
      const escaped =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(t)
          : t.replace(/["\\]/g, '\\$&');
      const sel = `iframe[name="${escaped}"], iframe#${escaped}, frame[name="${escaped}"], frame#${escaped}`;
      if (document.querySelector(sel)) return true;
      if (window.top && window.top !== window && window.top.document?.querySelector(sel)) {
        return true;
      }
    } catch {}
    return false;
  }

  // 4-3. window.open 후킹 (jsPopup, jsPopupScroll, 파일업로드 팝업 등)
  if (typeof window.open === 'function') {
    const origWindowOpen = window.open;
    window.open = function (url, target, features) {
      if (isDomainAllowed) {
        try {
          const rawUrl = typeof url === 'string' ? url.trim() : String(url || '').trim();
          if (rawUrl && rawUrl !== 'about:blank' && !rawUrl.startsWith('javascript:')) {
            emitTrackerEvent({
              kind: 'POPUP',
              badge: `팝업 오픈 (${target || '_blank'})`,
              method: 'GET',
              displayUrl: toDisplayPath(rawUrl),
              fullUrl: toFullUrl(rawUrl),
              queryParams: parseQueryParams(rawUrl),
              bodyParams: features ? { _windowFeatures: features } : {},
              targetWindow: target || '_blank'
            });
          }
        } catch {}
      }
      return origWindowOpen.apply(this, arguments);
    };
  }

  // 새로 열린 팝업창(window.opener가 존재하는 최상위 창)인 경우 초기 오픈 URL도 보완 전송
  if (IS_TOP && window.opener && window.location.href && !window.location.href.startsWith('about:')) {
    setTimeout(() => {
      if (!isDomainAllowed) return;
      emitTrackerEvent({
        kind: 'POPUP',
        badge: `팝업창 로드 (${window.name || 'popup'})`,
        method: 'GET',
        displayUrl: window.location.pathname + window.location.search + window.location.hash,
        fullUrl: window.location.href,
        queryParams: parseQueryParams(window.location.href),
        bodyParams: {},
        isPopupInitialLoad: true
      });
    }, 30);
  }

  // 4-4. Form Submit 후킹 (프로그래매틱 form.submit() 및 submit 이벤트)
  if (typeof HTMLFormElement !== 'undefined') {
    const origFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      if (isDomainAllowed) {
        try {
          const rawAction = this.getAttribute('action') || window.location.pathname;
          const method = (this.getAttribute('method') || 'GET').toUpperCase();
          const target = this.getAttribute('target') || '_self';
          const isNamedTarget =
            Boolean(target) && !['_self', '_blank', '_top', '_parent'].includes(target);
          const isIframeTarget =
            (isNamedTarget && isExistingIframeTarget(target)) ||
            (!IS_TOP && (target === '_self' || !target));
          const isPopupTarget =
            target === '_blank' || (isNamedTarget && !isExistingIframeTarget(target));
          const formParams = extractFormParams(this);
          Object.defineProperty(this, '__ut_submitted', {
            value: Date.now(),
            configurable: true,
            writable: true
          });
          emitTrackerEvent({
            kind: isPopupTarget ? 'POPUP' : isIframeTarget ? 'IFRAME_NAV' : 'FORM_SUBMIT',
            badge: isPopupTarget
              ? `팝업 폼 전송 (${method} → ${target})`
              : isIframeTarget
              ? `IFRAME 폼 (${method} → ${target !== '_self' ? target : FRAME_NAME})`
              : `폼 전송 (${method}${target !== '_self' ? ' → ' + target : ''})`,
            method,
            displayUrl: toDisplayPath(rawAction),
            fullUrl: toFullUrl(rawAction),
            queryParams: parseQueryParams(rawAction),
            bodyParams: formParams,
            targetWindow: target
          });
        } catch {}
      }
      return origFormSubmit.apply(this, arguments);
    };

    origAddEventListener.call(
      window,
      'submit',
      (e) => {
        if (!isDomainAllowed) return;
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.__ut_submitted && Date.now() - form.__ut_submitted < 500) return;
        try {
          const rawAction = form.getAttribute('action') || window.location.pathname;
          const method = (form.getAttribute('method') || 'GET').toUpperCase();
          const target = form.getAttribute('target') || '_self';
          const isNamedTarget =
            Boolean(target) && !['_self', '_blank', '_top', '_parent'].includes(target);
          const isIframeTarget =
            (isNamedTarget && isExistingIframeTarget(target)) ||
            (!IS_TOP && (target === '_self' || !target));
          const isPopupTarget =
            target === '_blank' || (isNamedTarget && !isExistingIframeTarget(target));
          emitTrackerEvent({
            kind: isPopupTarget ? 'POPUP' : isIframeTarget ? 'IFRAME_NAV' : 'FORM_SUBMIT',
            badge: isPopupTarget
              ? `팝업 폼 전송 (${method} → ${target})`
              : isIframeTarget
              ? `IFRAME 폼 (${method} → ${target !== '_self' ? target : FRAME_NAME})`
              : `폼 전송 (${method})`,
            method,
            displayUrl: toDisplayPath(rawAction),
            fullUrl: toFullUrl(rawAction),
            queryParams: parseQueryParams(rawAction),
            bodyParams: extractFormParams(form),
            targetWindow: target
          });
        } catch {}
      },
      true
    );
  }

  // 4-5. iframe 화면 전환 감지 ($("#content_iframe").attr("src", ...) 및 iframe.src = ...)
  if (typeof HTMLIFrameElement !== 'undefined') {
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        ...srcDesc,
        set(val) {
          if (isDomainAllowed) {
            try {
              recordIframeNavigation(this, val);
            } catch {}
          }
          return srcDesc.set.call(this, val);
        }
      });
    }

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (isDomainAllowed) {
        try {
          if (this.tagName === 'IFRAME' && String(name).toLowerCase() === 'src') {
            recordIframeNavigation(this, value);
          }
        } catch {}
      }
      return origSetAttribute.call(this, name, value);
    };
  }

  function recordIframeNavigation(iframeEl, rawUrl) {
    if (!isDomainAllowed) return;
    if (!rawUrl || typeof rawUrl !== 'string') return;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed === 'about:blank' || trimmed.startsWith('javascript:')) return;
    if (iframeEl.__ut_last_src === trimmed && Date.now() - (iframeEl.__ut_last_ts || 0) < 300) {
      return;
    }
    try {
      Object.defineProperty(iframeEl, '__ut_last_src', {
        value: trimmed,
        configurable: true,
        writable: true
      });
      Object.defineProperty(iframeEl, '__ut_last_ts', {
        value: Date.now(),
        configurable: true,
        writable: true
      });
    } catch {}

    const iframeLabel = iframeEl.id
      ? `#${iframeEl.id}`
      : iframeEl.name
      ? `[name="${iframeEl.name}"]`
      : 'iframe';

    emitTrackerEvent({
      kind: 'IFRAME_NAV',
      badge: `IFRAME 전환 (${iframeLabel})`,
      method: 'GET',
      displayUrl: toDisplayPath(trimmed),
      fullUrl: toFullUrl(trimmed),
      queryParams: parseQueryParams(trimmed),
      bodyParams: {}
    });
  }

  // 4-6. Chrome Navigation API (location.href = ..., window.location = ..., history.pushState 등 모두 감지)
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', (event) => {
      if (!isDomainAllowed) return;
      try {
        const destUrl = event.destination?.url || '';
        if (!destUrl || destUrl.startsWith('javascript:') || destUrl === window.location.href) {
          return;
        }
        // 이미 form submit으로 기록된 경우 중복 방지
        if (event.formData) return;

        emitTrackerEvent({
          kind: IS_TOP ? 'PAGE_MOVE' : 'IFRAME_NAV',
          badge: IS_TOP ? `페이지 이동 (${event.navigationType || 'move'})` : `프레임 이동 (${FRAME_NAME})`,
          method: 'GET',
          displayUrl: toDisplayPath(destUrl),
          fullUrl: destUrl,
          queryParams: parseQueryParams(destUrl),
          bodyParams: {}
        });
      } catch {}
    });
  }

  // ---------------------------------------------------------------------------
  // 5. 마우스 오버(Hover) 스마트 URL & 파라미터 정적/동적 분석 엔진
  // ---------------------------------------------------------------------------

  // 페이지 내 <script> 태그에서 로컬/전역 함수 정의 본문을 인덱싱
  function getScriptFunctionMap() {
    const scripts = document.scripts;
    if (scriptFunctionCache && scripts.length === lastScriptCount) {
      return scriptFunctionCache;
    }
    lastScriptCount = scripts.length;
    const fnMap = new Map();

    try {
      for (const s of scripts) {
        const code = s.textContent || '';
        if (!code || code.length > 300000) continue;

        // 패턴 1: function fnName(args) { ... }
        const declRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{/g;
        let m;
        while ((m = declRegex.exec(code)) !== null) {
          const fnName = m[1];
          const args = m[2];
          const body = extractBalancedBlock(code, m.index + m[0].length - 1);
          if (body) fnMap.set(fnName, { args, body, raw: `function ${fnName}(${args}) ${body}` });
        }

        // 패턴 2: var/let/const fnName = function(args) { ... } 또는 $.fnName = function(args) { ... }
        const exprRegex = /(?:(?:var|let|const)\s+|\$\.|[a-zA-Z0-9_$]+\.)([a-zA-Z0-9_$]+)\s*=\s*function\s*\(([^)]*)\)\s*\{/g;
        while ((m = exprRegex.exec(code)) !== null) {
          const fnName = m[1];
          const args = m[2];
          const body = extractBalancedBlock(code, m.index + m[0].length - 1);
          if (body) fnMap.set(fnName, { args, body, raw: `function(${args}) ${body}` });
        }

        // 패턴 3: 객체 리터럴 메서드 fnName: function(args) { ... }
        const propFnRegex = /([a-zA-Z0-9_$]+)\s*:\s*function\s*\(([^)]*)\)\s*\{/g;
        while ((m = propFnRegex.exec(code)) !== null) {
          const fnName = m[1];
          const args = m[2];
          if (['success', 'error', 'complete', 'beforeSend', 'render', 'action'].includes(fnName)) continue;
          const body = extractBalancedBlock(code, m.index + m[0].length - 1);
          if (body && !fnMap.has(fnName)) {
            fnMap.set(fnName, { args, body, raw: `function(${args}) ${body}` });
          }
        }
      }
    } catch {}

    scriptFunctionCache = fnMap;
    return fnMap;
  }

  // 핸들러 코드 내 DataTables rowData(data.docNo, data.apprNo 등) 치환 및 문자열 연결("a" + "b") 병합
  function normalizeAndInterpolateCode(rawCode, rowData = null) {
    if (!rawCode || typeof rawCode !== 'string') return '';
    let code = rawCode;

    try {
      // 1) 핸들러 내 row().data() 결과를 담는 변수명 파악 (기본: data, row, rowData, item, d)
      const rowVarNames = new Set(['data', 'row', 'rowData', 'item', 'd', 'record']);
      const rowVarRe =
        /(?:var|let|const)?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*[^;]*\.row\s*\([^;]*\)\.data\s*\(\s*\)/g;
      let m;
      while ((m = rowVarRe.exec(code)) !== null) {
        if (m[1]) rowVarNames.add(m[1]);
      }

      const resolvePropVal = (prop) => {
        if (rowData && typeof rowData === 'object' && prop in rowData && rowData[prop] !== null && rowData[prop] !== undefined) {
          return String(rowData[prop]);
        }
        return `{${prop}}`;
      };

      // 2) 각 row 변수명(data.xxx, data['xxx'])을 실제 행 데이터 값 문자열 리터럴로 치환
      for (const vName of rowVarNames) {
        const escV = escapeRegExp(vName);
        // 템플릿 리터럴 내부 ${data.prop}
        const tplDotRe = new RegExp(`\\$\\{\\s*${escV}\\.([a-zA-Z0-9_$]+)\\s*\\}`, 'g');
        code = code.replace(tplDotRe, (_, prop) => resolvePropVal(prop));

        const tplBracketRe = new RegExp(`\\$\\{\\s*${escV}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]\\s*\\}`, 'g');
        code = code.replace(tplBracketRe, (_, prop) => resolvePropVal(prop));

        // 일반 표현식 data.prop (뒤에 '(' 함수호출이 아닌 경우)
        const dotRe = new RegExp(`\\b${escV}\\.([a-zA-Z0-9_$]+)(?!\\s*[.(])\\b`, 'g');
        code = code.replace(dotRe, (full, prop) => {
          if (['length', 'toString', 'trim', 'slice', 'replace', 'indexOf'].includes(prop)) return full;
          return `"${resolvePropVal(prop)}"`;
        });

        // 대괄호 표현식 data['prop']
        const bracketRe = new RegExp(`\\b${escV}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g');
        code = code.replace(bracketRe, (_, prop) => `"${resolvePropVal(prop)}"`);
      }

      // 3) 백틱 템플릿 리터럴 `/path/to?a=...` -> 일반 따옴표 문자열로 변환
      code = code.replace(/`([^`$]+)`/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`);

      // 4) 인접 문자열 리터럴 연결("a" + "b" -> "ab") 반복 병합
      for (let i = 0; i < 6; i++) {
        const prev = code;
        code = code.replace(/(['"])([^'"]*)\1\s*\+\s*(['"])([^'"]*)\3/g, '"$2$4"');
        if (code === prev) break;
      }

      // 5) 로컬 URL 변수(var url = "/..."; jsPopup(url, ...))를 호출부에 인라인 치환
      const urlVarRe =
        /(?:var|let|const)?\s*\b(url|linkUrl|actionUrl|targetUrl|popupUrl|moveUrl|reqUrl|sUrl)\s*=\s*(['"])(\/[^'"]+)\2/g;
      const localVars = new Map();
      while ((m = urlVarRe.exec(code)) !== null) {
        localVars.set(m[1], m[3]);
      }
      for (const [vName, urlVal] of localVars.entries()) {
        const escV = escapeRegExp(vName);
        // jsPopup(url, ...) / window.open(url, ...) / fetch(url)
        const callArgRe = new RegExp(
          `(\\b(?:jsPopup\\w*|window\\.open|jsRedirect|jsAlertRedirect|downloadExcelFile|fetch|load)\\s*\\(\\s*)${escV}\\b`,
          'g'
        );
        code = code.replace(callArgRe, `$1"${urlVal}"`);

        // location.href = url / url: url
        const assignRe = new RegExp(
          `((?:location(?:\\.href)?\\s*=|\\burl\\s*:|\\.attr\\(\\s*['"]src['"]\\s*,)\\s*)${escV}\\b`,
          'g'
        );
        code = code.replace(assignRe, `$1"${urlVal}"`);
      }
    } catch {}

    return code;
  }

  function extractBalancedBlock(str, openBraceIdx) {
    if (str[openBraceIdx] !== '{') return '';
    let depth = 0;
    const maxLen = Math.min(str.length, openBraceIdx + 6000);
    for (let i = openBraceIdx; i < maxLen; i++) {
      const ch = str[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return str.slice(openBraceIdx, i + 1);
        }
      }
    }
    return str.slice(openBraceIdx, maxLen);
  }

  // 함수 호출 문자열(예: "openDetail('2026001', 'KR')")에서 인자 치환 후 URL 추출
  function resolveFunctionCallUrls(callExpr, depth = 0, rowData = null) {
    const results = [];
    if (!callExpr || depth > 2) return results;

    try {
      const normalizedExpr = normalizeAndInterpolateCode(callExpr, rowData);

      // 1) 공통 메뉴/팝업 헬퍼 함수 패턴 즉시 해석
      // doActionMegaMenu(event, 'topLeftMenuClick', '...', '/app/menu/list')
      const megaMatch = normalizedExpr.match(
        /doActionMegaMenu\s*\([^,]+,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/
      );
      if (megaMatch) {
        results.push({
          url: megaMatch[1],
          kind: 'IFRAME 메뉴 이동',
          method: 'GET',
          params: parseQueryParams(megaMatch[1]),
          source: 'onclick (doActionMegaMenu)'
        });
      }

      // doAction('leftMenuClick', '/dashboard/pendingList')
      const leftMenuMatch = normalizedExpr.match(
        /doAction\s*\(\s*['"]leftMenuClick['"]\s*,\s*['"]([^'"]+)['"]/
      );
      if (leftMenuMatch) {
        results.push({
          url: leftMenuMatch[1],
          kind: 'IFRAME 메뉴 이동',
          method: 'GET',
          params: parseQueryParams(leftMenuMatch[1]),
          source: 'onclick (doAction)'
        });
      }

      // dirMenuClick('/app/board/view')
      const dirMenuMatch = normalizedExpr.match(/dirMenuClick\s*\(\s*['"]([^'"]+)['"]/);
      if (dirMenuMatch) {
        results.push({
          url: dirMenuMatch[1],
          kind: 'IFRAME 화면 이동',
          method: 'GET',
          params: parseQueryParams(dirMenuMatch[1]),
          source: 'dirMenuClick()'
        });
      }

      // jsPopup('/common/noticePopup', ...) / jsPopupScroll(...) / window.open(...)
      const popupMatch = normalizedExpr.match(
        /(?:jsPopup\w*|window\.open)\s*\(\s*['"]([^'"]+)['"]/
      );
      if (popupMatch) {
        results.push({
          url: popupMatch[1],
          kind: '팝업 오픈 (window.open)',
          method: 'GET',
          params: parseQueryParams(popupMatch[1]),
          source: '팝업 호출'
        });
      }

      // 2) 일반 코드 블록 내 URL 패턴 스캔
      extractUrlsFromCodeBlock(normalizedExpr, '핸들러 코드').forEach((item) => {
        if (!results.some((r) => r.url === item.url)) results.push(item);
      });

      // 3) 호출된 커스텀 함수(예: openDetail('123', 'KR'), dataList(), $.downloadForExcel()) 추적
      const fnCallRegex = /(?:\$\.)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^()]*)\)/g;
      let m;
      const skipFns = new Set([
        'if',
        'for',
        'while',
        'switch',
        'function',
        'return',
        'alert',
        'confirm',
        'parseInt',
        'parseFloat',
        'encodeURIComponent',
        'jQuery',
        '$',
        'bind',
        'click',
        'on',
        'attr',
        'val',
        'text',
        'html',
        'show',
        'hide',
        'removeClass',
        'addClass',
        'trigger',
        'closest',
        'parent',
        'row',
        'data',
        'isEmpty'
      ]);

      while ((m = fnCallRegex.exec(normalizedExpr)) !== null) {
        const fnName = m[1];
        const rawArgsStr = m[2].trim();
        if (skipFns.has(fnName)) continue;

        const fnInfo = lookupFunctionSource(fnName);
        if (!fnInfo) continue;

        // 인자값과 파라미터명 매핑 (예: docId -> '2026001', orgCd -> 'KR')
        let resolvedBody = fnInfo.body;
        if (fnInfo.args && rawArgsStr) {
          const paramNames = fnInfo.args
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const argValues = parseCallArguments(rawArgsStr);
          paramNames.forEach((pName, idx) => {
            if (argValues[idx] !== undefined) {
              // 문자열 연결 패턴: "url..." + paramName + "..." 치환
              const concatRe = new RegExp(
                `(['"])\\s*\\+\\s*${escapeRegExp(pName)}\\s*\\+\\s*(['"])`,
                'g'
              );
              resolvedBody = resolvedBody.replace(concatRe, `${argValues[idx]}`);

              const tailRe = new RegExp(`(['"])\\s*\\+\\s*${escapeRegExp(pName)}\\b`, 'g');
              resolvedBody = resolvedBody.replace(tailRe, `${argValues[idx]}$1`);
            }
          });
        }

        resolvedBody = normalizeAndInterpolateCode(resolvedBody, rowData);
        const subItems = extractUrlsFromCodeBlock(resolvedBody, `${fnName}()`);
        for (const item of subItems) {
          if (!results.some((r) => r.url === item.url)) {
            results.push(item);
          }
        }
      }
    } catch {}

    return results;
  }

  function lookupFunctionSource(fnName) {
    try {
      // 1) 페이지 <script> 인덱서에서 조회
      const scriptMap = getScriptFunctionMap();
      if (scriptMap.has(fnName)) {
        return scriptMap.get(fnName);
      }
      // 2) window[fnName] 또는 jQuery[fnName]에서 조회
      const fn =
        (typeof window[fnName] === 'function' && window[fnName]) ||
        (window.jQuery && typeof window.jQuery[fnName] === 'function' && window.jQuery[fnName]);
      if (fn) {
        const raw = Function.prototype.toString.call(fn);
        const argMatch = raw.match(/^function[^()]*\(([^)]*)\)/);
        return {
          args: argMatch ? argMatch[1] : '',
          body: raw,
          raw
        };
      }
    } catch {}
    return null;
  }

  function parseCallArguments(rawArgsStr) {
    const args = [];
    const re = /'([^']*)'|"([^"]*)"|([^,\s]+)/g;
    let m;
    while ((m = re.exec(rawArgsStr)) !== null) {
      args.push(m[1] ?? m[2] ?? m[3]);
    }
    return args;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // JS 코드 문자열 내부에서 Ajax, jqGrid, 팝업, form.action, location, iframe URL 및 파라미터 추출
  function extractUrlsFromCodeBlock(code, sourceLabel) {
    const found = [];
    if (!code || typeof code !== 'string') return found;

    // 1) url: '/...' 또는 url : "/..." ($.ajax, jqGrid 등)
    const ajaxUrlRe = /\burl\s*:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = ajaxUrlRe.exec(code)) !== null) {
      const url = m[1];
      if (isValidCandidateUrl(url)) {
        const isGrid = /jqGrid|setGridParam|reloadGrid/.test(code);
        const methodMatch = code.match(/\b(?:type|method)\s*:\s*['"](GET|POST|PUT|DELETE)['"]/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : isGrid ? 'POST' : 'AJAX';
        const params = {
          ...parseQueryParams(url),
          ...extractDomParamsFromCode(code)
        };
        found.push({
          url,
          kind: isGrid ? `jqGrid 데이터 조회 (${method})` : `AJAX 호출 (${method})`,
          method,
          params,
          source: sourceLabel
        });
      }
    }

    // 2) fetch('/...') 또는 $(...).load('/...')
    const fetchLoadRe = /\b(?:fetch|load)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = fetchLoadRe.exec(code)) !== null) {
      const url = m[1];
      if (isValidCandidateUrl(url)) {
        found.push({
          url,
          kind: '비동기 로드 (fetch/load)',
          method: 'GET/POST',
          params: { ...parseQueryParams(url), ...extractDomParamsFromCode(code) },
          source: sourceLabel
        });
      }
    }

    // 3) 팝업 / 리다이렉트 / location / iframe src / downloadExcelFile
    const navRe =
      /(?:jsPopup\w*|window\.open|jsRedirect|jsAlertRedirect|downloadExcelFile|location(?:\.href)?\s*=|\.attr\(\s*['"]src['"]\s*,|\.action\s*=)\s*\(?\s*['"]([^'"]+)['"]/g;
    while ((m = navRe.exec(code)) !== null) {
      const url = m[1];
      if (isValidCandidateUrl(url)) {
        const isPopup = /jsPopup|window\.open/.test(m[0]);
        const isIframe = /attr\(\s*['"]src['"]/.test(m[0]);
        found.push({
          url,
          kind: isPopup ? '팝업 오픈' : isIframe ? 'IFRAME 전환' : '페이지 이동 / 다운로드',
          method: 'GET',
          params: { ...parseQueryParams(url), ...extractDomParamsFromCode(code) },
          source: sourceLabel
        });
      }
    }

    // 4) var url = "/app/orders/detail?1=1" 같은 변수 할당 패턴
    const varUrlRe = /\b(?:url|linkUrl|actionUrl)\s*=\s*['"](\/[a-zA-Z0-9_./?-][^'"]*)['"]/g;
    while ((m = varUrlRe.exec(code)) !== null) {
      const url = m[1];
      if (isValidCandidateUrl(url) && !found.some((f) => f.url === url)) {
        found.push({
          url,
          kind: 'URL 호출',
          method: 'GET/POST',
          params: { ...parseQueryParams(url), ...extractDomParamsFromCode(code) },
          source: sourceLabel
        });
      }
    }

    return found;
  }

  // 코드 내에 `searchType : $("#searchType").val()` 같은 패턴이 있으면 현재 화면의 실제 DOM 값을 읽어와 파라미터로 구성!
  function extractDomParamsFromCode(code) {
    const params = {};
    try {
      const domValRe = /([a-zA-Z0-9_]+)\s*:\s*\$\(\s*['"](#[a-zA-Z0-9_-]+)['"]\s*\)\.val\(\)/g;
      let m;
      while ((m = domValRe.exec(code)) !== null) {
        const paramKey = m[1];
        const selector = m[2];
        const el = document.querySelector(selector);
        params[paramKey] = el && 'value' in el ? el.value : `$(${selector}).val()`;
      }
    } catch {}
    return params;
  }

  function isValidCandidateUrl(u) {
    if (!u || typeof u !== 'string') return false;
    const t = u.trim();
    if (t.length < 2 || t === '#' || t === '/' || t.startsWith('javascript:')) return false;
    if (/\.(png|gif|jpg|jpeg|svg|css|woff2?)$/i.test(t)) return false;
    return t.startsWith('/') || /^https?:\/\//i.test(t);
  }

  // 요소에 바인딩된 jQuery 이벤트 및 네이티브 이벤트 핸들러 목록 수집
  function getBoundClickHandlers(el) {
    const handlers = [];
    if (!el || !(el instanceof Element)) return handlers;

    // 1) jQuery 이벤트 (직접 바인딩 + 상위/document 위임 바인딩)
    try {
      const jq = window.jQuery || window.$;
      if (jq) {
        const getEv = (node) => (jq._data ? jq._data(node, 'events') : jq(node).data?.('events'));

        // 직접 바인딩
        const directEv = getEv(el);
        if (directEv) {
          for (const type of ['click', 'dblclick']) {
            if (Array.isArray(directEv[type])) {
              directEv[type].forEach((h) => {
                if (h.handler && !h.selector) {
                  handlers.push({
                    type: `jQuery .${type}()`,
                    fn: h.handler,
                    code: Function.prototype.toString.call(h.handler)
                  });
                }
              });
            }
          }
        }

        // 위임(delegated) 이벤트 탐색 (조상 및 document)
        let ancestor = el.parentElement;
        const targets = [];
        while (ancestor) {
          targets.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        targets.push(document);

        for (const node of targets) {
          const ev = getEv(node);
          if (!ev) continue;
          for (const type of ['click', 'dblclick']) {
            if (!Array.isArray(ev[type])) continue;
            for (const h of ev[type]) {
              if (h.selector && h.handler) {
                try {
                  if (el.matches(h.selector) || el.closest(h.selector) === el) {
                    handlers.push({
                      type: `jQuery .on('${type}', '${h.selector}')`,
                      fn: h.handler,
                      code: Function.prototype.toString.call(h.handler)
                    });
                  }
                } catch {}
              }
            }
          }
        }
      }
    } catch {}

    // 2) 네이티브 addEventListener
    try {
      const list = nativeListeners.get(el);
      if (Array.isArray(list)) {
        list.forEach((item) => {
          handlers.push({
            type: `addEventListener('${item.type}')`,
            fn: item.listener,
            code: Function.prototype.toString.call(item.listener)
          });
        });
      }
    } catch {}

    return handlers;
  }

  // ---------------------------------------------------------------------------
  // 경로 파라미터 URL 패턴 학습 (예: /popup/employee/NX/{사번})
  // ---------------------------------------------------------------------------
  const STATE_CLASS_RE = /^(on|active|selected|hover|focus|current|open|over|checked|disabled|odd|even)$/i;

  function buildClickContext(el, desc) {
    const context = { ...desc, timestamp: Date.now() };
    try {
      context.patternGroupKey = getPatternGroupKey(el);
      context.elementValues = collectElementValues(el);
    } catch {}
    return context;
  }

  function getInlineCallCode(el) {
    const anchor = el.tagName === 'A' ? el : el.closest('a');
    const onclickCode = el.getAttribute('onclick') || anchor?.getAttribute('onclick') || '';
    if (onclickCode) return onclickCode;
    const href = anchor?.getAttribute('href') || '';
    return /^javascript:/i.test(href) ? href.replace(/^javascript:/i, '') : '';
  }

  // 같은 종류 요소 판별 키: 같은 화면 + 태그 + 상태 클래스를 뺀 클래스 + 같은 클릭 동작(함수명/핸들러) + 같은 표의 같은 열
  function getPatternGroupKey(el) {
    const classes =
      typeof el.className === 'string'
        ? el.className
            .trim()
            .split(/\s+/)
            .filter((c) => c && !STATE_CLASS_RE.test(c) && !c.startsWith('url-tracker-'))
            .sort()
            .join('.')
        : '';
    const parts = [window.location.pathname, el.tagName.toLowerCase(), classes];

    let hasClickBehavior = false;
    const fnMatch = getInlineCallCode(el).match(/([\w$.]+)\s*\(/);
    if (fnMatch) {
      parts.push(`fn:${fnMatch[1]}`);
      hasClickBehavior = true;
    }
    for (const h of getBoundClickHandlers(el)) {
      parts.push(`${h.type}:${h.code.length}:${h.code.slice(0, 60)}`);
      hasClickBehavior = true;
    }

    const table = el.closest('table');
    if (table) {
      const td = el.closest('td');
      parts.push(`table:${table.id || table.className}:${td ? td.cellIndex : 'row'}`);
    }

    // 클릭 동작도 없고 목록(표) 안도 아니면 같은 종류로 묶을 근거가 없으므로 패턴 학습 대상에서 제외
    if (!hasClickBehavior && !table) return null;
    return parts.join('|');
  }

  // URL 자리에 들어갈 수 있는 요소 값 수집 (이름은 같은 종류 요소끼리 동일하게 유지되도록 출처 기반으로 부여)
  function collectElementValues(el) {
    const values = new Map();
    const add = (name, raw) => {
      if (raw == null || typeof raw === 'object') return;
      const s = String(raw).replace(/\s+/g, ' ').trim();
      if (s.length < 2 || s.length > 80) return;
      if (!values.has(name)) values.set(name, s);
    };
    const addAttrs = (node, prefix) => {
      if (!node?.attributes) return;
      for (const attr of node.attributes) {
        if (attr.name === 'class' || attr.name === 'style') continue;
        add(`${prefix}:${attr.name}`, attr.value);
      }
    };

    addAttrs(el, 'attr');
    if (el.tagName !== 'A') addAttrs(el.closest('a'), 'a-attr');

    const callMatch = getInlineCallCode(el).match(/[\w$.]+\s*\(([^)]*)\)/);
    if (callMatch) {
      parseCallArguments(callMatch[1]).forEach((v, i) => add(`arg:${i}`, v));
    }

    add('text', el.innerText || el.value || '');

    const tr = el.tagName === 'TR' ? el : el.closest('tr');
    if (tr) {
      addAttrs(tr, 'tr-attr');
      Array.from(tr.cells || []).forEach((td, i) => add(`td:${i}`, td.innerText || ''));

      try {
        const dtCtx = getDataTableRowContext(tr);
        const rowData = dtCtx ? getDataTableApi(dtCtx.table)?.row(tr).data() : null;
        if (rowData && typeof rowData === 'object' && !Array.isArray(rowData)) {
          Object.entries(rowData).forEach(([k, v]) => add(`row:${k}`, v));
        }
      } catch {}

      try {
        if (tr.classList.contains('jqgrow') && window.jQuery) {
          const $grid = window.jQuery(tr.closest('table.ui-jqgrid-btable'));
          const rowData = $grid.jqGrid ? $grid.jqGrid('getRowData', tr.id) : null;
          if (rowData && typeof rowData === 'object') {
            Object.entries(rowData).forEach(([k, v]) => add(`row:${k}`, v));
          }
        }
      } catch {}
    }
    return values;
  }

  // 실측 URL의 경로 구간·쿼리 값 중 요소 값과 일치하는 부분을 {{값 이름}} 자리표시로 치환 (일치가 없으면 null)
  function buildUrlTemplate(url, values) {
    if (!url || !(values instanceof Map) || values.size === 0) return null;
    const m = url.match(/^([a-z][\w+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i);
    if (!m) return null;
    const [, origin = '', path = '', query = '', hash = ''] = m;

    const findValueName = (raw) => {
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {}
      // 사번·문서번호처럼 숫자가 섞인 3자 이상 값만 자리표시로 본다
      // (NX 같은 고정 코드 구간이나 pageSize=10 같은 짧은 값이 우연히 행 값과 같아 잘못 치환되는 것을 방지)
      if (decoded.length < 3 || !/\d/.test(decoded)) return null;
      for (const [name, val] of values) {
        if (val === decoded) return name;
      }
      return null;
    };

    let replaced = 0;
    const newPath = path
      .split('/')
      .map((seg) => {
        const name = seg ? findValueName(seg) : null;
        if (!name) return seg;
        replaced++;
        return `{{${name}}}`;
      })
      .join('/');

    const newQuery = query
      ? '?' +
        query
          .slice(1)
          .split('&')
          .map((pair) => {
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 0) return pair;
            const name = findValueName(pair.slice(eqIdx + 1));
            if (!name) return pair;
            replaced++;
            return `${pair.slice(0, eqIdx + 1)}{{${name}}}`;
          })
          .join('&')
      : '';

    return replaced > 0 ? origin + newPath + newQuery + hash : null;
  }

  // 자리표시를 대상 요소의 같은 이름 값으로 채움 (하나라도 없으면 추정 불가로 null)
  function fillUrlTemplate(template, values) {
    let missing = false;
    const url = template.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
      const v = values.get(name);
      if (v == null) {
        missing = true;
        return '';
      }
      return encodeURIComponent(v);
    });
    return missing ? null : url;
  }

  // 요소 마우스 오버 시 종합 URL 분석 수행
  function inspectElementOnHover(rawTarget) {
    const el = findActionableElement(rawTarget);
    if (!el) return null;

    const desc = getElementDescriptor(el);
    if (!desc) return null;

    const candidates = [];
    const addCandidate = (c) => {
      if (!c || !c.url) return;
      const disp = toDisplayPath(c.url);
      if (!disp || disp === '#') return;
      const existing = candidates.find((x) => x.displayUrl === disp);
      if (existing) {
        existing.params = { ...existing.params, ...(c.params || {}) };
        if (c.verified) existing.verified = true;
        return;
      }
      candidates.push({
        displayUrl: disp,
        fullUrl: toFullUrl(c.url),
        kind: c.kind || 'URL 이동/호출',
        method: c.method || 'GET',
        params: c.params || parseQueryParams(c.url),
        source: c.source || '',
        verified: !!c.verified
      });
    };

    // [1] 이전에 클릭해서 실측된 URL이 있는 경우 최우선 추가
    const learned = learnedElementUrls.get(desc.uniqueKey);
    if (Array.isArray(learned)) {
      learned.forEach((item) => {
        addCandidate({
          url: item.displayUrl,
          kind: `${item.kind} (실측 확인됨)`,
          method: item.method,
          params: item.params,
          source: '이전 클릭 실측',
          verified: true
        });
      });
    }


    // [2] <a href="..."> 또는 data-url / formaction 직접 속성
    const anchor = el.tagName === 'A' ? el : el.closest('a');
    if (anchor) {
      const rawHref = anchor.getAttribute('href') || '';
      if (rawHref && rawHref !== '#' && !rawHref.startsWith('#')) {
        if (/^javascript:/i.test(rawHref)) {
          const jsCode = rawHref.replace(/^javascript:/i, '');
          resolveFunctionCallUrls(jsCode).forEach(addCandidate);
        } else {
          addCandidate({
            url: rawHref,
            kind: anchor.getAttribute('target') === '_blank' ? '새창 링크 (a[href])' : '페이지 이동 (a[href])',
            method: 'GET',
            params: parseQueryParams(rawHref),
            source: 'href 속성'
          });
        }
      }
    }

    for (const attr of ['data-url', 'data-href', 'data-src', 'data-action', 'formaction']) {
      const val = el.getAttribute(attr);
      if (val && isValidCandidateUrl(val)) {
        addCandidate({
          url: val,
          kind: `속성 URL (${attr})`,
          method: 'GET',
          params: parseQueryParams(val),
          source: attr
        });
      }
    }

    // [3] 인라인 onclick 속성 분석 (파라미터 치환 포함)
    const onclickCode = el.getAttribute('onclick') || anchor?.getAttribute('onclick') || '';
    if (onclickCode) {
      resolveFunctionCallUrls(onclickCode).forEach(addCandidate);
    }

    // [4] <form> 내부 submit 버튼인 경우 form action 및 필드 추출
    if (
      (el.tagName === 'BUTTON' && (el.type === 'submit' || !el.getAttribute('type'))) ||
      (el.tagName === 'INPUT' && el.type === 'submit')
    ) {
      const form = el.closest('form');
      if (form && form.getAttribute('action')) {
        addCandidate({
          url: form.getAttribute('action'),
          kind: `FORM 전송 (${(form.getAttribute('method') || 'GET').toUpperCase()})`,
          method: (form.getAttribute('method') || 'GET').toUpperCase(),
          params: extractFormParams(form),
          source: 'form[action]'
        });
      }
    }

    // [5] jQuery 및 네이티브 클릭 이벤트 핸들러 역추적
    const handlers = getBoundClickHandlers(el);
    const handlerSummaries = [];
    for (const h of handlers) {
      const cleanCode = h.code.replace(/\s+/g, ' ').trim();
      handlerSummaries.push(`${h.type}: ${cleanCode.slice(0, 100)}${cleanCode.length > 100 ? '…' : ''}`);
      resolveFunctionCallUrls(h.code).forEach(addCandidate);
    }

    // [6] jqGrid 행(tr.jqgrow) 마우스 오버 시 그리드 이벤트 & 행 데이터(rowData) 추출
    const jqRow = el.tagName === 'TR' && el.classList.contains('jqgrow') ? el : el.closest('tr.jqgrow');
    if (jqRow && window.jQuery) {
      try {
        const $ = window.jQuery;
        const gridTable = jqRow.closest('table.ui-jqgrid-btable');
        if (gridTable && gridTable.id) {
          const $grid = $(gridTable);
          const rowId = jqRow.id;
          const rowData = $grid.jqGrid ? $grid.jqGrid('getRowData', rowId) : {};
          const compactRowParams = {};
          if (rowData && typeof rowData === 'object') {
            for (const [k, v] of Object.entries(rowData)) {
              if (typeof v === 'string' && !v.includes('<') && v.trim() !== '') {
                compactRowParams[k] = v.trim();
              }
            }
          }

          for (const cbName of ['onSelectRow', 'onCellSelect', 'ondblClickRow']) {
            const cb = $grid.jqGrid('getGridParam', cbName);
            if (typeof cb === 'function') {
              const cbCode = Function.prototype.toString.call(cb);
              const extracted = resolveFunctionCallUrls(cbCode, 0, rowData);
              extracted.forEach((item) => {
                addCandidate({
                  ...item,
                  kind: `jqGrid 행 선택 (${cbName})`,
                  params: { rowid: rowId, ...compactRowParams, ...(item.params || {}) },
                  source: `jqGrid ${cbName}`
                });
              });
            }
          }
        }
      } catch {}
    }

    // [7] DataTables 목록 행(tbody tr) 마우스 오버 시:
    //     - 행 데이터(dt.row(tr).data()) 실시간 추출 및 URL 치환 (예: ?docNo=2026001, ?sApprNo=45)
    //     - 행(tr) 또는 행 내부 특정 열(td:nth-child(3), td:not(:first-child) 등)에 걸린 위임 클릭 이벤트 역추적
    //     - 현재 DataTables의 목록 조회 Ajax URL (dt.ajax.url()) 및 검색 파라미터 표시
    const dtRowCtx = getDataTableRowContext(rawTarget) || getDataTableRowContext(el);
    if (dtRowCtx) {
      try {
        const { table, tbody, tr } = dtRowCtx;
        const dt = getDataTableApi(table);
        let rowData = null;
        try {
          if (dt && typeof dt.row === 'function') {
            rowData = dt.row(tr).data();
          }
        } catch {}

        // rowData에서 핵심 스칼라 필드(문서번호, 품의번호, 코드 등) 추출
        const compactRowParams = {};
        if (rowData && typeof rowData === 'object' && !Array.isArray(rowData)) {
          const entries = Object.entries(rowData).filter(([k, v]) => {
            if (v === null || v === undefined || v === '') return false;
            if (typeof v === 'object') return false;
            const s = String(v).trim();
            return s.length > 0 && s.length <= 60 && !s.includes('<');
          });
          // ID/No/Cd/Seq/Key 계열 키를 앞쪽에 배치
          entries.sort(([a], [b]) => {
            const aKey = /(?:No|Id|Cd|Seq|Key|Sts|Type|Nm)$/i.test(a) ? 0 : 1;
            const bKey = /(?:No|Id|Cd|Seq|Key|Sts|Type|Nm)$/i.test(b) ? 0 : 1;
            return aKey - bKey;
          });
          entries.slice(0, 10).forEach(([k, v]) => {
            compactRowParams[k] = String(v).trim();
          });
        }

        // 행(tr) 및 행 내부 모든 셀(td)에 매칭되는 jQuery 위임/직접 클릭 핸들러 수집
        const jq = window.jQuery || window.$;
        const cellHandlers = [];
        const seenFns = new Set();

        const getColumnHeaderLabel = (tdEl) => {
          try {
            const colIdx = tdEl.cellIndex;
            const ths = table.querySelectorAll('thead tr:last-child th, thead tr th');
            const th = ths[colIdx];
            const hText = th ? th.innerText.replace(/\s+/g, ' ').trim() : '';
            return hText ? `'${hText}' 열` : `${colIdx + 1}번째 열`;
          } catch {
            return '셀';
          }
        };

        if (jq) {
          const getEv = (node) => (jq._data ? jq._data(node, 'events') : jq(node).data?.('events'));
          const delegateRoots = [tbody, table, table.parentElement, document].filter(Boolean);
          const tds = Array.from(tr.querySelectorAll('td'));

          for (const root of delegateRoots) {
            const ev = getEv(root);
            if (!ev) continue;
            for (const type of ['click', 'dblclick']) {
              if (!Array.isArray(ev[type])) continue;
              for (const h of ev[type]) {
                if (!h.handler || seenFns.has(h.handler)) continue;
                const sel = h.selector;
                if (!sel) continue;
                try {
                  if (tr.matches(sel)) {
                    seenFns.add(h.handler);
                    cellHandlers.push({
                      label: `DataTables 행 클릭 (${sel})`,
                      code: Function.prototype.toString.call(h.handler)
                    });
                  } else {
                    const matchedTds = tds.filter((tdEl) => tdEl.matches(sel));
                    if (matchedTds.length > 0) {
                      seenFns.add(h.handler);
                      const colDesc =
                        matchedTds.length === 1
                          ? `${getColumnHeaderLabel(matchedTds[0])} 클릭`
                          : `행 셀 클릭 (${sel})`;
                      cellHandlers.push({
                        label: `DataTables ${colDesc}`,
                        code: Function.prototype.toString.call(h.handler)
                      });
                    }
                  }
                } catch {}
              }
            }
          }
        }

        // 수집된 행/셀 클릭 핸들러에서 rowData 치환 후 URL 추출
        for (const ch of cellHandlers) {
          const cleanCode = ch.code.replace(/\s+/g, ' ').trim();
          handlerSummaries.push(`${ch.label}: ${cleanCode.slice(0, 100)}${cleanCode.length > 100 ? '…' : ''}`);
          const extracted = resolveFunctionCallUrls(ch.code, 0, rowData);
          extracted.forEach((item) => {
            addCandidate({
              ...item,
              kind: `${ch.label} → ${item.kind}`,
              params: { ...compactRowParams, ...(item.params || {}) },
              source: ch.label
            });
          });
        }

        // 현재 DataTables 테이블 자체의 목록 조회 Ajax URL도 함께 안내
        if (dt && typeof dt.ajax?.url === 'function') {
          const dtAjaxUrl = dt.ajax.url();
          if (dtAjaxUrl && typeof dtAjaxUrl === 'string' && isValidCandidateUrl(dtAjaxUrl)) {
            let ajaxParams = { ...compactRowParams };
            try {
              const searchForm = document.querySelector('#searchForm, form[name="searchForm"]');
              if (searchForm instanceof HTMLFormElement) {
                ajaxParams = { ...extractFormParams(searchForm), ...compactRowParams };
              }
            } catch {}
            addCandidate({
              url: dtAjaxUrl,
              kind: 'DataTables 목록 조회 API (현재 테이블)',
              method: 'AJAX',
              params: ajaxParams,
              source: 'DataTables ajax.url()'
            });
          }
        }
      } catch {}
    }

    // [8] DataTables 상단/하단 커스텀 액션 버튼(.dt-button) 및 목록 재조회 버튼(ajax.reload) 지원
    try {
      const allHandlerText = [onclickCode, ...handlers.map((h) => h.code)].join('\n');

      // 8-A. DataTables Buttons 확장 버튼 (.dt-button)
      if (el.classList.contains('dt-button') || el.closest('.dt-buttons')) {
        const btnEl = el.classList.contains('dt-button') ? el : el.closest('.dt-button') || el;
        const wrapper = btnEl.closest('.dataTables_wrapper');
        const tbl = wrapper ? wrapper.querySelector('table.dataTable') : document.querySelector('table.dataTable');
        const dt = tbl ? getDataTableApi(tbl) : getAllDataTableApis()[0];
        if (dt) {
          let selectedRowData = null;
          try {
            selectedRowData =
              dt.row({ selected: true })?.data?.() ||
              dt.rows('.selected')?.data?.()?.[0] ||
              dt.row(0)?.data?.() ||
              null;
          } catch {}

          // DataTables 내부 버튼 설정에서 action 함수 추출
          const settings = dt.settings?.()?.[0];
          const btnInstances = settings?._buttons || [];
          for (const inst of btnInstances) {
            const buttonsArr = inst?.s?.buttons || [];
            for (const bObj of buttonsArr) {
              if (bObj?.node === btnEl || (bObj?.node && bObj.node.contains?.(btnEl))) {
                const actionFn = bObj?.conf?.action;
                if (typeof actionFn === 'function') {
                  const actionCode = Function.prototype.toString.call(actionFn);
                  const cleanCode = actionCode.replace(/\s+/g, ' ').trim();
                  handlerSummaries.push(`DataTables Button action: ${cleanCode.slice(0, 100)}…`);
                  resolveFunctionCallUrls(actionCode, 0, selectedRowData).forEach((item) => {
                    addCandidate({
                      ...item,
                      kind: `DataTables 버튼 (${item.kind})`,
                      source: 'DataTables buttons.action'
                    });
                  });
                }
              }
            }
          }
        }
      }

      // 8-B. 조회 버튼 클릭 핸들러가 dataTables.ajax.reload() 또는 listTable.ajax.reload()를 호출하는 경우
      if (/\.ajax\.reload\s*\(|\.draw\s*\(/.test(allHandlerText)) {
        const apis = getAllDataTableApis();
        for (const dt of apis) {
          const dtAjaxUrl = typeof dt.ajax?.url === 'function' ? dt.ajax.url() : '';
          if (dtAjaxUrl && isValidCandidateUrl(dtAjaxUrl)) {
            const searchForm = document.querySelector('#searchForm, form[name="searchForm"], form');
            const formParams =
              searchForm instanceof HTMLFormElement ? extractFormParams(searchForm) : {};
            addCandidate({
              url: dtAjaxUrl,
              kind: 'DataTables 목록 조회 (ajax.reload)',
              method: 'AJAX',
              params: formParams,
              source: 'dt.ajax.reload()'
            });
          }
        }
      }
    } catch {}

    // [8] 같은 종류 요소를 클릭해 학습한 URL 패턴을 이 요소의 값으로 채워 추정 (경로에 파라미터를 넣는 URL 대응)
    //     실측·정적 분석 후보가 먼저 자리 잡도록 마지막에 추가한다 (같은 URL이면 기존 후보의 표기를 유지)
    try {
      const patternGroupKey = getPatternGroupKey(el);
      const patterns = patternGroupKey ? learnedUrlPatterns.get(patternGroupKey) : null;
      if (Array.isArray(patterns) && patterns.length > 0) {
        const values = collectElementValues(el);
        patterns.forEach((p) => {
          const url = fillUrlTemplate(p.template, values);
          if (!url) return;
          addCandidate({
            url,
            kind: `${p.kind} (패턴 추정)`,
            method: p.method,
            params: parseQueryParams(url),
            source: '같은 종류 요소 클릭 실측 패턴'
          });
        });
      }
    } catch {}

    if (candidates.length === 0 && !onclickCode && handlerSummaries.length === 0) {
      return null;
    }

    const rect = el.getBoundingClientRect();
    return {
      element: desc,
      frameName: FRAME_NAME,
      onclick: onclickCode,
      handlers: handlerSummaries,
      candidates,
      rect: {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        width: rect.width,
        height: rect.height
      }
    };
  }

  // content.js로부터 마우스 오버 분석 요청 수신
  origAddEventListener.call(
    window,
    'mouseover',
    (e) => {
      if (!isDomainAllowed) return;
      // Shift 키를 누르고 있는 동안에는 호버 대상 변경 및 초기화를 중단하여 현재 URL 고정
      if (e.shiftKey) return;
      try {
        const el = findActionableElement(e.target);
        if (el === lastHoveredEl) return;
        lastHoveredEl = el;
        if (!el) {
          dispatchToContent('HOVER_CLEAR');
          return;
        }
        const info = inspectElementOnHover(el);
        if (info) {
          dispatchToContent('HOVER_RESULT', info);
        } else {
          dispatchToContent('HOVER_CLEAR');
        }
      } catch {}
    },
    true
  );
})();
