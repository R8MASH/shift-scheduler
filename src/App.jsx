import React, { useEffect, useMemo, useState } from "react";
import JapaneseHolidays from "japanese-holidays";

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

function greedySchedule(
  members,
  slots,
  seed = 0,
  balanceBias = 0.6,
  pairingPrefByIso = null,
  pairBonus = 0,
  preAssignedIsoByMember = null // ★ 昼夜またぎ連勤用：{ name: Set(iso) }
) {
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

    // ★ 同日ペア優遇（昼→夜の連携用）。slotId から iso を取り出して参照
    const iso = slotId.split('_')[0];
    const pairBoost =
      pairingPrefByIso && pairingPrefByIso[iso] && pairingPrefByIso[iso].has(member.name)
        ? pairBonus
        : 0;
    return prefBonus + fairness - loadPenalty + pairBoost + rng();
  };

  for (const slot of order) {
    let needed = slot.required;
    const candidates = members
      .filter((m) => m.availability.has(slot.id))
      .sort((a, b) => candidateScore(b, slot.id) - candidateScore(a, slot.id));

    for (const m of candidates) {
      if (needed <= 0) break;
      if (byMember[m.name].length >= Math.max(1, m.desired_days + 1)) continue;
      const maxConsec = Number.isFinite(m.max_consecutive) ? m.max_consecutive : 3;
      const external = preAssignedIsoByMember && preAssignedIsoByMember[m.name];
      if (wouldExceedConsecutive(byMember[m.name], slot.iso, maxConsec, external)) continue;
      bySlot[slot.id].push(m.name);
      byMember[m.name].push(slot.id);
      needed -= 1;
    }
    if (needed > 0) {
      for (const m of candidates) {
        if (needed <= 0) break;
        if (bySlot[slot.id].includes(m.name)) continue;
        const maxConsec = Number.isFinite(m.max_consecutive) ? m.max_consecutive : 3;
        const external = preAssignedIsoByMember && preAssignedIsoByMember[m.name];
        if (wouldExceedConsecutive(byMember[m.name], slot.iso, maxConsec, external)) continue;
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

// ★ 昼の割当結果を “同日ペア優遇” として取り入れつつ夜の候補を生成
function generateCandidatesWithPairing(
  members,
  slots,
  n = 5,
  minSatisfaction = 0.7,
  dayAssnForPairing,     // 昼のアサイン結果 { bySlot, ... } を想定
  pairStrength = 0.5
) {
  const accepted = [];
  const bestSeen = [];
  let seed = 0, tried = 0;

  // 昼アサインを iso→Set(名前) に変換
  const pairingPrefByIso = {};
  if (dayAssnForPairing && dayAssnForPairing.bySlot) {
    for (const [slotId, names] of Object.entries(dayAssnForPairing.bySlot)) {
      const iso = slotId.split('_')[0];
      pairingPrefByIso[iso] = pairingPrefByIso[iso] || new Set();
      names.forEach((nm) => pairingPrefByIso[iso].add(nm));
    }
  }
  const pairBonus = 0.3 * Math.max(0, Math.min(1, pairStrength));

  // ★ 昼の「各メンバーの割当日（ISO）」を作成し、夜の連勤判定に利用
  const preAssignedIsoByMember = {};
  if (dayAssnForPairing && dayAssnForPairing.byMember) {
    for (const [name, slotIds] of Object.entries(dayAssnForPairing.byMember)) {
      const set = new Set();
      (slotIds || []).forEach(id => set.add(String(id).split('_')[0]));
      preAssignedIsoByMember[name] = set;
    }
  }

  const pushUnique = (arr, assn) => {
    const sig = JSON.stringify(
      Object.fromEntries(Object.entries(assn.bySlot).map(([k, v]) => [k, [...v].sort()]))
    );
    if (!arr.some((r) => r.__sig === sig)) {
      assn.__sig = sig;
      arr.push(assn);
    }
  };

  while (accepted.length < n && tried < n * 40) {
    const bias = 0.4 + 0.4 * ((seed % 10) / 9 || 0);
    const assn = greedySchedule(
      members,
      slots,
      seed,
      bias,
      Object.keys(pairingPrefByIso).length ? pairingPrefByIso : null,
      pairBonus,
      // ★ 夜側の連勤制限で「昼に入っている連続日」もカウント
      Object.keys(preAssignedIsoByMember).length ? preAssignedIsoByMember : null
    );
    pushUnique(bestSeen, assn);
    const minSat = Math.min(...Object.values(assn.satisfaction));
    if (!Number.isNaN(minSat) && minSat >= minSatisfaction) pushUnique(accepted, assn);
    seed += 1; tried += 1;
  }
  if (accepted.length > 0) return accepted.sort((a, b) => b.score - a.score).slice(0, n);
  if (bestSeen.length > 0) return bestSeen.sort((a, b) => b.score - a.score).slice(0, n);
  return [];
}

function generateCandidates(members, slots, n = 5, minSatisfaction = 0.7) {
  const accepted = [];
  const bestSeen = [];
  let seed = 0, tried = 0;
  const pushUnique = (arr, assn) => {
    const sig = JSON.stringify(
      Object.fromEntries(Object.entries(assn.bySlot).map(([k, v]) => [k, [...v].sort()]))
    );
    if (!arr.some((r) => r.__sig === sig)) {
      assn.__sig = sig;
      arr.push(assn);
    }
  };

  while (accepted.length < n && tried < n * 40) {
    const bias = 0.4 + 0.4 * ((seed % 10) / 9 || 0);
    const assn = greedySchedule(members, slots, seed, bias);
    pushUnique(bestSeen, assn);
    const minSat = Math.min(...Object.values(assn.satisfaction));
    if (!Number.isNaN(minSat) && minSat >= minSatisfaction) {
      pushUnique(accepted, assn);
    }
    seed += 1; tried += 1;
  }

  if (accepted.length > 0) {
    return accepted.sort((a, b) => b.score - a.score).slice(0, n);
  }
  if (bestSeen.length > 0) {
    return bestSeen.sort((a, b) => b.score - a.score).slice(0, n);
  }
  return [];
}

function setIntersect(a, b) { const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out; }
function shuffle(arr, rng) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }
function mulberry32(a) { return function() { let t=(a+=0x6d2b79f5); t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function periodKey(year, month, half) { return `${year}-${String(month).padStart(2,"0")}-${half}`; }
function weekdayJ(iso) { const [y,m,d] = iso.split('-').map(Number); return ['日','月','火','水','木','金','土'][new Date(y, m-1, d).getDay()]; }

function isoAddDays(iso, delta){ const [y,m,d] = iso.split('-').map(Number); const dt = new Date(y, m-1, d + delta); const yy = dt.getFullYear(); const mm = String(dt.getMonth()+1).padStart(2,'0'); const dd = String(dt.getDate()).padStart(2,'0'); return `${yy}-${mm}-${dd}`; }
function wouldExceedConsecutive(existingSlotIds, candidateIso, max, externalIsoSet = null){
  // 既割当（同側）のスロットIDを ISO 日付に正規化
  const isoSet = new Set((existingSlotIds||[]).map(sid => String(sid).split('_')[0]));
  // ★ 外部（反対側のシフトなど）の割当 ISO を合算
  if (externalIsoSet) { for (const iso of externalIsoSet) isoSet.add(iso); }
  // 同日すでに入っているなら（昼↔夜の同日）連勤チェックは不該当
  if (isoSet.has(candidateIso)) return false;
  // 前後の連続日数をカウント
  let left=0, right=0;
  let cur = isoAddDays(candidateIso, -1);
  while(isoSet.has(cur)){ left++; cur = isoAddDays(cur, -1); }
  cur = isoAddDays(candidateIso, +1);
  while(isoSet.has(cur)){ right++; cur = isoAddDays(cur, +1); }
  const total = left + 1 + right;
  return total > max;
}
function isHolidayISO(iso) { const [y,m,d] = iso.split('-').map(Number); return !!JapaneseHolidays.isHoliday(new Date(y, m-1, d)); }
function weekendHolidayBg(iso) { const [y,m,d] = iso.split('-').map(Number); const dt = new Date(y, m-1, d); const dow = dt.getDay(); if (JapaneseHolidays.isHoliday(dt) || dow === 0) return '#FFE4E6'; if (dow === 6) return '#DBEAFE'; return '#F9FAFB'; }

const LS_KEY = 'shift-scheduler-demo/state/v6';
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

export default function ShiftSchedulerApp() {
  const persisted = loadState();
  const today = new Date();
  const [year, setYear] = useState(persisted?.year ?? today.getFullYear());
  const [month, setMonth] = useState(persisted?.month ?? (today.getMonth() + 1));
  const [half, setHalf] = useState(persisted?.half ?? 'H1');
  const [periodConfigs, setPeriodConfigs] = useState(persisted?.periodConfigs ?? {});
  const [members, setMembers] = useState(persisted?.members ?? []);
  const [minSat, setMinSat] = useState(persisted?.minSat ?? 0.7);
  const [numCandidates, setNumCandidates] = useState(persisted?.numCandidates ?? 3);
  const [viewMode, setViewMode] = useState(persisted?.viewMode ?? 'calendar');
  const [onlyLack, setOnlyLack] = useState(persisted?.onlyLack ?? false);
  const [highlightName, setHighlightName] = useState(persisted?.highlightName ?? '');
  // ★ FIX: pairStrength は useEffect で参照するため先に宣言
  const [pairStrength, setPairStrength] = useState(persisted?.pairStrength ?? 0.5);
  const [publishedDay, setPublishedDay] = useState(persisted?.publishedDay ?? []);
  const [publishedNight, setPublishedNight] = useState(persisted?.publishedNight ?? []);
  const [publishedSig, setPublishedSig] = useState(persisted?.publishedSig ?? null);
  const [sortBy, setSortBy] = useState(persisted?.sortBy ?? 'totalLack'); // 'idx'|'dayMin'|'dayAvg'|'dayLack'|'nightMin'|'nightAvg'|'nightLack'|'totalLack'
  const [sortDir, setSortDir] = useState(persisted?.sortDir ?? 'asc');     // 'asc'|'desc'

  useEffect(() => {
    // 出力済み情報も含めて永続化
    saveState({
      year, month, half, periodConfigs, members,
      minSat, numCandidates, viewMode, onlyLack, highlightName, pairStrength,
      publishedDay, publishedNight, publishedSig,
      sortBy, sortDir
    });
  }, [
    year, month, half, periodConfigs, members,
    minSat, numCandidates, viewMode, onlyLack, highlightName, pairStrength,
    publishedDay, publishedNight, publishedSig,
    sortBy, sortDir
  ]);

  useEffect(() => {
    const key = periodKey(year, month, half);
    setPeriodConfigs((prev) => {
      const dmax = daysInMonth(year, month);
      const start = half === 'H1' ? 1 : 16;
      const end = half === 'H1' ? Math.min(15, dmax) : dmax;
      const defaultsReqDay = {}; const defaultsReqNight = {};
      for (let d = start; d <= end; d++) {
        const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        defaultsReqDay[iso] = 1; defaultsReqNight[iso] = 1;
      }
      const cur = prev[key] || { reqDay:{}, reqNight:{} };
      return { ...prev, [key]: { reqDay: { ...defaultsReqDay, ...(cur.reqDay||{}) }, reqNight: { ...defaultsReqNight, ...(cur.reqNight||{}) } } };
    });
  }, [year, month, half]);

  const cfgRaw = periodConfigs[periodKey(year, month, half)] || {};
  const cfg = { reqDay: { ...(cfgRaw.reqDay||{}) }, reqNight: { ...(cfgRaw.reqNight||{}) } };


  const slotsDay = useMemo(() => {
    const out = []; const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16; const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    for (let d=start; d<=end; d++){
      const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      out.push({ id:`${iso}_DAY`, label:`${iso} (${weekdayJ(iso)}) 昼`, required: cfg.reqDay[iso] ?? 1, iso, mode:'昼' });
    }
    return out;
  }, [cfg, year, month, half]);

  const slotsNight = useMemo(() => {
    const out = []; const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16; const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    for (let d=start; d<=end; d++){
      const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      out.push({ id:`${iso}_NIGHT`, label:`${iso} (${weekdayJ(iso)}) 夜`, required: cfg.reqNight[iso] ?? 1, iso, mode:'夜' });
    }
    return out;
  }, [cfg, year, month, half]);

  const membersDay = useMemo(() => members.map(m => ({
    ...m,
    availability: new Set(Array.from(m.availability||[]).filter(id => id.endsWith('_DAY'))),
    preferred_slots: new Set(Array.from(m.preferred_slots||[]).filter(id => id.endsWith('_DAY'))),
    desired_days: m.desired_days_day ?? 0,
  })), [members]);

  const membersNight = useMemo(() => members.map(m => ({
    ...m,
    availability: new Set(Array.from(m.availability||[]).filter(id => id.endsWith('_NIGHT'))),
    preferred_slots: new Set(Array.from(m.preferred_slots||[]).filter(id => id.endsWith('_NIGHT'))),
    desired_days: m.desired_days_night ?? 0,
  })), [members]);

  const candidatesDay = useMemo(
    () => generateCandidates(membersDay, slotsDay, numCandidates, minSat),
    [membersDay, slotsDay, numCandidates, minSat]
  );
  const candidatesNight = useMemo(() => {
    // 昼候補があれば、同じインデックスの昼案を参照して“同日ペア優遇込み”で夜候補を作る
    if ((candidatesDay?.length || 0) > 0) {
      const out = [];
      for (let i = 0; i < numCandidates; i++) {
        const refDay = candidatesDay[i] || candidatesDay[0]; // 足りなければ先頭を流用
        const one = generateCandidatesWithPairing(
          membersNight,
          slotsNight,
          1,
          minSat,
          refDay,
          pairStrength
        );
        if (one[0]) out.push(one[0]);
      }
      return out;
    }
    // 昼候補が無い場合は従来通り
    return generateCandidates(membersNight, slotsNight, numCandidates, minSat);
  }, [membersNight, slotsNight, numCandidates, minSat, candidatesDay, pairStrength]);

  // ===== 出力の固定制御 =====
  // 署名用の正規化：入力が変わったかどうかを判定（Setsは配列化し、ソートしてから署名化）
  function normMembers(ms){
    return (ms||[])
      .map(m => ({
        name: m.name,
        desired_days_day: m.desired_days_day,
        desired_days_night: m.desired_days_night,
        max_consecutive: m.max_consecutive,
        availability: Array.from(m.availability||[]).sort(),
        preferred_slots: Array.from(m.preferred_slots||[]).sort(),
      }))
      .sort((a,b)=>a.name.localeCompare(b.name));
  }
  function normPeriod(pc){
    const ord = o => Object.fromEntries(Object.entries(o||{}).sort(([a],[b]) => a.localeCompare(b)));
    return {
      reqDay: ord(pc?.reqDay||{}),
      reqNight: ord(pc?.reqNight||{}),
    };
  }
  const configSig = useMemo(() => {
    const target = {
      year, month, half,
      period: normPeriod(periodConfigs?.[`${year}-${month}-${half}`]),
      members: normMembers(members),
      minSat, numCandidates, pairStrength
    };
    return JSON.stringify(target);
  }, [year, month, half, periodConfigs, members, minSat, numCandidates, pairStrength]);
  const isDirtySincePublish = useMemo(() => publishedSig !== configSig, [publishedSig, configSig]);

  // 出力（固定）実行：現在のプレビュー候補をそのまま固定して表示・保存
  const handlePublish = () => {
    setPublishedDay(candidatesDay || []);
    setPublishedNight(candidatesNight || []);
    setPublishedSig(configSig);
  };
  // 出力クリア（必要ならUIにボタン追加可）
  const handleClearPublish = () => {
    setPublishedDay([]);
    setPublishedNight([]);
    setPublishedSig(null);
  };

  // 画面に表示するのは「出力済み」のみ（未出力なら空扱い）
  const displayDay = publishedDay || [];
  const displayNight = publishedNight || [];

  
  // ===== サマリー計算（各候補ごとの満足度・不足合計） =====
  const summarizeAssn = (assn, slots) => {
    if (!assn) return { minSat: null, avgSat: null, lackTotal: null };
    const vals = Object.values(assn.satisfaction || {});
    const minSat = vals.length ? Math.min(...vals) : 1;
    const avgSat = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 1;
    let lackTotal = 0;
    for (const s of slots) {
      const cur = assn.bySlot?.[s.id]?.length || 0;
      lackTotal += Math.max(0, (s.required || 0) - cur);
    }
    return { minSat, avgSat, lackTotal };
  };
  const summaryRows = useMemo(() => {
    const n = Math.max(displayDay.length, displayNight.length);
    const rows = [];
    for (let i=0;i<n;i++){
      const d = summarizeAssn(displayDay[i], slotsDay);
      const nsum = summarizeAssn(displayNight[i], slotsNight);
      rows.push({ i, day: d, night: nsum });
    }
    return rows;
    }, [displayDay, displayNight, slotsDay, slotsNight]);

  // ★ サマリーの並び替え（行インデックス配列を作って並べ替え）
  const rowByIndex = useMemo(() => Object.fromEntries(summaryRows.map(r => [r.i, r])), [summaryRows]);
  const sortedIdxs = useMemo(() => {
    const keyVal = (r) => {
      switch (sortBy) {
        case 'dayMin':    return r.day.minSat   ?? 1;
        case 'dayAvg':    return r.day.avgSat   ?? 1;
        case 'dayLack':   return r.day.lackTotal   ?? 0;
        case 'nightMin':  return r.night.minSat ?? 1;
        case 'nightAvg':  return r.night.avgSat ?? 1;
        case 'nightLack': return r.night.lackTotal ?? 0;
        case 'totalLack': return (r.day.lackTotal ?? 0) + (r.night.lackTotal ?? 0);
        case 'idx':
        default:          return r.i;
      }
    };
    const arr = summaryRows.map(r => r.i);
    arr.sort((a, b) => {
      const ra = rowByIndex[a], rb = rowByIndex[b];
      const va = keyVal(ra),     vb = keyVal(rb);
      const cmp = (va === vb) ? (a - b) : (va < vb ? -1 : 1);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [summaryRows, rowByIndex, sortBy, sortDir]);
 

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto grid gap-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">シフト自動編成（昼夜同時）</h1>
          <div className="text-sm text-gray-500">前半・後半 / 昼夜必要人数 / 自動保存</div>
        </header>

        <div className="grid md:grid-cols-3 gap-4">
          <Panel title="期間（年月・前半/後半）">
            <PeriodControls year={year} month={month} half={half} setYear={setYear} setMonth={setMonth} setHalf={setHalf} />
          </Panel>

          <Panel title="日別設定（昼・夜 必要人数）">
            <CalendarHalf year={year} month={month} half={half} cfg={cfg} onChange={(next)=> setPeriodConfigs(prev=> ({ ...prev, [periodKey(year, month, half)]: next }))} />
          </Panel>

          <Panel title="条件">
            <div className="space-y-4">
              <Labeled label={`最低充足率: ${(minSat * 100).toFixed(0)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={minSat} onChange={(e)=> setMinSat(parseFloat(e.target.value))} className="w-full" />
              </Labeled>
              <Labeled label={`候補数: ${numCandidates}`}>
                <input type="range" min={1} max={10} step={1} value={numCandidates} onChange={(e)=> setNumCandidates(parseInt(e.target.value))} className="w-full" />
              </Labeled>
              <Labeled label={`同日集約の強さ: ${(pairStrength*100).toFixed(0)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={pairStrength} onChange={(e)=> setPairStrength(parseFloat(e.target.value))} className="w-full" />
              </Labeled>
            </div>
          </Panel>
        </div>

        <Panel title="メンバー（タブで希望を編集）">
          <TabbedMemberEditor year={year} month={month} half={half} cfg={cfg} members={members} setMembers={setMembers} />
        </Panel>

        <Panel title="候補スケジュール（昼夜まとめて表示／不足は赤）">
          {/* ★ 出力（固定）ボタン群 */}
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded border bg-white hover:bg-gray-50"
              onClick={handlePublish}
            >
              {publishedSig ? (isDirtySincePublish ? '再出力（現在の設定で上書き）' : '再出力（同じ設定）') : 'シフトを出力'}
            </button>
            {publishedSig && (
              <button
                type="button"
                className="px-3 py-1 rounded border text-gray-600 hover:bg-gray-50"
                onClick={handleClearPublish}
              >
                出力をクリア
              </button>
            )}
            <span className={`text-xs ${isDirtySincePublish ? 'text-red-600' : 'text-gray-500'}`}>
              {publishedSig
                ? (isDirtySincePublish
                    ? '未出力の変更があります（表示は固定のまま）'
                    : '出力と設定は一致しています')
                : 'まだ出力されていません'}
            </span>
          </div>
          {/* 候補比較サマリー（上部に一覧） */}
          {/* ★ 並び替えUI */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-gray-600">サマリー並び替え:</span>
            <select className="border rounded px-2 py-1 text-sm" value={sortBy} onChange={(e)=> setSortBy(e.target.value)}>
              <option value="totalLack">不足合計</option>
              <option value="dayLack">昼 不足合計</option>
              <option value="nightLack">夜 不足合計</option>
              <option value="dayMin">昼 最低充足率</option>
              <option value="nightMin">夜 最低充足率</option>
              <option value="dayAvg">昼 平均充足率</option>
              <option value="nightAvg">夜 平均充足率</option>
              <option value="idx">元の順序</option>
            </select>
            <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>
              {sortDir === 'asc' ? '↑ 昇順' : '↓ 降順'}
            </button>
          </div>
          <div className="mb-3 overflow-x-auto">
            <table className="w-full text-sm border">
              <thead>
                <tr className="bg-gray-50">
                  <th className="border px-2 py-1 text-left">候補</th>
                  <th className="border px-2 py-1">昼 最低/平均</th>
                  <th className="border px-2 py-1">昼 不足合計</th>
                  <th className="border px-2 py-1">夜 最低/平均</th>
                  <th className="border px-2 py-1">夜 不足合計</th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.length === 0 ? (
                  <tr><td colSpan={5} className="border px-2 py-2 text-gray-500">
                    {publishedSig ? '出力済み候補がありません' : 'まだ出力されていません（「シフトを出力」を押すと固定表示されます）'}
                  </td></tr>
                ) : sortedIdxs.map(i => {
                  const r = rowByIndex[i];
                  return (
                  <tr key={`sum-${r.i}`} className="odd:bg-white even:bg-gray-50">
                    <td className="border px-2 py-1">案 {r.i+1}</td>
                    <td className="border px-2 py-1">
                      {r.day.minSat==null ? '-' : `${Math.round(r.day.minSat*100)}% / ${Math.round(r.day.avgSat*100)}%`}
                    </td>
                    <td className="border px-2 py-1">{r.day.lackTotal==null ? '-' : r.day.lackTotal}</td>
                    <td className="border px-2 py-1">
                      {r.night.minSat==null ? '-' : `${Math.round(r.night.minSat*100)}% / ${Math.round(r.night.avgSat*100)}%`}
                    </td>
                    <td className="border px-2 py-1">{r.night.lackTotal==null ? '-' : r.night.lackTotal}</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyLack} onChange={(e)=>setOnlyLack(e.target.checked)} /> 不足のみ
            </label>

            <span className="ml-4 text-sm text-gray-600">　ハイライト</span>
            <select className="border rounded px-2 py-1 text-sm" value={highlightName} onChange={(e)=> setHighlightName(e.target.value)}>
              <option value="">なし</option>
              {members.map(m => (<option key={m.name} value={m.name}>{m.name}</option>))}
            </select>

            <div className="ml-auto text-xs text-gray-500 flex items-center gap-3">
              <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded" style={{background:'#DCFCE7'}} />充足</span>
              <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded" style={{background:'#FEE2E2'}} />不足</span>
            </div>
          </div>

          {(displayDay.length === 0 && displayNight.length === 0) ? (
            <div className="text-gray-500">候補がありません。必要人数やしきい値、可用日を調整してください。</div>
          ) : (
            <div className="grid gap-4">
              {Array.from({length: Math.max(displayDay.length, displayNight.length)}, (_,i)=>i).map(i => (
                <CombinedCandidateCard
                  key={`c${i}`}
                  idx={i}
                  dayAssn={displayDay[i]}
                  nightAssn={displayNight[i]}
                  slotsDay={slotsDay}
                  slotsNight={slotsNight}
                  onlyLack={onlyLack}
                  year={year}
                  month={month}
                  half={half}
                  highlightName={highlightName}
                />
              ))}
            </div>
          )}
        </Panel>


        <footer className="text-xs text-gray-500 text-center">© Shift Scheduler</footer>
      </div>
    </div>
  );
}

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
  const years = []; const current = new Date().getFullYear();
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

function CalendarHalf({ year, month, half, cfg, onChange }) {
  const [bulkDayVal, setBulkDayVal] = useState(1);
  const [bulkNightVal, setBulkNightVal] = useState(1);

  const dmax = daysInMonth(year, month);
  const start = half === 'H1' ? 1 : 16;
  const end = half === 'H1' ? Math.min(15, dmax) : dmax;

  const firstDow = new Date(year, month - 1, 1).getDay();
  let day = 1;
  const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

  const update = (iso, patch) => {
    const next = {
      modes: { ...(cfg.modes || {}) },
      reqDay: { ...(cfg.reqDay || {}) },
      reqNight: { ...(cfg.reqNight || {}) },
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'reqDay')) next.reqDay[iso] = patch.reqDay;
    if (Object.prototype.hasOwnProperty.call(patch, 'reqNight')) next.reqNight[iso] = patch.reqNight;
    onChange(next);
  };

  const applyScope = (which, scope, value) => {
    const next = {
      modes: { ...(cfg.modes || {}) },
      reqDay: { ...(cfg.reqDay || {}) },
      reqNight: { ...(cfg.reqNight || {}) },
    };
    for (let d = start; d <= end; d++) {
      const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const date = new Date(year, month-1, d);
      const dow = date.getDay();
      const isHol = !!JapaneseHolidays.isHoliday(date);
      let ok = false;
      if (scope === 'all') ok = true;
      else if (scope === 'weekday') ok = dow>=1 && dow<=5 && !isHol;
      else if (scope === 'sat') ok = dow===6 && !isHol;
      else if (scope === 'sunhol') ok = dow===0 || isHol;
      if (!ok) continue;
      if (which === 'day') next.reqDay[iso] = value; else next.reqNight[iso] = value;
    }
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
      cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight: '128px'}}/>);
      continue;
    }
    const d = day++;
    const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const inRange = d >= start && d <= end;
    const reqDay = cfg.reqDay[iso] ?? 1;
    const reqNight = cfg.reqNight[iso] ?? 1;

    cells.push(
      <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'128px', background: inRange ? weekendHolidayBg(iso, '昼') : undefined}}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">{d}</div>
          <div className="text-xs text-gray-500">({['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]})</div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs px-1.5 py-0.5 rounded border bg-yellow-200">昼</span>
            <button type="button" disabled={!inRange} onClick={() => update(iso, { reqDay: Math.max(0, (reqDay||0)-1) })} className="px-2 py-1 text-xs rounded border">−</button>
            <input type="number" min={0} disabled={!inRange} className="w-20 border rounded px-2 py-1" value={reqDay} onChange={(e) => update(iso, { reqDay: parseInt(e.target.value || '0') })} />
            <button type="button" disabled={!inRange} onClick={() => update(iso, { reqDay: (reqDay||0)+1 })} className="px-2 py-1 text-xs rounded border">＋</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-1.5 py-0.5 rounded border bg-indigo-200">夜</span>
            <button type="button" disabled={!inRange} onClick={() => update(iso, { reqNight: Math.max(0, (reqNight||0)-1) })} className="px-2 py-1 text-xs rounded border">−</button>
            <input type="number" min={0} disabled={!inRange} className="w-20 border rounded px-2 py-1" value={reqNight} onChange={(e) => update(iso, { reqNight: parseInt(e.target.value || '0') })} />
            <button type="button" disabled={!inRange} onClick={() => update(iso, { reqNight: (reqNight||0)+1 })} className="px-2 py-1 text-xs rounded border">＋</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">昼 一括</span>
          <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={bulkDayVal} onChange={(e)=> setBulkDayVal(Math.max(0, parseInt(e.target.value || '0')))} />
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('day','all',bulkDayVal)}>全日</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('day','weekday',bulkDayVal)}>平日</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('day','sat',bulkDayVal)}>土曜</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('day','sunhol',bulkDayVal)}>日祝</button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">夜 一括</span>
          <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={bulkNightVal} onChange={(e)=> setBulkNightVal(Math.max(0, parseInt(e.target.value || '0')))} />
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('night','all',bulkNightVal)}>全日</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('night','weekday',bulkNightVal)}>平日</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('night','sat',bulkNightVal)}>土曜</button>
          <button type="button" className="px-2 py-1 text-xs rounded border" onClick={()=> applyScope('night','sunhol',bulkNightVal)}>日祝</button>
        </div>
      </div>
      {head}
      <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap: '8px'}}>
        {cells}
      </div>
    </div>
  );
}

