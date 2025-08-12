import React, { useEffect, useMemo, useState } from "react";
import JapaneseHolidays from "japanese-holidays";

// ===============================
// Shift Scheduler Web App (React)
// - 1日1枠（昼 or 夜）
// - 前半(1-15) / 後半(16-末) 切替
// - 昼夜で必要人数を別々に保持
// - 祝日/土日色分け
// - メンバー希望（カレンダーで可/優先）
// - 候補生成＆不足ハイライト
// - 提案ビュー：リスト / カレンダー
// - 昼夜別に「採用」→ 統合カレンダー表示
// - 連勤制限（デフォルト3、個別設定可）
// - ローカル保存/復元
// ===============================

/** 型の目安
 * Slot: { id: string, label: string, required: number, iso: string, mode: '昼'|'夜' }
 * Member: { name: string, availability: Set<string>, desired_days: number, preferred_slots: Set<string>, max_consecutive?: number }
 */

// ===== スケジューラ（必要人数最優先 2パス + 連勤制限） =====
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
      const maxConsec = Number.isFinite(m.max_consecutive) ? m.max_consecutive : 3;
      if (wouldExceedConsecutive(byMember[m.name], slot.iso, maxConsec)) continue;
      bySlot[slot.id].push(m.name);
      byMember[m.name].push(slot.id);
      needed -= 1;
    }
    // パス2: まだ足りなければ上限を外してでも充足（必要人数最優先）
    if (needed > 0) {
      for (const m of candidates) {
        if (needed <= 0) break;
        if (bySlot[slot.id].includes(m.name)) continue; // 既に割当済み
        const maxConsec = Number.isFinite(m.max_consecutive) ? m.max_consecutive : 3;
        if (wouldExceedConsecutive(byMember[m.name], slot.iso, maxConsec)) continue;
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

// --- 連勤制限ヘルパ ---
function isoAddDays(iso, delta){
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const dd = String(dt.getDate()).padStart(2,'0');
  return `${yy}-${mm}-${dd}`;
}
function wouldExceedConsecutive(existingSlotIds, candidateIso, max){
  const isoSet = new Set((existingSlotIds||[]).map(sid => sid.split('_')[0]));
  if (isoSet.has(candidateIso)) return false;
  let left=0, right=0;
  let cur = isoAddDays(candidateIso, -1);
  while(isoSet.has(cur)){ left++; cur = isoAddDays(cur, -1); }
  cur = isoAddDays(candidateIso, +1);
  while(isoSet.has(cur)){ right++; cur = isoAddDays(cur, +1); }
  const total = left + 1 + right;
  return total > max;
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
const LS_KEY = 'shift-scheduler-demo/state/v5';
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
      max_consecutive: m.max_consecutive ?? 3,
      desired_days_day: m.desired_days_day ?? m.desired_days ?? 2,
      desired_days_night: m.desired_days_night ?? m.desired_days ?? 2,
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
  // periodConfigs[key] = { modes: {iso:'昼|夜'}, reqDay: {iso:number}, reqNight: {iso:number}, periodMode: '昼'|'夜' }
  const [periodConfigs, setPeriodConfigs] = useState(persisted?.periodConfigs ?? {});
  const [members, setMembers] = useState(persisted?.members ?? [
    { name: "栄嶋", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "せりな", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "ここあ", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "安井", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "松原", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "高村", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "田村", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "坂ノ下", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "吉村", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
    { name: "小原", availability: new Set(), desired_days: 2, desired_days_day: 2, desired_days_night: 2, preferred_slots: new Set(), max_consecutive: 3 },
  ]);
  const [minSat, setMinSat] = useState(persisted?.minSat ?? 0.7);
  const [numCandidates, setNumCandidates] = useState(persisted?.numCandidates ?? 3);
  // 提案表示の見やすさ向上用トグル
  const [viewMode, setViewMode] = useState(persisted?.viewMode ?? 'list'); // 'list' | 'calendar'
  const [onlyLack, setOnlyLack] = useState(persisted?.onlyLack ?? false);
  // 昼夜ごとの「採用」候補（期間キー別に保存） { [periodKey]: { day: AssnSnap|null, night: AssnSnap|null } }
  const [adopted, setAdopted] = useState(persisted?.adopted ?? {});

  // 状態の永続化
  useEffect(() => {
    saveState({ year, month, half, periodConfigs, members, minSat, numCandidates, viewMode, onlyLack, adopted });
  }, [year, month, half, periodConfigs, members, minSat, numCandidates, viewMode, onlyLack, adopted]);

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
      const cur = prev[key] || { modes: {}, reqs: {}, reqDay: {}, reqNight: {}, periodMode: '昼' };
      // 旧フィールド reqs があれば、それを両方に流用
      const mergedDay = { ...defaultsReqDay, ...(cur.reqDay || {}), ...(cur.reqs || {}) };
      const mergedNight = { ...defaultsReqNight, ...(cur.reqNight || {}), ...(cur.reqs || {}) };
      const modes = { ...defaultsModes, ...(cur.modes || {}) };
      return { ...prev, [key]: { modes, reqDay: mergedDay, reqNight: mergedNight, periodMode: cur.periodMode || '昼' } };
    });
  }, [year, month, half]);

  const cfgRaw = periodConfigs[periodKey(year, month, half)] || {};
  // 旧データ（reqsのみ）でも落ちないように正規化
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
    const legacy = cfg.reqs || {};

    let isoKeys = Object.keys(cfg.modes || {}).sort();
    // フォールバック：modes が空の場合でも半月分を生成
    if (isoKeys.length === 0) {
      const dmax = daysInMonth(year, month);
      const start = half === 'H1' ? 1 : 16;
      const end = half === 'H1' ? Math.min(15, dmax) : dmax;
      isoKeys = [];
      for (let d = start; d <= end; d++) {
        isoKeys.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
      }
    }

    for (const iso of isoKeys) {
      const mode = (cfg.modes || {})[iso] || cfg.periodMode || '昼';
      const id = `${iso}_${mode === '昼' ? 'DAY' : 'NIGHT'}`;
      const label = `${iso} (${weekdayJ(iso)}) ${mode}`;
      const required = mode === '昼' ? (reqDay[iso] ?? legacy[iso] ?? 1) : (reqNight[iso] ?? legacy[iso] ?? 1);
      out.push({ id, label, required, iso, mode });
    }
    return out;
  }, [cfg, year, month, half]);

  // 提案モード（昼/夜）タブ
  const [proposalTab, setProposalTab] = useState('昼');

  // 提案用スロット（昼固定/夜固定）
  const slotsProposal = useMemo(() => {
    let isoKeys = Object.keys(cfg.modes || {}).sort();
    if (isoKeys.length === 0) {
      const dmax = daysInMonth(year, month);
      const start = half === 'H1' ? 1 : 16;
      const end = half === 'H1' ? Math.min(15, dmax) : dmax;
      isoKeys = [];
      for (let d = start; d <= end; d++) isoKeys.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
    const out = [];
    for (const iso of isoKeys) {
      const required = proposalTab === '昼' ? (cfg.reqDay[iso] ?? 1) : (cfg.reqNight[iso] ?? 1);
      const id = `${iso}_${proposalTab === '昼' ? 'DAY' : 'NIGHT'}`;
      const label = `${iso} (${weekdayJ(iso)}) ${proposalTab}`;
      out.push({ id, label, required, iso, mode: proposalTab });
    }
    return out;
  }, [cfg, proposalTab, year, month, half]);

  // メンバーの可用IDを提案モードに合わせてリマップ、希望日数も昼夜別を反映
  const membersProposal = useMemo(() => (
    members.map(m => {
      const target = proposalTab === '昼' ? 'DAY' : 'NIGHT';
      const avail = new Set(Array.from(m.availability || []).map(sid => `${String(sid).split('_')[0]}_${target}`));
      const desired = proposalTab === '昼' ? (m.desired_days_day ?? m.desired_days ?? 0) : (m.desired_days_night ?? m.desired_days ?? 0);
      return { ...m, availability: avail, desired_days: desired };
    })
  ), [members, proposalTab]);

  const candidates = useMemo(
    () => generateCandidates(membersProposal, slotsProposal, numCandidates, minSat),
    [membersProposal, slotsProposal, numCandidates, minSat]
  );

  // 全日一括：昼／夜
  const bulkSetMode = (mode) => {
    const key = periodKey(year, month, half);
    const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16;
    const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    const isos = [];
    for (let d = start; d <= end; d++) {
      isos.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }

    // 期間設定を更新（キーが空でも全日埋める）
    setPeriodConfigs((prev) => {
      const now = prev[key] || { modes: {}, reqDay: {}, reqNight: {}, periodMode: '昼' };
      const nextModes = Object.fromEntries(isos.map((iso) => [iso, mode]));
      return { ...prev, [key]: { ...now, modes: nextModes, periodMode: mode } };
    });

    // メンバーの availability / preferred_slots を新モードIDへリマップ
    setMembers((arr) => arr.map((m) => {
      const avail = new Set(m.availability);
      const pref = new Set(m.preferred_slots);
      for (const iso of isos) {
        const dayId = `${iso}_DAY`;
        const nightId = `${iso}_NIGHT`;
        const nextId = `${iso}_${mode === '昼' ? 'DAY' : 'NIGHT'}`;
        if (dayId !== nextId && avail.has(dayId)) { avail.delete(dayId); avail.add(nextId); }
        if (nightId !== nextId && avail.has(nightId)) { avail.delete(nightId); avail.add(nextId); }
        if (dayId !== nextId && pref.has(dayId)) { pref.delete(dayId); pref.add(nextId); }
        if (nightId !== nextId && pref.has(nightId)) { pref.delete(nightId); pref.add(nextId); }
      }
      return { ...m, availability: avail, preferred_slots: pref };
    }));
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
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm text-gray-600">表示</span>
            <button type="button" className={`px-2 py-1 text-sm rounded border ${viewMode==='list'?'bg-blue-600 text-white border-blue-600':'bg-white'}`} onClick={()=>setViewMode('list')}>リスト</button>
            <button type="button" className={`px-2 py-1 text-sm rounded border ${viewMode==='calendar'?'bg-blue-600 text-white border-blue-600':'bg-white'}`} onClick={()=>setViewMode('calendar')}>カレンダー</button>
            <span className="ml-4 text-sm text-gray-600">提案モード</span>
            <button type="button" className={`px-2 py-1 text-sm rounded border ${proposalTab==='昼'?'bg-yellow-200':'bg-white'}`} onClick={()=>setProposalTab('昼')}>昼</button>
            <button type="button" className={`px-2 py-1 text-sm rounded border ${proposalTab==='夜'?'bg-indigo-200':'bg-white'}`} onClick={()=>setProposalTab('夜')}>夜</button>
            <label className="ml-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyLack} onChange={(e)=>setOnlyLack(e.target.checked)} /> 不足のみ
            </label>
            <div className="ml-auto text-xs text-gray-500 flex items-center gap-3">
              <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded" style={{background:'#DCFCE7'}} />充足</span>
              <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded" style={{background:'#FEE2E2'}} />不足</span>
            </div>
          </div>
          {candidates.length === 0 ? (
            <div className="text-gray-500">条件を満たす案がありません。しきい値を下げるか、希望を広げてください。</div>
          ) : (
            <div className="grid gap-4">
              {candidates.map((c, idx) => (
                <CandidateCard
                  key={idx}
                  idx={idx}
                  assn={c}
                  slots={slotsProposal}
                  viewMode={viewMode}
                  onlyLack={onlyLack}
                  year={year}
                  month={month}
                  half={half}
                  cfg={cfg}
                  mode={proposalTab}
                  adoptedByMode={(adopted[periodKey(year, month, half)] || {})}
                  onToggleAdopt={(mode, nextChecked, assn) => {
                    setAdopted(prev => {
                      const k = periodKey(year, month, half);
                      const cur = prev[k] || {};
                      if (!nextChecked) {
                        const next = { ...cur };
                        if (mode === '昼') delete next.day; else delete next.night;
                        return { ...prev, [k]: next };
                      }
                      const snap = { bySlot: assn.bySlot, satisfaction: assn.satisfaction, score: assn.score, __sig: assn.__sig };
                      const next = mode === '昼' ? { ...cur, day: snap } : { ...cur, night: snap };
                      return { ...prev, [k]: next };
                    });
                  }}
                />
              ))}
            </div>
          )}
        </Panel>

        {/* 採用（昼・夜）統合カレンダー */}
        <Panel title="採用（昼・夜）統合カレンダー">
          <AdoptedMergedCalendar
            year={year}
            month={month}
            half={half}
            cfg={cfg}
            adoptedByMode={adopted[periodKey(year, month, half)] || {}}
          />
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
      periodMode: cfg.periodMode,
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

  const add = () => setMembers((m) => [...m, { name: `Member${m.length + 1}`, availability: new Set(), desired_days: 1, preferred_slots: new Set(), max_consecutive: 3 }]);
  const remove = (idx) => setMembers((arr) => arr.filter((_, i) => i !== idx));
  const updateMember = (idx, patch) => setMembers((arr) => arr.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  // 昼夜それぞれのスロットIDを扱う（期間モードに依存せず常に昼夜を表示）
  const toggleAvailSlot = (idx, slotId) => {
    setMembers((arr) => {
      const copy = [...arr];
      const set = new Set(copy[idx].availability);
      if (set.has(slotId)) set.delete(slotId); else set.add(slotId);
      // 優先の整合性維持
      const pref = new Set(copy[idx].preferred_slots);
      if (!set.has(slotId) && pref.has(slotId)) pref.delete(slotId);
      copy[idx] = { ...copy[idx], availability: set, preferred_slots: pref };
      return copy;
    });
  };
  const setPreferredSlot = (idx, slotId, checked) => {
    setMembers((arr) => {
      const copy = [...arr];
      const pref = new Set(copy[idx].preferred_slots);
      const avail = new Set(copy[idx].availability);
      if (checked) { pref.add(slotId); avail.add(slotId); } else { pref.delete(slotId); }
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
            <label className="text-sm text-gray-600 ml-auto">希望日数（昼）</label>
            <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={members[active].desired_days_day ?? members[active].desired_days ?? 0} onChange={(e) => updateMember(active, { desired_days_day: parseInt(e.target.value || '0') })} />
            <label className="text-sm text-gray-600 ml-4">希望日数（夜）</label>
            <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={members[active].desired_days_night ?? members[active].desired_days ?? 0} onChange={(e) => updateMember(active, { desired_days_night: parseInt(e.target.value || '0') })} />
            <label className="text-sm text-gray-600 ml-4">連勤上限</label>
            <input type="number" min={1} className="w-20 border rounded px-2 py-1" value={members[active].max_consecutive ?? 3} onChange={(e) => updateMember(active, { max_consecutive: Math.max(1, parseInt(e.target.value || '3')) })} />
            <button type="button" className="text-red-600 ml-2" onClick={() => remove(active)}>削除</button>
          </div>

          <div className="text-xs text-gray-600">クリックで「勤務可能」を切り替え。チェックで「優先日」を指定できます（昼・夜それぞれに「勤務可能」と「優先」を個別に設定できます）。</div>

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
              if (empty) return <div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'120px'}}/>;
              const d = i - firstDow + 1;
              const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
              const inRange = d >= start && d <= end;
              const dayId = `${iso}_DAY`;
              const nightId = `${iso}_NIGHT`;
              const isAvailDay = members[active].availability.has(dayId);
              const isAvailNight = members[active].availability.has(nightId);
              const isPrefDay = members[active].preferred_slots.has(dayId);
              const isPrefNight = members[active].preferred_slots.has(nightId);

              return (
                <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'120px', background: inRange ? weekendHolidayBg(iso, cfg.periodMode) : undefined}}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">{d}</div>
                    <div className="text-xs text-gray-500">({['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]})</div>
                  </div>

                  {/* 昼 行 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs px-1.5 py-0.5 rounded border bg-yellow-200">昼</span>
                    <button type="button" disabled={!inRange} onClick={() => toggleAvailSlot(active, dayId)} className={`text-xs border rounded px-2 py-0.5 ${isAvailDay ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>
                      {isAvailDay ? '勤務可能' : '未選択'}
                    </button>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" disabled={!inRange} checked={isPrefDay} onChange={(e)=> setPreferredSlot(active, dayId, e.target.checked)} /> 優先
                    </label>
                  </div>

                  {/* 夜 行 */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-1.5 py-0.5 rounded border bg-indigo-200">夜</span>
                    <button type="button" disabled={!inRange} onClick={() => toggleAvailSlot(active, nightId)} className={`text-xs border rounded px-2 py-0.5 ${isAvailNight ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>
                      {isAvailNight ? '勤務可能' : '未選択'}
                    </button>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" disabled={!inRange} checked={isPrefNight} onChange={(e)=> setPreferredSlot(active, nightId, e.target.checked)} /> 優先
                    </label>
                  </div>
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

function CandidateCard({ idx, assn, slots, viewMode='list', onlyLack=false, year, month, half, cfg, mode='昼', adoptedByMode={}, onToggleAdopt }) {
  const minSat = Math.min(...Object.values(assn.satisfaction));
  const avgSat = Object.values(assn.satisfaction).reduce((a, b) => a + b, 0) / Object.values(assn.satisfaction).length;

  // 補助: ISO→スロット検索（この期間は各ISO1枠）
  const slotByIso = React.useMemo(() => Object.fromEntries(slots.map(s => [s.iso, s])), [slots]);

  // カレンダー描画（半月）
  const CalendarView = () => {
    const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16;
    const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    const firstDow = new Date(year, month - 1, 1).getDay();
    const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

    const cells = [];
    let day = 1;
    for (let i = 0; i < totalCells; i++) {
      const empty = i < firstDow || day > dmax;
      if (empty) { cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'70px'}}/>); continue; }
      const d = day++;
      const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const inRange = d >= start && d <= end;
      const slot = slotByIso[iso];
      if (!inRange) { cells.push(<div key={iso} className="border rounded p-2 opacity-40" style={{minHeight:'70px'}}><div className="text-sm font-medium">{d}</div></div>); continue; }
      if (!slot) { cells.push(<div key={iso} className="border rounded p-2" style={{minHeight:'70px'}}><div className="text-sm font-medium">{d}</div></div>); continue; }

      const people = assn.bySlot[slot.id] || [];
      const required = slot.required || 0;
      const lack = people.length < required;
      if (onlyLack && !lack) { cells.push(<div key={iso} className="border rounded p-2 bg-gray-50" style={{minHeight:'70px'}}/>); continue; }

      const bg = lack ? '#FEE2E2' : '#DCFCE7';
      const maxShow = 4;
      const shown = people.slice(0, maxShow);
      const extra = people.length - shown.length;
      cells.push(
        <div key={iso} className="relative border rounded p-2" style={{minHeight:'86px', background:bg}}>
          {/* 右上バッジ：割当/必要 */}
          <div className={`absolute top-1 right-1 text-[11px] px-1.5 py-0.5 rounded-full text-white ${lack ? 'bg-red-600' : 'bg-green-600'}`}>
            {people.length}/{required}
          </div>
          <div className="flex items-center justify-between mb-1 pr-12">
            <div className="text-sm font-medium">{d}</div>
            <div className="text-xs text-gray-700">{mode}</div>
          </div>
          <div className="text-xs leading-tight" title={people.join(', ')}>
            {shown.length > 0 ? shown.map((p, i) => (<div key={i}>{p}</div>)) : '-' }
            {extra > 0 && <div className="text-[10px] text-gray-600">+{extra} 名</div>}
          </div>
        </div>
      );
    }

    return (
      <div>
        <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
          {['日','月','火','水','木','金','土'].map((w) => (
            <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
          ))}
        </div>
        <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>
          {cells}
        </div>
      </div>
    );
  };

  // リスト描画
  const ListView = () => (
    <div className="space-y-2 text-sm">
      {[...Object.entries(assn.bySlot)]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([sid, people]) => {
          if (!onlyLack) return true;
          const slot = slots.find((s) => s.id === sid);
          const required = slot?.required ?? 0;
          return people.length < required;
        })
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
              <div className={`font-medium ${lack ? 'text-red-600' : 'text-gray-700'}`} title={people.join(', ')}>
                {(() => { const maxShow=4; const shown=people.slice(0,maxShow); const extra=people.length-shown.length; return (<>
                  {shown.join('、') || '-'}{extra>0 && <span className="text-xs text-gray-500">、+{extra}</span>}
                </>); })()}
              </div>
            </div>
          );
        })}
    </div>
  );

  return (
    <div className="rounded-2xl border p-4 bg-white shadow">
      <div className="flex items-center gap-3 justify-between">
        <div className="font-semibold">候補 {idx + 1}</div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mode==='昼' ? (adoptedByMode.day?.__sig === assn.__sig) : (adoptedByMode.night?.__sig === assn.__sig)}
            onChange={(e)=> onToggleAdopt(mode, e.target.checked, assn)}
          />
          採用（{mode}）
        </label>
        <div className="text-sm text-gray-600">スコア {assn.score.toFixed(3)} ・ 最低 {Math.round(minSat * 100)}% ・ 平均 {Math.round(avgSat * 100)}%</div>
      </div>

      {/* 上: 提案カレンダー/リスト */}
      <div className="mt-3">
        <div className="text-sm text-gray-600 mb-1">{viewMode==='calendar' ? 'カレンダー（不足=赤 / 充足=緑）' : 'シフト別割当（不足は赤）'}</div>
        {viewMode==='calendar' ? <CalendarView /> : <ListView />}
      </div>

      {/* 下: 充足率 */}
      <div className="mt-4">
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
    </div>
  );
}

function AdoptedMergedCalendar({ year, month, half, cfg, adoptedByMode }) {
  const dmax = daysInMonth(year, month);
  const start = half === 'H1' ? 1 : 16;
  const end = half === 'H1' ? Math.min(15, dmax) : dmax;
  const firstDow = new Date(year, month - 1, 1).getDay();
  const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;
  let day = 1;

  const hasDay = !!adoptedByMode.day;
  const hasNight = !!adoptedByMode.night;

  const head = (
    <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
      {['日','月','火','水','木','金','土'].map((w) => (
        <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
      ))}
    </div>
  );

  const cells = [];
  for (let i=0;i<totalCells;i++){
    const empty = i < firstDow || day > dmax;
    if (empty){ cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'110px'}}/>); continue; }
    const d = day++;
    const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const inRange = d >= start && d <= end;

    const reqDay = cfg.reqDay[iso] ?? 0;
    const reqNight = cfg.reqNight[iso] ?? 0;
    const dayPeople = hasDay ? (adoptedByMode.day.bySlot[`${iso}_DAY`] || []) : [];
    const nightPeople = hasNight ? (adoptedByMode.night.bySlot[`${iso}_NIGHT`] || []) : [];

    cells.push(
      <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'110px', background: inRange ? weekendHolidayBg(iso, '昼') : undefined}}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">{d}</div>
          <div className="text-xs text-gray-500">({weekdayJ(iso)})</div>
        </div>
        <div className="space-y-1 text-xs">
          <div className="flex items-start gap-2">
            <span className="px-2 py-0.5 rounded border bg-yellow-200">昼</span>
            <div className="flex-1">
              <div className="inline-block text-[11px] px-1.5 py-0.5 rounded-full text-white align-middle mr-2" style={{background: (dayPeople.length < reqDay) ? '#DC2626' : '#16A34A'}}>
                {dayPeople.length}/{reqDay}
              </div>
              {dayPeople.slice(0,4).map((p,i)=>(<span key={i} className="mr-1">{p}</span>))}
              {dayPeople.length>4 && <span className="text-gray-500">+{dayPeople.length-4}</span>}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="px-2 py-0.5 rounded border bg-indigo-200">夜</span>
            <div className="flex-1">
              <div className="inline-block text-[11px] px-1.5 py-0.5 rounded-full text-white align-middle mr-2" style={{background: (nightPeople.length < reqNight) ? '#DC2626' : '#16A34A'}}>
                {nightPeople.length}/{reqNight}
              </div>
              {nightPeople.slice(0,4).map((p,i)=>(<span key={i} className="mr-1">{p}</span>))}
              {nightPeople.length>4 && <span className="text-gray-500">+{nightPeople.length-4}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {head}
      <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>
        {cells}
      </div>
      {(!hasDay && !hasNight) && <div className="text-sm text-gray-500 mt-2">まだ「採用」を選んだ候補がありません。候補一覧で昼/夜のどちらかにチェックを入れてください。</div>}
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
