/* CourtFit: workout tracker.
   Data lives in Supabase (tables exercises, routines, workouts, history).
   Access: the link's ?k= code is sent as x-app-key on every request; the
   database's row-level security refuses requests without it.
   The workout in progress is kept on this phone until it is finished. */
(() => {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const $tabbar = document.getElementById('tabbar');
  const $live = document.getElementById('liveslot');
  const $install = document.getElementById('installslot');
  const CFG = window.COURTFIT_CONFIG || {};
  const QS = new URLSearchParams(location.search);
  const KEY = QS.get('k') || '';
  // Local preview without a database (only on this computer).
  const DEMO = QS.get('demo') === '1' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const LB_KG = 0.45359237, DAY = 86400000;

  const MUSCLES = ['Glutes', 'Hamstrings', 'Quads', 'Calves', 'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Core', 'Full Body', 'Cardio'];
  const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Smith Machine', 'Other'];

  const S = {
    sb: null, myName: '', exercises: [], routines: [], workouts: [], active: null,
    loaded: false, offline: false, outbox: [], view: { name: 'home' }, pendingRender: false,
    search: '', muscle: null, exMetric: 'heaviest', profMetric: 'workouts', rMetric: 'volume',
    calMonth: firstOfMonth(Date.now()), routinesOpen: true
  };

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
    del(k) { try { localStorage.removeItem(k); } catch { } }
  };
  const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const appUrl = () => location.origin + location.pathname + '?k=' + encodeURIComponent(KEY);
  function firstOfMonth(t) { const d = new Date(t); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = (t) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
  const fmtDate = (t, o) => new Date(t).toLocaleDateString(undefined, o || { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function fmtDur(ms) { const s = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return hh ? `${hh}h ${m}m` : m ? `${m}m` : `${s}s`; }
  function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60, p = (n) => String(n).padStart(2, '0'); return hh ? `${hh}:${p(m)}:${p(x)}` : `${m}:${p(x)}`; }
  const num1 = (v) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };

  // Weights are stored in pounds; shown in the unit this phone prefers.
  const isKg = () => ls.get('cf-unit') === 'kg';
  const unit = () => isKg() ? 'kg' : 'lbs';
  const disp = (lbs) => isKg() ? (lbs || 0) * LB_KG : (lbs || 0);
  const store = (v) => isKg() ? v / LB_KG : v;
  const fw = (lbs) => num1(disp(lbs));
  const fwu = (lbs) => `${fw(lbs)} ${unit()}`;
  const fvol = (lbs) => `${Math.round(disp(lbs)).toLocaleString()} ${unit()}`;
  const restSecs = () => Number(ls.get('cf-rest') || 90);

  let toastTimer;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    $toast.replaceChildren(...[h('span', { text: msg }), action ? h('button', { type: 'button', class: 'toastbtn', text: action.label, onclick: () => { $toast.hidden = true; action.run(); } }) : null].filter(Boolean));
    $toast.hidden = false;
    toastTimer = setTimeout(() => { $toast.hidden = true; }, action ? 7000 : 2800);
  }
  function go(hash) { if (location.hash === hash || (hash === '' && !location.hash)) route(); else location.hash = hash; }
  function goBack(fallback) { if (history.length > 1) history.back(); else go(fallback || ''); }
  function showErr(e) { console.error(e); toast('Could not save: ' + ((e && e.message) || 'unknown problem') + '. Try again.'); }
  const field = (label, input) => h('label', { class: 'f' }, h('span', { text: label }), input);
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(name, cls = 'ic') {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#i-' + name); s.append(u);
    return s;
  }
  function svgFrom(str) { const d = document.createElement('div'); d.innerHTML = str; return d.firstElementChild; }
  const muscleIcon = (m) => ({ Glutes: 'legs', Hamstrings: 'legs', Quads: 'legs', Calves: 'legs', Back: 'back-m', Biceps: 'arm', Core: 'core', Cardio: 'heart', 'Full Body': 'sparkle' }[m] || 'dumbbell');
  const thumb = (m, size) => h('span', { class: 'thumbic' + (size ? ' ' + size : '') }, icon(muscleIcon(m)));

  // ---------- exercises, workouts ----------
  const findEx = (id) => S.exercises.find(e => e.id === id);
  const exLabel = (ex) => !ex ? 'Deleted exercise' : (ex.equipment && !['Bodyweight', 'Other'].includes(ex.equipment) ? `${ex.name} (${ex.equipment})` : ex.name);
  const exLabelId = (id) => exLabel(findEx(id));
  const doneSets = (entry) => (entry.sets || []).filter(s => s.done);
  const setsOf = (w) => (w.exercises || []).flatMap(doneSets);
  const volumeOf = (w) => setsOf(w).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
  const repsOf = (w) => setsOf(w).reduce((a, s) => a + (s.reps || 0), 0);
  const durOf = (w) => (w.end || Date.now()) - w.start;
  const e1rm = (s) => !s.reps ? 0 : s.reps === 1 ? (s.weight || 0) : (s.weight || 0) * (1 + s.reps / 30);
  const finished = () => [...S.workouts].sort((a, b) => b.start - a.start);
  function bestSet(entry) {
    let best = null;
    for (const s of doneSets(entry)) if (!best || (s.weight || 0) > (best.weight || 0) || ((s.weight || 0) === (best.weight || 0) && (s.reps || 0) > (best.reps || 0))) best = s;
    return best;
  }
  function previousSets(exerciseId, excludeId, before) {
    for (const w of finished()) {
      if (w.id === excludeId || (before && w.start >= before)) continue;
      const e = (w.exercises || []).find(x => x.exerciseId === exerciseId && doneSets(x).length);
      if (e) return doneSets(e);
    }
    return [];
  }
  const historyFor = (exerciseId) => finished().flatMap(w => (w.exercises || []).filter(e => e.exerciseId === exerciseId && doneSets(e).length).map(entry => ({ entry, w })));
  const setLabel = (sets, i) => { const k = sets[i].kind; if (k === 'warmup') return 'W'; if (k === 'drop') return 'D'; if (k === 'failure') return 'F'; return String(sets.slice(0, i + 1).filter(s => !s.kind || s.kind === 'normal').length); };
  const firstNum = (t) => { const m = String(t || '').match(/\d+/); return m ? Number(m[0]) : null; };
  const sortedRoutines = () => [...S.routines].sort((a, b) => (a.order ?? a.created ?? 0) - (b.order ?? b.created ?? 0));

  // ---------- data: Supabase + offline outbox + undo ----------
  const TABLES = ['exercises', 'routines', 'workouts'];
  const listOf = (t) => S[t];
  const setList = (t, arr) => { S[t] = arr; };
  const toRow = (t, obj) => { const data = clone(obj); delete data.id; return { id: obj.id, data }; };
  const fromRow = (t, r) => ({ ...(r.data || {}), id: r.id });
  function applyLocal(op) {
    const arr = listOf(op.table).filter(x => x.id !== (op.op === 'put' ? op.row.id : op.id));
    if (op.op === 'put') arr.push(fromRow(op.table, op.row));
    setList(op.table, arr);
  }
  function saveCache() { ls.set('cf-cache', JSON.stringify({ exercises: S.exercises, routines: S.routines, workouts: S.workouts, at: Date.now() })); }
  function loadCache() {
    try { const c = JSON.parse(ls.get('cf-cache') || 'null'); if (c) { S.exercises = c.exercises || []; S.routines = c.routines || []; S.workouts = c.workouts || []; return true; } } catch { }
    return false;
  }
  const saveOutbox = () => ls.set('cf-outbox', JSON.stringify(S.outbox));
  const isNetErr = (err) => !!err && (err instanceof TypeError || /fetch|network|load failed|offline|timed? ?out/i.test(String(err.message || err)));
  async function exec(op) {
    const q = op.op === 'put' ? S.sb.from(op.table).upsert(op.row) : S.sb.from(op.table).delete().eq('id', op.id);
    const { error } = await q;
    if (error) throw error;
  }
  let offlineToastShown = false;
  async function send(op) {
    applyLocal(op);
    if (!S.sb) { saveCache(); return; }
    if (!S.outbox.length && navigator.onLine !== false) {
      try { await exec(op); saveCache(); announce(op.table); return; }
      catch (err) { if (!isNetErr(err)) { await loadTable(op.table).catch(() => {}); render(true); throw err; } }
    }
    S.outbox.push(op); saveOutbox(); saveCache(); S.offline = true;
    if (!offlineToastShown) { offlineToastShown = true; toast('No signal. Saved on this phone; it will sync when you are back online.'); }
  }
  let flushing = false;
  async function flush() {
    if (flushing || !S.outbox.length || !S.sb) return;
    flushing = true;
    let sent = 0;
    try {
      while (S.outbox.length) {
        try { await exec(S.outbox[0]); S.outbox.shift(); saveOutbox(); sent++; }
        catch (err) { if (isNetErr(err)) break; console.error('Dropped change that the server refused', err, S.outbox[0]); S.outbox.shift(); saveOutbox(); }
      }
    } finally { flushing = false; }
    if (sent) { toast(`Synced ${sent} change${sent === 1 ? '' : 's'} made offline`); TABLES.forEach(announce); await loadAll(); }
  }
  let tx = null;
  async function put(t, obj, rec = true) { const before = clone(listOf(t).find(x => x.id === obj.id) || null); if (rec && tx) tx.push({ t, id: obj.id, before }); await send({ op: 'put', table: t, row: toRow(t, obj) }); }
  async function del(t, id, rec = true) { const before = clone(listOf(t).find(x => x.id === id) || null); if (rec && tx) tx.push({ t, id, before }); await send({ op: 'del', table: t, id }); }
  async function action(label, fn) {
    tx = [];
    let ops;
    try { await fn(); } catch (e) { showErr(e); } finally { ops = tx; tx = null; }
    render(true);
    if (ops.length && label) toast(label, { label: 'Undo', run: () => undoOps(ops) });
  }
  async function undoOps(ops) {
    try {
      for (const o of [...ops].reverse()) { if (o.before) await put(o.t, o.before, false); else await del(o.t, o.id, false); }
      toast('Undone'); render(true);
    } catch (e) { showErr(e); }
  }
  async function loadTable(t) {
    const { data, error } = await S.sb.from(t).select('*');
    if (error) throw error;
    setList(t, data.map(r => fromRow(t, r)));
  }
  async function loadAll() {
    try {
      await Promise.all(TABLES.map(loadTable));
      for (const op of S.outbox) applyLocal(op);
      S.loaded = true; S.offline = S.outbox.length > 0; saveCache();
    } catch (err) {
      console.error(err);
      if (!S.loaded && loadCache()) { for (const op of S.outbox) applyLocal(op); }
      S.loaded = true; S.offline = true;
    }
    render();
  }
  let channel;
  function announce(t) { if (channel) channel.send({ type: 'broadcast', event: 'changed', payload: { table: t } }).catch(() => {}); }

  // The workout in progress lives on this phone only.
  function saveActive() { if (S.active) ls.set('cf-active', JSON.stringify(S.active)); else ls.del('cf-active'); }
  function loadActive() { try { S.active = JSON.parse(ls.get('cf-active') || 'null'); } catch { S.active = null; } }

  // ---------- routing / render ----------
  function parseHash() {
    const s = location.hash.slice(1); let m;
    if (s === 'workout') return { name: 'workout' };
    if (s === 'profile') return { name: 'profile' };
    if (s === 'exercises') return { name: 'exercises' };
    if (s === 'settings') return { name: 'settings' };
    if (s === 'active') return { name: 'active' };
    if ((m = s.match(/^routine-([A-Za-z0-9_-]+)$/))) return { name: 'routine', id: m[1] };
    if ((m = s.match(/^ex-([A-Za-z0-9_-]+)$/))) return { name: 'exercise', id: m[1] };
    if ((m = s.match(/^w-([A-Za-z0-9_-]+)$/))) return { name: 'wdetail', id: m[1] };
    return { name: 'home' };
  }
  function route() {
    S.view = parseHash();
    closeSheets();
    render(true); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function render(force) {
    const v = S.view;
    if (!force) {
      const a = document.activeElement;
      if (a && $app.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { S.pendingRender = true; return; }
      if (v.name === 'active') { S.pendingRender = true; return; }
    }
    S.pendingRender = false;
    const y = window.scrollY;
    let node;
    if (S.setupMissing) node = msg('Setup needed', 'Add the Supabase project URL and key to config.js.');
    else if (S.badLink) node = msg('This link is incomplete', 'Open CourtFit with the full link you were sent. It ends with ?k= and a long code.');
    else if (S.needName) node = nameView();
    else if (!S.loaded) node = msg('Loading CourtFit…', 'Getting your workouts.');
    else if (v.name === 'active' && S.active) node = activeView();
    else if (v.name === 'active') { node = workoutView(); history.replaceState(null, '', '#workout'); S.view = { name: 'workout' }; }
    else if (v.name === 'workout') node = workoutView();
    else if (v.name === 'routine') node = routineView(v.id);
    else if (v.name === 'exercises') node = exercisesView();
    else if (v.name === 'exercise') node = exerciseView(v.id);
    else if (v.name === 'wdetail') node = workoutDetail(v.id);
    else if (v.name === 'profile') node = profileView();
    else if (v.name === 'settings') node = settingsView();
    else node = homeView();
    const banner = S.offline ? h('div', { class: 'banner' },
      'No connection. Showing what is saved on this phone.',
      S.outbox.length ? ` ${S.outbox.length} change${S.outbox.length === 1 ? '' : 's'} will sync when you are back online.` : '') : null;
    $app.replaceChildren(...[banner, node].filter(Boolean));
    if (!force) window.scrollTo(0, y);
    updateChrome();
  }
  $app.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && S.view.name !== 'active') render(); }, 0));
  const msg = (t, p) => h('div', { class: 'empty', style: 'margin-top:12vh' }, h('h2', { text: t }), h('p', { text: p }));
  const backLink = (href, text) => h('a', { class: 'back', href }, icon('back'), text);
  const topbar = (...kids) => h('div', { class: 'top' }, ...kids);
  const sectionhd = (title, right) => h('div', { class: 'sectionhd' }, h('h2', { text: title }), right || null);

  // ---------- chrome: tab bar, workout bar, install bar ----------
  function tabFor(v) {
    if (['workout', 'routine', 'active'].includes(v.name)) return 'workout';
    if (['profile', 'exercises', 'exercise', 'settings'].includes(v.name)) return 'profile';
    return 'home';
  }
  function updateChrome() {
    const ready = !S.setupMissing && !S.badLink && !S.needName && S.loaded;
    const inWorkout = ready && S.view.name === 'active' && !!S.active;
    $tabbar.hidden = !ready || inWorkout;
    document.body.classList.toggle('in-workout', inWorkout);
    const tab = tabFor(S.view);
    for (const a of $tabbar.querySelectorAll('a')) { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    drawLive(ready && !inWorkout && !!S.active);
    drawInstall(ready && !inWorkout && !S.active);
    drawRest();
  }
  function drawLive(show) {
    document.body.classList.toggle('with-banner', show);
    if (!show) { $live.replaceChildren(); return; }
    $live.replaceChildren(h('button', { type: 'button', class: 'livebar', onclick: () => go('#active'), 'aria-label': 'Workout in progress. Resume.' },
      h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      isLive(S.active) ? h('span', { class: 'txt' }, h('b', { text: S.active.name }), 'In progress · ', h('span', { class: 'num', 'data-clock': '', text: fmtClock(Date.now() - S.active.start) }))
        : h('span', { class: 'txt' }, h('b', { text: S.active.name }), S.active.mode === 'edit' ? 'Editing, not saved yet' : 'Past workout, not saved yet'),
      h('span', { class: 'pill', text: isLive(S.active) ? 'Resume' : 'Open' })));
  }

  // Add to Home Screen: Android/desktop Chrome can install directly; iPhone needs the Share menu.
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); deferredInstall = ev; updateChrome(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; ls.set('cf-installed', '1'); updateChrome(); });
  const standalone = () => navigator.standalone === true || (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches));
  const onIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function iosBrowser() {
    const ua = navigator.userAgent;
    if (/FBAN|FBAV|Instagram|Line\/|GSA\/|Snapchat|LinkedInApp|MicroMessenger/.test(ua)) return 'inapp';
    if (/CriOS/.test(ua)) return 'chrome';
    if (/FxiOS/.test(ua)) return 'firefox';
    if (/EdgiOS/.test(ua)) return 'edge';
    return 'safari';
  }
  let installHiddenThisVisit = false;
  function drawInstall(ready) {
    const show = ready && !standalone() && !installHiddenThisVisit && (deferredInstall || onIOS());
    document.body.classList.toggle('with-install', !!show);
    if (!show) { $install.replaceChildren(); return; }
    if ($install.firstChild) return;
    $install.append(h('div', { class: 'installbar', role: 'region', 'aria-label': 'Add to Home Screen' },
      h('img', { src: 'logo-180.png', alt: '' }),
      h('div', { class: 'txt' }, h('b', { text: 'Get the CourtFit app' }), 'Opens full screen from your home screen'),
      h('button', { class: 'primary small', type: 'button', text: 'Install', 'aria-label': 'Add to Home Screen', onclick: startInstall }),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Hide for now', text: '✕', onclick: () => { installHiddenThisVisit = true; updateChrome(); } })));
  }
  async function startInstall() {
    if (deferredInstall) {
      deferredInstall.prompt();
      try { const r = await deferredInstall.userChoice; if (r && r.outcome === 'accepted') installHiddenThisVisit = true; } catch { }
      deferredInstall = null; updateChrome(); return;
    }
    const b = iosBrowser();
    const share = h('span', { class: 'sharei' }, icon('share', 'ic'));
    const steps = {
      safari: [['Tap the Share button ', share, ' at the bottom of the screen (on some iPhones it is in the ⋯ menu next to the address).'], ['Scroll down and tap ', h('b', { text: 'Add to Home Screen' }), '.'], ['Leave ', h('b', { text: 'Open as Web App' }), ' on and tap ', h('b', { text: 'Add' }), '.']],
      chrome: [['Tap the Share button ', share, ' at the top right, in the address bar.'], ['Tap ', h('b', { text: 'Add to Home Screen' }), '. If you do not see it, tap ', h('b', { text: 'Edit Actions' }), ' and add it.'], ['Tap ', h('b', { text: 'Add' }), '.']],
      firefox: [['Tap the ', h('b', { text: '☰' }), ' menu, then ', h('b', { text: 'Share' }), '.'], ['Tap ', h('b', { text: 'Add to Home Screen' }), '.']],
      edge: [['Tap the ', h('b', { text: '⋯' }), ' menu, then ', h('b', { text: 'Share' }), '.'], ['Tap ', h('b', { text: 'Add to Home Screen' }), '.']],
      inapp: [['This page is open inside another app, which cannot add home-screen apps.'], ['Tap ', h('b', { text: 'Copy link' }), ' below, open ', h('b', { text: 'Safari' }), ', paste it in the address bar, then tap Add to Home Screen again.']]
    }[b];
    const body = h('div', { class: 'guide' },
      h('p', { class: 'muted', style: 'margin:0;font-size:.9rem', text: 'iPhone only lets you add apps from the Share menu, so it takes two quick taps:' }),
      h('ol', null, steps.map(s => h('li', null, s))),
      b === 'inapp' ? h('button', { type: 'button', class: 'small', text: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(appUrl()); toast('Link copied'); } catch { toast('Copy the address from the address bar'); } } }) : null,
      h('p', { class: 'muted', style: 'margin:0;font-size:.82rem', text: 'After that, open CourtFit from its icon. It opens full screen and this bar goes away.' }));
    const sh = sheet('Add to Home Screen', body);
    if (b === 'safari' || b === 'chrome') {
      const top = b === 'chrome';
      const arrow = h('div', { class: 'pointer' + (top ? ' top right' : '') }, top ? [icon('up'), 'Share'] : ['Share', icon('down')]);
      document.body.append(arrow);
      sh.onClose = () => arrow.remove();
    }
  }

  // ---------- sheets ----------
  const openSheets = [];
  function sheet(title, body, opts = {}) {
    const box = h('div', { class: 'sheet' + (opts.tall ? ' tall' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      title != null ? h('div', { class: 'hd' }, opts.left || null, h('h2', { text: title }), opts.right || h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', text: '✕', onclick: () => api.close() })) : null,
      body);
    const wrap = h('div', { class: 'sheetwrap', onclick: (ev) => { if (ev.target === wrap) api.close(); } }, box);
    const api = {
      el: box, onClose: null,
      close() { if (!wrap.isConnected) return; wrap.remove(); const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1); if (api.onClose) api.onClose(); }
    };
    document.body.append(wrap);
    openSheets.push(api);
    return api;
  }
  function closeSheets() { [...openSheets].forEach(s => s.close()); }
  function actions(title, items, note) {
    const sh = sheet(title, h('div', { class: 'acts' },
      note ? h('p', { class: 'muted', style: 'margin:0 0 6px', text: note }) : null,
      items.map(it => h('button', { type: 'button', class: it.danger ? 'danger' : it.primary ? 'primary' : '', onclick: () => { sh.close(); it.run(); } },
        it.icon ? icon(it.icon, 'ic sm') : null, it.label, it.checked ? ' ✓' : ''))));
    return sh;
  }
  function confirmBox(title, note, label, danger) {
    return new Promise((resolve) => {
      let answered = false;
      const sh = actions(title, [{ label, danger, primary: !danger, run: () => { answered = true; resolve(true); } }], note);
      // The tapped action runs right after the sheet closes, so wait a tick before treating it as cancelled.
      const prev = sh.onClose; sh.onClose = () => { if (prev) prev(); setTimeout(() => { if (!answered) resolve(false); }, 0); };
    });
  }

  // ---------- first-run name ----------
  function nameView() {
    const form = h('form', { class: 'login', onsubmit: (ev) => {
      ev.preventDefault();
      const n = form.elements.name.value.trim();
      if (!n) return;
      ls.set('cf-name', n); S.myName = n; S.needName = false; render(true);
    } },
      h('img', { class: 'logo', src: 'logo-180.png', alt: 'CourtFit logo' }),
      h('div', { class: 'eyebrow', text: 'Workout tracker' }),
      h('h1', { text: 'CourtFit' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'What should we call you? Your name shows on your routines and workouts.' }),
      field('Your name', h('input', { id: 'name', name: 'name', autocomplete: 'given-name', required: true, value: S.myName || '' })),
      h('button', { class: 'primary big', type: 'submit', text: 'Continue' }));
    return form;
  }

  // ---------- home ----------
  function tally(w) {
    return h('div', { class: 'tally' },
      h('div', null, h('span', { text: 'Time' }), h('b', { text: fmtDur(durOf(w)) })),
      h('div', null, h('span', { text: 'Volume' }), h('b', { text: fvol(volumeOf(w)) })),
      h('div', null, h('span', { text: 'Sets' }), h('b', { text: String(setsOf(w).length) })));
  }
  function workoutCard(w) {
    const ex = w.exercises || [];
    return h('a', { class: 'card', href: '#w-' + w.id },
      h('div', null, h('h3', { text: w.name }), h('div', { class: 'meta', text: fmtWhen(w.start) + (w.by ? ' · ' + w.by : '') })),
      tally(w),
      h('div', { class: 'divider' }),
      ex.slice(0, 3).map(e => {
        const b = bestSet(e);
        return h('div', { class: 'exline' }, thumb(findEx(e.exerciseId)?.muscle, 'sm'),
          h('span', { class: 'n', text: `${doneSets(e).length} sets ${exLabelId(e.exerciseId)}` }),
          b ? h('span', { class: 'muted', style: 'font-size:.82rem', text: `${fw(b.weight)} × ${b.reps || 0}` }) : null);
      }),
      ex.length > 3 ? h('div', { class: 'accent', style: 'font-size:.85rem;font-weight:600', text: `See ${ex.length - 3} more exercise${ex.length - 3 === 1 ? '' : 's'}` }) : null);
  }
  function homeView() {
    const list = finished();
    const hr = new Date().getHours();
    const hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const wk = startOfWeek(Date.now());
    const n = list.filter(w => w.start >= wk).length;
    const days = new Set(list.map(w => startOfDay(w.start)));
    const today = startOfDay(Date.now());
    return h('div', null,
      topbar(h('a', { class: 'brand', href: '#' }, h('img', { src: 'logo-180.png', alt: 'CourtFit logo' }), h('span', null, h('b', { text: 'CourtFit' }), h('small', { text: 'Lift, log, glow' })))),
      h('div', { class: 'hero' }, h('h2', { text: `${hello}, ${S.myName} 🌸` }),
        h('p', { text: n === 0 ? 'Ready to make this week count?' : n === 1 ? '1 workout this week. Keep it going!' : `${n} workouts this week. You're glowing ✨` })),
      h('div', { class: 'panel' }, h('div', { class: 'week' }, Array.from({ length: 7 }, (_, i) => {
        const d = addDays(wk, i), on = days.has(d);
        return h('div', { class: 'd', role: 'img', 'aria-label': fmtDate(d, { weekday: 'long' }) + (on ? ': worked out' : ': no workout') },
          fmtDate(d, { weekday: 'narrow' }),
          h('span', { class: 'dc' + (on ? ' on' : '') + (d === today ? ' today' : '') }, on ? icon('check', 'ic sm') : String(new Date(d).getDate())));
      }))),
      list.length ? [sectionhd('Recent workouts'), h('div', { class: 'cards' }, list.slice(0, 30).map(workoutCard))]
        : h('div', { class: 'empty', style: 'margin-top:16px' }, h('h2', { text: 'Your first workout awaits' }),
          h('p', { text: 'Start a workout and it will show up here with all your stats.' }),
          h('button', { type: 'button', class: 'primary', onclick: () => startWorkout() }, icon('plus'), 'Start Workout')));
  }

  // ---------- workout tab ----------
  function workoutView() {
    const routines = sortedRoutines();
    return h('div', null,
      topbar(h('h1', { text: 'Workout' })),
      h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'startcard', onclick: () => startWorkout() }, icon('plus'), 'Start Empty Workout'),
        h('button', { type: 'button', class: 'startcard', onclick: () => startWorkout(null, [], null, { past: true }) }, icon('cal'), 'Log Past Workout')),
      sectionhd('Routines', h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'New routine', onclick: () => routineEditor(null) }, icon('plus'))),
      h('div', { class: 'duo' },
        h('button', { type: 'button', onclick: () => routineEditor(null) }, icon('edit'), 'New Routine'),
        h('button', { type: 'button', onclick: () => newExercise() }, icon('dumbbell'), 'New Exercise')),
      h('button', { type: 'button', class: 'folder', 'aria-expanded': String(S.routinesOpen), style: 'margin-top:14px', onclick: () => { S.routinesOpen = !S.routinesOpen; render(true); } },
        icon('chev', 'ic sm'), `My Routines (${routines.length})`),
      S.routinesOpen ? (routines.length ? h('div', { class: 'cards' }, routines.map(routineCard))
        : h('div', { class: 'empty' }, h('p', { text: 'No routines yet. Tap New Routine to build your first one.' }))) : null);
  }
  function routineCard(r) {
    return h('div', { class: 'rcard' },
      h('div', { class: 'rtop' },
        h('a', { href: '#routine-' + r.id }, h('h3', { text: r.name }), h('p', { text: (r.items || []).map(i => exLabelId(i.exerciseId)).join(', ') || 'No exercises' })),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Options for ' + r.name, onclick: () => routineMenu(r) }, icon('dots'))),
      h('button', { type: 'button', class: 'primary', onclick: () => startRoutine(r) }, 'Start Routine'));
  }
  function routineMenu(r) {
    const list = sortedRoutines(), i = list.findIndex(x => x.id === r.id);
    const move = (d) => action(null, async () => {
      const j = i + d; if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      for (let k = 0; k < list.length; k++) if (list[k].order !== k) await put('routines', { ...list[k], order: k });
    });
    actions(r.name, [
      { label: 'Edit Routine', icon: 'edit', run: () => routineEditor(r) },
      { label: 'Duplicate Routine', icon: 'repeat', run: () => action('Routine duplicated', () => put('routines', { ...clone(r), id: uid('r'), name: r.name + ' (copy)', created: Date.now(), order: list.length })) },
      { label: 'Move Up', icon: 'up', run: () => move(-1) },
      { label: 'Move Down', icon: 'down', run: () => move(1) },
      { label: 'Delete Routine', icon: 'trash', danger: true, run: async () => { if (await confirmBox(`Delete "${r.name}"?`, 'Past workouts stay in your history.', 'Delete Routine', true)) action('Routine deleted', () => del('routines', r.id)); } }
    ]);
  }

  // ---------- routine page ----------
  function routineView(id) {
    const r = S.routines.find(x => x.id === id);
    if (!r) return h('div', null, topbar(backLink('#workout', 'Workout')), msg('Routine not found', 'It may have been deleted.'));
    const sessions = finished().filter(w => w.routineId === r.id).reverse();
    const val = (w) => S.rMetric === 'volume' ? disp(volumeOf(w)) : S.rMetric === 'reps' ? repsOf(w) : durOf(w) / 60000;
    const fmtVal = (v) => S.rMetric === 'volume' ? `${Math.round(v).toLocaleString()} ${unit()}` : S.rMetric === 'reps' ? `${Math.round(v)} reps` : `${Math.round(v)} min`;
    const pts = sessions.map(w => ({ x: w.start, y: val(w) }));
    const last = pts[pts.length - 1];
    const pill = (k, label) => h('button', { type: 'button', 'aria-pressed': String(S.rMetric === k), onclick: () => { S.rMetric = k; render(true); } }, label);
    return h('div', null,
      topbar(h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'Back', onclick: () => goBack('#workout') }, icon('back')),
        h('h2', { style: 'flex:1;text-align:center;font-size:1.05rem;font-weight:600', text: 'Routine' }),
        h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'Routine options', onclick: () => routineMenu(r) }, icon('dots'))),
      h('h1', { style: 'font-size:1.6rem', text: r.name }),
      h('p', { class: 'muted', style: 'margin:4px 0 16px', text: 'Created by ' + (r.by || S.myName) }),
      h('button', { type: 'button', class: 'primary big', onclick: () => startRoutine(r) }, 'Start Routine'),
      h('div', { style: 'margin:20px 0 6px' },
        last ? h('div', { class: 'bigval' }, h('b', { text: fmtVal(last.y) }), h('span', { text: fmtDate(last.x, { month: 'short', day: 'numeric' }) })) : null,
        pts.length >= 2 ? h('div', { style: 'margin-top:10px' }, svgFrom(lineChart(pts, S.rMetric === 'volume' ? unit() : '')))
          : h('p', { class: 'muted', style: 'margin:8px 0 12px', text: pts.length ? 'Do this routine one more time to see your progress chart.' : 'Your progress chart appears after you do this routine twice.' }),
        h('div', { class: 'pills', style: 'margin-top:8px' }, pill('volume', 'Volume'), pill('reps', 'Reps'), pill('duration', 'Duration'))),
      sectionhd('Exercises', h('button', { type: 'button', class: 'link', onclick: () => routineEditor(r) }, 'Edit Routine')),
      (r.items || []).map(it => {
        const ex = findEx(it.exerciseId);
        return h('div', { style: 'margin-bottom:18px' },
          h('a', { class: 'exlink', href: '#ex-' + it.exerciseId }, thumb(ex?.muscle, 'lg'), exLabel(ex)),
          h('div', { class: 'rtable', role: 'table' },
            h('div', { class: 'r h', role: 'row' }, h('span', { text: 'SET' }), h('span', { text: unit().toUpperCase() }), h('span', { text: 'REP RANGE' })),
            (it.sets || []).map((s, i) => h('div', { class: 'r', role: 'row' }, h('b', { text: String(i + 1) }), h('span', { text: s.weight ? fw(s.weight) : '—' }), h('span', { text: s.reps || '—' })))));
      }));
  }

  // ---------- routine editor ----------
  function routineEditor(r) {
    const d = { name: r ? r.name : '', items: r ? clone(r.items || []) : [] };
    const list = h('div', { class: 'stack' });
    const nameIn = h('input', { value: d.name, placeholder: 'e.g. Booty Builder', autocomplete: 'off', oninput: (e) => { d.name = e.target.value; } });
    function draw() {
      list.replaceChildren(...(d.items.length ? d.items.map((it, i) => h('div', { class: 'rrow' },
        h('div', { class: 'exhd' }, h('a', { href: null, style: 'cursor:default' }, exLabelId(it.exerciseId)),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [d.items[i - 1], d.items[i]] = [d.items[i], d.items[i - 1]]; draw(); } }, icon('up', 'ic sm')),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move down', disabled: i === d.items.length - 1, onclick: () => { [d.items[i + 1], d.items[i]] = [d.items[i], d.items[i + 1]]; draw(); } }, icon('down', 'ic sm')),
          h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove exercise', onclick: () => { d.items.splice(i, 1); draw(); } }, icon('trash', 'ic sm'))),
        h('div', { class: 'rtable', style: 'margin:0' },
          h('div', { class: 'r h' }, h('span', { text: 'SET' }), h('span', { text: unit().toUpperCase() }), h('span', { text: 'REP RANGE' })),
          it.sets.map((s, si) => h('div', { class: 'r', style: 'align-items:center;gap:8px;padding:6px 0' },
            h('button', { type: 'button', class: 'small', style: 'padding:0;min-height:36px', 'aria-label': `Remove set ${si + 1}`, disabled: it.sets.length === 1, onclick: () => { it.sets.splice(si, 1); draw(); } }, String(si + 1)),
            h('input', { inputmode: 'decimal', placeholder: '—', 'aria-label': `Set ${si + 1} weight`, value: s.weight ? fw(s.weight) : '', style: 'text-align:center',
              oninput: (e) => { const v = parseFloat(e.target.value.replace(',', '.')); s.weight = isFinite(v) && v > 0 ? store(v) : null; } }),
            h('input', { placeholder: '8-10', 'aria-label': `Set ${si + 1} rep range`, value: s.reps || '', style: 'text-align:center', oninput: (e) => { s.reps = e.target.value.trim(); } })))),
        h('button', { type: 'button', class: 'soft small', onclick: () => { const l = it.sets[it.sets.length - 1]; it.sets.push(l ? { ...l } : { weight: null, reps: '8-10' }); draw(); } }, icon('plus', 'ic sm'), 'Add Set')))
        : [h('p', { class: 'muted', text: 'No exercises yet.' })]));
    }
    draw();
    const save = h('button', { type: 'button', class: 'primary small', text: 'Save', onclick: async () => {
      if (!d.name.trim()) { toast('Give your routine a name'); nameIn.focus(); return; }
      if (!d.items.length) { toast('Add at least one exercise'); return; }
      sh.close();
      await action(r ? 'Routine saved' : 'Routine created', () => put('routines', r
        ? { ...r, name: d.name.trim(), items: d.items }
        : { id: uid('r'), name: d.name.trim(), items: d.items, by: S.myName, created: Date.now(), order: S.routines.length }));
    } });
    const sh = sheet(r ? 'Edit Routine' : 'New Routine', h('div', { class: 'fgrid' },
      field('Routine name', nameIn), list,
      h('button', { type: 'button', class: 'soft', onclick: () => picker((ids) => { ids.forEach(id => d.items.push({ exerciseId: id, sets: [1, 2, 3].map(() => ({ weight: null, reps: '8-10' })) })); draw(); }) }, icon('plus'), 'Add Exercise')),
      { tall: true, right: save });
  }

  // ---------- exercise picker ----------
  function picker(onAdd, single) {
    const st = { q: '', m: null, sel: [] };
    const listBox = h('div');
    const addBtn = h('button', { type: 'button', class: 'primary big', disabled: true, text: 'Select exercises', onclick: () => { if (!st.sel.length) return; sh.close(); onAdd(st.sel); } });
    const chipsBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by muscle' });
    function draw() {
      chipsBox.replaceChildren(...[null, ...MUSCLES].map(m => h('button', { type: 'button', 'aria-pressed': String(st.m === m), onclick: () => { st.m = m; draw(); } }, m || 'All')));
      const q = st.q.toLowerCase();
      const items = S.exercises.filter(e => (!st.m || e.muscle === st.m) && (!q || exLabel(e).toLowerCase().includes(q))).sort((a, b) => exLabel(a).localeCompare(exLabel(b)));
      listBox.replaceChildren(items.length ? h('div', { class: 'list' }, items.map(e => {
        const i = st.sel.indexOf(e.id);
        return h('button', { type: 'button', class: 'li' + (i >= 0 ? ' sel' : ''), 'aria-pressed': String(i >= 0), onclick: () => {
          if (single) { sh.close(); onAdd([e.id]); return; }
          if (i >= 0) st.sel.splice(i, 1); else st.sel.push(e.id); draw();
        } }, thumb(e.muscle), h('span', { class: 'grow' }, h('span', { class: 't', text: exLabel(e) }), h('span', { class: 's', text: e.muscle })),
        i >= 0 ? h('span', { class: 'selnum', text: String(i + 1) }) : null);
      })) : h('p', { class: 'muted', text: 'No exercises match. Tap + to create one.' }));
      addBtn.disabled = !st.sel.length;
      addBtn.textContent = st.sel.length ? `Add ${st.sel.length} exercise${st.sel.length === 1 ? '' : 's'}` : 'Select exercises';
    }
    draw();
    const sh = sheet(single ? 'Replace Exercise' : 'Add Exercises', h('div', null,
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', autocomplete: 'off', oninput: (e) => { st.q = e.target.value; draw(); } })),
      chipsBox, listBox,
      single ? null : h('div', { style: 'position:sticky;bottom:-18px;padding:12px 0 4px;background:var(--surface)' }, addBtn)),
      { tall: true, right: h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Create custom exercise', onclick: () => newExercise((ex) => { if (single) { sh.close(); onAdd([ex.id]); } else { st.sel.push(ex.id); draw(); } }) }, icon('plus')) });
  }
  function newExercise(done) {
    const name = h('input', { placeholder: 'e.g. Cable Pull Through', autocomplete: 'off' });
    const eq = h('select', null, EQUIPMENT.map(x => h('option', { text: x })));
    const mu = h('select', null, MUSCLES.map(x => h('option', { text: x })));
    const sh = sheet('New Exercise', h('form', { class: 'fgrid', onsubmit: async (ev) => {
      ev.preventDefault();
      const n = name.value.trim(); if (!n) { name.focus(); return; }
      const ex = { id: uid('x'), name: n, equipment: eq.value, muscle: mu.value, custom: true, by: S.myName };
      sh.close();
      await action('Exercise created', () => put('exercises', ex));
      if (done) done(ex);
    } }, field('Name', name), field('Equipment', eq), field('Muscle group', mu), h('button', { class: 'primary big', type: 'submit', text: 'Save Exercise' })));
    setTimeout(() => name.focus(), 300);
  }

  // ---------- exercises library ----------
  function exercisesView() {
    const listBox = h('div');
    function draw() {
      const q = S.search.toLowerCase();
      const items = S.exercises.filter(e => (!S.muscle || e.muscle === S.muscle) && (!q || exLabel(e).toLowerCase().includes(q))).sort((a, b) => exLabel(a).localeCompare(exLabel(b)));
      listBox.replaceChildren(...(items.length ? MUSCLES.map(m => {
        const g = items.filter(e => e.muscle === m);
        return g.length ? [h('div', { class: 'eyebrow grouphd', text: m }), h('div', { class: 'list' }, g.map(e => h('a', { class: 'li', href: '#ex-' + e.id }, thumb(e.muscle),
          h('span', { class: 'grow' }, h('span', { class: 't', text: exLabel(e) }), h('span', { class: 's', text: e.custom ? 'Custom' : e.muscle })), icon('next', 'ic sm'))))] : null;
      }) : [h('p', { class: 'muted', text: 'No exercises match.' })]));
    }
    draw();
    return h('div', null,
      topbar(backLink('#profile', 'Profile'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'small', onclick: () => newExercise() }, icon('plus', 'ic sm'), 'New')),
      h('h1', { style: 'font-size:1.6rem;margin-bottom:12px', text: 'Exercises' }),
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', value: S.search, autocomplete: 'off', oninput: (e) => { S.search = e.target.value; draw(); } })),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by muscle' }, [null, ...MUSCLES].map(m => h('button', { type: 'button', 'aria-pressed': String(S.muscle === m), onclick: () => { S.muscle = m; render(true); } }, m || 'All'))),
      listBox);
  }
  function exerciseView(id) {
    const ex = findEx(id);
    if (!ex) return h('div', null, topbar(backLink('#exercises', 'Exercises')), msg('Exercise not found', 'It may have been deleted.'));
    const hist = historyFor(id);
    const all = hist.flatMap(x => doneSets(x.entry));
    const mval = (sets) => S.exMetric === 'heaviest' ? Math.max(...sets.map(s => s.weight || 0)) : S.exMetric === 'onerm' ? Math.max(...sets.map(e1rm)) : sets.reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
    const pts = [...hist].reverse().map(x => ({ x: x.w.start, y: disp(mval(doneSets(x.entry))) }));
    const mx = (arr) => arr.length ? Math.max(...arr) : null;
    const tab = (k, label) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.exMetric === k), onclick: () => { S.exMetric = k; render(true); } }, label);
    const tile = (label, value) => h('div', { class: 'tile rec' }, h('b', { text: value }), h('span', { text: label }));
    const hv = mx(all.map(s => s.weight || 0)), orm = mx(all.map(e1rm)), bv = mx(all.map(s => (s.weight || 0) * (s.reps || 0))), mr = mx(all.map(s => s.reps || 0));
    return h('div', null,
      topbar(h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'Back', onclick: () => goBack('#exercises') }, icon('back')), h('span', { class: 'spacer' }),
        ex.custom ? h('button', { type: 'button', class: 'roundbtn danger', 'aria-label': 'Delete exercise', onclick: async () => {
          if (await confirmBox(`Delete ${exLabel(ex)}?`, 'Past workouts keep their sets.', 'Delete Exercise', true)) { await action('Exercise deleted', () => del('exercises', ex.id)); goBack('#exercises'); }
        } }, icon('trash')) : null),
      h('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:16px' }, thumb(ex.muscle, 'lg'),
        h('div', null, h('h1', { style: 'font-size:1.45rem', text: exLabel(ex) }), h('div', { class: 'muted', text: `${ex.muscle} · ${ex.equipment}` }))),
      h('div', { class: 'panel' },
        h('div', { class: 'tabs', role: 'tablist' }, tab('heaviest', 'Heaviest'), tab('onerm', 'Est. 1RM'), tab('volume', 'Volume')),
        pts.length >= 2 ? svgFrom(lineChart(pts, S.exMetric === 'volume' ? '' : unit())) : h('p', { class: 'muted', style: 'text-align:center;margin:20px 0', text: 'Log this exercise in two or more workouts to see your progress chart.' })),
      sectionhd('Personal records'),
      h('div', { class: 'tiles' }, tile('Heaviest weight', hv != null ? fwu(hv) : '—'), tile('Best est. 1RM', orm != null ? fwu(orm) : '—'), tile('Best set volume', bv != null ? fvol(bv) : '—'), tile('Most reps', mr != null ? String(mr) : '—')),
      hist.length ? [sectionhd('History'), h('div', { class: 'cards' }, hist.map(({ entry, w }) => h('a', { class: 'card', href: '#w-' + w.id },
        h('div', null, h('h3', { text: w.name }), h('div', { class: 'meta', text: fmtDate(w.start) })),
        setTable(entry))))] : null);
  }
  function setTable(entry) {
    const sets = doneSets(entry);
    return h('div', { class: 'sets' }, h('div', { class: 'r h' }, h('span', { text: 'SET' }), h('span', { text: 'WEIGHT × REPS' }), h('span', { text: 'EST. 1RM' })),
      sets.map((s, i) => h('div', { class: 'r' }, h('b', { text: setLabel(sets, i) }), h('span', { text: `${fwu(s.weight)} × ${s.reps || 0}` }), h('span', { class: 'muted', text: fw(e1rm(s)) }))));
  }

  // ---------- finished workout ----------
  function workoutDetail(id) {
    const w = S.workouts.find(x => x.id === id);
    if (!w) return h('div', null, topbar(backLink('#', 'Home')), msg('Workout not found', 'It may have been deleted.'));
    return h('div', null,
      topbar(h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'Back', onclick: () => goBack('#') }, icon('back')), h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'Workout options', onclick: () => actions(w.name, [
          { label: 'Edit Workout', icon: 'edit', run: () => startWorkout(w.name, (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, notes: e.notes || '',
            sets: (e.sets || []).map(s => ({ ...newSet(s.weight, s.reps, s.kind), done: true })) })), w.routineId, { edit: w }) },
          { label: 'Save as Routine', icon: 'edit', run: () => action('Saved as routine', () => put('routines', { id: uid('r'), name: w.name, by: S.myName, created: Date.now(), order: S.routines.length,
            items: (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, sets: doneSets(e).map(s => ({ weight: s.weight || null, reps: s.reps ? String(s.reps) : '' })) })) })) },
          { label: 'Delete Workout', icon: 'trash', danger: true, run: async () => { if (await confirmBox('Delete this workout?', 'You can undo right after.', 'Delete Workout', true)) { await action('Workout deleted', () => del('workouts', w.id)); go(''); } } }
        ]) }, icon('dots'))),
      h('div', { class: 'panel' }, h('h1', { style: 'font-size:1.5rem', text: w.name }), h('p', { class: 'muted', style: 'margin:2px 0 14px', text: fmtWhen(w.start) }), tally(w),
        w.notes ? h('p', { style: 'margin:12px 0 0;white-space:pre-wrap', text: w.notes }) : null),
      (w.exercises || []).map(e => h('div', { class: 'panel' },
        h('a', { class: 'exlink', href: '#ex-' + e.exerciseId, style: 'margin-bottom:8px' }, thumb(findEx(e.exerciseId)?.muscle, 'sm'), exLabelId(e.exerciseId)),
        e.notes ? h('p', { class: 'muted', style: 'margin:0 0 6px', text: e.notes }) : null, setTable(e))),
      h('button', { type: 'button', class: 'primary big', style: 'margin-top:16px', onclick: () => startWorkout(w.name, (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, sets: doneSets(e).map(s => newSet(s.weight, s.reps, s.kind)) })), w.routineId) }, icon('repeat'), 'Repeat Workout'));
  }

  // ---------- profile ----------
  function profileView() {
    const list = finished();
    const now = new Date();
    const month = list.filter(w => { const d = new Date(w.start); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length;
    const wk = startOfWeek(Date.now());
    const weeks = Array.from({ length: 12 }, (_, i) => addDays(wk, -7 * (11 - i)));
    const weekly = weeks.map(s => { const ws = list.filter(w => w.start >= s && w.start < addDays(s, 7));
      return { x: s, y: S.profMetric === 'workouts' ? ws.length : S.profMetric === 'minutes' ? ws.reduce((a, w) => a + durOf(w), 0) / 60000 : disp(ws.reduce((a, w) => a + volumeOf(w), 0)) }; });
    const counts = {};
    list.filter(w => w.start >= Date.now() - 30 * DAY).forEach(w => (w.exercises || []).forEach(e => { const m = findEx(e.exerciseId)?.muscle || 'Other'; counts[m] = (counts[m] || 0) + doneSets(e).length; }));
    const split = Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
    const top = split[0]?.[1] || 1;
    const tile = (ic, label, value) => h('div', { class: 'tile' }, h('span', { class: 'ti' }, icon(ic, 'ic sm')), h('b', { text: value }), h('span', { text: label }));
    const pill = (k, label) => h('button', { type: 'button', 'aria-pressed': String(S.profMetric === k), onclick: () => { S.profMetric = k; render(true); } }, label);
    return h('div', null,
      topbar(h('h1', { text: 'Profile' }), h('span', { class: 'spacer' }), h('a', { class: 'btn iconbtn', href: '#settings', 'aria-label': 'Settings' }, icon('gear'))),
      h('div', { style: 'display:flex;gap:16px;align-items:center;margin-bottom:16px' },
        h('div', { class: 'avatar', 'aria-hidden': 'true', text: (S.myName || 'C').slice(0, 1).toUpperCase() }),
        h('div', null, h('h2', { style: 'font-size:1.4rem', text: S.myName }), h('div', { class: 'muted', text: `${list.length} workout${list.length === 1 ? '' : 's'}` }))),
      h('div', { class: 'duo', style: 'margin-bottom:12px' },
        h('button', { type: 'button', onclick: () => go('#exercises') }, icon('list'), 'Exercises'),
        h('button', { type: 'button', onclick: () => go('#settings') }, icon('gear'), 'Settings')),
      h('div', { class: 'tiles' },
        tile('flame', 'Week streak', String(weekStreak(list))), tile('cal', 'This month', String(month)),
        tile('weight', 'Total volume', fvol(list.reduce((a, w) => a + volumeOf(w), 0))), tile('clock', 'Total time', fmtDur(list.reduce((a, w) => a + durOf(w), 0)))),
      h('div', { class: 'panel', style: 'margin-top:12px' }, h('div', { class: 'hd' }, h('h2', { text: 'Last 12 weeks' })),
        h('div', { class: 'pills', style: 'margin:10px 0' }, pill('workouts', 'Workouts'), pill('minutes', 'Minutes'), pill('volume', 'Volume')),
        svgFrom(barChart(weekly))),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Muscle split' }), h('span', { class: 'muted', style: 'font-size:.8rem', text: 'Sets, last 30 days' })),
        split.length ? split.map(([m, c]) => h('div', { class: 'hbar', role: 'img', 'aria-label': `${m}: ${c} sets` }, h('span', { text: m }), h('span', { class: 'tr' }, h('i', { style: `width:${Math.max(4, c / top * 100)}%` })), h('b', { style: 'text-align:right', text: String(c) })))
          : h('p', { class: 'muted', text: 'No sets logged in the last 30 days.' })),
      h('div', { class: 'panel' }, calendar(new Set(list.map(w => startOfDay(w.start))))));
  }
  function weekStreak(list) {
    const weeks = new Set(list.map(w => startOfWeek(w.start)));
    let c = startOfWeek(Date.now()); if (!weeks.has(c)) c = addDays(c, -7);
    let n = 0; while (weeks.has(c)) { n++; c = addDays(c, -7); }
    return n;
  }
  function calendar(days) {
    const m = new Date(S.calMonth), y = m.getFullYear(), mo = m.getMonth();
    const count = new Date(y, mo + 1, 0).getDate(), off = new Date(y, mo, 1).getDay(), today = startOfDay(Date.now());
    const shift = (d) => { const x = new Date(S.calMonth); x.setMonth(x.getMonth() + d); S.calMonth = x.getTime(); render(true); };
    const cells = [];
    for (let i = 0; i < 7; i++) cells.push(h('div', { class: 'wd', 'aria-hidden': 'true', text: new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' }) }));
    for (let i = 0; i < off; i++) cells.push(h('div'));
    for (let d = 1; d <= count; d++) { const t = new Date(y, mo, d).getTime(), on = days.has(t);
      cells.push(h('div', { class: 'dy' + (on ? ' on' : '') + (t === today ? ' today' : ''), 'aria-label': fmtDate(t, { month: 'long', day: 'numeric' }) + (on ? ', workout logged' : ''), text: String(d) })); }
    return h('div', null,
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' },
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('back')),
        h('b', { text: m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next month', onclick: () => shift(1) }, icon('next'))),
      h('div', { class: 'cal' }, cells));
  }

  // ---------- settings ----------
  function settingsView() {
    const nameIn = h('input', { value: S.myName, autocomplete: 'given-name', onchange: (e) => { const n = e.target.value.trim(); if (n) { S.myName = n; ls.set('cf-name', n); toast('Name saved'); } } });
    const seg = (key, val, label, cur) => h('button', { type: 'button', 'aria-pressed': String(cur === val), onclick: () => { ls.set(key, val); render(true); } }, label);
    const rest = h('select', { 'aria-label': 'Default rest timer', onchange: (e) => { ls.set('cf-rest', e.target.value); toast('Rest timer saved'); } },
      [0, ...Array.from({ length: 19 }, (_, i) => 30 + i * 15)].map(s => h('option', { value: String(s), text: s ? fmtClock(s * 1000) : 'Off', selected: restSecs() === s })));
    return h('div', null,
      topbar(backLink('#profile', 'Profile')),
      h('h1', { style: 'font-size:1.6rem;margin-bottom:14px', text: 'Settings' }),
      h('div', { class: 'panel fgrid' },
        field('Your name', nameIn),
        h('div', { class: 'f' }, h('span', { class: 'eyebrow', text: 'Weight unit' }), h('div', { class: 'seg' }, seg('cf-unit', 'lbs', 'Pounds (lbs)', unit()), seg('cf-unit', 'kg', 'Kilograms (kg)', unit()))),
        field('Default rest timer', rest)),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Your app link' })),
        h('p', { class: 'muted', style: 'margin:10px 0', text: 'Anyone with this link can open your workouts, so keep it private. Use it to open CourtFit on a new phone.' }),
        h('button', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(appUrl()); toast('Link copied'); } catch { toast('Copy the address from the address bar'); } } }, 'Copy app link')),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Backup' })),
        h('p', { class: 'muted', style: 'margin:10px 0', text: 'Your workouts are saved online. You can also download a copy.' }),
        h('button', { type: 'button', onclick: () => {
          const blob = new Blob([JSON.stringify({ exercises: S.exercises, routines: S.routines, workouts: S.workouts }, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `courtfit-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
        } }, 'Download backup')),
      h('p', { class: 'muted', style: 'text-align:center;font-size:.8rem;margin-top:18px', text: 'CourtFit · Lift, log, glow' }));
  }

  // ---------- active workout ----------
  const newSet = (weight = null, reps = null, kind = 'normal', target = '') => ({ weight: weight ?? null, reps: reps ?? null, done: false, kind: kind || 'normal', target });
  function defaultName() { const hr = new Date().getHours(); return hr >= 4 && hr < 12 ? 'Morning Workout' : hr >= 12 && hr < 17 ? 'Afternoon Workout' : 'Evening Workout'; }
  // mode: 'live' (happening now), 'past' (logging an earlier workout) or 'edit' (changing a saved one).
  const isLive = (w) => !w.mode || w.mode === 'live';
  const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  async function startWorkout(name, exercises, routineId, opts = {}) {
    if (S.active) {
      actions(isLive(S.active) ? 'Workout in progress' : 'Unsaved workout', [{ label: 'Go back to it', primary: true, run: () => go('#active') },
        { label: 'Throw it away and start new', danger: true, run: () => { S.active = null; saveActive(); startWorkout(name, exercises, routineId, opts); } }],
        'You already have a workout open.');
      return;
    }
    const ed = opts.edit;
    const mode = ed ? 'edit' : opts.past ? 'past' : 'live';
    const start = ed ? ed.start : opts.past ? Date.now() - 3600000 : Date.now();
    S.active = { id: ed ? ed.id : uid('w'), mode, by: ed ? ed.by : S.myName, name: name || (opts.past ? 'Workout' : defaultName()), start,
      durMin: ed ? Math.max(1, Math.round(durOf(ed) / 60000)) : 60, notes: ed ? ed.notes || '' : '', routineId: routineId || null, exercises: exercises || [], restEnd: null, restDur: 0 };
    saveActive();
    if (navigator.vibrate) navigator.vibrate(12);
    go('#active');
  }
  function startRoutine(r) {
    startWorkout(r.name, (r.items || []).filter(i => findEx(i.exerciseId)).map(it => {
      const prev = previousSets(it.exerciseId);
      return { exerciseId: it.exerciseId, notes: '', sets: (it.sets || [{}]).map((s, i) => newSet(s.weight || prev[i]?.weight || null, null, 'normal', s.reps || '')) };
    }), r.id);
  }
  function addExercises(ids) {
    for (const id of ids) {
      const prev = previousSets(id);
      S.active.exercises.push({ exerciseId: id, notes: '', sets: Array.from({ length: prev.length || 3 }, (_, i) => newSet(null, null, prev[i]?.kind)) });
    }
    saveActive(); render(true);
  }
  function liveTally() {
    const w = S.active;
    return h('div', { class: 'tally', id: 'livetally' },
      isLive(w) ? h('div', null, h('span', { text: 'Duration' }), h('b', { 'data-dur': '', text: fmtDur(Date.now() - w.start) }))
        : h('div', null, h('span', { text: 'Duration' }), h('b', { text: w.durMin ? fmtDur(w.durMin * 60000) : '—' })),
      h('div', null, h('span', { text: 'Volume' }), h('b', { text: fvol(volumeOf(w)) })),
      h('div', null, h('span', { text: 'Sets' }), h('b', { text: String(setsOf(w).length) })));
  }
  function refreshTally() { const el = document.getElementById('livetally'); if (el && S.active) el.replaceWith(liveTally()); }
  function grow(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  function activeView() {
    const w = S.active;
    const notes = h('textarea', { class: 'noteinput', rows: '1', placeholder: 'Add notes…', 'aria-label': 'Workout notes', value: w.notes || '', oninput: (e) => { w.notes = e.target.value; grow(e.target); saveActive(); } });
    const live = isLive(w);
    const when = live ? null : h('div', { class: 'fgrid', style: 'grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);margin-top:12px' },
      field('Date & time', h('input', { type: 'datetime-local', value: toLocalInput(w.start), max: toLocalInput(Date.now()),
        onchange: (e) => { const t = new Date(e.target.value).getTime(); if (isFinite(t)) { w.start = t; saveActive(); } } })),
      field('Minutes', h('input', { inputmode: 'numeric', pattern: '[0-9]*', value: w.durMin ? String(w.durMin) : '', placeholder: '60',
        oninput: (e) => { const v = parseInt(e.target.value, 10); w.durMin = isFinite(v) && v > 0 ? v : 0; saveActive(); refreshTally(); } })));
    return h('div', null,
      topbar(h('button', { type: 'button', class: 'roundbtn', 'aria-label': live ? 'Minimize workout' : 'Back', onclick: () => goBack('#workout') }, icon(live ? 'chev' : 'back')),
        live ? h('span', { class: 'clock', 'data-clock': '', 'aria-label': 'Elapsed time', text: fmtClock(Date.now() - w.start) })
          : h('span', { class: 'clock', style: 'font-size:1.05rem', text: w.mode === 'edit' ? 'Edit Workout' : 'Log Past Workout' }),
        h('button', { type: 'button', class: 'pill', onclick: finishWorkout }, live ? 'Finish' : 'Save')),
      h('div', { class: 'panel' },
        h('input', { class: 'nameinput', 'aria-label': 'Workout name', value: w.name, autocomplete: 'off', oninput: (e) => { w.name = e.target.value; saveActive(); } }),
        when,
        h('div', { style: 'margin:12px 0' }, liveTally()), notes),
      w.exercises.map((e, i) => exerciseCard(e, i)),
      w.exercises.length ? null : h('div', { class: 'empty', style: 'margin-top:12px' }, h('h2', { text: 'Get started' }), h('p', { text: 'Add an exercise to start logging sets.' })),
      h('div', { class: 'stack', style: 'margin-top:16px' },
        h('button', { type: 'button', class: 'primary big', onclick: () => picker(addExercises) }, icon('plus'), 'Add Exercise'),
        h('div', { class: live ? 'duo' : 'stack' },
          live ? h('button', { type: 'button', onclick: () => go('#settings'), style: 'justify-content:center' }, icon('timer'), 'Rest: ' + (restSecs() ? fmtClock(restSecs() * 1000) : 'Off')) : null,
          h('button', { type: 'button', class: 'danger', style: 'justify-content:center', onclick: async () => {
            const editing = w.mode === 'edit';
            if (await confirmBox(editing ? 'Stop editing?' : 'Discard this workout?', editing ? 'Your changes will not be saved. The saved workout stays as it was.' : 'Everything logged here will be deleted.', editing ? 'Discard Changes' : 'Discard Workout', true)) {
              S.active = null; saveActive(); go(editing ? '#w-' + w.id : '#workout');
            }
          } }, w.mode === 'edit' ? 'Discard Changes' : 'Discard'))));
  }
  function exerciseCard(e, idx) {
    const w = S.active, ex = findEx(e.exerciseId);
    const prev = previousSets(e.exerciseId, w.id, isLive(w) ? null : w.start);
    const card = h('div', { class: 'panel' },
      h('div', { class: 'exhd' },
        h('a', { href: '#ex-' + e.exerciseId }, exLabel(ex), h('small', { text: ex ? ex.muscle : '' })),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Exercise options', onclick: () => {
          const move = (d) => () => { const j = idx + d; if (j < 0 || j >= w.exercises.length) return; [w.exercises[idx], w.exercises[j]] = [w.exercises[j], w.exercises[idx]]; saveActive(); render(true); };
          actions(exLabel(ex), [
            { label: 'Move Up', icon: 'up', run: move(-1) }, { label: 'Move Down', icon: 'down', run: move(1) },
            { label: 'Replace Exercise', icon: 'repeat', run: () => picker((ids) => { e.exerciseId = ids[0]; saveActive(); render(true); }, true) },
            { label: 'Remove Exercise', icon: 'trash', danger: true, run: () => { w.exercises.splice(idx, 1); saveActive(); render(true); } }]);
        } }, icon('dots'))),
      h('textarea', { class: 'noteinput', rows: '1', placeholder: 'Notes', 'aria-label': 'Exercise notes', style: 'margin:6px 0 4px', value: e.notes || '', oninput: (ev) => { e.notes = ev.target.value; grow(ev.target); saveActive(); } }),
      h('div', { class: 'sethd', 'aria-hidden': 'true' }, h('span', { text: 'SET' }), h('span', { text: 'PREVIOUS' }), h('span', { text: unit().toUpperCase() }), h('span', { text: 'REPS' }), h('span', { text: '✓' })),
      h('div', { class: 'stack', style: 'gap:6px' }, e.sets.map((s, si) => setRow(e, s, si, prev[si]))),
      h('button', { type: 'button', class: 'soft', style: 'width:100%;margin-top:10px', onclick: () => { const l = e.sets[e.sets.length - 1]; e.sets.push(newSet(l?.weight, l?.reps, 'normal', l?.target)); saveActive(); render(true); } }, icon('plus', 'ic sm'), 'Add Set'));
    return card;
  }
  function setRow(e, s, si, p) {
    const label = setLabel(e.sets, si);
    const prevText = p ? `${fw(p.weight)} × ${p.reps || 0}` : '—';
    const wIn = h('input', { inputmode: 'decimal', enterkeyhint: 'next', autocomplete: 'off', 'aria-label': `Set ${label} weight in ${unit()}`, placeholder: p ? fw(p.weight) : '0', value: s.weight != null ? fw(s.weight) : '',
      onfocus: (ev) => ev.target.select(),
      oninput: (ev) => { const v = parseFloat(ev.target.value.replace(',', '.')); s.weight = isFinite(v) ? store(v) : null; saveActive(); refreshTally(); } });
    const rIn = h('input', { inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'done', autocomplete: 'off', 'aria-label': `Set ${label} reps`, placeholder: s.target || (p ? String(p.reps || 0) : '0'), value: s.reps != null ? String(s.reps) : '',
      onfocus: (ev) => ev.target.select(),
      oninput: (ev) => { const v = parseInt(ev.target.value, 10); s.reps = isFinite(v) ? v : null; saveActive(); refreshTally(); } });
    const row = h('div', { class: 'setrow' + (s.done ? ' done' : '') },
      h('button', { type: 'button', class: 'sn ' + (s.kind || 'normal'), 'aria-label': `Set ${label} options`, onclick: () => actions('Set type', [
        ...[['normal', 'Normal Set'], ['warmup', 'Warm-up Set'], ['drop', 'Drop Set'], ['failure', 'Failure Set']].map(([k, l]) => ({ label: l, checked: (s.kind || 'normal') === k, run: () => { s.kind = k; saveActive(); render(true); } })),
        { label: 'Delete Set', icon: 'trash', danger: true, run: () => { e.sets.splice(si, 1); saveActive(); render(true); } }]) }, label),
      h('span', { class: 'prev', text: prevText, 'aria-label': p ? 'Previous ' + prevText : 'No previous' }),
      wIn, rIn,
      h('button', { type: 'button', class: 'ck', 'aria-pressed': String(!!s.done), 'aria-label': s.done ? 'Completed. Tap to undo' : 'Mark set complete', onclick: () => {
        if (s.done) { s.done = false; saveActive(); render(true); return; }
        if (s.weight == null && p) s.weight = p.weight;
        if (s.reps == null) s.reps = firstNum(s.target) ?? (p ? p.reps : null);
        s.done = true;
        if (isLive(S.active) && restSecs() > 0) { S.active.restEnd = Date.now() + restSecs() * 1000; S.active.restDur = restSecs() * 1000; }
        unlockAudio();
        if (navigator.vibrate) navigator.vibrate(15);
        saveActive(); render(true);
      } }, icon('check')));
    // Swipe a set left to delete it.
    const wrap = h('div', { class: 'setwrap' }, h('div', { class: 'swipeback', 'aria-hidden': 'true' }, icon('trash', 'ic sm'), 'Delete'), row);
    let x0 = null, y0 = null, dx = 0, locked = null;
    row.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'mouse' || ev.target.closest('button, input')) return; x0 = ev.clientX; y0 = ev.clientY; dx = 0; locked = null; });
    row.addEventListener('pointermove', (ev) => {
      if (x0 == null) return;
      const mx = ev.clientX - x0, my = ev.clientY - y0;
      if (locked == null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (locked !== 'x') return;
      dx = Math.min(0, Math.max(-160, mx));
      row.classList.add('dragging'); row.style.transform = `translateX(${dx}px)`;
    });
    const end = () => {
      if (x0 == null) return;
      row.classList.remove('dragging');
      const fire = locked === 'x' && dx < -100;
      row.style.transform = '';
      x0 = null; locked = null;
      if (fire) { if (navigator.vibrate) navigator.vibrate(12); e.sets.splice(si, 1); saveActive(); render(true); }
    };
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
    return wrap;
  }
  async function finishWorkout() {
    const w = S.active;
    const live = isLive(w);
    if (!setsOf(w).length) { actions('Nothing logged yet', [], 'Tap the ✓ on at least one set first.'); return; }
    if (!live && w.start > Date.now()) { toast('The date and time can’t be in the future'); return; }
    if (!(await confirmBox(live ? 'Finish workout?' : 'Save workout?', "Sets you haven't checked off will be removed.", live ? 'Finish Workout' : 'Save Workout'))) return;
    const end = live ? Date.now() : w.start + Math.max(1, w.durMin || 60) * 60000;
    const done = { id: w.id, name: (w.name || '').trim() || defaultName(), start: w.start, end, notes: w.notes || '', routineId: w.routineId || null, by: w.by || S.myName,
      exercises: w.exercises.map(e => ({ exerciseId: e.exerciseId, notes: e.notes || '', sets: doneSets(e).map(s => ({ weight: s.weight, reps: s.reps, kind: s.kind || 'normal', done: true })) })).filter(e => e.sets.length) };
    const prs = done.exercises.map(e => {
      const best = Math.max(0, ...e.sets.map(s => s.weight || 0));
      const prior = Math.max(0, ...historyFor(e.exerciseId).filter(x => x.w.id !== done.id && x.w.start < done.start).flatMap(x => doneSets(x.entry).map(s => s.weight || 0)));
      return best > 0 && prior > 0 && best > prior ? { name: exLabelId(e.exerciseId), weight: best } : null;
    }).filter(Boolean);
    S.active = null; saveActive();
    if (w.mode === 'edit') {
      await action('Workout updated', () => put('workouts', done));
      go('#w-' + done.id);
      return;
    }
    try { await put('workouts', done); } catch (e) { showErr(e); }
    go('');
    setTimeout(() => summary(done, prs, live), 150);
  }
  function summary(w, prs, live) {
    chime();
    const sh = sheet(null, h('div', { style: 'text-align:center;display:grid;gap:12px' },
      h('div', { class: 'trophy' }, icon('trophy')),
      h('h2', { style: 'font-size:1.6rem', text: live ? 'Workout complete!' : 'Workout saved!' }),
      h('p', { class: 'muted', style: 'margin:0', text: `That's workout #${S.workouts.length}. Proud of you 💕` }),
      h('div', { class: 'panel', style: 'text-align:left' }, tally(w)),
      prs.length ? h('div', { class: 'panel', style: 'text-align:left' }, h('div', { class: 'accent', style: 'font-weight:700;margin-bottom:6px', text: '🏆 New personal records' }),
        prs.map(p => h('div', { style: 'display:flex;justify-content:space-between;padding:4px 0' }, h('span', { text: p.name }), h('b', { text: fwu(p.weight) })))) : null,
      h('button', { type: 'button', class: 'primary big', text: 'Done', onclick: () => sh.close() })));
  }

  // Rest timer bar (shown during a workout).
  let restEl = null;
  function drawRest() {
    const w = S.active;
    const show = w && w.restEnd && S.view.name === 'active' && !S.needName;
    if (!show) { if (restEl) { restEl.remove(); restEl = null; } return; }
    if (!restEl) {
      restEl = h('div', { class: 'restbar', role: 'timer', 'aria-label': 'Rest timer' },
        h('div', { class: 'rt' }, h('span', { class: 'accent' }, icon('timer')), h('b', { id: 'rest-time', class: 'num' })),
        h('div', { class: 'rbar' }, h('i', { id: 'rest-prog' })),
        h('div', { class: 'btns' },
          h('button', { type: 'button', 'aria-label': 'Subtract 15 seconds', text: '−15s', onclick: () => adjustRest(-15) }),
          h('button', { type: 'button', 'aria-label': 'Add 15 seconds', text: '+15s', onclick: () => adjustRest(15) }),
          h('button', { type: 'button', class: 'primary', text: 'Skip', onclick: () => { S.active.restEnd = null; saveActive(); drawRest(); } })));
      document.body.append(restEl);
    }
    const left = Math.max(0, w.restEnd - Date.now());
    restEl.querySelector('#rest-time').textContent = fmtClock(left + 999);
    restEl.querySelector('#rest-prog').style.width = Math.min(100, left / (w.restDur || 1) * 100) + '%';
  }
  function adjustRest(d) {
    const w = S.active; if (!w || !w.restEnd) return;
    w.restEnd += d * 1000; w.restDur = Math.max(1000, w.restDur + d * 1000);
    if (w.restEnd <= Date.now()) w.restEnd = null;
    saveActive(); drawRest();
  }
  let audioCtx = null;
  function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch { } }
  function chime() {
    try {
      unlockAudio();
      [660, 880].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + i * 0.18;
        o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.32);
      });
    } catch { }
    if (navigator.vibrate) navigator.vibrate(200);
  }
  setInterval(() => {
    const w = S.active; if (!w) return;
    for (const el of document.querySelectorAll('[data-clock]')) el.textContent = fmtClock(Date.now() - w.start);
    const d = document.querySelector('[data-dur]'); if (d) d.textContent = fmtDur(Date.now() - w.start);
    if (w.restEnd && Date.now() >= w.restEnd) { w.restEnd = null; saveActive(); chime(); toast('Rest is over. Time for your next set 💪'); }
    drawRest();
  }, 1000);

  // ---------- charts (SVG strings) ----------
  let gid = 0;
  function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  const kfmt = (v) => v >= 1000 ? num1(v / 1000) + 'k' : num1(v);
  function lineChart(points, suffix) {
    const W = 340, H = 190, L = 44, R = 10, T = 12, B = 24, id = 'g' + (++gid);
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), hi = niceMax(Math.max(...ys) * 1.1), lo = 0;
    const sx = (x) => L + (x1 === x0 ? (W - L - R) / 2 : (x - x0) / (x1 - x0) * (W - L - R));
    const sy = (y) => T + (1 - (y - lo) / (hi - lo || 1)) * (H - T - B);
    const pts = points.map(p => [sx(p.x), sy(p.y)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = `${d} L${pts[pts.length - 1][0]},${H - B} L${pts[0][0]},${H - B} Z`;
    const ticks = [hi / 3, hi * 2 / 3, hi];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart, latest ${num1(ys[ys.length - 1])}">
      <defs><linearGradient id="${id}l" x1="0" x2="1"><stop offset="0" stop-color="#ff5c9e"/><stop offset="1" stop-color="#c08cff"/></linearGradient>
      <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5c9e" stop-opacity=".3"/><stop offset="1" stop-color="#ff5c9e" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 6}" y="${sy(t) + 3.5}" text-anchor="end">${kfmt(t)}${suffix && t === hi ? ' ' + suffix : ''}</text>`).join('')}
      <line class="grid" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      <path d="${area}" fill="url(#${id}a)"/>
      <path d="${d}" fill="none" stroke="url(#${id}l)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6" fill="#ff5c9e"/>`).join('')}
      <text x="${L}" y="${H - 6}">${fmtDate(x0, { month: 'short', day: 'numeric' })}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDate(x1, { month: 'short', day: 'numeric' })}</text></svg>`;
  }
  function barChart(points) {
    const W = 340, H = 180, L = 32, R = 6, T = 10, B = 22, id = 'g' + (++gid);
    const max = niceMax(Math.max(...points.map(p => p.y))), bw = (W - L - R) / points.length;
    const sy = (y) => T + (1 - y / max) * (H - T - B);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Last 12 weeks">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5c9e"/><stop offset="1" stop-color="#c08cff"/></linearGradient></defs>
      ${[0, max / 2, max].map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 5}" y="${sy(t) + 3.5}" text-anchor="end">${kfmt(t)}</text>`).join('')}
      ${points.map((p, i) => { const hh = Math.max(0, H - B - sy(p.y)), x = L + i * bw + bw * .18;
        return `<rect x="${x}" y="${H - B - hh}" width="${bw * .64}" height="${hh}" rx="4" fill="url(#${id})"><title>${num1(p.y)}</title></rect>` +
          (i % 3 === 0 ? `<text x="${x + bw * .32}" y="${H - 6}" text-anchor="middle">${fmtDate(p.x, { month: 'short', day: 'numeric' })}</text>` : ''); }).join('')}</svg>`;
  }

  // ---------- boot ----------
  window.addEventListener('online', () => { flush().then(() => loadAll()); });
  window.addEventListener('offline', () => { S.offline = true; render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.sb && !S.needName) flush().then(() => loadAll()); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker', err));

  // Hidden user log: records who opened the app and on what (read only in Supabase).
  function logVisit() {
    try {
      const last = Number(ls.get('cf-visit-at') || 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      let did = ls.get('cf-device');
      if (!did) { did = Math.random().toString(36).slice(2, 10); ls.set('cf-device', did); }
      const ua = navigator.userAgent;
      const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
      const br = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /EdgiOS|Edg/.test(ua) ? 'Edge' : /Safari/.test(ua) ? 'Safari' : '';
      S.sb.rpc('courtfit_log_visit', { p_name: S.myName || '', p_device: dev + (br ? ' · ' + br : ''), p_mode: standalone() ? 'home screen' : 'browser', p_device_id: did })
        .then(({ error }) => { if (!error) ls.set('cf-visit-at', String(Date.now())); }, () => {});
    } catch { }
  }

  (async () => {
    loadActive();
    S.view = parseHash();
    S.myName = ls.get('cf-name') || '';
    if (DEMO) {
      if (!loadCache()) { S.exercises = (window.COURTFIT_LIBRARY || []).map(([name, equipment, muscle]) => ({ id: window.courtfitExerciseId(name, equipment), name, equipment, muscle })); saveCache(); }
      S.needName = !S.myName; S.loaded = true; render(true); return;
    }
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) { S.setupMissing = true; render(true); return; }
    if (!KEY) { S.badLink = true; render(true); return; }
    try { S.outbox = JSON.parse(ls.get('cf-outbox') || '[]'); } catch { S.outbox = []; }
    S.needName = !S.myName;
    // Show the saved copy right away, then refresh from the server.
    if (loadCache()) { for (const op of S.outbox) applyLocal(op); S.loaded = true; }
    render(true);
    if (!window.supabase) { S.offline = true; S.loaded = true; render(true); return; }
    const baseFetch = window.fetch.bind(window);
    S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, opts = {}) => { const hd = new Headers(opts.headers || {}); hd.set('x-app-key', KEY); hd.set('x-user-name', encodeURIComponent(S.myName || '')); return baseFetch(url, { ...opts, headers: hd }); } }
    });
    try {
      const { data: ok, error } = await S.sb.rpc('app_key_ok');
      if (!error && ok !== true) { S.badLink = true; render(true); return; }
    } catch { }
    logVisit();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') logVisit(); });
    await flush();
    await loadAll();
    let t;
    channel = S.sb.channel('courtfit-changes', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, ({ payload }) => {
        clearTimeout(t);
        const tb = payload && TABLES.includes(payload.table) ? payload.table : null;
        t = setTimeout(() => (tb ? loadTable(tb) : Promise.all(TABLES.map(loadTable))).then(() => { saveCache(); render(); }).catch(() => {}), 200);
      })
      .subscribe();
    setInterval(() => { if (document.visibilityState === 'visible') loadAll(); }, 120000);
  })();
})();
