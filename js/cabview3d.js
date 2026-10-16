/* =====================================================================
   인천2호선 3D 전면 전망 (cabview3d.js) — ES 모듈
   사용: <div id="cab3d-stage"></div> + route.js 로드 후 이 모듈 로드
         매 프레임 CabView3D.update({ s, v, rain, wiper, headlight, doorsOpen }) 호출
   - Three.js r160, 외부 이미지 없음 (텍스처 캔버스 생성)
   - 열차 주변 약 1.3km만 150m 청크로 생성/해제, 그림자 없음, 지하 조명은 정점 색으로 굽기
   ===================================================================== */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const { clamp, smooth, lerp, TRK, EYE, PLAT, TRAIN_LEN, VMAX, STN, SID, S, START, END, CURVES, SPEED_ZONES, curv, XOVERS, nearXover, CANAL, DS, NS, F, at, Y, grade, ZC, PORTALS, stationAt, zc, isUnder, PD, OUT_NEAR, limitAt } = window.IC2;
/* =====================================================================
   0. 유틸
   ===================================================================== */
let _seed = 20240917;
const rnd = () => { _seed = (_seed * 16807) % 2147483647; return (_seed - 1) / 2147483646; };
const rr = (a, b) => a + (b - a) * rnd();
const reseed = n => { _seed = (Math.abs(Math.floor(n)) * 7919 + 104729) % 2147483646 + 1; };

/* 외부(운전 로직)에서 받는 열차 상태 */
const train = { s: SID['201'].stop, v: 0 };
/* 화면 구성: 3D(WebGL) / 전면창 효과(와이퍼·빗방울) / 운전실 창틀 */
const STAGE = document.getElementById('cab3d-stage') || document.body;
for (const id of ['c3d-gl', 'c3d-fx', 'c3d-cab']) {
  const c = document.createElement('canvas'); c.id = id;
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;' + (id === 'c3d-gl' ? '' : 'pointer-events:none;');
  STAGE.appendChild(c);
}
if (getComputedStyle(STAGE).position === 'static') STAGE.style.position = 'relative';
/* 청크 원점 (float32 정밀도 보호: 청크 내부 좌표를 작게 유지) */
let OX = 0, OY = 0, OZ = 0;
function W(s, u, v, out) {
  at(s); out.set(F.x + Math.cos(F.h) * u - OX, F.y + v - OY, F.z + Math.sin(F.h) * u - OZ); return out;
}
function Wabs(s, u, v, out) {
  at(s); out.set(F.x + Math.cos(F.h) * u, F.y + v, F.z + Math.sin(F.h) * u); return out;
}
const _bR = new THREE.Vector3(), _bU = new THREE.Vector3(0, 1, 0), _bB = new THREE.Vector3();
function basisAt(s, m) {
  at(s); const c = Math.cos(F.h), sn = Math.sin(F.h);
  _bR.set(c, 0, sn); _bB.set(-sn, 0, c);       // 로컬 X=우측, Y=위, Z=후방
  return m.makeBasis(_bR, _bU, _bB);
}

/* =====================================================================
   2b. 지하 조명 (정점 색으로 굽기)
   ===================================================================== */
const TUN_R = 5.3, TUN_CY = 0.95;           // 원형 터널 반경/중심높이
const BOX_W = 4.9, BOX_H = 5.3;             // 박스 터널 반폭/천장
const LAMP = { round: { sp: 9, u: 4.72, v: 3.2 }, box: { sp: 6, u: 4.75, v: 4.1 } };
function lampField(s, u, v, L) {
  let sum = 0;
  for (const side of [-1, 1]) {
    const o = side > 0 ? 0 : L.sp / 2, n = Math.round((s - o) / L.sp);
    for (let k = n - 1; k <= n + 1; k++) {
      const ds = s - (o + k * L.sp), du = u - side * L.u, dv = v - L.v;
      sum += 1 / (1 + (ds * ds + du * du + dv * dv) / 4.5);
    }
  }
  return sum;
}
function lightAt(s, u, v) {
  const c = zc(s);
  if (!isUnder(c)) return 1;
  let L = c === 4 ? 0.03 + 0.19 * lampField(s, u, v, LAMP.round) : 0.03 + 0.13 * lampField(s, u, v, LAMP.box);
  const pd = PD[clamp(Math.round((s - START) / DS), 0, NS - 1)];
  if (pd < 200) L += 0.7 * Math.exp(-pd / 9);              // 갱구 주광
  const st = stationAt(s);
  if (st && st.type === 'under') {
    const k = smooth(st.s0 - 22, st.s0 + 2, s) * (1 - smooth(st.s1 - 2, st.s1 + 22, s));
    const au = Math.abs(u);
    const sv = au > 3.72 && c === 5 ? 0.95 : 0.26 + 0.16 * smooth(2.0, 3.7, au) * (c === 5 ? 1 : 0.4) + (v > 3.4 ? 0.06 : 0);
    L = lerp(L, sv, k);
  }
  return Math.min(L, 1.6);
}

/* =====================================================================
   3. 렌더러 / 씬
   ===================================================================== */
const Q = new URLSearchParams(location.search);
const glCanvas = document.getElementById('c3d-gl'), cabCanvas = document.getElementById('c3d-cab');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: Q.get('aa') !== '0', powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const scene = new THREE.Scene();
const FOG_OUT = new THREE.Color('#d3dbe0'), FOG_IN = new THREE.Color('#151617'), FOG_RAIN = new THREE.Color('#9aa4ab');
scene.fog = new THREE.FogExp2(FOG_OUT.clone(), 0.0011);
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.25, 1800);
const hemi = new THREE.HemisphereLight(0xdfe9f3, 0x6a6553, 1.9);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.3);
sun.position.set(-0.45, 1, -0.35).multiplyScalar(100);
scene.add(hemi, sun);

/* =====================================================================
   4. 캔버스 텍스처
   ===================================================================== */
function canvasTex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}
function speckle(g, w, h, n, a, dark = true) {
  for (let i = 0; i < n; i++) {
    const l = dark ? rr(0, 60) : rr(160, 255);
    g.fillStyle = `rgba(${l},${l},${l},${rr(0.02, a)})`;
    const s = rr(0.6, 2.2); g.fillRect(rr(0, w), rr(0, h), s, s);
  }
}
function blotches(g, w, h, n, color, a, rmin, rmax) {
  for (let i = 0; i < n; i++) {
    const x = rr(0, w), y = rr(0, h), r = rr(rmin, rmax);
    for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      gr.addColorStop(0, color.replace('A', rr(a * 0.4, a))); gr.addColorStop(1, color.replace('A', 0));
      g.fillStyle = gr; g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
}
const T = {};
T.concrete = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#a3a39e'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 26, 'rgba(70,70,62,A)', 0.10, 20, 70);
  blotches(g, w, h, 16, 'rgba(230,230,225,A)', 0.10, 20, 60);
  speckle(g, w, h, 3500, 0.22); speckle(g, w, h, 900, 0.15, false);
  g.fillStyle = 'rgba(60,60,55,.25)'; g.fillRect(0, h - 2, w, 2);       // 거푸집 이음
});
T.slab = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#8f8d87'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 30, 'rgba(60,55,48,A)', 0.16, 15, 60);
  speckle(g, w, h, 4500, 0.28);
  g.fillStyle = 'rgba(40,38,34,.28)'; g.fillRect(0, 0, w, 3);          // 슬래브 신축 줄눈
});
T.lining = canvasTex(256, 256, (g, w, h) => {   // 터널 세그먼트 라이닝 (가로=단면 둘레 6m, 세로=길이 1.5m)
  g.fillStyle = '#b4b5b2'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 30, 'rgba(80,80,74,A)', 0.14, 15, 70);
  blotches(g, w, h, 10, 'rgba(110,100,80,A)', 0.10, 30, 90);        // 누수 얼룩
  speckle(g, w, h, 3000, 0.2);
  g.fillStyle = 'rgba(50,50,48,.55)'; g.fillRect(0, 0, w, 3);         // 링 이음
  g.fillStyle = 'rgba(50,50,48,.35)'; g.fillRect(w / 2, 0, 2, h);     // 세그먼트 이음
});
T.ground = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#6f7748'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 60, 'rgba(140,135,95,A)', 0.35, 20, 80);   // 흙
  blotches(g, w, h, 60, 'rgba(60,85,40,A)', 0.35, 20, 90);     // 짙은 풀
  speckle(g, w, h, 9000, 0.18); speckle(g, w, h, 4000, 0.12, false);
});
T.road = canvasTex(256, 256, (g, w, h) => {   // 폭 14m 도로 (가로=폭, 세로=길이)
  g.fillStyle = '#55575a'; g.fillRect(0, 0, w, h);
  speckle(g, w, h, 6000, 0.25); speckle(g, w, h, 1500, 0.12, false);
  g.fillStyle = '#d8b13a'; g.fillRect(w / 2 - 4, 0, 3, h); g.fillRect(w / 2 + 1, 0, 3, h);
  g.fillStyle = '#e8e8e8'; g.fillRect(8, 0, 3, h); g.fillRect(w - 11, 0, 3, h);
  for (const x of [w * 0.25, w * 0.75]) for (let y = 0; y < h; y += 64) g.fillRect(x - 1, y, 3, 34);
});
T.tile = canvasTex(256, 256, (g, w, h) => {   // 화강석 바닥 (2.4m 반복, 0.6m 판)
  g.fillStyle = '#c9c9c6'; g.fillRect(0, 0, w, h);
  speckle(g, w, h, 9000, 0.35); speckle(g, w, h, 3000, 0.3, false);
  g.strokeStyle = 'rgba(90,90,90,.35)'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
});
T.ceiling = canvasTex(256, 256, (g, w, h) => {   // 격자형 천장판 (1.2m)
  g.fillStyle = '#e9ecee'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(120,125,130,.6)'; g.lineWidth = 3;
  g.strokeRect(0, 0, w, h); g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
});
T.wallTile = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#e6e5e0'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(150,150,145,.6)'; g.lineWidth = 2;
  for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, h); g.stroke(); }
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
});
T.header = canvasTex(64, 256, (g, w, h) => {   // PSD 상부 은색 곡면 헤더 (세로 그라데이션)
  const gr = g.createLinearGradient(0, h, 0, 0);
  gr.addColorStop(0, '#9fa3a6'); gr.addColorStop(0.25, '#d6d9db'); gr.addColorStop(0.6, '#b9bdc0'); gr.addColorStop(1, '#8e9295');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(60,60,60,.5)'; g.fillRect(0, 0, 2, h);   // 패널 이음
});
/* PSD 모듈 3.6m × 2.35m : 고정창(광고) + 양개문, 주황 문틀, 주황 상단띠 */
const PSD_MOD = 3.6, PSD_H = 2.35;
function makePSDTex(ads) {
  return canvasTex(1024, 668, (g, w, h) => {
    const m = w / PSD_MOD;                    // px per m
    const X = x => x * m, Yp = y => h - y * m;
    g.clearRect(0, 0, w, h);
    // 유리 (반투명)
    g.fillStyle = 'rgba(62,80,88,0.40)'; g.fillRect(0, 0, w, h);
    // 고정창 광고 (0.12~1.02m)
    if (ads) {
      const hue = Math.floor(rr(0, 360));
      g.fillStyle = `hsla(${hue},55%,42%,0.92)`; g.fillRect(X(0.14), Yp(2.0), X(0.86), X(0.95));
      g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `bold ${X(0.11)}px 'Malgun Gothic'`;
      g.fillText('인천2호선', X(0.2), Yp(1.72)); g.font = `${X(0.07)}px 'Malgun Gothic'`;
      g.fillText('역세권 광고', X(0.2), Yp(1.6));
      g.fillStyle = 'rgba(240,140,30,.95)'; g.fillRect(X(0.14), Yp(1.12), X(0.86), X(0.12));
    }
    // 프레임 (은색) + 하부 씰
    g.fillStyle = '#c9cccf';
    g.fillRect(0, Yp(0.12), w, X(0.12));
    g.fillRect(0, 0, X(0.07), h); g.fillRect(w - X(0.07), 0, X(0.07), h);
    // 문짝 (1.1 ~ 2.5m): 은색 테 + 중앙 맞닿음
    g.strokeStyle = '#b8bcc0'; g.lineWidth = X(0.05);
    g.strokeRect(X(1.12), Yp(2.08), X(0.68), X(1.95)); g.strokeRect(X(1.82), Yp(2.08), X(0.68), X(1.95));
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(X(1.14), Yp(1.08), X(1.34), X(0.04));   // 안전띠 스티커
    // 주황 문설주 + 빨간 세로 스티커
    g.fillStyle = '#e8931c';
    g.fillRect(X(1.0), 0, X(0.11), h); g.fillRect(X(2.51), 0, X(0.11), h);
    g.fillStyle = '#ffffff'; g.fillRect(X(1.025), Yp(1.9), X(0.06), X(0.85));
    g.fillStyle = '#d62a2a'; g.fillRect(X(1.035), Yp(1.88), X(0.04), X(0.81));
    // 상단 주황띠
    g.fillStyle = '#ec9a22'; g.fillRect(0, 0, w, X(0.2));
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, X(0.2), w, X(0.02));
  });
}
T.psdA = makePSDTex(false);
T.psdB = makePSDTex(false);
T.glassWall = canvasTex(256, 512, (g, w, h) => {      // 고가역 외벽 커튼월 (1.8m × 4.5m)
  g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(190,210,215,0.18)'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#d7dadc'; g.fillRect(0, 0, 8, h); g.fillRect(0, h - 10, w, 10); g.fillRect(0, h * 0.42, w, 6); g.fillRect(0, 0, w, 6);
});
T.roof = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#dfe3e5'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(120,125,130,.35)'; for (let i = 0; i < 8; i++) g.fillRect(i * 32, 0, 2, h);
  speckle(g, w, h, 800, 0.08);
});
T.glow = canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,250,235,.75)');
  gr.addColorStop(0.5, 'rgba(255,245,225,.16)'); gr.addColorStop(1, 'rgba(255,245,225,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}, { repeat: false });
T.apt = canvasTex(256, 256, (g, w, h) => {      // 아파트 외벽 8×8 모듈 (모듈=3m×2.8m)
  const cw = w / 8, ch = h / 8;
  g.fillStyle = '#ecebe6'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const x = i * cw, y = j * ch, l = rr(70, 110);
    g.fillStyle = `rgb(${l * 0.85},${l * 0.95},${l * 1.08})`; g.fillRect(x + 4, y + 7, cw - 8, ch - 13);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 4, y + 7, (cw - 8) * rr(0.2, 0.6), ch - 13);
    if (rnd() < 0.35) { g.fillStyle = `rgba(230,225,210,${rr(.4, .8)})`; g.fillRect(x + 4 + rr(0, 10), y + 7, rr(6, 14), ch - 13); }
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x, y + ch - 4, cw, 2);
  }
});
T.sky = canvasTex(1024, 512, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h / 2);
  gr.addColorStop(0, '#6993c4'); gr.addColorStop(0.55, '#a7c0d6'); gr.addColorStop(1, '#d9e1e6');
  g.fillStyle = gr; g.fillRect(0, 0, w, h / 2);
  g.fillStyle = '#e3e8ea'; g.fillRect(0, h / 2, w, h / 2);
  // 흐린 날 뭉게구름
  for (let i = 0; i < 260; i++) {
    const y = rr(40, h / 2 - 8), x = rr(0, w), rx = rr(30, 110) * (1 - y / h), ry = rx * rr(0.35, 0.6);
    const shade = rnd() < 0.3 ? 'rgba(170,178,188,' : 'rgba(255,255,255,';
    for (const dx of [-w, 0, w]) {
      const gr2 = g.createRadialGradient(x + dx, y, 0, x + dx, y, rx);
      gr2.addColorStop(0, shade + rr(0.25, 0.5) + ')'); gr2.addColorStop(1, shade + '0)');
      g.save(); g.translate(x + dx, y); g.scale(1, ry / rx); g.translate(-(x + dx), -y);
      g.fillStyle = gr2; g.fillRect(x + dx - rx, y - rx, rx * 2, rx * 2); g.restore();
    }
  }
}, { repeat: false });
T.sky.wrapS = THREE.RepeatWrapping;
function signTex(name) {          // 노란 세로 역명판
  return canvasTex(128, 448, (g, w, h) => {
    g.fillStyle = '#f2bf00'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1a1a1a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const chars = [...name], fs = Math.min(92, (h - 70) / chars.length);
    g.font = `bold ${fs}px 'Malgun Gothic', sans-serif`;
    chars.forEach((c, i) => g.fillText(c, w / 2, 30 + fs / 2 + i * fs));
  }, { repeat: false });
}
/* 정차위치표지 (편성량 수 = 2)
   측면표지: 400×400mm 흑색 바탕 + 백색 숫자 (글자 높이 300mm) — PSD에 부착
   전면표지: 삼각기둥(길이 1000mm, 높이 160mm, 폭 180mm) 백색 반사재 + 적색 숫자 — 선로 중앙 */
