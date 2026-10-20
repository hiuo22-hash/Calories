'use strict';

const HOUR_PX = 64;            // 1시간 높이(px)
const PXM = HOUR_PX / 60;      // 1분당 px
const SNAP = 5;                // 드래그 시 5분 단위로 맞춤
const DAY = 1440;
const MIN_DUR = 10;
const LONG_PRESS_MS = 300;

const TYPES = {
  daily: { label: '일상' },
  exercise: { label: '운동' },
  meal: { label: '식사' },
  event: { label: '일정' },
};

const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const eventsEl = $('events');

let store = null;
let profile = null;
let routines = [];
let curDate;               // 'YYYY-MM-DD'
let dayEntries = [];       // 보고 있는 날의 기록
let weekOthers = [];       // 같은 주의 다른 날 기록 (운동 목표용)
let unwatchDay = null;
let editing = null;        // { isNew, draft, aiCtl }
let drag = null;
let pendingRender = false;
let sample = null;         // claude.ai 안에서만: 앱에서 바로 AI 계산

/* ---------- 유틸 ---------- */

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.round(n).toLocaleString('ko-KR');
const WD = '일월화수목금토';

function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
function today() { return dateStr(new Date()); }
function weekStart(s) { const d = parseDate(s); return addDays(s, -((d.getDay() + 6) % 7)); } // 월요일 시작
function dayLabel(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`; }
function fmt(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

// <input type="time">은 24:00을 표현할 수 없어 23:59로 대신 보여줌
function toTimeInput(min) { return min >= DAY ? '23:59' : fmt(min); }
function fromTimeInput(v) {
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  const min = h * 60 + m;
  return min === DAY - 1 ? DAY : min;
}

function durationText(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h}시간` : '', m ? `${m}분` : ''].filter(Boolean).join(' ') || '0분';
}

