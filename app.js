'use strict';

const STORE_KEY = 'daylog.v1';
const HOUR_PX = 64;            // 1시간 높이(px)
const PXM = HOUR_PX / 60;      // 1분당 px
const SNAP = 5;                // 드래그 시 5분 단위로 맞춤
const DAY = 1440;
const MIN_DUR = 10;
const LONG_PRESS_MS = 300;

const TYPES = {
  daily: { label: '일상', icon: '📝' },
  exercise: { label: '운동', icon: '🏃' },
  meal: { label: '식사', icon: '🍚' },
  event: { label: '일정', icon: '📅' },
};

const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const eventsEl = $('events');

let state = load();
let curDate;          // 'YYYY-MM-DD'
let editing = null;   // { isNew, draft }
let drag = null;

/* ---------- 저장소 ---------- */

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.entries) return s;
  } catch (e) { /* 비어 있거나 손상됨 */ }
  return { profile: null, entries: {} };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    alert('저장에 실패했어요: ' + e.message);
  }
}

function entriesOf(date) { return state.entries[date] || []; }

function findEntry(id) { return entriesOf(curDate).find((e) => e.id === id); }

/* ---------- 유틸 ---------- */

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.round(n).toLocaleString('ko-KR');

function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }

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

/* ---------- 칼로리 ---------- */

function weight() { return state.profile?.weight || 65; }

function bmr(p) {
  if (!p) return 0;
  // Mifflin-St Jeor 공식
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
  return p.sex === 'f' ? base - 161 : base + 5;
}

function exerciseOf(key) { return EXERCISES.find((x) => x.key === key) || EXERCISES[0]; }

function autoKcal(e) {
  if (e.type === 'exercise') return Math.round(exerciseOf(e.exercise).met * weight() * (e.end - e.start) / 60);
  if (e.type === 'meal') return Math.round(e.foods.reduce((s, f) => s + f.kcal * f.qty, 0));
  return 0;
}

function entryTitle(e) {
  if (e.title) return e.title;
  if (e.type === 'exercise') return exerciseOf(e.exercise).name;
  if (e.type === 'meal' && e.foods.length) return e.foods.map((f) => f.name.replace(/\s*\(.*\)$/, '')).join(', ');
  return TYPES[e.type].label;
}

/* ---------- 화면 그리기 ---------- */

function buildGrid() {
  const grid = $('grid');
  $('timeline').style.height = `${24 * HOUR_PX}px`;
  let html = '';
  for (let h = 0; h <= 24; h++) {
    html += `<div class="hour" style="top:${h * HOUR_PX}px"><span>${h < 24 ? pad(h) + ':00' : ''}</span></div>`;
    if (h < 24) html += `<div class="half" style="top:${h * HOUR_PX + HOUR_PX / 2}px"></div>`;
  }
  grid.innerHTML = html;
}

function render() {
  renderHeader();
  renderSummary();
  renderEvents();
  renderNow();
}