T.stop = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 104px Arial'; g.fillText('2', w / 2, h / 2 + 4);
}, { repeat: false });
T.stopFront = canvasTex(256, 64, (g, w, h) => {
  g.fillStyle = '#f4f6f6'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e01b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 54px Arial'; g.fillText('2', w / 2, h / 2 + 3);
}, { repeat: false });
T.trainFront = canvasTex(256, 320, (g, w, h) => {   // 반대편 열차 전면
  g.fillStyle = '#f1f2f0'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#1b1f24'; g.beginPath(); g.roundRect(18, 26, w - 36, 150, 14); g.fill();
  g.fillStyle = 'rgba(120,150,170,.35)'; g.fillRect(28, 34, w - 56, 30);
  g.fillStyle = '#ff6a1a'; g.font = "bold 22px 'Malgun Gothic'"; g.textAlign = 'center'; g.fillText('검단오류', w / 2, 58);
  g.fillStyle = '#ef8a1e'; g.fillRect(0, 196, w, 22);
  g.fillStyle = '#fefefe'; g.beginPath(); g.arc(46, 250, 14, 0, 7); g.arc(w - 46, 250, 14, 0, 7); g.fill();
  g.fillStyle = '#9a9c9e'; g.fillRect(0, h - 26, w, 26);
}, { repeat: false });
T.trainSide = canvasTex(512, 128, (g, w, h) => {   // 반대편 열차 측면
  g.fillStyle = '#eceeed'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#2a3036'; for (let i = 0; i < 4; i++) g.fillRect(20 + i * 125, 26, 80, 46);
  g.fillStyle = '#ef8a1e'; g.fillRect(0, 84, w, 10);
  g.fillStyle = '#9a9c9e'; g.fillRect(0, h - 14, w, 14);
});
/* 객실 조명 (발광맵: 창 부분만 밝게, 나머지 검정) */
function litCabin(g, x, y, w, h) {
  const gr = g.createLinearGradient(0, y, 0, y + h);   // 천장 조명 → 밝은 내장판 → 좌석 높이
  gr.addColorStop(0, '#fffdf2'); gr.addColorStop(0.18, '#f4f1e4'); gr.addColorStop(0.55, '#d9dad2'); gr.addColorStop(1, '#b9bcb6');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,250,.95)'; g.fillRect(x, y + h * 0.04, w, h * 0.07);   // 천장 등기구 라인
  g.fillStyle = 'rgba(120,128,132,.55)';                                              // 반대편 창
  g.fillRect(x + w * 0.12, y + h * 0.3, w * 0.76, h * 0.28);
  g.fillStyle = 'rgba(90,96,100,.55)'; g.fillRect(x, y + h * 0.22, w, h * 0.025);
  g.fillStyle = 'rgba(60,66,70,.5)'; g.fillRect(x, y + h * 0.82, w, h * 0.18);       // 좌석 등받이
}
T.trainSideLit = canvasTex(512, 128, (g, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) litCabin(g, 20 + i * 125, 26, 80, 46);
});
T.trainFrontLit = canvasTex(256, 320, (g, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.save(); g.beginPath(); g.roundRect(18, 26, w - 36, 150, 14); g.clip();
  litCabin(g, 18, 26, w - 36, 150);
  g.fillStyle = 'rgba(25,30,34,.85)'; g.fillRect(18, 140, w - 36, 36);                   // 운전대 실루엣
  g.restore();
  g.fillStyle = '#1b1f24'; g.fillRect(28, 34, w - 56, 30);                               // 행선 표시기
  g.fillStyle = '#ff6a1a'; g.font = "bold 22px 'Malgun Gothic'"; g.textAlign = 'center'; g.fillText('검단오류', w / 2, 58);
  g.fillStyle = '#fefefe'; g.beginPath(); g.arc(46, 250, 14, 0, 7); g.arc(w - 46, 250, 14, 0, 7); g.fill();   // 전조등
}, { repeat: false });


T.mesh = canvasTex(64, 64, (g, w, h) => {          // 마름모 철망
  g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(165,170,168,.9)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
});
T.forest = canvasTex(256, 256, (g, w, h) => {      // 산림 (원거리 수관)
  g.fillStyle = '#3e5a2e'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 70, 'rgba(25,45,20,A)', 0.5, 6, 18); blotches(g, w, h, 60, 'rgba(95,125,60,A)', 0.4, 5, 14);
  speckle(g, w, h, 3000, 0.25);
});
T.low = canvasTex(256, 256, (g, w, h) => {         // 저층 건물 외벽 (모듈 3m)
  const cw = w / 8, ch = h / 8;
  g.fillStyle = '#d9d4c8'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const x = i * cw, y = j * ch, l = rr(60, 100);
    g.fillStyle = `rgb(${l},${l * 1.05},${l * 1.15})`; g.fillRect(x + 6, y + 8, cw - 12, ch - 16);
  }
  speckle(g, w, h, 2000, 0.12);
});

/* =====================================================================
   5. 재질
   ===================================================================== */