function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function saveFailed(e) {
  toast(e?.code === 'quota_exceeded' ? '저장 공간이 가득 찼어요. 오래된 루틴을 지워 주세요.' : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

/* ---------- 칼로리 ---------- */

function weight() { return profile?.weight || 65; }

function bmr(p) {
  if (!p || !p.weight) return 0;
  // Mifflin-St Jeor 공식
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
  return p.sex === 'f' ? base - 161 : base + 5;
}

function baseBurn() { return profile ? Math.round(bmr(profile) * (profile.activity || 1)) : 0; }

function exerciseOf(key) { return EXERCISES.find((x) => x.key === key) || EXERCISES[0]; }

// 자유 입력한 음식이 아직 AI 계산 전인지
function isPending(e) {
  return e.type === 'meal' && !e.kcalManual && !!(e.foodText || '').trim() && !(e.ai && e.ai.forText === e.foodText);
}

function autoKcal(e) {
  if (e.type === 'exercise') return Math.round(exerciseOf(e.exercise).met * weight() * (e.end - e.start) / 60);
  if (e.type === 'meal') {
    const picked = (e.foods || []).reduce((s, f) => s + f.kcal * f.qty, 0);
    const ai = e.ai && e.ai.forText === e.foodText ? e.ai.total : 0;
    return Math.round(picked + ai);
  }
  return 0;
}

function entryTitle(e) {
  if (e.title) return e.title;
  if (e.type === 'exercise') return exerciseOf(e.exercise).name;
  if (e.type === 'meal') {
    const parts = [];
    if (e.foodText) parts.push(e.foodText.trim());
    (e.foods || []).forEach((f) => parts.push(f.name.replace(/\s*\(.*\)$/, '')));
    if (parts.length) return parts.join(', ');
  }
  return TYPES[e.type].label;
}

function dayTotals(entries) {
  const ex = entries.filter((e) => e.type === 'exercise');
  const intake = entries.filter((e) => e.type === 'meal').reduce((s, e) => s + (e.kcal || 0), 0);
  const exBurn = ex.reduce((s, e) => s + (e.kcal || 0), 0);
  const exMin = ex.reduce((s, e) => s + (e.end - e.start), 0);
  return {
    intake, exBurn, exMin, exCount: ex.length,
    pending: entries.filter(isPending).length,
    burn: baseBurn() + exBurn,
  };
}

/* ---------- 기록 화면 ---------- */

function buildGrid() {
  $('timeline').style.height = `${24 * HOUR_PX}px`;
  let html = '';
  for (let h = 0; h <= 24; h++) {
    html += `<div class="hour" style="top:${h * HOUR_PX}px"><span>${h < 24 ? pad(h) + ':00' : ''}</span></div>`;
    if (h < 24) html += `<div class="half" style="top:${h * HOUR_PX + HOUR_PX / 2}px"></div>`;
  }
  $('grid').innerHTML = html;
}

function render() {
  if (drag && drag.active) { pendingRender = true; return; }
  renderHeader();
  renderSummary();
  renderEvents();
  renderNow();
}

function renderHeader() {
  const d = parseDate(curDate);
  const isToday = curDate === today();
  $('dateLabel').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})${isToday ? ' · 오늘' : ''}`;
  $('datePicker').value = curDate;
  $('todayBtn').hidden = isToday;
}

function renderSummary() {
  const t = dayTotals(dayEntries);
  const net = t.intake - t.burn;
  $('sumIn').textContent = num(t.intake);
  $('sumInNote').textContent = t.pending ? `kcal · 계산 대기 ${t.pending}건` : 'kcal';
  $('sumOut').textContent = num(t.burn);
  $('sumOutDetail').textContent = profile ? `기초 ${num(baseBurn())} + 운동 ${num(t.exBurn)}` : '설정에서 내 정보 입력';
  $('sumNet').textContent = (net > 0 ? '+' : '') + num(net);
  $('sumNetNote').textContent = net > 0 ? '초과 섭취' : net < 0 ? '부족 (감량 방향)' : '균형';
  $('summary').classList.toggle('over', net > 0);

  const g = profile?.goals || {};
  const hasIn = g.intake > 0, hasEx = g.exMinutes > 0 || g.exCount > 0;
  $('goals').hidden = !hasIn && !hasEx;
  $('goalInText').textContent = hasIn ? `${num(t.intake)} / ${num(g.intake)}` : '목표 없음';
  $('goalInBar').style.width = hasIn ? `${Math.min(100, (t.intake / g.intake) * 100)}%` : '0';
  $('goalInBar').classList.toggle('over', hasIn && t.intake > g.intake);

  const wk = [...weekOthers, { entries: dayEntries }].map((d) => dayTotals(d.entries || []));
  const wMin = wk.reduce((s, x) => s + x.exMin, 0), wCnt = wk.reduce((s, x) => s + x.exCount, 0);
  const parts = [];
  if (g.exMinutes > 0) parts.push(`${wMin}/${g.exMinutes}분`);
  if (g.exCount > 0) parts.push(`${wCnt}/${g.exCount}회`);
  $('goalExText').textContent = parts.join(' · ') || '목표 없음';
  const ratio = Math.min(
    g.exMinutes > 0 ? wMin / g.exMinutes : Infinity,
    g.exCount > 0 ? wCnt / g.exCount : Infinity);
  $('goalExBar').style.width = Number.isFinite(ratio) ? `${Math.min(100, ratio * 100)}%` : '0';

  const important = dayEntries.filter((e) => e.important).sort((a, b) => a.start - b.start);
  $('importantBar').hidden = !important.length;
  $('importantBar').innerHTML = important.map((e) =>
    `<button data-id="${e.id}">★ ${fmt(e.start)} ${esc(entryTitle(e))}</button>`).join('');
}

// 겹치는 기록은 옆으로 나란히 배치
function layout(list) {
  const minVis = 24 / PXM;
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map();
  let cluster = [], cols = [], clusterEnd = -1;
  const flush = () => {
    cluster.forEach((e) => { out.get(e.id).n = cols.length; });
    cluster = []; cols = []; clusterEnd = -1;
  };
  for (const e of sorted) {
    const visEnd = Math.max(e.end, e.start + minVis);
    if (cluster.length && e.start >= clusterEnd) flush();
    let c = cols.findIndex((end) => end <= e.start);
    if (c < 0) { c = cols.length; cols.push(visEnd); } else cols[c] = visEnd;
    out.set(e.id, { col: c, n: 1 });
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, visEnd);
  }
  flush();
  return out;
}

function metaHtml(e) {
  let s = `${TYPES[e.type].label} ${fmt(e.start)}–${fmt(e.end)}`;
  if (e.type === 'meal' && e.kcal) s += ` · +${num(e.kcal)}kcal`;
  if (e.type === 'exercise' && e.kcal) s += ` · −${num(e.kcal)}kcal`;
  return esc(s) + (isPending(e) ? ' · <span class="pending">계산 대기</span>' : '');
}

function placeEvent(el, e, pos) {
  el.style.top = `${e.start * PXM}px`;
  el.style.height = `${Math.max((e.end - e.start) * PXM - 2, 22)}px`;
  if (pos) {
    el.style.left = `calc(${(pos.col / pos.n) * 100}% + 1px)`;
    el.style.width = `calc(${100 / pos.n}% - 3px)`;
  }
  el.querySelector('.ev-meta').innerHTML = metaHtml(e);
  el.classList.toggle('short', e.end - e.start < 40);
}

function renderEvents() {
  const lay = layout(dayEntries);
  eventsEl.innerHTML = '';
  for (const e of dayEntries) {
    const el = document.createElement('div');
    el.className = `ev t-${e.type}${e.important ? ' important' : ''}`;
    el.dataset.id = e.id;
    el.innerHTML =
      `<div class="ev-title">${e.important ? '<span class="star">★</span> ' : ''}${esc(entryTitle(e))}</div>` +
      `<div class="ev-meta"></div><div class="handle" aria-label="길이 조절"></div>`;
    placeEvent(el, e, lay.get(e.id));
    eventsEl.append(el);
  }
  $('emptyHint').hidden = dayEntries.length > 0;
}

function renderNow() {
  const isToday = curDate === today();
  $('nowLine').hidden = !isToday;
  if (isToday) $('nowLine').style.top = `${nowMinutes() * PXM}px`;
}

function scrollToDefault() {
  const isToday = curDate === today();
  const target = isToday ? nowMinutes() - 90
    : dayEntries.length ? Math.min(...dayEntries.map((e) => e.start)) - 30 : 7 * 60;
  scroller.scrollTop = Math.max(0, target * PXM);
}

async function loadWeek() {
  const from = weekStart(curDate), to = addDays(from, 6), date = curDate;
  try {
    const days = await store.rangeDays(from, to);
    if (date !== curDate) return;
    weekOthers = days.filter((d) => d.date !== curDate);
    renderSummary();
  } catch (e) { /* 주간 합계는 다음 이동 때 다시 시도 */ }
}

function goTo(date) {
  curDate = date;
  if (unwatchDay) unwatchDay();
  let first = true;
  dayEntries = [];
  weekOthers = [];
  render();
  scrollToDefault();
  unwatchDay = store.watchDay(date, (entries) => {
    if (date !== curDate) return;
    dayEntries = entries;
    render();
    if (first) { first = false; scrollToDefault(); }
  }, () => toast('기록을 불러오지 못했어요. 새로고침해 주세요.'));
  loadWeek();
}

function commitDay() {
  render();
  store.setDay(curDate, dayEntries).catch(saveFailed);
}

/* ---------- 드래그로 시간 조정 ---------- */
// 블록을 꾹 누르면(롱프레스) 이동, 아래쪽 손잡이를 끌면 길이 조절.
// 짧게 탭하면 편집 화면이 열림.

function findEntry(id) { return dayEntries.find((e) => e.id === id); }

eventsEl.addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.ev');
  if (!el || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  const entry = findEntry(el.dataset.id);
  if (!entry) return;
  const resize = !!ev.target.closest('.handle');
  drag = {
    el, entry, mode: resize ? 'resize' : 'move', pid: ev.pointerId,
    x0: ev.clientX, y0: ev.clientY, lastY: ev.clientY, s0: scroller.scrollTop,
    orig: { start: entry.start, end: entry.end },
    touch: ev.pointerType !== 'mouse', active: false, timer: null,
  };
  if (resize) activateDrag();
  else if (drag.touch) drag.timer = setTimeout(activateDrag, LONG_PRESS_MS);
});

function activateDrag() {
  if (!drag) return;
  drag.active = true;
  drag.el.classList.add('dragging');
  try { drag.el.setPointerCapture(drag.pid); } catch (e) { /* 이미 해제됨 */ }
  if (drag.touch && navigator.vibrate) navigator.vibrate(12);
  requestAnimationFrame(autoScroll);
}

function updateDrag() {
  const dMin = ((drag.lastY - drag.y0) + (scroller.scrollTop - drag.s0)) / PXM;
  const { start, end } = drag.orig;
  const e = drag.entry;
  if (drag.mode === 'move') {
    const len = end - start;
    e.start = clamp(Math.round((start + dMin) / SNAP) * SNAP, 0, DAY - len);
    e.end = e.start + len;
  } else {
    e.end = clamp(Math.round((end + dMin) / SNAP) * SNAP, start + MIN_DUR, DAY);
  }
  if (e.type === 'exercise' && !e.kcalManual) e.kcal = autoKcal(e);
  placeEvent(drag.el, e);
}

// 화면 위/아래 끝으로 끌면 자동 스크롤
function autoScroll() {
  if (!drag || !drag.active) return;
  const r = scroller.getBoundingClientRect();
  const edge = 56;
  let v = 0;
  if (drag.lastY < r.top + edge) v = -Math.ceil((r.top + edge - drag.lastY) / 5);
  else if (drag.lastY > r.bottom - edge) v = Math.ceil((drag.lastY - (r.bottom - edge)) / 5);
  if (v) { scroller.scrollTop += v; updateDrag(); }
  requestAnimationFrame(autoScroll);
}

window.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pid) return;
  drag.lastY = ev.clientY;
  if (!drag.active) {
    if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 8) return;
    if (drag.touch) { cancelDrag(); return; }   // 손가락이 먼저 움직이면 스크롤로 판단
    activateDrag();
  }
  ev.preventDefault();
  updateDrag();
}, { passive: false });

// 드래그 중에는 화면 스크롤을 막음
document.addEventListener('touchmove', (ev) => {
  if (drag && drag.active) ev.preventDefault();
}, { passive: false });

function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag = null;
}

function endDrag(ev) {
  if (!drag || ev.pointerId !== drag.pid) return;
  const d = drag;
  clearTimeout(d.timer);
  drag = null;
  pendingRender = false;
  const moved = d.entry.start !== d.orig.start || d.entry.end !== d.orig.end;
  if (moved) {
    commitDay();
  } else {
    d.el.classList.remove('dragging');
    render();
    if (ev.type === 'pointerup') openEditor(d.entry, false);
  }
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', (ev) => {
  if (drag && drag.active) endDrag(ev); else cancelDrag();
});
eventsEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

// 빈 시간대를 탭하면 그 시간에 새 기록
eventsEl.addEventListener('click', (ev) => {
  if (ev.target !== eventsEl) return;
  newEntryAt(Math.floor(ev.offsetY / PXM / 30) * 30);
});

function newEntryAt(start) {
  start = clamp(start, 0, DAY - 30);
  openEditor({
    id: uid(), type: 'daily', title: '', start, end: Math.min(start + 60, DAY),
    important: false, memo: '', toCal: false,
    exercise: EXERCISES[0].key, foodText: '', foods: [], ai: null, kcal: 0, kcalManual: false,
  }, true);
}

/* ---------- 시트 공통 ---------- */

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => closeSheet(b.closest('.backdrop').id)));
document.querySelectorAll('.backdrop').forEach((bd) =>
  bd.addEventListener('click', (ev) => { if (ev.target === bd) closeSheet(bd.id); }));

/* ---------- 편집 화면 ---------- */

const form = $('editor');
$('fExercise').innerHTML = EXERCISES.map((x) => `<option value="${x.key}">${esc(x.name)}</option>`).join('');

function openEditor(entry, isNew) {
  editing?.aiCtl?.abort();
  editing = { isNew, draft: structuredClone(entry), aiCtl: null };
  const d = editing.draft;
  d.foods = d.foods || [];
  d.foodText = d.foodText || '';
  $('editorTitle').textContent = isNew ? '새 기록' : '기록 수정';
  $('fTitle').value = d.title;
  $('fStart').value = toTimeInput(d.start);
  $('fEnd').value = toTimeInput(d.end);
  $('fImportant').checked = !!d.important;
  $('fExercise').value = d.exercise || EXERCISES[0].key;
  $('fFoodText').value = d.foodText;
  $('fMemo').value = d.memo || '';
  $('fToCal').checked = !!d.toCal;
  $('foodSearch').value = '';
  $('foodResults').innerHTML = '';
  $('deleteBtn').hidden = isNew;
  disarmDelete();
  syncEditor();
  openSheet('editorSheet');
}

function readTimes() {
  const d = editing.draft;
  const s = fromTimeInput($('fStart').value);
  const e = fromTimeInput($('fEnd').value);
  if (s !== null) d.start = s;
  if (e !== null) d.end = e;
}

// 종류·시간·음식이 바뀔 때마다 편집 화면을 다시 맞춤
function syncEditor() {
  const d = editing.draft;
  document.querySelectorAll('#typeChips button').forEach((b) => {
    b.classList.toggle('on', b.dataset.type === d.type);
    b.style.setProperty('--c-on', `var(--c-${b.dataset.type})`);
  });
  form.dataset.type = d.type;
  const bad = d.end <= d.start;
  $('fDuration').textContent = bad ? '종료 시간이 시작보다 늦어야 해요' : `총 ${durationText(d.end - d.start)}`;
  $('fDuration').classList.toggle('error', bad);

  const ex = exerciseOf(d.exercise);
  $('metNote').textContent = `운동 강도 ${ex.met} MET × 체중 ${weight()}kg × ${durationText(Math.max(0, d.end - d.start))}`;

  renderAi();
  $('foodList').innerHTML = d.foods.map((f, i) => `
    <li>
      <span class="food-name">${esc(f.name)}</span>
      <span class="qty">
        <button type="button" data-food="${i}" data-step="-0.5" aria-label="줄이기">−</button>
        <b>${f.qty}</b>
        <button type="button" data-food="${i}" data-step="0.5" aria-label="늘리기">+</button>
      </span>
      <span class="food-kcal">${num(f.kcal * f.qty)}</span>
      <button type="button" class="remove" data-food="${i}" data-remove aria-label="빼기">×</button>
    </li>`).join('');

  $('kcalBox').hidden = !(d.type === 'exercise' || d.type === 'meal');
  $('kcalLabel').textContent = d.type === 'meal' ? '섭취 칼로리 (kcal)' : '소모 칼로리 (kcal)';
  if (!d.kcalManual) d.kcal = autoKcal(d);
  $('fKcal').value = isPending(d) && !d.kcal ? '' : d.kcal;
  $('fKcal').placeholder = isPending(d) ? '계산 대기' : '';
  $('kcalAuto').hidden = !d.kcalManual;
}

function renderAi() {
  const d = editing.draft;
  const text = d.foodText.trim();
  const fresh = d.ai && d.ai.forText === d.foodText;
  const busy = !!editing.aiCtl;
  let status = '';
  if (busy) status = 'AI가 칼로리를 계산하는 중…';
  else if (!text) status = '';
  else if (d.kcalManual) status = '칼로리를 직접 입력해서 AI 계산은 건너뜁니다.';
  else if (fresh) status = `AI 계산 완료 (${d.ai.by === 'nightly' ? '새벽 자동 계산' : '앱에서 계산'})`;
  else if (store.mode === 'cloud') status = '저장해 두면 새벽 1시에 자동으로 계산돼요.';
  $('aiStatus').textContent = status;
  $('aiBtn').hidden = !sample || !text || d.kcalManual;
  $('aiBtn').disabled = busy;
  $('aiBtn').textContent = fresh ? '다시 계산' : '지금 AI로 계산';
  $('aiItems').innerHTML = fresh ? d.ai.items.map((it) =>
    `<li><span>${esc(it.name)}${it.amount ? ` <small>${esc(it.amount)}</small>` : ''}</span><span>${num(it.kcal)}</span></li>`).join('') +
    (d.ai.note ? `<li class="note">${esc(d.ai.note)}</li>` : '') : '';
}

$('typeChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-type]');
  if (!b) return;
  editing.draft.type = b.dataset.type;
  editing.draft.kcalManual = false;
  syncEditor();
});

['fStart', 'fEnd'].forEach((id) => $(id).addEventListener('change', () => { readTimes(); syncEditor(); }));
$('fExercise').addEventListener('change', () => { editing.draft.exercise = $('fExercise').value; syncEditor(); });
$('fFoodText').addEventListener('input', () => { editing.draft.foodText = $('fFoodText').value; syncEditor(); });
$('fKcal').addEventListener('input', () => {
  editing.draft.kcalManual = true;
  editing.draft.kcal = Math.max(0, Number($('fKcal').value) || 0);
  $('kcalAuto').hidden = false;
  renderAi();
});
$('kcalAuto').addEventListener('click', () => { editing.draft.kcalManual = false; syncEditor(); });

/* AI 칼로리 계산 (claude.ai 안에서 열었을 때만) */
function foodPrompt(text) {
  return [
    '당신은 한국 음식 영양 정보에 밝은 영양사입니다.',
    '아래 식사 기록에 적힌 음식과 음료 각각의 섭취 칼로리(kcal)를 추정하세요.',
    '양이 적혀 있지 않으면 한국에서 흔한 1인분으로 가정하세요.',
    '',
    `식사 기록: """${text}"""`,
    '',
    'JSON 객체 하나로만 답하세요. 예:',
    '{"items":[{"name":"김치찌개","amount":"반 그릇","kcal":125}],"note":"가정한 내용이 있으면 한 문장"}',
  ].join('\n');
}

$('aiBtn').addEventListener('click', async () => {
  const ed = editing;
  const d = ed.draft;
  const text = d.foodText;
  ed.aiCtl = new AbortController();
  renderAi();
  try {
    const res = await sample.json(foodPrompt(text.trim()), { signal: ed.aiCtl.signal, modelTier: 'quick' });
    const items = (Array.isArray(res?.items) ? res.items : [])
      .map((it) => ({ name: String(it.name || ''), amount: String(it.amount || ''), kcal: Math.max(0, Math.round(Number(it.kcal) || 0)) }))
      .filter((it) => it.name);
    if (!items.length) throw { code: 'invalid_json' };
    d.ai = { items, total: items.reduce((s, it) => s + it.kcal, 0), note: String(res.note || ''), forText: text, by: 'app', at: new Date().toISOString() };
  } catch (e) {
    if (e?.code === 'not_granted' || e?.code === 'sampling_disabled') { sample = null; toast('AI 계산을 쓸 수 없어요. 새벽 자동 계산을 기다려 주세요.'); }
    else if (e?.code === 'rate_limited') toast('요청이 많아요. 잠시 후 다시 눌러 주세요.');
    else if (e?.code !== 'cancelled') toast('계산하지 못했어요. 음식 이름과 양을 조금 더 구체적으로 적어 보세요.');
  } finally {
    ed.aiCtl = null;
    if (editing === ed) syncEditor();
  }
});

/* 음식 목록 검색 */
$('foodSearch').addEventListener('input', () => {
  const q = $('foodSearch').value.trim().replace(/\s+/g, '');
  const hits = q ? FOODS.filter((f) => f.name.replace(/\s+/g, '').includes(q)).slice(0, 8) : [];
  $('foodResults').innerHTML = hits.map((f) =>
    `<button type="button" data-add="${esc(f.name)}" data-kcal="${f.kcal}">${esc(f.name)} <small>${f.kcal}</small></button>`).join('');
});

$('foodSearch').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  $('foodResults').querySelector('button')?.click();
});

$('foodResults').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-add]');
  if (!b) return;
  const d = editing.draft;
  const name = b.dataset.add, kcal = Number(b.dataset.kcal);
  const same = d.foods.find((f) => f.name === name);
  if (same) same.qty += 1; else d.foods.push({ name, kcal, qty: 1 });
  $('foodSearch').value = '';
  $('foodResults').innerHTML = '';
  syncEditor();
});

$('foodList').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-food]');
  if (!b) return;
  const d = editing.draft;
  const i = Number(b.dataset.food);
  if (b.dataset.remove !== undefined) d.foods.splice(i, 1);
  else d.foods[i].qty = Math.max(0.5, d.foods[i].qty + Number(b.dataset.step));
  syncEditor();
});

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  readTimes();
  const d = editing.draft;
  if (d.end <= d.start) { toast('종료 시간은 시작 시간보다 늦어야 해요.'); return; }
  editing.aiCtl?.abort();
  d.title = $('fTitle').value.trim();
  d.important = $('fImportant').checked;
  d.memo = $('fMemo').value.trim();
  d.toCal = $('fToCal').checked;
  // 앞뒤 공백만 다른 경우 AI 결과를 그대로 유지
  const text = d.type === 'meal' ? d.foodText.trim() : '';
  if (d.ai && d.ai.forText.trim() === text) d.ai.forText = text;
  d.foodText = text;
  if (!d.kcalManual) d.kcal = autoKcal(d);
  if (d.type !== 'exercise' && d.type !== 'meal') d.kcal = 0;

  const i = dayEntries.findIndex((e) => e.id === d.id);
  if (i >= 0) dayEntries[i] = d; else dayEntries.push(d);
  closeSheet('editorSheet');
  commitDay();
});

// 삭제는 두 번 눌러야 실행
let deleteArmed = null;
function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  $('deleteBtn').classList.remove('armed');
  $('deleteBtn').textContent = '이 기록 삭제';
}
$('deleteBtn').addEventListener('click', () => {
  if (!deleteArmed) {
    $('deleteBtn').classList.add('armed');
    $('deleteBtn').textContent = '한 번 더 누르면 삭제됩니다';
    deleteArmed = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  dayEntries = dayEntries.filter((e) => e.id !== editing.draft.id);
  closeSheet('editorSheet');
  commitDay();
  toast('삭제했어요.');
});

/* ---------- 루틴 ---------- */

function renderRoutines() {
  const list = [...routines].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  $('routineList').innerHTML = list.length ? list.map((r) => {
    const s = Math.min(...r.items.map((x) => x.start)), e = Math.max(...r.items.map((x) => x.end));
    return `<li>
      <div class="r-info"><b>${esc(r.name)}</b><small>${r.items.length}개 기록 · ${fmt(s)}–${fmt(e)}</small></div>
      <button type="button" class="primary-btn" data-apply="${r.id}">넣기</button>
      <button type="button" class="ghost-btn small" data-del="${r.id}">삭제</button>
    </li>`;
  }).join('') : '<li class="empty">저장된 루틴이 없어요. 하루를 기록한 뒤 아래에서 저장해 보세요.</li>';
  $('routineNote').textContent = dayEntries.length
    ? `보고 있는 날(${dayLabel(curDate)})의 기록 ${dayEntries.length}개를 저장합니다. 칼로리와 메모도 함께 저장돼요.`
    : '보고 있는 날에 기록이 없어요. 기록을 먼저 남겨 주세요.';
}

$('routineList').addEventListener('click', (ev) => {
  const apply = ev.target.closest('[data-apply]');
  const del = ev.target.closest('[data-del]');
  if (apply) {
    const r = routines.find((x) => x.id === apply.dataset.apply);
    if (!r) return;
    const added = r.items.map((x) => ({ ...structuredClone(x), id: uid() }));
    dayEntries = [...dayEntries, ...added];
    closeSheet('routineSheet');
    showTab('day');
    commitDay();
    toast(`'${r.name}' 루틴에서 ${added.length}개 기록을 넣었어요.`);
  } else if (del) {
    if (del.dataset.armed) {
      store.deleteRoutine(del.dataset.del).catch(saveFailed);
    } else {
      del.dataset.armed = '1';
      del.textContent = '확인';
      setTimeout(() => { delete del.dataset.armed; del.textContent = '삭제'; }, 3000);
    }
  }
});

$('routineForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('routineName').value.trim();
  if (!dayEntries.length) { toast('보고 있는 날에 기록이 없어요.'); return; }
  if (!name) { toast('루틴 이름을 적어 주세요.'); $('routineName').focus(); return; }
  const items = dayEntries.map(({ id, ...rest }) => structuredClone(rest));
  const existing = routines.find((r) => r.name === name);
  const r = { id: existing?.id || uid(), name, items, createdAt: existing?.createdAt || new Date().toISOString() };
  store.saveRoutine(r).then(() => toast(existing ? `'${name}' 루틴을 새로 덮어썼어요.` : `'${name}' 루틴을 저장했어요.`), saveFailed);
  $('routineName').value = '';
});

/* ---------- 설정 ---------- */

function openSettings() {
  const p = profile || { sex: 'm', age: '', height: '', weight: '', activity: 1.2, goals: {} };
  const g = p.goals || {};
  $('pSex').value = p.sex;
  $('pAge').value = p.age;
  $('pHeight').value = p.height;
  $('pWeight').value = p.weight;
  $('pActivity').value = String(p.activity);
  $('gIntake').value = g.intake || '';
  $('gExMin').value = g.exMinutes ?? 150;
  $('gExCount').value = g.exCount ?? 3;
  $('profileNote').hidden = !!profile;
  $('storageNote').textContent = store.mode === 'cloud'
    ? '기록은 claude.ai 계정에 저장돼요. 휴대폰과 PC에서 같은 기록을 봅니다.'
    : '지금은 이 브라우저에만 저장돼요. claude.ai에서 열면 계정에 저장되고 새벽 자동 계산도 동작합니다.';
  updateBmrPreview();
  openSheet('settingsSheet');
}

function readProfile() {
  return {
    sex: $('pSex').value,
    age: Number($('pAge').value),
    height: Number($('pHeight').value),
    weight: Number($('pWeight').value),
    activity: Number($('pActivity').value),
    goals: {
      intake: Number($('gIntake').value) || 0,
      exMinutes: Number($('gExMin').value) || 0,
      exCount: Number($('gExCount').value) || 0,
    },
  };
}

function suggestedIntake(p) {
  const b = bmr(p) * p.activity;
  return b ? Math.max(1200, Math.round((b - 500) / 50) * 50) : 0;
}

function updateBmrPreview() {
  const p = readProfile();
  if (!p.age || !p.height || !p.weight) { $('bmrPreview').textContent = ''; $('gSuggestNote').textContent = ''; return; }
  const b = bmr(p);
  $('bmrPreview').innerHTML = `기초대사량 <b>${num(b)}</b> kcal · 일상 활동 포함 <b>${num(b * p.activity)}</b> kcal/일`;
  $('gSuggestNote').textContent = `추천값 ${num(suggestedIntake(p))}kcal: 운동을 빼고 하루 소모량보다 500kcal 적게 먹는 기준이에요 (일주일에 약 0.5kg 감량).`;
}

['pSex', 'pAge', 'pHeight', 'pWeight', 'pActivity'].forEach((id) => $(id).addEventListener('input', updateBmrPreview));
$('gSuggest').addEventListener('click', () => {
  const v = suggestedIntake(readProfile());
  if (v) $('gIntake').value = v; else toast('나이, 키, 체중을 먼저 입력해 주세요.');
});

$('settings').addEventListener('submit', (ev) => {
  ev.preventDefault();
  profile = readProfile();
  closeSheet('settingsSheet');
  render();
  store.setProfile(profile).then(() => toast('저장했어요.'), saveFailed);
});

/* ---------- 통계 ---------- */

const stats = { range: 'week', anchor: null, days: [], sel: null };

function periodOf() {
  if (stats.range === 'week') {
    const from = weekStart(stats.anchor);
    return { from, to: addDays(from, 6) };
  }
  const d = parseDate(stats.anchor);
  return {
    from: dateStr(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: dateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

function shiftPeriod(dir) {
  if (stats.range === 'week') stats.anchor = addDays(stats.anchor, dir * 7);
  else { const d = parseDate(stats.anchor); stats.anchor = dateStr(new Date(d.getFullYear(), d.getMonth() + dir, 1)); }
  loadStats();
}

async function loadStats() {
  const { from, to } = periodOf();
  const f = parseDate(from), t = parseDate(to);
  $('periodLabel').textContent = stats.range === 'week'
    ? `${f.getMonth() + 1}.${f.getDate()} – ${t.getMonth() + 1}.${t.getDate()}`
    : `${f.getFullYear()}년 ${f.getMonth() + 1}월`;
  stats.sel = null;
  let docs = [];
  try { docs = await store.rangeDays(from, to); } catch (e) { toast('통계를 불러오지 못했어요.'); }
  const byDate = new Map(docs.map((d) => [d.date, d.entries || []]));
  if (curDate >= from && curDate <= to) byDate.set(curDate, dayEntries);
  stats.days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const entries = byDate.get(d) || [];
    stats.days.push({ date: d, has: entries.length > 0, ...dayTotals(entries) });
  }
  renderStats();
}

function renderStats() {
  const days = stats.days;
  const rec = days.filter((d) => d.has);
  const goal = profile?.goals?.intake || 0;
  const avg = (k) => (rec.length ? rec.reduce((s, d) => s + d[k], 0) / rec.length : 0);
  const exMin = days.reduce((s, d) => s + d.exMin, 0), exCnt = days.reduce((s, d) => s + d.exCount, 0);
  const met = goal ? rec.filter((d) => d.intake > 0 && d.intake <= goal).length : 0;
  const net = avg('intake') - avg('burn');
  $('statTiles').innerHTML = [
    ['평균 섭취', num(avg('intake')), `kcal · 기록한 ${rec.length}일 기준`],
    ['평균 소모', num(avg('burn')), 'kcal'],
    ['평균 차이', (net > 0 ? '+' : '') + num(net), net > 0 ? 'kcal 초과' : 'kcal 부족'],
    ['운동', `${num(exMin)}분`, `${exCnt}회`],
    ...(goal ? [['섭취 목표 지킨 날', `${met}일`, `기록한 ${rec.length}일 중 · 목표 ${num(goal)}kcal`]] : []),
  ].map(([l, v, s]) => `<div class="tile"><span>${l}</span><b>${v}</b><small>${s}</small></div>`).join('');

  $('goalLegend').hidden = !goal;
  $('chartKcal').innerHTML = barChart(days, [{ key: 'intake', cls: 'm-in' }, { key: 'burn', cls: 'm-out' }], goal);
  $('chartEx').innerHTML = barChart(days, [{ key: 'exMin', cls: 'm-ex' }], 0);
  updateTips();

  $('statsTable').innerHTML = '<thead><tr><th>날짜</th><th>섭취</th><th>소모</th><th>차이</th><th>운동(분)</th></tr></thead><tbody>' +
    (rec.length ? rec.map((d) =>
      `<tr><td>${dayLabel(d.date)}</td><td>${num(d.intake)}</td><td>${num(d.burn)}</td><td>${num(d.intake - d.burn)}</td><td>${d.exMin}</td></tr>`).join('')
      : '<tr><td colspan="5">이 기간에는 기록이 없어요.</td></tr>') + '</tbody>';
}

// 눈금 간격을 1·2·5 단위의 보기 좋은 수로
function niceStep(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}

// 하루 단위 막대 차트 (계열 1~2개). 칸 전체가 누르는 영역.
function barChart(days, series, goal) {
  const W = 340, H = 170, L = 40, R = 6, T = 8, B = 22;
  const pw = W - L - R, ph = H - T - B;
  const top = Math.max(goal * 1.05, ...days.flatMap((d) => (d.has ? series.map((s) => d[s.key]) : [0])));
  const step = niceStep(top / 4);
  const ticks = Math.max(1, Math.ceil(top / step));
  const vmax = step * ticks;
  const y = (v) => T + ph - (v / vmax) * ph;
  const slot = pw / days.length;
  const gap = series.length > 1 ? 2 : 0;
  const bw = Math.max(1.5, Math.min(18, (slot * 0.7 - gap * (series.length - 1)) / series.length));
  const base = T + ph;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="날짜별 막대 차트">`;
  for (let i = 0; i <= ticks; i++) {
    const v = step * i;
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${num(v)}</text>`;
  }
  const every = days.length > 10 ? 5 : 1;
  days.forEach((d, i) => {
    const x0 = L + i * slot;
    svg += `<rect class="hit${stats.sel === i ? ' sel' : ''}" data-i="${i}" x="${x0}" y="${T}" width="${slot}" height="${ph}"/>`;
    if (d.has) {
      const groupW = bw * series.length + gap * (series.length - 1);
      series.forEach((s, k) => {
        const v = d[s.key];
        if (!v) return;
        const top = Math.min(base - 1, y(v));
        const x = x0 + (slot - groupW) / 2 + k * (bw + gap);
        const r = Math.min(3, bw / 2, base - top);
        // 위쪽만 둥근 막대
        svg += `<path class="${s.cls}" pointer-events="none" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z"/>`;
      });
    }
    const dt = parseDate(d.date);
    if (stats.range === 'week') {
      svg += `<text x="${x0 + slot / 2}" y="${H - 6}" text-anchor="middle">${WD[dt.getDay()]}</text>`;
    } else if ((dt.getDate() - 1) % every === 0) {
      svg += `<text x="${x0 + slot / 2}" y="${H - 6}" text-anchor="middle">${dt.getDate()}</text>`;
    }
  });
  if (goal) svg += `<line class="goal-line" pointer-events="none" x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}"/>`;
  return svg + '</svg>';
}

