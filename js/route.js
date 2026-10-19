/* =====================================================================
   인천2호선 노선 데이터 (route.js) — 3D 전면 전망과 운전 로직이 공유하는 단일 기준
   s = 검단오류역 중심 기준 거리(m), u = 노선 중심 기준 우측(+), v = 레일면 기준 높이
   ※ 일반 스크립트 (window.IC2). three.js 의존 없음
   ===================================================================== */
(function () {
'use strict';
/* =====================================================================
   0. 유틸
   ===================================================================== */
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/* =====================================================================
   1. 노선 데이터
      s = 검단오류역 중심 기준 거리(m), u = 노선 중심 기준 우측(+), v = 레일면 기준 높이
      본 열차는 하선(GD0, 201→227) = 진행방향 우측(+u) 선로
   ===================================================================== */
const TRK = 2.2;                 // 선로 중심 ↔ 노선 중심 (선간 4.4m)
const EYE = 2.3;                 // 레일면 위 운전자 눈높이
const PLAT = 75;                 // 승강장 길이 (4량 기준)
const TRAIN_LEN = 34.4;          // 2량 1편성 (연결면간 거리, 제원)
const VMAX = 80 / 3.6;

/* =====================================================================
   1a. 노선 데이터 (ROUTE_DATA) — route-editor.html 의 '코드 내보내기' 결과로 통째로 바꿔 넣을 수 있음
   위치 표기: '202+406' = 202역 중심에서 하선 방향 406m / '218-245' = 218역 중심 245m 앞
              'K3456.2' = 도면 거리정표(m) (chainage0 = 도면상 검단오류역 중심 거리정표) / 'START' 'END' = 노선 양 끝
   ===================================================================== */
/* ROUTE_DATA 시작 */
const ROUTE_DATA = {
  chainage0: 0,
  /* [번호, 역명, 앞역과 거리(m), 형식 'elev' 고가 | 'under' 지하, 레일면 높이(참고값, 실제 높이는 grades)] — 역간거리는 노선도 기준 */
  stations: [
  ['201', '검단오류', 0, 'elev', 10], ['202', '왕길', 1300, 'elev', 10], ['203', '검단사거리', 1400, 'under', -15],
  ['204', '마전', 1100, 'under', -15], ['205', '완정', 800, 'under', -16], ['206', '독정', 900, 'under', -15],
  ['207', '검암', 1800, 'elev', 16], ['208', '검바위', 900, 'elev', 16], ['209', '아시아드경기장', 1100, 'under', -15],
  ['210', '서구청', 800, 'under', -15], ['211', '가정', 2200, 'under', -17], ['212', '가정중앙시장', 800, 'under', -16],
  ['213', '석남', 1200, 'under', -15], ['214', '서부여성회관', 800, 'under', -18], ['215', '인천가좌', 1100, 'under', -20],
  ['216', '가재울', 1100, 'under', -18], ['217', '주안국가산단', 1400, 'under', -16], ['218', '주안', 1000, 'under', -15],
  ['219', '시민공원', 1000, 'under', -16], ['220', '석바위시장', 1000, 'under', -17], ['221', '인천시청', 700, 'under', -18],
  ['222', '석천사거리', 800, 'under', -18], ['223', '모래내시장', 800, 'under', -17], ['224', '만수', 1100, 'under', -16],
  ['225', '남동구청', 1200, 'under', -15], ['226', '인천대공원', 1500, 'elev', 7], ['227', '운연', 1300, 'under', -12],
  ],
  /* 곡선: [중심 위치, 제한구간 길이(m), 반경 R, 방향(+1 우/-1 좌), 설계속도 km/h] — 선로개요도 위치 비례로 환산 */
  curves: [
  ['202+406', 245, 1198, +1, 69], ['202+896', 236, 801, -1, 70],
  ['203+330', 230, 98, +1, 30], ['203+770', 223, 298, -1, 55],
  ['204+240', 152, 498, +1, 69], ['204+560', 162, 218, +1, 50],
  ['205+621', 153, 699, -1, 68],
  ['206+540', 328, 238, -1, 50], ['206+864', 373, 1199, +1, 60], ['206+1242', 362, 1099, +1, 57],
  ['207+441', 141, 298, -1, 60],
  ['208+330', 209, 5999, +1, 58], ['208+539', 209, 3499, -1, 59], ['208+759', 209, 6000, +1, 62],
  ['210+1562', 423, 1999, +1, 61],
  ['211+245', 150, 103, -1, 30], ['211+395', 150, 103, +1, 30],
  ['215+330', 248, 98, +1, 30], ['215+572', 213, 148, -1, 40], ['215+781', 213, 4999, +1, 69],
  ['216+400', 260, 198, -1, 45], ['216+665', 260, 198, +1, 45], ['216+994', 269, 498, -1, 56],
  ['218-245', 170, 699, +1, 58], ['218+240', 153, 358, -1, 60], ['218+750', 170, 98, -1, 30],
  ['219+710', 203, 4000, +1, 66],
  ['221+200', 135, 999, -1, 72], ['221+608', 126, 999, +1, 61],
  ['223', 308, 2999, -1, 48],
  ['224+360', 217, 248, +1, 50], ['224+590', 230, 103, -1, 30], ['224+830', 230, 103, +1, 30],
  ['225+375', 253, 10000, +1, 58], ['225+600', 236, 1499, -1, 74],
  ['225+745', 240, 198, -1, 40], ['225+995', 240, 198, +1, 40],
  ['226+200', 262, 263, +1, 50], ['226+650', 262, 999, +1, 64], ['226+910', 262, 158, -1, 45],
  ],
  /* 종단: 시작 높이 y0(START 지점 레일면, m) + [시작 위치, 구배 ‰, 길이 m, 메모] — 구간 사이는 수평, 꺾이는 곳은 종곡선으로 다듬음
     ※ 개요도는 축척이 없어 각 구배 구간의 위치·길이는 개요도상 비례로 추정. 역 전후 60m는 수평 */
  grades: {
    y0: 6.88,
    rows: [
      ['START', 52, 60, '차량기지 → 검단오류'],
      ['202+420', -54, 462.963, '왕길 → 검단사거리 (지하 진입, 개요도의 47은 미적용)'],
      ['204+445', -26, 150, '마전 → 완정'],
      ['206+700', 55, 634.5455, '독정 → 검암 (아라뱃길 교량으로)'],
      ['207+360', 29, 140, '검암 → 검바위 (값 확인됨, 길이 추정)'],
      ['208+300', -55, 637.4545, '검바위 → 아시아드경기장'],
      ['210+1310', -19, 280, '서구청 → 가정'],
      ['214+582', -27, 266, '서부여성회관 → 인천가좌'],
      ['218+123', 22, 395, '주안 → 시민공원'],
      ['220+380', 26, 257, '석바위시장 → 인천시청'],
      ['221+259', -25, 382, '인천시청 → 석천사거리'],
      ['224+515', -32, 241, '만수 → 남동구청 (확인됨)'],
      ['224+756', 32, 241, '〃 V자로 다시 상승'],
      ['225+538', 52, 551.5385, '남동구청 → 인천대공원 (인천대공원 647m 전 지상 진출)'],
      ['226+60', -34, 558.8235, '인천대공원 → 운연 (지하)'],
    ],
  },
  /* 건넘선 (선로개요도 101~114): [시작 위치, 끝 위치, '/'=본선(+u)→반대선 / '\\'=반대선→본선] */
  xovers: [
  ['201-115', '201-79', '\\'], ['201+55', '201+91', '/'],
  ['210-330', '210-294', '\\'], ['210-150', '210-114', '/'],
  ['214-115', '214-79', '/'], ['214+55', '214+91', '\\'],
  ['218-115', '218-79', '\\'], ['218+80', '218+116', '/'],
  ['221-115', '221-79', '/'], ['221+55', '221+91', '\\'],
  ['226-115', '226-79', '/'], ['227-115', '227-79', '/'],
  ],
};
/* ROUTE_DATA 끝 */

/* =====================================================================
   1b. 노선 생성 — build(DATA) 가 3D·운전 로직이 쓰는 IC2 객체를 만든다 (편집기도 같은 함수로 미리보기)
   ===================================================================== */
function build(DATA) {
const STN = [];
{
  let s = 0;
  for (const [id, name, d, type, y] of DATA.stations) {
    s += d;
    STN.push({ id, name, s, type, y, s0: s - PLAT / 2, s1: s + PLAT / 2,
      stop: s + TRAIN_LEN / 2,          // 2량 열차는 4량 승강장의 1~2 위치(중앙)에 정차
      oppStop: s - TRAIN_LEN / 2 });
  }
}
const SID = Object.fromEntries(STN.map(st => [st.id, st]));
const S = id => SID[id].s;
const START = -400, END = STN[STN.length - 1].s + 450;
const pos = p => {               // 위치 표기 → s
  if (typeof p === 'number' && isFinite(p)) return p;
  const t = String(p).trim();
  if (t === 'START') return START;
  if (t === 'END') return END;
  let m = /^K\s*(-?\d+(?:\.\d+)?)$/i.exec(t);
  if (m) return +m[1] - (+DATA.chainage0 || 0);
  m = /^(\d+)\s*(?:([+-])\s*(\d+(?:\.\d+)?))?$/.exec(t);
  if (m && SID[m[1]]) return S(m[1]) + (m[2] ? (m[2] === '-' ? -1 : 1) * +m[3] : 0);
  throw new Error(`위치 표기 오류: "${p}"`);
};
const CURVES = DATA.curves.map(([p, w, R, dir, v]) => [pos(p), +w, +R, dir < 0 ? -1 : 1, +v]);
const SPEED_ZONES = CURVES.map(([c, w, , , v]) => ({ a: c - w / 2, b: c + w / 2, v: v / 3.6 }));
function curv(s) {
  let k = 0;
  for (const [c, w, R, dir] of CURVES) {
    const arc = Math.max(60, w - 40), T = Math.min(25, arc * 0.2), a = c - arc / 2, b = c + arc / 2;
    if (s <= a - T || s >= b + T) continue;
    const f = s < a ? (s - (a - T)) / T : s > b ? ((b + T) - s) / T : 1;
    k += dir / R * f;
  }
  return k;
}
/* 종단 (레일면 높이 꺾은선) */
const PROFILE = (() => {
  const P = [];
  let y = +DATA.grades.y0;
  const knot = (s, yy) => { const L = P[P.length - 1]; if (L && Math.abs(L[0] - s) < 1e-6) L[1] = yy; else P.push([s, yy]); };
  knot(START, y);
  const rows = DATA.grades.rows.map(([p, g, len]) => [pos(p), +g / 1000, +len]).sort((a, b) => a[0] - b[0]);
  for (const [s0, g, len] of rows) {
    if (s0 < P[P.length - 1][0] - 1e-6) throw new Error(`구배 구간이 겹침: s=${s0.toFixed(1)}`);
    knot(s0, y); y += g * len; knot(s0 + len, y);
  }
  if (END > P[P.length - 1][0]) knot(END, y);
  return P;
})();

/* 건넘선: [시작 s, 끝 s, '/'=본선(+u)→반대선 / '\'=반대선→본선] */
const XOVERS = DATA.xovers.map(([a, b, d]) => [pos(a), pos(b), d]);
const nearXover = (s, m) => XOVERS.some(([a, b]) => s > a - m && s < b + m);
const CANAL = S('206') + 1500;   // 아라뱃길 횡단 (교량)

/* =====================================================================
   2. 경로 적분 (1m 간격) + 구간 분류
   ===================================================================== */
const DS = 1;
const NS = Math.round((END - START) / DS) + 1;
const PX = new Float64Array(NS), PY = new Float64Array(NS), PZ = new Float64Array(NS), PH = new Float64Array(NS);
{
  // 종단: 꺾은선 → 이동평균 2회 (종곡선)
  const raw = new Float64Array(NS);
  let j = 0;
  for (let i = 0; i < NS; i++) {
    const s = START + i * DS;
    while (j < PROFILE.length - 2 && s > PROFILE[j + 1][0]) j++;
    const [s0, y0] = PROFILE[j], [s1, y1] = PROFILE[j + 1];
    raw[i] = y0 + (y1 - y0) * clamp((s - s0) / (s1 - s0), 0, 1);
  }
  const box = (src, r) => {
    const out = new Float64Array(NS); let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[clamp(i, 0, NS - 1)];
    for (let i = 0; i < NS; i++) { out[i] = acc / (2 * r + 1); acc += src[clamp(i + r + 1, 0, NS - 1)] - src[clamp(i - r, 0, NS - 1)]; }
    return out;
  };
  const ys = box(box(raw, 22), 22);
  let x = 0, z = 0, h = 0;
  for (let i = 0; i < NS; i++) {
    const s = START + i * DS;
    PX[i] = x; PY[i] = ys[i]; PZ[i] = z; PH[i] = h;
    const k = curv(s + DS / 2), hm = h + k * DS / 2;
    x += Math.sin(hm) * DS; z -= Math.cos(hm) * DS; h += k * DS;
  }
  const i0 = Math.round(-START / DS), ox = PX[i0], oz = PZ[i0];
  for (let i = 0; i < NS; i++) { PX[i] -= ox; PZ[i] -= oz; }
}
const F = { x: 0, y: 0, z: 0, h: 0 };
function at(s) {
  const f = clamp((s - START) / DS, 0, NS - 1.0001), i = Math.floor(f), t = f - i;
  F.x = PX[i] + (PX[i + 1] - PX[i]) * t; F.y = PY[i] + (PY[i + 1] - PY[i]) * t;
  F.z = PZ[i] + (PZ[i + 1] - PZ[i]) * t; F.h = PH[i] + (PH[i + 1] - PH[i]) * t;
  return F;
}
const Y = s => at(s).y;
for (const st of STN) st.y = Y(st.s);           // 역 레일면 높이는 종단(구배 적용) 결과를 따름
const grade = s => (Y(s + 2) - Y(s - 2)) / 4;
/* 구간 코드 (1m 단위)
   0 고가교 / 1 고가역 / 2 U형 개착 / 3 박스 터널 / 4 원형 터널 / 5 지하역 승강장 */
const ZC = new Uint8Array(NS);
const PORTALS = [];      // { s, dir: 터널 쪽 방향(+1: s 증가 방향) }
const DEPTH_ZONE = { VIA: 2.6, TUN: -5.3 };
const stationAt = s => STN.find(st => s > st.s - 160 && s < st.s + 160);
{
  for (let i = 0; i < NS; i++) {
    const s = START + i * DS, y = PY[i], st = stationAt(s);
    if (st && st.type === 'elev' && Math.abs(s - st.s) <= PLAT / 2 + 14) ZC[i] = 1;
    else if (st && st.type === 'under' && Math.abs(s - st.s) <= PLAT / 2) ZC[i] = 5;
    else if (y > DEPTH_ZONE.VIA) ZC[i] = 0;
    else if (y > DEPTH_ZONE.TUN) ZC[i] = 2;
    else ZC[i] = 4;
  }
  for (let i = 1; i < NS; i++) {
    const a = ZC[i - 1], b = ZC[i];
    if (a === 2 && b >= 3) PORTALS.push({ s: START + i * DS, dir: +1 });
    if (a >= 3 && b === 2) PORTALS.push({ s: START + i * DS, dir: -1 });
  }
  const boxes = [];
  for (const st of STN) if (st.type === 'under') boxes.push([st.s - (st.id === '210' ? 380 : 127.5), st.s + 127.5]);
  for (const p of PORTALS) boxes.push(p.dir > 0 ? [p.s, p.s + 110] : [p.s - 110, p.s]);
  for (let i = 0; i < NS; i++) {
    const s = START + i * DS;
    if (ZC[i] === 4 && boxes.some(([a, b]) => s >= a && s < b)) ZC[i] = 3;
  }
}
const zc = s => ZC[clamp(Math.round((s - START) / DS), 0, NS - 1)];
const isUnder = c => c >= 3;
/* 가장 가까운 갱구까지 거리 (지하 쪽) */
const PD = new Float32Array(NS).fill(1e9);
for (const p of PORTALS) {
  const i0 = Math.round((p.s - START) / DS);
  for (let d = 0; d < 200; d++) { const i = i0 + p.dir * d; if (i >= 0 && i < NS) PD[i] = Math.min(PD[i], d); }
}
/* 실외 인접 청크 판정 (지면/주변 경관 생성 범위) */
const OUT_NEAR = new Uint8Array(NS);
{
  let last = -1e9;
  for (let i = 0; i < NS; i++) { if (!isUnder(ZC[i])) last = i; if (i - last < 1500) OUT_NEAR[i] = 1; }
  last = 1e9;
  for (let i = NS - 1; i >= 0; i--) { if (!isUnder(ZC[i])) last = i; if (last - i < 1500) OUT_NEAR[i] = 1; }
}

/* ---------- 운전 로직 공용 함수 ---------- */
function limitAt(x) { let v = VMAX; for (const z of SPEED_ZONES) if (x >= z.a && x <= z.b && z.v < v) v = z.v; return v; }
function curLimit(s) { let v = VMAX; for (let x = s - TRAIN_LEN; x <= s; x += 5) v = Math.min(v, limitAt(x)); return v; }
const nextStation = s => STN.find(st => st.stop > s + 0.5) ?? null;
const atStation = s => STN.find(st => Math.abs(st.stop - s) < 1.0);
/* 전방 제한속도를 감속도 b로 미리 따라가는 목표속도 (m/s) — 곡선 설계속도 준수용 */
function limitAhead(s, b = 0.6) {
  let vt = curLimit(s);
  for (let d = 5; d <= 600; d += 10) { const vl = limitAt(s + d); vt = Math.min(vt, Math.sqrt(vl * vl + 2 * b * d)); }
  return vt;
}
/* index.html 호환: 터널 진입/진출 거리 (m) */
function tunnelInfo(s) {
  const inside = isUnder(zc(s));
  let entry = 1e9, exit = 1e9;
  for (const p of PORTALS) {
    if (p.s < s) continue;
    if (p.dir > 0 && entry === 1e9) entry = p.s - s;
    if (p.dir < 0 && exit === 1e9) exit = p.s - s;
  }
  return { inside, entry, exit };
}
/* index.html 호환: 다음(또는 현재) 정차역 승강장까지 거리 */
function stationInfo(s) {
  let idx = STN.findIndex(st => st.s1 > s);
  if (idx < 0) idx = STN.length - 1;
  const st = STN[idx];
  return { dStart: st.s0 - s, dEnd: st.s1 - s, dStop: st.stop - s, name: st.name, eng: st.eng || '', id: st.id,
    type: st.type === 'under' ? 'TUNNEL' : 'GROUND', platformSide: 'R', index: idx };
}
/* ---------- 운행 방향 (하선 +1: 201→227 / 상선 -1: 227→201) ----------
   운전 로직은 진행방향 거리 p(값이 커지는 쪽 = 진행방향)로 동작하고, 3D는 실제 위치 s = P.toS(p)를 씀.
   상선은 반대편(-u) 선로를 달리며 승강장은 하선과 같이 진행방향 우측. 제한속도는 하선과 동일 구간 적용 */
const P = { dir: 1, START, END };
const mir = x => START + END - x;
P.toS = p => P.dir > 0 ? p : mir(p);
P.toP = P.toS;
P.setDir = d => {
  P.dir = d < 0 ? -1 : 1;
  P.STN = P.dir > 0 ? STN : STN.slice().reverse().map(st => ({ ...st,
    s: mir(st.s), s0: mir(st.s1), s1: mir(st.s0), stop: mir(st.oppStop), oppStop: mir(st.stop) }));
};
P.setDir(1);
P.curv = p => P.dir * curv(P.toS(p));                  // 진행방향 기준 (+: 우곡선)
P.grade = p => P.dir * grade(P.toS(p));                // 진행방향 기준 (+: 상구배)
P.limitAt = p => limitAt(P.toS(p));
P.curLimit = p => { let v = VMAX; for (let x = p - TRAIN_LEN; x <= p; x += 5) v = Math.min(v, P.limitAt(x)); return v; };
P.limitAhead = (p, b = 0.6) => {
  let vt = P.curLimit(p);
  for (let d = 5; d <= 600; d += 10) { const vl = P.limitAt(p + d); vt = Math.min(vt, Math.sqrt(vl * vl + 2 * b * d)); }
  return vt;
};
P.nextStation = p => P.STN.find(st => st.stop > p + 0.5) ?? null;
P.atStation = p => P.STN.find(st => Math.abs(st.stop - p) < 1.0);
P.tunnelInfo = p => {
  const inside = isUnder(zc(P.toS(p)));
  let entry = 1e9, exit = 1e9;
  const ps = PORTALS.map(o => ({ p: P.toP(o.s), dir: o.dir * P.dir })).sort((a, b) => a.p - b.p);
  for (const o of ps) {
    if (o.p < p) continue;
    if (o.dir > 0 && entry === 1e9) entry = o.p - p;
    if (o.dir < 0 && exit === 1e9) exit = o.p - p;
  }
  return { inside, entry, exit };
};
P.stationInfo = p => {
  let idx = P.STN.findIndex(st => st.s1 > p);
  if (idx < 0) idx = P.STN.length - 1;
  const st = P.STN[idx];
  return { dStart: st.s0 - p, dEnd: st.s1 - p, dStop: st.stop - p, name: st.name, eng: st.eng || '', id: st.id,
    type: st.type === 'under' ? 'TUNNEL' : 'GROUND', platformSide: 'R', index: idx };
};

return {
  clamp, smooth, lerp, TRK, EYE, PLAT, TRAIN_LEN, VMAX, STN, SID, S, START, END, CURVES, SPEED_ZONES, curv, PROFILE,
  XOVERS, nearXover, CANAL, DS, NS, PX, PY, PZ, PH, F, at, Y, grade, ZC, PORTALS, DEPTH_ZONE, stationAt, zc, isUnder, PD, OUT_NEAR,
  limitAt, curLimit, limitAhead, nextStation, atStation, tunnelInfo, stationInfo, P, pos, DATA,
};
}

/* 편집기 미리보기: 주소에 ?route=custom 이 있으면 route-editor.html 이 이 브라우저에 저장한 경로를 사용 */
function loadCustom() {
  try {
    if (typeof location === 'undefined' || new URLSearchParams(location.search).get('route') !== 'custom') return null;
    const d = JSON.parse(localStorage.getItem('ic2.routeData') || 'null');
    return d && Array.isArray(d.stations) ? d : null;
  } catch (e) { return null; }
}
let IC2 = null;
const custom = loadCustom();
if (custom) {
  try { IC2 = build(custom); IC2.custom = true; } catch (e) { console.warn('[route] 편집 경로를 쓸 수 없어 기본 노선을 사용합니다:', e); }
}
window.IC2 = IC2 || build(ROUTE_DATA);
window.IC2_DEFAULT = ROUTE_DATA;
window.IC2_build = build;
})();