const DS2 = THREE.DoubleSide;
const MAT = {
  concrete: new THREE.MeshLambertMaterial({ map: T.concrete, vertexColors: true, side: DS2 }),
  concI: new THREE.MeshLambertMaterial({ map: T.concrete }),
  slab: new THREE.MeshLambertMaterial({ map: T.slab, vertexColors: true, side: DS2 }),
  slabU: new THREE.MeshBasicMaterial({ map: T.slab, vertexColors: true, side: DS2 }),
  rail: new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x777777, shininess: 70 }),
  seat: new THREE.MeshLambertMaterial({ vertexColors: true }),
  metal: new THREE.MeshLambertMaterial({ color: 0xb8bcc0, vertexColors: true, side: DS2 }),
  metalI: new THREE.MeshLambertMaterial({ color: 0xb8bcc0 }),
  third: new THREE.MeshLambertMaterial({ color: 0x8d9092, vertexColors: true, side: DS2 }),
  thirdI: new THREE.MeshLambertMaterial({ color: 0x6f6a62 }),
  tag: new THREE.MeshLambertMaterial({ color: 0xf2c200 }),             // 위치 태그 상판 (노란색)
  tagBase: new THREE.MeshLambertMaterial({ color: 0x1c1d1f }),         // 위치 태그 받침
  ground: new THREE.MeshLambertMaterial({ map: T.ground, side: DS2 }),
  road: new THREE.MeshLambertMaterial({ map: T.road, side: DS2 }),
  barrier: new THREE.MeshLambertMaterial({ color: 0xc6dde2, transparent: true, opacity: 0.28, depthWrite: false, side: DS2 }),
  fence: new THREE.MeshLambertMaterial({ map: T.mesh, transparent: true, alphaTest: 0.25, side: DS2 }),
  psdA: new THREE.MeshLambertMaterial({ map: T.psdA, transparent: true, side: DS2, depthWrite: false, vertexColors: true }),
  psdB: new THREE.MeshBasicMaterial({ map: T.psdB, transparent: true, side: DS2, depthWrite: false, vertexColors: true }),
  glassWall: new THREE.MeshLambertMaterial({ map: T.glassWall, transparent: true, side: DS2, depthWrite: false }),
  tileA: new THREE.MeshLambertMaterial({ map: T.tile, vertexColors: true, side: DS2 }),
  roof: new THREE.MeshLambertMaterial({ map: T.roof, vertexColors: true, side: DS2 }),
  white: new THREE.MeshLambertMaterial({ color: 0xf0f2f3 }),
  lining: new THREE.MeshBasicMaterial({ map: T.lining, vertexColors: true, side: DS2 }),
  boxWall: new THREE.MeshBasicMaterial({ map: T.concrete, vertexColors: true, side: DS2 }),
  concU: new THREE.MeshBasicMaterial({ map: T.concrete, side: DS2 }),
  metalU: new THREE.MeshBasicMaterial({ color: 0xb4b8bb }),
  darkU: new THREE.MeshBasicMaterial({ color: 0x2c2c2c, vertexColors: true, side: DS2 }),
  tileB: new THREE.MeshBasicMaterial({ map: T.tile, vertexColors: true, side: DS2 }),
  ceilB: new THREE.MeshBasicMaterial({ map: T.ceiling, vertexColors: true, side: DS2 }),
  wallB: new THREE.MeshBasicMaterial({ map: T.wallTile, vertexColors: true, side: DS2 }),
  wallBI: new THREE.MeshBasicMaterial({ map: T.wallTile }),
  headerB: new THREE.MeshBasicMaterial({ map: T.header, vertexColors: true, side: DS2 }),
  tactile: new THREE.MeshBasicMaterial({ color: 0xe0a51c, side: DS2 }),
  lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.1, 2.9) }),
  doorGlow: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.0, 2.0, 1.95), side: DS2 }),
  greenSign: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.6, 0.6) }),
  stopU: new THREE.MeshBasicMaterial({ map: T.stop }),
  stopA: new THREE.MeshLambertMaterial({ map: T.stop }),
  stopFront: new THREE.MeshBasicMaterial({ map: T.stopFront, color: new THREE.Color(1.15, 1.15, 1.15), side: DS2 }),   // 반사재: 조명 영향 적게
  water: new THREE.MeshPhongMaterial({ color: 0x3d6577, specular: 0x8899aa, shininess: 90 }),
  hill: new THREE.MeshLambertMaterial({ map: T.forest, vertexColors: true }),
  pole: new THREE.MeshLambertMaterial({ color: 0x9a9fa3 }),
  tree: new THREE.MeshLambertMaterial({ vertexColors: true }),
  apt: new THREE.MeshLambertMaterial({ map: T.apt }),
  low: new THREE.MeshLambertMaterial({ map: T.low }),
  far: new THREE.MeshLambertMaterial({ color: 0x6c7347 }),
};
const GLOW = color => new THREE.PointsMaterial({ map: T.glow, size: 2.4, sizeAttenuation: true, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending, color, toneMapped: false });
MAT.glowW = GLOW(0xfff1dc); MAT.glowG = GLOW(0x55ff99);
const SIGN_MAT = new Map();
const signMat = (st, basic) => {
  const k = st.id + (basic ? 'b' : 'a');
  if (!SIGN_MAT.has(k)) SIGN_MAT.set(k, basic ? new THREE.MeshBasicMaterial({ map: signTex(st.name), color: new THREE.Color().setScalar(1.1) })
    : new THREE.MeshLambertMaterial({ map: signTex(st.name) }));
  return SIGN_MAT.get(k);
};

/* =====================================================================
   6. 기하 생성기 (현재 청크 그룹 TARGET에 추가)
   ===================================================================== */
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _sc = new THREE.Vector3(), _col = new THREE.Color();
let TARGET = scene;
const shared = g => { g.userData.shared = true; return g; };
const hard = pts => { const o = []; pts.forEach((p, i) => { o.push(p); if (i > 0 && i < pts.length - 1) o.push(p); }); return o; };
const mirror = line => line.map(p => [-p[0], p[1], p[2]]).reverse();
function extrude({ s0, s1, step = 2, lines, mat, uvU = 4, uvS = 4, swapUV = false, color = null, order = 0 }) {
  if (s1 - s0 < 0.05) return;
  const fn = typeof lines === 'function', ss = [];
  const n0 = Math.max(1, Math.ceil((s1 - s0) / step - 1e-6));
  for (let i = 0; i <= n0; i++) ss.push(s0 + (s1 - s0) * i / n0);
  const pos = [], uv = [], col = [], idx = [];
  const perS = fn ? ss.map(s => lines(s)) : null, L0 = fn ? perS[0] : lines;
  for (let li = 0; li < L0.length; li++) {
    const n = L0[li].length, base = pos.length / 3;
    for (let si = 0; si < ss.length; si++) {
      const s = ss[si], line = fn ? perS[si][li] : L0[li];
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const p = line[k], u = p[0], v = p[1];
        if (k) acc += Math.hypot(u - line[k - 1][0], v - line[k - 1][1]);
        W(s, u, v, _v); pos.push(_v.x, _v.y, _v.z);
        if (swapUV) uv.push(s / uvS, acc / uvU); else uv.push(acc / uvU, s / uvS);
        if (mat.vertexColors) {
          const c = color ? color(s, u, v, li) : 1, pc = p[2] ?? 1;
          for (let q = 0; q < 3; q++) col.push((typeof c === 'number' ? c : c[q]) * (typeof pc === 'number' ? pc : pc[q]));
        }
      }
    }
    for (let si = 0; si < ss.length - 1; si++) for (let k = 0; k < n - 1; k++) {
      const i0 = base + si * n + k, i1 = i0 + 1, i2 = i0 + n, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv.map(x => x % 4096), 2));
  if (col.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals(); geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = order; mesh.matrixAutoUpdate = false;
  TARGET.add(mesh);
}
/* 노선 좌표 기반 인스턴싱: items = [{ s, u, v, sx, sy, sz, yaw, c }] */
function inst(geo, mat, items, far = 0) {
  if (!items.length) return;
  const m = new THREE.InstancedMesh(geo, mat, items.length);
  if (far) m.userData.far = far;
  items.forEach((it, i) => {
    basisAt(it.s, _m);
    if (it.yaw) _m.multiply(_m2.makeRotationY(it.yaw));
    _m.scale(_sc.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1));
    W(it.s, it.u, it.v, _v); _m.setPosition(_v);
    m.setMatrixAt(i, _m);
    if (it.c !== undefined) m.setColorAt(i, typeof it.c === 'number' ? _col.setScalar(it.c) : _col.setRGB(...it.c));
  });
  m.computeBoundingSphere(); m.matrixAutoUpdate = false;
  TARGET.add(m);
}
/* 월드 XZ 직접 지정 인스턴싱 (건물·수목) */
function instXZ(geo, mat, items, far = 0) {
  if (!items.length) return;
  const m = new THREE.InstancedMesh(geo, mat, items.length);
  if (far) m.userData.far = far;
  items.forEach((it, i) => {
    _m.makeRotationY(it.rot || 0).scale(_sc.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1));
    _m.setPosition(it.x - OX, (it.y ?? 0) - OY, it.z - OZ); m.setMatrixAt(i, _m);
    if (it.c !== undefined) m.setColorAt(i, _col.setRGB(...it.c));
  });
  m.computeBoundingSphere(); m.matrixAutoUpdate = false; TARGET.add(m);
}
function glowPoints(list, mat) {
  if (!list.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
  const p = new THREE.Points(g, mat); p.renderOrder = 5; p.matrixAutoUpdate = false; TARGET.add(p);
}
const boxGeo = (w, h, d, oy = 0) => new THREE.BoxGeometry(w, h, d).translate(0, oy, 0);
function colored(geo, rgb) {
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(rgb, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo;
}
function plate(s, outer, hole, mat) {
  const sh = new THREE.Shape(outer.map(p => new THREE.Vector2(p[0], p[1])));
  if (hole) sh.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p[0], p[1]))));
  mat.userData.chunkOwned = true;
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat);
  basisAt(s, _m); W(s, 0, 0, _v); _m.setPosition(_v); m.matrix.copy(_m); m.matrixAutoUpdate = false;
  TARGET.add(m);
}
const rect = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
/* [a,b) 범위에서 조건을 만족하는 연속 구간 */
function segs(a, b, pred) {
  const out = []; let cur = null;
  for (let s = a; s < b; s += 1) {
    const ok = pred(zc(s + 0.5), s + 0.5);
    if (ok && !cur) cur = [s, s + 1]; else if (ok) cur[1] = s + 1; else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
const grid = (a, b, step, off = 0) => { const o = []; for (let s = Math.ceil((a - off) / step) * step + off; s < b; s += step) o.push(s); return o; };

/* 공용 지오메트리 */
const G = {
  unit: shared(boxGeo(1, 1, 1)), unitUp: shared(boxGeo(1, 1, 1, 0.5)),
  pier: shared(new THREE.CylinderGeometry(1, 1.08, 1, 16).translate(0, 0.5, 0)),
  signFwd: shared(new THREE.PlaneGeometry(0.34, 0.95)),                         // 진입 열차를 향함(-s 방향)
  signBack: shared(new THREE.PlaneGeometry(0.34, 0.95).rotateY(Math.PI)),
  stopR: shared(new THREE.PlaneGeometry(0.4, 0.4).rotateY(-Math.PI / 2)),
  stopFront: shared((() => {
    // 삼각기둥: 진입 열차 쪽(로컬 +Z)으로 경사면, 폭(선로 직각) 1.0m, 높이 0.16m, 깊이 0.18m
    const W = 0.5, Hh = 0.16, D = 0.09;
    const P = [[-W, 0, D], [W, 0, D], [W, Hh, -D], [-W, Hh, -D],     // 경사면 (텍스처)
      [-W, Hh, -D], [W, Hh, -D], [W, 0, -D], [-W, 0, -D],               // 뒷면
      [-W, 0, D], [-W, Hh, -D], [-W, 0, -D], [W, 0, D], [W, 0, -D], [W, Hh, -D]];   // 양 끝 삼각형
    const pos = P.flat(), uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13]);
    g.computeVertexNormals();
    return g;
  })()),
  door: shared(new THREE.PlaneGeometry(1.0, 2.05)),
};
{
  // 운전석에서 보이는 윗면·앞면만 (삼각형 8개)
  const face = (w, h, d, y, rgb) => [
    colored(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, y + h / 2, 0), rgb),
    colored(new THREE.PlaneGeometry(w, h).translate(0, y, d / 2), rgb.map(c => c * 0.8))];
  G.seat = shared(mergeGeometries([...face(0.46, 0.13, 0.24, -0.235, [0.62, 0.61, 0.58]), ...face(0.34, 0.06, 0.12, -0.145, [0.16, 0.16, 0.17])]));
  // 수목 (줄기 + 수관 4덩이)
  const blob = (r, x, y, z, c) => {
    const g = new THREE.IcosahedronGeometry(r, 0), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i).multiplyScalar(rr(0.8, 1.15)); p.setXYZ(i, _v.x + x, _v.y + y, _v.z + z); }
    const a = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const sh = 0.75 + 0.35 * clamp((p.getY(i) - y + r) / (2 * r), 0, 1); a.set([c[0] * sh, c[1] * sh, c[2] * sh], i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
  };
  const leaf = [0.20, 0.33, 0.13];
  const trunk = colored(new THREE.CylinderGeometry(0.12, 0.18, 2.2, 6).translate(0, 1.1, 0), [0.28, 0.22, 0.16]).toNonIndexed();
  G.tree = shared(mergeGeometries([trunk, blob(1.3, 0, 2.9, 0, leaf), blob(1.0, 0.75, 2.4, 0.3, leaf), blob(0.95, -0.6, 2.5, -0.4, leaf), blob(0.85, 0.1, 3.8, 0.1, leaf)]));
  G.tree.computeVertexNormals();
  // 건물 (텍스처 비율 유지용 고정 치수)
  const bld = (w, h, d, mod) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), uv = g.attributes.uv;
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
      const i = f * 4 + k, fw = f < 2 ? d : w;
      if (f === 2 || f === 3) uv.setXY(i, 0.01, 0.01); else uv.setXY(i, uv.getX(i) * fw / (mod[0] * 8), uv.getY(i) * h / (mod[1] * 8));
    }
    return shared(g);
  };
  G.apts = [bld(15, 72, 13, [3, 2.8]), bld(15, 54, 13, [3, 2.8]), bld(32, 42, 14, [3, 2.8])];
  G.lows = [bld(14, 12, 12, [3, 3]), bld(20, 16, 14, [3, 3]), bld(10, 9, 10, [3, 3])];
  // 가로등
  G.lamppost = shared(mergeGeometries([boxGeo(0.18, 9, 0.18, 4.5), boxGeo(2.2, 0.12, 0.14, 8.9).translate(1.0, 0, 0)]));
  // 피난 계단
  const steps = []; for (let i = 0; i < 6; i++) steps.push(boxGeo(0.8, 0.06, 0.28, 0).translate(0, -0.3 + (i + 1) * 0.225, i * 0.3));
  G.steps = shared(mergeGeometries(steps));
}