function updateTips() {
  const d = stats.sel != null ? stats.days[stats.sel] : null;
  const hint = '막대를 누르면 그날 수치가 보여요';
  if (!d) { $('tipKcal').textContent = hint; $('tipEx').textContent = hint; return; }
  const label = dayLabel(d.date);
  if (!d.has) { $('tipKcal').textContent = `${label} 기록 없음`; $('tipEx').textContent = `${label} 기록 없음`; return; }
  $('tipKcal').innerHTML = `${label} · 섭취 <b>${num(d.intake)}</b> · 소모 <b>${num(d.burn)}</b> · 차이 <b>${num(d.intake - d.burn)}</b> kcal`;
  $('tipEx').innerHTML = `${label} · 운동 <b>${d.exMin}</b>분 · ${d.exCount}회 · <b>${num(d.exBurn)}</b> kcal`;
}

['chartKcal', 'chartEx'].forEach((id) => $(id).addEventListener('click', (ev) => {
  const r = ev.target.closest('.hit');
  if (!r) return;
  const i = Number(r.dataset.i);
  stats.sel = stats.sel === i ? null : i;
  document.querySelectorAll('.chart .hit').forEach((h) => h.classList.toggle('sel', Number(h.dataset.i) === stats.sel));
  updateTips();
}));

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  stats.range = b.dataset.range;
  loadStats();
}));
$('prevPeriod').addEventListener('click', () => shiftPeriod(-1));
$('nextPeriod').addEventListener('click', () => shiftPeriod(1));