function renderHeader() {
  const d = parseDate(curDate);
  const wd = '일월화수목금토'[d.getDay()];
  const isToday = curDate === dateStr(new Date());
  $('dateLabel').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})${isToday ? ' · 오늘' : ''}`;
  $('datePicker').value = curDate;
  $('todayBtn').hidden = isToday;
}

function renderSummary() {
  const list = entriesOf(curDate);
  const intake = list.filter((e) => e.type === 'meal').reduce((s, e) => s + (e.kcal || 0), 0);
  const exBurn = list.filter((e) => e.type === 'exercise').reduce((s, e) => s + (e.kcal || 0), 0);
  const p = state.profile;
  const base = p ? Math.round(bmr(p) * (p.activity || 1)) : 0;
  const burn = base + exBurn;
  const net = intake - burn;

  $('sumIn').textContent = num(intake);
  $('sumOut').textContent = num(burn);
  $('sumOutDetail').textContent = p ? `기초 ${num(base)} + 운동 ${num(exBurn)}` : '내 정보 입력 필요';
  $('sumNet').textContent = (net > 0 ? '+' : '') + num(net);
  $('sumNetNote').textContent = net > 0 ? '초과 섭취' : net < 0 ? '부족 (감량 방향)' : '균형';
  $('summary').classList.toggle('over', net > 0);

  const important = list.filter((e) => e.important).sort((a, b) => a.start - b.start);
  const bar = $('importantBar');
  bar.hidden = !important.length;
  bar.innerHTML = important.map((e) =>
    `<button data-id="${e.id}">⭐ ${fmt(e.start)} ${esc(entryTitle(e))}</button>`).join('');
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

function kcalText(e) {
  if (e.type === 'meal' && e.kcal) return ` · +${num(e.kcal)}kcal`;
  if (e.type === 'exercise' && e.kcal) return ` · −${num(e.kcal)}kcal`;
  return '';
}

function placeEvent(el, e, pos) {
  el.style.top = `${e.start * PXM}px`;
  el.style.height = `${Math.max((e.end - e.start) * PXM - 2, 22)}px`;
  if (pos) {
    el.style.left = `calc(${(pos.col / pos.n) * 100}% + 1px)`;
    el.style.width = `calc(${100 / pos.n}% - 3px)`;
  }
  el.querySelector('.ev-meta').textContent = `${fmt(e.start)}–${fmt(e.end)}${kcalText(e)}`;
  el.classList.toggle('short', e.end - e.start < 40);
}

function renderEvents() {
  const list = entriesOf(curDate);
  const lay = layout(list);
  eventsEl.innerHTML = '';
  for (const e of list) {
    const el = document.createElement('div');
    el.className = `ev t-${e.type}${e.important ? ' important' : ''}`;
    el.dataset.id = e.id;
    el.innerHTML =
      `<div class="ev-title">${e.important ? '⭐ ' : ''}${TYPES[e.type].icon} ${esc(entryTitle(e))}</div>` +
      `<div class="ev-meta"></div><div class="handle" aria-label="길이 조절"></div>`;
    placeEvent(el, e, lay.get(e.id));
    eventsEl.append(el);
  }
}

function renderNow() {
  const line = $('nowLine');
  const isToday = curDate === dateStr(new Date());
  line.hidden = !isToday;
  if (isToday) line.style.top = `${nowMinutes() * PXM}px`;
}

function scrollToDefault() {
  const isToday = curDate === dateStr(new Date());
  const list = entriesOf(curDate);
  let target = isToday ? nowMinutes() - 90 : list.length ? Math.min(...list.map((e) => e.start)) - 30 : 7 * 60;
  scroller.scrollTop = Math.max(0, target * PXM);
}

function goTo(date) {
  curDate = date;
  render();
  scrollToDefault();
}

/* ---------- 드래그로 시간 조정 ---------- */
// 블록을 꾹 누르면(롱프레스) 이동, 아래쪽 손잡이를 끌면 길이 조절.
// 짧게 탭하면 편집 화면이 열림.

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
  if (v) {
    scroller.scrollTop += v;
    updateDrag();
  }
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
  const moved = d.entry.start !== d.orig.start || d.entry.end !== d.orig.end;
  if (moved) {
    save();
    render();
  } else {
    d.el.classList.remove('dragging');
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
  const min = Math.floor(ev.offsetY / PXM / 30) * 30;
  newEntryAt(min);
});

function newEntryAt(start) {
  start = clamp(start, 0, DAY - 30);
  openEditor({
    id: uid(), type: 'daily', title: '', start, end: Math.min(start + 60, DAY),
    important: false, memo: '', toCal: false,
    exercise: EXERCISES[0].key, foods: [], kcal: 0, kcalManual: false,
  }, true);
}

/* ---------- 편집 화면 ---------- */

const form = $('editor');

function openSheet(id) {
  $(id).hidden = false;
  document.body.classList.add('modal-open');
}

function closeSheet(id) {
  $(id).hidden = true;
  document.body.classList.remove('modal-open');
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => closeSheet(b.closest('.backdrop').id)));
document.querySelectorAll('.backdrop').forEach((bd) =>
  bd.addEventListener('click', (ev) => { if (ev.target === bd) closeSheet(bd.id); }));

$('fExercise').innerHTML = EXERCISES.map((x) => `<option value="${x.key}">${esc(x.name)}</option>`).join('');

function openEditor(entry, isNew) {
  editing = { isNew, draft: structuredClone(entry) };
  const d = editing.draft;
  d.foods = d.foods || [];
  $('editorTitle').textContent = isNew ? '새 기록' : '기록 수정';
  $('fTitle').value = d.title;
  $('fStart').value = toTimeInput(d.start);
  $('fEnd').value = toTimeInput(d.end);
  $('fImportant').checked = !!d.important;
  $('fExercise').value = d.exercise || EXERCISES[0].key;
  $('fMemo').value = d.memo || '';
  $('fToCal').checked = !!d.toCal;
  $('foodSearch').value = '';
  $('foodResults').innerHTML = '';
  $('deleteBtn').hidden = isNew;
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
  document.querySelectorAll('#typeChips button').forEach((b) =>
    b.classList.toggle('on', b.dataset.type === d.type));
  form.dataset.type = d.type;
  $('fDuration').textContent = d.end > d.start ? `총 ${durationText(d.end - d.start)}` : '종료 시간이 시작보다 늦어야 해요';
  $('fDuration').classList.toggle('error', d.end <= d.start);

  const ex = exerciseOf(d.exercise);
  $('metNote').textContent = `운동 강도 ${ex.met} MET × 체중 ${weight()}kg × ${durationText(Math.max(0, d.end - d.start))}`;

  $('foodList').innerHTML = d.foods.map((f, i) => `
    <li>
      <span class="food-name">${esc(f.name)}</span>
      <span class="qty">
        <button type="button" data-food="${i}" data-step="-0.5">−</button>
        <b>${f.qty}</b>
        <button type="button" data-food="${i}" data-step="0.5">+</button>
      </span>
      <span class="food-kcal">${num(f.kcal * f.qty)}</span>
      <button type="button" class="remove" data-food="${i}" data-remove>×</button>
    </li>`).join('');

  $('kcalBox').hidden = !(d.type === 'exercise' || d.type === 'meal');
  $('kcalLabel').textContent = d.type === 'meal' ? '섭취 칼로리 (kcal)' : '소모 칼로리 (kcal)';
  if (!d.kcalManual) d.kcal = autoKcal(d);
  $('fKcal').value = d.kcal;
  $('kcalAuto').hidden = !d.kcalManual;
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
$('fKcal').addEventListener('input', () => {
  editing.draft.kcalManual = true;
  editing.draft.kcal = Math.max(0, Number($('fKcal').value) || 0);
  $('kcalAuto').hidden = false;
});
$('kcalAuto').addEventListener('click', () => { editing.draft.kcalManual = false; syncEditor(); });

/* 음식 검색 */
$('foodSearch').addEventListener('input', () => {
  const q = $('foodSearch').value.trim().replace(/\s+/g, '');
  if (!q) { $('foodResults').innerHTML = ''; return; }
  const hits = FOODS.filter((f) => f.name.replace(/\s+/g, '').includes(q)).slice(0, 8);
  $('foodResults').innerHTML =
    hits.map((f) => `<button type="button" data-add="${esc(f.name)}" data-kcal="${f.kcal}">${esc(f.name)} <small>${f.kcal}kcal</small></button>`).join('') +
    `<button type="button" class="custom" data-custom>＋ '${esc($('foodSearch').value.trim())}' 직접 입력</button>`;
});

$('foodSearch').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const first = $('foodResults').querySelector('button');
  if (first) first.click();
});

function addFood(name, kcal) {
  const d = editing.draft;
  const same = d.foods.find((f) => f.name === name && f.kcal === kcal);
  if (same) same.qty += 1; else d.foods.push({ name, kcal, qty: 1 });
  $('foodSearch').value = '';
  $('foodResults').innerHTML = '';
  syncEditor();
}

$('foodResults').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.custom !== undefined) {
    const name = $('foodSearch').value.trim();
    const kcal = Number(prompt(`'${name}' 1인분의 칼로리(kcal)를 입력하세요`, ''));
    if (name && Number.isFinite(kcal) && kcal >= 0) addFood(name, Math.round(kcal));
  } else {
    addFood(b.dataset.add, Number(b.dataset.kcal));
  }
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
  if (d.end <= d.start) { alert('종료 시간은 시작 시간보다 늦어야 해요.'); return; }
  d.title = $('fTitle').value.trim();
  d.important = $('fImportant').checked;
  d.memo = $('fMemo').value.trim();
  d.toCal = $('fToCal').checked;
  if (!d.kcalManual) d.kcal = autoKcal(d);
  if (d.type !== 'exercise' && d.type !== 'meal') d.kcal = 0;

  const list = state.entries[curDate] || (state.entries[curDate] = []);
  const i = list.findIndex((e) => e.id === d.id);
  if (i >= 0) list[i] = d; else list.push(d);
  save();
  closeSheet('editorSheet');
  render();
});

$('deleteBtn').addEventListener('click', () => {
  if (!confirm('이 기록을 삭제할까요?')) return;
  const list = entriesOf(curDate);
  const i = list.findIndex((e) => e.id === editing.draft.id);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete state.entries[curDate];
  save();
  closeSheet('editorSheet');
  render();
});

/* ---------- 설정 ---------- */

function openSettings() {
  const p = state.profile || { sex: 'm', age: '', height: '', weight: '', activity: 1.2 };
  $('pSex').value = p.sex;
  $('pAge').value = p.age;
  $('pHeight').value = p.height;
  $('pWeight').value = p.weight;
  $('pActivity').value = String(p.activity);
  $('profileNote').hidden = !!state.profile;
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
  };
}

function updateBmrPreview() {
  const p = readProfile();
  if (!p.age || !p.height || !p.weight) { $('bmrPreview').textContent = ''; return; }
  const b = bmr(p);
  $('bmrPreview').innerHTML = `기초대사량 <b>${num(b)}</b> kcal · 일상 활동 포함 <b>${num(b * p.activity)}</b> kcal/일`;
}

['pSex', 'pAge', 'pHeight', 'pWeight', 'pActivity'].forEach((id) => $(id).addEventListener('input', updateBmrPreview));

$('settings').addEventListener('submit', (ev) => {
  ev.preventDefault();
  state.profile = readProfile();
  save();
  closeSheet('settingsSheet');
  render();
});

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `하루기록-백업-${dateStr(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.entries !== 'object') throw new Error('형식이 올바르지 않아요');
    if (!confirm('지금 기록을 백업 파일 내용으로 바꿀까요?')) return;
    state = data;
    save();
    closeSheet('settingsSheet');
    render();
  } catch (e) {
    alert('불러오기에 실패했어요: ' + e.message);
  }
});