/* =====================================================================
   7. 청크 빌더
   ===================================================================== */
const TRACKS = [-TRK, TRK];
function floorLine(xL, xR, base = -0.45) {
  const p = [[xL, base]];
  for (const c of TRACKS) { const a = c - 1.35, b = c + 1.35; p.push([a, base], [a, base], [a, -0.3], [a, -0.3], [b, -0.3], [b, -0.3], [b, base], [b, base]); }
  p.push([xR, base]); return p;
}
const RAIL_PROF = (() => {
  const H = [0.92, 0.93, 0.95], S2 = [0.6, 0.58, 0.56], Rr = [0.42, 0.31, 0.23];
  return [[-0.066, -0.172, Rr], [-0.009, -0.14, Rr], [-0.036, -0.038, S2], [-0.036, 0, S2], [-0.036, 0, H], [0.036, 0, H],
    [0.036, 0, S2], [0.036, -0.038, S2], [0.009, -0.14, Rr], [0.066, -0.172, Rr]];
})();
const railAt = (cu, o) => RAIL_PROF.map(p => [p[0] + cu + o, p[1], p[2]]);
const L = (s, u, v) => lightAt(s, u, v);

function buildTrack(a, b) {
  const lines = [];
  for (const c of TRACKS) for (const o of [-0.7535, 0.7535]) lines.push(railAt(c, o));
  extrude({ s0: a, s1: b, step: 2, lines, mat: MAT.rail, color: L });
  const seats = [];
  for (const s of grid(a, b, 0.625)) for (const c of TRACKS) for (const o of [-0.7535, 0.7535]) seats.push({ s, u: c + o, v: 0, c: lightAt(s, c + o, 0) });
  // 건넘선
  for (const [x0, x1, dir] of XOVERS) {
    const s0 = Math.max(a, x0), s1 = Math.min(b, x1);
    if (s1 <= s0) continue;
    const uc = s => { const t = smooth(x0, x1, s); return dir === '/' ? lerp(TRK, -TRK, t) : lerp(-TRK, TRK, t); };
    extrude({ s0, s1, step: 1, lines: s => [railAt(uc(s), -0.7535), railAt(uc(s), 0.7535)], mat: MAT.rail, color: L });
    for (const s of grid(s0, s1, 0.625)) for (const o of [-0.7535, 0.7535]) seats.push({ s, u: uc(s) + o, v: -0.01, c: lightAt(s, 0, 0) });
  }
  inst(G.seat, MAT.seat, seats, 250);
  // 위치 태그: 선로 중앙 25m 간격 노란 장치 (VOBC 위치 확인용)
  //   검은 받침 브래킷(침목 위, 선로 직각) + 납작한 노란 상판
  const tags = [], tagBase = [];
  for (let s = Math.ceil(a / 25) * 25; s < b; s += 25) if (!nearXover(s, 4)) for (const c of TRACKS) {
    const l = lightAt(s, c, 0);
    tagBase.push({ s, u: c, v: -0.15, sx: 0.66, sy: 0.07, sz: 0.17, c: l });
    tags.push({ s, u: c, v: -0.095, sx: 0.44, sy: 0.04, sz: 0.13, c: l });
  }
  inst(G.unit, MAT.tagBase, tagBase, 300);
  inst(G.unit, MAT.tag, tags, 300);
  // 제3궤조: 원형 터널은 바깥쪽, 그 외 선로 사이 (전환부·건넘선 구간은 단절)
  const sideAt = s => zc(s) === 4 ? 1 : -1;
  const third = c => hard([[c - 0.07, 0.04], [c + 0.07, 0.04], [c + 0.07, 0.24], [c - 0.07, 0.24], [c - 0.07, 0.04]]);
  for (const side of [-1, 1]) {
    const runs = segs(a, b, (z, s) => sideAt(s) === side && sideAt(s - 3) === side && sideAt(s + 3) === side && !nearXover(s, 8));
    for (const [r0, r1] of runs) {
      const cs = TRACKS.map(c => c + Math.sign(c) * side * 1.42);
      extrude({ s0: r0, s1: r1, step: 3, lines: cs.map(third), mat: MAT.third, color: L });
      const br = [];
      for (const s of grid(r0, r1, 4.5, 1)) for (const c of cs) br.push({ s, u: c, v: -0.12, sx: 0.22, sy: 0.34, sz: 0.12, c: lightAt(s, c, 0) });
      inst(G.unit, MAT.thirdI, br);
    }
  }
}

const DECK = hard([[-4.9, -0.45], [-4.9, 0.95], [-5.25, 0.95], [-5.25, -0.8], [-2.7, -1.1], [-2.1, -2.6],
  [2.1, -2.6], [2.7, -1.1], [5.25, -0.8], [5.25, 0.95], [4.9, 0.95], [4.9, -0.45]]);
const sqTube = (u, v, r = 0.03) => [[u, v - r], [u, v + r]];
function buildViaduct(a, b) {
  for (const [s0, s1] of segs(a, b, z => z === 0 || z === 1)) {
    extrude({ s0, s1, step: 2, lines: [floorLine(-4.9, 4.9)], mat: MAT.slab, uvU: 3, uvS: 3, color: () => 0.95 });
  }
  const piers = [], caps = [], posts = [], bposts = [];
  for (const [s0, s1] of segs(a, b, z => z === 0)) {
    extrude({ s0, s1, step: 2, lines: [DECK], mat: MAT.concrete, color: (s, u, v) => v < -0.7 ? 0.7 : 1 });
    extrude({ s0, s1, step: 4, lines: [sqTube(-5.05, 2.1), sqTube(5.05, 2.1), sqTube(-5.05, 1.55), sqTube(5.05, 1.55)], mat: MAT.metal });
    for (const s of grid(s0, s1, 2)) for (const u of [-5.05, 5.05]) posts.push({ s, u, v: 0.95, sx: 0.07, sy: 1.15, sz: 0.07 });
    for (const s of grid(s0, s1, 30)) {
      if (Math.abs(s - CANAL) < 55) continue;
      const y = Y(s);
      piers.push({ s, u: 0, v: -y, sy: y - 2.6, sx: 1.5, sz: 1.0 });
      caps.push({ s, u: 0, v: -3.05, sx: 4.6, sy: 0.9, sz: 2.0 });
    }
    // 방음벽 (역 주변 200m 단위로 결정)
    for (const blk of grid(s0, s1, 200)) {
      reseed(blk); const st = STN.find(x => Math.abs(x.s - blk) < 700);
      if (!st || rnd() < 0.35) continue;
      const e0 = Math.max(s0, blk), e1 = Math.min(s1, blk + 200), sides = rnd() < 0.5 ? [1] : [-1, 1];
      for (const side of sides) {
        extrude({ s0: e0, s1: e1, step: 4, lines: [[[side * 5.12, 0.95], [side * 5.12, 3.6]]], mat: MAT.barrier, order: 2 });
        extrude({ s0: e0, s1: e1, step: 4, lines: [sqTube(side * 5.12, 3.6)], mat: MAT.metal });
        for (const s of grid(e0, e1, 2)) bposts.push({ s, u: side * 5.12, v: 0.95, sx: 0.12, sy: 2.65, sz: 0.1 });
      }
    }
  }
  inst(G.pier, MAT.concI, piers); inst(G.unit, MAT.concI, caps);
  inst(G.unitUp, MAT.metalI, posts); inst(G.unitUp, MAT.pole, bposts);
}

function stationFeatures(st, a, b, under) {
  // 승강장 진입부: 노란 역명판 + 녹색 비상대피 유도등 + 끝단 출입문 (+ 지하: 피난 계단)
  const pillars = [], signsF = [], signsB = [], greens = [], doors = [], steps = [], glowG = [];
  const add = (s, side) => {
    if (s < a || s >= b) return;
    const u = side * 4.05, face = s - side * 0.31;
    pillars.push({ s: s + side * 0.0, u, v: 1.05, sx: 0.6, sy: 3.4, sz: 0.6, c: under ? 1.0 : undefined });
    (side > 0 ? signsF : signsB).push({ s: face, u, v: 3.25 });
    greens.push({ s: face, u: u + side * 0.55, v: 3.75, sx: 0.35, sy: 0.16, sz: 0.06 });
    W(face - side * 0.1, u + side * 0.55, 3.75, _v); glowG.push(_v.x, _v.y, _v.z);
    if (under) doors.push({ s: s - side * 0.17, u: side * 5.6, v: 2.08, yaw: side > 0 ? 0 : Math.PI });
    if (under) steps.push({ s: s - side * 2.0, u: side * 4.2, v: 0, yaw: side > 0 ? Math.PI : 0 });
  };
  add(st.s0, +1); add(st.s1, -1);
  const pm = under ? MAT.wallBI : MAT.white;
  inst(G.unitUp, pm, pillars);
  inst(G.signFwd, signMat(st, under), signsF); inst(G.signBack, signMat(st, under), signsB);
  inst(G.unit, MAT.greenSign, greens); glowPoints(glowG, MAT.glowG);
  inst(G.door, MAT.doorGlow, doors);
  inst(G.steps, MAT.metalU, steps);
  // 정차위치표지: 측면(PSD 부착, 흑색 바탕 백색 숫자) + 전면(선로 중앙, 백색 반사재 적색 숫자)
  if (st.stop + 0.6 >= a && st.stop + 0.6 < b) inst(G.stopR, under ? MAT.stopU : MAT.stopA, [{ s: st.stop + 0.6, u: 3.69, v: 2.6 }]);
  if (st.stop >= a && st.stop < b) inst(G.stopFront, MAT.stopFront, [{ s: st.stop, u: TRK, v: -0.30 }]);
}

function buildStationA(a, b) {
  for (const [s0, s1] of segs(a, b, z => z === 1)) {
    const st = stationAt((s0 + s1) / 2), e0 = Math.max(s0, st.s0 - 4), e1 = Math.min(s1, st.s1 + 4);
    const under = (s, u, v) => (v > 1 && Math.abs(u) < 9 ? 0.82 : v < -0.7 ? 0.7 : 0.95);
    const plat = hard([[4.9, -0.45], [3.76, -0.45], [3.76, 1.05], [3.76, 1.05], [9.0, 1.05], [9.0, -1.2], [2.6, -2.7]]);
    extrude({ s0, s1, step: 2, lines: [plat, mirror(plat)], mat: MAT.concrete, color: under });
    extrude({ s0, s1, step: 2, lines: [[[3.76, 1.051], [9.0, 1.051]], [[-9.0, 1.051], [-3.76, 1.051]]], mat: MAT.tileA, uvU: 2.4, uvS: 2.4, color: () => 0.85 });
    if (e1 > e0) extrude({ s0: e0, s1: e1, step: PSD_MOD, lines: [[[3.73, 1.05], [3.73, 1.05 + PSD_H]], [[-3.73, 1.05], [-3.73, 1.05 + PSD_H]]],
      mat: MAT.psdA, swapUV: true, uvS: PSD_MOD, uvU: PSD_H, color: () => 0.92, order: 3 });
    extrude({ s0, s1, step: 4, lines: [[[8.85, 1.05], [8.85, 5.6]], [[-8.85, 1.05], [-8.85, 5.6]]], mat: MAT.glassWall, swapUV: true, uvS: 1.8, uvU: 4.55, order: 2 });
    const arch = []; for (let i = 0; i <= 18; i++) { const u = -9.8 + 19.6 * i / 18; arch.push([u, 5.7 + 3.1 * (1 - (u / 9.8) ** 2)]); }
    extrude({ s0, s1, step: 4, lines: [arch], mat: MAT.roof, uvU: 2, uvS: 6, color: () => 0.8 });
    if (!G.rib) G.rib = shared(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arch.map(p => new THREE.Vector3(p[0], p[1] - 0.18, 0))), 40, 0.13, 6, false));
    const ribs = [], cols = [], piers = [];
    for (const s of grid(s0, s1, 7.2, st.s0 % 7.2)) { ribs.push({ s, u: 0, v: 0 }); for (const u of [-8.5, 8.5]) cols.push({ s, u, v: 1.05, sx: 0.45, sy: 4.75, sz: 0.45 }); }
    for (const s of grid(s0, s1, 30)) for (const u of [-5.5, 5.5]) piers.push({ s, u, v: -Y(s), sy: Y(s) - 1.4, sx: 0.9, sz: 0.9 });
    inst(G.rib, MAT.white, ribs); inst(G.unitUp, MAT.white, cols); inst(G.pier, MAT.concI, piers);
    stationFeatures(st, s0, s1, false);
  }
}