/* ---------- 탭과 상단 버튼 ---------- */

let tab = 'day';
function showTab(name) {
  if (name === 'routines') { renderRoutines(); openSheet('routineSheet'); return; }
  if (name === 'settings') { openSettings(); return; }
  tab = name;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('dayView').hidden = name !== 'day';
  $('statsView').hidden = name !== 'stats';
  document.querySelector('.topbar').hidden = name !== 'day';
  if (name === 'stats') { stats.anchor = curDate; loadStats(); }
  else loadWeek();
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

$('prevDay').addEventListener('click', () => goTo(addDays(curDate, -1)));
$('nextDay').addEventListener('click', () => goTo(addDays(curDate, 1)));
$('todayBtn').addEventListener('click', () => goTo(today()));
$('datePicker').addEventListener('change', () => { if ($('datePicker').value) goTo($('datePicker').value); });
$('fab').addEventListener('click', () => {
  const base = curDate === today() ? nowMinutes() : Math.round((scroller.scrollTop / PXM + 60) / 30) * 30;
  newEntryAt(Math.floor(base / SNAP) * SNAP);
});
$('importantBar').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-id]');
  const e = b && findEntry(b.dataset.id);
  if (e) scroller.scrollTo({ top: Math.max(0, (e.start - 60) * PXM), behavior: 'smooth' });
});

/* ---------- 시작 ---------- */

async function boot() {
  buildGrid();
  let db = null;
  if (window.claude && typeof window.claude.use === 'function') {
    db = await window.claude.use('db').catch(() => null);
    window.claude.use('sample').then((s) => { sample = s; }).catch(() => {});
  }
  store = db ? Store.remote(db) : Store.local();

  let firstProfile = true;
  store.watchProfile((p) => {
    profile = p;
    if (tab === 'stats') renderStats(); else renderSummary();
    if (firstProfile) { firstProfile = false; if (!p) openSettings(); }
  });
  store.watchRoutines((list) => { routines = list; if (!$('routineSheet').hidden) renderRoutines(); });
  goTo(today());

  setInterval(renderNow, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    // 앱으로 돌아왔을 때 '오늘' 표시와 현재 시각 선을 갱신
    if (document.visibilityState === 'visible') { renderHeader(); renderNow(); }
  });
}

boot();