/* ---------- 상단 버튼 ---------- */

$('prevDay').addEventListener('click', () => goTo(addDays(curDate, -1)));
$('nextDay').addEventListener('click', () => goTo(addDays(curDate, 1)));
$('todayBtn').addEventListener('click', () => goTo(dateStr(new Date())));
$('datePicker').addEventListener('change', () => { if ($('datePicker').value) goTo($('datePicker').value); });
$('settingsBtn').addEventListener('click', openSettings);
$('fab').addEventListener('click', () => {
  const isToday = curDate === dateStr(new Date());
  const base = isToday ? nowMinutes() : Math.round((scroller.scrollTop / PXM + 60) / 30) * 30;
  newEntryAt(Math.floor(base / SNAP) * SNAP);
});
$('importantBar').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-id]');
  const e = b && findEntry(b.dataset.id);
  if (!e) return;
  scroller.scrollTo({ top: Math.max(0, (e.start - 60) * PXM), behavior: 'smooth' });
});

/* ---------- 시작 ---------- */

buildGrid();
goTo(dateStr(new Date()));
setInterval(renderNow, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  // 앱으로 돌아왔을 때 '오늘' 표시와 현재 시각 선을 갱신
  if (document.visibilityState === 'visible') { renderHeader(); renderNow(); }
});
if (!state.profile) openSettings();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
