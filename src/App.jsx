import React, { useEffect, useMemo, useState } from "react";
import JapaneseHolidays from "japanese-holidays";

// 追加対応（昼夜で必要人数を別々に指定）
// - 各日について「昼の必要人数」「夜の必要人数」を個別に設定可能
// - その日のモード（昼/夜）で、対応する必要人数がスケジューラ＆不足判定に反映
// - モードを切り替えても数値は保持（昼用・夜用を両方保存）
// - 既存機能：カレンダー表示、タブ編集、必要人数最優先、保存＆復元、不足ハイライト、曜日表示

/** 型の目安
 * Slot: { id: string, label: string, required: number, iso: string, mode: '昼'|'夜' }
 * Member: { name: string, availability: Set<string>, desired_days: number, preferred_slots: Set<string> }
 */

// ===== スケジューラ（必要人数優先 2パス方式） =====
function computeSatisfaction(member, assigned) {
  if (member.desired_days <= 0) {
    return member.preferred_slots.size === 0
      ? 1
      : setIntersect(new Set(assigned), member.preferred_slots).size /
          Math.max(1, member.preferred_slots.size);
  }
  const coverRatio = Math.min(1, assigned.length / member.desired_days);
  if (member.preferred_slots && member.preferred_slots.size > 0) {
    const preferredAssigned = setIntersect(new Set(assigned), member.preferred_slots).size;
    const denom = Math.max(1, Math.min(member.desired_days, member.preferred_slots.size));
    const prefRatio = preferredAssigned / denom;
    return 0.5 * coverRatio + 0.5 * prefRatio;
  }
  return coverRatio;
}

function greedySchedule(members, slots, seed = 0, balanceBias = 0.6) {
  const rng = mulberry32(seed);
  const bySlot = Object.fromEntries(slots.map((s) => [s.id, []]));
  const byMember = Object.fromEntries(members.map((m) => [m.name, []]));

  const order = [...slots];
  shuffle(order, rng);

  const candidateScore = (member, slotId) => {
    if (!member.availability.has(slotId)) return -1e9;
    const prefBonus = member.preferred_slots.has(slotId) ? 0.25 : 0;
    const deficit = Math.max(0, member.desired_days - byMember[member.name].length);
    const fairness = balanceBias * (deficit / Math.max(1, member.desired_days));
    const loadPenalty = 0.05 * byMember[member.name].length;
    return prefBonus + fairness - loadPenalty + rng();
  };

  for (const slot of order) {
    let needed = slot.required;
    const candidates = members
      .filter((m) => m.availability.has(slot.id))
      .sort((a, b) => candidateScore(b, slot.id) - candidateScore(a, slot.id));

    // パス1: 希望日数(+1のゆるい上限)を尊重
    for (const m of candidates) {
      if (needed <= 0) break;
      if (byMember[m.name].length >= Math.max(1, m.desired_days + 1)) continue;
      bySlot[slot.id].push(m.name);
      byMember[m.name].push(slot.id);
      needed -= 1;
    }
    // パス2: まだ足りなければ上限を外してでも充足（必要人数最優先）
    if (needed > 0) {
      for (const m of candidates) {
        if (needed <= 0) break;
        if (bySlot[slot.id].includes(m.name)) continue; // 既に入っていればスキップ
        bySlot[slot.id].push(m.name);
        byMember[m.name].push(slot.id);
        needed -= 1;
      }
    }
  }

  const satisfaction = {};
  let total = 0;
  for (const m of members) {
    const s = computeSatisfaction(m, byMember[m.name]);
    satisfaction[m.name] = s;
    total += s;
  }
  const vals = Object.values(satisfaction);
  const minSat = vals.length ? Math.min(...vals) : 1;
  const avgSat = vals.length ? total / members.length : 1;
  const score = 0.4 * minSat + 0.6 * avgSat;
  return { bySlot, byMember, satisfaction, score };
}