function buildCut(a, b) {
  for (const [s0, s1] of segs(a, b, z => z === 2)) {
    extrude({ s0, s1, step: 2, lines: [floorLine(-5.0, 5.0)], mat: MAT.slab, uvU: 3, uvS: 3, color: () => 0.95 });
    const wall = side => s => {
      const y = Y(s), top = Math.max(y + 1.2, 0.9) - y, g = -y;
      const pts = hard([[5.0, Math.min(-0.45, g)], [5.0, top], [5.35, top], [5.35, g]]);
      return side > 0 ? pts : mirror(pts);
    };
    extrude({ s0, s1, step: 2, lines: s => [wall(1)(s), wall(-1)(s)], mat: MAT.concrete, color: (s, u, v) => 0.8 + 0.2 * smooth(-1, 1.5, v) });
    // 옹벽 상부 철망 울타리
    const ftop = s => Math.max(Y(s) + 1.2, 0.9) - Y(s);
    extrude({ s0, s1, step: 3, lines: s => [[[5.2, ftop(s)], [5.2, ftop(s) + 1.8]], [[-5.2, ftop(s)], [-5.2, ftop(s) + 1.8]]],
      mat: MAT.fence, swapUV: true, uvS: 0.25, uvU: 0.25 });
    const fp = []; for (const s of grid(s0, s1, 3)) for (const u of [-5.2, 5.2]) fp.push({ s, u, v: ftop(s), sx: 0.07, sy: 1.85, sz: 0.07 });
    inst(G.unitUp, MAT.metalI, fp);
  }
  for (const p of PORTALS) {
    if (p.s < a || p.s >= b) continue;
    const top = 1.4 - Y(p.s);
    plate(p.s, rect(-7.5, 7.5, -1.0, top), rect(-BOX_W, BOX_W, -0.45, BOX_H), new THREE.MeshLambertMaterial({ map: T.concrete, side: DS2 }));
    inst(G.unit, MAT.concI, [{ s: p.s - p.dir * 0.3, u: 0, v: top - 0.2, sx: 15.4, sy: 0.4, sz: 1.2 }]);
  }
}

function buildTunnels(a, b) {
  const lamps = [], glow = [], greens = [];
  const addLamps = (s0, s1, Lp, skipSt) => {
    for (const side of [-1, 1]) for (const s of grid(s0, s1, Lp.sp, side > 0 ? 0 : Lp.sp / 2)) {
      if (skipSt && zc(s) === 5) continue;
      lamps.push({ s, u: side * Lp.u, v: Lp.v, sx: 0.14, sy: 0.12, sz: 0.9 });
      W(s, side * (Lp.u - 0.12), Lp.v, _v); glow.push(_v.x, _v.y, _v.z);
    }
  };
  /* 박스 */
  for (const [s0, s1] of segs(a, b, z => z === 3)) {
    extrude({ s0, s1, step: 1.5, lines: [hard([[-BOX_W, -0.45], [-BOX_W, BOX_H], [BOX_W, BOX_H], [BOX_W, -0.45]])], mat: MAT.boxWall, color: L });
    extrude({ s0, s1, step: 1.5, lines: [floorLine(-BOX_W, BOX_W)], mat: MAT.slabU, uvU: 3, uvS: 3, color: L });
    addLamps(s0, s1, LAMP.box, true);
    for (const s of grid(s0, s1, 50, 25)) greens.push({ s, u: BOX_W - 0.05, v: 1.2, sx: 0.06, sy: 0.25, sz: 0.5 });
  }
  /* 중앙 기둥 (박스·지하역, 건넘선 구간 제외) */
  const cols = [];
  for (const s of grid(a, b, 6, 3)) { const z = zc(s); if ((z === 3 || z === 5) && !nearXover(s, 6) && PD[Math.round(s - START)] > 4) cols.push({ s, u: 0, v: -0.45, sx: 0.7, sy: BOX_H + 0.45, sz: 0.9, c: lightAt(s, 0.4, 2.5) * 0.95 }); }
  inst(G.unitUp, MAT.concU, cols);
  /* 원형 */
  const a0 = Math.asin((-0.45 - TUN_CY) / TUN_R), arc = [];
  for (let i = 0; i <= 24; i++) { const t = a0 + (Math.PI - 2 * a0) * i / 24; arc.push([TUN_R * Math.cos(t), TUN_CY + TUN_R * Math.sin(t)]); }
  const hw = TUN_R * Math.cos(a0);
  const walk = hard([[-0.55, -0.45], [-0.55, 0.85], [0.55, 0.85], [0.55, -0.45]]);
  const cu = v => TUN_R * Math.cos(Math.asin((v - TUN_CY) / TUN_R)) - 0.04;
  const cable = (u, v) => [[u, v], [u - Math.sign(u) * 0.05, v + 0.06]];
  const hr = (u, v) => [[u, v], [u, v + 0.05]];
  const posts = [];
  for (const [s0, s1] of segs(a, b, z => z === 4)) {
    extrude({ s0, s1, step: 1.5, lines: [arc], mat: MAT.lining, uvU: 6, uvS: 1.5, color: L });
    extrude({ s0, s1, step: 1.5, lines: [floorLine(-hw, hw), walk], mat: MAT.slabU, uvU: 3, uvS: 3, color: L });
    const cl = []; for (const v of [1.55, 1.7, 1.85, 2.0]) { cl.push(cable(cu(v), v)); cl.push(cable(-cu(v), v)); }
    extrude({ s0, s1, step: 3, lines: cl, mat: MAT.darkU, color: (s, u, v) => 0.6 * L(s, u, v) });
    extrude({ s0, s1, step: 3, lines: [hr(-0.5, 1.85), hr(0.5, 1.85), hr(-0.5, 1.35), hr(0.5, 1.35)], mat: MAT.metal, color: (s, u, v) => 0.75 * L(s, u, v) });
    for (const s of grid(s0, s1, 2.4)) for (const u of [-0.5, 0.5]) posts.push({ s, u, v: 0.85, sx: 0.06, sy: 1.05, sz: 0.06, c: L(s, u, 1.5) });
    addLamps(s0, s1, LAMP.round, false);
    for (const s of grid(s0, s1, 50, 25)) greens.push({ s, u: cu(1.2), v: 1.2, sx: 0.06, sy: 0.25, sz: 0.5 });
  }
  inst(G.unitUp, MAT.metalU, posts);
  inst(G.unit, MAT.lamp, lamps); inst(G.unit, MAT.greenSign, greens); glowPoints(glow, MAT.glowW);
  /* 박스↔원형 전환부 막음판 */
  for (let s = Math.ceil(a); s < b; s++) {
    const z0 = zc(s - 0.5), z1 = zc(s + 0.5);
    if ((z0 === 3 && z1 === 4) || (z0 === 4 && z1 === 3) || (z0 === 4 && z1 === 5) || (z0 === 5 && z1 === 4)) {
      plate(s, rect(-7, 7, -1, 8), rect(-BOX_W + 0.01, BOX_W - 0.01, -0.44, BOX_H - 0.01),
        new THREE.MeshBasicMaterial({ map: T.concrete, color: new THREE.Color().setScalar(lightAt(s, 4, 3) * 0.8), side: DS2 }));
    }
  }
}

function buildStationB(a, b) {
  for (const [s0, s1] of segs(a, b, z => z === 5)) {
    const st = stationAt((s0 + s1) / 2);
    const under = hard([[BOX_W, -0.45], [3.76, -0.45], [3.76, 1.05]]);
    extrude({ s0, s1, step: 1.2, lines: [under, mirror(under)], mat: MAT.boxWall, color: (s, u, v) => 0.6 * L(s, u, v) });
    extrude({ s0, s1, step: 1.2, lines: [floorLine(-3.76, 3.76)], mat: MAT.slabU, uvU: 3, uvS: 3, color: L });
    extrude({ s0, s1, step: PSD_MOD, lines: [[[3.73, 1.05], [3.73, 1.05 + PSD_H]], [[-3.73, 1.05], [-3.73, 1.05 + PSD_H]]],
      mat: MAT.psdB, swapUV: true, uvS: PSD_MOD, uvU: PSD_H, color: () => 1.0, order: 3 });
    const hdr = [[3.73, 3.4], [3.9, 3.75], [4.0, 4.3], [3.95, 4.85], [3.7, BOX_H]];
    extrude({ s0, s1, step: 1.2, lines: [hdr, mirror(hdr)], mat: MAT.headerB, uvU: 2, uvS: 1.2, swapUV: true, color: () => 0.8 });
    extrude({ s0, s1, step: 1.2, lines: [[[-3.7, BOX_H], [3.7, BOX_H]]], mat: MAT.boxWall, color: () => 0.55 });
    extrude({ s0, s1, step: 2.4, lines: [[[3.76, 1.05], [10, 1.05]], [[-10, 1.05], [-3.76, 1.05]]], mat: MAT.tileB, uvU: 2.4, uvS: 2.4, color: () => 0.95 });
    extrude({ s0, s1, step: 2.4, lines: [[[3.9, 4.4], [10, 4.4]], [[-10, 4.4], [-3.9, 4.4]]], mat: MAT.ceilB, uvU: 2.4, uvS: 2.4, color: () => 0.9 });
    extrude({ s0, s1, step: 2.4, lines: [[[10, 1.05], [10, 4.4]], [[-10, 1.05], [-10, 4.4]]], mat: MAT.wallB, uvU: 3.35, uvS: 2.4, swapUV: true, color: () => 0.85 });
    extrude({ s0, s1, step: 4.8, lines: [[[4.15, 1.056], [4.45, 1.056]], [[-4.45, 1.056], [-4.15, 1.056]]], mat: MAT.tactile });
    const strips = [], pcols = [];
    for (const s of grid(s0, s1, 2.4, 1.2)) for (const u of [5.6, 8.0, -5.6, -8.0]) strips.push({ s, u, v: 4.38, sx: 0.22, sy: 0.03, sz: 1.8 });
    for (const s of grid(s0, s1, 9.6, st.s0 + 6)) for (const u of [-7.6, 7.6]) pcols.push({ s, u, v: 1.05, sx: 0.7, sy: 3.35, sz: 0.7 });
    inst(G.unit, MAT.lamp, strips); inst(G.unitUp, MAT.wallBI, pcols);
    // 승강장 끝 막음벽
    const ends = [];
    for (const side of [-1, 1]) for (const s of [st.s0, st.s1]) if (s >= a && s < b) ends.push({ s, u: side * 7.1, v: -0.45, sx: 6.8, sy: BOX_H + 0.5, sz: 0.3, c: 0.75 });
    inst(G.unitUp, MAT.concU, ends);
  }
  for (const st of STN) if (st.type === 'under' && ((st.s0 >= a && st.s0 < b) || (st.s1 >= a && st.s1 < b))) stationFeatures(st, a, b, true);
}

/* ---------- 지상 경관 ---------- */
const ROADS = [[START, S('202') + 300, -20, 14], [S('207') - 100, S('208') + 700, -22, 12], [S('226') - 450, S('226') + 300, 24, 16]];
const CROSS_ROADS = [S('201') + 250, S('202') - 380, S('207') + 340, S('208') - 300, S('226') - 260, S('226') + 160];
const regionAt = s => s < S('202') + 900 ? 'town' : (s > CANAL - 700 && s < S('207') - 150) ? 'canal'
  : (s >= S('207') - 150 && s < S('208') + 900) ? 'apt' : s > S('225') + 450 ? 'forest' : 'none';
