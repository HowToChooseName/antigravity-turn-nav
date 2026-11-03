// Antigravity Turn Navigator — edge rail widget.
// Docks to the left edge of the conversation pane: at rest it is a slim stack
// of short bars (one per user turn); on hover it expands into a list
// (text + gray date + bar per row). Click a row to jump to that turn.
//
// Rows are keyed by the turn's stable `userStepIndex` (read from the React
// fiber of each [data-testid="user-input-step"] element), NOT by DOM order or
// DB index. That index is the step's absolute position in the whole
// conversation, so it survives virtualization, re-renders and duplicate text —
// which is what made earlier index/text-based mapping jump to the wrong turn.
(function () {
  const VERSION = 'v37';
  if (window.__agTurnNavInstalled && window.__agTurnNavVersion === VERSION) return;
  window.__agTurnNavInstalled = true;
  window.__agTurnNavVersion = VERSION;
  try { document.getElementById('ag-turn-nav-host')?.remove(); } catch {}

  const HOST_ID = 'ag-turn-nav-host';

  const convId = () => (location.pathname.match(/\/c\/([0-9a-f-]{36})/i) || [])[1] || null;

  function install() {
    if (document.getElementById(HOST_ID)) return;
    if (!document.documentElement) { document.addEventListener('DOMContentLoaded', install, { once: true }); return; }
    const host = document.createElement('div');
    host.id = HOST_ID;
    (document.body || document.documentElement).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .rail {
        position: fixed; left: 16px; top: 50%; transform: translateY(-50%);
        z-index: 2147483000; display: flex; justify-content: flex-start;
        padding: 8px 2px; border-radius: 11px; background: transparent;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        transition: background .18s ease, box-shadow .18s ease, padding .18s ease;
      }
      .rail.open, .rail.expanded { background: rgba(30,31,34,0.98); box-shadow: 0 16px 44px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,0.08); padding: 10px 12px; }
      .rail:not(.open):not(.expanded) { border: 1px solid transparent; }
      .rows { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; max-height: 66vh; overflow-y: auto; overflow-x: hidden; scroll-behavior: auto; }
      .rail.open .rows, .rail.expanded .rows { padding-right: 6px; }
      .rail:not(.open):not(.expanded) .rows { overflow-y: hidden; scrollbar-width: none; }
      .rail:not(.open):not(.expanded) .rows::-webkit-scrollbar { display: none; }
      .rows::-webkit-scrollbar { width: 4px; }
      .rows::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 2px; transition: background .18s ease; }
      .rows:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,.28); }
      .row { display: flex; align-items: center; justify-content: flex-start; gap: 8px; cursor: pointer; }
      .txt {
        display: flex; align-items: center; gap: 5px;
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap;
        font-size: 12.5px; line-height: 1.3; color: #a2a8b0; text-align: left;
        transition: max-width .22s ease, opacity .16s ease, color .16s ease;
      }
      .txt > .tt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* [图片] sits INSIDE the message preview, like a chat app's inline marker */
      .im { flex: none; font-size: 12px; line-height: 1.3; color: #6b7280; }
      .rail.open .txt, .rail.expanded .txt { max-width: 264px; opacity: 1; }
      .row:hover .txt { color: #e6e7ea; }
      .row:hover .im { color: #8b929b; }
      .row.current .txt { color: #ffffff; }
      .row.current .im { color: #9aa3ad; }
      /* date: secondary, muted gray; only visible when expanded */
      .date { display: none; flex: none; font-size: 11px; line-height: 1.3; color: #6b7280; white-space: nowrap; }
      .rail.open .date, .rail.expanded .date { display: inline; }
      .row:hover .date { color: #8b929b; }
      .row.current .date { color: #9aa3ad; }
      .bar { flex: none; width: 9px; height: 2px; border-radius: 1px; background: rgba(255,255,255,.42); transition: width .18s ease, background .18s ease; }
      .row:hover .bar { background: rgba(255,255,255,.72); }
      .row.current .bar { width: 14px; background: #ffffff; }
    `;
    root.appendChild(style);

    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.innerHTML = '<div class="rows"></div>';
    root.appendChild(rail);
    const rowsEl = rail.querySelector('.rows');
    let turns = [], lastId = null, currentKey = null;

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const turnEls = () => [...document.querySelectorAll('[data-testid="user-input-step"]')];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Match a trailing timestamp (the turn DOM appends one). Covers "2026年10月24日
    // 11:27", ISO-ish "2026-10-24 11:27", relative "昨天 11:27" and — important —
    // today's bare "11:27", which older patterns missed: the time then stayed glued
    // to the message, so today's rows rendered it in message color and broke spacing.
    const DATE_RE = /((?:\d{4}年)?\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?|(?:今天|昨天|前天)\s*\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
    // Year is noise in a 200px rail — keep month/day + time only.
    const fmtDate = d => d.replace(/^\d{4}\s*年\s*/, '').replace(/^\d{4}[-/]/, '').trim();

    function splitLabel(raw, el) {
      const s = norm(raw);
      // Preferred source: the turn chrome renders the timestamp in its own muted
      // span. Reading it there is immune to the message text ending in something
      // that merely looks like a clock (e.g. "会议 14:30").
      if (el) {
        const spans = [...el.querySelectorAll('span[class*="text-muted-foreground"]')]
          .map(n => norm(n.textContent)).filter(t => t && DATE_RE.test(t));
        const stamp = spans.pop();
        if (stamp && s.endsWith(stamp)) {
          return { text: s.slice(0, s.length - stamp.length).trim(), date: fmtDate(stamp) };
        }
      }
      const m = s.match(DATE_RE);
      if (!m) return { text: s, date: '' };
      return { text: s.slice(0, m.index).trim(), date: fmtDate(m[1]) };
    }

    // Stable identity: walk each user-input-step's React fiber up to the prop
    // `userStepIndex` (the turn's absolute index in the conversation). Cached
    // per element so repeated scroll checks stay cheap.
    const keyCache = new WeakMap();
    function keyOf(el) {
      if (!el) return null;
      if (keyCache.has(el)) return keyCache.get(el);
      let key = null;
      try {
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('_reactInternals$') || k.startsWith('__reactInternalInstance$'));
        if (fk) {
          let f = el[fk], i = 0;
          while (f && i < 30) {
            const p = f.memoizedProps;
            if (p && typeof p.userStepIndex === 'number') { key = p.userStepIndex; break; }
            f = f.return; i++;
          }
        }
      } catch {}
      if (key != null) keyCache.set(el, key);
      return key;
    }

    // The app keeps several cascade contexts around (sub-panes etc); only one of
    // them owns this conversation. Walking from the scroll viewport and caching
    // the instance gives the right one (verified: totalStepsLength matches the
    // highest userStepIndex seen on the rendered steps). Reading a stale/other
    // provider made requestPageUpdate jump to a bogus range — the "点击总在末尾".
    let aspCache = null;
    function provider() {
      if (aspCache) { try { aspCache.getState(); return aspCache; } catch { aspCache = null; } }
      const el = document.querySelector('[data-testid="autoscroll-viewport"]') || document.querySelector('[data-turn-content]');
      if (!el) return null;
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('_reactInternals$') || k.startsWith('__reactInternalInstance$'));
      if (!key) return null;
      let fiber = el[key], hops = 0;
      while (fiber && hops < 45) {
        const p = fiber.memoizedProps;
        if (p && p.cascadeContext && p.cascadeContext.state && p.cascadeContext.state.agentStateProvider) {
          aspCache = p.cascadeContext.state.agentStateProvider;
          return aspCache;
        }
        fiber = fiber.return; hops++;
      }
      return null;
    }

    // Ask the app to mount the WHOLE conversation once per conversation, then wait
    // until the mounted user-turn count stops growing. Verified: 986 steps / 97
    // turns mount in ~400ms, which is what lets the rail be complete at startup
    // instead of starting at whatever slice happened to be rendered.
    let loadedFor = null;
    async function ensureLoaded(force) {
      const id = convId();
      if (!force && id && loadedFor === id) return;
      const asp = provider();
      let total = 0, want = 0;
      try {
        const st = asp.getState().trajectorySlice;
        total = Number(st.totalStepsLength) || 0;
        want = (st.stepsInSlice || []).filter(s => Number(s.type) === 14).length;
      } catch {}
      if (asp && total) {
        try { Promise.resolve(asp.requestPageUpdate({ startStepIndex: 0, endStepIndex: total })).catch(() => {}); } catch {}
      }
      const t0 = performance.now();
      let prev = -1;
      while (performance.now() - t0 < 2500) {
        await sleep(180);
        const n = turnEls().length;
        if (n === prev && (want ? n >= want : n > 0)) break;
        prev = n;
      }
      if (id) loadedFor = id;
    }

    function render() {
      const keepTop = rowsEl.scrollTop;
      if (!turns.length) { rowsEl.innerHTML = '<div class="row"><span class="bar"></span></div>'; return; }
      rowsEl.innerHTML = turns.map(t => {
        const cur = t.key === currentKey ? ' current' : '';
        // The image marker leads the message body (inside .txt): "[图片] 文字".
        // Placed before the text so the ellipsis can never swallow it.
        const im = t.hasImg ? '<span class="im">[图片]</span>' : '';
        const date = t.date ? `<span class="date">${esc(t.date)}</span>` : '';
        return `<div class="row${cur}" data-key="${t.key}"><span class="bar"></span><span class="txt">${im}<span class="tt">${esc(t.text)}</span></span>${date}</div>`;
      }).join('');
      // innerHTML replacement resets the rail's own scroll — put it back so an
      // incremental merge never makes the strip jump back to the top.
      if (keepTop) rowsEl.scrollTop = Math.min(keepTop, rowsEl.scrollHeight);
    }

    // ---- rail scroll: eased, never instant ----
    const ROW_GAP = 5;            // matches .rows gap (expanded state)
    const SLOT_MID = 'mid';       // clicked row is parked in the middle of the strip
    let railTimer = 0;
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
    function railTargetOf(row, slot) {
      const rRect = rowsEl.getBoundingClientRect();
      const cRect = row.getBoundingClientRect();
      const offset = rowsEl.scrollTop + (cRect.top - rRect.top); // row top inside content
      if (typeof slot === 'number') return offset - slot * (cRect.height + ROW_GAP);
      // Centre: keep as much context above as below the lit row.
      return offset - Math.max(0, (rRect.height - cRect.height) / 2);
    }
    // No artificial head/tail padding: at the first and last turns the strip
    // simply stops at the edge (normal scroll clamping). Centring only applies
    // when there is real content to fill both sides.
    // Timed with setTimeout rather than rAF: an occluded/unfocused window
    // throttles rAF to a standstill, which left the strip unable to move at all.
    function animateRailTo(target) {
      const max = Math.max(0, rowsEl.scrollHeight - rowsEl.clientHeight);
      target = Math.max(0, Math.min(max, Math.round(target)));
      const from = rowsEl.scrollTop;
      const delta = target - from;
      if (Math.abs(delta) < 1) return;
      clearTimeout(railTimer);
      const dist = Math.abs(delta);
      const DURATION = Math.min(420, Math.max(160, 130 + dist * 1.1));
      const t0 = performance.now();
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / DURATION);
        rowsEl.scrollTop = from + delta * easeOutCubic(p);
        if (p < 1) railTimer = setTimeout(step, 16);
      };
      step();
    }
    function markCurrent(slot) {
      rowsEl.querySelectorAll('.row').forEach(r => r.classList.toggle('current', Number(r.dataset.key) === currentKey));
      revealCurrent(slot);
    }
    function revealCurrent(slot) {
      const cur = rowsEl.querySelector('.row.current');
      if (!cur) return;
      const rRect = rowsEl.getBoundingClientRect();
      const cRect = cur.getBoundingClientRect();
      // Collapsed rail clips the strip; animating there would fight the hover
      // transition, so only move when we're in the scrollable (expanded) state.
      if (rowsEl.scrollHeight <= rowsEl.clientHeight + 1) return;
      const force = slot === SLOT_MID;
      const margin = 6;
      const within = cRect.top >= rRect.top + margin && cRect.bottom <= rRect.bottom - margin;
      if (!force && within) return;
      animateRailTo(railTargetOf(cur, typeof slot === 'number' ? slot : null));
    }
    let pinning = false;
    // Latch the highlight to a clicked turn until the user scrolls manually.
    let jumpLock = false;

    function currentFromScroll() {
      if (pinning || jumpLock) return;
      const els = turnEls(); if (!els.length || !turns.length) return;
      const vp = document.querySelector('[data-testid="autoscroll-viewport"]');
      const vpr = vp ? vp.getBoundingClientRect() : null;
      const top = vpr ? vpr.top : 0;
      const vpH = vpr ? vpr.height : 0;
      if (vp) {
        const maxScroll = vp.scrollHeight - vp.clientHeight;
        if (maxScroll > 0 && vp.scrollTop >= maxScroll - 4) {
          const key = keyOf(els[els.length - 1]);
          if (key != null && key !== currentKey) { currentKey = key; markCurrent(); }
          return;
        }
      }
      // "Current turn" = the last user-input-step whose top crossed a reference
      // line ~30% down the viewport — the turn you're actively reading. Keys are
      // the turn's absolute index, so the lit row is exactly that message.
      const ref = top + vpH * 0.3;
      let best = -1;
      els.forEach((e, i) => { if (e.getBoundingClientRect().top <= ref) best = i; });
      if (best < 0) best = 0;
      const key = keyOf(els[best]);
      if (key != null && key !== currentKey) { currentKey = key; markCurrent(); }
    }

    // ---- scrolling ------------------------------------------------------------
    // Clicking a row must move the conversation. Two approaches failed, both
    // measured live:
    //  · one long eased animation → the app swaps its rendered slice mid-flight,
    //    the clamped destination becomes the new max, you land at the bottom;
    //  · instant hops → the virtualizer re-anchors and yanks scrollTop back
    //    (observed: we set 40353, the app reset it to 4197).
    // What the app *does* handle well is a stream of ordinary scroll deltas. So we
    // walk there in viewport-sized steps (like a fast wheel scroll) and re-measure
    // by stable key every step, which keeps the target mounted the whole way.
    let jumpToken = 0;
    const jumpLog = [];
    const logJump = o => { jumpLog.push(o); if (jumpLog.length > 80) jumpLog.shift(); };

    function findElByKey(key) {
      for (const el of turnEls()) if (keyOf(el) === key) return el;
      return null;
    }

    // Ease the pane from A to B. Timer-driven (16ms) rather than rAF: an
    // occluded/unfocused window throttles rAF to a standstill and the animation
    // would simply never finish.
    let paneTimer = 0;
    function animatePaneTo(vp, target, duration) {
      const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
      target = Math.max(0, Math.min(max, Math.round(target)));
      clearTimeout(paneTimer);
      const from = vp.scrollTop, delta = target - from;
      if (Math.abs(delta) < 1) return Promise.resolve();
      const DUR = duration || Math.min(760, Math.max(240, Math.round(180 + Math.abs(delta) * 0.5)));
      const t0 = performance.now();
      let last = t0;
      return new Promise(resolve => {
        const step = () => {
          const now = performance.now();
          const gap = now - last; last = now;
          // If a single tick spans >200ms the window is occluded and timers are
          // throttled to ~1Hz — animating would take minutes, so snap to the end.
          if (gap > 200) { vp.scrollTop = target; resolve(); return; }
          const p = Math.min(1, (now - t0) / DUR);
          const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
          vp.scrollTop = from + delta * e;
          if (p < 1) paneTimer = setTimeout(step, 16); else resolve();
        };
        step();
      });
    }

    async function scrollToKey(key) {
      const vp = document.querySelector('[data-testid="autoscroll-viewport"]');
      if (!vp) return;
      const prevBehavior = vp.style.scrollBehavior;
      vp.style.scrollBehavior = 'auto';
      const token = ++jumpToken;
      pinning = true;
      const driftOf = el => el.getBoundingClientRect().top - vp.getBoundingClientRect().top - 8;
      try {
        // Fast path: the whole conversation is mounted (see ensureLoaded), so the
        // app has no windowed slice to re-anchor — a single eased scroll is stable
        // (measured: scrollTop 81k stayed put). The old viewport-by-viewport walk
        // needed ~1s per bite under timer throttling and crawled there in minutes.
        let el = findElByKey(key);
        if (el) {
          logJump({ i: 0, key, drift: Math.round(driftOf(el)), top: Math.round(vp.scrollTop), mounted: turnEls().length });
          await animatePaneTo(vp, vp.scrollTop + driftOf(el));
          if (token !== jumpToken) return;
          await sleep(90);
          const again = findElByKey(key);
          if (again) {
            const d = driftOf(again);
            logJump({ i: 1, key, drift: Math.round(d), top: Math.round(vp.scrollTop), mounted: turnEls().length });
            if (Math.abs(d) > 12) await animatePaneTo(vp, vp.scrollTop + d, 220);
          }
          return;
        }
        // Slow path: the target is not mounted. Head toward it in viewport-sized
        // bites until the app mounts it, then let the fast path land it.
        const t0 = performance.now();
        let stalls = 0;
        for (let i = 0; i < 120 && performance.now() - t0 < 6000; i++) {
          if (token !== jumpToken) return;              // a newer click took over
          const vh = vp.clientHeight || 800;
          const found = findElByKey(key);
          if (found) { await animatePaneTo(vp, vp.scrollTop + driftOf(found)); break; }
          const ks = turnEls().map(keyOf).filter(k => k != null);
          const step = ks.length
            ? (key > Math.max(...ks) ? vh * 0.9 : (key < Math.min(...ks) ? -vh * 0.9 : vh * 0.5))
            : vh * 0.9;
          const before = vp.scrollTop;
          vp.scrollTop = before + step;
          if (Math.abs(vp.scrollTop - before) < 1) {
            // Hit an edge (or the app refused): retry a few times, then stop.
            if (++stalls > 8) break;
            await sleep(60);
          } else stalls = 0;
          await sleep(16);
        }
      } finally {
        if (token === jumpToken) {
          vp.style.scrollBehavior = prevBehavior;
          pinning = false;
        }
      }
      // NOTE: no currentFromScroll() — jumpLock pins the highlight to the target.
    }

    function jump(turn) {
      // Light the row and slide the rail to it BEFORE the page starts moving, so
      // the highlight snaps straight to the middle of the strip ("马上").
      currentKey = turn.key;
      markCurrent(SLOT_MID);
      jumpLock = true;
      // No pre-mounting here: a full re-mount resets the scroll position and
      // defeats the walk. scrollToKey handles a not-yet-mounted target by heading
      // in its direction until the app mounts it.
      scrollToKey(turn.key).catch(() => { pinning = false; });
    }

    // ---- position: dock to the conversation pane's left edge, follow layout ----
    let raf = null;
    function reposition() {
      raf = null;
      const pane = document.querySelector('[data-testid="conversation-view"]')
        || document.querySelector('[data-testid="overview-panel-host"]')
        || document.querySelector('[data-testid="autoscroll-viewport"]');
      if (!pane) return;
      const r = pane.getBoundingClientRect();
      if (r.width < 80) return;
      rail.style.right = 'auto';
      rail.style.left = Math.round(r.left + 14) + 'px';
      rail.style.top = Math.round(r.top + r.height / 2) + 'px';
    }
    const scheduleReposition = () => { if (!raf) raf = requestAnimationFrame(reposition); };

    function buildTurns() {
      const list = [];
      let missing = [];
      turnEls().forEach((el, i) => {
        const key = keyOf(el);
        if (key == null) { missing.push({ el, i }); return; }
        const { text, date } = splitLabel(el.textContent || '', el);
        const hasImg = !!el.querySelector('img');
        list.push({ key, text: text || (hasImg ? '' : '（空）'), date, hasImg });
      });
      // Extremely rare: fiber props unavailable. Fall back to DOM order for the
      // whole batch instead of mixing synthetic indices into real step keys
      // (a mixed set would collide with genuine keys and make rows flap).
      if (!list.length && missing.length) {
        missing.forEach(({ el, i }) => {
          const { text, date } = splitLabel(el.textContent || '', el);
          const hasImg = !!el.querySelector('img');
          list.push({ key: i, text: text || (hasImg ? '' : '（空）'), date, hasImg });
        });
      }
      list.sort((a, b) => a.key - b.key);
      return list;
    }
    // MERGE, never replace. The app only renders a window of steps, so whichever
    // slice happens to be in the DOM at poll time used to define the whole list —
    // that is why the rail grew and shrank ("历史时长时短"). Keys are absolute
    // step indices, so unioning them gives a list that only ever grows toward the
    // full conversation and never loses rows you already saw.
    function syncTurns() {
      const next = buildTurns();
      if (!next.length) return false;
      const map = new Map(turns.map(t => [t.key, t]));
      let changed = false;
      for (const t of next) {
        const old = map.get(t.key);
        if (!old) { map.set(t.key, t); changed = true; }
        else if (old.text !== t.text || old.date !== t.date || old.hasImg !== t.hasImg) { map.set(t.key, t); changed = true; }
      }
      if (!changed) return false;
      turns = [...map.values()].sort((a, b) => a.key - b.key);
      // render() already re-applies `.current` from currentKey — deliberately no
      // markCurrent() here, so a passive merge can never move the strip under
      // the user's cursor.
      render();
      return true;
    }

    // Per-conversation cache. The rail list must NEVER be rebuilt from scratch
    // off the DOM (the DOM only holds a window of steps), and must survive a
    // transient missing convId or a momentary route change — resetting here was
    // what made the list shrink to whatever happened to be mounted (97 → 27).
    const lists = new Map();
    async function refresh() {
      const id = convId();
      if (!id) return;                      // transient: keep what we have
      if (id !== lastId) {
        lastId = id;
        aspCache = null;
        loadedFor = null;
        turns = lists.get(id) || [];
        currentKey = null;
        render();
      }
      await ensureLoaded();
      syncTurns();
      lists.set(id, turns);
      currentFromScroll();
    }

    // A jump must be something the user asked for. The strip sits over the left
    // edge of the transcript, and hovering used to expand it instantly — a click
    // aimed at whatever was underneath landed on a row and yanked the conversation
    // to a much earlier turn ("打开侧边栏后莫名其妙跳走"). Two guards:
    //  · expansion waits for a short dwell, so a cursor just passing through never
    //    turns the 13px strip into a 300px click target;
    //  · a row click only counts when the press itself started on an open rail.
    let openAt = 0;
    let openTimer = 0;
    let downOnOpenRail = false;
    const HOVER_INTENT = 300;
    function openRail() {
      if (rail.classList.contains('open')) return;
      rail.classList.add('open');
      openAt = performance.now();
      revealCurrent();
    }
    function closeRail() {
      if (!rail.classList.contains('open')) return;
      rail.classList.remove('open');
      openAt = 0;
    }
    rail.addEventListener('pointerdown', () => {
      downOnOpenRail = rail.classList.contains('open') || rail.classList.contains('expanded');
    }, true);
    rowsEl.addEventListener('click', e => {
      const row = e.target.closest('.row'); if (!row || row.dataset.key == null) return;
      if (!downOnOpenRail) return;                 // press began on the bare strip
      if (openAt && performance.now() - openAt < 220) return;  // panel just appeared
      const key = Number(row.dataset.key);
      const turn = turns.find(t => t.key === key);
      if (turn) jump(turn);
    });

    document.addEventListener('scroll', () => { scheduleReposition(); currentFromScroll(); }, true);
    const releaseJumpLock = () => { if (jumpLock) { jumpLock = false; currentFromScroll(); } };
    window.addEventListener('wheel', releaseJumpLock, { passive: true });
    window.addEventListener('touchmove', releaseJumpLock, { passive: true });
    window.addEventListener('keydown', e => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) releaseJumpLock();
    }, { passive: true });
    window.addEventListener('resize', scheduleReposition);
    // The collapsed strip and the expanded one have different padding, so the
    // row measured while collapsed sits a few px off after hovering. Re-align on
    // hover (after the width/padding transition settles) instead of leaving the
    // lit row half-clipped.
    // Hover intent instead of instant expansion (see the click guard above). Once
    // open, the collapsed→expanded padding flips, so re-align the lit row after the
    // transition settles rather than leaving it half-clipped.
    rail.addEventListener('mouseenter', () => {
      clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        openRail();
        if (currentKey == null) return;
        requestAnimationFrame(() => requestAnimationFrame(() => revealCurrent()));
      }, HOVER_INTENT);
    });
    rail.addEventListener('mouseleave', () => { clearTimeout(openTimer); closeRail(); });
    setInterval(() => { syncTurns(); currentFromScroll(); scheduleReposition(); }, 800);
    try { new ResizeObserver(scheduleReposition).observe(document.body); } catch {}
    try {
      const pane = document.querySelector('[data-testid="conversation-view"]');
      if (pane) new ResizeObserver(scheduleReposition).observe(pane);
    } catch {}

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; lastId = null; refresh(); scheduleReposition(); }
    }, 800);

    refresh();
    scheduleReposition();
    window.__agTurnNav = {
      refresh,
      expand: v => { rail.classList.toggle('expanded', !!v); revealCurrent(); },
      jumpKey: k => { const t = turns.find(x => x.key === k); return t ? jump(t) : Promise.resolve(); },
      get turns() { return turns; },
      get jumpLog() { return jumpLog.slice(); },
    };
  }

  install();
})();
