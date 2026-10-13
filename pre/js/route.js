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
const TRAIN_LEN = 37.5;          // 2량 1편성
const VMAX = 80 / 3.6;

/* [번호, 역명, 앞역과 거리(m), 형식, 레일면 높이(m, 지면=0)] — 역간거리는 노선도 기준 */
const STN_RAW = [
  ['201', '검단오류', 0, 'elev', 10], ['202', '왕길', 1300, 'elev', 10], ['203', '검단사거리', 1400, 'under', -15],
  ['204', '마전', 1100, 'under', -15], ['205', '완정', 800, 'under', -16], ['206', '독정', 900, 'under', -15],
  ['207', '검암', 1800, 'elev', 16], ['208', '검바위', 900, 'elev', 16], ['209', '아시아드경기장', 1100, 'under', -15],
  ['210', '서구청', 800, 'under', -15], ['211', '가정', 2200, 'under', -17], ['212', '가정중앙시장', 800, 'under', -16],
  ['213', '석남', 1200, 'under', -15], ['214', '서부여성회관', 800, 'under', -18], ['215', '인천가좌', 1100, 'under', -20],
  ['216', '가재울', 1100, 'under', -18], ['217', '주안국가산단', 1400, 'under', -16], ['218', '주안', 1000, 'under', -15],
  ['219', '시민공원', 1000, 'under', -16], ['220', '석바위시장', 1000, 'under', -17], ['221', '인천시청', 700, 'under', -18],
  ['222', '석천사거리', 800, 'under', -18], ['223', '모래내시장', 800, 'under', -17], ['224', '만수', 1100, 'under', -16],
  ['225', '남동구청', 1200, 'under', -15], ['226', '인천대공원', 1500, 'elev', 7], ['227', '운연', 1300, 'under', -12],
];
const STN = [];
{
  let s = 0;
  for (const [id, name, d, type, y] of STN_RAW) {
    s += d;
    STN.push({ id, name, s, type, y, s0: s - PLAT / 2, s1: s + PLAT / 2,
      stop: s + TRAIN_LEN / 2,          // 2량 열차는 4량 승강장의 1~2 위치(중앙)에 정차
      oppStop: s - TRAIN_LEN / 2 });
  }
}
const SID = Object.fromEntries(STN.map(st => [st.id, st]));
const S = id => SID[id].s;
const START = -400, END = S('227') + 450;