const nearPath = (x, z, s, r) => {
  for (let q = s - 600; q <= s + 600; q += 8) { at(q); if ((F.x - x) ** 2 + (F.z - z) ** 2 < r * r) return true; }
  return false;
};
const onRoad = (s, u) => ROADS.some(([a, b, c, w]) => s > a && s < b && Math.abs(u - c) < w / 2 + 6) || CROSS_ROADS.some(c => Math.abs(s - c) < 14);
function buildScenery(a, b, ci) {
  const mid = (a + b) / 2, iMid = clamp(Math.round(mid - START), 0, NS - 1);
  if (!OUT_NEAR[iMid]) return;
  /* 지면 리본 (개착부는 구멍, 아라뱃길 구간 제외) */
  let kmax = 1e-6; for (let s = a; s <= b; s += 5) kmax = Math.max(kmax, Math.abs(curv(s)));
  const lat = Math.min(460, 0.85 / kmax);
  const gapAt = s => zc(s) === 2 ? 5.35 : 0;
  const ground = s => { const v = -Y(s), g = gapAt(s); return [[-lat, v], [-lat * 0.5, v], [-lat * 0.2, v], [-40, v], [-15, v], [-Math.max(g, 0.01), v]].map(p => [p[0], p[1]]); };
  for (const [g0, g1] of [[a, Math.min(b, CANAL - 70)], [Math.max(a, CANAL + 70), b]]) {
    if (g1 - g0 < 1) continue;
    extrude({ s0: g0, s1: g1, step: 5, lines: s => { const l = ground(s); return [l, mirror(l)]; }, mat: MAT.ground, uvU: 24, uvS: 24 });
  }
  /* 아라뱃길 (수면 + 호안) */
  if (CANAL >= a && CANAL < b) {
    const wm = new THREE.Mesh(new THREE.PlaneGeometry(140, 3000).rotateX(-Math.PI / 2), MAT.water);
    basisAt(CANAL, _m); _m.multiply(_m2.makeRotationY(Math.PI / 2)); W(CANAL, 0, -Y(CANAL) - 0.4, _v); _m.setPosition(_v);
    wm.matrix.copy(_m); wm.matrixAutoUpdate = false; TARGET.add(wm);
    const banks = [];
    for (const side of [-1, 1]) banks.push({ s: CANAL + side * 66, u: 0, v: -Y(CANAL) - 1.5, sx: 3000, sy: 1.6, sz: 8, c: [0.75, 0.73, 0.68] });
    inst(G.unit, MAT.concI, banks.map(b2 => ({ ...b2, yaw: 0 })));
  }
  /* 도로 */
  for (const [r0, r1, c, w] of ROADS) {
    const s0 = Math.max(a, r0), s1 = Math.min(b, r1);
    if (s1 - s0 < 1) continue;
    extrude({ s0, s1, step: 5, lines: s => [[[c - w / 2, -Y(s) + 0.04], [c + w / 2, -Y(s) + 0.04]]], mat: MAT.road, uvU: w, uvS: 14 });
    const lp = []; for (const s of grid(s0, s1, 32)) lp.push({ s, u: c + w / 2 + 1, v: -Y(s), yaw: Math.PI });
    inst(G.lamppost, MAT.pole, lp);
  }
  for (const c of CROSS_ROADS) {
    if (c < a || c >= b) continue;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 900).rotateX(-Math.PI / 2), MAT.road);
    basisAt(c, _m); _m.multiply(_m2.makeRotationY(Math.PI / 2)); W(c, 0, -Y(c) + 0.05, _v); _m.setPosition(_v);
    m.matrix.copy(_m); m.matrixAutoUpdate = false; TARGET.add(m);
  }
  /* 건물·수목 (청크 시드 고정) */
  const reg = regionAt(mid);
  if (reg === 'none') return;
  reseed(ci * 31 + 7);
  const trees = [], apts = [[], [], []], lows = [[], [], []];
  const place = (u, s, r) => { at(s); const x = F.x + Math.cos(F.h) * u, z = F.z + Math.sin(F.h) * u; return nearPath(x, z, s, r) ? null : { x, z, rot: -F.h + rr(-0.25, 0.25) }; };
  const nTree = { town: 40, canal: 25, apt: 30, forest: 160 }[reg];
  for (let i = 0; i < nTree; i++) {
    const s = rr(a, b), u = (rnd() < 0.5 ? -1 : 1) * rr(10, reg === 'forest' ? 220 : 140);
    if (onRoad(s, u) || Math.abs(s - CANAL) < 75) continue;
    const p = place(u, s, 9); if (!p) continue;
    const sc = rr(1.1, 2.0), g = rr(0.7, 1.25);
    trees.push({ ...p, y: 0, sx: sc, sy: sc * rr(0.9, 1.3), sz: sc, rot: rr(0, 6.28), c: [g * rr(0.9, 1.1), g, g * rr(0.8, 1.05)] });
  }
  const nApt = { town: 1, canal: 2, apt: 4, forest: 0 }[reg], nLow = { town: 9, canal: 1, apt: 3, forest: 1 }[reg];
  for (let i = 0; i < nApt; i++) {
    const s = rr(a, b), u = (rnd() < 0.5 ? -1 : 1) * rr(170, 560), p = place(u, s, 90);
    if (!p) continue;
    const t = rr(0.88, 1.05);
    apts[rnd() < 0.15 ? 2 : rnd() < 0.5 ? 0 : 1].push({ ...p, c: [t, t * rr(0.96, 1), t * rr(0.9, 0.98)] });
  }
  for (let i = 0; i < nLow; i++) {
    const s = rr(a, b), u = (rnd() < 0.5 ? -1 : 1) * rr(22, 170);
    if (onRoad(s, u)) continue;
    const p = place(u, s, 20); if (!p) continue;
    const t = rr(0.75, 1.1);
    lows[Math.floor(rnd() * 3)].push({ ...p, c: [t, t * rr(0.9, 1), t * rr(0.85, 1)] });
  }
  instXZ(G.tree, MAT.tree, trees, 750);
  apts.forEach((l, i) => instXZ(G.apts[i], MAT.apt, l));
  lows.forEach((l, i) => instXZ(G.lows[i], MAT.low, l));
  /* 숲 지대 구릉 */
  if (reg === 'forest') {
    for (const side of [-1, 1]) {
      const r = rr(80, 150), s = rr(a, b), u = side * (r + rr(40, 160)), p = place(u, s, r * 1.2 + 30); if (!p) continue;
      const g = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), pp = g.attributes.position, cc = new Float32Array(pp.count * 3);
      for (let i = 0; i < pp.count; i++) { const f = rr(0.75, 1.1); cc.set([f, f, f], i * 3); _v.fromBufferAttribute(pp, i); pp.setY(i, _v.y * rr(0.92, 1.08)); }
      g.setAttribute('color', new THREE.BufferAttribute(cc, 3)); g.computeVertexNormals();
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 12, uv.getY(i) * 3);
      const m = new THREE.Mesh(g, MAT.hill);
      m.position.set(p.x - OX, -2 - OY, p.z - OZ); m.scale.set(r, rr(25, 55), r * rr(0.7, 1.2)); m.rotation.y = p.rot;
      m.updateMatrix(); m.matrixAutoUpdate = false; TARGET.add(m);
    }
  }
}

/* =====================================================================
   7b. 청크 관리 (열차 주변만 생성, 나머지 해제)
   ===================================================================== */
const CH = 150, AHEAD = 1050, BEHIND = 300;
const chunks = new Map();
function buildChunk(ci) {
  const a = START + ci * CH, b = Math.min(END, a + CH);
  if (b <= a) return;
  at(a); OX = F.x; OY = F.y; OZ = F.z;
  const g = new THREE.Group(); g.position.set(OX, OY, OZ); TARGET = g;
  buildTrack(a, b); buildViaduct(a, b); buildStationA(a, b); buildCut(a, b);
  buildTunnels(a, b); buildStationB(a, b); buildScenery(a, b, ci);
  TARGET = scene; OX = OY = OZ = 0;
  at((a + b) / 2); g.userData.cx = F.x; g.userData.cy = F.y; g.userData.cz = F.z;
  scene.add(g); chunks.set(ci, g);
}
/* 거리 기반 세부 객체 표시 (체결장치·수목) */
function updateLod() {
  const p = camera.position;
  for (const g of chunks.values()) {
    const d = Math.hypot(g.userData.cx - p.x, g.userData.cy - p.y, g.userData.cz - p.z) - CH / 2;
    for (const o of g.children) if (o.userData.far) o.visible = d < o.userData.far;
  }
}
function disposeChunk(ci) {
  const g = chunks.get(ci); if (!g) return;
  g.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material && o.material.userData && o.material.userData.chunkOwned) o.material.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
  scene.remove(g); chunks.delete(ci);
}
function updateChunks(s, budget) {
  const c0 = Math.max(0, Math.floor((s - BEHIND - START) / CH)), c1 = Math.min(Math.floor((END - START) / CH), Math.floor((s + AHEAD - START) / CH));
  const cur = Math.floor((s - START) / CH);
  const want = []; for (let c = c0; c <= c1; c++) if (!chunks.has(c)) want.push(c);
  want.sort((x, y) => Math.abs(x - cur) - Math.abs(y - cur));
  for (const c of want) { if (budget-- <= 0) break; buildChunk(c); }
  for (const c of [...chunks.keys()]) if (c < c0 - 1 || c > c1 + 1) disposeChunk(c);
}

/* 하늘 / 원경 (카메라 추종) */
function buildSkyFar() {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), new THREE.MeshBasicMaterial({ map: T.sky, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10;
  const far = new THREE.Group();
  const ring = (r, hmin, hmax, colTop, colBot, so) => {
    const N = 240, pos = [], col = [], idx = [], ct = new THREE.Color(colTop), cb = new THREE.Color(colBot);
    for (let i = 0; i <= N; i++) {
      const t = i / N * Math.PI * 2, n = 0.5 + 0.25 * Math.sin(t * 3 + so) + 0.15 * Math.sin(t * 7.3 + so * 2) + 0.1 * Math.sin(t * 17.1 + so);
      const hgt = hmin + (hmax - hmin) * clamp(n, 0, 1), x = Math.cos(t) * r, z = Math.sin(t) * r;
      pos.push(x, -5, z, x, hgt, z); col.push(cb.r, cb.g, cb.b, ct.r, ct.g, ct.b);
      if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: DS2 })); m.renderOrder = -9; far.add(m);
  };
  ring(1400, 40, 150, '#9fb1b9', '#c9d3d7', 1.3);
  ring(1050, 20, 95, '#7f9585', '#b9c4bf', 4.1);
  const gr = new THREE.Mesh(new THREE.RingGeometry(440, 1600, 48, 1).rotateX(-Math.PI / 2), MAT.far);
  gr.position.y = -0.45; far.add(gr);
  scene.add(sky, far);
  return { sky, far };
}

/* =====================================================================
   7c. 반대 방향 열차 (상선, 역마다 정차)
   ===================================================================== */
