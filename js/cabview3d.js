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
const train = { s: SID['201'].stop, v: 0, dir: 1, head: 'LOW' };   // head: 전조등 'LOW' | 'HIGH' | 'OFF'   // dir: +1 하선(+u 선로, s 증가) / -1 상선(-u 선로, s 감소)
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
/* 전조등: 모든 재질 셰이더에 '전조등 빛' 항을 주입 (구운 조명을 쓰는 Basic 재질의 벽·바닥까지 함께 밝아짐)
   하향 = 평소 / 상향 = 더 밝고 멀리. 원뿔 각도 + 거리 감쇠, 재질 고유색(구운 조명 제외) 기준 */
const HEAD = {
  LOW:  { k: 0.65, range: 70,  cos: 0.80, aim: 30 },
  HIGH: { k: 1.6, range: 220, cos: 0.84, aim: 90 },
};
const HL = { pos: { value: new THREE.Vector3() }, dir: { value: new THREE.Vector3(0, 0, -1) }, k: { value: 0 }, range: { value: 75 }, cos: { value: 0.8 } };
function withHeadlight(mat) {
  if (!mat || !(mat.isMeshBasicMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) return mat;
  if (mat.blending === THREE.AdditiveBlending) return mat;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { hlPos: HL.pos, hlDir: HL.dir, hlK: HL.k, hlRange: HL.range, hlCos: HL.cos });
    sh.vertexShader = 'varying vec3 vHlW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      `vec4 hlw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        hlw = instanceMatrix * hlw;
      #endif
      vHlW = (modelMatrix * hlw).xyz;
      #include <project_vertex>`);
    sh.fragmentShader = 'uniform vec3 hlPos; uniform vec3 hlDir; uniform float hlK, hlRange, hlCos; varying vec3 vHlW;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', 'vec3 hlAlb = diffuseColor.rgb;\n#include <color_fragment>')
      .replace('#include <opaque_fragment>', `if (hlK > 0.0) {
        vec3 hd = vHlW - hlPos; float hL = max(length(hd), 0.5);
        float cone = smoothstep(hlCos - 0.06, hlCos + 0.10, dot(hd / hL, hlDir));
        float fall = clamp(1.0 - hL / hlRange, 0.0, 1.0);
        outgoingLight += hlAlb * vec3(1.0, 0.95, 0.86) * hlK * cone * fall * fall * (0.9 / (1.0 + hL * 0.10));
      }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'hl1';
  return mat;
}

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
/* ---------- 반대편 열차 (인천2호선 전동차: 은색 차체 + 주황 띠, 검은 전면 + 은색 테두리) ----------
   차체 단면(오른쪽 절반, 아래 → 지붕 가운데). 중심 기준 y: -1.625(차체 하단) ~ +1.625(지붕) */
const CAR_L = 17.6, CAR_H = 3.25;
const CAR_HALF = (() => {
  const P = [[0, -1.625], [1.27, -1.625], [1.36, -1.48], [1.385, -0.7], [1.38, 0.15], [1.34, 0.95]];
  for (let i = 1; i <= 7; i++) { const t = i / 7 * Math.PI / 2; P.push([0.93 + 0.41 * Math.cos(t), 1.215 + 0.41 * Math.sin(t)]); }
  P.push([0, 1.625]);
  return P;
})();
/* 단면 전체 둘레(오른쪽 아래 중심 → 오른쪽 → 지붕 → 왼쪽 → 아래 중심)와 둘레 위치(v) */
const CAR_LOOP = (() => {
  const R = CAR_HALF, L = R.slice(1, -1).reverse().map(([x, y]) => [-x, y]);
  const pts = [...R, ...L, [0, -1.625]];
  const len = [0]; for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return pts.map((p, i) => ({ x: p[0], y: p[1], v: len[i] / len[len.length - 1] }));
})();
/* 차체 높이 y → 측면 텍스처 v (side: +1 오른쪽, -1 왼쪽) */
function carV(y, side) {
  const seg = side > 0 ? CAR_LOOP.slice(0, 7) : CAR_LOOP.slice(CAR_LOOP.length - 8);
  const S = side > 0 ? seg : seg.slice().reverse();          // 아래 → 위 순서
  for (let i = 1; i < S.length; i++) if (y <= S[i].y || i === S.length - 1) {
    const t = clamp((y - S[i - 1].y) / ((S[i].y - S[i - 1].y) || 1), 0, 1); return S[i - 1].v + (S[i].v - S[i - 1].v) * t;
  }
  return S[S.length - 1].v;
}
const SIDE_W = 2048, SIDE_H = 512;
/* 측면 칠하기: 길이 x(m, 0 = 뒤끝, CAR_L = 운전실 앞끝) × 높이 y 구간을 양쪽 측면에 */
function sideRect(g, x0, x1, y0, y1, fill) {
  g.fillStyle = fill;
  for (const side of [1, -1]) {
    const va = carV(y0, side), vb = carV(y1, side), top = (1 - Math.max(va, vb)) * SIDE_H, bot = (1 - Math.min(va, vb)) * SIDE_H;
    g.fillRect(x0 / CAR_L * SIDE_W, top, (x1 - x0) / CAR_L * SIDE_W, bot - top);
  }
}
const CAR_DOORS = [2.7, 8.1, 13.5];            // 출입문 중심 (뒤끝 기준 m)
const CAR_WINS = [[0.35, 1.85], [3.55, 7.25], [8.95, 12.65]];   // 측창 구간
const CAB_WIN = [14.75, 15.85];                 // 운전실 측창 (검은 패널 안)
T.trainSide = canvasTex(SIDE_W, SIDE_H, (g, w, h) => {
  g.fillStyle = '#c3c7cb'; g.fillRect(0, 0, w, h);                                    // 은색 차체
  // 지붕 (측면 위쪽 끝 ~ 지붕 가운데)
  const rv0 = carV(0.95, 1), rv1 = carV(0.95, -1);
  g.fillStyle = '#d3d6d9'; g.fillRect(0, (1 - rv1) * h, w, (rv1 - rv0) * h);
  for (let x = 0.4; x < CAR_L; x += 1.2) { g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(x / CAR_L * w, (1 - rv1) * h, 2, (rv1 - rv0) * h); }
  sideRect(g, 0, CAR_L, -1.625, -1.47, '#3b3e42');                                   // 하부 치마
  sideRect(g, 0, CAR_L, -0.46, -0.40, '#f5f5f3');                                    // 흰 줄
  sideRect(g, 0, CAR_L, -0.40, -0.16, '#ef8a1e');                                    // 주황 띠
  for (const [a, b] of CAR_WINS) { sideRect(g, a - 0.06, b + 0.06, -0.06, 0.9, '#15181b'); sideRect(g, a, b, 0.0, 0.84, '#1f2a33'); }
  for (const c of CAR_DOORS) {                                                         // 양문형 출입문
    sideRect(g, c - 0.68, c + 0.68, -1.5, 0.92, '#55595e');
    sideRect(g, c - 0.65, c + 0.65, -1.47, 0.89, '#aeb3b8');
    sideRect(g, c - 0.55, c - 0.08, -0.05, 0.78, '#1f2a33'); sideRect(g, c + 0.08, c + 0.55, -0.05, 0.78, '#1f2a33');
    sideRect(g, c - 0.012, c + 0.012, -1.47, 0.89, '#3d4145');
  }
  // 운전실 쪽 끝: 주황·흰 띠가 앞으로 갈수록 아래로 휘어 내려가 은색 앞 덮개 밑단에 닿고, 띠 위쪽은 검은 패널
  const X0 = 14.25, X1 = 16.75, NS = 60;                 // 곡선 시작 · 앞 덮개 시작 (뒤끝 기준 m)
  const drop = x => { const t = clamp((x - X0) / (X1 - X0), 0, 1); return Math.pow(t, 1.7) * 1.08; };
  for (let i = 0; i < NS; i++) {
    const x = X0 + (X1 - X0) * i / NS, dx = (X1 - X0) / NS + 0.01, d = drop(x + dx / 2);
    sideRect(g, x, x + dx, -0.16 - d, 1.0, '#141618');                    // 검은 패널 (띠 위)
    sideRect(g, x, x + dx, -0.40 - d, -0.16 - d, '#ef8a1e');              // 주황 띠
    sideRect(g, x, x + dx, -0.46 - d, -0.40 - d, '#f5f5f3');              // 흰 줄
  }
  sideRect(g, X1, CAR_L, -1.47, 1.0, '#c3c7cb');                           // 은색 앞 덮개
  sideRect(g, CAB_WIN[0] - 0.05, CAB_WIN[1] + 0.05, -0.05, 0.9, '#0b0c0d');
  sideRect(g, CAB_WIN[0], CAB_WIN[1], 0.0, 0.84, '#26313a');               // 운전실 측창
  sideRect(g, 14.45, 14.55, 0.62, 0.84, '#e0412f');                         // 측창 옆 표시등
  // Fly Incheon 로고 (검은 패널 왼쪽)
  for (const side of [1, -1]) {
    const y = (1 - carV(0.35, side)) * h, x = 14.3 / CAR_L * w;
    g.font = 'bold italic 26px Arial'; g.fillStyle = '#3b82f6'; g.fillText('F', x, y);
    g.fillStyle = '#ef8a1e'; g.fillText('ly', x + 13, y + 4);
  }
  g.fillStyle = '#1b1d20'; g.font = 'bold 22px Arial';                                 // 편성 번호
  for (const side of [1, -1]) g.fillText('2116', 12.0 / CAR_L * w, (1 - carV(-1.0, side)) * h);
}, { repeat: false });
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
T.trainSideLit = canvasTex(SIDE_W, SIDE_H, (g, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const lit = (x0, x1, y0, y1) => { for (const side of [1, -1]) {
    const va = carV(y0, side), vb = carV(y1, side), top = (1 - Math.max(va, vb)) * h, bot = (1 - Math.min(va, vb)) * h;
    litCabin(g, x0 / CAR_L * w, top, (x1 - x0) / CAR_L * w, bot - top); } };
  for (const [a, b] of CAR_WINS) lit(a, b, 0.0, 0.84);
  lit(CAB_WIN[0], CAB_WIN[1], 0.0, 0.84);
  for (const c of CAR_DOORS) { lit(c - 0.55, c - 0.08, -0.05, 0.78); lit(c + 0.08, c + 0.55, -0.05, 0.78); }
}, { repeat: false });
/* 전면: 은색 테두리 안 검은 면 — 창 3개(가운데 비상문)·행선 표시기·전조등/미등·그릴·주황 엠블럼·편성 번호 */
const FW = 512, FH = 640;
/* 전면 (실물 사진 기준): 넓은 은색 좌우 덮개 + 위쪽 짙은 회색 띠, 가운데 검은 면
   위: 창 3개(가운데 비상문은 별도 문틀 안 작은 창) + 와이퍼
   아래: 검은 가로 리브 / 가운데 주황 가로줄 + 엠블럼 주황 판 / 양쪽 흰 하우징 둥근 전조등 + 빨간 LED 미등 / 편성 번호
   맨 아래: 검은 리브 띠 + 은색 하부 덮개와 연결기 */
/* 마주 오는 열차 행선: 내 열차와 반대 방향의 종착역 (내가 하선 → 상선 열차 '검단오류' / 내가 상선 → 하선 열차 '운연') */
let OPP_DEST = '검단오류';
function frontFace(g, lit) {
  const W = FW, H = FH, X = f => f * W, Y = f => f * H;
  const L = 0.15, R = 0.85, C0 = 0.395, C1 = 0.605;          // 검은 면 좌우 끝 · 가운데 기둥
  if (lit) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
  else {
    // 은색 덮개 (가장자리로 갈수록 어둡게 → 둥근 느낌)
    const sg = g.createLinearGradient(0, 0, W, 0);
    sg.addColorStop(0, '#9da3a9'); sg.addColorStop(0.07, '#d3d7db'); sg.addColorStop(0.15, '#c4c9ce');
    sg.addColorStop(0.85, '#c4c9ce'); sg.addColorStop(0.93, '#d3d7db'); sg.addColorStop(1, '#9da3a9');
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    g.fillStyle = '#4a4f55'; g.fillRect(X(L), Y(0.055), X(R - L), Y(0.10));                 // 위쪽 짙은 회색 띠
    g.fillStyle = '#121416'; g.fillRect(X(L), Y(0.15), X(R - L), Y(0.68));                  // 검은 면
    // 검은 가로 리브 (창 아래 ~ 하단)
    for (let y = 0.535; y < 0.83; y += 0.0165) { g.fillStyle = '#25282c'; g.fillRect(X(L), Y(y), X(R - L), 3); }
    // 가운데 기둥: 주황 가로줄 + 엠블럼 주황 판
    for (let y = 0.535; y < 0.79; y += 0.0165) { if (y > 0.565 && y < 0.645) continue; g.fillStyle = '#d9761a'; g.fillRect(X(C0), Y(y), X(C1 - C0), 4); }
    g.fillStyle = '#ef8a1e'; g.fillRect(X(C0), Y(0.57), X(C1 - C0), Y(0.072));
    g.fillStyle = '#f7f1e6'; g.beginPath(); g.moveTo(X(0.48), Y(0.585)); g.lineTo(X(0.52), Y(0.578)); g.lineTo(X(0.515), Y(0.627)); g.lineTo(X(0.475), Y(0.633)); g.fill();
    g.fillStyle = '#5fb3d9'; g.beginPath(); g.arc(X(0.522), Y(0.618), 7, 0, 7); g.fill();
    // 하단 검은 리브 띠 + 은색 하부 덮개 + 연결기
    g.fillStyle = '#16181b'; g.fillRect(X(L - 0.02), Y(0.83), X(R - L + 0.04), Y(0.035));
    for (let y = 0.835; y < 0.865; y += 0.01) { g.fillStyle = '#2c3035'; g.fillRect(X(L - 0.02), Y(y), X(R - L + 0.04), 2); }
    g.fillStyle = '#3a3e43'; g.beginPath(); g.roundRect(X(0.41), Y(0.865), X(0.18), Y(0.075), 6); g.fill();
    g.fillStyle = '#26292d'; g.beginPath(); g.arc(X(0.5), Y(0.905), 16, 0, 7); g.fill();
    // 편성 번호
    g.fillStyle = '#ffffff'; g.font = 'bold 30px Arial'; g.fillText('2113', X(0.215), Y(0.80));
  }
  // 창: 왼쪽 · 오른쪽 (안쪽에 한 단 더 들어간 틀) / 가운데 비상문 (문틀 + 작은 창)
  const glass = (x, y, w, h) => {
    if (lit) { g.save(); g.globalAlpha = 0.5; litCabin(g, X(x), Y(y), X(w), Y(h)); g.restore(); return; }
    const gr = g.createLinearGradient(0, Y(y), 0, Y(y + h)); gr.addColorStop(0, '#3d4a56'); gr.addColorStop(0.45, '#26313b'); gr.addColorStop(1, '#151c23');
    g.fillStyle = gr; g.fillRect(X(x), Y(y), X(w), Y(h));
    g.fillStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(X(x), Y(y + h * 0.75)); g.lineTo(X(x + w * 0.55), Y(y)); g.lineTo(X(x + w * 0.75), Y(y)); g.lineTo(X(x), Y(y + h)); g.fill();
  };
  for (const x of [0.165, 0.625]) {
    if (!lit) { g.fillStyle = '#0a0b0c'; g.fillRect(X(x), Y(0.16), X(0.21), Y(0.365)); }
    glass(x + 0.008, 0.168, 0.194, 0.35);
    if (!lit) { g.strokeStyle = 'rgba(120,130,140,.35)'; g.lineWidth = 2; g.strokeRect(X(x + 0.03), Y(0.25), X(0.15), Y(0.22)); }   // 안쪽 틀
    // 행선 표시기 (창 위쪽 안)
    if (!lit) { g.fillStyle = '#0b0b0b'; g.fillRect(X(x + 0.02), Y(0.175), X(0.17), Y(0.035)); }
    g.fillStyle = '#ff7a1a'; g.font = "bold 15px 'Malgun Gothic'"; g.textAlign = 'center';
    g.fillText(OPP_DEST, X(x + 0.105), Y(0.203)); g.textAlign = 'left';
  }
  if (!lit) { g.fillStyle = '#0a0b0c'; g.fillRect(X(C0), Y(0.205), X(C1 - C0), Y(0.33)); g.fillStyle = '#1c2026'; g.fillRect(X(C0 + 0.01), Y(0.212), X(C1 - C0 - 0.02), Y(0.318)); }
  glass(C0 + 0.04, 0.265, C1 - C0 - 0.08, 0.19);
  // 와이퍼 (양쪽 창 대각선)
  if (!lit) {
    g.strokeStyle = '#08090a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(X(0.30), Y(0.505)); g.lineTo(X(0.215), Y(0.36)); g.stroke();
    g.beginPath(); g.moveTo(X(0.70), Y(0.505)); g.lineTo(X(0.785), Y(0.36)); g.stroke();
  }
  // 전조등 (흰 사각 하우징 + 둥근 램프) · 미등 (빨간 LED)
  for (const [x0, x1, lx] of [[0.20, 0.385, 0.315], [0.615, 0.80, 0.685]]) {
    if (!lit) {
      g.fillStyle = '#e6e9ec'; g.fillRect(X(x0), Y(0.568), X(x1 - x0), Y(0.076));
      for (let y = 0.575; y < 0.64; y += 0.012) { g.fillStyle = 'rgba(150,156,162,.5)'; g.fillRect(X(x0), Y(y), X(lx - x0 - 0.04), 2); }
      g.fillStyle = '#f4f5f6'; g.beginPath(); g.arc(X(lx), Y(0.606), 24, 0, 7); g.fill();
    }
    g.fillStyle = lit ? '#fff6d8' : '#cdbf86'; g.beginPath(); g.arc(X(lx), Y(0.606), lit ? 20 : 16, 0, 7); g.fill();
    const tx = lx - 0.045;
    if (!lit) { g.fillStyle = '#2a0c0e'; g.fillRect(X(tx), Y(0.668), X(0.09), Y(0.026)); }
    g.fillStyle = lit ? '#5a0000' : '#d4232b'; g.fillRect(X(tx + 0.008), Y(0.672), X(0.074), Y(0.018));
  }
}
/* 신조차 전면: 큰 통유리창 + 위 행선 표시기(왼쪽)·열차번호 LED(오른쪽), 창 아래 주황 가는 줄·표지등,
   전조등 줄(흰 하우징 + 가운데 엠블럼 주황 판), 빨간 LED 미등, 가로 그릴(가운데 주황 줄), 편성 번호 */
function frontFaceNew(g, lit) {
  const W = FW, H = FH, X = f => f * W, Y = f => f * H;
  const L = 0.15, R = 0.85, C0 = 0.37, C1 = 0.63;
  if (lit) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
  else {
    const sg = g.createLinearGradient(0, 0, W, 0);
    sg.addColorStop(0, '#9da3a9'); sg.addColorStop(0.07, '#d3d7db'); sg.addColorStop(0.15, '#c4c9ce');
    sg.addColorStop(0.85, '#c4c9ce'); sg.addColorStop(0.93, '#d3d7db'); sg.addColorStop(1, '#9da3a9');
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    g.fillStyle = '#121416'; g.beginPath(); g.roundRect(X(L), Y(0.10), X(R - L), Y(0.73), [18, 18, 4, 4]); g.fill();   // 검은 면
    for (let y = 0.64; y < 0.82; y += 0.0165) { g.fillStyle = '#25282c'; g.fillRect(X(L), Y(y), X(R - L), 3); }       // 그릴
    for (let y = 0.64; y < 0.82; y += 0.0165) { g.fillStyle = '#c96a18'; g.fillRect(X(C0), Y(y), X(C1 - C0), 3); }    // 그릴 가운데 주황 줄
    for (let y = 0.50; y < 0.555; y += 0.013) { g.fillStyle = '#c96a18'; g.fillRect(X(0.30), Y(y), X(0.40), 3); }     // 창 아래 주황 가는 줄
    g.fillStyle = '#ef8a1e'; g.fillRect(X(C0), Y(0.565), X(C1 - C0), Y(0.07));                                       // 엠블럼 주황 판
    g.fillStyle = '#f7f1e6'; g.beginPath(); g.moveTo(X(0.48), Y(0.58)); g.lineTo(X(0.52), Y(0.573)); g.lineTo(X(0.515), Y(0.62)); g.lineTo(X(0.475), Y(0.627)); g.fill();
    g.fillStyle = '#5fb3d9'; g.beginPath(); g.arc(X(0.522), Y(0.612), 7, 0, 7); g.fill();
    g.fillStyle = '#9aa0a6'; g.fillRect(0, Y(0.835), W, Y(0.03));                                                     // 하부 은색 띠
    g.fillStyle = '#2b2f34'; g.fillRect(X(L), Y(0.865), X(R - L), Y(0.135));                                         // 하부
    g.fillStyle = '#3a3e43'; g.beginPath(); g.roundRect(X(0.39), Y(0.86), X(0.22), Y(0.12), 8); g.fill();              // 연결기 덮개
    for (const x of [0.17, 0.75]) for (let y = 0.875; y < 0.95; y += 0.018) { g.fillStyle = '#4b5056'; g.fillRect(X(x), Y(y), X(0.08), 4); }
    g.fillStyle = '#ffffff'; g.font = 'bold 30px Arial'; g.fillText('2038', X(0.18), Y(0.81));                      // 편성 번호
    // 창 위: 행선 표시기(흰 테두리) · 열차번호 LED
    g.fillStyle = '#d9dde1'; g.fillRect(X(0.18), Y(0.13), X(0.25), Y(0.075));
    g.fillStyle = '#1a1d21'; g.fillRect(X(0.188), Y(0.138), X(0.234), Y(0.059));
    g.fillStyle = '#26292d'; g.fillRect(X(0.58), Y(0.13), X(0.24), Y(0.075));
  }
  g.fillStyle = '#ff7a1a'; g.font = "bold 17px 'Malgun Gothic'"; g.textAlign = 'center';
  g.fillText(OPP_DEST, X(0.305), Y(0.178));
  g.font = 'bold 24px monospace'; g.fillText('2230', X(0.70), Y(0.18)); g.textAlign = 'left';
  // 큰 통유리창
  if (lit) { g.save(); g.globalAlpha = 0.5; litCabin(g, X(0.18), Y(0.235), X(0.64), Y(0.245)); g.restore(); }
  else {
    g.fillStyle = '#0a0b0c'; g.beginPath(); g.roundRect(X(0.175), Y(0.228), X(0.65), Y(0.26), 8); g.fill();
    const gr = g.createLinearGradient(0, Y(0.235), 0, Y(0.48)); gr.addColorStop(0, '#3d4a56'); gr.addColorStop(0.5, '#26313b'); gr.addColorStop(1, '#151c23');
    g.fillStyle = gr; g.beginPath(); g.roundRect(X(0.183), Y(0.235), X(0.634), Y(0.245), 6); g.fill();
    g.fillStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(X(0.183), Y(0.42)); g.lineTo(X(0.45), Y(0.235)); g.lineTo(X(0.55), Y(0.235)); g.lineTo(X(0.183), Y(0.48)); g.fill();
    // 팬터그래프 와이퍼 (가운데 아래 축, 평행 팔 2개, 왼쪽 위로)
    g.strokeStyle = '#08090a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(X(0.60), Y(0.545)); g.lineTo(X(0.47), Y(0.34)); g.stroke();
    g.beginPath(); g.moveTo(X(0.63), Y(0.545)); g.lineTo(X(0.50), Y(0.34)); g.stroke();
    g.lineWidth = 3; g.beginPath(); g.moveTo(X(0.455), Y(0.255)); g.lineTo(X(0.455), Y(0.46)); g.stroke();
  }
  // 창 아래 작은 표지등
  g.fillStyle = lit ? '#fffbe8' : '#e6e9ec'; g.beginPath(); g.arc(X(0.70), Y(0.52), lit ? 13 : 10, 0, 7); g.fill();
  // 전조등 (흰 하우징 + 둥근 램프) · 미등 (빨간 LED)
  for (const [x0, x1, lx] of [[0.17, 0.365, 0.27], [0.635, 0.83, 0.73]]) {
    if (!lit) {
      g.fillStyle = '#e6e9ec'; g.fillRect(X(x0), Y(0.565), X(x1 - x0), Y(0.07));
      for (let y = 0.572; y < 0.63; y += 0.012) { g.fillStyle = 'rgba(150,156,162,.5)'; g.fillRect(X(lx + 0.04), Y(y), X(x1 - lx - 0.045), 2); }
    }
    g.fillStyle = lit ? '#fff6d8' : '#cdbf86'; g.beginPath(); g.arc(X(lx), Y(0.60), lit ? 20 : 16, 0, 7); g.fill();
    if (!lit) { g.fillStyle = '#2a0c0e'; g.fillRect(X(lx - 0.055), Y(0.66), X(0.11), Y(0.03)); }
    g.fillStyle = lit ? '#5a0000' : '#d4232b'; g.fillRect(X(lx - 0.045), Y(0.665), X(0.09), Y(0.02));
  }
}
const OPP_FRONTS = [
  ['trainFront', g => frontFace(g, false)], ['trainFrontLit', g => frontFace(g, true)],
  ['trainFrontNew', g => frontFaceNew(g, false)], ['trainFrontNewLit', g => frontFaceNew(g, true)]];
for (const [k, draw] of OPP_FRONTS) T[k] = canvasTex(FW, FH, draw, { repeat: false });
/* 운행 방향이 바뀌면 마주 오는 열차 전면(행선 표시기)을 다시 그림 */
function setOppDest(dir) {
  const d = dir > 0 ? '검단오류' : '운연';
  if (d === OPP_DEST) return;
  OPP_DEST = d;
  for (const [k, draw] of OPP_FRONTS) {
    const c = T[k].image, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height); draw(g); T[k].needsUpdate = true;
  }
}

/* 차체 형상: 단면을 길이 방향으로 뽑은 몸체 + 운전실 쪽 코(앞으로 0.38m, 위로 갈수록 뒤로 기움) + 연결부 마감 */
function buildCarGeometry() {
  const half = CAR_L / 2, NOSE = 0.38, n = CAR_LOOP.length;
  // 몸체
  const pos = [], uv = [], idx = [];
  for (const z of [-half, half]) for (const p of CAR_LOOP) { pos.push(p.x, p.y, z); uv.push(z < 0 ? 0 : 1, p.v); }
  for (let i = 0; i < n - 1; i++) { const a = i, b = i + 1, c = n + i, d = n + i + 1; idx.push(a, c, b, b, c, d); }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); body.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  body.setIndex(idx); body.computeVertexNormals();
  // 전면: 차체 단면 → 조금 작은 단면(앞으로 NOSE, 위쪽은 뒤로 기움) + 앞면
  const fuv = (x, y) => [(x + 1.39) / 2.78, (y + 1.625) / CAR_H];
  const inner = CAR_LOOP.map(p => ({ x: p.x * 0.95, y: -0.12 + (p.y + 0.12) * 0.96 }));
  const zIn = y => half + NOSE - Math.max(0, y) * 0.09;
  const fp = [], fu = [], fi = [];
  for (const p of CAR_LOOP) { fp.push(p.x, p.y, half); fu.push(...fuv(p.x, p.y)); }
  for (const p of inner) { fp.push(p.x, p.y, zIn(p.y)); fu.push(...fuv(p.x, p.y)); }
  for (let i = 0; i < n - 1; i++) { const a = i, b = i + 1, c = n + i, d = n + i + 1; fi.push(a, c, b, b, c, d); }
  const cIdx = fp.length / 3; fp.push(0, -0.12, zIn(0) + 0.02); fu.push(...fuv(0, -0.12));
  for (let i = 0; i < n - 1; i++) fi.push(cIdx, n + i, n + i + 1);
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3)); front.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
  front.setIndex(fi); front.computeVertexNormals();
  // 연결부 쪽 마감 (평면)
  const ep = [0, 0, -half], ei = [];
  for (const p of CAR_LOOP) ep.push(p.x, p.y, -half);
  for (let i = 1; i < n; i++) ei.push(0, i + 1, i);
  const end = new THREE.BufferGeometry();
  end.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3)); end.setIndex(ei); end.computeVertexNormals();
  return { body, front, end };
}

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
  tag: new THREE.MeshLambertMaterial({ color: 0xf2c200, emissive: 0x2a1e00 }),   // 위치 태그 상판 (노란색, 전조등에 비춰 보임)
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
Object.values(MAT).forEach(withHeadlight);
const SIGN_MAT = new Map();
const signMat = (st, basic) => {
  const k = st.id + (basic ? 'b' : 'a');
  if (!SIGN_MAT.has(k)) SIGN_MAT.set(k, withHeadlight(basic ? new THREE.MeshBasicMaterial({ map: signTex(st.name), color: new THREE.Color().setScalar(1.1) })
    : new THREE.MeshLambertMaterial({ map: signTex(st.name) })));
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
    tags.push({ s, u: c, v: -0.095, sx: 0.44, sy: 0.04, sz: 0.13, c: Math.max(l, 0.7) });
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
  const add = (s0, side) => {
    // 역명 기둥은 PSD 시작 끝단에 (고가역 PSD는 승강장 끝에서 4m 앞서 시작)
    const s = under ? s0 : s0 - side * 4.3;
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
  //   바닥 표지 = 정차 시 열차 앞끝 / PSD 표지 = 운전자 옆(앞끝에서 1m 뒤) → 우측 측창으로 확인
  const SIDE_BACK = 1.0;
  if (st.stop - SIDE_BACK >= a && st.stop - SIDE_BACK < b) inst(G.stopR, under ? MAT.stopU : MAT.stopA, [{ s: st.stop - SIDE_BACK, u: 3.69, v: 2.6 }]);
  if (st.stop >= a && st.stop < b) inst(G.stopFront, MAT.stopFront, [{ s: st.stop, u: TRK, v: -0.30 }]);
  // 상선 (반대편 선로, s 감소 방향 진행)
  if (st.oppStop + SIDE_BACK >= a && st.oppStop + SIDE_BACK < b) inst(G.stopR, under ? MAT.stopU : MAT.stopA, [{ s: st.oppStop + SIDE_BACK, u: -3.69, v: 2.6, yaw: Math.PI }]);
  if (st.oppStop >= a && st.oppStop < b) inst(G.stopFront, MAT.stopFront, [{ s: st.oppStop, u: -TRK, v: -0.30, yaw: Math.PI }]);
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
    plate(p.s, rect(-7.5, 7.5, -1.0, top), rect(-BOX_W, BOX_W, -0.45, BOX_H), withHeadlight(new THREE.MeshLambertMaterial({ map: T.concrete, side: DS2 })));
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
  /* 박스↔원형 전환부 막음판: 구멍 = 박스 단면 ∩ 원형 단면
     (원형은 가운데가 박스보다 넓지만 위 모서리는 박스보다 안쪽 → 박스에서 보면 모서리로 바깥 빈 공간이 보이던 것 막음) */
  const bw = BOX_W - 0.01, bt = BOX_H - 0.01, R = TUN_R - 0.02;
  const yAt = x => TUN_CY + Math.sqrt(Math.max(0, R * R - x * x));        // x에서 원 위쪽 높이
  const xAt = y => Math.sqrt(Math.max(0, R * R - (y - TUN_CY) ** 2));      // y에서 원의 반폭
  const ySide = Math.min(bt, yAt(bw)), xTop = Math.min(bw, xAt(bt));
  const hole = [[-bw, -0.44], [bw, -0.44], [bw, ySide]];
  const t0 = Math.atan2(ySide - TUN_CY, bw), t1 = Math.atan2(bt - TUN_CY, xTop);
  for (let i = 1; i < 12; i++) { const t = t0 + (t1 - t0) * i / 12; hole.push([R * Math.cos(t), TUN_CY + R * Math.sin(t)]); }
  hole.push([xTop, bt], [-xTop, bt]);
  for (let i = 1; i < 12; i++) { const t = (Math.PI - t1) + (t1 - t0) * i / 12; hole.push([R * Math.cos(t), TUN_CY + R * Math.sin(t)]); }
  hole.push([-bw, ySide]);
  for (let s = Math.ceil(a); s < b; s++) {
    const z0 = zc(s - 0.5), z1 = zc(s + 0.5);
    if ((z0 === 3 && z1 === 4) || (z0 === 4 && z1 === 3) || (z0 === 4 && z1 === 5) || (z0 === 5 && z1 === 4)) {
      plate(s, rect(-7, 7, -1, 8), hole,
        withHeadlight(new THREE.MeshBasicMaterial({ map: T.concrete, color: new THREE.Color().setScalar(lightAt(s, 4, 3) * 0.8), side: DS2 })));
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
  const back = train.dir > 0 ? BEHIND : AHEAD, fwd = train.dir > 0 ? AHEAD : BEHIND;   // 진행방향으로 멀리
  const c0 = Math.max(0, Math.floor((s - back - START) / CH)), c1 = Math.min(Math.floor((END - START) / CH), Math.floor((s + fwd - START) / CH));
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
function buildOppTrain(type = 'old') {
  // 창은 발광맵으로 객실 조명이 켜진 것처럼 (터널에서도 밝게 보임). type: 'old' 기존차(창 3개) / 'new' 신조차(통유리창)
  const isNew = type === 'new';
  const side = new THREE.MeshLambertMaterial({ map: T.trainSide, emissive: 0xffffff, emissiveMap: T.trainSideLit, emissiveIntensity: 0.85, side: THREE.DoubleSide });
  const front = new THREE.MeshLambertMaterial({ map: isNew ? T.trainFrontNew : T.trainFront, emissive: 0xffffff,
    emissiveMap: isNew ? T.trainFrontNewLit : T.trainFrontLit, emissiveIntensity: 0.8, side: THREE.DoubleSide });
  const roof = new THREE.MeshLambertMaterial({ color: 0xd9dbdb }), dark = new THREE.MeshLambertMaterial({ color: 0x3a3c3e, side: THREE.DoubleSide });
  [side, front, roof, dark].forEach(withHeadlight);
  const G0 = buildCarGeometry();
  // 1호차: 운전실이 +Z(진행방향) / 2호차: 같은 차체를 180° 돌려 운전실이 뒤쪽(-Z)
  const makeCar = flip => {
    const c = new THREE.Group();
    [[G0.body, side], [G0.front, front], [G0.end, dark]].forEach(([geo, m]) => {
      const mesh = new THREE.Mesh(flip ? geo.clone().rotateY(Math.PI) : geo, m); c.add(mesh);
    });
    // 지붕 냉방기 2대
    for (const z of [-4.2, 4.2]) { const ac = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.32, 3.0), roof); ac.position.set(0, 1.78, z); c.add(ac); }
    return c;
  };
  const cars = [makeCar(false), makeCar(true)];
  // 하부 기기·대차 (차체와 레일 사이를 채워 떠 보이지 않게)
  const under = withHeadlight(new THREE.MeshLambertMaterial({ color: 0x24272b }));
  const underGeo = mergeGeometries([
    new THREE.BoxGeometry(2.3, 0.45, 15.5).translate(0, -1.75, 0),
    new THREE.BoxGeometry(2.0, 0.55, 2.6).translate(0, -2.0, 6.5),
    new THREE.BoxGeometry(2.0, 0.55, 2.6).translate(0, -2.0, -6.5)]);
  cars.forEach(c => c.add(new THREE.Mesh(underGeo, under)));
  const g = new THREE.Group(); cars.forEach(c => { c.matrixAutoUpdate = false; g.add(c); });
  const hp = new THREE.BufferGeometry(); hp.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const heads = new THREE.Points(hp, new THREE.PointsMaterial({ map: T.glow, size: 0.75, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  heads.frustumCulled = false; heads.renderOrder = 6; g.add(heads);
  g.visible = false; scene.add(g);
  return { g, cars, heads, mats: [side, front, roof, under], headX: isNew ? 0.61 : 0.53, s: 0, v: 0, a: 0, active: false, dwell: 0, cool: 8 };
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
/* 축은 유리창 밑단보다 drop만큼 아래(차체 안쪽, 운전실에서는 안 보임) → 팔이 밑단을 넘어 올라옴 (신조차 사진 기준) */
const WIPER = { ref: 376, refW: 600, drop: 95, aux: [21, -2], arm: 376, park: -0.793, sweep: -2.348, top: 200, bottom: 210, tiltPark: 0.12, tiltSweep: -0.12 };
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
/* 가로는 유리창 폭, 세로는 유리창 높이에 따로 맞춤 → 화면 비율과 무관하게 오른쪽 끝(쉬는 위치) ~ 왼쪽 끝까지 닦음 */
function wiperGeo(progress) {
  const k = (WIN.bot - WIN.top) / WIPER.ref, kx = (WIN.right - WIN.left) / WIPER.refW, p = clamp(progress, 0, 1);
  const base = { x: WIN.w / 2, y: WIN.bot + WIPER.drop * k }, aux = { x: base.x + WIPER.aux[0] * kx, y: base.y + WIPER.aux[1] * k };
  const ang = WIPER.park + (WIPER.sweep - WIPER.park) * p;
  const pj = { x: base.x + WIPER.arm * kx * Math.cos(ang), y: base.y + WIPER.arm * k * Math.sin(ang) };
  const qj = { x: pj.x + aux.x - base.x, y: pj.y + aux.y - base.y };
  const tilt = WIPER.tiltPark + (WIPER.tiltSweep - WIPER.tiltPark) * p, ub = { x: Math.sin(tilt), y: -Math.cos(tilt) };
  return { k, base, aux, pj, qj, ub,
    top: { x: pj.x + ub.x * WIPER.top * kx, y: pj.y + ub.y * WIPER.top * k },
    bottom: { x: pj.x - ub.x * WIPER.bottom * kx, y: pj.y - ub.y * WIPER.bottom * k } };
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
  const outdoor = !sheltered(train.s);
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
/* 비가 들이치지 않는 곳: 지하 구간 + 지붕 있는 고가역 승강장 */
const sheltered = s => { const c = zc(s); return isUnder(c) || c === 1; };
function drawGlassFx(dt) {
  if (!WIN) return;
  const target = sheltered(train.s) ? 0 : clamp(+glass.rainOn || 0, 0, 1);   // 비 강도 0~1 (지하·고가역 지붕 아래는 0)
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
  const D = train.dir, uT = D * TRK, s = train.s - 1.0 * D, k = train.v / 22;
  Wabs(s + 4 * D, uT, EYE, camTgt); Wabs(s - 9 * D, uT, EYE, _v);
  const dir = _d.copy(camTgt).sub(_v).normalize();
  Wabs(s, uT, EYE, camPos);
  const bob = (Math.sin(time * 7.1) * 0.5 + Math.sin(time * 12.7 + 1) * 0.3 + Math.sin(train.s * 0.9) * 0.4) * 0.006 * k;
  const sway = (Math.sin(train.s * 0.11) * 0.6 + Math.sin(train.s * 0.37 + 2) * 0.4) * 0.018 * k;
  at(s); camPos.x += Math.cos(F.h) * sway; camPos.z += Math.sin(F.h) * sway; camPos.y += bob;
  camera.position.copy(camPos);
  const roll = clamp(curv(s) * 32 * D, -0.06, 0.06) + Math.sin(train.s * 0.23) * 0.0025 * k;
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
  // 전조등 (낮에는 거의 티 나지 않고 터널에서 효과)
  const hp = HEAD[train.head];
  if (hp) {
    Wabs(train.s + 0.2 * D, uT, 1.0, HL.pos.value);
    Wabs(train.s + hp.aim * D, uT, 0, _v);
    HL.dir.value.copy(_v).sub(HL.pos.value).normalize();
    HL.k.value = hp.k * lerp(0.12, 1, inside); HL.range.value = hp.range; HL.cos.value = hp.cos;
  } else HL.k.value = 0;
}
const _b0 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
function updateOpp(o, dt) {
  const D = train.dir, od = -D, uO = od * TRK;         // od: 반대 열차 진행방향, uO: 반대 열차 선로
  if (!o.active) {
    o.cool -= dt; o.g.visible = false;
    const sp = train.s + 1000 * D;
    if (o.cool <= 0 && sp > START + 60 && sp < END - 60) {
      o.active = true; o.s = sp; o.v = 15; o.a = 0; o.dwell = 0;
      const st = STN.find(x => o.s > x.s - 60 && o.s < x.s + 60); if (st) o.s = st.s + 70 * D;
    }
    return;
  }
  // 반대 열차 다음 정차역 (od 방향) — s 감소 방향은 oppStop, 증가 방향은 stop
  let ns = null;
  if (od < 0) { for (const st of STN) if (st.oppStop < o.s - 0.5) ns = st; }
  else ns = STN.find(st => st.stop > o.s + 0.5) ?? null;
  const stopPt = ns ? (od < 0 ? ns.oppStop : ns.stop) : 0;
  if (o.dwell > 0) { o.dwell -= dt; o.v = 0; }
  else {
    const d = ns ? (stopPt - o.s) * od : 1e9;
    const vt = Math.min(19.4, limitAt(o.s) - 0.5, Math.sqrt(Math.max(0, 2 * 0.75 * (d - 0.2))));
    o.a += (clamp((vt - o.v) * 0.9, -1.0, 0.8) - o.a) * Math.min(1, dt / 0.6);
    o.v = Math.max(0, o.v + o.a * dt); o.s += od * o.v * dt;
    if (ns && d < 0.4 && o.v < 0.3) { o.dwell = 20; o.v = 0; o.a = 0; o.s = stopPt + od * 0.6; }
  }
  if ((o.s - train.s) * D + 40 < -150 || o.s < START + 60 || o.s > END - 60) {
    o.active = false; o.cool = rr(25, 60); o.g.visible = false;
    oppIdx ^= 1; opps[oppIdx].cool = o.cool; opp = opps[oppIdx];          // 다음은 다른 형식 (기존차 ↔ 신조차)
    return;
  }
  o.g.visible = true;
  // 차체는 앞뒤 대차 중심(±6.5m)을 잇는 방향 → 구배·곡선을 따라 기울어짐
  o.cars.forEach((c, i) => {
    const sc = o.s - od * (8.8 + i * 18.2);
    Wabs(sc + od * 6.5, uO, 0, _b0); Wabs(sc - od * 6.5, uO, 0, _b1);
    _bz.subVectors(_b0, _b1).normalize();                 // 로컬 +Z = 진행방향 = 전면
    _bx.crossVectors(_bU, _bz).normalize(); _by.crossVectors(_bz, _bx);
    _m.makeBasis(_bx, _by, _bz);
    _v.addVectors(_b0, _b1).multiplyScalar(0.5).addScaledVector(_by, 1.95);
    _m.setPosition(_v); c.matrix.copy(_m);
  });
  const lv = clamp(lightAt(o.s, uO, 2), 0.45, 1.6);   // 터널에서도 차체 형태가 보이게 최소 밝기 o.mats.forEach(m => m.color.setScalar(lv));
  const p = o.heads.geometry.attributes.position;
  Wabs(o.s + od * 0.42, uO - o.headX, 1.62, _v); p.setXYZ(0, _v.x, _v.y, _v.z);       // 전면 전조등 (코 끝)
  Wabs(o.s + od * 0.42, uO + o.headX, 1.62, _v); p.setXYZ(1, _v.x, _v.y, _v.z); p.needsUpdate = true;
}

/* =====================================================================
   11. 크기 / 해상도 자동 조절
   ===================================================================== */
let renderScale = 0.85, autoQ = true, cssW = 0, cssH = 0;
/* 크기·해상도가 실제로 바뀔 때만 다시 설정하고, 설정 직후 바로 다시 그림
   (캔버스 크기를 바꾸면 내용이 지워지므로 그대로 두면 빈 화면이 한 프레임 보여 깜빡임) */
let appliedGL = '', appliedCab = '', ready = false;
function resize() {
  cssW = STAGE.clientWidth || innerWidth; cssH = STAGE.clientHeight || innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const glW = Math.round(cssW * dpr * renderScale), glH = Math.round(cssH * dpr * renderScale);
  const cabKey = `${Math.round(cssW * dpr)}x${Math.round(cssH * dpr)}:${STAGE.dataset.winBottom}`;
  if (`${glW}x${glH}` === appliedGL && cabKey === appliedCab) return;
  appliedGL = `${glW}x${glH}`;
  renderer.setPixelRatio(1);
  renderer.setSize(glW, glH, false);
  if (cabKey !== appliedCab) {
    appliedCab = cabKey;
    WIN = drawCab(Math.round(cssW * dpr), Math.round(cssH * dpr));
    fxCanvas.width = WIN.w; fxCanvas.height = WIN.h;
  }
  const { horizon } = WIN;
  const aspect = cssW / cssH, k = 1.2, vfov = 2 * Math.atan(Math.tan(36 * Math.PI / 180) / aspect);
  camera.aspect = aspect;
  camera.fov = 2 * Math.atan(Math.tan(vfov / 2) * k) * 180 / Math.PI;
  camera.setViewOffset(cssW, cssH * k, 0, cssH * (k / 2 - horizon), cssW, cssH);
  camera.updateProjectionMatrix();
  if (ready) { renderer.render(scene, camera); drawGlassFx(0); }
}
let fpsAcc = 0, fpsN = 0, fps = 60, lastAdj = 0;
function adaptQuality(dt, now) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc < 1) return;
  fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
  if (!autoQ || now - lastAdj < 2500 || now - t0 < 5000) return;   // 시작 직후(선로 생성 중)에는 조절하지 않음
  if (fps < 42 && renderScale > 0.5) { renderScale = Math.max(0.5, renderScale - 0.1); lastAdj = now; resize(); }
  else if (fps > 57 && renderScale < 1) { renderScale = Math.min(1, renderScale + 0.05); lastAdj = now; resize(); }
}


/* =====================================================================
   12. 외부 연동 API + 렌더 루프
   ===================================================================== */
let opp, opps, oppIdx = 0, sky, far;
function jumpReset() {
  const c = zc(train.s); inside = isUnder(c) ? 1 : 0; exposure = isUnder(c) ? 1.4 : 1;
  opp.active = false; opp.cool = 6; glass.drops.length = 0;
  updateChunks(train.s, 99);
}
window.CabView3D = {
  /* s: 실제 위치(m), dir: +1 하선 / -1 상선, v: 속도(m/s), headlight: 'LOW'|'HIGH'|'OFF', rain: 비 강도 0~1 또는 bool, wiper: 'OFF'|'INT'|'SLOW'|'FAST'|'AUTO', doorsOpen: bool */
  update(st) {
    if (st.dir !== undefined && (st.dir < 0 ? -1 : 1) !== train.dir) {   // 운행 방향 전환 (하선/상선)
      train.dir = st.dir < 0 ? -1 : 1;
      setOppDest(train.dir);
      if (st.s !== undefined) train.s = clamp(st.s, START + 50, END - 40);
      jumpReset();
    }
    if (st.s !== undefined) {
      const jump = Math.abs(st.s - train.s) > 200;
      train.s = clamp(st.s, START + 50, END - 40);
      if (jump) jumpReset();
    }
    if (st.v !== undefined) train.v = Math.max(0, st.v);
    if (st.headlight !== undefined) train.head = st.headlight;
    if (st.rain !== undefined) glass.rainOn = typeof st.rain === 'number' ? clamp(st.rain, 0, 1) : (st.rain ? 1 : 0);
    if (st.wiper !== undefined && WIPER_MODES.includes(st.wiper)) glass.wiperMode = st.wiper;
  },
  setQuality(q) { autoQ = q === 'auto'; if (!autoQ) renderScale = +q; resize(); },
  resize() { resize(); },
  spawnOncoming(dist = 300, frozen = false, type) {
    if (type) { const i = type === 'new' ? 1 : 0; if (i !== oppIdx) { opp.active = false; opp.g.visible = false; oppIdx = i; opp = opps[i]; } }
    opp.active = true; opp.s = train.s + dist * train.dir; opp.v = frozen ? 0 : 15; opp.dwell = frozen ? 1e9 : 0; },
  get stats() { return { fps: Math.round(fps), scale: renderScale, chunks: chunks.size, zone: zc(train.s) }; },
  get renderInfo() { updateCamera(0.016); updateLod(); renderer.render(scene, camera); const r = renderer.info.render; return { calls: r.calls, tris: r.triangles, chunks: chunks.size, geos: renderer.info.memory.geometries }; },
  get glass() { return { rain: glass.rain, wiper: glass.wiperMode }; },
  get oppDest() { return OPP_DEST; },   // 마주 오는 열차 행선 (확인용)
};

const t0 = performance.now();
({ sky, far } = buildSkyFar());
opps = [buildOppTrain('old'), buildOppTrain('new')];
opp = opps[0];
updateChunks(train.s, 99);
resize();
new ResizeObserver(() => resize()).observe(STAGE);
console.log(`[cabview3d] init ${(performance.now() - t0).toFixed(0)} ms`);
ready = true;
window.dispatchEvent(new Event('cabview3d-ready'));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  if (STAGE.offsetParent !== null || STAGE === document.body) {
    adaptQuality(dt, now);                 // 해상도 변경은 그리기 전에
    updateChunks(train.s, 1); updateCamera(dt); updateOpp(opp, dt); updateLod();
    sky.position.copy(camera.position); far.position.set(camera.position.x, 0, camera.position.z);
    renderer.render(scene, camera);
    drawGlassFx(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