/* 곡선: [중심 s, 제한구간 길이(m), 반경 R, 방향(+1 우/-1 좌), 설계속도 km/h] — 선로개요도 위치 비례로 환산 */
const CURVES = [
  [S('202') + 406, 245, 1198, +1, 69], [S('202') + 896, 236, 801, -1, 70],
  [S('203') + 330, 230, 98, +1, 30], [S('203') + 770, 223, 298, -1, 55],
  [S('204') + 240, 152, 498, +1, 69], [S('204') + 560, 162, 218, +1, 50],
  [S('205') + 621, 153, 699, -1, 68],
  [S('206') + 540, 328, 238, -1, 50], [S('206') + 864, 373, 1199, +1, 60], [S('206') + 1242, 362, 1099, +1, 57],
  [S('207') + 441, 141, 298, -1, 60],
  [S('208') + 330, 209, 5999, +1, 58], [S('208') + 539, 209, 3499, -1, 59], [S('208') + 759, 209, 6000, +1, 62],
  [S('210') + 1562, 423, 1999, +1, 61],
  [S('211') + 245, 150, 103, -1, 30], [S('211') + 395, 150, 103, +1, 30],
  [S('215') + 330, 248, 98, +1, 30], [S('215') + 572, 213, 148, -1, 40], [S('215') + 781, 213, 4999, +1, 69],
  [S('216') + 400, 260, 198, -1, 45], [S('216') + 665, 260, 198, +1, 45], [S('216') + 994, 269, 498, -1, 56],
  [S('218') - 245, 170, 699, +1, 58], [S('218') + 240, 153, 358, -1, 60], [S('218') + 750, 170, 98, -1, 30],
  [S('219') + 710, 203, 4000, +1, 66],
  [S('221') + 200, 135, 999, -1, 72], [S('221') + 608, 126, 999, +1, 61],
  [S('223'), 308, 2999, -1, 48],
  [S('224') + 360, 217, 248, +1, 50], [S('224') + 590, 230, 103, -1, 30], [S('224') + 830, 230, 103, +1, 30],
  [S('225') + 375, 253, 10000, +1, 58], [S('225') + 600, 236, 1499, -1, 74],
  [S('225') + 745, 240, 198, -1, 40], [S('225') + 995, 240, 198, +1, 40],
  [S('226') + 200, 262, 263, +1, 50], [S('226') + 650, 262, 999, +1, 64], [S('226') + 910, 262, 158, -1, 45],
];
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
/* 종단 (레일면 높이 꺾은선) — 역 전후 60m 수평, 사이 구간은 중간 저점(배수) 또는 개요도 구배 */
const PROFILE = (() => {
  const P = [[START, 10]];
  const flat = st => { P.push([st.s - 60, st.y], [st.s + 60, st.y]); };
  for (let i = 0; i < STN.length; i++) {
    const st = STN[i], nx = STN[i + 1];
    flat(st);
    if (!nx) break;
    if (st.id === '202') { P.push([st.s + 420, 10], [st.s + 420 + 25 / 0.054, -15]); continue; }         // -54‰ 지하 진입
    if (st.id === '206') { P.push([st.s + 700, -15], [st.s + 700 + 31 / 0.055, 16]); continue; }         // +55‰ 아라뱃길 교량으로
    if (st.id === '208') { P.push([st.s + 300, 16], [st.s + 300 + 31 / 0.055, -15]); continue; }         // -55‰ 아시아드경기장으로
    if (st.id === '225') { P.push([nx.s - 834, -15], [nx.s - 834 + 22 / 0.052, 7]); continue; }         // +52‰ 지상 진출
    if (st.id === '226') { P.push([st.s + 60 + 19 / 0.034, -12]); continue; }          // -34‰ 운연 방면 지하
    if (st.type === 'under' && nx.type === 'under') {
      const d = nx.s - st.s, dip = d > 1000 ? 4 : 2.5;
      P.push([(st.s + nx.s) / 2, Math.min(st.y, nx.y) - dip]);
    }
  }
  P.push([END, STN[STN.length - 1].y]);
  return P;
})();

/* 건넘선 (선로개요도 101~114): [시작 s, 끝 s, '/'=본선(+u)→반대선 / '\'=반대선→본선] */
const XOVERS = [
  [S('201') - 115, S('201') - 79, '\\'], [S('201') + 55, S('201') + 91, '/'],
  [S('210') - 330, S('210') - 294, '\\'], [S('210') - 150, S('210') - 114, '/'],
  [S('214') - 115, S('214') - 79, '/'], [S('214') + 55, S('214') + 91, '\\'],
  [S('218') - 115, S('218') - 79, '\\'], [S('218') + 80, S('218') + 116, '/'],
  [S('221') - 115, S('221') - 79, '/'], [S('221') + 55, S('221') + 91, '\\'],
  [S('226') - 115, S('226') - 79, '/'], [S('227') - 115, S('227') - 79, '/'],
];
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
window.IC2 = {
  clamp, smooth, lerp, TRK, EYE, PLAT, TRAIN_LEN, VMAX, STN, SID, S, START, END, CURVES, SPEED_ZONES, curv, PROFILE,
  XOVERS, nearXover, CANAL, DS, NS, PX, PY, PZ, PH, F, at, Y, grade, ZC, PORTALS, DEPTH_ZONE, stationAt, zc, isUnder, PD, OUT_NEAR,
  limitAt, curLimit, limitAhead, nextStation, atStation, tunnelInfo, stationInfo,
};
})();