function buildOppTrain() {
  // 창은 발광맵으로 객실 조명이 켜진 것처럼 (터널에서도 밝게 보임)
  const side = new THREE.MeshLambertMaterial({ map: T.trainSide, emissive: 0xffffff, emissiveMap: T.trainSideLit, emissiveIntensity: 0.85 });
  const front = new THREE.MeshLambertMaterial({ map: T.trainFront, emissive: 0xffffff, emissiveMap: T.trainFrontLit, emissiveIntensity: 0.75 });
  const roof = new THREE.MeshLambertMaterial({ color: 0xd9dbdb }), dark = new THREE.MeshLambertMaterial({ color: 0x3a3c3e });
  const geo = new THREE.BoxGeometry(2.75, 3.25, 17.6);
  const cars = [new THREE.Mesh(geo, [side, side, roof, dark, front, dark]), new THREE.Mesh(geo, [side, side, roof, dark, dark, front])];
  // 하부 기기·대차 (차체와 레일 사이를 채워 떠 보이지 않게)
  const under = new THREE.MeshLambertMaterial({ color: 0x24272b });
  const underGeo = mergeGeometries([
    new THREE.BoxGeometry(2.3, 0.45, 15.5).translate(0, -1.75, 0),
    new THREE.BoxGeometry(2.0, 0.55, 2.6).translate(0, -2.0, 6.5),
    new THREE.BoxGeometry(2.0, 0.55, 2.6).translate(0, -2.0, -6.5)]);
  cars.forEach(c => c.add(new THREE.Mesh(underGeo, under)));
  const g = new THREE.Group(); cars.forEach(c => { c.matrixAutoUpdate = false; g.add(c); });
  const hp = new THREE.BufferGeometry(); hp.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const heads = new THREE.Points(hp, new THREE.PointsMaterial({ map: T.glow, size: 1.6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  heads.frustumCulled = false; heads.renderOrder = 6; g.add(heads);
  g.visible = false; scene.add(g);
  return { g, cars, heads, mats: [side, front, roof, under], s: 0, v: 0, a: 0, active: false, dwell: 0, cool: 8 };
}


/* =====================================================================
   8. 운전실 창틀 오버레이 (2D, 리사이즈 시 1회 그림) — 신조차 통유리창
   ===================================================================== */
function drawCab(w, h) {
  const g = cabCanvas.getContext('2d');
  cabCanvas.width = w; cabCanvas.height = h; g.clearRect(0, 0, w, h);
  // 창 하단 위치: 컨테이너의 data-win-bottom (기본 0.715). 값이 클수록 창 아래 콘솔이 얇아짐
  const botF = clamp(+STAGE.dataset.winBottom || 0.715, 0.6, 0.9), topF = 0.07;
  const top = topF * h, bot = botF * h, lT = 0.05 * w, rT = 0.95 * w, lB = 0.035 * w, rB = 0.965 * w, rad = 0.05 * h;
  const win = new Path2D();
  win.moveTo(lT + rad, top); win.lineTo(rT - rad, top); win.quadraticCurveTo(rT, top, rT + (rB - rT) * 0.08, top + rad);
  win.lineTo(rB, bot - rad); win.quadraticCurveTo(rB, bot, rB - rad, bot); win.lineTo(lB + rad, bot);
  win.quadraticCurveTo(lB, bot, lB, bot - rad); win.lineTo(lT - (lT - lB) * 0.08, top + rad); win.quadraticCurveTo(lT, top, lT + rad, top); win.closePath();
  // 실내 패널 (연하늘)
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#d5e2ea'); bg.addColorStop(0.4, '#c3d4df'); bg.addColorStop(0.72, '#b4c7d4'); bg.addColorStop(1, '#9fb4c3');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const side = (x0, x1, dir) => { const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, 'rgba(60,80,95,.28)'); gr.addColorStop(1, 'rgba(60,80,95,0)'); g.fillStyle = gr; g.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h); };
  side(0, 0.06 * w); side(w, 0.94 * w);
  // 콘솔 상판
  const ct = bot + 0.03 * h;
  const cg = g.createLinearGradient(0, ct, 0, h);
  cg.addColorStop(0, '#e3edf3'); cg.addColorStop(0.08, '#c7d7e1'); cg.addColorStop(1, '#a9bccb');
  g.fillStyle = cg; g.beginPath(); g.moveTo(0, ct + 0.02 * h); g.quadraticCurveTo(w / 2, ct - 0.012 * h, w, ct + 0.02 * h); g.lineTo(w, h); g.lineTo(0, h); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = Math.max(1, h * 0.003);
  g.beginPath(); g.moveTo(0, ct + 0.02 * h); g.quadraticCurveTo(w / 2, ct - 0.012 * h, w, ct + 0.02 * h); g.stroke();
  g.fillStyle = 'rgba(70,85,95,.35)';
  for (const x of [0.2, 0.36, 0.64, 0.8]) { g.beginPath(); g.arc(x * w, ct + 0.06 * h, h * 0.006, 0, 7); g.fill(); }
  g.fillStyle = 'rgba(40,50,58,.55)'; g.beginPath(); g.roundRect(0.44 * w, ct + 0.05 * h, 0.12 * w, 0.025 * h, 4); g.fill();
  // 창 개구부 뚫기
  g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fill(win); g.restore();   // 불투명으로 완전히 뚫기
  // 유리 반사 / 상단 차양 그라데이션
  g.save(); g.clip(win);
  const gl = g.createLinearGradient(0, top, 0, bot);
  gl.addColorStop(0, 'rgba(30,40,50,.28)'); gl.addColorStop(0.12, 'rgba(30,40,50,0)'); gl.addColorStop(0.85, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(210,225,235,.10)');
  g.fillStyle = gl; g.fillRect(0, 0, w, h);
  const rf = g.createLinearGradient(0.1 * w, top, 0.5 * w, bot);
  rf.addColorStop(0, 'rgba(255,255,255,0)'); rf.addColorStop(0.48, 'rgba(255,255,255,.035)'); rf.addColorStop(0.52, 'rgba(255,255,255,0)');
  g.fillStyle = rf; g.fillRect(0, 0, w, h);
  // 롤 블라인드 하우징 (좌측)
  g.fillStyle = '#2b3137'; g.fillRect(lT + rad * 0.4, top, 0.42 * w, 0.032 * h);
  g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(lT + rad * 0.4, top + 0.026 * h, 0.42 * w, 0.004 * h);
  g.strokeStyle = 'rgba(20,24,28,.85)'; g.lineWidth = Math.max(1, w * 0.0012);
  // 상부 카메라/미러 모듈
  g.fillStyle = '#b9cbd6'; g.beginPath(); g.roundRect(0.48 * w, top - 4, 0.085 * w, 0.115 * h, [0, 0, 10, 10]); g.fill();
  g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0.485 * w, top, 0.075 * w, 0.006 * h);
  g.fillStyle = '#a9bdca'; g.beginPath(); g.roundRect(0.575 * w, top - 4, 0.03 * w, 0.12 * h, [0, 0, 12, 12]); g.fill();
  g.restore();
  // 고무 가스켓
  g.strokeStyle = '#121518'; g.lineWidth = h * 0.012; g.stroke(win);
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.5; g.save(); g.translate(0, h * 0.007); g.stroke(win); g.restore();
  return { horizon: topF + (botF - topF) * 0.55, path: win, top, bot, left: lB, right: rB, w, h };
}

/* =====================================================================
   8b. 전면창 효과 — 팬터그래프 와이퍼 + 빗방울 (기존 index.html 방식 이식)
       와이퍼: 창 하단 중앙 피벗, 평행 링크로 블레이드 자세 유지, 우측 파킹 ↔ 좌측 최대
   ===================================================================== */
const fxCanvas = document.getElementById('c3d-fx'), fx = fxCanvas.getContext('2d');
let WIN = null;
const WIPER_MODES = ['OFF', 'INT', 'SLOW', 'FAST', 'AUTO'];
const WIPER_KO = { OFF: '끔', INT: '간헐', SLOW: '저속', FAST: '고속', AUTO: '자동' };
const glass = { rainOn: false, rain: 0, drops: [], wiperMode: 'AUTO', wiperAngle: 0, wiperTimer: 0 };
/* 기존 CV_WIPER 제원 (창 높이 376px 기준) */
const WIPER = { ref: 376, aux: [21, -2], arm: 286, park: -0.793, sweep: -2.348, top: 200, bottom: 210, tiltPark: 0.12, tiltSweep: -0.12 };
function wiperTiming() {
  switch (glass.wiperMode) {
    case 'INT': return { period: 1.6, pause: 2.2 };
    case 'SLOW': return { period: 1.5, pause: 0 };
    case 'FAST': return { period: 0.85, pause: 0 };
    case 'AUTO': return glass.rain > 0.05 ? { period: 1.3, pause: glass.rain > 0.5 ? 0 : 1.6 } : { period: 0, pause: 0 };
    default: return { period: 0, pause: 0 };
  }
}
function updateWiper(dt) {
  const m = wiperTiming();
  if (m.period <= 0) { glass.wiperAngle += (0 - glass.wiperAngle) * Math.min(1, dt * 5); glass.wiperTimer = 0; return; }
  glass.wiperTimer += dt;
  const t = glass.wiperTimer % (m.period + m.pause);
  if (t < m.period) glass.wiperAngle = 0.5 * (1 - Math.cos(t / m.period * Math.PI * 2));
  else glass.wiperAngle += (0 - glass.wiperAngle) * Math.min(1, dt * 8);
}
function wiperGeo(progress) {
  const k = (WIN.bot - WIN.top) / WIPER.ref, p = clamp(progress, 0, 1);
  const base = { x: WIN.w / 2, y: WIN.bot - 4 * k }, aux = { x: base.x + WIPER.aux[0] * k, y: base.y + WIPER.aux[1] * k };
  const ang = WIPER.park + (WIPER.sweep - WIPER.park) * p;
  const pj = { x: base.x + WIPER.arm * k * Math.cos(ang), y: base.y + WIPER.arm * k * Math.sin(ang) };
  const qj = { x: pj.x + aux.x - base.x, y: pj.y + aux.y - base.y };
  const tilt = WIPER.tiltPark + (WIPER.tiltSweep - WIPER.tiltPark) * p, ub = { x: Math.sin(tilt), y: -Math.cos(tilt) };
  return { k, base, aux, pj, qj, ub,
    top: { x: pj.x + ub.x * WIPER.top * k, y: pj.y + ub.y * WIPER.top * k },
    bottom: { x: pj.x - ub.x * WIPER.bottom * k, y: pj.y - ub.y * WIPER.bottom * k } };
}
function drawWiper(g) {
  const w = wiperGeo(glass.wiperAngle), k = w.k;
  const line = (a, b, lw, c) => { g.strokeStyle = c; g.lineWidth = lw * k; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };
  const dot = (c, r, fill, stroke) => { g.fillStyle = fill; g.strokeStyle = stroke; g.lineWidth = 1.2 * k; g.beginPath(); g.arc(c.x, c.y, r * k, 0, 7); g.fill(); g.stroke(); };
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 6 * k; g.shadowOffsetX = 3 * k; g.shadowOffsetY = 4 * k;
  line(w.base, w.pj, 5.2, '#181b20');                    // 메인 암
  line(w.aux, w.qj, 3.2, '#22262d');                     // 보조 평행 링크
  g.shadowColor = 'transparent';
  line({ x: w.base.x - 0.7 * k, y: w.base.y - 0.7 * k }, { x: w.pj.x - 0.7 * k, y: w.pj.y - 0.7 * k }, 1.4, 'rgba(148,163,184,.28)');
  // 블레이드 중앙 브래킷
  const nb = { x: -w.ub.y, y: w.ub.x }, bt = { x: w.pj.x + w.ub.x * 22 * k, y: w.pj.y + w.ub.y * 22 * k }, bb = { x: w.pj.x - w.ub.x * 22 * k, y: w.pj.y - w.ub.y * 22 * k };
  g.fillStyle = '#262a32'; g.strokeStyle = '#475569'; g.lineWidth = 1.6 * k; g.beginPath();
  g.moveTo(bt.x, bt.y); g.lineTo(w.qj.x + nb.x * 3.5 * k, w.qj.y + nb.y * 3.5 * k); g.lineTo(w.qj.x - nb.x * 3.5 * k, w.qj.y - nb.y * 3.5 * k);
  g.lineTo(bb.x, bb.y); g.lineTo(w.pj.x - nb.x * 4.5 * k, w.pj.y - nb.y * 4.5 * k); g.closePath(); g.fill(); g.stroke();
  // 일체형 롱 블레이드 (고무 + 가이드 바 + 하이라이트)
  line(w.bottom, w.top, 7.0, '#0a0c0f'); line(w.bottom, w.top, 4.0, '#2b303a');
  line({ x: w.bottom.x + 0.6 * k, y: w.bottom.y }, { x: w.top.x + 0.6 * k, y: w.top.y }, 1.2, 'rgba(203,213,225,.45)');
  dot(w.pj, 4.5, '#1e232a', '#94a3b8'); dot(w.qj, 3.2, '#1e232a', '#64748b');
  dot(w.base, 6.0, '#15181d', '#334155'); dot(w.aux, 4.5, '#15181d', '#334155');
  g.restore();
}
function segDist2(px, py, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, t = clamp(((px - a.x) * vx + (py - a.y) * vy) / (vx * vx + vy * vy), 0, 1);
  const dx = px - (a.x + vx * t), dy = py - (a.y + vy * t); return dx * dx + dy * dy;
}
function updateRain(g, dt) {
  const k = (WIN.bot - WIN.top) / WIPER.ref, drops = glass.drops;
  const outdoor = !isUnder(zc(train.s));
  if (glass.rain > 0.02 && outdoor) {
    const spawn = glass.rain * 34 * dt * ((WIN.right - WIN.left) * (WIN.bot - WIN.top)) / (800 * 350 * k * k);
    let n = Math.floor(spawn) + (Math.random() < spawn % 1 ? 1 : 0);
    while (n-- > 0 && drops.length < 320) drops.push({ x: rr(WIN.left, WIN.right), y: rr(WIN.top, WIN.bot), r: (1.2 + Math.random() * 2.6) * k, v: 0 });
  }
  if (!outdoor) for (let i = drops.length - 1; i >= 0; i--) if (Math.random() < dt * 0.5) drops.splice(i, 1);   // 터널: 서서히 마름
  const wind = Math.min(2.4, train.v * 3.6 * 0.045), w = wiperGeo(glass.wiperAngle);
  const rB = 380 * k * k, rA = 220 * k * k;
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.v += (d.r / k * 0.55 - d.v) * dt * 2.2;
    d.y += d.v * dt * 26 * k; d.x += wind * dt * 14 * (d.r / (3 * k)) * k;
    if (segDist2(d.x, d.y, w.bottom, w.top) < rB || segDist2(d.x, d.y, w.base, w.pj) < rA || d.y > WIN.bot || d.x > WIN.right) drops.splice(i, 1);
  }
  for (const d of drops) {
    g.fillStyle = 'rgba(232,241,248,0.30)'; g.beginPath(); g.ellipse(d.x, d.y, d.r * 0.8, d.r * 1.15, 0, 0, 6.2832); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(d.x - d.r * 0.28, d.y - d.r * 0.34, d.r * 0.3, 0, 6.2832); g.fill();
    if (d.v > 1.4) { g.strokeStyle = 'rgba(226,238,246,0.22)'; g.lineWidth = d.r * 0.8; g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x - wind * 3 * k, d.y - d.v * 6 * k); g.stroke(); }
  }
  if (glass.rain > 0.25 && outdoor) {                     // 공중 빗줄기
    g.strokeStyle = `rgba(214,226,238,${0.12 + glass.rain * 0.16})`; g.lineWidth = Math.max(1, k);
    const t = performance.now() * 0.001;
    for (let i = 0; i < 90; i++) {
      const hh = Math.abs((Math.sin(i * 127.1 + Math.floor(t * 12) * 311.7) * 43758.5453) % 1);
      const x = WIN.left + hh * (WIN.right - WIN.left), y = WIN.top + ((hh * 977 + t * 900) * k) % (WIN.bot - WIN.top);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - (5 + wind * 3) * k, y + 22 * k); g.stroke();
    }
  }
}
function drawGlassFx(dt) {
  if (!WIN) return;
  const target = isUnder(zc(train.s)) ? 0 : clamp(+glass.rainOn || 0, 0, 1);   // 비 강도 0~1 (지하는 0)
  glass.rain += (target - glass.rain) * Math.min(1, dt * 0.35);
  updateWiper(dt);
  fx.clearRect(0, 0, WIN.w, WIN.h);
  fx.save(); fx.clip(WIN.path);
  if (glass.rain > 0.01 || glass.drops.length) updateRain(fx, dt);
  drawWiper(fx);
  fx.restore();
}



