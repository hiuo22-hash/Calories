'use strict';

// 저장소 두 가지를 같은 모양으로 감쌈
// - cloud: claude.ai 아티팩트 데이터베이스 (기기 간 공유, 새벽 자동 계산이 읽고 씀)
// - local: 이 브라우저에만 저장 (claude.ai 밖에서 열었을 때)
//
// 문서 구조 (cloud)
//   days/<YYYY-MM-DD>   { date, entries: [...], updatedAt }
//   settings/profile    { sex, age, height, weight, activity, goals: { intake, exMinutes, exCount } }
//   routines/<id>       { name, items: [...], createdAt }
const Store = (() => {
  // 같은 문서에는 한 번에 하나씩만 쓰기
  const queues = new Map();
  function serial(key, fn) {
    const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
    queues.set(key, next.catch(() => {}));
    return next;
  }

  const clone = (v) => (v == null ? v : structuredClone(v));

  function remote(db) {
    return {
      mode: 'cloud',
      watchDay(date, cb, onError) {
        return db.doc('days/' + date).onSnapshot(
          (s) => cb(s.exists ? clone(s.data().entries || []) : []), onError);
      },
      setDay(date, entries) {
        const ref = db.doc('days/' + date);
        const body = { date, entries: clone(entries), updatedAt: new Date().toISOString() };
        return serial(ref.path, () => (entries.length ? ref.set(body) : ref.delete()));
      },
      watchProfile(cb, onError) {
        return db.doc('settings/profile').onSnapshot((s) => cb(s.exists ? clone(s.data()) : null), onError);
      },
      setProfile(p) {
        const ref = db.doc('settings/profile');
        return serial(ref.path, () => ref.set(clone(p)));
      },
      watchRoutines(cb, onError) {
        return db.collection('routines').onSnapshot(
          (q) => cb(q.docs.map((d) => ({ ...clone(d.data()), id: d.id }))), onError);
      },
      saveRoutine(r) {
        const ref = db.doc('routines/' + r.id);
        return serial(ref.path, () => ref.set(clone(r)));
      },
      deleteRoutine(id) {
        const ref = db.doc('routines/' + id);
        return serial(ref.path, () => ref.delete());
      },
      async rangeDays(from, to) {
        const q = await db.collection('days').where('date', '>=', from).where('date', '<=', to).get();
        return q.docs.map((d) => clone(d.data()));
      },
    };
  }

  function local() {
    const KEY = 'daylog.v2';
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* 저장소 사용 불가 */ }
    if (!s || typeof s.days !== 'object') s = { days: {}, profile: null, routines: {} };
    const subs = new Set();
    const persist = () => {
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 메모리에만 유지 */ }
      subs.forEach((f) => f());
    };
    const watch = (read, cb) => {
      const f = () => cb(clone(read()));
      subs.add(f);
      setTimeout(f, 0);
      return () => subs.delete(f);
    };
    return {
      mode: 'local',
      watchDay: (date, cb) => watch(() => s.days[date]?.entries || [], cb),
      async setDay(date, entries) {
        if (entries.length) s.days[date] = { date, entries: clone(entries) }; else delete s.days[date];
        persist();
      },
      watchProfile: (cb) => watch(() => s.profile, cb),
      async setProfile(p) { s.profile = clone(p); persist(); },
      watchRoutines: (cb) => watch(() => Object.values(s.routines), cb),
      async saveRoutine(r) { s.routines[r.id] = clone(r); persist(); },
      async deleteRoutine(id) { delete s.routines[id]; persist(); },
      async rangeDays(from, to) {
        return clone(Object.values(s.days).filter((d) => d.date >= from && d.date <= to));
      },
    };
  }

  return { remote, local };
})();
