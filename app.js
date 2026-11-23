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
  const SAMPLE = DEMO && QS.get('sample') === '1'; // preview filled with made-up data (local only)
  const LB_KG = 0.45359237, DAY = 86400000;
  const APP_VERSION = ((document.querySelector('script[src^="app.js"]')?.getAttribute('src') || '').match(/v=(\d+)/) || [])[1] || '0';

  const MUSCLES = ['Glutes', 'Hamstrings', 'Quads', 'Calves', 'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Core', 'Full Body', 'Cardio'];
  const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Smith Machine', 'Other'];

  const S = {
    sb: null, myName: '', exercises: [], routines: [], workouts: [], programs: [], active: null,
    loaded: false, offline: false, outbox: [], view: { name: 'home' }, pendingRender: false,
    search: '', muscle: null, exMetric: 'heaviest', profMetric: 'workouts', rMetric: 'volume',
    calMonth: firstOfMonth(Date.now()), routinesOpen: true,
    progId: null, progWorkout: 'A', progWeek: null, progMode: 'week',
    meals: [], saved_meals: [], body_scans: [], scanMetric: "pbf", mDate: null, thumbs: {}, images: {}
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
  const autoSecs = () => { const v = ls.get('cf-auto'); return v == null || v === '' ? 10 : Number(v); }; // 0 = off

  let toastTimer;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    $toast.replaceChildren(...[h('span', { text: msg }), action ? h('button', { type: 'button', class: 'toastbtn', text: action.label, onclick: () => { $toast.hidden = true; action.run(); } }) : null].filter(Boolean));
    $toast.hidden = false;
    toastTimer = setTimeout(() => { $toast.hidden = true; }, action ? 10000 : 2800);
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
  const KP = { pad: null, inp: null, key: null, buf: '', fresh: false }; // number pad state
  const AUTO = new Map(); // set object -> pending auto-confirm countdown
  const firstNum = (t) => { const m = String(t || '').match(/\d+/); return m ? Number(m[0]) : null; };
  const sortedRoutines = () => [...S.routines].sort((a, b) => (a.order ?? a.created ?? 0) - (b.order ?? b.created ?? 0));

  // ---------- data: Supabase + offline outbox + undo ----------
  // meal_photos is not a list table: photos are fetched only when a day is shown.
  const TABLES = ['exercises', 'routines', 'workouts', 'programs', 'meals', 'saved_meals', 'body_scans'];
  const listOf = (t) => S[t];
  const setList = (t, arr) => { S[t] = arr; };
  const toRow = (t, obj) => { const data = clone(obj); delete data.id; return { id: obj.id, data }; };
  const fromRow = (t, r) => ({ ...(r.data || {}), id: r.id });
  function applyLocal(op) {
    if (!TABLES.includes(op.table)) return;
    const arr = listOf(op.table).filter(x => x.id !== (op.op === 'put' ? op.row.id : op.id));
    if (op.op === 'put') arr.push(fromRow(op.table, op.row));
    setList(op.table, arr);
  }
  function saveCache() { ls.set('cf-cache', JSON.stringify({ exercises: S.exercises, routines: S.routines, workouts: S.workouts, programs: S.programs, meals: S.meals, saved_meals: S.saved_meals, body_scans: S.body_scans, at: Date.now() })); }
  function loadCache() {
    try { const c = JSON.parse(ls.get('cf-cache') || 'null'); if (c) { S.exercises = c.exercises || []; S.routines = c.routines || []; S.workouts = c.workouts || []; S.programs = c.programs || []; S.meals = c.meals || []; S.saved_meals = c.saved_meals || []; S.body_scans = c.body_scans || []; return true; } } catch { }
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
      S.loaded = true; S.synced = true; S.offline = S.outbox.length > 0; saveCache();
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
    if (s === 'strongher') return { name: 'strongher' };
    if (s === 'macros') return { name: 'macros' };
    if (s === 'exercises') return { name: 'exercises' };
    if (s === 'settings') return { name: 'settings' };
    if (s === 'active') return { name: 'active' };
    if ((m = s.match(/^routine-([A-Za-z0-9_-]+)$/))) return { name: 'routine', id: m[1] };
    if ((m = s.match(/^ex-([A-Za-z0-9_-]+)$/))) return { name: 'exercise', id: m[1] };
    if ((m = s.match(/^w-([A-Za-z0-9_-]+)$/))) return { name: 'wdetail', id: m[1] };
    return { name: 'home' };
  }
  function route() {
    flushProg();
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
    else if (v.name === 'strongher') node = programView();
    else if (v.name === 'macros') node = macrosView();
    else if (v.name === 'settings') node = settingsView();
    else node = homeView();
    const banner = SAMPLE ? h('div', { class: 'banner', style: 'margin-top:10px', text: 'Preview with sample data. Nothing here is saved online.' }) : S.offline ? h('div', { class: 'banner' },
      'No connection. Showing what is saved on this phone.',
      S.outbox.length ? ` ${S.outbox.length} change${S.outbox.length === 1 ? '' : 's'} will sync when you are back online.` : '') : null;
    $app.replaceChildren(...[banner, node].filter(Boolean));
    if (S.loaded) { clearTimeout(S.badgeTimer); S.badgeTimer = setTimeout(checkAchievements, 700); }
    if (!force) window.scrollTo(0, y);
    updateChrome();
    if (KP.key) kpReattach();
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
    if (v.name === 'strongher') return 'strongher';
    if (v.name === 'macros') return 'macros';
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
      close() { if (!wrap.isConnected) return; wrap.remove(); const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1); if (api.onClose) api.onClose(); if (!openSheets.length) setTimeout(checkAchievements, 450); }
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
    const act = activityMap();
    const trainedDays = Object.keys(act).filter(k => act[k].w.length || act[k].s.length);
    const n = trainedDays.filter(k => new Date(k + 'T00:00').getTime() >= wk).reduce((a, k) => a + act[k].w.length + act[k].s.length, 0);
    const days = new Set(trainedDays.map(k => new Date(k + 'T00:00').getTime()));
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
      renderRuns(r.items || [], (it) => {
        const ex = findEx(it.exerciseId);
        return h('div', { style: 'margin-bottom:18px' },
          h('a', { class: 'exlink', href: '#ex-' + it.exerciseId }, thumb(ex?.muscle, 'lg'), exLabel(ex)),
          h('div', { class: 'rtable', role: 'table' },
            h('div', { class: 'r h', role: 'row' }, h('span', { text: 'SET' }), h('span', { text: unit().toUpperCase() }), h('span', { text: 'REP RANGE' })),
            (it.sets || []).map((s, i) => h('div', { class: 'r', role: 'row' }, h('b', { text: String(i + 1) }), h('span', { text: s.weight ? fw(s.weight) : '—' }), h('span', { text: s.reps || '—' })))));
      }));
  }

  // ---------- achievements ----------
  // Worked out from the data each time (nothing extra stored online). The phone remembers
  // which ones it has already celebrated in localStorage ('cf-badges-seen').
  function longestRun(sorted, isNext) { let best = 0, run = 0; sorted.forEach((x, i) => { run = i && isNext(sorted[i - 1], x) ? run + 1 : 1; best = Math.max(best, run); }); return best; }
  function prCount() {
    const best = {}; let n = 0;
    for (const w of [...S.workouts].sort((a, b) => a.start - b.start)) for (const e of w.exercises || []) {
      const top = Math.max(0, ...doneSets(e).map(s => s.weight || 0)); if (!top) continue;
      if (best[e.exerciseId] && top > best[e.exerciseId]) n++;
      if (!best[e.exerciseId] || top > best[e.exerciseId]) best[e.exerciseId] = top;
    }
    return n;
  }
  function achievements() {
    const act = activityMap();
    const nextDay = (a, b) => shiftDay(a, 1) === b;
    const trainWeeks = [...new Set(Object.keys(act).filter(k => act[k].w.length || act[k].s.length).map(k => startOfWeek(new Date(k + 'T00:00').getTime())))].sort((a, b) => a - b);
    const weekRun = longestRun(trainWeeks, (a, b) => Math.round((b - a) / DAY) === 7);
    const foodDays = Object.keys(act).filter(k => act[k].m.length).sort();
    const g = goals();
    const proteinDays = foodDays.filter(k => totals(act[k].m).p >= g.p);
    const shSessions = Object.values(act).reduce((n, a) => n + a.s.length, 0);
    const roundDone = S.programs.some(p => (p.workouts || []).some(w => { const wk = (p.log || {})[w.key]?.weeks || []; return wk.length >= (p.weeks || 6) && weekHas(wk[(p.weeks || 6) - 1] || {}); }));
    const scans = sortedScans(), first = scans[0], last = scans[scans.length - 1];
    const muscleUp = scans.length >= 2 && has(first.smm) && has(last.smm) && Number(last.smm) > Number(first.smm);
    const fatDown = scans.length >= 2 && has(first.pbf) && has(last.pbf) && Number(last.pbf) < Number(first.pbf);
    const supersets = S.workouts.filter(w => supersetRuns(w.exercises || []).some(r => r.group)).length;
    const n = S.workouts.length, prs = prCount();
    return [
      ['w1', '🌱', 'First workout', n, 1], ['w10', '💪', '10 workouts', n, 10], ['w25', '🔥', '25 workouts', n, 25], ['w50', '👑', '50 workouts', n, 50], ['w100', '💎', '100 workouts', n, 100],
      ['pr1', '🏆', 'First PR', prs, 1], ['pr10', '🥇', '10 PRs', prs, 10], ['pr25', '🌟', '25 PRs', prs, 25],
      ['st2', '✨', '2-week streak', weekRun, 2], ['st4', '🌸', '4-week streak', weekRun, 4], ['st8', '🦋', '8-week streak', weekRun, 8], ['st12', '🌈', '12-week streak', weekRun, 12],
      ['sh1', '💗', 'First StrongHER session', shSessions, 1], ['sh10', '💞', '10 StrongHER sessions', shSessions, 10], ['shr', '🎀', 'Finished a 6-week round', roundDone ? 1 : 0, 1],
      ['m1', '🍓', 'First food logged', foodDays.length, 1], ['m7', '🥗', '7 days of food in a row', longestRun(foodDays, nextDay), 7], ['p7', '🥚', 'Protein goal 7 days in a row', longestRun(proteinDays, nextDay), 7],
      ['sm1', '♡', 'First saved meal', S.saved_meals.length, 1], ['ss1', '🔗', 'First superset workout', supersets, 1],
      ['b1', '📊', 'First InBody scan', scans.length, 1], ['b3', '📈', '3 InBody scans', scans.length, 3], ['bm', '🌷', 'More muscle than your first scan', muscleUp ? 1 : 0, 1], ['bf', '🍑', 'Lower body fat than your first scan', fatDown ? 1 : 0, 1]
    ].map(([id, em, name, have, need]) => ({ id, em, name, have: Math.min(have, need), need, on: have >= need }));
  }
  function achievementsPanel() {
    const list = achievements(), on = list.filter(a => a.on);
    // Earned first, then the closest ones still to go.
    const locked = list.filter(a => !a.on).sort((a, b) => b.have / b.need - a.have / a.need);
    const shown = S.badgesAll ? [...on, ...locked] : [...on.slice(-6), ...locked.slice(0, Math.max(3, 6 - Math.min(on.length, 6)))];
    const badge = (a) => h('div', { class: 'badge' + (a.on ? ' on' : ''), role: 'img', 'aria-label': `${a.name}${a.on ? ', earned' : `, ${a.have} of ${a.need}`}` },
      h('span', { class: 'em', 'aria-hidden': 'true', text: a.em }), h('b', { text: a.name }),
      a.on ? h('small', { text: 'Earned' }) : a.need > 1 ? [h('span', { class: 'bar' }, h('i', { style: `width:${Math.round(a.have / a.need * 100)}%` })), h('small', { text: `${a.have} / ${a.need}` })] : h('small', { text: 'Not yet' }));
    return h('div', { class: 'panel' },
      h('div', { class: 'hd' }, h('h2', { text: 'Achievements' }), h('span', { class: 'muted', style: 'font-size:.85rem', text: `${on.length} of ${list.length}` })),
      h('div', { class: 'badges' }, shown.map(badge)),
      h('button', { type: 'button', class: 'link', onclick: () => { S.badgesAll = !S.badgesAll; render(true); } }, S.badgesAll ? 'Show fewer' : `See all ${list.length}`));
  }
  function confetti() {
    const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    const colors = ['#f7a3c7', '#d3b8f5', '#ffc4ad', '#ffffff', '#f490bb', '#b9e4d6', '#fde68a'];
    for (let i = 0; i < 80; i++) {
      const p = h('i'); p.style.left = (Math.random() * 100).toFixed(1) + '%'; p.style.background = colors[i % colors.length];
      p.style.animationDuration = (1.8 + Math.random() * 1.8).toFixed(2) + 's'; p.style.animationDelay = (Math.random() * .6).toFixed(2) + 's';
      p.style.transform = `rotate(${Math.round(Math.random() * 360)}deg)`; box.append(p);
    }
    document.body.append(box); setTimeout(() => box.remove(), 4500);
  }
  function checkAchievements() {
    if (!S.synced || S.needName) return;
    const list = achievements(), earned = list.filter(a => a.on).map(a => a.id);
    let seen = null; try { seen = JSON.parse(ls.get('cf-badges-seen') || 'null'); } catch { }
    if (!Array.isArray(seen)) { ls.set('cf-badges-seen', JSON.stringify(earned)); return; } // first run on this phone: no fanfare for old ones
    const fresh = list.filter(a => a.on && !seen.includes(a.id));
    if (!fresh.length) return;
    const a = document.activeElement;
    if (openSheets.length || S.view.name === 'active' || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) return; // celebrate at a calmer moment
    ls.set('cf-badges-seen', JSON.stringify([...new Set([...seen, ...earned])]));
    confetti();
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    const sh = sheet(null, h('div', { style: 'text-align:center;display:grid;gap:12px;padding:6px 0 4px' },
      h('div', { style: 'font-size:3.2rem;line-height:1', 'aria-hidden': 'true', text: fresh.map(x => x.em).join(' ') }),
      h('h2', { style: 'font-size:1.5rem', text: fresh.length === 1 ? 'New achievement!' : `${fresh.length} new achievements!` }),
      h('div', { class: 'stack', style: 'gap:6px' }, fresh.map(x => h('b', { text: x.name }))),
      h('p', { class: 'muted', style: 'margin:0', text: 'See them all on your Profile.' }),
      h('button', { type: 'button', class: 'primary big', text: 'Yay! 💖', onclick: () => sh.close() })));
  }

  // ---------- supersets ----------
  // Exercises next to each other with the same `group` form a superset (like StrongHER's 1.1 + 1.2).
  function supersetRuns(items) {
    const runs = [];
    items.forEach((it, i) => { const g = it.group || null, last = runs[runs.length - 1]; if (g && last && last.group === g) last.idxs.push(i); else runs.push({ group: g, idxs: [i] }); });
    return runs.map(r => (r.group && r.idxs.length > 1 ? r : { group: null, idxs: r.idxs }));
  }
  function normalizeGroups(items) {
    const keep = new Set(); for (const r of supersetRuns(items)) if (r.group) r.idxs.forEach(i => keep.add(i));
    items.forEach((it, i) => { if (!keep.has(i) && it.group) delete it.group; });
  }
  const linkedToNext = (items, i) => !!(items[i] && items[i + 1] && items[i].group && items[i].group === items[i + 1].group);
  function toggleLink(items, i) {
    if (!items[i + 1]) return;
    if (linkedToNext(items, i)) {
      const g = items[i].group, ng = uid('g');
      for (let j = i + 1; j < items.length && items[j].group === g; j++) items[j].group = ng;
    } else {
      const g = items[i].group || uid('g'), old = items[i + 1].group;
      items[i].group = g;
      if (old) { for (let j = i + 1; j < items.length && items[j].group === old; j++) items[j].group = g; } else items[i + 1].group = g;
    }
    normalizeGroups(items);
  }
  // Rest only after the last exercise of a superset round.
  function endsRound(items, entry) {
    const idx = items.indexOf(entry), run = supersetRuns(items).find(r => r.idxs.includes(idx));
    return !run || !run.group || run.idxs[run.idxs.length - 1] === idx;
  }
  function renderRuns(items, fn) {
    let letter = 0;
    return supersetRuns(items).map(r => r.group
      ? h('div', { class: 'ssgroup' }, h('div', { class: 'sslabel' }, icon('repeat', 'ic sm'), `Superset ${String.fromCharCode(65 + letter++)} · ${r.idxs.length} exercises`), r.idxs.map(i => fn(items[i], i)))
      : r.idxs.map(i => fn(items[i], i)));
  }

  // ---------- routine editor ----------
  function routineEditor(r) {
    const d = { name: r ? r.name : '', items: r ? clone(r.items || []) : [] };
    const list = h('div', { class: 'stack' });
    const nameIn = h('input', { value: d.name, placeholder: 'e.g. Booty Builder', autocomplete: 'off', oninput: (e) => { d.name = e.target.value; } });
    function draw() {
      normalizeGroups(d.items);
      const linkToggle = (i) => h('div', { class: 'linkbtn' }, h('button', { type: 'button', 'aria-pressed': String(linkedToNext(d.items, i)), onclick: () => { toggleLink(d.items, i); draw(); } },
        icon('repeat', 'ic sm'), linkedToNext(d.items, i) ? 'Superset · tap to unlink' : 'Make superset with next'));
      list.replaceChildren(...(d.items.length ? d.items.flatMap((it, i) => [h('div', { class: 'rrow' },
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
        h('button', { type: 'button', class: 'soft small', onclick: () => { const l = it.sets[it.sets.length - 1]; it.sets.push(l ? { ...l } : { weight: null, reps: '8-10' }); draw(); } }, icon('plus', 'ic sm'), 'Add Set')), i < d.items.length - 1 ? linkToggle(i) : null]).filter(Boolean)
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
      }).flat().filter(Boolean) : [h('p', { class: 'muted', text: 'No exercises match.' })]));
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
          { label: 'Edit Workout', icon: 'edit', run: () => startWorkout(w.name, (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, group: e.group || null, notes: e.notes || '',
            sets: (e.sets || []).map(s => ({ ...newSet(s.weight, s.reps, s.kind), done: true })) })), w.routineId, { edit: w }) },
          { label: 'Save as Routine', icon: 'edit', run: () => action('Saved as routine', () => put('routines', { id: uid('r'), name: w.name, by: S.myName, created: Date.now(), order: S.routines.length,
            items: (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, group: e.group || null, sets: doneSets(e).map(s => ({ weight: s.weight || null, reps: s.reps ? String(s.reps) : '' })) })) })) },
          { label: 'Delete Workout', icon: 'trash', danger: true, run: async () => { if (await confirmBox('Delete this workout?', 'You can undo right after.', 'Delete Workout', true)) { await action('Workout deleted', () => del('workouts', w.id)); go(''); } } }
        ]) }, icon('dots'))),
      h('div', { class: 'panel' }, h('h1', { style: 'font-size:1.5rem', text: w.name }), h('p', { class: 'muted', style: 'margin:2px 0 14px', text: fmtWhen(w.start) }), tally(w),
        w.notes ? h('p', { style: 'margin:12px 0 0;white-space:pre-wrap', text: w.notes }) : null),
      renderRuns(w.exercises || [], e => h('div', { class: 'panel' },
        h('a', { class: 'exlink', href: '#ex-' + e.exerciseId, style: 'margin-bottom:8px' }, thumb(findEx(e.exerciseId)?.muscle, 'sm'), exLabelId(e.exerciseId)),
        e.notes ? h('p', { class: 'muted', style: 'margin:0 0 6px', text: e.notes }) : null, setTable(e))),
      h('button', { type: 'button', class: 'primary big', style: 'margin-top:16px', onclick: () => startWorkout(w.name, (w.exercises || []).map(e => ({ exerciseId: e.exerciseId, group: e.group || null, sets: doneSets(e).map(s => newSet(s.weight, s.reps, s.kind)) })), w.routineId) }, icon('repeat'), 'Repeat Workout'));
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
        tile('flame', 'Week streak', String(streaks(activityMap()).weeks)), tile('cal', 'This month', String(month)),
        tile('weight', 'Total volume', fvol(list.reduce((a, w) => a + volumeOf(w), 0))), tile('clock', 'Total time', fmtDur(list.reduce((a, w) => a + durOf(w), 0)))),
      h('div', { style: 'margin-top:12px' }, scansPanel()),
      achievementsPanel(),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Last 12 weeks' })),
        h('div', { class: 'pills', style: 'margin:10px 0' }, pill('workouts', 'Workouts'), pill('minutes', 'Minutes'), pill('volume', 'Volume')),
        svgFrom(barChart(weekly))),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Muscle split' }), h('span', { class: 'muted', style: 'font-size:.8rem', text: 'Sets, last 30 days' })),
        split.length ? split.map(([m, c]) => h('div', { class: 'hbar', role: 'img', 'aria-label': `${m}: ${c} sets` }, h('span', { text: m }), h('span', { class: 'tr' }, h('i', { style: `width:${Math.max(4, c / top * 100)}%` })), h('b', { style: 'text-align:right', text: String(c) })))
          : h('p', { class: 'muted', text: 'No sets logged in the last 30 days.' })),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Calendar' })), h('div', { style: 'margin-top:8px' }, calendar())));
  }
  function weekStreak(list) {
    const weeks = new Set(list.map(w => startOfWeek(w.start)));
    let c = startOfWeek(Date.now()); if (!weeks.has(c)) c = addDays(c, -7);
    let n = 0; while (weeks.has(c)) { n++; c = addDays(c, -7); }
    return n;
  }
  // Everything logged, by day: workouts, StrongHER sessions (by each week's date) and macros.
  function activityMap() {
    const map = {};
    const at = (iso) => (map[iso] = map[iso] || { w: [], s: [], m: [], b: [] });
    for (const w of S.workouts) at(isoOf(new Date(w.start))).w.push(w);
    for (const p of S.programs) for (const wk of p.workouts || []) {
      ((p.log || {})[wk.key]?.weeks || []).forEach((x, i) => { if (x && x.date && weekHas(x)) at(x.date).s.push({ p, key: wk.key, phase: wk.phase, week: i }); });
    }
    for (const m of S.meals) if (m.date) at(m.date).m.push(m);
    for (const b of S.body_scans) if (b.date) at(b.date).b.push(b);
    return map;
  }
  // Weeks in a row with a workout or StrongHER session; days in a row with food logged.
  function streaks(map) {
    const trainWeeks = new Set(Object.keys(map).filter(k => map[k].w.length || map[k].s.length).map(k => startOfWeek(new Date(k + 'T00:00').getTime())));
    let c = startOfWeek(Date.now()); if (!trainWeeks.has(c)) c = addDays(c, -7);
    let weeks = 0; while (trainWeeks.has(c)) { weeks++; c = addDays(c, -7); }
    let d = todayISO(); if (!(map[d] && map[d].m.length)) d = shiftDay(d, -1);
    let days = 0; while (map[d] && map[d].m.length) { days++; d = shiftDay(d, -1); }
    return { weeks, days };
  }
  function calendar() {
    const map = activityMap();
    const m = new Date(S.calMonth), y = m.getFullYear(), mo = m.getMonth();
    const count = new Date(y, mo + 1, 0).getDate(), off = new Date(y, mo, 1).getDay(), today = todayISO();
    const shift = (d) => { const x = new Date(S.calMonth); x.setMonth(x.getMonth() + d); S.calMonth = x.getTime(); render(true); };
    const cells = [];
    for (let i = 0; i < 7; i++) cells.push(h('div', { class: 'wd', 'aria-hidden': 'true', text: new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' }) }));
    for (let i = 0; i < off; i++) cells.push(h('div'));
    for (let d = 1; d <= count; d++) {
      const iso = isoOf(new Date(y, mo, d)), a = map[iso] || { w: [], s: [], m: [], b: [] };
      const trained = a.w.length || a.s.length;
      const what = [a.w.length && 'workout', a.s.length && 'StrongHER', a.m.length && 'food logged', a.b.length && 'InBody scan'].filter(Boolean);
      cells.push(h('button', { type: 'button', class: 'dy' + (trained ? ' on' : '') + (iso === today ? ' today' : ''), onclick: () => daySheet(iso, a),
        'aria-label': fmtDate(new Date(iso + 'T00:00'), { month: 'long', day: 'numeric' }) + (what.length ? ': ' + what.join(', ') : '') },
        h('span', { text: String(d) }),
        h('span', { class: 'dots', 'aria-hidden': 'true' }, a.w.length ? h('i', { class: 'dw' }) : null, a.s.length ? h('i', { class: 'ds' }) : null, a.m.length ? h('i', { class: 'dm' }) : null, a.b.length ? h('i', { class: 'db' }) : null)));
    }
    const st = streaks(map);
    return h('div', null,
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' },
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('back')),
        h('b', { text: m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next month', onclick: () => shift(1) }, icon('next'))),
      h('div', { class: 'cal' }, cells),
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'dw' }), 'Workout'), h('span', null, h('i', { class: 'ds' }), 'StrongHER'), h('span', null, h('i', { class: 'dm' }), 'Macros'), h('span', null, h('i', { class: 'db' }), 'InBody')),
      h('div', { class: 'tally', style: 'margin-top:12px' },
        h('div', null, h('span', { text: 'Training streak' }), h('b', { text: `${st.weeks} week${st.weeks === 1 ? '' : 's'}` })),
        h('div', null, h('span', { text: 'Food log streak' }), h('b', { text: `${st.days} day${st.days === 1 ? '' : 's'}` })),
        h('div', null, h('span', { text: 'Tap a day' }), h('b', { text: 'for details' }))));
  }
  function daySheet(iso, a) {
    const t = totals(a.m), go2 = (fn) => { sh.close(); fn(); };
    const sh = sheet(new Date(iso + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), h('div', { class: 'stack' },
      a.w.map(w => h('a', { class: 'card', href: '#w-' + w.id, onclick: () => sh.close() }, h('div', { class: 'eyebrow', text: 'Workout' }), h('h3', { text: w.name }), tally(w))),
      a.s.map(x => h('button', { type: 'button', class: 'card', onclick: () => go2(() => { S.progId = x.p.id; S.progWorkout = x.key; S.progWeek = x.week; S.progMode = 'week'; go('#strongher'); }) },
        h('div', { class: 'eyebrow', text: 'StrongHER' }), h('h3', { text: `Workout ${x.key} · ${x.phase || ''} — Week ${x.week + 1}` }), h('div', { class: 'meta', text: `Round ${x.p.round || ''}${x.p.theme ? ' · ' + x.p.theme : ''}` }))),
      a.m.length ? h('button', { type: 'button', class: 'card', onclick: () => go2(() => { S.mDate = iso; go('#macros'); }) },
        h('div', { class: 'eyebrow', text: 'Macros' }), h('h3', { text: `${Math.round(t.cal).toLocaleString()} kcal · ${a.m.length} food${a.m.length === 1 ? '' : 's'}` }),
        h('div', { class: 'meta', text: `Protein ${Math.round(t.p)} g · Carbs ${Math.round(t.c)} g · Fat ${Math.round(t.f)} g` })) : null,
      (a.b || []).map(b => h('button', { type: 'button', class: 'card', onclick: () => go2(() => scanDetail(b.id)) },
        h('div', { class: 'eyebrow', text: 'InBody scan' }), h('h3', { text: scanHeadline(b) }))),
      !a.w.length && !a.s.length && !a.m.length && !a.b.length ? h('p', { class: 'muted', text: 'Nothing logged this day.' }) : null));
  }

  // ---------- InBody body scans ----------
  // body_scans rows: { date, weight, smm, bfm (masses stored in lb), pbf %, bmi, vfl, bmr kcal, score,
  //   optional tbw/icw/ecw (lb), ecwr, smi, pa, seg: { la, ra, tr, ll, rl } (lean mass in lb), notes, hasPhoto }.
  // The printout photo is stored like meal photos (meal_photos table, same id as the scan).
  const SCAN_FIELDS = [
    { k: 'weight', label: 'Weight', mass: true, better: 0 },
    { k: 'smm', label: 'Skeletal Muscle Mass', short: 'Muscle', mass: true, better: 1 },
    { k: 'bfm', label: 'Body Fat Mass', short: 'Fat mass', mass: true, better: -1 },
    { k: 'pbf', label: 'Percent Body Fat', short: 'Body fat', unit: '%', dec: 1, better: -1 },
    { k: 'bmi', label: 'BMI', dec: 1, better: 0 },
    { k: 'vfl', label: 'Visceral Fat Level', short: 'Visceral fat', better: -1 },
    { k: 'bmr', label: 'Basal Metabolic Rate', short: 'BMR', unit: 'kcal', better: 0 },
    { k: 'score', label: 'InBody Score', short: 'Score', better: 1 },
    // Extra numbers from the InBody app's History tab (optional when adding a scan).
    { k: 'tbw', label: 'Total Body Water', short: 'Body water', mass: true, better: 0, extra: true },
    { k: 'icw', label: 'Intracellular Water', short: 'ICW', mass: true, better: 0, extra: true },
    { k: 'ecw', label: 'Extracellular Water', short: 'ECW', mass: true, better: 0, extra: true },
    { k: 'ecwr', label: 'ECW Ratio', short: 'ECW ratio', dec: 3, better: -1, extra: true },
    { k: 'smi', label: 'SMI', unit: 'kg/m²', dec: 1, better: 1, extra: true },
    { k: 'pa', label: 'Whole Body Phase Angle', short: 'Phase angle', unit: '°', dec: 1, better: 1, extra: true }
  ];
  // Order and colors of the History chart cards (pink = weight/fat, mint = muscle/water, slate = scores).
  const SCAN_HISTORY = [['score', 's', 'Points'], ['bmr', 'p', 'kcal'], ['weight', 'p'], ['smm', 'g'], ['bfm', 'p'], ['bmi', 'p', 'kg/m²'], ['pbf', 'p', '%'],
    ['vfl', 'p', 'Level'], ['tbw', 'g'], ['icw', 'g'], ['ecw', 'g'], ['ecwr', 'g'], ['smi', 's', 'kg/m²'], ['pa', 's', '°']];
  const scanNum = (f, v) => f.dec ? Number(v).toFixed(f.dec) : num1(Number(v));
  const SEG = [['la', 'Left arm'], ['ra', 'Right arm'], ['tr', 'Trunk'], ['ll', 'Left leg'], ['rl', 'Right leg']];
  const sortedScans = () => [...S.body_scans].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)));
  const has = (v) => v !== '' && v != null && isFinite(Number(v));
  const scanVal = (f, v) => !has(v) ? '—' : f.mass ? fwu(Number(v)) : `${scanNum(f, v)}${f.unit ? (f.unit === '%' || f.unit === '°' ? f.unit : ' ' + f.unit) : ''}`;
  function scanHeadline(b) {
    const parts = [has(b.weight) && fwu(b.weight), has(b.pbf) && `${num1(b.pbf)}% body fat`, has(b.smm) && `${fwu(b.smm)} muscle`].filter(Boolean);
    return parts.join(' · ') || 'Scan';
  }
  // Change since the previous scan, e.g. "+0.8 lb muscle". Green when it moved the good way.
  function scanDelta(f, cur, prev) {
    if (!prev || !has(cur[f.k]) || !has(prev[f.k])) return null;
    const d = Number(cur[f.k]) - Number(prev[f.k]);
    if (f.dec !== 3 && Math.abs(d) < 0.05) return { text: 'no change', cls: '' };
    if (f.dec === 3 && Math.abs(d) < 0.0005) return { text: 'no change', cls: '' };
    const shown = f.mass ? num1(disp(Math.abs(d))) + ' ' + unit() : (f.dec ? Math.abs(d).toFixed(f.dec) : num1(Math.abs(d))) + (f.unit === '%' ? '%' : '');
    const good = f.better === 0 ? null : (d > 0) === (f.better > 0);
    return { text: `${d > 0 ? '+' : '−'}${shown}`, cls: good == null ? '' : good ? 'good' : 'bad' };
  }

  function scansPanel() {
    const list = sortedScans(), last = list[list.length - 1], prev = list[list.length - 2];
    const metric = SCAN_FIELDS.find(f => f.k === S.scanMetric) || SCAN_FIELDS[3];
    // Last 6 scans with this number, each dot labeled with its value and date (History has them all).
    const pts = list.filter(b => has(b[metric.k])).slice(-6).map(b => {
      const y = metric.mass ? disp(Number(b[metric.k])) : Number(b[metric.k]);
      return { y, date: b.date, label: metric.mass ? y.toFixed(1) : scanNum(metric, b[metric.k]) };
    });
    const color = (SCAN_HISTORY.find(([k]) => k === metric.k) || [])[1] || 'p';
    if (last && last.hasPhoto) wantThumbs([last.id]);
    const pill = (f) => h('button', { type: 'button', 'aria-pressed': String(f.k === metric.k), onclick: () => { S.scanMetric = f.k; render(true); } }, f.short || f.label);
    return h('div', { class: 'panel' },
      h('div', { class: 'hd' }, h('h2', { text: 'InBody scans' }),
        h('button', { type: 'button', class: 'small primary', onclick: () => scanSheet(null) }, icon('plus', 'ic sm'), 'Add scan')),
      !last ? h('div', { class: 'empty', style: 'margin-top:12px;padding:24px 16px' }, h('h2', { style: 'font-size:1.1rem', text: 'No scans yet' }),
        h('p', { text: 'After each InBody scan, snap the printout and add the main numbers to see your progress over time.' }))
      : [
        h('button', { type: 'button', class: 'scanlast', onclick: () => scanDetail(last.id) },
          last.hasPhoto && S.thumbs[last.id] ? h('img', { src: S.thumbs[last.id], alt: 'InBody printout photo', class: 'mthumb' }) : h('span', { class: 'mthumb ph', 'aria-hidden': 'true' }, icon('weight')),
          h('span', { class: 'grow' }, h('span', { class: 't', text: 'Latest scan' }), h('span', { class: 's', text: fmtDate(new Date(last.date + 'T12:00')) + (prev ? ` · vs ${fmtDate(new Date(prev.date + 'T12:00'), { month: 'short', day: 'numeric' })}` : '') })),
          icon('next', 'ic sm')),
        h('div', { class: 'scangrid' }, SCAN_FIELDS.filter(f => ['weight', 'smm', 'pbf', 'bfm'].includes(f.k)).map(f => {
          const dl = scanDelta(f, last, prev);
          return h('div', { class: 'scanstat' }, h('span', { text: f.short || f.label }), h('b', { text: scanVal(f, last[f.k]) }), dl ? h('small', { class: dl.cls, text: dl.text }) : null);
        })),
        list.length >= 2 ? [h('div', { class: 'pills', style: 'margin:14px 0 8px' }, SCAN_FIELDS.filter(f => ['weight', 'smm', 'pbf', 'bfm', 'score'].includes(f.k)).map(pill)),
          pts.length >= 2 ? svgFrom(scanChart(pts, color, metric.label)) : h('p', { class: 'muted', text: 'Add this number to two or more scans to see a chart.' })] : null,
        h('div', { class: 'duo', style: 'margin-top:12px' },
          h('button', { type: 'button', class: 'soft', style: 'justify-content:center', onclick: scanHistory }, icon('chart', 'ic sm'), 'History'),
          h('button', { type: 'button', style: 'justify-content:center', onclick: scansList }, `All scans (${list.length})`))]);
  }

  // History: one chart card per stat, every scan labeled, so she can compare like the InBody app.
  function scanHistory() {
    const all = sortedScans();
    let mode = 'recent';
    const body = h('div', { class: 'stack' });
    const draw = () => {
      const list = mode === 'recent' ? all.slice(-6) : all;
      const cards = SCAN_HISTORY.map(([k, color, tag]) => {
        const f = SCAN_FIELDS.find(x => x.k === k);
        const rows = list.filter(b => has(b[k]));
        if (!rows.length) return null;
        const last = rows[rows.length - 1];
        const val = (b) => f.mass ? disp(Number(b[k])) : Number(b[k]);
        const shown = (b) => f.mass ? val(b).toFixed(1) : scanNum(f, b[k]);
        return h('div', { class: 'hcard' },
          h('div', { class: 'hhd' }, h('h3', null, f.label, h('small', { text: ` (${f.mass ? unit() : tag || ''})`.replace(' ()', '') })),
            h('span', { class: 'hlast' }, h('span', { text: fmtDate(new Date(last.date + 'T12:00'), { month: 'short', day: 'numeric', year: '2-digit' }) }), h('b', { text: shown(last) }))),
          svgFrom(scanChart(rows.map(b => ({ y: val(b), label: shown(b), date: b.date })), color, f.label)));
      }).filter(Boolean);
      body.replaceChildren(
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Which scans' },
          h('button', { type: 'button', 'aria-pressed': String(mode === 'recent'), onclick: () => { mode = 'recent'; draw(); } }, 'Last 6 scans'),
          h('button', { type: 'button', 'aria-pressed': String(mode === 'all'), onclick: () => { mode = 'all'; draw(); } }, `All ${all.length} scans`)),
        ...(cards.length ? cards : [h('p', { class: 'muted', text: 'Add a scan to see your history.' })]));
    };
    draw();
    sheet('InBody history', body, { tall: true });
  }
  // Evenly spaced points with each value written above its dot and the date underneath.
  function scanChart(pts, color, name) {
    const n = pts.length, W = 340, H = 158, L = 26, R = 26, T = 30, B = 26;
    const ys = pts.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || Math.max(Math.abs(hi) * 0.05, 1);
    const sx = (i) => n === 1 ? W / 2 : L + i * (W - L - R) / (n - 1);
    const sy = (y) => T + 8 + (1 - (y - lo) / span) * (H - T - B - 16) - (hi === lo ? (H - T - B - 16) / 2 : 0);
    const xy = pts.map((p, i) => [sx(i), sy(p.y)]);
    // Smooth curve through the points (Catmull-Rom turned into cubic Béziers).
    let d = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    const lx = xy[n - 1][0];
    const dateTxt = (iso, i) => { const dt = new Date(iso + 'T12:00'); return fmtDate(dt, i === 0 || dt.getMonth() === 0 ? { month: 'numeric', day: 'numeric', year: '2-digit' } : { month: 'numeric', day: 'numeric' }); };
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<svg class="hchart ${color}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)}: ${pts.map(p => esc(p.label)).join(', ')}">
      ${[0, 1, 2, 3].map(i => `<line class="grid" x1="8" x2="${W - 8}" y1="${T + i * (H - T - B) / 3}" y2="${T + i * (H - T - B) / 3}"/>`).join('')}
      <line class="now" x1="${lx}" x2="${lx}" y1="${T - 6}" y2="${H - B}"/>
      ${n > 1 ? `<path class="ln" d="${d}"/>` : ''}
      ${xy.map(([x, y], i) => `<circle class="dot" cx="${x}" cy="${y}" r="5"/><text class="v" x="${x}" y="${y - 10}" text-anchor="middle">${esc(pts[i].label)}</text>`).join('')}
      ${xy.map(([x], i) => `<text class="dt" x="${x}" y="${H - 7}" text-anchor="middle">${esc(dateTxt(pts[i].date, i))}</text>`).join('')}
    </svg>`;
  }

  function scansList() {
    const list = sortedScans().reverse();
    wantThumbs(list.filter(b => b.hasPhoto).map(b => b.id));
    sheet('InBody scans', h('div', { class: 'stack' }, list.map((b, i) => {
      const prev = list[i + 1];
      const dl = scanDelta(SCAN_FIELDS[3], b, prev);
      return h('button', { type: 'button', class: 'mcard', onclick: () => scanDetail(b.id) },
        b.hasPhoto && S.thumbs[b.id] ? h('img', { src: S.thumbs[b.id], alt: 'InBody printout photo', class: 'mthumb' }) : h('span', { class: 'mthumb ph', 'aria-hidden': 'true' }, icon('weight')),
        h('span', { class: 'grow' }, h('span', { class: 't', text: fmtDate(new Date(b.date + 'T12:00')) }), h('span', { class: 's', text: scanHeadline(b) }),
          dl ? h('span', { class: 'mchips' }, h('i', { class: 'mp', text: `Body fat ${dl.text}` })) : null),
        icon('next', 'ic sm'));
    })), { tall: true });
  }

  function scanDetail(id) {
    const b = S.body_scans.find(x => x.id === id); if (!b) return;
    const list = sortedScans(), prev = list[list.findIndex(x => x.id === id) - 1];
    const photo = b.hasPhoto ? h('img', { class: 'fullphoto', alt: 'InBody printout photo', src: S.images[id] || S.thumbs[id] || '' }) : null;
    if (b.hasPhoto && !S.images[id]) getImage(id).then(src => { if (src && photo) photo.src = src; }).catch(() => {});
    const row = (label, v, dl) => h('div', { class: 'r', style: 'grid-template-columns:1fr auto auto;gap:10px' }, h('span', { text: label }), h('b', { text: v }),
      h('small', { class: 'delta ' + (dl ? dl.cls : ''), text: dl ? dl.text : '' }));
    const segs = SEG.filter(([k]) => b.seg && has(b.seg[k]));
    const sh = sheet(`InBody · ${fmtDate(new Date(b.date + 'T12:00'), { month: 'short', day: 'numeric', year: 'numeric' })}`, h('div', { class: 'fgrid' },
      photo,
      prev ? h('p', { class: 'muted', style: 'margin:0;font-size:.82rem', text: `Changes are since ${fmtDate(new Date(prev.date + 'T12:00'), { month: 'short', day: 'numeric' })}.` }) : null,
      h('div', { class: 'sets' }, SCAN_FIELDS.filter(f => has(b[f.k])).map(f => row(f.label, scanVal(f, b[f.k]), scanDelta(f, b, prev)))),
      segs.length ? h('div', null, h('div', { class: 'eyebrow', style: 'margin-bottom:6px', text: 'Segmental lean mass' }),
        h('div', { class: 'sets' }, segs.map(([k, l]) => row(l, fwu(Number(b.seg[k])), prev && prev.seg && has(prev.seg[k]) ? scanDelta({ k, mass: true, better: 1 }, b.seg, prev.seg) : null)))) : null,
      b.notes ? h('p', { style: 'margin:0;white-space:pre-wrap', text: b.notes }) : null,
      h('div', { class: 'duo' },
        h('button', { type: 'button', style: 'justify-content:center', onclick: () => { sh.close(); scanSheet(b); } }, icon('edit', 'ic sm'), 'Edit'),
        h('button', { type: 'button', class: 'danger', style: 'justify-content:center', onclick: async () => {
          if (!(await confirmBox('Delete this scan?', 'You can undo right after.', 'Delete', true))) return;
          sh.close();
          await action('Scan deleted', () => del('body_scans', b.id));
          if (b.hasPhoto) setTimeout(() => { if (!S.body_scans.some(x => x.id === b.id)) deletePhoto(b.id).catch(() => {}); }, 9000);
        } }, icon('trash', 'ic sm'), 'Delete'))), { tall: !!b.hasPhoto });
  }

  function scanSheet(existing) {
    const d = { date: existing ? existing.date : todayISO(), notes: existing ? existing.notes || '' : '', photo: null, removed: false, seg: { ...(existing && existing.seg || {}) } };
    const vals = {};
    for (const f of SCAN_FIELDS) vals[f.k] = existing && has(existing[f.k]) ? (f.mass ? fw(Number(existing[f.k])) : String(existing[f.k])) : '';
    const segVals = {}; for (const [k] of SEG) segVals[k] = has(d.seg[k]) ? fw(Number(d.seg[k])) : '';
    const zone = h('label', { class: 'photozone' });
    const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: async (e) => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      zone.replaceChildren(h('span', { class: 'muted', text: 'Preparing photo…' }));
      try { const img = await loadImage(file); d.photo = { thumb: squareThumb(img, 240), image: shrinkImage(img, 1600, 0.85) }; d.removed = false; } catch (err) { toast(err.message); }
      drawZone();
    } });
    function drawZone() {
      const src = d.photo ? d.photo.image : (existing && existing.hasPhoto && !d.removed ? (S.images[existing.id] || S.thumbs[existing.id]) : null);
      zone.replaceChildren(fileIn, ...(src
        ? [h('img', { src, alt: 'InBody printout photo' }), h('span', { class: 'zonebtns' }, h('span', { class: 'pill', text: 'Change photo' }),
            h('button', { type: 'button', class: 'small danger', onclick: (e) => { e.preventDefault(); d.photo = null; d.removed = true; drawZone(); } }, 'Remove'))]
        : [icon('camera'), h('b', { text: 'Add the printout photo' }), h('span', { style: 'font-size:.8rem', text: 'From your camera or photo library' })]));
    }
    drawZone();
    if (existing && existing.hasPhoto && !S.images[existing.id]) getImage(existing.id).then(() => { if (!d.photo && !d.removed) drawZone(); }).catch(() => {});
    const numIn = (obj, k, label) => field(label, h('input', { inputmode: 'decimal', value: obj[k], placeholder: '—', autocomplete: 'off', oninput: (e) => { obj[k] = e.target.value; } }));
    const segBox = h('details', { class: 'segbox', open: Object.values(segVals).some(Boolean) },
      h('summary', null, 'Segmental lean mass (optional)'),
      h('div', { class: 'mgrid', style: 'grid-template-columns:repeat(3,minmax(0,1fr));margin-top:10px' }, SEG.map(([k, l]) => numIn(segVals, k, `${l} (${unit()})`))));
    const save = h('button', { type: 'button', class: 'primary small', text: 'Save', onclick: async () => {
      const n = (v) => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : ''; };
      const out = existing ? { ...existing } : { id: uid('b'), at: Date.now(), by: S.myName };
      out.date = d.date || todayISO(); out.notes = d.notes.trim();
      for (const f of SCAN_FIELDS) { const v = n(vals[f.k]); out[f.k] = v === '' ? '' : f.mass ? store(v) : v; }
      out.seg = {}; for (const [k] of SEG) { const v = n(segVals[k]); if (v !== '') out.seg[k] = store(v); }
      out.hasPhoto = !!(d.photo || (existing && existing.hasPhoto && !d.removed));
      if (!out.hasPhoto && !SCAN_FIELDS.some(f => has(out[f.k]))) { toast('Add the photo or at least one number'); return; }
      sh.close();
      await action(existing ? 'Scan updated' : 'Scan saved', () => put('body_scans', out));
      try { if (d.photo) await savePhoto(out.id, d.photo.thumb, d.photo.image); else if (existing && existing.hasPhoto && d.removed) await deletePhoto(out.id); } catch (e) { showErr(e); }
      render(true);
    } });
    const sh = sheet(existing ? 'Edit InBody scan' : 'New InBody scan', h('div', { class: 'fgrid' },
      zone,
      field('Scan date', h('input', { type: 'date', value: d.date, max: todayISO(), onchange: (e) => { d.date = e.target.value; } })),
      h('p', { class: 'muted', style: 'margin:0;font-size:.8rem', text: `Copy the numbers from the printout. Weights in ${unit()}. Leave any blank.` }),
      h('div', { class: 'mgrid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' },
        SCAN_FIELDS.filter(f => !f.extra).map(f => numIn(vals, f.k, f.label + (f.mass ? ` (${unit()})` : f.unit ? ` (${f.unit})` : '')))),
      h('details', { class: 'segbox', open: SCAN_FIELDS.some(f => f.extra && vals[f.k]) },
        h('summary', null, 'Water, SMI & phase angle (optional)'),
        h('div', { class: 'mgrid', style: 'grid-template-columns:repeat(2,minmax(0,1fr));margin-top:10px' },
          SCAN_FIELDS.filter(f => f.extra).map(f => numIn(vals, f.k, f.label + (f.mass ? ` (${unit()})` : f.unit ? ` (${f.unit})` : ''))))),
      segBox,
      field('Notes', h('textarea', { value: d.notes, placeholder: 'Optional, e.g. scanned after breakfast', style: 'min-height:60px', oninput: (e) => { d.notes = e.target.value; } })),
      h('button', { type: 'button', class: 'primary big', onclick: () => save.click() }, existing ? 'Save Changes' : 'Save Scan')),
      { tall: true, right: save });
  }

  // ---------- reminders (web push, sent by the courtfit-remind server function) ----------
  const REMIND_DEFAULT = { enabled: false, workoutOn: true, workoutDays: [1, 3, 5], workoutTime: '17:30',
    meals: { Breakfast: { on: false, time: '09:00' }, Lunch: { on: true, time: '12:30' }, Dinner: { on: true, time: '19:00' } } };
  function remindPrefs() {
    let p = {}; try { p = JSON.parse(ls.get('cf-remind') || '{}'); } catch { }
    return { ...clone(REMIND_DEFAULT), ...p, meals: { ...clone(REMIND_DEFAULT.meals), ...(p.meals || {}) } };
  }
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const deviceId = () => { let d = ls.get('cf-device'); if (!d) { d = Math.random().toString(36).slice(2, 10); ls.set('cf-device', d); } return d; };
  function b64urlBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
  async function saveReminders(prefs) {
    ls.set('cf-remind', JSON.stringify(prefs));
    if (DEMO) { toast(prefs.enabled ? 'Preview: reminders would turn on here' : 'Reminders off'); return; }
    if (!S.sb) throw new Error('No connection. Try again when you are online.');
    if (!prefs.enabled) {
      await S.sb.from('push_subs').update({ enabled: false, prefs }).eq('id', deviceId());
      try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch { }
      toast('Reminders off'); return;
    }
    const { data: vapid, error: ve } = await S.sb.rpc('courtfit_vapid_public');
    if (ve || !vapid) throw new Error('Reminders are still being set up. Try again in a few minutes.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for CourtFit in iPhone Settings → Notifications.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(vapid) });
    const { error } = await S.sb.from('push_subs').upsert({ id: deviceId(), sub: sub.toJSON(), prefs, name: S.myName, enabled: true,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', updated_at: new Date().toISOString() });
    if (error) throw error;
    toast('Reminders on 💖');
  }
  function remindersPanel() {
    const p = remindPrefs();
    const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    let note = null;
    if (DEMO) note = 'Preview: reminders switch on after you approve this update.';
    else if (!pushSupported() || (ios && !standalone())) note = 'To get reminders on iPhone, add CourtFit to your Home Screen and open it from the icon.';
    const body = h('div', { class: 'fgrid', style: 'margin-top:12px' });
    function draw() {
      const toggle = (on, label, onch) => h('label', { class: 'switchrow' }, h('span', { text: label }),
        h('input', { type: 'checkbox', role: 'switch', checked: on, onchange: (e) => { onch(e.target.checked); draw(); } }));
      body.replaceChildren(...[
        toggle(p.enabled, 'Reminders', (v) => { p.enabled = v; }),
        p.enabled ? [
          h('div', { class: 'rem' },
            toggle(p.workoutOn, 'Workout reminder', (v) => { p.workoutOn = v; }),
            p.workoutOn ? h('div', { class: 'fgrid', style: 'gap:10px' },
              h('div', { class: 'daypick', role: 'group', 'aria-label': 'Workout days' }, DAYS.map((d, i) => h('button', { type: 'button', 'aria-pressed': String(p.workoutDays.includes(i)),
                'aria-label': new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' }),
                onclick: () => { p.workoutDays = p.workoutDays.includes(i) ? p.workoutDays.filter(x => x !== i) : [...p.workoutDays, i].sort(); draw(); } }, d))),
              field('Time', h('input', { type: 'time', value: p.workoutTime, onchange: (e) => { p.workoutTime = e.target.value; } })),
              h('p', { class: 'muted', style: 'margin:0;font-size:.78rem', text: 'Skipped on days you have already trained.' })) : null),
          h('div', { class: 'rem' }, h('b', { style: 'font-size:.9rem', text: 'Log your food' }),
            MEALS.slice(0, 3).map(mt => h('div', { class: 'mealrem' },
              h('label', { class: 'switchrow', style: 'flex:1' }, h('span', { text: mt }), h('input', { type: 'checkbox', role: 'switch', checked: p.meals[mt].on, onchange: (e) => { p.meals[mt].on = e.target.checked; draw(); } })),
              h('input', { type: 'time', value: p.meals[mt].time, disabled: !p.meals[mt].on, 'aria-label': `${mt} reminder time`, onchange: (e) => { p.meals[mt].time = e.target.value; } }))),
            h('p', { class: 'muted', style: 'margin:0;font-size:.78rem', text: 'Skipped if that meal is already logged.' }))] : null,
        h('button', { type: 'button', class: 'primary', disabled: !!note && !DEMO, onclick: async (e) => {
          e.target.disabled = true;
          try { await saveReminders(p); } catch (err) { toast(err.message || 'Could not save reminders'); } finally { e.target.disabled = false; }
        } }, 'Save Reminders'),
        p.enabled && !DEMO && !note ? h('button', { type: 'button', class: 'soft', onclick: async () => {
          try {
            const r = await fetch(CFG.supabaseUrl + '/functions/v1/courtfit-remind', { method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseAnonKey, 'x-app-key': KEY }, body: JSON.stringify({ test: true, id: deviceId() }) });
            const j = await r.json().catch(() => ({}));
            toast(r.ok && j.sent ? 'Test sent. Check your notifications.' : (j.error || 'Could not send. Tap Save Reminders first.'));
          } catch { toast('Could not reach the reminder service'); }
        } }, 'Send test reminder') : null].flat(Infinity).filter(Boolean));
    }
    draw();
    return h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Reminders' })),
      note ? h('p', { class: 'banner', style: 'margin:10px 0 0', text: note }) : null, body);
  }

  // ---------- settings ----------
  function settingsView() {
    const nameIn = h('input', { value: S.myName, autocomplete: 'given-name', onchange: (e) => { const n = e.target.value.trim(); if (n) { S.myName = n; ls.set('cf-name', n); toast('Name saved'); } } });
    const seg = (key, val, label, cur) => h('button', { type: 'button', 'aria-pressed': String(cur === val), onclick: () => { ls.set(key, val); render(true); } }, label);
    const rest = h('select', { 'aria-label': 'Default rest timer', onchange: (e) => { ls.set('cf-rest', e.target.value); toast('Rest timer saved'); } },
      [0, ...Array.from({ length: 19 }, (_, i) => 30 + i * 15)].map(s => h('option', { value: String(s), text: s ? fmtClock(s * 1000) : 'Off', selected: restSecs() === s })));
    const auto = h('select', { 'aria-label': 'Auto-confirm sets', onchange: (e) => { ls.set('cf-auto', e.target.value); toast('Auto-confirm saved'); } },
      [0, 10, 15, 20, 30].map(s => h('option', { value: String(s), text: s ? `After ${s} seconds` : 'Off', selected: autoSecs() === s })));
    return h('div', null,
      topbar(backLink('#profile', 'Profile')),
      h('h1', { style: 'font-size:1.6rem;margin-bottom:14px', text: 'Settings' }),
      h('div', { class: 'panel fgrid' },
        field('Your name', nameIn),
        h('div', { class: 'f' }, h('span', { class: 'eyebrow', text: 'Weight unit' }), h('div', { class: 'seg' }, seg('cf-unit', 'lbs', 'Pounds (lbs)', unit()), seg('cf-unit', 'kg', 'Kilograms (kg)', unit()))),
        field('Default rest timer', rest),
        field('Auto-confirm sets', auto),
        h('p', { class: 'muted', style: 'margin:-4px 0 0;font-size:.82rem', text: 'Once you enter weight and reps, the set checks itself off after this long. Tap the check to do it sooner.' })),
      remindersPanel(),
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
      h('p', { class: 'muted', style: 'text-align:center;font-size:.8rem;margin-top:18px', text: `CourtFit version ${APP_VERSION} · Lift, log, glow` }));
  }

  // ---------- StrongHER program tracker (mirrors the paper sheets) ----------
  // One row in `programs` per round. log[workoutKey].weeks[i] = { date, v: { exerciseNumber: [weight per set] } }.
  // Values are free text so entries like "—", "BW" or "AW" from the paper fit too.
  const SH_FLOW = 'Start on different moves, then swap. Unilateral blocks: both moves right, then both left = 1 round.';
  const SH_CORE = '2 rounds: Move 1 - 60 sec + Move 2 - 60 sec. Split sides within the minute when needed.';
  const STRONGHER_R4 = {
    id: 'strongher-r4', name: 'StrongHER', round: 4, theme: 'Holiday Hustle', weeks: 6,
    startDate: '2026-11-08', unit: 'lb', bodyWeight: '158.9', created: Date.UTC(2026, 10, 8),
    footer: 'Increase load when reps, range and control allow. Keep the prescribed tempo consistent.',
    workouts: [
      { key: 'A', phase: 'Build', where: 'In person', flow: SH_FLOW, finisher: SH_CORE, ex: [
        { n: '1.1', name: 'Front-rack DB squat', note: '', reps: [12, 10, 8, 6] },
        { n: '1.2', name: 'Rotating DB bench press', note: '', reps: [12, 10, 8, 6] },
        { n: '2.1', name: 'Bench-supported single-arm row', note: 'Per side | 3-sec lowering', reps: [12, 10, 8] },
        { n: '2.2', name: 'Kickstand DB Romanian deadlift', note: 'Per side | 3-sec lowering', reps: [12, 10, 8] },
        { n: '3.1', name: 'Lateral step-up', note: 'Per side | Low stable platform', reps: [10, 10, 10] },
        { n: '3.2', name: 'Weighted lateral leg raise at barre', note: 'Per side', reps: [10, 10, 10] },
        { n: '4.1', name: 'Seated W biceps curl', note: '', reps: [12, 10, 8] },
        { n: '4.2', name: 'Bent-over DB reverse fly', note: 'Controlled 2-sec lowering', reps: [12, 10, 8] }] },
      { key: 'B', phase: 'Perform', where: 'In person', flow: SH_FLOW, finisher: SH_CORE, ex: [
        { n: '1.1', name: 'Single-DB Romanian deadlift', note: '', reps: [12, 10, 8, 6] },
        { n: '1.2', name: 'Seated narrow DB shoulder press', note: '', reps: [12, 10, 8, 6] },
        { n: '2.1', name: 'Assisted pull-up / barre pull-up', note: 'Record assistance or variation', reps: [15, 15, 15] },
        { n: '2.2', name: 'Hands-on-bench push-up', note: 'Record bench height / variation', reps: [15, 15, 15] },
        { n: '3.1', name: 'Reverse-stepping DB lunge', note: 'Per side', reps: [12, 10, 8] },
        { n: '3.2', name: 'Seated single-arm overhead triceps extension', note: 'Per side', reps: [12, 10, 8] },
        { n: '4.1', name: 'Weighted side-lying adductor raise', note: 'Per side | Bottom leg lifts', reps: [8, 8, 8] },
        { n: '4.2', name: 'Cross-body hammer curl', note: 'Per side', reps: [8, 8, 8] }] },
      { key: 'C', phase: 'Grow', where: 'Optional at home', home: 'Dumbbells + body weight only. Four rounds per block; finish with about 3 good reps left. 1.5-rep squat: lower, halfway up, lower again, then stand. No bench or barre needed.', ex: [
        { n: '1.1', name: 'DB 1.5-rep squat', note: 'One full cycle = one rep', reps: [12, 10, 8, 6] },
        { n: '1.2', name: 'Elbows-out bent-over DB row', note: '', reps: [12, 10, 8, 6] },
        { n: '2.1', name: 'DB good morning - weight at chest', note: '3-sec lowering', reps: [12, 10, 8, 6] },
        { n: '2.2', name: 'DB squeeze floor press', note: '', reps: [12, 10, 8, 6] },
        { n: '3.1', name: 'Side-lying hip abduction', note: 'Per side', reps: [12, 10, 8, 6] },
        { n: '3.2', name: 'Supine alternating heel taps', note: 'Per side | Record BW', reps: [12, 10, 8, 6] }] }
    ],
    log: {
      A: { weeks: [{ date: '', v: { '1.1': ['12', '15', '20', '20'], '1.2': ['12', '15', '20', '20'], '2.1': ['15', '20', '25'], '2.2': ['15', '20', '25'],
        '3.1': ['AW', 'AW', 'AW'], '3.2': ['AW', 'AW', 'AW'], '4.1': ['10', '10', '10'], '4.2': ['10', '10', '10'] } }], core1: '', core2: '', notes: '' },
      B: { weeks: [{ date: '', v: { '1.1': ['10', '12', '15', '20'], '1.2': ['8', '8', '10', '10'], '2.1': ['—', '—', '—'], '2.2': ['—', '—', '—'],
        '3.1': ['8', '10', '12'], '3.2': ['7', '7', '10'], '4.1': ['—', '—', '—'], '4.2': ['10', '10', '10'] } }], core1: '', core2: '', notes: '' },
      C: { weeks: [], core1: '', core2: '', notes: '' }
    }
  };
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtMD = (iso) => iso ? new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : '';
  const sortedPrograms = () => [...S.programs].sort((a, b) => (b.created || 0) - (a.created || 0));
  const curProg = () => { const list = sortedPrograms(); return list.find(p => p.id === S.progId) || list[0] || null; };
  function wlog(p, key) {
    p.log = p.log || {};
    const l = p.log[key] = p.log[key] || { weeks: [], core1: '', core2: '', notes: '' };
    l.weeks = l.weeks || [];
    while (l.weeks.length < (p.weeks || 6)) l.weeks.push({ date: '', v: {} });
    for (const w of l.weeks) w.v = w.v || {};
    return l;
  }
  const weekHas = (wk) => Object.values(wk.v || {}).some(a => (a || []).some(x => String(x || '').trim()));
  function defaultWeek(p) {
    if (!p.startDate) return 0;
    const d = Math.floor((startOfDay(Date.now()) - new Date(p.startDate + 'T00:00').getTime()) / (7 * DAY));
    return Math.max(0, Math.min((p.weeks || 6) - 1, d));
  }
  // Edits change the current program object right away; saving waits for a pause in typing.
  let progTimer = null, progTyped = false;
  function saveProg() { clearTimeout(progTimer); progTimer = setTimeout(flushProg, 700); }
  async function flushProg() {
    if (!progTimer) return;
    clearTimeout(progTimer); progTimer = null;
    const p = curProg(); if (!p) return;
    let ok = true;
    await put('programs', p).catch((e) => { ok = false; showErr(e); });
    // First StrongHER set she types in herself (week 1 from the paper doesn't count).
    if (ok && progTyped && !firstLogShown() && !S.workouts.length) firstLogMessage();
  }
  const editProg = (fn) => { const p = curProg(); if (!p) return; fn(p); saveProg(); };
  const shTitle = () => h('h1', { class: 'shlogo' }, h('span', { class: 'sh-strong', text: 'Strong' }), ' HER');

  function programView() {
    const p = curProg();
    if (!p) return h('div', null, topbar(shTitle()), msg('Setting up StrongHER…', 'One moment.'));
    const w = p.workouts.find(x => x.key === S.progWorkout) || p.workouts[0];
    const L = wlog(p, w.key);
    const wi = Math.min(S.progWeek ?? defaultWeek(p), L.weeks.length - 1);
    const pill = (k, label) => h('button', { type: 'button', 'aria-pressed': String(S.progMode === k), onclick: () => { flushProg(); S.progMode = k; render(true); } }, label);
    return h('div', null,
      topbar(shTitle(), h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'roundbtn', 'aria-label': 'StrongHER options', onclick: () => programMenu(p, w) }, icon('dots'))),
      h('div', { class: 'panel' },
        h('div', { class: 'eyebrow', text: `Round ${p.round || ''}${p.theme ? ' / ' + p.theme : ''} / ${p.weeks || 6}-week weight tracker` }),
        h('div', { class: 'fgrid', style: 'grid-template-columns:minmax(0,1.5fr) minmax(0,.8fr) minmax(0,1fr);margin-top:12px' },
          field('Start date', h('input', { type: 'date', value: p.startDate || '', onchange: (e) => { editProg(q => { q.startDate = e.target.value; }); } })),
          field('Units', h('select', { onchange: (e) => editProg(q => { q.unit = e.target.value; }) }, ['lb', 'kg'].map(u => h('option', { value: u, text: u, selected: (p.unit || 'lb') === u })))),
          field('Body wt', h('input', { inputmode: 'decimal', value: p.bodyWeight || '', placeholder: '—', autocomplete: 'off', oninput: (e) => editProg(q => { q.bodyWeight = e.target.value.trim(); }) }))),
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:12px' },
          h('span', { class: 'eyebrow', text: 'Progress, not perfection' }), h('span', { class: 'accent' }, icon('heart', 'ic sm')))),
      h('div', { class: 'tabs', role: 'tablist', style: 'margin-top:14px' }, p.workouts.map(x => h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.key === w.key),
        onclick: () => { flushProg(); S.progWorkout = x.key; render(true); } }, h('span', { style: 'display:grid;line-height:1.25' }, h('b', { text: 'Workout ' + x.key }), h('small', { style: 'font-weight:500;font-size:.72rem', text: x.phase }))))),
      h('div', { class: 'sectionhd', style: 'margin-top:4px' },
        h('h2', { text: `${(w.phase || '').toUpperCase()} | WORKOUT ${w.key}` }), h('span', { class: 'eyebrow', text: w.where || '' })),
      h('div', { class: 'pills', style: 'margin-bottom:12px' }, pill('week', 'Log week'), pill('grid', 'All 6 weeks')),
      S.progMode === 'grid' ? programGrid(p, w, L) : programWeek(p, w, L, wi),
      w.flow || w.finisher ? h('div', { class: 'panel' },
        w.flow ? [h('div', { class: 'eyebrow', text: 'Partner flow' }), h('p', { style: 'margin:4px 0 12px', text: w.flow })] : null,
        w.finisher ? [h('div', { class: 'eyebrow', text: 'Core finisher' }), h('p', { style: 'margin:4px 0 12px', text: w.finisher }),
          h('div', { class: 'fgrid', style: 'grid-template-columns:1fr 1fr' },
            field('Core move 1', h('input', { value: L.core1 || '', autocomplete: 'off', oninput: (e) => editProg(q => { wlog(q, w.key).core1 = e.target.value; }) })),
            field('Core move 2', h('input', { value: L.core2 || '', autocomplete: 'off', oninput: (e) => editProg(q => { wlog(q, w.key).core2 = e.target.value; }) })))] : null) : null,
      w.home ? h('div', { class: 'panel' }, h('div', { class: 'eyebrow', text: 'Home notes' }), h('p', { style: 'margin:4px 0 0', text: w.home })) : null,
      h('div', { class: 'panel' }, field('Notes / L-R loads / assistance', h('textarea', { value: L.notes || '', placeholder: 'e.g. Left side 15, right 20', oninput: (e) => editProg(q => { wlog(q, w.key).notes = e.target.value; }) }))),
      p.footer ? h('p', { class: 'muted', style: 'text-align:center;font-size:.8rem;margin:16px 8px', text: p.footer }) : null);
  }

  function programWeek(p, w, L, wi) {
    const wk = L.weeks[wi];
    const prev = wi > 0 ? L.weeks[wi - 1] : null;
    const dateIn = h('input', { type: 'date', value: wk.date || '', onchange: (e) => { editProg(q => { wlog(q, w.key).weeks[wi].date = e.target.value; }); } });
    return h('div', null,
      h('div', { class: 'wk', role: 'group', 'aria-label': 'Week' }, L.weeks.map((x, i) => h('button', { type: 'button', 'aria-pressed': String(i === wi),
        onclick: () => { flushProg(); S.progWeek = i; render(true); } }, h('b', { text: 'Week ' + (i + 1) }), h('small', { text: x.date ? fmtMD(x.date) : weekHas(x) ? 'logged' : '—' })))),
      h('div', { class: 'panel', style: 'margin-top:10px' },
        h('div', { style: 'display:flex;gap:12px;align-items:end;margin-bottom:4px' }, h('div', { style: 'flex:1' }, field(`Week ${wi + 1} date`, dateIn))),
        h('p', { class: 'muted', style: 'font-size:.8rem;margin:8px 0 2px', text: `Write the weight (${p.unit || 'lb'}) for each set. Rep targets are above each box.` }),
        w.ex.map(ex => {
          const vals = (wk.v[ex.n] || []);
          const before = prev ? (prev.v[ex.n] || []) : [];
          // Heaviest weight ever written for this exercise in earlier weeks (for the PR star).
          const earlierBest = Math.max(0, ...L.weeks.slice(0, wi).flatMap(x => (x.v[ex.n] || []).map(nv)).filter(n => n != null));
          const cue = shCue(L, ex, wi, p.unit || 'lb');
          return h('div', { class: 'pex' },
            h('div', { class: 'nm' }, h('span', { class: 'no', text: ex.n }), h('b', { text: ex.name })),
            ex.note ? h('div', { class: 'note', text: ex.note }) : null,
            h('div', { class: 'boxes' }, ex.reps.map((r, si) => {
              const mark = h('i', { class: 'mark', 'aria-hidden': 'true' });
              const input = h('input', { value: vals[si] || '', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '6', enterkeyhint: 'next',
                'aria-label': `${ex.name}, set ${si + 1}, ${r} reps, weight`, onfocus: (e) => e.target.select(),
                oninput: (e) => {
                  const v = e.target.value.trim();
                  paint(v);
                  if (v) progTyped = true;
                  editProg(q => {
                    const k = wlog(q, w.key).weeks[wi];
                    const a = (k.v[ex.n] || []).slice(); while (a.length < ex.reps.length) a.push('');
                    a[si] = v; k.v[ex.n] = a;
                    if (v && !k.date) { k.date = todayISO(); dateIn.value = k.date; }
                  });
                } });
              // ▲ = heavier than the same set last week; ★ = heaviest ever for this exercise.
              function paint(v) {
                const n = nv(v), b = nv(before[si]);
                const pr = n != null && earlierBest > 0 && n > earlierBest;
                const up = n != null && b != null && n > b;
                input.className = (v ? 'filled' : '') + (up ? ' up' : '') + (pr ? ' pr' : '');
                mark.textContent = pr ? '★ PR' : up ? '▲' : '';
                mark.className = 'mark' + (pr ? ' pr' : up ? ' up' : '');
              }
              paint(vals[si] || '');
              return h('label', { class: 'box' }, h('span', { text: String(r) }), input, mark);
            })),
            before.some(x => x) ? h('div', { class: 'prevwk', text: `Week ${wi}: ${ex.reps.map((_, i) => before[i] || '–').join(' · ')}` }) : null,
            cue ? h('div', { class: 'cue' + (cue.up ? ' up' : '') }, icon(cue.up ? 'up' : 'repeat', 'ic sm'), h('span', { text: cue.text })) : null);
        })));
  }
  const nv = (x) => { const n = parseFloat(String(x ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
  // StrongHER cue: same numbers two weeks running means it's time to add a little weight
  // ("Increase load when reps, range and control allow").
  function shCue(L, ex, wi, unit) {
    if (wi < 2) return null;
    const a = (L.weeks[wi - 1].v[ex.n] || []).map(nv), b = (L.weeks[wi - 2].v[ex.n] || []).map(nv);
    if (!a.length || a.some(x => x == null) || a.length !== b.length || a.some((x, i) => x !== b[i])) return null;
    if (weekHas({ v: { [ex.n]: L.weeks[wi].v[ex.n] || [] } })) return null;
    return { up: true, text: `Same weights 2 weeks in a row. If the reps felt controlled, try +${unit === 'kg' ? '2.5 kg' : '5 lb'} on your last set or two.` };
  }

  function programGrid(p, w, L) {
    return h('div', { class: 'panel' }, h('div', { class: 'pgrid' }, h('table', { class: 'pg' },
      h('thead', null, h('tr', null, h('th', { text: 'Exercise / reps' }), L.weeks.map((wk, i) => h('th', null,
        h('button', { type: 'button', class: 'small', onclick: () => { S.progWeek = i; S.progMode = 'week'; render(true); } }, 'Week ' + (i + 1)),
        h('div', { class: 'muted', style: 'font-size:.65rem;margin-top:3px', text: wk.date ? fmtMD(wk.date) : ' ' }))))),
      h('tbody', null, w.ex.map(ex => h('tr', null,
        h('td', null, h('div', { style: 'font-weight:600', text: `${ex.n} ${ex.name}` }), h('div', { class: 'muted', style: 'font-size:.66rem', text: ex.reps.join(' / ') })),
        L.weeks.map((wk, wi) => h('td', null, h('div', { class: 'cells' }, ex.reps.map((r, si) => {
          const v = (wk.v[ex.n] || [])[si] || '';
          const n = nv(v), b = wi > 0 ? nv((L.weeks[wi - 1].v[ex.n] || [])[si]) : null;
          return h('i', { class: (v ? 'f' : '') + (n != null && b != null && n > b ? ' up' : ''), title: `${r} reps`, text: v || '·' });
        }))))))))),
      h('p', { class: 'muted', style: 'font-size:.75rem;margin:10px 0 0', text: '▲ = heavier than the week before. Tap a week to fill it in; scroll sideways to see every week.' }));
  }

  function programMenu(p, w) {
    const items = [
      { label: `Edit Workout ${w.key} exercises`, icon: 'edit', run: () => programEditor(w.key) },
      { label: 'Start next round', icon: 'repeat', run: async () => {
        if (!(await confirmBox(`Start Round ${(Number(p.round) || 0) + 1}?`, 'Makes a fresh 6-week tracker with the same exercises. You can edit them after. This round stays saved.', 'Start Next Round'))) return;
        flushProg();
        const next = { id: uid('p'), name: p.name || 'StrongHER', round: (Number(p.round) || 0) + 1, theme: '', weeks: p.weeks || 6, startDate: todayISO(), unit: p.unit || 'lb', bodyWeight: '',
          created: Date.now(), footer: p.footer || '', workouts: clone(p.workouts), log: {} };
        S.progId = next.id; S.progWeek = 0; S.progMode = 'week';
        await action(`Round ${next.round} started`, () => put('programs', next));
      } }];
    const others = sortedPrograms().filter(x => x.id !== p.id);
    for (const o of others) items.push({ label: `Open Round ${o.round || '?'}${o.theme ? ' · ' + o.theme : ''}`, icon: 'cal', run: () => { flushProg(); S.progId = o.id; S.progWeek = null; render(true); } });
    actions('StrongHER', items);
  }

  function programEditor(key) {
    const p = curProg(); if (!p) return;
    const w = p.workouts.find(x => x.key === key);
    const d = { round: String(p.round || ''), theme: p.theme || '', phase: w.phase || '', where: w.where || '', ex: clone(w.ex).map(e => ({ ...e, repsText: e.reps.join(', ') })) };
    const list = h('div', { class: 'stack' });
    function draw() {
      list.replaceChildren(...d.ex.map((e, i) => h('div', { class: 'rrow' },
        h('div', { class: 'fgrid', style: 'grid-template-columns:64px 1fr' },
          field('No.', h('input', { value: e.n, oninput: (ev) => { e.n = ev.target.value.trim(); } })),
          field('Exercise', h('input', { value: e.name, oninput: (ev) => { e.name = ev.target.value; } }))),
        field('Note', h('input', { value: e.note || '', placeholder: 'e.g. Per side', oninput: (ev) => { e.note = ev.target.value; } })),
        field('Rep targets (one per set)', h('input', { value: e.repsText, placeholder: '12, 10, 8, 6', oninput: (ev) => { e.repsText = ev.target.value; } })),
        h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [d.ex[i - 1], d.ex[i]] = [d.ex[i], d.ex[i - 1]]; draw(); } }, icon('up', 'ic sm')),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move down', disabled: i === d.ex.length - 1, onclick: () => { [d.ex[i + 1], d.ex[i]] = [d.ex[i], d.ex[i + 1]]; draw(); } }, icon('down', 'ic sm')),
          h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove exercise', onclick: () => { d.ex.splice(i, 1); draw(); } }, icon('trash', 'ic sm'))))));
    }
    draw();
    const save = h('button', { type: 'button', class: 'primary small', text: 'Save', onclick: async () => {
      const ex = d.ex.map(e => ({ n: e.n || '', name: (e.name || '').trim(), note: (e.note || '').trim(), reps: e.repsText.split(/[^0-9]+/).filter(Boolean).map(Number) })).filter(e => e.name);
      if (ex.some(e => !e.reps.length)) { toast('Each exercise needs at least one rep target'); return; }
      if (new Set(ex.map(e => e.n)).size !== ex.length) { toast('Exercise numbers must be different'); return; }
      sh.close();
      flushProg();
      const q = clone(curProg());
      q.round = Number(d.round) || d.round; q.theme = d.theme.trim();
      const qw = q.workouts.find(x => x.key === key);
      qw.phase = d.phase.trim(); qw.where = d.where.trim(); qw.ex = ex;
      await action('StrongHER updated', () => put('programs', q));
    } });
    const sh = sheet(`Edit Workout ${key}`, h('div', { class: 'fgrid' },
      h('div', { class: 'fgrid', style: 'grid-template-columns:80px 1fr' },
        field('Round', h('input', { inputmode: 'numeric', value: d.round, oninput: (e) => { d.round = e.target.value; } })),
        field('Theme', h('input', { value: d.theme, placeholder: 'e.g. Holiday Hustle', oninput: (e) => { d.theme = e.target.value; } }))),
      h('div', { class: 'fgrid', style: 'grid-template-columns:1fr 1fr' },
        field('Phase', h('input', { value: d.phase, placeholder: 'e.g. Build', oninput: (e) => { d.phase = e.target.value; } })),
        field('Where', h('input', { value: d.where, placeholder: 'e.g. In person', oninput: (e) => { d.where = e.target.value; } }))),
      list,
      h('button', { type: 'button', class: 'soft', onclick: () => { const last = d.ex[d.ex.length - 1]; d.ex.push({ n: '', name: '', note: '', repsText: last ? last.repsText : '12, 10, 8' }); draw(); } }, icon('plus'), 'Add Exercise'),
      h('p', { class: 'muted', style: 'font-size:.8rem;margin:0', text: 'Logged weights stay attached to each exercise number.' })),
      { tall: true, right: save });
  }

  // ---------- Macros: food log with photos ----------
  // meals rows: { date: 'YYYY-MM-DD', at, meal, name, cal, p, c, f, notes, hasPhoto, by }.
  // meal_photos rows (same id as the meal): { thumb, image } as compressed JPEG data URLs.
  const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  const mealByTime = () => { const hr = new Date().getHours(); return hr < 10 ? 'Breakfast' : hr < 14 ? 'Lunch' : hr < 16 ? 'Snack' : hr < 21 ? 'Dinner' : 'Snack'; };
  function goals() {
    let g = {}; try { g = JSON.parse(ls.get('cf-goals') || '{}'); } catch { }
    return { cal: 1800, p: 130, c: 180, f: 60, ...g };
  }
  const numv = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
  const fmt1 = (v) => num1(numv(v));
  const mealCal = (m) => numv(m.cal) > 0 ? numv(m.cal) : Math.round(4 * numv(m.p) + 4 * numv(m.c) + 9 * numv(m.f));
  const dayMeals = (d) => S.meals.filter(m => m.date === d).sort((a, b) => (a.at || 0) - (b.at || 0));
  const totals = (list) => list.reduce((t, m) => ({ cal: t.cal + mealCal(m), p: t.p + numv(m.p), c: t.c + numv(m.c), f: t.f + numv(m.f) }), { cal: 0, p: 0, c: 0, f: 0 });
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shiftDay = (iso, n) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoOf(d); };

  // Photos: shrink on the phone before upload (big image ~1280px, square thumbnail 240px).
  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
      img.src = url;
    });
  }
  function shrinkImage(img, max, q) {
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }
  function squareThumb(img, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const m = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.75);
  }
  async function savePhoto(id, thumb, image) {
    S.thumbs[id] = thumb; S.images[id] = image;
    if (S.sb) await send({ op: 'put', table: 'meal_photos', row: { id, thumb, image } });
  }
  async function deletePhoto(id) {
    delete S.thumbs[id]; delete S.images[id];
    if (S.sb) await send({ op: 'del', table: 'meal_photos', id });
  }
  let thumbReq = false;
  function wantThumbs(ids) {
    const missing = ids.filter(id => !(id in S.thumbs));
    if (!missing.length || !S.sb || thumbReq) return;
    thumbReq = true;
    S.sb.from('meal_photos').select('id,thumb').in('id', missing).then(({ data, error }) => {
      thumbReq = false;
      if (error) return;
      for (const id of missing) S.thumbs[id] = null;
      for (const r of data || []) S.thumbs[r.id] = r.thumb;
      render();
    }, () => { thumbReq = false; });
  }
  async function getImage(id) {
    if (S.images[id]) return S.images[id];
    if (!S.sb) return null;
    const { data } = await S.sb.from('meal_photos').select('image').eq('id', id).maybeSingle();
    if (data) S.images[id] = data.image;
    return data ? data.image : null;
  }

  function macrosView() {
    const d = S.mDate || todayISO();
    const list = dayMeals(d);
    const t = totals(list), g = goals();
    wantThumbs(list.filter(m => m.hasPhoto).map(m => m.id));
    const today = todayISO();
    const label = d === today ? 'Today' : d === shiftDay(today, -1) ? 'Yesterday' : new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'long' });
    const dateIn = h('input', { type: 'date', class: 'sr', value: d, max: today, 'aria-label': 'Pick a date', onchange: (e) => { if (e.target.value) { S.mDate = e.target.value; render(true); } } });
    return h('div', null,
      topbar(h('h1', { text: 'Macros' }), h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'small', onclick: exportSheet }, icon('share', 'ic sm'), 'Export'),
        h('button', { type: 'button', class: 'small', onclick: goalsSheet }, icon('gear', 'ic sm'), 'Goals')),
      h('div', { class: 'daynav' },
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous day', onclick: () => { S.mDate = shiftDay(d, -1); render(true); } }, icon('back')),
        h('button', { type: 'button', class: 'daylabel', 'aria-label': 'Pick a date', onclick: () => { try { dateIn.showPicker(); } catch { dateIn.focus(); dateIn.click(); } } },
          h('b', { text: label }), h('small', { text: new Date(d + 'T00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) })),
        dateIn,
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next day', disabled: d >= today, onclick: () => { S.mDate = shiftDay(d, 1); render(true); } }, icon('next'))),
      macroSummary(t, g),
      h('button', { type: 'button', class: 'primary big', style: 'margin-top:12px', onclick: () => mealSheet(null, d) }, icon('camera'), 'Add Food'),
      MEALS.map(mt => {
        const ms = list.filter(m => (m.meal || 'Snack') === mt);
        if (!ms.length) return null;
        return [sectionhd(mt, h('span', { style: 'display:flex;align-items:center;gap:4px' },
          h('span', { class: 'muted', style: 'font-size:.85rem', text: `${Math.round(totals(ms).cal).toLocaleString()} kcal` }),
          h('button', { type: 'button', class: 'link', style: 'font-size:.85rem;padding:0 6px', 'aria-label': `Save ${mt} as a saved meal`, onclick: () => saveMealSheet(mt, ms) }, '♡ Save'))),
          h('div', { class: 'cards' }, ms.map(mealCard))];
      }),
      list.length ? null : h('div', { class: 'empty', style: 'margin-top:14px' }, h('h2', { text: d === today ? 'Nothing logged yet today' : 'Nothing logged this day' }),
        h('p', { text: 'Snap a photo of your food and type in the macros from the label or your tracking app.' })),
      weekMacros(d, g));
  }

  function macroSummary(t, g) {
    const left = Math.round(g.cal - t.cal);
    const pct = g.cal ? Math.min(1, t.cal / g.cal) : 0;
    const r = 46, C = 2 * Math.PI * r;
    const ring = svgFrom(`<svg viewBox="0 0 110 110" class="ring" aria-hidden="true"><defs><linearGradient id="mring" x1="0" x2="1"><stop offset="0" stop-color="#f490bb"/><stop offset="1" stop-color="#c9a3f0"/></linearGradient></defs><circle cx="55" cy="55" r="${r}" fill="none" stroke="rgba(214,120,165,.18)" stroke-width="10"/><circle cx="55" cy="55" r="${r}" fill="none" stroke="url(#mring)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 55 55)"/></svg>`);
    const bar = (label, v, goal, cls) => h('div', { class: 'mbar', role: 'img', 'aria-label': `${label}: ${Math.round(v)} of ${goal} grams` },
      h('div', { class: 'mtop' }, h('span', { text: label }), h('b', { text: `${Math.round(v)} / ${goal} g` })),
      h('div', { class: 'tr' }, h('i', { class: cls, style: `width:${Math.min(100, goal ? v / goal * 100 : 0)}%` })));
    return h('div', { class: 'panel msum' },
      h('div', { class: 'ringwrap', role: 'img', 'aria-label': `${Math.round(t.cal)} of ${g.cal} calories` }, ring,
        h('div', { class: 'ringtxt' }, h('b', { text: Math.round(t.cal).toLocaleString() }), h('span', { text: `of ${Number(g.cal).toLocaleString()} kcal` }))),
      h('div', null,
        h('div', { class: 'mleft' + (left < 0 ? ' over' : ''), text: left >= 0 ? `${left.toLocaleString()} kcal left` : `${(-left).toLocaleString()} kcal over` }),
        bar('Protein', t.p, g.p, 'mp'), bar('Carbs', t.c, g.c, 'mc'), bar('Fat', t.f, g.f, 'mf')));
  }

  function mealCard(m) {
    const th = S.thumbs[m.id];
    const time = new Date(m.at || Date.now()).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return h('button', { type: 'button', class: 'mcard', onclick: () => mealDetail(m.id) },
      m.hasPhoto && th ? h('img', { src: th, alt: 'Photo of ' + (m.name || 'food'), class: 'mthumb' })
        : h('span', { class: 'mthumb ph', 'aria-hidden': 'true' }, icon(m.hasPhoto ? 'camera' : 'plate')),
      h('span', { class: 'grow' },
        h('span', { class: 't', text: m.name || 'Food' }),
        h('span', { class: 's', text: `${time} · ${Math.round(mealCal(m)).toLocaleString()} kcal` }),
        h('span', { class: 'mchips' }, h('i', { class: 'mp', text: `P ${fmt1(m.p)}` }), h('i', { class: 'mc', text: `C ${fmt1(m.c)}` }), h('i', { class: 'mf', text: `F ${fmt1(m.f)}` }))),
      icon('next', 'ic sm'));
  }

  function mealSheet(existing, date) {
    const d = {
      meal: existing ? existing.meal || 'Snack' : mealByTime(), name: existing ? existing.name || '' : '',
      cal: existing && numv(existing.cal) > 0 ? String(existing.cal) : '', p: existing ? String(existing.p ?? '') : '', c: existing ? String(existing.c ?? '') : '', f: existing ? String(existing.f ?? '') : '',
      notes: existing ? existing.notes || '' : '', photo: null, removed: false
    };
    const zone = h('label', { class: 'photozone' });
    const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: async (e) => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      zone.replaceChildren(h('span', { class: 'muted', text: 'Preparing photo…' }));
      try {
        const img = await loadImage(file);
        d.photo = { thumb: squareThumb(img, 240), image: shrinkImage(img, 1280, 0.8) }; d.removed = false;
      } catch (err) { toast(err.message); }
      drawZone();
    } });
    function drawZone() {
      const src = d.photo ? d.photo.image : (existing && existing.hasPhoto && !d.removed ? (S.images[existing.id] || S.thumbs[existing.id]) : null);
      zone.replaceChildren(fileIn, ...(src
        ? [h('img', { src, alt: 'Food photo' }), h('span', { class: 'zonebtns' },
            h('span', { class: 'pill', text: 'Change photo' }),
            h('button', { type: 'button', class: 'small danger', onclick: (e) => { e.preventDefault(); d.photo = null; d.removed = true; drawZone(); } }, 'Remove'))]
        : [icon('camera'), h('b', { text: 'Add a photo' }), h('span', { style: 'font-size:.8rem', text: 'Take one or pick from your library (optional)' })]));
    }
    drawZone();
    if (existing && existing.hasPhoto && !S.images[existing.id]) getImage(existing.id).then(() => { if (!d.photo && !d.removed) drawZone(); }).catch(() => {});

    const calIn = h('input', { inputmode: 'decimal', value: d.cal, autocomplete: 'off', oninput: (e) => { d.cal = e.target.value; } });
    const autoCal = () => { calIn.placeholder = String(Math.round(4 * numv(d.p) + 4 * numv(d.c) + 9 * numv(d.f)) || 'auto'); };
    const macroIn = (k) => h('input', { inputmode: 'decimal', value: d[k], placeholder: '0', autocomplete: 'off', oninput: (e) => { d[k] = e.target.value; autoCal(); } });
    const inputs = { p: macroIn('p'), c: macroIn('c'), f: macroIn('f') };
    autoCal();
    const nameIn = h('input', { value: d.name, placeholder: 'e.g. Greek yogurt bowl', autocomplete: 'off', oninput: (e) => { d.name = e.target.value; } });
    const segBox = h('div', { class: 'seg', role: 'group', 'aria-label': 'Meal' });
    const drawSeg = () => segBox.replaceChildren(...MEALS.map(mt => h('button', { type: 'button', 'aria-pressed': String(d.meal === mt), onclick: () => { d.meal = mt; drawSeg(); } }, mt)));
    drawSeg();

    // Recent foods: one tap fills in the name and macros.
    const seen = new Set(), recent = [];
    for (const m of [...S.meals].sort((a, b) => (b.at || 0) - (a.at || 0))) { const k = (m.name || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); recent.push(m); } if (recent.length >= 12) break; }
    const recentBox = !existing && recent.length ? h('div', null, h('div', { class: 'eyebrow', style: 'margin-bottom:6px', text: 'Recent' }),
      h('div', { class: 'recent' }, recent.map(m => h('button', { type: 'button', onclick: () => {
        d.name = m.name || ''; d.cal = numv(m.cal) > 0 ? String(m.cal) : ''; d.p = String(m.p ?? ''); d.c = String(m.c ?? ''); d.f = String(m.f ?? '');
        nameIn.value = d.name; calIn.value = d.cal; inputs.p.value = d.p; inputs.c.value = d.c; inputs.f.value = d.f; autoCal();
      } }, m.name)))) : null;

    // Saved meals: one tap logs every food in it (to the meal picked above).
    const savedList = [...S.saved_meals].sort((a, b) => (b.created || 0) - (a.created || 0));
    const savedBox = !existing && savedList.length ? h('div', null,
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
        h('span', { class: 'eyebrow', text: 'Saved meals' }), h('button', { type: 'button', class: 'link', style: 'font-size:.8rem;min-height:32px', onclick: manageSaved }, 'Edit')),
      h('div', { class: 'recent' }, savedList.map(sm => h('button', { type: 'button', class: 'savedchip', onclick: async () => {
        sh.close();
        const base = date === todayISO() ? Date.now() : new Date(date + 'T12:00').getTime();
        await action(`Logged "${sm.name}"`, async () => {
          for (const [i, it] of (sm.items || []).entries()) await put('meals', { id: uid('m'), date, at: base + i, meal: d.meal, name: it.name || '', cal: numv(it.cal) > 0 ? numv(it.cal) : '', p: numv(it.p), c: numv(it.c), f: numv(it.f), notes: '', hasPhoto: false, by: S.myName });
        });
      } }, h('b', { text: sm.name }), h('small', { text: `${(sm.items || []).length} food${(sm.items || []).length === 1 ? '' : 's'} · ${Math.round(totals(sm.items || []).cal)} kcal` }))))) : null;

    const save = h('button', { type: 'button', class: 'primary small', text: 'Save', onclick: async () => {
      const hasPhoto = !!(d.photo || (existing && existing.hasPhoto && !d.removed));
      if (!d.name.trim() && !hasPhoto && !(numv(d.p) || numv(d.c) || numv(d.f) || numv(d.cal))) { toast('Add a photo, a name or some macros'); return; }
      const m = existing ? { ...existing } : { id: uid('m'), date, at: date === todayISO() ? Date.now() : new Date(date + 'T12:00').getTime(), by: S.myName };
      Object.assign(m, { meal: d.meal, name: d.name.trim(), cal: numv(d.cal) > 0 ? numv(d.cal) : '', p: numv(d.p), c: numv(d.c), f: numv(d.f), notes: d.notes.trim(), hasPhoto });
      sh.close();
      await action(existing ? 'Food updated' : 'Food added', () => put('meals', m));
      try {
        if (d.photo) await savePhoto(m.id, d.photo.thumb, d.photo.image);
        else if (existing && existing.hasPhoto && d.removed) await deletePhoto(m.id);
      } catch (e) { showErr(e); }
      render(true);
    } });
    const sh = sheet(existing ? 'Edit Food' : 'Add Food', h('div', { class: 'fgrid' },
      zone, segBox, savedBox, recentBox, field('Name', nameIn),
      h('div', { class: 'mgrid' }, field('Calories', calIn), field('Protein g', inputs.p), field('Carbs g', inputs.c), field('Fat g', inputs.f)),
      h('p', { class: 'muted', style: 'font-size:.78rem;margin:-6px 0 0', text: 'Leave calories blank to work them out from the macros.' }),
      field('Notes', h('textarea', { value: d.notes, placeholder: 'Optional', style: 'min-height:60px', oninput: (e) => { d.notes = e.target.value; } })),
      h('button', { type: 'button', class: 'primary big', onclick: () => save.click() }, existing ? 'Save Changes' : 'Add Food')),
      { tall: true, right: save });
  }

  function mealDetail(id) {
    const m = S.meals.find(x => x.id === id); if (!m) return;
    const photo = m.hasPhoto ? h('img', { class: 'fullphoto', alt: 'Photo of ' + (m.name || 'food'), src: S.images[id] || S.thumbs[id] || '' }) : null;
    if (m.hasPhoto && !S.images[id]) getImage(id).then(src => { if (src && photo) photo.src = src; }).catch(() => {});
    const row = (k, v) => h('div', { class: 'r', style: 'grid-template-columns:1fr auto' }, h('span', { text: k }), h('b', { text: v }));
    const sh = sheet(m.name || 'Food', h('div', { class: 'fgrid' },
      photo,
      h('div', { class: 'muted', text: `${m.meal || 'Snack'} · ${new Date(m.at || Date.now()).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }),
      h('div', { class: 'sets' }, row('Calories', `${Math.round(mealCal(m)).toLocaleString()} kcal${numv(m.cal) > 0 ? '' : ' (from macros)'}`), row('Protein', `${fmt1(m.p)} g`), row('Carbs', `${fmt1(m.c)} g`), row('Fat', `${fmt1(m.f)} g`)),
      m.notes ? h('p', { style: 'margin:0;white-space:pre-wrap', text: m.notes }) : null,
      h('div', { class: 'duo' },
        h('button', { type: 'button', style: 'justify-content:center', onclick: () => { sh.close(); mealSheet(m, m.date); } }, icon('edit', 'ic sm'), 'Edit'),
        h('button', { type: 'button', style: 'justify-content:center', onclick: async () => {
          sh.close();
          const today = todayISO();
          const copy = { ...clone(m), id: uid('m'), date: today, at: Date.now(), by: S.myName };
          await action('Logged again today', () => put('meals', copy));
          if (m.hasPhoto) { const img = await getImage(m.id).catch(() => null); const th = S.thumbs[m.id]; if (img && th) await savePhoto(copy.id, th, img).catch(showErr); else await put('meals', { ...copy, hasPhoto: false }).catch(() => {}); }
          S.mDate = today; render(true);
        } }, icon('repeat', 'ic sm'), 'Log Again Today')),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmBox('Delete this food?', 'You can undo right after.', 'Delete', true))) return;
        sh.close();
        await action('Food deleted', () => del('meals', m.id));
        // Remove the photo too, unless the delete was undone.
        if (m.hasPhoto) setTimeout(() => { if (!S.meals.some(x => x.id === m.id)) deletePhoto(m.id).catch(() => {}); }, 9000);
      } }, icon('trash', 'ic sm'), 'Delete')), { tall: !!m.hasPhoto });
  }

  function weekMacros(d, g) {
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(d, i - 6));
    const pts = days.map(x => ({ x: new Date(x + 'T00:00').getTime(), y: totals(dayMeals(x)).cal }));
    const logged = days.filter(x => dayMeals(x).length);
    const avg = (k) => logged.length ? Math.round(logged.reduce((a, x) => a + totals(dayMeals(x))[k], 0) / logged.length) : 0;
    const W = 340, H = 150, L = 34, R = 6, T = 10, B = 22;
    const max = niceMax(Math.max(g.cal, ...pts.map(p => p.y)));
    const bw = (W - L - R) / 7, sy = (y) => T + (1 - y / max) * (H - T - B);
    const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories, last 7 days">
      <defs><linearGradient id="mwk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f490bb"/><stop offset="1" stop-color="#c9a3f0"/></linearGradient></defs>
      ${[0, max / 2, max].map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 5}" y="${sy(t) + 3.5}" text-anchor="end">${kfmt(t)}</text>`).join('')}
      <line x1="${L}" x2="${W - R}" y1="${sy(g.cal)}" y2="${sy(g.cal)}" stroke="#ee9a7c" stroke-dasharray="4 4" stroke-width="1.5"/>
      ${pts.map((p, i) => { const hh = Math.max(0, H - B - sy(p.y)), x = L + i * bw + bw * .2;
        return `<rect x="${x}" y="${H - B - hh}" width="${bw * .6}" height="${hh}" rx="4" fill="url(#mwk)"><title>${Math.round(p.y)} kcal</title></rect><text x="${x + bw * .3}" y="${H - 6}" text-anchor="middle">${new Date(p.x).toLocaleDateString(undefined, { weekday: 'narrow' })}</text>`; }).join('')}</svg>`;
    return h('div', { class: 'panel', style: 'margin-top:16px' },
      h('div', { class: 'hd' }, h('h2', { text: 'Last 7 days' }), h('span', { class: 'muted', style: 'font-size:.78rem', text: 'dashed line = goal' })),
      svgFrom(svg),
      h('div', { class: 'tally', style: 'margin-top:10px' },
        h('div', null, h('span', { text: 'Avg calories' }), h('b', { text: logged.length ? avg('cal').toLocaleString() : '—' })),
        h('div', null, h('span', { text: 'Avg protein' }), h('b', { text: logged.length ? avg('p') + ' g' : '—' })),
        h('div', null, h('span', { text: 'Days logged' }), h('b', { text: `${logged.length} / 7` }))));
  }

  function saveMealSheet(mt, ms) {
    const nameIn = h('input', { value: `My usual ${mt.toLowerCase()}`, autocomplete: 'off' });
    const t = totals(ms);
    const sh = sheet('Save as Saved Meal', h('form', { class: 'fgrid', onsubmit: async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
      sh.close();
      await action(`Saved "${name}"`, () => put('saved_meals', { id: uid('s'), name, meal: mt, created: Date.now(), by: S.myName,
        items: ms.map(m => ({ name: m.name || 'Food', cal: numv(m.cal) > 0 ? numv(m.cal) : '', p: numv(m.p), c: numv(m.c), f: numv(m.f) })) }));
    } },
      field('Name', nameIn),
      h('div', { class: 'sets' }, ms.map(m => h('div', { class: 'r', style: 'grid-template-columns:1fr auto' }, h('span', { text: m.name || 'Food' }), h('b', { text: `${Math.round(mealCal(m))} kcal` })))),
      h('p', { class: 'muted', style: 'margin:0;font-size:.85rem', text: `Total ${Math.round(t.cal)} kcal · P ${Math.round(t.p)} · C ${Math.round(t.c)} · F ${Math.round(t.f)}. Next time, tap it in Add Food to log all of these at once.` }),
      h('button', { class: 'primary big', type: 'submit', text: 'Save Meal' })));
  }
  function manageSaved() {
    const box = h('div', { class: 'stack' });
    const draw = () => box.replaceChildren(...(S.saved_meals.length ? [...S.saved_meals].sort((a, b) => (b.created || 0) - (a.created || 0)).map(sm => h('div', { class: 'rcard' },
      h('div', { class: 'rtop' }, h('div', { style: 'flex:1;min-width:0' }, h('h3', { text: sm.name }), h('p', { text: (sm.items || []).map(i => i.name).join(', ') })),
        h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': `Delete ${sm.name}`, onclick: async () => { await action(`Deleted "${sm.name}"`, () => del('saved_meals', sm.id)); draw(); } }, icon('trash', 'ic sm')))))
      : [h('p', { class: 'muted', text: 'No saved meals. Use ♡ Save next to a meal on the Macros page.' })]));
    draw();
    sheet('Saved Meals', box);
  }

  // Export: a CSV spreadsheet (opens in Numbers, Excel or Google Sheets). On iPhone this
  // opens the share sheet so it can be saved to Files, emailed or AirDropped.
  function exportSheet() {
    const st = { range: 30, kind: 'foods' };
    const opt = (key, val, label) => h('button', { type: 'button', 'aria-pressed': String(st[key] === val), onclick: () => { st[key] = val; draw(); } }, label);
    const box = h('div', { class: 'fgrid' });
    const count = h('p', { class: 'muted', style: 'margin:0;font-size:.85rem' });
    function pick() {
      const today = todayISO();
      const from = st.range ? shiftDay(today, -(st.range - 1)) : '0000-00-00';
      return S.meals.filter(m => m.date >= from && m.date <= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)));
    }
    function draw() {
      const list = pick();
      const days = new Set(list.map(m => m.date)).size;
      count.textContent = list.length ? `${list.length} food${list.length === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}.` : 'Nothing logged in this range yet.';
      box.replaceChildren(
        h('div', { class: 'f' }, h('span', { class: 'eyebrow', text: 'Time range' }), h('div', { class: 'seg' }, opt('range', 7, 'Last 7 days'), opt('range', 30, 'Last 30 days'), opt('range', 0, 'All time'))),
        h('div', { class: 'f' }, h('span', { class: 'eyebrow', text: 'What to include' }), h('div', { class: 'seg' }, opt('kind', 'foods', 'Every food'), opt('kind', 'days', 'Daily totals'))),
        count,
        h('button', { type: 'button', class: 'primary big', disabled: !list.length, onclick: () => doExport(list) }, icon('share'), 'Export CSV'));
    }
    async function doExport(list) {
      const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const r1 = (v) => Math.round(numv(v) * 10) / 10;
      let rows;
      if (st.kind === 'foods') {
        rows = [['Date', 'Time', 'Meal', 'Food', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Notes', 'Photo']].concat(list.map(m => [
          m.date, new Date(m.at || Date.now()).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), m.meal || '', m.name || '',
          Math.round(mealCal(m)), r1(m.p), r1(m.c), r1(m.f), m.notes || '', m.hasPhoto ? 'yes' : '']));
      } else {
        const g = goals(), byDay = {};
        for (const m of list) (byDay[m.date] = byDay[m.date] || []).push(m);
        rows = [['Date', 'Foods', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Calorie goal', 'Protein goal (g)']].concat(Object.keys(byDay).sort().map(d => {
          const t = totals(byDay[d]);
          return [d, byDay[d].length, Math.round(t.cal), r1(t.p), r1(t.c), r1(t.f), g.cal, g.p];
        }));
      }
      const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
      const name = `courtfit-macros-${st.kind === 'foods' ? 'foods' : 'daily'}-${todayISO()}.csv`;
      const file = new File([csv], name, { type: 'text/csv' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'CourtFit macros' }); sh.close(); return; }
      } catch (e) { if (e && e.name === 'AbortError') return; }
      const a = h('a', { href: URL.createObjectURL(file), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      sh.close(); toast('Export downloaded');
    }
    draw();
    const sh = sheet('Export Macros', h('div', null, box, h('p', { class: 'muted', style: 'font-size:.78rem;margin:12px 0 0', text: 'Saves a spreadsheet file (CSV) that opens in Numbers, Excel or Google Sheets. Photos stay in the app.' })));
  }

  function goalsSheet() {
    const g = goals();
    const inp = (k) => h('input', { inputmode: 'numeric', value: String(g[k]), autocomplete: 'off' });
    const I = { cal: inp('cal'), p: inp('p'), c: inp('c'), f: inp('f') };
    const hint = h('p', { class: 'muted', style: 'font-size:.8rem;margin:0' });
    const upd = () => { hint.textContent = `Your macros add up to about ${Math.round(4 * numv(I.p.value) + 4 * numv(I.c.value) + 9 * numv(I.f.value)).toLocaleString()} kcal.`; };
    for (const k of ['p', 'c', 'f']) I[k].addEventListener('input', upd);
    upd();
    const sh = sheet('Daily Goals', h('form', { class: 'fgrid', onsubmit: (e) => {
      e.preventDefault();
      const next = {}; for (const k of Object.keys(I)) next[k] = Math.max(0, Math.round(numv(I[k].value)));
      if (!next.cal) { toast('Set a calorie goal'); return; }
      ls.set('cf-goals', JSON.stringify(next)); sh.close(); toast('Goals saved'); render(true);
    } }, h('div', { class: 'mgrid' }, field('Calories', I.cal), field('Protein g', I.p), field('Carbs g', I.c), field('Fat g', I.f)), hint,
      h('button', { class: 'primary big', type: 'submit', text: 'Save Goals' })));
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
      return { exerciseId: it.exerciseId, group: it.group || null, notes: '', sets: (it.sets || [{}]).map((s) => ({ ...newSet(null, null, 'normal', s.reps || ''), hint: s.weight || null })) };
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
      renderRuns(w.exercises, (e, i) => exerciseCard(e, i)),
      w.exercises.length ? null : h('div', { class: 'empty', style: 'margin-top:12px' }, h('h2', { text: 'Get started' }), h('p', { text: 'Add an exercise to start logging sets.' })),
      h('div', { class: 'stack', style: 'margin-top:16px' },
        h('button', { type: 'button', class: 'primary big', onclick: () => picker(addExercises) }, icon('plus'), 'Add Exercise'),
        h('div', { class: live ? 'duo' : 'stack' },
          live ? h('button', { type: 'button', onclick: () => go('#settings'), style: 'justify-content:center' }, icon('timer'), 'Rest: ' + (restSecs() ? fmtClock(restSecs() * 1000) : 'Off')) : null,
          h('button', { type: 'button', class: 'danger', style: 'justify-content:center', onclick: async () => {
            const editing = w.mode === 'edit';
            if (await confirmBox(editing ? 'Stop editing?' : 'Discard this workout?', editing ? 'Your changes will not be saved. The saved workout stays as it was.' : 'Everything logged here will be deleted.', editing ? 'Discard Changes' : 'Discard Workout', true)) {
              autoClear(); S.active = null; saveActive(); go(editing ? '#w-' + w.id : '#workout');
            }
          } }, w.mode === 'edit' ? 'Discard Changes' : 'Discard'))));
  }
  function exerciseCard(e, idx) {
    const w = S.active, ex = findEx(e.exerciseId);
    const prev = previousSets(e.exerciseId, w.id, isLive(w) ? null : w.start);
    const histBest = Math.max(0, ...historyFor(e.exerciseId).filter(x => x.w.id !== w.id && (isLive(w) || x.w.start < w.start)).flatMap(x => doneSets(x.entry)).map(e1rm));
    const cue = workoutCue(e, prev);
    const card = h('div', { class: 'panel' },
      h('div', { class: 'exhd' },
        h('a', { href: '#ex-' + e.exerciseId }, exLabel(ex), h('small', { text: ex ? ex.muscle : '' })),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Exercise options', onclick: () => {
          const move = (d) => () => { const j = idx + d; if (j < 0 || j >= w.exercises.length) return; [w.exercises[idx], w.exercises[j]] = [w.exercises[j], w.exercises[idx]]; saveActive(); render(true); };
          actions(exLabel(ex), [
            { label: 'Move Up', icon: 'up', run: move(-1) }, { label: 'Move Down', icon: 'down', run: move(1) },
            { label: 'Replace Exercise', icon: 'repeat', run: () => picker((ids) => { e.exerciseId = ids[0]; saveActive(); render(true); }, true) },
            ...(idx < w.exercises.length - 1 ? [{ label: linkedToNext(w.exercises, idx) ? 'Unlink superset with next' : 'Superset with next exercise', icon: 'repeat', run: () => { toggleLink(w.exercises, idx); saveActive(); render(true); } }] : []),
            { label: 'Remove Exercise', icon: 'trash', danger: true, run: () => { w.exercises.splice(idx, 1); normalizeGroups(w.exercises); saveActive(); render(true); } }]);
        } }, icon('dots'))),
      h('textarea', { class: 'noteinput', rows: '1', placeholder: 'Notes', 'aria-label': 'Exercise notes', style: 'margin:6px 0 4px', value: e.notes || '', oninput: (ev) => { e.notes = ev.target.value; grow(ev.target); saveActive(); } }),
      cue ? h('div', { class: 'cue' + (cue.up ? ' up' : '') }, icon(cue.up ? 'up' : 'repeat', 'ic sm'), h('span', { text: cue.text })) : null,
      h('div', { class: 'sethd', 'aria-hidden': 'true' }, h('span', { text: 'SET' }), h('span', { text: 'PREVIOUS' }), h('span', { text: unit().toUpperCase() }), h('span', { text: 'REPS' }), h('span', { text: '✓' })),
      h('div', { class: 'stack', style: 'gap:6px' }, e.sets.map((s, si) => setRow(e, s, si, prev[si], histBest))),
      h('button', { type: 'button', class: 'soft', style: 'width:100%;margin-top:10px', onclick: () => { const l = e.sets[e.sets.length - 1]; e.sets.push({ ...newSet(null, null, 'normal', l?.target), hint: l?.weight ?? l?.hint ?? null, hintReps: l?.reps ?? l?.hintReps ?? null }); saveActive(); render(true); } }, icon('plus', 'ic sm'), 'Add Set'));
    return card;
  }
  // Progress cue for an exercise, based on last time. With a rep range (from a routine),
  // hitting the top of the range on every set suggests going up in weight.
  function workoutCue(e, prev) {
    if (!prev.length) return null;
    const tops = e.sets.map(s => { const t = String(s.target || '').match(/\d+/g); return t ? Math.max(...t.map(Number)) : null; });
    const heavy = Math.max(...prev.map(p => p.weight || 0));
    const last = prev.map(p => `${fw(p.weight)}×${p.reps || 0}`).join(', ');
    const hasRange = tops.some(t => t != null);
    const hitTop = hasRange && prev.every((p, i) => { const t = tops[Math.min(i, tops.length - 1)] ?? tops.find(x => x != null); return (p.reps || 0) >= t; });
    if (heavy > 0 && hitTop) return { up: true, text: `Last time ${last}. You hit the top of your rep range, so try ${fwu(heavy + (isKg() ? 2.5 / LB_KG : 5))}.` };
    if (heavy > 0 && hasRange) return { up: false, text: `Last time ${last}. Stay at this weight until you reach the top of the rep range.` };
    return { up: false, text: `Last time ${last}. Beat it with one more rep or a little more weight.` };
  }
  function setRow(e, s, si, p, histBest = 0) {
    const better = !!(s.done && p && ((s.weight || 0) > (p.weight || 0) || ((s.weight || 0) === (p.weight || 0) && (s.reps || 0) > (p.reps || 0))));
    const isPR = !!(s.done && histBest > 0 && e1rm(s) > histBest + 0.01);
    const label = setLabel(e.sets, si);
    const prevText = p ? `${fw(p.weight)}×${p.reps || 0}` : '—';
    // Gray hint = last time's numbers (or the routine's). Typing replaces it; leaving it
    // untouched and tapping the check uses the hint as the set's value.
    const hintW = p ? p.weight : s.hint ?? null;
    const hintR = firstNum(s.target) ?? (p ? p.reps : s.hintReps ?? null);
    const ei = S.active.exercises.indexOf(e);
    const wIn = h('input', { readonly: '', inputmode: 'none', autocomplete: 'off', 'data-kp': `${ei}-${si}-w`, 'aria-label': `Set ${label} weight in ${unit()}`,
      placeholder: hintW != null ? fw(hintW) : '0', value: s.weight != null ? fw(s.weight) : '' });
    wIn._kp = { decimal: true, step: isKg() ? 2.5 : 5, hint: () => (hintW != null ? Number(fw(hintW)) || 0 : 0),
      set: (t) => { const v = parseFloat(t); s.weight = isFinite(v) ? store(v) : null; saveActive(); refreshTally(); } };
    const rIn = h('input', { readonly: '', inputmode: 'none', autocomplete: 'off', 'data-kp': `${ei}-${si}-r`, 'aria-label': `Set ${label} reps`,
      placeholder: s.target || (hintR != null ? String(hintR) : '0'), value: s.reps != null ? String(s.reps) : '' });
    rIn._kp = { decimal: false, step: 1, hint: () => hintR || 0,
      set: (t) => { const v = parseInt(t, 10); s.reps = isFinite(v) ? v : null; saveActive(); refreshTally(); } };
    for (const el of [wIn, rIn]) { el.addEventListener('pointerdown', (ev) => ev.preventDefault()); el.addEventListener('click', () => kpOpen(el)); }
    // Tick the set. `at` is when she actually finished it (an auto-confirm fires a few seconds later).
    const complete = () => {
      if (s.done || !S.active || !S.active.exercises.includes(e) || !e.sets.includes(s)) return;
      if (s.weight == null) s.weight = hintW;
      if (s.reps == null) s.reps = hintR;
      s.done = true;
      if (isLive(S.active) && restSecs() > 0 && endsRound(S.active.exercises, e)) { S.active.restEnd = Date.now() + restSecs() * 1000; S.active.restDur = restSecs() * 1000; }
      if (navigator.vibrate) navigator.vibrate(15);
      saveActive(); render(true);
    };
    const pend = AUTO.get(s);
    const ck = h('button', { type: 'button', class: 'ck' + (pend ? ' auto' : ''), 'aria-pressed': String(!!s.done), 'aria-label': s.done ? 'Completed. Tap to undo' : 'Mark set complete',
      style: pend ? `--auto-dur:${pend.dur}ms;--auto-delay:${pend.start - Date.now()}ms` : null, onclick: () => {
        autoCancel(s);
        if (s.done) { s.done = false; saveActive(); render(true); return; }
        unlockAudio(); complete();
      } }, icon('check'));
    // Once she has typed both weight and reps, the set ticks itself after a few seconds.
    // Each new keypress restarts the countdown; clearing a box stops it.
    // A weight far from last time (under half or over 1.5x) looks like a typo, so it waits for her ✓.
    const odd = () => hintW > 0 && s.weight != null && (s.weight < hintW * 0.5 || s.weight > hintW * 1.5);
    if (!s.done && odd()) wIn.classList.add('odd');
    for (const el of [wIn, rIn]) {
      const set = el._kp.set;
      el._kp.set = (t) => {
        set(t);
        wIn.classList.toggle('odd', odd());
        if (!s.done && s.weight != null && s.reps != null && !odd()) autoStart(s, complete, ck); else autoCancel(s, ck);
      };
    }
    const row = h('div', { class: 'setrow' + (s.done ? ' done' : '') + (isPR ? ' pr' : '') },
      isPR ? h('span', { class: 'prbadge', text: 'PR' }) : null,
      h('button', { type: 'button', class: 'sn ' + (s.kind || 'normal'), 'aria-label': `Set ${label} options`, onclick: () => actions('Set type', [
        ...[['normal', 'Normal Set'], ['warmup', 'Warm-up Set'], ['drop', 'Drop Set'], ['failure', 'Failure Set']].map(([k, l]) => ({ label: l, checked: (s.kind || 'normal') === k, run: () => { s.kind = k; saveActive(); render(true); } })),
        { label: 'Delete Set', icon: 'trash', danger: true, run: () => {
          const gone = e.sets.splice(si, 1)[0]; saveActive(); render(true);
          toast(`Set ${label} removed`, { label: 'Undo', run: () => { e.sets.splice(Math.min(si, e.sets.length), 0, gone); saveActive(); render(true); } });
        } }]) }, label),
      h('span', { class: 'prev' + (better ? ' up' : ''), text: better ? `▲${fw(p.weight)}×${p.reps || 0}` : prevText, 'aria-label': p ? `Previous ${prevText}${better ? ', you beat it' : ''}` : 'No previous' }),
      wIn, rIn,
      ck);
    // Swipe a set either way, starting anywhere on the row (boxes included), to delete it.
    // A plain tap still opens the number pad or ticks the set.
    const back = h('div', { class: 'swipeback', 'aria-hidden': 'true' }, icon('trash', 'ic sm'), 'Delete');
    const wrap = h('div', { class: 'setwrap' }, back, row);
    let x0 = null, y0 = null, dx = 0, locked = null, swiped = false;
    row.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'mouse') return; x0 = ev.clientX; y0 = ev.clientY; dx = 0; locked = null; swiped = false; });
    row.addEventListener('pointermove', (ev) => {
      if (x0 == null) return;
      const mx = ev.clientX - x0, my = ev.clientY - y0;
      if (locked == null && (Math.abs(mx) > 10 || Math.abs(my) > 10)) {
        locked = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (locked === 'x') { swiped = true; try { row.setPointerCapture(ev.pointerId); } catch {} }
      }
      if (locked !== 'x') return;
      dx = Math.max(-170, Math.min(170, mx));
      back.classList.toggle('fromleft', dx > 0);
      back.classList.toggle('ready', Math.abs(dx) > 100);
      row.classList.add('dragging'); row.style.transform = `translateX(${dx}px)`;
    });
    const end = () => {
      if (x0 == null) return;
      row.classList.remove('dragging');
      const fire = locked === 'x' && Math.abs(dx) > 100;
      row.style.transform = fire ? `translateX(${dx > 0 ? 110 : -110}%)` : '';
      x0 = null; locked = null;
      if (fire) {
        if (navigator.vibrate) navigator.vibrate(12);
        setTimeout(() => {
          const gone = e.sets.splice(si, 1)[0]; saveActive(); render(true);
          toast(`Set ${label} removed`, { label: 'Undo', run: () => { e.sets.splice(Math.min(si, e.sets.length), 0, gone); saveActive(); render(true); } });
        }, 160);
      }
    };
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
    // A swipe that started on a box or the check shouldn't also count as a tap on it.
    row.addEventListener('click', (ev) => { if (swiped) { ev.stopPropagation(); ev.preventDefault(); swiped = false; } }, true);
    return wrap;
  }
  // ---------- auto-confirm: a set she moved on from ticks itself after a few seconds ----------
  // AUTO maps a set object to its pending countdown. Not saved; a reload just drops it.
  // (Re)start the countdown for a set. The check button fills up pink while it runs.
  function autoStart(s, complete, ck) {
    const secs = autoSecs();
    autoCancel(s, ck);
    if (!secs) return;
    const at = Date.now(), dur = secs * 1000;
    const timer = setTimeout(() => { AUTO.delete(s); complete(); }, dur);
    AUTO.set(s, { timer, start: at, dur, fire: () => { clearTimeout(timer); AUTO.delete(s); complete(); } });
    if (ck && ck.isConnected) { ck.style.setProperty('--auto-dur', dur + 'ms'); ck.style.setProperty('--auto-delay', '0ms'); void ck.offsetWidth; ck.classList.add('auto'); }
  }
  function autoCancel(s, ck) {
    const p = AUTO.get(s);
    if (ck) { ck.classList.remove('auto'); ck.removeAttribute('style'); }
    if (!p) return false;
    clearTimeout(p.timer); AUTO.delete(s);
    return true;
  }
  function autoFlush() { for (const p of [...AUTO.values()]) p.fire(); }
  function autoClear() { for (const p of AUTO.values()) clearTimeout(p.timer); AUTO.clear(); }
  // ---------- number pad for set weight/reps (replaces the phone keyboard) ----------
  function kpBuild() {
    const k = (label, fn, cls = '', aria) => h('button', { type: 'button', class: 'kpk ' + cls, 'aria-label': aria || label, onclick: fn }, label);
    const dig = (d) => k(d, () => kpType(d));
    KP.pad = h('div', { class: 'kpad', role: 'group', 'aria-label': 'Number pad', hidden: '' },
      dig('1'), dig('2'), dig('3'), k(icon('kbdown'), kpClose, 'fn', 'Hide number pad'),
      dig('4'), dig('5'), dig('6'), k(icon('plus'), () => kpStep(1), 'fn', 'Increase'),
      dig('7'), dig('8'), dig('9'), k(icon('minus'), () => kpStep(-1), 'fn', 'Decrease'),
      k('.', () => kpType('.'), 'dot', 'Decimal point'), dig('0'), k(icon('bksp'), kpBack, 'fn', 'Delete'), k(icon('next'), kpNext, 'go', 'Next box'));
    KP.pad.addEventListener('pointerdown', (ev) => ev.preventDefault());
    document.body.append(KP.pad);
    document.addEventListener('pointerdown', (ev) => {
      if (!KP.inp || ev.target.closest('.kpad, [data-kp], .setrow .ck')) return;
      kpClose();
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (!KP.inp) return;
      if (/^[0-9]$/.test(ev.key) || ev.key === '.') kpType(ev.key);
      else if (ev.key === 'Backspace') kpBack();
      else if (ev.key === 'Enter' || ev.key === 'Tab') kpNext();
      else if (ev.key === 'Escape') kpClose();
      else return;
      ev.preventDefault();
    });
  }
  function kpOpen(inp) {
    if (!KP.pad) kpBuild();
    const prev = KP.inp;
    if (prev) prev.classList.remove('kpon');
    KP.inp = inp; KP.key = inp.dataset.kp; KP.buf = inp.value; KP.fresh = true;
    // Moving to another set: if the one she left has weight and reps, its countdown keeps going.
    inp.classList.add('kpon');
    KP.pad.querySelector('.dot').disabled = !inp._kp.decimal;
    KP.pad.hidden = false; document.body.classList.add('kp-open');
    requestAnimationFrame(() => {
      // Measure where the pad will end up, not where its slide-up animation has it right now.
      const r = inp.getBoundingClientRect(), top = window.innerHeight - KP.pad.offsetHeight;
      if (r.bottom > top - 12) window.scrollBy({ top: r.bottom - top + 60, behavior: 'smooth' });
      else if (r.top < 70) window.scrollBy({ top: r.top - 90, behavior: 'smooth' });
    });
  }
  function kpClose() {
    const prev = KP.inp;
    if (prev) prev.classList.remove('kpon');
    KP.inp = null; KP.key = null;
    if (KP.pad) KP.pad.hidden = true;
    document.body.classList.remove('kp-open');
  }
  function kpApply() { KP.inp.value = KP.buf; KP.inp._kp.set(KP.buf); }
  // First key after opening a box replaces what's there (or the gray hint); later keys add on.
  function kpType(d) {
    if (!KP.inp) return;
    if (d === '.' && !KP.inp._kp.decimal) return;
    let b = KP.fresh ? '' : KP.buf;
    KP.fresh = false;
    if (d === '.') { if (b.includes('.')) return; b = (b || '0') + '.'; }
    else if (b === '0') b = d;
    else b += d;
    if (b.replace('.', '').length > 6) return;
    KP.buf = b; kpApply();
  }
  function kpBack() { if (!KP.inp) return; KP.fresh = false; KP.buf = KP.buf.slice(0, -1); kpApply(); }
  // + / − nudge from the current number, or from the gray hint if the box is empty.
  function kpStep(dir) {
    if (!KP.inp) return;
    const c = KP.inp._kp, cur = parseFloat(KP.buf);
    const v = Math.max(0, Math.round(((isFinite(cur) ? cur : c.hint()) + dir * c.step) * 100) / 100);
    KP.buf = String(v); KP.fresh = true; kpApply();
  }
  function kpNext() {
    if (!KP.inp) return;
    const all = [...document.querySelectorAll('[data-kp]')].filter(el => !el.closest('.setrow.done'));
    const i = all.indexOf(KP.inp);
    if (i >= 0 && all[i + 1]) kpOpen(all[i + 1]); else kpClose();
  }
  // After the workout screen redraws (e.g. a set is checked), keep the pad on the same box.
  function kpReattach() {
    const el = document.querySelector(`[data-kp="${KP.key}"]`);
    const { buf, fresh } = KP; // a redraw mid-typing (e.g. another set auto-confirming) keeps her place
    if (el && !el.closest('.setrow.done')) { kpOpen(el); KP.buf = buf; KP.fresh = fresh; } else kpClose();
  }
  async function finishWorkout() {
    const w = S.active;
    const live = isLive(w);
    autoFlush(); // sets still counting down count as done
    if (!setsOf(w).length) { actions('Nothing logged yet', [], 'Tap the ✓ on at least one set first.'); return; }
    if (!live && w.start > Date.now()) { toast('The date and time can’t be in the future'); return; }
    const left = w.exercises.reduce((n, e) => n + e.sets.filter(s => !s.done).length, 0);
    const note = left ? `${left} set${left === 1 ? '' : 's'} you haven't checked off will be removed. Go back to tick ${left === 1 ? 'it' : 'them'} if you did ${left === 1 ? 'it' : 'them'}.` : 'Every set is checked off.';
    if (!(await confirmBox(live ? 'Finish workout?' : 'Save workout?', note, live ? 'Finish Workout' : 'Save Workout'))) return;
    const end = live ? Date.now() : w.start + Math.max(1, w.durMin || 60) * 60000;
    const done = { id: w.id, name: (w.name || '').trim() || defaultName(), start: w.start, end, notes: w.notes || '', routineId: w.routineId || null, by: w.by || S.myName,
      exercises: w.exercises.map(e => ({ exerciseId: e.exerciseId, group: e.group || null, notes: e.notes || '', sets: doneSets(e).map(s => ({ weight: s.weight, reps: s.reps, kind: s.kind || 'normal', done: true })) })).filter(e => e.sets.length) };
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
    const first = !firstLogShown() && !S.workouts.some(x => x.id !== done.id);
    try { await put('workouts', done); } catch (e) { showErr(e); }
    go('');
    setTimeout(() => summary(done, prs, live, first ? firstLogMessage : null), 150);
  }
  // One-time message after the very first exercise she logs (Workout tab or StrongHER), never again.
  const firstLogShown = () => ls.get('cf-first-log-shown') === '1';
  function firstLogMessage() {
    if (firstLogShown()) return;
    ls.set('cf-first-log-shown', '1');
    if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    const sh = sheet(null, h('div', { style: 'text-align:center;display:grid;gap:14px;padding:8px 0 4px' },
      h('div', { class: 'trophy' }, icon('heart')),
      h('h2', { style: 'font-size:1.55rem;line-height:1.25', text: 'Now thank your husband with a BJ!!!!' }),
      h('button', { type: 'button', class: 'primary big', text: 'OK 😉', onclick: () => sh.close() })));
  }
  function summary(w, prs, live, after) {
    chime();
    const sh = sheet(null, h('div', { style: 'text-align:center;display:grid;gap:12px' },
      h('div', { class: 'trophy' }, icon('trophy')),
      h('h2', { style: 'font-size:1.6rem', text: live ? 'Workout complete!' : 'Workout saved!' }),
      h('p', { class: 'muted', style: 'margin:0', text: `That's workout #${S.workouts.length}. Proud of you 💕` }),
      h('div', { class: 'panel', style: 'text-align:left' }, tally(w)),
      prs.length ? h('div', { class: 'panel', style: 'text-align:left' }, h('div', { class: 'accent', style: 'font-weight:700;margin-bottom:6px', text: '🏆 New personal records' }),
        prs.map(p => h('div', { style: 'display:flex;justify-content:space-between;padding:4px 0' }, h('span', { text: p.name }), h('b', { text: fwu(p.weight) })))) : null,
      h('button', { type: 'button', class: 'primary big', text: 'Done', onclick: () => sh.close() })));
    if (after) sh.onClose = () => setTimeout(after, 250);
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
  // zoom: scale the y-axis to the data range (for body numbers that change by small amounts).
  function lineChart(points, suffix, zoom) {
    const W = 340, H = 190, L = 44, R = 10, T = 12, B = 24, id = 'g' + (++gid);
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys), pad = Math.max((yMax - yMin) * 0.35, Math.abs(yMax) * 0.01, 0.5);
    const hi = zoom ? yMax + pad : niceMax(yMax * 1.1), lo = zoom ? Math.max(0, yMin - pad) : 0;
    const sx = (x) => L + (x1 === x0 ? (W - L - R) / 2 : (x - x0) / (x1 - x0) * (W - L - R));
    const sy = (y) => T + (1 - (y - lo) / (hi - lo || 1)) * (H - T - B);
    const pts = points.map(p => [sx(p.x), sy(p.y)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = `${d} L${pts[pts.length - 1][0]},${H - B} L${pts[0][0]},${H - B} Z`;
    const ticks = zoom ? [lo, (lo + hi) / 2, hi] : [hi / 3, hi * 2 / 3, hi];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart, latest ${num1(ys[ys.length - 1])}">
      <defs><linearGradient id="${id}l" x1="0" x2="1"><stop offset="0" stop-color="#f490bb"/><stop offset="1" stop-color="#c9a3f0"/></linearGradient>
      <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f490bb" stop-opacity=".3"/><stop offset="1" stop-color="#f490bb" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 6}" y="${sy(t) + 3.5}" text-anchor="end">${kfmt(t)}${suffix && t === hi ? ' ' + suffix : ''}</text>`).join('')}
      <line class="grid" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      <path d="${area}" fill="url(#${id}a)"/>
      <path d="${d}" fill="none" stroke="url(#${id}l)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6" fill="#e46fa5"/>`).join('')}
      <text x="${L}" y="${H - 6}">${fmtDate(x0, { month: 'short', day: 'numeric' })}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDate(x1, { month: 'short', day: 'numeric' })}</text></svg>`;
  }
  function barChart(points) {
    const W = 340, H = 180, L = 32, R = 6, T = 10, B = 22, id = 'g' + (++gid);
    const max = niceMax(Math.max(...points.map(p => p.y))), bw = (W - L - R) / points.length;
    const sy = (y) => T + (1 - y / max) * (H - T - B);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Last 12 weeks">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f490bb"/><stop offset="1" stop-color="#c9a3f0"/></linearGradient></defs>
      ${[0, max / 2, max].map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 5}" y="${sy(t) + 3.5}" text-anchor="end">${kfmt(t)}</text>`).join('')}
      ${points.map((p, i) => { const hh = Math.max(0, H - B - sy(p.y)), x = L + i * bw + bw * .18;
        return `<rect x="${x}" y="${H - B - hh}" width="${bw * .64}" height="${hh}" rx="4" fill="url(#${id})"><title>${num1(p.y)}</title></rect>` +
          (i % 3 === 0 ? `<text x="${x + bw * .32}" y="${H - 6}" text-anchor="middle">${fmtDate(p.x, { month: 'short', day: 'numeric' })}</text>` : ''); }).join('')}</svg>`;
  }

  // ---------- sample data for the local preview (?demo=1&sample=1) ----------
  function samplePhoto(hue, label) {
    const c = document.createElement('canvas'); c.width = c.height = 640; const g = c.getContext('2d');
    g.fillStyle = `hsl(${hue + 30} 35% 22%)`; g.fillRect(0, 0, 640, 640);
    g.fillStyle = '#f4efe9'; g.beginPath(); g.arc(320, 320, 250, 0, 7); g.fill();
    g.fillStyle = '#e6ded6'; g.beginPath(); g.arc(320, 320, 200, 0, 7); g.fill();
    for (let i = 0; i < 7; i++) { g.fillStyle = `hsl(${hue + i * 18} 65% ${48 + (i % 3) * 8}%)`; g.beginPath(); g.ellipse(230 + (i % 3) * 90, 250 + Math.floor(i / 3) * 80, 62, 44, i, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 560, 640, 80); g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.fillText(label, 320, 612);
    const t = document.createElement('canvas'); t.width = t.height = 240; t.getContext('2d').drawImage(c, 0, 0, 240, 240);
    return { thumb: t.toDataURL('image/jpeg', 0.75), image: c.toDataURL('image/jpeg', 0.8) };
  }
  function sampleScanPhoto(date, weight, smm, pbf) {
    const c = document.createElement('canvas'); c.width = 720; c.height = 960; const g = c.getContext('2d');
    g.fillStyle = '#d9d2cc'; g.fillRect(0, 0, 720, 960);
    g.save(); g.translate(360, 480); g.rotate(-0.03); g.fillStyle = '#fbfbf9'; g.fillRect(-300, -420, 600, 840);
    g.fillStyle = '#b4123a'; g.font = 'bold 44px sans-serif'; g.fillText('InBody', -260, -350);
    g.fillStyle = '#333'; g.font = '20px sans-serif'; g.fillText('Body Composition Analysis · ' + date, -260, -310);
    const rows = [['Weight', weight + ' lb'], ['Skeletal Muscle Mass', smm + ' lb'], ['Percent Body Fat', pbf + ' %']];
    rows.forEach(([k, v], i) => { const y = -240 + i * 70; g.fillStyle = '#eee'; g.fillRect(-260, y - 34, 520, 50); g.fillStyle = '#222'; g.font = '24px sans-serif'; g.fillText(k, -245, y); g.font = 'bold 26px sans-serif'; g.fillText(v, 120, y); });
    for (let i = 0; i < 9; i++) { g.fillStyle = '#ddd'; g.fillRect(-260, 20 + i * 38, 220 + (i * 37) % 280, 14); }
    g.restore();
    const t = document.createElement('canvas'); t.width = t.height = 240; t.getContext('2d').drawImage(c, 0, 120, 720, 720, 0, 0, 240, 240);
    return { thumb: t.toDataURL('image/jpeg', 0.75), image: c.toDataURL('image/jpeg', 0.8) };
  }
  function loadSample() {
    const X = (n, eq) => window.courtfitExerciseId(n, eq);
    S.exercises = (window.COURTFIT_LIBRARY || []).map(([name, equipment, muscle]) => ({ id: X(name, equipment), name, equipment, muscle }));
    const range = (n, reps) => Array.from({ length: n }, () => ({ weight: null, reps }));
    S.routines = [{ id: 'rsample', name: 'Glute Day 🍑', by: S.myName, created: 1, order: 0, items: [
      { exerciseId: X('Hip Thrust', 'Barbell'), sets: range(3, '8-10') },
      { exerciseId: X('Romanian Deadlift', 'Dumbbell'), sets: range(3, '10-12') },
      { exerciseId: X('Hip Abduction', 'Machine'), sets: range(3, '12-15') }] }];
    const today = startOfDay(Date.now());
    const plan = [[16, 85, 8], [12, 90, 9], [8, 95, 9], [3, 95, 10]]; // days ago, weight, reps: last one hits the top of 8-10
    S.workouts = plan.map(([ago, wt, reps], i) => {
      const set = (w, r) => ({ weight: w, reps: r, done: true, kind: 'normal' });
      return { id: 'wsample' + i, name: 'Glute Day 🍑', by: S.myName, routineId: 'rsample', start: today - ago * DAY + 17.5 * 3600000, end: today - ago * DAY + 18.3 * 3600000, notes: '',
        exercises: [
          { exerciseId: X('Hip Thrust', 'Barbell'), notes: '', sets: [set(wt, reps), set(wt, reps), set(wt, reps)] },
          { exerciseId: X('Romanian Deadlift', 'Dumbbell'), notes: '', sets: [set(25 + i * 2.5, 10 + (i > 1 ? 1 : 0)), set(25 + i * 2.5, 10), set(25 + i * 2.5, 10)] },
          { exerciseId: X('Hip Abduction', 'Machine'), notes: '', sets: [set(70 + i * 5, 15), set(70 + i * 5, 14), set(70 + i * 5, 12)] }] };
    });
    const p = clone(STRONGHER_R4);
    const wkA = p.log.A.weeks, wkB = p.log.B.weeks;
    wkA[0].date = shiftDay(todayISO(), -13); wkB[0].date = shiftDay(todayISO(), -11);
    wkA[1] = { date: shiftDay(todayISO(), -6), v: { '1.1': ['15', '15', '20', '25'], '1.2': ['12', '15', '20', '20'], '2.1': ['15', '20', '25'], '2.2': ['20', '20', '25'],
      '3.1': ['AW', 'AW', 'AW'], '3.2': ['AW', 'AW', 'AW'], '4.1': ['10', '12', '12'], '4.2': ['10', '10', '10'] } };
    wkB[1] = { date: shiftDay(todayISO(), -4), v: { '1.1': ['12', '12', '15', '20'], '1.2': ['8', '8', '10', '10'], '2.1': ['—', '—', '—'], '2.2': ['—', '—', '—'],
      '3.1': ['10', '10', '12'], '3.2': ['7', '7', '10'], '4.1': ['—', '—', '—'], '4.2': ['10', '10', '10'] } };
    S.programs = [p];
    const foods = [
      ['Breakfast', 'Greek yogurt + berries', 20, 30, 6, 30], ['Breakfast', 'Eggs & toast', 22, 28, 16, 50],
      ['Lunch', 'Chicken salad', 38, 18, 20, 120], ['Lunch', 'Turkey wrap', 32, 40, 14, 20],
      ['Snack', 'Protein shake', 30, 8, 3, 200], ['Snack', 'Apple + peanut butter', 7, 28, 16, 0],
      ['Dinner', 'Salmon, rice & greens', 40, 55, 18, 160], ['Dinner', 'Taco bowl', 35, 60, 22, 10]];
    S.meals = []; S.thumbs = {}; S.images = {};
    for (let ago = 9; ago >= 0; ago--) {
      const date = shiftDay(todayISO(), -ago);
      if (ago === 6) continue; // a missed day
      const pick = ago === 0 ? [0, 2] : ago % 2 ? [0, 3, 4, 6] : [1, 2, 5, 7];
      pick.forEach((fi, j) => {
        const [meal, name, pr, cb, ft, hue] = foods[fi];
        const id = `msample${ago}_${j}`;
        const photo = j % 2 === 0;
        S.meals.push({ id, date, at: new Date(date + 'T00:00').getTime() + (8 + j * 4) * 3600000, meal, name, cal: '', p: pr, c: cb, f: ft, notes: '', hasPhoto: photo, by: S.myName });
        if (photo) { const ph = samplePhoto(hue, name); S.thumbs[id] = ph.thumb; S.images[id] = ph.image; }
      });
    }
    // Superset in the sample routine and recent workouts (RDL + hip abduction).
    S.routines[0].items[1].group = 'gsample'; S.routines[0].items[2].group = 'gsample';
    S.workouts.slice(-2).forEach(w => { w.exercises[1].group = 'gsample'; w.exercises[2].group = 'gsample'; });
    // Three InBody scans, about a month apart, with a mock printout photo.
    const scanRows = [[58, 160.2, 62.1, 47.0, 29.3, 26.6, 9, 1392, 72], [29, 159.1, 62.8, 45.2, 28.4, 26.4, 8, 1405, 74], [3, 158.9, 63.5, 43.9, 27.6, 26.4, 8, 1418, 76]];
    S.body_scans = scanRows.map(([ago, weight, smm, bfm, pbf, bmi, vfl, bmr, score], i) => {
      const id = 'bsample' + i, date = shiftDay(todayISO(), -ago);
      const ph = sampleScanPhoto(date, weight, smm, pbf); S.thumbs[id] = ph.thumb; S.images[id] = ph.image;
      return { id, date, at: i, weight, smm, bfm, pbf, bmi, vfl, bmr, score, hasPhoto: true, notes: '',
        seg: i === 2 ? { la: 6.2, ra: 6.3, tr: 50.4, ll: 17.6, rl: 17.7 } : i === 1 ? { la: 6.1, ra: 6.2, tr: 49.9, ll: 17.4, rl: 17.4 } : {} };
    });
    S.saved_meals = [{ id: 'ssample', name: 'My usual breakfast', meal: 'Breakfast', created: 1, items: [
      { name: 'Greek yogurt', cal: '', p: 17, c: 7, f: 0 }, { name: 'Blueberries', cal: '', p: 1, c: 21, f: 0 }, { name: 'Granola', cal: '', p: 3, c: 20, f: 6 }] }];
  }

  // Screenshot states for the local sample preview only (?demo=1&sample=1&shot=...).
  function previewShot(shot) {
    if (!shot) return;
    const later = (fn) => setTimeout(fn, 300);
    if (shot === 'active') {
      S.active = null; saveActive();
      startRoutine(S.routines[0]);
      const s = S.active.exercises[0].sets[0]; s.weight = 100; s.reps = 10; s.done = true; saveActive();
      S.view = { name: 'active' };
    } else if (shot === 'shA2' || shot === 'shB3' || shot === 'shgrid') {
      S.progWorkout = shot === 'shB3' ? 'B' : 'A'; S.progWeek = shot === 'shB3' ? 2 : 1; S.progMode = shot === 'shgrid' ? 'grid' : 'week';
      S.view = { name: 'strongher' };
      if (shot === 'shB3') later(() => { const el = [...document.querySelectorAll('.pex')][1]; if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80); });
    } else if (shot === 'macros') {
      S.view = { name: 'macros' }; S.mDate = shiftDay(todayISO(), -1);
    } else if (shot === 'addfood') {
      S.view = { name: 'macros' }; later(() => mealSheet(null, todayISO()));
    } else if (shot === 'calendar') {
      S.view = { name: 'profile' };
      later(() => { const p = [...document.querySelectorAll('.panel')].find(x => x.querySelector('.cal')); if (p) window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 70); });
    } else if (shot === 'day') {
      S.view = { name: 'profile' };
      later(() => { const iso = isoOf(new Date(S.workouts[S.workouts.length - 1].start)); daySheet(iso, activityMap()[iso]); });
    } else if (shot === 'scans' || shot === 'badges') {
      S.view = { name: 'profile' }; S.scanMetric = 'pbf';
      later(() => { const p = [...document.querySelectorAll('.panel')].find(x => x.innerText.startsWith(shot === 'scans' ? 'InBody' : 'Achievements')); if (p) window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 70); });
    } else if (shot === 'scan') {
      S.view = { name: 'profile' }; later(() => scanDetail(S.body_scans[S.body_scans.length - 1].id));
    } else if (shot === 'addscan') {
      S.view = { name: 'profile' }; later(() => scanSheet(null));
    } else if (shot === 'superset') {
      S.active = null; saveActive(); startRoutine(S.routines[0]); S.view = { name: 'active' };
      later(() => { const el = document.querySelector('.ssgroup'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80); });
    } else if (shot === 'celebrate') {
      S.view = { name: 'profile' };
      const on = achievements().filter(a => a.on).map(a => a.id);
      ls.set('cf-badges-seen', JSON.stringify(on.filter(id => id !== 'b3' && id !== 'bf')));
    } else if (shot === 'reminders') {
      ls.set('cf-remind', JSON.stringify({ ...REMIND_DEFAULT, enabled: true }));
      S.view = { name: 'settings' };
      later(() => { const p = [...document.querySelectorAll('.panel')].find(x => x.innerText.startsWith('Reminders')); if (p) window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 70); });
    }
    const hashFor = { active: 'active', strongher: 'strongher', macros: 'macros', profile: 'profile', settings: 'settings' };
    history.replaceState(null, '', location.pathname + location.search + '#' + (hashFor[S.view.name] || ''));
  }

  // ---------- boot ----------
  window.addEventListener('online', () => { flush().then(() => loadAll()); });
  window.addEventListener('offline', () => { S.offline = true; render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.sb && !S.needName) flush().then(() => loadAll()); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProg(); });
  window.addEventListener('pagehide', flushProg);
  // Updates. The running version is the ?v= on app.js. iPhone home-screen apps often resume
  // instead of reloading, so when the app comes back on screen we ask for the newest
  // index.html and reload if it names a newer app.js. Nothing is lost: the workout in
  // progress is saved on every change, and pending StrongHER edits are sent first.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(err => console.error('Service worker', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) checkForUpdate(); });
  }
  let checkingUpdate = false;
  async function checkForUpdate() {
    if (checkingUpdate || location.protocol !== 'https:') return;
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; // never interrupt typing; try again next time
    checkingUpdate = true;
    try {
      navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {});
      const html = await (await fetch('index.html?check=' + Date.now(), { cache: 'no-store' })).text();
      const v = (html.match(/app\.js\?v=(\d+)/) || [])[1];
      if (v && Number(v) > Number(APP_VERSION)) {
        await flushProg();
        location.reload();
      }
    } catch { } finally { checkingUpdate = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkForUpdate(); });
  setTimeout(checkForUpdate, 4000);

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
    if (DEMO && SAMPLE) {
      if (!S.myName) { S.myName = 'Court'; ls.set('cf-name', S.myName); }
      ls.set('cf-first-log-shown', '1');
      if (QS.get('shot') !== 'celebrate') ls.del('cf-badges-seen');
      loadSample(); S.loaded = true; S.synced = true;
      previewShot(QS.get('shot'));
      render(true); return;
    }
    if (DEMO) {
      if (!loadCache()) { S.exercises = (window.COURTFIT_LIBRARY || []).map(([name, equipment, muscle]) => ({ id: window.courtfitExerciseId(name, equipment), name, equipment, muscle })); saveCache(); }
      if (!S.programs.length) { S.programs = [clone(STRONGHER_R4)]; saveCache(); }
      S.needName = !S.myName; S.loaded = true; S.synced = true; render(true); return;
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
    // First run: add the StrongHER Round 4 tracker with Court's week-1 numbers from the paper.
    if (!S.offline && !S.programs.length) { try { await put('programs', clone(STRONGHER_R4)); render(); } catch (e) { console.error(e); } }
    let t;
    channel = S.sb.channel('courtfit-changes', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, ({ payload }) => {
        clearTimeout(t);
        if (payload && payload.table === 'meal_photos') { S.thumbs = {}; S.images = {}; render(); return; }
        const tb = payload && TABLES.includes(payload.table) ? payload.table : null;
        t = setTimeout(() => (tb ? loadTable(tb) : Promise.all(TABLES.map(loadTable))).then(() => { saveCache(); render(); }).catch(() => {}), 200);
      })
      .subscribe();
    setInterval(() => { if (document.visibilityState === 'visible') loadAll(); }, 120000);
  })();
})();