/* =====================================================================
   10. 카메라 / 노출 / 반대 열차
   ===================================================================== */
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), up = new THREE.Vector3(), _d = new THREE.Vector3();
let exposure = 1, inside = 0, time = 0;
function updateCamera(dt) {
  const s = train.s - 1.0, k = train.v / 22;
  Wabs(s + 4, TRK, EYE, camTgt); Wabs(s - 9, TRK, EYE, _v);
  const dir = _d.copy(camTgt).sub(_v).normalize();
  Wabs(s, TRK, EYE, camPos);
  const bob = (Math.sin(time * 7.1) * 0.5 + Math.sin(time * 12.7 + 1) * 0.3 + Math.sin(train.s * 0.9) * 0.4) * 0.006 * k;
  const sway = (Math.sin(train.s * 0.11) * 0.6 + Math.sin(train.s * 0.37 + 2) * 0.4) * 0.018 * k;
  at(s); camPos.x += Math.cos(F.h) * sway; camPos.z += Math.sin(F.h) * sway; camPos.y += bob;
  camera.position.copy(camPos);
  const roll = clamp(curv(s) * 32, -0.06, 0.06) + Math.sin(train.s * 0.23) * 0.0025 * k;
  up.set(0, 1, 0).applyAxisAngle(dir, roll); camera.up.copy(up);
  camera.lookAt(camPos.x + dir.x, camPos.y + dir.y, camPos.z + dir.z);
  // 지상/지하 전환 (눈 순응 지연)
  const c = zc(train.s), pd = PD[clamp(Math.round(train.s - START), 0, NS - 1)];
  const sIn = isUnder(c) ? clamp((pd + 5) / 25, 0, 1) : 0;
  inside += (sIn - inside) * Math.min(1, dt / 0.6);
  scene.fog.color.copy(FOG_OUT).lerp(FOG_IN, inside);
  scene.fog.density = lerp(0.0011, 0.0075, inside);
  const st = stationAt(train.s), inSt = st && st.type === 'under' && Math.abs(train.s - st.s) < PLAT / 2 + 40;
  const target = !isUnder(c) ? 1.0 : inSt ? 1.15 : lerp(1.0, 1.4, clamp(pd / 40, 0, 1));
  exposure += (target - exposure) * Math.min(1, dt / 1.4);
  renderer.toneMappingExposure = exposure;
  const wet = glass.rain * (1 - inside);                 // 우천: 시정 저하·흐린 조명
  if (wet > 0.001) { scene.fog.color.lerp(FOG_RAIN, wet); scene.fog.density += 0.0035 * wet; }
  hemi.intensity = lerp(1.9, 0.95, inside) * (1 - 0.25 * wet); sun.intensity = lerp(2.3, 0.2, inside) * (1 - 0.7 * wet);
}
const _b0 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
function updateOpp(o, dt) {
  if (!o.active) {
    o.cool -= dt; o.g.visible = false;
    if (o.cool <= 0 && train.s + 1000 < END - 60) {
      o.active = true; o.s = train.s + 1000; o.v = 15; o.a = 0; o.dwell = 0;
      const st = STN.find(x => o.s > x.s - 60 && o.s < x.s + 60); if (st) o.s = st.s + 70;
    }
    return;
  }
  // 상선 다음 정차역 (s 감소 방향)
  let ns = null; for (const st of STN) if (st.oppStop < o.s - 0.5) ns = st;
  if (o.dwell > 0) { o.dwell -= dt; o.v = 0; }
  else {
    const d = ns ? o.s - ns.oppStop : 1e9;
    const vt = Math.min(19.4, limitAt(o.s) - 0.5, Math.sqrt(Math.max(0, 2 * 0.75 * (d - 0.2))));
    o.a += (clamp((vt - o.v) * 0.9, -1.0, 0.8) - o.a) * Math.min(1, dt / 0.6);
    o.v = Math.max(0, o.v + o.a * dt); o.s -= o.v * dt;
    if (ns && d < 0.4 && o.v < 0.3) { o.dwell = 20; o.v = 0; o.a = 0; o.s = ns.oppStop - 0.6; }
  }
  if (o.s + 40 < train.s - 150 || o.s < START + 60) { o.active = false; o.cool = rr(25, 60); o.g.visible = false; return; }
  o.g.visible = true;
  // 차체는 앞뒤 대차 중심(±6.5m)을 잇는 방향 → 구배·곡선을 따라 기울어짐
  o.cars.forEach((c, i) => {
    const sc = o.s + 8.8 + i * 18.2;
    Wabs(sc - 6.5, -TRK, 0, _b0); Wabs(sc + 6.5, -TRK, 0, _b1);
    _bz.subVectors(_b0, _b1).normalize();                 // 로컬 +Z = 진행방향(s 감소) = 전면
    _bx.crossVectors(_bU, _bz).normalize(); _by.crossVectors(_bz, _bx);
    _m.makeBasis(_bx, _by, _bz);
    _v.addVectors(_b0, _b1).multiplyScalar(0.5).addScaledVector(_by, 1.95);
    _m.setPosition(_v); c.matrix.copy(_m);
  });
  const lv = clamp(lightAt(o.s, -TRK, 2), 0.25, 1.6); o.mats.forEach(m => m.color.setScalar(lv));
  const p = o.heads.geometry.attributes.position;
  Wabs(o.s - 0.05, -TRK - 0.85, 0.85, _v); p.setXYZ(0, _v.x, _v.y, _v.z);
  Wabs(o.s - 0.05, -TRK + 0.85, 0.85, _v); p.setXYZ(1, _v.x, _v.y, _v.z); p.needsUpdate = true;
}

/* =====================================================================
   11. 크기 / 해상도 자동 조절
   ===================================================================== */
let renderScale = 0.85, autoQ = true, cssW = 0, cssH = 0;
function resize() {
  cssW = STAGE.clientWidth || innerWidth; cssH = STAGE.clientHeight || innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(1);
  renderer.setSize(Math.round(cssW * dpr * renderScale), Math.round(cssH * dpr * renderScale), false);
  WIN = drawCab(Math.round(cssW * dpr), Math.round(cssH * dpr));
  fxCanvas.width = WIN.w; fxCanvas.height = WIN.h;
  const { horizon } = WIN;
  const aspect = cssW / cssH, k = 1.2, vfov = 2 * Math.atan(Math.tan(36 * Math.PI / 180) / aspect);
  camera.aspect = aspect;
  camera.fov = 2 * Math.atan(Math.tan(vfov / 2) * k) * 180 / Math.PI;
  camera.setViewOffset(cssW, cssH * k, 0, cssH * (k / 2 - horizon), cssW, cssH);
  camera.updateProjectionMatrix();
}
let fpsAcc = 0, fpsN = 0, fps = 60, lastAdj = 0;
function adaptQuality(dt, now) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc < 1) return;
  fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
  if (!autoQ || now - lastAdj < 2500) return;
  if (fps < 42 && renderScale > 0.5) { renderScale = Math.max(0.5, renderScale - 0.1); lastAdj = now; resize(); }
  else if (fps > 57 && renderScale < 1) { renderScale = Math.min(1, renderScale + 0.05); lastAdj = now; resize(); }
}


/* =====================================================================
   12. 외부 연동 API + 렌더 루프
   ===================================================================== */
let opp, sky, far;
function jumpReset() {
  const c = zc(train.s); inside = isUnder(c) ? 1 : 0; exposure = isUnder(c) ? 1.4 : 1;
  opp.active = false; opp.cool = 6; glass.drops.length = 0;
  updateChunks(train.s, 99);
}
window.CabView3D = {
  /* s: 위치(m), v: 속도(m/s), rain: 비 강도 0~1 또는 bool, wiper: 'OFF'|'INT'|'SLOW'|'FAST'|'AUTO', doorsOpen: bool */
  update(st) {
    if (st.s !== undefined) {
      const jump = Math.abs(st.s - train.s) > 200;
      train.s = clamp(st.s, START + 50, END - 40);
      if (jump) jumpReset();
    }
    if (st.v !== undefined) train.v = Math.max(0, st.v);
    if (st.rain !== undefined) glass.rainOn = typeof st.rain === 'number' ? clamp(st.rain, 0, 1) : (st.rain ? 1 : 0);
    if (st.wiper !== undefined && WIPER_MODES.includes(st.wiper)) glass.wiperMode = st.wiper;
  },
  setQuality(q) { autoQ = q === 'auto'; if (!autoQ) renderScale = +q; resize(); },
  resize() { resize(); },
  spawnOncoming(dist = 300, frozen = false) { opp.active = true; opp.s = train.s + dist; opp.v = frozen ? 0 : 15; opp.dwell = frozen ? 1e9 : 0; },
  get stats() { return { fps: Math.round(fps), scale: renderScale, chunks: chunks.size, zone: zc(train.s) }; },
  get renderInfo() { updateCamera(0.016); updateLod(); renderer.render(scene, camera); const r = renderer.info.render; return { calls: r.calls, tris: r.triangles, chunks: chunks.size, geos: renderer.info.memory.geometries }; },
  get glass() { return { rain: glass.rain, wiper: glass.wiperMode }; },
};

const t0 = performance.now();
({ sky, far } = buildSkyFar());
opp = buildOppTrain();
updateChunks(train.s, 99);
resize();
new ResizeObserver(() => resize()).observe(STAGE);
console.log(`[cabview3d] init ${(performance.now() - t0).toFixed(0)} ms`);
window.dispatchEvent(new Event('cabview3d-ready'));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  if (STAGE.offsetParent !== null || STAGE === document.body) {
    updateChunks(train.s, 1); updateCamera(dt); updateOpp(opp, dt); updateLod();
    sky.position.copy(camera.position); far.position.set(camera.position.x, 0, camera.position.z);
    renderer.render(scene, camera);
    drawGlassFx(dt);
    adaptQuality(dt, now);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