function TabbedMemberEditor({ year, month, half, cfg, members, setMembers }) {
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  // ★ 連勤上限の入力ドラフト（メンバー名ごとに一時保持）
  const [maxConsDraft, setMaxConsDraft] = useState({}); // { [memberName]: '文字列' }

  // アクティブ切替やメンバー更新時に、ドラフト未初期化なら現値を入れる
  useEffect(() => {
    const m = members[active];
    if (!m) return;
    setMaxConsDraft(prev =>
      Object.prototype.hasOwnProperty.call(prev, m.name)
        ? prev
        : { ...prev, [m.name]: String(m.max_consecutive ?? 3) }
    );
  }, [active, members]);

  const commitMaxConsecutive = (idx, name, raw, fallback) => {
    const v = parseInt(String(raw ?? '').replace(/[^\d]/g, ''), 10);
    const next = Number.isFinite(v) ? Math.max(1, Math.min(31, v)) : (fallback ?? 3);
    setMembers(prev => prev.map((m, i) => (i === idx ? { ...m, max_consecutive: next } : m)));
    setMaxConsDraft(prev => ({ ...prev, [name]: String(next) }));
  };  

  const add = () => setMembers((m) => [...m, { name: `Member${m.length + 1}`, availability: new Set(), desired_days_day: 1, desired_days_night: 1, preferred_slots: new Set(), max_consecutive: 3 }]);
  const remove = (idx) => setMembers((arr) => arr.filter((_, i) => i !== idx));
  const updateMember = (idx, patch) => setMembers((arr) => arr.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  const toggleAvailSlot = (idx, slotId) => {
    setMembers((arr) => {
      const copy = [...arr];
      const set = new Set(copy[idx].availability);
      if (set.has(slotId)) set.delete(slotId); else set.add(slotId);
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

  const bulkToggleAll = (idx, target) => {
    setMembers((arr) => {
      const copy = [...arr];
      const dmax = daysInMonth(year, month);
      const start = half === 'H1' ? 1 : 16;
      const end = half === 'H1' ? Math.min(15, dmax) : dmax;
      const avail = new Set(copy[idx].availability);
      const ids = [];
      for (let d = start; d <= end; d++) {
        const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        ids.push(`${iso}_${target}`);
      }
      const allOn = ids.every(id => avail.has(id));
      if (allOn) ids.forEach(id => avail.delete(id)); else ids.forEach(id => avail.add(id));
      copy[idx] = { ...copy[idx], availability: avail };
      return copy;
    });
  };

  const dmax = daysInMonth(year, month);
  const start = half === 'H1' ? 1 : 16;
  const end = half === 'H1' ? Math.min(15, dmax) : dmax;
  const firstDow = new Date(year, month - 1, 1).getDay();
  const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {members.map((m, idx) => (
          <button key={idx} type="button" onClick={() => { if (active === idx) setCollapsed(!collapsed); else { setActive(idx); setCollapsed(false); }}} className={`px-3 py-1 rounded border text-sm ${active === idx && !collapsed ? 'bg-blue-600 text-white' : 'bg-white'}`}>{m.name}</button>
        ))}
        <button type="button" className="px-3 py-1 rounded border text-sm" onClick={add}>+ 追加</button>
      </div>

      {members[active] && !collapsed && (
        <div className="rounded-xl border p-3 space-y-3">
          <div className="flex gap-2 items-center">
            <input className="border rounded px-2 py-1" value={members[active].name} onChange={(e) => updateMember(active, { name: e.target.value })} />
            <label className="text-sm text-gray-600 ml-auto">希望日数（昼）</label>
            <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={members[active].desired_days_day ?? 0} onChange={(e) => updateMember(active, { desired_days_day: parseInt(e.target.value || '0') })} />
            <label className="text-sm text-gray-600 ml-4">希望日数（夜）</label>
            <input type="number" min={0} className="w-20 border rounded px-2 py-1" value={members[active].desired_days_night ?? 0} onChange={(e) => updateMember(active, { desired_days_night: parseInt(e.target.value || '0') })} />
            <label className="text-sm text-gray-600 ml-4">連勤上限</label>
            <input type="number" min={1} className="w-20 border rounded px-2 py-1" value={members[active].max_consecutive ?? 3} onChange={(e) => updateMember(active, { max_consecutive: Math.max(1, parseInt(e.target.value || '3')) })} />
            <label className="text-sm text-gray-600 ml-4">連勤上限</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-20 border rounded px-2 py-1 text-right"
              value={maxConsDraft[members[active].name] ?? String(members[active].max_consecutive ?? 3)}
              onChange={(e) =>
                setMaxConsDraft(prev => ({ ...prev, [members[active].name]: e.target.value }))
              }
              onBlur={(e) =>
                commitMaxConsecutive(active, members[active].name, e.target.value, members[active].max_consecutive)
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur(); // Enterで確定
                }
              }}
            />            
            <button type="button" className="ml-4 px-2 py-1 text-xs rounded border bg-yellow-200" onClick={() => bulkToggleAll(active, 'DAY')}>昼 全選択/解除</button>
            <button type="button" className="px-2 py-1 text-xs rounded border bg-indigo-200" onClick={() => bulkToggleAll(active, 'NIGHT')}>夜 全選択/解除</button>
            <button type="button" className="text-red-600 ml-2" onClick={() => remove(active)}>削除</button>
          </div>

          <div className="text-xs text-gray-600">クリックで「勤務可能」を切り替え。チェックで「優先日」を指定できます（昼・夜それぞれ個別）。</div>

          <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
            {['日','月','火','水','木','金','土'].map((w) => (
              <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
            ))}
          </div>

          <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>
            {Array.from({length: totalCells}, (_, i) => i).map((i) => {
              const empty = i < firstDow || i - firstDow + 1 > dmax;
              if (empty) return <div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'120px'}}/>;
              const d = i - firstDow + 1;
              const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
              const inRange = d >= start && d <= end;
              const dayId = `${iso}_DAY`; const nightId = `${iso}_NIGHT`;
              const isAvailDay = members[active].availability.has(dayId);
              const isAvailNight = members[active].availability.has(nightId);
              const isPrefDay = members[active].preferred_slots.has(dayId);
              const isPrefNight = members[active].preferred_slots.has(nightId);
              return (
                <div key={iso} className={`border rounded p-2 ${inRange ? '' : 'opacity-40'}`} style={{minHeight:'120px', background: inRange ? weekendHolidayBg(iso) : undefined}}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">{d}</div>
                    <div className="text-xs text-gray-500">({['日','月','火','水','木','金','土'][new Date(year, month-1, d).getDay()]})</div>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs px-1.5 py-0.5 rounded border bg-yellow-200">昼</span>
                    <button type="button" disabled={!inRange} onClick={() => toggleAvailSlot(active, dayId)} className={`text-sm border rounded px-3 py-1 ${isAvailDay ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>{isAvailDay ? '勤務可能' : '未選択'}</button>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!inRange} checked={isPrefDay} onChange={(e)=> setPreferredSlot(active, dayId, e.target.checked)} /> 優先</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-1.5 py-0.5 rounded border bg-indigo-200">夜</span>
                    <button type="button" disabled={!inRange} onClick={() => toggleAvailSlot(active, nightId)} className={`text-sm border rounded px-3 py-1 ${isAvailNight ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>{isAvailNight ? '勤務可能' : '未選択'}</button>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!inRange} checked={isPrefNight} onChange={(e)=> setPreferredSlot(active, nightId, e.target.checked)} /> 優先</label>
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

function CountBadge({ current, required }) {
  const lack = current < required;
  return (
    <span className={`absolute top-1 right-1 text-[11px] leading-none px-1.5 py-0.5 rounded-full text-gray ${lack ? 'bg-red-600' : 'bg-green-600'}`}>{current}/{required}</span>
  );
}

function PeopleChips({ people = [], highlightName = "" }) {
  const firstRow = people.slice(0, 4);
  const rest = people.slice(4);

  const Chip = ({ name }) => (
    <span
      className={
        "inline-flex items-center justify-center px-1.5 py-0.5 rounded-full border " +
        "text-[11px] leading-[1.05] whitespace-nowrap " +
        (name === highlightName
          ? "border-amber-500 text-amber-700 bg-amber-50 font-semibold"
          : "border-gray-300 text-gray-700 bg-white")
      }
      title={name}
    >
      {name}
    </span>
  );

  return (
    <div className="space-y-1">
      {/* 上段：4名を必ず横一列（各25%幅） */}
      <div className="flex gap-1">
        {firstRow.map((p, i) => (
          <div
            key={`top-${i}`}
            className="basis-1/4 shrink-0 grow-0 min-w-0 flex justify-center"
          >
            <Chip name={p} />
          </div>
        ))}
      </div>

      {/* 5人目以降：普通に折り返して全員表示 */}
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rest.map((p, i) => (
            <Chip key={`rest-${i}`} name={p} />
          ))}
        </div>
      )}
    </div>
  );
}



function CombinedCandidateCard({ idx, dayAssn, nightAssn, slotsDay, slotsNight, onlyLack=false, year, month, half, highlightName='' }) {
  const [tab, setTab] = useState('calendar'); // 'calendar' | 'satisfaction'
  const fmtScore = (assn)=>{
    if(!assn) return '—';
    const minSat = Math.min(...Object.values(assn.satisfaction));
    const avgSat = Object.values(assn.satisfaction).reduce((a,b)=>a+b,0)/Object.values(assn.satisfaction).length;
    return `S ${assn.score.toFixed(3)} / 最低 ${Math.round(minSat*100)}% / 平均 ${Math.round(avgSat*100)}%`;
  };
  
  // ★ 候補カード用：不足合計（昼／夜／合計）を計算してバッジ表示
  const lackSum = (assn, slots) => {
    if (!assn) return 0;
    let t = 0;
    for (const s of slots) {
      const cur = assn.bySlot?.[s.id]?.length || 0;
      t += Math.max(0, (s.required || 0) - cur);
    }
    return t;
  };
  const lackDayTotal = useMemo(()=> lackSum(dayAssn, slotsDay), [dayAssn, slotsDay]);
  const lackNightTotal = useMemo(()=> lackSum(nightAssn, slotsNight), [nightAssn, slotsNight]);
  const lackTotal = lackDayTotal + lackNightTotal;

  const weekdayHead = (
    <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>
      {['日','月','火','水','木','金','土'].map((w) => (
        <div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>
      ))}
    </div>
  );

  const CalendarMerged = () => {
    const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16;
    const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    const firstDow = new Date(year, month - 1, 1).getDay();
    const totalCells = Math.ceil((firstDow + dmax) / 7) * 7;

    const slotDayByIso = Object.fromEntries((slotsDay||[]).map(s=>[s.iso,s]));
    const slotNightByIso = Object.fromEntries((slotsNight||[]).map(s=>[s.iso,s]));

    const cells = [];
    let day = 1;
    for (let i=0;i<totalCells;i++){
      const empty = i < firstDow || day > dmax;
      if (empty) { cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'110px'}}/>); continue; }
      const d = day++;
      const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const inRange = d >= start && d <= end;

      const sDay = slotDayByIso[iso];
      const sNight = slotNightByIso[iso];

      const peopleDay = (dayAssn && sDay) ? (dayAssn.bySlot[sDay.id] || []) : [];
      const peopleNight = (nightAssn && sNight) ? (nightAssn.bySlot[sNight.id] || []) : [];

      const reqDay = sDay?.required ?? 0;
      const reqNight = sNight?.required ?? 0;

      const lackDay = peopleDay.length < reqDay;
      const lackNight = peopleNight.length < reqNight;

      if (onlyLack && !(lackDay || lackNight)) { cells.push(<div key={iso} className="border rounded p-2 bg-gray-50" style={{minHeight:'110px'}}/>); continue; }

      cells.push(
        <div key={iso} className={`relative border rounded p-2 ${inRange ? '' : 'opacity-40'} ${(lackDay||lackNight) ? 'ring-2 ring-red-400' : ''}`} style={{minHeight:'110px', background: inRange ? weekendHolidayBg(iso) : undefined}}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">{d}</div>
            <div className="text-xs text-gray-500">({weekdayJ(iso)})</div>
          </div>

          <div className="space-y-1 text-xs">
            <div className={`relative rounded px-2 py-1 ${lackDay?'bg-red-50':'bg-green-50'}`}>
              <span className="inline-block mr-2 text-xs px-1.5 py-0.5 rounded border bg-yellow-200">昼</span>
              <CountBadge current={peopleDay.length} required={reqDay} />
              <div className={`mt-1 ${highlightName && peopleDay.includes(highlightName) ? 'ring-2 ring-amber-400 rounded' : ''}`}>
                <PeopleChips people={peopleDay} highlightName={highlightName} />
              </div>
            </div>

            <div className={`relative rounded px-2 py-1 ${lackNight?'bg-red-50':'bg-green-50'}`}>
              <span className="inline-block mr-2 text-xs px-1.5 py-0.5 rounded border bg-indigo-200">夜</span>
              <CountBadge current={peopleNight.length} required={reqNight} />
              <div className={`mt-1 ${highlightName && peopleNight.includes(highlightName) ? 'ring-2 ring-amber-400 rounded' : ''}`}>
                <PeopleChips people={peopleNight} highlightName={highlightName} />
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div>
        {weekdayHead}
        <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>
          {cells}
        </div>
      </div>
    );
  };

  const SatisfactionList = () => {
    const names = Array.from(new Set([
      ...(dayAssn ? Object.keys(dayAssn.satisfaction) : []),
      ...(nightAssn ? Object.keys(nightAssn.satisfaction) : []),
    ])).sort((a,b)=> a.localeCompare(b, 'ja'));

    return (
      <div className="space-y-2">
        {names.map((n) => {
          const sd = dayAssn ? dayAssn.satisfaction[n] : undefined;
          const sn = nightAssn ? nightAssn.satisfaction[n] : undefined;
          return (
            <div key={n} className="flex items-center gap-2">
              <div className="w-24 text-sm">{n}</div>
              <div className="flex-1 flex items-center gap-2">
                <span className="w-7 text-[11px] text-gray-600">昼</span>
                <Progress value={sd ?? 0} />
                <span className="w-10 text-right text-xs">{sd!=null ? Math.round(sd*100) : '-'}%</span>

                <span className="w-7 text-[11px] text-gray-600 ml-3">夜</span>
                <Progress value={sn ?? 0} />
                <span className="w-10 text-right text-xs">{sn!=null ? Math.round(sn*100) : '-'}%</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="rounded-2xl border p-4 bg-white shadow">
      <div className="flex items-center justify-between">
        <div className="font-semibold">候補 {idx + 1}（昼・夜）</div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${lackTotal>0 ? 'bg-red-600 text-white' : 'bg-green-600 text-white'}`}
            title={`昼 ${lackDayTotal} / 夜 ${lackNightTotal}`}
          >
            不足合計 {lackTotal}
          </span>
          <div className="text-xs text-gray-600">昼: {fmtScore(dayAssn)}　|　夜: {fmtScore(nightAssn)}</div>
        </div>
      </div>

      {/* タブ切替：カレンダー / 充足率 */}
      <div className="mt-3">
        <div className="inline-flex rounded-lg overflow-hidden border">
          <button
            type="button"
            onClick={() => setTab('calendar')}
            className={`px-3 py-1 text-sm ${tab==='calendar' ? 'bg-blue-600 text-white' : 'bg-white'}`}
          >
            カレンダー
          </button>
          <button
            type="button"
            onClick={() => setTab('satisfaction')}
            className={`px-3 py-1 text-sm border-l ${tab==='satisfaction' ? 'bg-blue-600 text-white' : 'bg-white'}`}
          >
            充足率
          </button>
        </div>

        {tab === 'calendar' ? (
         <div className="mt-3">
            <div className="text-sm text-gray-600 mb-1">カレンダー（不足=赤 / 充足=緑）</div>
            <CalendarMerged />
          </div>
        ) : (
          <div className="mt-3">
            <div className="text-sm text-gray-600 mb-1">充足率一覧（各メンバー・昼/夜）</div>
            <SatisfactionList />
          </div>
        )}
      </div>
    </div>
  );
}


function CandidateCard({ idx, assn, slots, viewMode='list', onlyLack=false, year, month, half, mode='昼', highlightName='' }) {
  const minSat = Math.min(...Object.values(assn.satisfaction));
  const avgSat = Object.values(assn.satisfaction).reduce((a, b) => a + b, 0) / Object.values(assn.satisfaction).length;
  const slotByIso = React.useMemo(() => Object.fromEntries(slots.map(s => [s.iso, s])), [slots]);

  const CalendarView = () => {
    const dmax = daysInMonth(year, month);
    const start = half === 'H1' ? 1 : 16; const end = half === 'H1' ? Math.min(15, dmax) : dmax;
    const firstDow = new Date(year, month - 1, 1).getDay();
    const totalCells = Math.ceil((firstDow + dmax) / 7) * 7; let day = 1;
    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      const empty = i < firstDow || day > dmax; if (empty) { cells.push(<div key={`e${i}`} className="border rounded p-2 bg-gray-50" style={{minHeight:'86px'}}/>); continue; }
      const d = day++; const iso = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`; const inRange = d >= start && d <= end;
      const slot = slotByIso[iso]; if (!inRange || !slot) { cells.push(<div key={iso} className="border rounded p-2" style={{minHeight:'86px'}}><div className="text-sm font-medium">{d}</div></div>); continue; }
      const people = assn.bySlot[slot.id] || []; const required = slot.required || 0; const lack = people.length < required; if (onlyLack && !lack) { cells.push(<div key={iso} className="border rounded p-2 bg-gray-50" style={{minHeight:'86px'}}/>); continue; }
      const selectedInCell = highlightName && people.includes(highlightName); const bg = lack ? '#FEE2E2' : '#DCFCE7';
      const maxShow = 4; const shown = people.slice(0, maxShow); const extra = people.length - shown.length;
      cells.push(
        <div key={iso} className={`relative border rounded p-2 ${selectedInCell ? 'ring-2 ring-amber-400' : ''}`} style={{minHeight:'86px', background:bg}}>
          <div className={`absolute top-1 right-1 text-[11px] px-1.5 py-0.5 rounded-full text-white ${lack ? 'bg-red-600' : 'bg-green-600'}`}>{people.length}/{required}</div>
          <div className="flex items-center justify-between mb-1 pr-12"><div className="text-sm font-medium">{d}</div><div className="text-xs text-gray-700">{mode}</div></div>
          <div className="text-xs leading-tight" title={people.join(', ')}>
            {shown.length>0 ? shown.map((p,i)=>(<div key={i} className={p===highlightName ? 'font-bold text-amber-700' : ''}>{p}</div>)) : '-'}
            {extra>0 && <div className="text-[10px] text-gray-600">+{extra} 名</div>}
          </div>
        </div>
      );
    }
    return (
      <div>
        <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))'}}>{['日','月','火','水','木','金','土'].map((w) => (<div key={w} className="text-center text-xs text-gray-600 py-1">{w}</div>))}</div>
        <div className="grid" style={{gridTemplateColumns:'repeat(7,minmax(0,1fr))', gap:'8px'}}>{cells}</div>
      </div>
    );
  };

  const ListView = () => (
    <div className="space-y-2 text-sm">
      {[...Object.entries(assn.bySlot)]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([sid, people]) => {
          if (!onlyLack) return true; const slot = slots.find((s) => s.id === sid); const required = slot?.required ?? 0; return people.length < required;
        })
        .map(([sid, people]) => { const slot = slots.find((s) => s.id === sid); const required = slot?.required ?? 0; const lack = people.length < required; return (
          <div key={sid} className={`flex justify-between border rounded px-2 py-1 ${lack ? 'bg-red-50 border-red-300' : ''}`}>
            <div>{slot?.label || sid}{lack && <span className="ml-2 text-red-600">不足: {required - people.length}人</span>}</div>
            <div className="flex items-center gap-2">
              <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded-full text-white ${lack ? 'bg-red-600' : 'bg-green-600'}`}>{people.length}/{required}</span>
              <PeopleChips people={people} highlightName={highlightName} />
            </div>
          </div>
        ); })}
    </div>
  );

  return (
    <div className="rounded-2xl border p-4 bg-white shadow">
      <div className="flex items-center gap-3 justify-between">
        <div className="font-semibold">候補 {idx + 1}（{mode}）</div>
        <div className="text-sm text-gray-600">スコア {assn.score.toFixed(3)}</div>
      </div>
      <div className="mt-3">
        <div className="text-sm text-gray-600 mb-1">{viewMode==='calendar' ? 'カレンダー（不足=赤 / 充足=緑）' : 'シフト別割当（不足は赤）'}</div>
        {viewMode==='calendar' ? <CalendarView /> : <ListView />}
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
