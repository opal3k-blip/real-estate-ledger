// R1-B2 / B2-2b-b0 — FOCUS KEEPER: keeps what the person is typing alive across core.render(), which replaces #app.innerHTML on every call.
// Contract (no change to core.js): the keeper TRACKS the live field continuously (focusin / input / selection / scroll / composition events) and, from the
// existing render-end hook, puts the tracked state back on the NEW element with the same data-fvp-field key. It never owns a value: the unsent text lives in the
// actions state; the keeper only re-seats the DOM (focus, caret, scroll, and — only if the new DOM disagrees with what was just typed — the typed value, counted).
// It does nothing to session data: clear() drops every tracked value at once and is the first thing a teardown / permission loss / view exit calls.
export const FIELD_ATTR = 'data-fvp-field';
export const SECTION_ATTR = 'data-fvp-section';   // the fallback: when the focused field is gone, focus goes to its section (tabindex=-1), not to <body>
export const SCROLL_ATTR = 'data-fvp-scroll';
const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'password', 'email', 'number', '']);

export const POPUP_MAX_MS = 30000;   // the longest a list may be held open with no other sign of life (the popup state itself cannot be read)

export function createFocusKeeper({ doc, win, getRoot, onLost, now } = {}) {
  const D = doc || (typeof document !== 'undefined' ? document : null);
  const W = win || (typeof window !== 'undefined' ? window : null);
  const rootOf = () => (getRoot ? getRoot() : D && D.getElementById('app'));
  let attached = false; let cur = null; let restoring = false; let compEl = null; let quiet = false; let sectionKey = null; let composing = false; let scrolls = new Map(); let winY = 0; let winX = 0; let pressEl = null; let popupEl = null; let popupAt = 0;
  const clock = () => (typeof now === 'function' ? now() : Date.now());
  const stats = { restored: 0, valueRepaired: 0, lost: 0, renders: 0, composingSkips: 0 };

  const inField = (el) => !!(el && el.closest && el.hasAttribute && el.hasAttribute(FIELD_ATTR) && rootOf() && rootOf().contains(el));
  const keyOf = (el) => el.getAttribute(FIELD_ATTR);
  const canSelect = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase()));
  function snap(el) {
    if (quiet || !inField(el)) return;
    const c = { key: keyOf(el), tag: el.tagName, type: (el.getAttribute('type') || '').toLowerCase() };
    if (el.type === 'checkbox' || el.type === 'radio') c.checked = el.checked; else c.value = el.value;
    try { if (canSelect(el) && el.selectionStart != null) { c.s = el.selectionStart; c.e = el.selectionEnd; c.dir = el.selectionDirection; } } catch (e) { /* number inputs have no selection */ }
    const sec = el.closest('[' + SECTION_ATTR + ']'); sectionKey = sec ? sec.getAttribute(SECTION_ATTR) : null;
    cur = c;
  }
    const onInput = (ev) => { if (!restoring && inField(ev.target)) snap(ev.target); };
  const onSel = () => { if (restoring) return; const a = D.activeElement; if (a && cur && inField(a) && keyOf(a) === cur.key) snap(a); };
  // NOT focusout/blur: Chromium fires blur on a node that a render is about to remove, so a blur cannot tell the person's leaving from a render.
  // The person's leaving is a focusin on something that is not one of our fields, or a press outside the fields.
  const onFocusIn2 = (ev) => { if (restoring) return; const t = ev.target; if (inField(t)) { quiet = false; snap(t); } else if (t && t !== D.body && t !== D.documentElement && !composing) cur = null; };
  const onDown = (ev) => { const t = ev.target; if (!(t && t.closest && t.closest('[' + FIELD_ATTR + ']')) && !composing) cur = null; };
  // An open <select> popup lives on its node: a render that replaces the node closes it (found on Edge and Chrome under the storm). Its state cannot be read, so the render waits from the press that
  // opens it (mouse-down; Alt+Down / F4 / Space) until it is over: a value is chosen (change), focus leaves the select or the window, Escape / Tab / Enter, a second press on it (toggle), or POPUP_MAX_MS.
  const isSelectField = (t) => !!(t && t.tagName === 'SELECT' && inField(t));
  const onPopupDown = (ev) => { const t = ev.target; if (ev.button != null && ev.button !== 0) return; if (isSelectField(t)) { if (popupEl === t) popupEl = null; else { popupEl = t; popupAt = clock(); } } else popupEl = null; };
  const onPopupKey = (ev) => {  // keydown AND keyup: with the popup open Chrome delivers only the key-UP of Escape / Enter to the page (measured), so a closing key must be honoured on both
    if (ev.type === 'keyup') { if (ev.key === 'Escape' || ev.key === 'Tab' || ev.key === 'Enter') popupEl = null; return; }
    const t = ev.target; const k = ev.key;
    if (k === 'Escape' || k === 'Tab' || k === 'Enter') { popupEl = null; return; }
    if (isSelectField(t) && ((ev.altKey && (k === 'ArrowDown' || k === 'ArrowUp')) || k === 'F4' || k === ' ' || ev.code === 'Space') && !ev.repeat) { popupEl = t; popupAt = clock(); }
  };
  const onPopupChange = (ev) => { if (popupEl && ev.target === popupEl) popupEl = null; };
  const onScroll = (ev) => {
    const t = ev.target;
    if (t === D || t === W || t === D.documentElement) { winY = W.scrollY; winX = W.scrollX; return; }
    if (t && t.getAttribute && t.hasAttribute(SCROLL_ATTR)) scrolls.set(t.getAttribute(SCROLL_ATTR), { top: t.scrollTop, left: t.scrollLeft });
  };
  // Space on a checkbox / radio / button activates it on KEY-UP. A render between the key-down and the key-up replaces the element: the key-up lands on a new node that never saw
  // the key-down, and the activation is lost (found with the T5/T6 probe). So the render waits for the key-up — held only while the pressed node is still on the page and focused.
  const isPressable = (t) => !!(t && t.tagName && (t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && /^(checkbox|radio|button|submit|reset)$/i.test(t.type || ''))));
  const onKeyDown = (ev) => { if (ev.repeat || !(ev.key === ' ' || ev.code === 'Space')) return; const t = ev.target; const root = rootOf(); if (isPressable(t) && root && root.contains(t)) pressEl = t; };
  const isSpace = (ev) => !!ev && (ev.key === ' ' || ev.code === 'Space');
  const onKeyUp2 = (ev) => { if (isSpace(ev)) pressEl = null; };   // ONLY the release of Space ends a Space press: another key (Shift, Tab...) coming up does not
  const onWinBlur = () => { pressEl = null; popupEl = null; };   // the window lost focus: a key-up may now go to another window and never reach us, so the press is dropped, not suspended
  const onCompStart = (ev) => { composing = true; compEl = (ev && ev.target) || null; };
  const onCompEnd = () => { composing = false; compEl = null; onSel(); };

  function attach() {
    if (attached || !D) return; attached = true;
    D.addEventListener('focusin', onFocusIn2, true); D.addEventListener('mousedown', onDown, true); D.addEventListener('input', onInput, true); D.addEventListener('change', onInput, true);
    D.addEventListener('keyup', onSel, true); D.addEventListener('keydown', onKeyDown, true); D.addEventListener('keyup', onKeyUp2, true); D.addEventListener('mouseup', onSel, true); D.addEventListener('selectionchange', onSel, true);
    D.addEventListener('scroll', onScroll, true);
    D.addEventListener('compositionstart', onCompStart, true); D.addEventListener('compositionend', onCompEnd, true);
    D.addEventListener('mousedown', onPopupDown, true); D.addEventListener('keydown', onPopupKey, true); D.addEventListener('keyup', onPopupKey, true); D.addEventListener('change', onPopupChange, true);
    if (W && W.addEventListener) W.addEventListener('blur', onWinBlur, false);
  }
  function detach() {
    if (!attached) return; attached = false;
    for (const [n, f, c] of [['focusin', onFocusIn2, 1], ['mousedown', onDown, 1], ['input', onInput, 1], ['change', onInput, 1], ['keyup', onSel, 1], ['keydown', onKeyDown, 1], ['keyup', onKeyUp2, 1], ['mouseup', onSel, 1], ['selectionchange', onSel, 1], ['scroll', onScroll, 1], ['compositionstart', onCompStart, 1], ['compositionend', onCompEnd, 1], ['mousedown', onPopupDown, 1], ['keydown', onPopupKey, 1], ['keyup', onPopupKey, 1], ['change', onPopupChange, 1]]) D.removeEventListener(n, f, !!c);
    if (W && W.removeEventListener) W.removeEventListener('blur', onWinBlur, false);
  }
  /** Drop everything tracked. Called FIRST on session teardown, permission loss and view exit: nothing typed survives, nothing waits for a render. */
  /** true only while a composition is OPEN ON A LIVE NODE: the node that started it is one of our fields and still has focus (a node that left the page has lost focus too). Time plays no part:
      a composition that is really going on is never timed out (a forced render would break it), and one whose node was replaced or lost focus is over
      (the browser has already committed or dropped it), so it can never hold a gate. */
  const isComposing = () => !!(composing && compEl && D.activeElement === compEl && inField(compEl));
  // After clear() NOTHING is tracked again until the person focuses a field herself: Chromium commits an open composition when its node is removed and fires `input`
  // on it while it is still attached, so an event that merely ARRIVES after the clear must never re-seat the old text (possibly into another user's session).
  /** Read the live field's value and selection, and the scroll positions, NOW. Called at the START of every render (via the gate hook): a caret move whose `selectionchange` has not been delivered yet
      (arrow key pressed, render timer fires before the event) would otherwise be lost to the re-seat. Reads only; does nothing after clear() until she focuses a field herself. */
  function captureLive() {
    if (restoring || quiet || !D) return;
    // scroll positions too: a scroll event is delivered once per frame, AFTER the scroll happened; a render that comes first would re-seat the OLD position and undo the person's scroll
    // (found with the T5/T6 probe: the inner scroller jumped back to a stale offset in ~5% of loaded runs)
    const root = rootOf(); if (root) for (const el of root.querySelectorAll('[' + SCROLL_ATTR + ']')) scrolls.set(el.getAttribute(SCROLL_ATTR), { top: el.scrollTop, left: el.scrollLeft });
    if (W) { winY = W.scrollY; winX = W.scrollX; }
    const a = D.activeElement; if (a && inField(a)) snap(a);
  }
  function clear() { cur = null; composing = false; compEl = null; pressEl = null; popupEl = null; scrolls = new Map(); quiet = true; sectionKey = null; }

  /** Render-end hook: the DOM was just rebuilt. Re-seat focus / caret / scroll on the element with the same key. */
  function afterRender() {
    stats.renders += 1;
    const root = rootOf(); if (!root) return { status: 'no_root' };
    for (const [k, p] of scrolls) { const el = root.querySelector(`[${SCROLL_ATTR}="${cssEsc(k)}"]`); if (el) { el.scrollTop = p.top; el.scrollLeft = p.left; } }
    if (W && (W.scrollY !== winY || W.scrollX !== winX)) W.scrollTo(winX, winY);
    if (!cur) return { status: 'nothing_tracked' };
    const c = cur;                                                     // a local copy: focusing below fires our own listeners, which must not overwrite it
    restoring = true;
    try {
      const el = c.section ? null : root.querySelector(`[${FIELD_ATTR}="${cssEsc(c.key)}"]`);
      if (!el) {
        const sec = sectionKey ? root.querySelector(`[${SECTION_ATTR}="${cssEsc(sectionKey)}"]`) : null;
        const wasField = !c.section;
        if (wasField) { stats.lost += 1; if (onLost) { try { onLost({ key: c.key }); } catch (e) { /* ignore */ } } }
        if (sec) { try { sec.focus({ preventScroll: true }); } catch (e) { sec.focus(); } cur = { key: sectionKey, section: true }; return { status: wasField ? 'lost' : 'section', key: c.key }; }
        cur = null; return { status: 'lost', key: c.key };
      }
      if (composing) stats.composingSkips += 1;                          // an IME composition cannot survive a replaced node; the gate (if approved) is what prevents this
      if (c.checked !== undefined) { if (el.checked !== c.checked) { el.checked = c.checked; stats.valueRepaired += 1; } }
      else if (c.value !== undefined && el.value !== c.value) { el.value = c.value; stats.valueRepaired += 1; }
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      try { if (c.s != null && canSelect(el)) el.setSelectionRange(c.s, c.e, c.dir || 'none'); } catch (e) { /* ignore */ }
      stats.restored += 1;
    } finally { restoring = false; }
    return { status: 'restored', key: cur.key };
  }
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
  /** true while a Space press on a button/checkbox/radio is open on a live, focused node of the page (and the window still has focus: a key-up lost with the window ends the hold) */
  const isPressing = () => { if (!pressEl) return false; const live = !!(pressEl.isConnected && D.activeElement === pressEl && (!D.hasFocus || D.hasFocus())); if (!live) pressEl = null; return live; };   // a press that is not live is DROPPED here too (no blur event needed): it cannot come back with the focus
  /** true while a mouse- or keyboard-opened list of a <select> field is (as far as can be told) open: the node is on the page and focused, the window has focus and POPUP_MAX_MS has not passed.
      Anything else DROPS the hold for good: it does not come back with the focus. */
  const isPopupOpen = () => { if (!popupEl) return false; const live = !!(popupEl.isConnected && inField(popupEl) && D.activeElement === popupEl && (!D.hasFocus || D.hasFocus()) && clock() - popupAt < POPUP_MAX_MS); if (!live) popupEl = null; return live; };
  const holds = () => isComposing() || isPressing() || isPopupOpen();
  return { attach, detach, clear, afterRender, captureLive, isComposing, isPressing, isPopupOpen, holds, stats: () => ({ ...stats, tracked: cur ? cur.key : null, composing }), tracked: () => (cur ? { ...cur } : null) };
}