function generateCandidates(members, slots, n = 5, minSatisfaction = 0.7) {
  const results = [];
  let seed = 0, tried = 0;
  while (results.length < n && tried < n * 30) {
    const bias = 0.4 + 0.4 * ((seed % 10) / 9 || 0);
    const assn = greedySchedule(members, slots, seed, bias);
    const minSat = Math.min(...Object.values(assn.satisfaction));
    if (!Number.isNaN(minSat) && minSat >= minSatisfaction) {
      const sig = JSON.stringify(
        Object.fromEntries(Object.entries(assn.bySlot).map(([k, v]) => [k, [...v].sort()]))
      );
      if (!results.some((r) => r.__sig === sig)) {
        assn.__sig = sig;
        results.push(assn);
      }
    }
    seed += 1; tried += 1;
  }
  return results.sort((a, b) => b.score - a.score);
}

// ===== ヘルパ =====
function setIntersect(a, b) { const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out; }
function shuffle(arr, rng) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }
function mulberry32(a) { return function() { let t=(a+=0x6d2b79f5); t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function periodKey(year, month, half) { return `${year}-${String(month).padStart(2,"0")}-${half}`; }
function weekdayJ(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const w = new Date(y, m-1, d).getDay();
  return ['日','月','火','水','木','金','土'][w];
}

// 日本の祝日判定（ライブラリ利用） & 色決定
function isHolidayISO(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const date = new Date(y, m-1, d);
  return !!JapaneseHolidays.isHoliday(date);
}
function weekendHolidayBg(iso, periodMode) {
  const [y,m,d] = iso.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const dow = date.getDay();
  if (JapaneseHolidays.isHoliday(date) || dow === 0) return '#FFE4E6'; // 祝日・日曜: 薄赤
  if (dow === 6) return '#DBEAFE'; // 土曜: 薄青
  return periodMode === '昼' ? '#FFFBEB' : '#EEF2FF'; // 平日: 期間モード色
}

// ===== 永続化（ローカルストレージ） =====
const LS_KEY = 'shift-scheduler-demo/state/v5'; // v5: 初期メンバー刷新（Aoi/Bea/Chen → 指定10名） // v4: reqDay/reqNight へ移行
function saveState(state) {
  try {
    const plain = {
      ...state,
      members: state.members.map(m => ({
        ...m,
        availability: Array.from(m.availability || []),
        preferred_slots: Array.from(m.preferred_slots || []),
      })),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(plain));
  } catch {}
}
function loadState() {
  try {
    const txt = localStorage.getItem(LS_KEY);
    if (!txt) return null;
    const s = JSON.parse(txt);
    s.members = (s.members || []).map(m => ({
      ...m,
      availability: new Set(m.availability || []),
      preferred_slots: new Set(m.preferred_slots || []),
    }));
    return s;
  } catch { return null; }
}

// ===== アプリ本体 =====
export default function ShiftSchedulerApp() {
  const persisted = loadState();
  const today = new Date();
  const [year, setYear] = useState(persisted?.year ?? today.getFullYear());
  const [month, setMonth] = useState(persisted?.month ?? (today.getMonth() + 1));
  const [half, setHalf] = useState(persisted?.half ?? 'H1');
  // periodConfigs[key] = { modes: {iso:'昼|夜'}, reqDay: {iso:number}, reqNight: {iso:number} }
  const [periodConfigs, setPeriodConfigs] = useState(persisted?.periodConfigs ?? {});
  const [members, setMembers] = useState(persisted?.members ?? [
    { name: "栄嶋", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "せりな", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "ここあ", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "安井", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "松原", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "高村", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "田村", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "坂ノ下", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "鈴木", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "吉村", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
    { name: "小原", availability: new Set(), desired_days: 2, preferred_slots: new Set() },
  ]);
  const [minSat, setMinSat] = useState(persisted?.minSat ?? 0.7);
  const [numCandidates, setNumCandidates] = useState(persisted?.numCandidates ?? 3);

  // 状態の永続化
  useEffect(() => {
    saveState({ year, month, half, periodConfigs, members, minSat, numCandidates });
  }, [year, month, half, periodConfigs, members, minSat, numCandidates]);

  // 期間の欠損日を毎回デフォルトで埋める（初期化安定 & 旧データ移行）
  useEffect(() => {
    const key = periodKey(year, month, half);
    setPeriodConfigs((prev) => {
      const dmax = daysInMonth(year, month);
      const start = half === 'H1' ? 1 : 16;
      const end = half === 'H1' ? Math.min(15, dmax) : dmax;
      const defaultsModes = {};
      const defaultsReqDay = {};
      const defaultsReqNight = {};
      for (let d = start; d <= end; d++) {
        const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        defaultsModes[iso] = '昼';
        defaultsReqDay[iso] = 1;
        defaultsReqNight[iso] = 1;
      }
      const cur = prev[key] || { modes: {}, reqs: {}, reqDay: {}, reqNight: {} };
      // 旧フィールド reqs があれば、それを両方に流用
      const mergedDay = { ...defaultsReqDay, ...(cur.reqDay || {}), ...(cur.reqs || {}) };
      const mergedNight = { ...defaultsReqNight, ...(cur.reqNight || {}), ...(cur.reqs || {}) };
      const modes = { ...defaultsModes, ...(cur.modes || {}) };
      return { ...prev, [key]: { modes, reqDay: mergedDay, reqNight: mergedNight, periodMode: cur.periodMode || '昼' } };
    });
  }, [year, month, half]);

  const cfgRaw = periodConfigs[periodKey(year, month, half)] || {};
  // 旧データ（reqsのみ）でも落ちないようにマージして正規化
  const cfg = {
    modes: {},
    reqDay: {},
    reqNight: {},
    ...cfgRaw,
    periodMode: cfgRaw.periodMode || '昼',
    reqDay: { ...(cfgRaw.reqs || {}), ...(cfgRaw.reqDay || {}) },
    reqNight: { ...(cfgRaw.reqs || {}), ...(cfgRaw.reqNight || {}) },
  };

  // スロット（各日1枠：昼/夜 + 曜日表示）
  const slots = useMemo(() => {
    const out = [];
    const reqDay = cfg.reqDay || {};
    const reqNight = cfg.reqNight || {};
    const legacy = cfg.reqs || {}; // 念のため（旧）
    for (const iso of Object.keys(cfg.modes || {}).sort()) {
      const mode = cfg.modes[iso];
      const id = `${iso}_${mode === '昼' ? 'DAY' : 'NIGHT'}`;
      const label = `${iso} (${weekdayJ(iso)}) ${mode}`;
      const required = mode === '昼' ? (reqDay[iso] ?? legacy[iso] ?? 1) : (reqNight[iso] ?? legacy[iso] ?? 1);
      out.push({ id, label, required, iso, mode });
    }
    return out;
  }, [cfg]);

  const candidates = useMemo(
    () => generateCandidates(members, slots, numCandidates, minSat),
    [members, slots, numCandidates, minSat]
  );

  // 全日一括：昼／夜
  const bulkSetMode = (mode) => {
    setPeriodConfigs((prev) => {
      const key = periodKey(year, month, half);
      const now = prev[key] || { modes: {}, reqDay: {}, reqNight: {} };
      const nextModes = Object.fromEntries(Object.keys(now.modes).map((iso) => [iso, mode]));
      return { ...prev, [key]: { ...now, modes: nextModes, periodMode: mode } };
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto grid gap-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">シフト自動編成（昼夜別の必要人数）</h1>
          <div className="text-sm text-gray-500">1日1枠（昼/夜） / 前半・後半 / 保存＆復元</div>
        </header>

        <div className="grid md:grid-cols-3 gap-4">
          <Panel title="期間（年月・前半/後半・昼夜一括）">
            <div className="flex flex-col gap-3">
              <PeriodControls
                year={year}
                month={month}
                half={half}
                setYear={setYear}
                setMonth={setMonth}
                setHalf={setHalf}
              />
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">期間のモード（昼/夜）：</span>
                <button type="button" className="px-3 py-1 text-sm rounded border bg-yellow-200" onClick={() => bulkSetMode('昼')}>昼</button>
                <button type="button" className="px-3 py-1 text-sm rounded border bg-indigo-200" onClick={() => bulkSetMode('夜')}>夜</button>
              </div>
            </div>
          </Panel>

          <Panel title="日別設定（カレンダー：昼/夜の必要人数を別々に設定）">
            <CalendarHalf
              year={year}
              month={month}
              half={half}
              cfg={cfg}
              onChange={(next) => setPeriodConfigs((prev) => ({ ...prev, [periodKey(year, month, half)]: next }))}
            />
          </Panel>

          <Panel title="条件">
            <div className="space-y-4">
              <Labeled label={`最低充足率: ${(minSat * 100).toFixed(0)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={minSat} onChange={(e) => setMinSat(parseFloat(e.target.value))} className="w-full" />
              </Labeled>
              <Labeled label={`候補数: ${numCandidates}`}>
                <input type="range" min={1} max={10} step={1} value={numCandidates} onChange={(e) => setNumCandidates(parseInt(e.target.value))} className="w-full" />
              </Labeled>
              <p className="text-xs text-gray-500">必要人数はモード別。モード切替しても数値は保持されます。</p>
            </div>
          </Panel>
        </div>

        <Panel title="メンバー（タブで希望を編集）">
          <TabbedMemberEditor year={year} month={month} half={half} cfg={cfg} members={members} setMembers={setMembers} />
        </Panel>

        <Panel title="候補スケジュール（不足日は赤ハイライト）">
          {candidates.length === 0 ? (
            <div className="text-gray-500">条件を満たす案がありません。しきい値を下げるか、希望を広げてください。</div>
          ) : (
            <div className="grid gap-4">
              {candidates.map((c, idx) => (
                <CandidateCard key={idx} idx={idx} assn={c} slots={slots} />
              ))}
            </div>
          )}
        </Panel>

        <footer className="text-xs text-gray-500 text-center">© Shift Scheduler demo – カレンダー表示 / タブ編集 / 不足ハイライト / 自動保存 / 昼夜別必要人数</footer>
      </div>
    </div>
  );
}

// ===== UI 小物 =====
function Panel({ title, children }) {
  return (
    <section className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
}
function Labeled({ label, children }) {
  return (
    <label className="block text-sm">
      <div className="mb-1 text-gray-600">{label}</div>
      {children}
    </label>
  );
}
function PeriodControls({ year, month, half, setYear, setMonth, setHalf }) {
  const years = [];
  const current = new Date().getFullYear();
  for (let y = current - 2; y <= current + 2; y++) years.push(y);

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <select className="border rounded px-2 py-1" value={year} onChange={(e) => setYear(parseInt(e.target.value))}>
        {years.map((y) => (<option key={y} value={y}>{y}年</option>))}
      </select>
      <select className="border rounded px-2 py-1" value={month} onChange={(e) => setMonth(parseInt(e.target.value))}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (<option key={m} value={m}>{m}月</option>))}
      </select>
      <div className="inline-flex overflow-hidden rounded border">
        <button type="button" className={`px-3 py-1 text-sm ${half === 'H1' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setHalf('H1')}>前半（1–15）</button>
        <button type="button" className={`px-3 py-1 text-sm border-l ${half === 'H2' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setHalf('H2')}>後半（16–月末）</button>
      </div>
    </div>
  );
}

// ===== カレンダー（半月範囲だけ編集可能：昼夜別必要人数） =====
function CalendarHalf({ year, month, half, cfg, onChange }) {
  const dmax = daysInMonth(year, month);
  const start = half === 'H1' ? 1 : 16;
  const end = half === 'H1' ? Math.min(15, dmax) : dmax;

  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=日
  let day = 1;
  const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

  const update = (iso, patch) => {
    const next = {
  modes: { ...(cfg.modes || {}) },
  reqDay: { ...(cfg.reqDay || {}) },
  reqNight: { ...(cfg.reqNight || {}) },
  periodMode: cfg.periodMode         // ← これを追加
};

    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) next.modes[iso] = patch.mode;
    if (Object.prototype.hasOwnProperty.call(patch, 'reqDay')) next.reqDay[iso] = patch.reqDay;
    if (Object.prototype.hasOwnProperty.call(patch, 'reqNight')) next.reqNight[iso] = patch.reqNight;
    onChange(next);
  };

  const head = (
    <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
      {['日','月','火','水','木','金','土'].map((w) => (
        <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
      ))}
    </div>
  );

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const empty = i < firstDow || day > dmax;
    if (empty) {
      cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight: '92px'}}/>);
      continue;
    }
    const d = day++;
    const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const inRange = d >= start && d <= end;
    const mode = cfg.modes[iso] || '昼';
    const reqDay = cfg.reqDay[iso] ?? 1;
    const reqNight = cfg.reqNight[iso] ?? 1;

    cells.push(
      <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'120px', background: inRange ? weekendHolidayBg(iso, cfg.periodMode) : undefined}}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">{d}</div>
          <div className="text-xs text-gray-500">({['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]})</div>
        </div>
        <div className="mb-2 text-xs"><span className={`px-2 py-0.5 rounded border ${mode==='昼' ? 'bg-yellow-200' : 'bg-indigo-200'}`}>{mode}</span></div>
        <div className="space-y-1">
          {cfg.periodMode === '昼' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600">昼 必要</span>
              <input type="number" min={0} disabled={!inRange} className="w-16 border rounded px-2 py-1" value={reqDay} onChange={(e) => update(iso, { reqDay: parseInt(e.target.value || '0') })} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600">夜 必要</span>
              <input type="number" min={0} disabled={!inRange} className="w-16 border rounded px-2 py-1" value={reqNight} onChange={(e) => update(iso, { reqNight: parseInt(e.target.value || '0') })} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {head}
      <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap: '8px'}}>
        {cells}
      </div>
    </div>
  );
}

// ===== メンバー編集（タブ + 開閉） =====
function TabbedMemberEditor({ year, month, half, cfg, members, setMembers }) {
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  const add = () => setMembers((m) => [...m, { name: `Member${m.length + 1}`, availability: new Set(), desired_days: 1, preferred_slots: new Set() }]);
  const remove = (idx) => setMembers((arr) => arr.filter((_, i) => i !== idx));
  const updateMember = (idx, patch) => setMembers((arr) => arr.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  // 指定日のスロットIDを取得（期間の現モードに合わせる）
  const slotIdForIso = (iso) => {
    const mode = (cfg.modes || {})[iso] || '昼';
    return `${iso}_${mode === '昼' ? 'DAY' : 'NIGHT'}`;
  };

  const toggleAvail = (idx, iso) => {
    setMembers((arr) => {
      const copy = [...arr];
      const sid = slotIdForIso(iso);
      const set = new Set(copy[idx].availability);
      if (set.has(sid)) set.delete(sid); else set.add(sid);
      // 優先の整合性は維持（優先がONで可→不可にした場合は優先も外す）
      const pref = new Set(copy[idx].preferred_slots);
      if (!set.has(sid) && pref.has(sid)) pref.delete(sid);
      copy[idx] = { ...copy[idx], availability: set, preferred_slots: pref };
      return copy;
    });
  };
  const setPreferred = (idx, iso, checked) => {
    setMembers((arr) => {
      const copy = [...arr];
      const sid = slotIdForIso(iso);
      const pref = new Set(copy[idx].preferred_slots);
      const avail = new Set(copy[idx].availability);
      if (checked) {
        pref.add(sid);
        // 優先を付けたら勤務可能も自動ON
        avail.add(sid);
      } else {
        pref.delete(sid);
      }
      copy[idx] = { ...copy[idx], preferred_slots: pref, availability: avail };
      return copy;
    });
  };

  // カレンダー範囲
  const dmax = daysInMonth(year, month);
  const start = half === 'H1' ? 1 : 16;
  const end = half === 'H1' ? Math.min(15, dmax) : dmax;
  const firstDow = new Date(year, month - 1, 1).getDay();
  const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

  return (
    <div className="space-y-3">
      {/* タブヘッダ */}
      <div className="flex flex-wrap gap-2">
        {members.map((m, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => { if (active === idx) setCollapsed(!collapsed); else { setActive(idx); setCollapsed(false); }}}
            className={`px-3 py-1 rounded border text-sm ${active === idx && !collapsed ? 'bg-blue-600 text-white' : 'bg-white'}`}
          >{m.name}</button>
        ))}
        <button type="button" className="px-3 py-1 rounded border text-sm" onClick={add}>+ 追加</button>
      </div>

      {/* アクティブタブ内容（カレンダー） */}
      {members[active] && !collapsed && (
        <div className="rounded-xl border p-3 space-y-3">
          <div className="flex gap-2 items-center">
            <input className="border rounded px-2 py-1" value={members[active].name} onChange={(e) => updateMember(active, { name: e.target.value })} />
            <label className="text-sm text-gray-600 ml-auto">希望日数</label>
            <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={members[active].desired_days} onChange={(e) => updateMember(active, { desired_days: parseInt(e.target.value || '0') })} />
            <button type="button" className="text-red-600 ml-2" onClick={() => remove(active)}>削除</button>
          </div>

          <div className="text-xs text-gray-600">クリックで「勤務可能」を切り替え。チェックで「優先日」を指定できます（この期間のモード：<b>{cfg.periodMode}</b>）。</div>

          {/* 曜日ヘッダ */}
          <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
            {['日','月','火','水','木','金','土'].map((w) => (
              <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
            ))}
          </div>

          {/* 月カレンダー */}
          <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>
            {Array.from({length: totalCells}, (_, i) => i).map((i) => {
              const empty = i < firstDow || i - firstDow + 1 > dmax;
              if (empty) return <div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'92px'}}/>;
              const d = i - firstDow + 1;
              const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
              const inRange = d >= start && d <= end;
              const sid = slotIdForIso(iso);
              const isAvail = members[active].availability.has(sid);
              const isPref = members[active].preferred_slots.has(sid);

              return (
                <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'110px', background: inRange ? (isAvail ? '#DBEAFE' : weekendHolidayBg(iso, cfg.periodMode)) : undefined}}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">{d}</div>
                    <div className="text-xs text-gray-500">({['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]})</div>
                  </div>
                  <button type="button" disabled={!inRange} onClick={() => toggleAvail(active, iso)} className={`w-full text-sm border rounded px-2 py-1 ${isAvail ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>
                    {isAvail ? '勤務可能' : '未選択'}
                  </button>
                  <label className="flex items-center gap-2 mt-2 text-xs">
                    <input type="checkbox" disabled={!inRange} checked={isPref} onChange={(e)=> setPreferred(active, iso, e.target.checked)} />
                    優先日
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} className={"px-2 py-1 rounded-full border text-sm " + (active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700 border-gray-300")}>
      {children}
    </button>
  );
}

function CandidateCard({ idx, assn, slots }) {
  const minSat = Math.min(...Object.values(assn.satisfaction));
  const avgSat = Object.values(assn.satisfaction).reduce((a, b) => a + b, 0) / Object.values(assn.satisfaction).length;
  return (
    <div className="rounded-2xl border p-4 bg-white shadow">
      <div className="flex items-center justify-between">
        <div className="font-semibold">候補 {idx + 1}</div>
        <div className="text-sm text-gray-600">スコア {assn.score.toFixed(3)} ・ 最低 {Math.round(minSat * 100)}% ・ 平均 {Math.round(avgSat * 100)}%</div>
      </div>
      <div className="grid md:grid-cols-2 gap-4 mt-3">
        <div>
          <div className="text-sm text-gray-600 mb-1">各メンバーの充足率</div>
          <div className="space-y-2">
            {Object.entries(assn.satisfaction).map(([name, s]) => (
              <div key={name} className="flex items-center gap-2">
                <div className="w-24 text-sm">{name}</div>
                <Progress value={s} />
                <div className="w-12 text-right text-sm">{Math.round(s * 100)}%</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-600 mb-1">シフト別割当（不足は赤）</div>
          <div className="space-y-2 text-sm">
            {[...Object.entries(assn.bySlot)]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([sid, people]) => {
                const slot = slots.find((s) => s.id === sid);
                const required = slot?.required ?? 0;
                const lack = people.length < required;
                return (
                  <div key={sid} className={`flex justify-between border rounded px-2 py-1 ${lack ? 'bg-red-50 border-red-300' : ''}`}>
                    <div>
                      {slot?.label || sid}
                      {lack && <span className="ml-2 text-red-600">不足: {required - people.length}人</span>}
                    </div>
                    <div className={`font-medium ${lack ? 'text-red-600' : 'text-gray-700'}`}>{people.join(', ') || '-'}</div>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Progress({ value }) {
  return (
    <div className="flex-1 h-2 bg-gray-200 rounded">
      <div className="h-2 rounded bg-blue-600" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
