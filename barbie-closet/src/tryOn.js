// =====================================================================
// tryOn.js  -  makes a flat clothing photo look worn on a live body
//
//  1. prepareGarment()  analyses a background-removed shirt photo once
//                       (finds the torso panel and the sleeves).
//  2. TopRenderer       every frame: smooths the pose, wraps the torso
//                       panel around a cylinder, bends each sleeve along
//                       the arm, adds shading + real-scene lighting, trims
//                       the result to your body outline and hides it behind
//                       forearms that cross your chest.
// =====================================================================

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const mix = (p, q, t) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
const add = (p, v, s = 1) => ({ x: p.x + v.x * s, y: p.y + v.y * s });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const unit = (v) => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};

// ---------------------------------------------------------------------
// 1. GARMENT ANALYSIS
// ---------------------------------------------------------------------
export function prepareGarment(image) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return null;

  // shrink once so per-frame drawing stays cheap
  const k = Math.min(1, 560 / Math.max(iw, ih));
  const w0 = Math.max(2, Math.round(iw * k));
  const h0 = Math.max(2, Math.round(ih * k));
  const c0 = document.createElement("canvas");
  c0.width = w0;
  c0.height = h0;
  const x0c = c0.getContext("2d", { willReadFrequently: true });
  x0c.drawImage(image, 0, 0, w0, h0);
  const d0 = x0c.getImageData(0, 0, w0, h0).data;

  // crop to the garment
  let minX = w0, minY = h0, maxX = 0, maxY = 0;
  for (let y = 0; y < h0; y++) {
    for (let x = 0; x < w0; x++) {
      if (d0[(y * w0 + x) * 4 + 3] > 25) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return null;

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const tex = document.createElement("canvas");
  tex.width = w;
  tex.height = h;
  const tc = tex.getContext("2d", { willReadFrequently: true });
  tc.drawImage(c0, minX, minY, w, h, 0, 0, w, h);
  const a = tc.getImageData(0, 0, w, h).data;
  const alphaAt = (x, y) => a[(y * w + x) * 4 + 3];

  // Where does the torso panel end and the sleeves begin?
  // At the hem the shirt is only as wide as the body.
  const lefts = [], rights = [];
  for (let y = Math.floor(h * 0.86); y <= Math.min(h - 1, Math.floor(h * 0.94)); y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) > 40) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) {
      lefts.push(l);
      rights.push(r + 1);
    }
  }
  const median = (arr) => arr.sort((p, q) => p - q)[arr.length >> 1];
  let bx0 = lefts.length ? median(lefts) : 0;
  let bx1 = rights.length ? median(rights) : w;

  // A flat-lay sleeve usually points diagonally. Measure its axis so it can
  // be laid along the real arm instead of being stretched square.
  const sleeveInfo = (side) => {
    const xa = side === "L" ? 0 : bx1;
    const xb = side === "L" ? bx0 : w;
    const px = [];
    let sx = 0, sy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = xa; x < xb; x++) {
        if (alphaAt(x, y) > 40) {
          px.push(x, y);
          sx += x;
          sy += y;
        }
      }
    }
    const n = px.length / 2;
    if (n < w * h * 0.004) return null;
    const C = { x: sx / n, y: sy / n };
    const col = side === "L" ? bx0 - 1 : bx1;
    let ya = h, yb = -1;
    for (let y = 0; y < h; y++) {
      if (alphaAt(col, y) > 40) {
        if (y < ya) ya = y;
        if (y > yb) yb = y;
      }
    }
    const A = { x: side === "L" ? bx0 : bx1, y: yb > ya ? (ya + yb) / 2 : C.y };
    const axis = unit(sub(C, A));
    const out = { x: side === "L" ? -1 : 1, y: 0 };
    let perp = { x: -axis.y, y: axis.x };
    if (-perp.y + 0.5 * (perp.x * out.x + perp.y * out.y) < 0) perp = { x: -perp.x, y: -perp.y };
    let smin = 0, smax = 0, t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < px.length; i += 2) {
      const dx = px[i] - A.x, dy = px[i + 1] - A.y;
      const s = dx * axis.x + dy * axis.y;
      const t = dx * perp.x + dy * perp.y;
      if (s < smin) smin = s;
      if (s > smax) smax = s;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    if (smax - smin < w * 0.05 || t1 - t0 < w * 0.03) return null;
    return { A, axis, perp, smin, smax, t0, t1 };
  };

  let sl = null, sr = null;
  if (bx0 > w * 0.07 && bx0 < w * 0.38) sl = sleeveInfo("L");
  if (w - bx1 > w * 0.07 && w - bx1 < w * 0.38) sr = sleeveInfo("R");
  if (!sl) bx0 = 0;
  if (!sr) bx1 = w;

  // average brightness (for matching the room's light)
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 16) {
    if (a[i + 3] > 40) {
      sum += (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) / 255;
      n++;
    }
  }

  // sleeves get their own texture with the torso cleared, so a tilted sleeve
  // rectangle never samples body pixels
  const sleeveTex = (clearX, clearW) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d");
    cx.drawImage(tex, 0, 0);
    cx.clearRect(clearX, 0, clearW, h);
    return c;
  };
  if (sl) sl.tex = sleeveTex(bx0, w - bx0);
  if (sr) sr.tex = sleeveTex(0, bx1);

  return { tex, w, h, bx0, bx1, sl, sr, lum: n ? sum / n : 0.5 };
}

// ---------------------------------------------------------------------
// TRIANGLE / GRID WARP  (affine texture mapping)
// ---------------------------------------------------------------------
function tri(ctx, img, s0, s1, s2, d0, d1, d2) {
  const den = s0.x * (s2.y - s1.y) + s1.x * (s0.y - s2.y) + s2.x * (s1.y - s0.y);
  if (Math.abs(den) < 1e-6) return;
  const a = (d0.x * (s2.y - s1.y) + d1.x * (s0.y - s2.y) + d2.x * (s1.y - s0.y)) / den;
  const b = (d0.y * (s2.y - s1.y) + d1.y * (s0.y - s2.y) + d2.y * (s1.y - s0.y)) / den;
  const c = (d0.x * (s1.x - s2.x) + d1.x * (s2.x - s0.x) + d2.x * (s0.x - s1.x)) / den;
  const d = (d0.y * (s1.x - s2.x) + d1.y * (s2.x - s0.x) + d2.y * (s0.x - s1.x)) / den;
  const e =
    (d0.x * (s2.x * s1.y - s1.x * s2.y) +
      d1.x * (s0.x * s2.y - s2.x * s0.y) +
      d2.x * (s1.x * s0.y - s0.x * s1.y)) / den;
  const f =
    (d0.y * (s2.x * s1.y - s1.x * s2.y) +
      d1.y * (s0.x * s2.y - s2.x * s0.y) +
      d2.y * (s1.x * s0.y - s0.x * s1.y)) / den;

  // grow the clip by under a pixel so neighbouring triangles leave no seams
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p) => {
    const vx = p.x - cx, vy = p.y - cy, l = Math.hypot(vx, vy) || 1;
    return [p.x + (vx / l) * 0.8, p.y + (vy / l) * 0.8];
  };
  ctx.save();
  ctx.beginPath();
  let q = grow(d0);
  ctx.moveTo(q[0], q[1]);
  q = grow(d1);
  ctx.lineTo(q[0], q[1]);
  q = grow(d2);
  ctx.lineTo(q[0], q[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawGrid(ctx, img, dest, src) {
  for (let r = 0; r < dest.length - 1; r++) {
    for (let c = 0; c < dest[0].length - 1; c++) {
      tri(ctx, img, src[r][c], src[r][c + 1], src[r + 1][c + 1], dest[r][c], dest[r][c + 1], dest[r + 1][c + 1]);
      tri(ctx, img, src[r][c], src[r + 1][c + 1], src[r + 1][c], dest[r][c], dest[r + 1][c + 1], dest[r + 1][c]);
    }
  }
}

// ---------------------------------------------------------------------
// 2. RENDERER
// ---------------------------------------------------------------------
const TRACKED = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export class TopRenderer {
  constructor() {
    this.work = document.createElement("canvas");   // garment is built here
    this.alpha = document.createElement("canvas");  // copy of garment alpha
    this.detail = document.createElement("canvas"); // fold/light layer
    this.mask = document.createElement("canvas");   // person silhouette
    this.maskCtx = this.mask.getContext("2d");
    this.maskImg = null;
    this.hasMask = false;
    this.tiny = document.createElement("canvas");
    this.tiny.width = this.tiny.height = 8;
    this.tctx = this.tiny.getContext("2d", { willReadFrequently: true });
    this.sm = [];
    this.yaw = 0;
    this.light = 0.5;
    this.frame = 0;
    this.canFilter = "filter" in this.work.getContext("2d");
  }

  reset() {
    this.sm = [];
    this.yaw = 0;
  }

  // smooth the pose so the shirt doesn't shake
  track(landmarks, W, H) {
    for (const i of TRACKED) {
      const p = landmarks[i];
      const t = { x: p.x * W, y: p.y * H, z: p.z || 0, v: p.visibility ?? 1 };
      const s = this.sm[i];
      if (!s) {
        this.sm[i] = t;
      } else {
        s.x += (t.x - s.x) * 0.55;
        s.y += (t.y - s.y) * 0.55;
        s.z += (t.z - s.z) * 0.3;
        s.v = t.v;
      }
    }
    return this.sm;
  }

  // segmentation mask from MediaPipe (1 = person)
  setMask(data, mw, mh) {
    const sw = mw >> 1, sh = mh >> 1;
    if (this.mask.width !== sw || this.mask.height !== sh) {
      this.mask.width = sw;
      this.mask.height = sh;
      this.maskImg = this.maskCtx.createImageData(sw, sh);
    }
    if (!this.maskImg) this.maskImg = this.maskCtx.createImageData(sw, sh);
    const o = this.maskImg.data;
    for (let y = 0; y < sh; y++) {
      const row = y * 2 * mw;
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        o[i] = o[i + 1] = o[i + 2] = 255;
        o[i + 3] = clamp((data[row + x * 2] - 0.3) / 0.4, 0, 1) * 255;
      }
    }
    this.maskCtx.putImageData(this.maskImg, 0, 0);
    this.hasMask = true;
  }

  drawTop(ctx, video, p, G, opts = {}) {
    if (!G) return;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const LS = p[11], RS = p[12], LH = p[23], RH = p[24];
    if (!LS || !RS || !LH || !RH) return;
    if (Math.min(LS.v, RS.v, LH.v, RH.v) < 0.5) return;

    const fit = opts.fit ?? 1;
    const lengthK = opts.length ?? 1;

    // ---- body frame ------------------------------------------------
    const sw = len(sub(RS, LS));
    const hipW = len(sub(RH, LH));
    const Ct = mix(LS, RS, 0.5);
    const Cb = mix(LH, RH, 0.5);
    const T = sub(Cb, Ct);
    const torso = len(T);
    if (sw < 20 || torso < 40) return;
    const down = unit(T);
    const ax = unit(sub(RS, LS)); // texture "left" -> "right"

    // body turning (from shoulder depth) shifts the pattern around the torso
    const rawYaw = clamp(Math.atan2(RS.z - LS.z, Math.abs(RS.x - LS.x) / W), -0.9, 0.9);
    this.yaw += (rawYaw * 0.6 - this.yaw) * 0.12;
    const yaw = clamp(this.yaw, -0.5, 0.5);

    // ---- torso panel -------------------------------------------------
    const hTop = sw * 0.5 * 1.3 * fit;
    const hChest = sw * 0.5 * 1.42 * fit;
    const hHip = Math.max(hipW * 0.5 * 1.5, sw * 0.5 * 1.1) * fit;
    const half = (v) => {
      const base = v < 0.25 ? lerp(hTop, hChest, ease(v / 0.25)) : lerp(hChest, hHip, ease((v - 0.25) / 0.75));
      return base * (1 - 0.05 * Math.sin(Math.PI * clamp((v - 0.3) / 0.6, 0, 1)));
    };
    const top0 = -0.13 * torso;
    const bot = torso * 1.08 * lengthK;
    const WR = 1.9; // how far round the body the front panel wraps (radians)
    const wrap = (u) => {
      const t0 = -WR / 2 + yaw, t1 = WR / 2 + yaw, th = (u - 0.5) * WR + yaw;
      return ((Math.sin(th) - Math.sin(t0)) / (Math.sin(t1) - Math.sin(t0))) * 2 - 1;
    };

    const ROWS = 8, COLS = 6;
    const bodyDest = [], bodySrc = [];
    const bw = G.bx1 - G.bx0;
    for (let r = 0; r <= ROWS; r++) {
      const v = r / ROWS;
      const c = add(Ct, down, top0 + (bot - top0) * v);
      const hv = half(v);
      const dRow = [], sRow = [];
      for (let q = 0; q <= COLS; q++) {
        const u = q / COLS;
        const wx = wrap(u);
        let pt = add(c, ax, wx * hv);
        pt = add(pt, down, torso * 0.025 * Math.pow(v, 3) * (1 - wx * wx)); // hem sags in front
        pt = add(pt, down, torso * 0.07 * wx * wx * clamp(1 - v / 0.22, 0, 1)); // shoulders slope away
        dRow.push(pt);
        sRow.push({ x: G.bx0 + bw * u, y: G.h * v });
      }
      bodyDest.push(dRow);
      bodySrc.push(sRow);
    }

    // ---- sleeves ---------------------------------------------------------
    const sc = (2 * hChest) / bw; // garment pixels -> screen pixels
    const sleeves = [];
  const makeSleeve = (side) => {
    const sp = side === "L" ? G.sl : G.sr;
if (!sp) return;
  const shoulder = side === "L" ? LS : RS;
  const elbow = side === "L" ? p[13] : p[14];

  if (!shoulder || !elbow) return;
  if (shoulder.v < 0.4 || elbow.v < 0.35) return;

  // Direction of upper arm
  const armDir = unit(sub(elbow, shoulder));

  // Perpendicular to arm
  let normal = {
    x: -armDir.y,
    y: armDir.x,
  };

  const outward = unit(sub(shoulder, Ct));

  // Make normal consistently face outward
  if (
    normal.x * outward.x +
      normal.y * outward.y <
    0
  ) {
    normal = {
      x: -normal.x,
      y: -normal.y,
    };
  }

  const upperArm = len(sub(elbow, shoulder));

  // Short sleeve length
  const sleeveLength = upperArm * 0.52;

  // Width of sleeve
  const topWidth = sw * 0.16;
  const bottomWidth = sw * 0.125;

  // Pull sleeve slightly INTO torso so there's no gap
  const start = add(
    shoulder,
    outward,
    -sw * 0.035
  );

  const end = add(
    start,
    armDir,
    sleeveLength
  );

  // Destination quad on person's arm
  const d0 = add(start, normal, topWidth);
  const d1 = add(start, normal, -topWidth);

  const d2 = add(end, normal, bottomWidth);
  const d3 = add(end, normal, -bottomWidth);

  // ---------------------------------
  // SOURCE FROM MAIN GARMENT IMAGE
  // ---------------------------------

  const garmentWidth = G.bx1 - G.bx0;
  const garmentHeight = G.h;

  // Take texture from the appropriate
  // upper shoulder/outer-shirt region.
  const sx0 =
    side === "L"
      ? G.bx0
      : G.bx0 + garmentWidth * 0.72;

  const sx1 =
    side === "L"
      ? G.bx0 + garmentWidth * 0.28
      : G.bx1;

  const sy0 = 0;
  const sy1 = garmentHeight * 0.34;

  const src = [
    [
      { x: sx0, y: sy0 },
      { x: sx0, y: sy1 },
    ],
    [
      { x: sx1, y: sy0 },
      { x: sx1, y: sy1 },
    ],
  ];

  const dest = [
    [d0, d2],
    [d1, d3],
  ];

  sleeves.push({
    tex: G.b,
    dest,
    src,
    RR: 1,
    SC: 1,
    over: false,
  });
};
  makeSleeve("L");
  makeSleeve("R");

    // ---- bounding box of everything we draw ------------------------------
    const all = [...bodyDest.flat(), ...sleeves.flatMap((s) => s.dest.flat())];
    let bx = Infinity, by = Infinity, ex = -Infinity, ey = -Infinity;
    for (const q of all) {
      bx = Math.min(bx, q.x); by = Math.min(by, q.y);
      ex = Math.max(ex, q.x); ey = Math.max(ey, q.y);
    }
    bx = Math.max(0, Math.floor(bx - 12)); by = Math.max(0, Math.floor(by - 12));
    ex = Math.min(W, Math.ceil(ex + 12)); ey = Math.min(H, Math.ceil(ey + 12));
    const bW = ex - bx, bH = ey - by;
    if (bW < 8 || bH < 8) return;

    // ---- build the garment on the work canvas -----------------------------
    const wk = this.work;
    if (wk.width !== W || wk.height !== H) {
      wk.width = W;
      wk.height = H;
    }
    const x = wk.getContext("2d");
    x.globalCompositeOperation = "source-over";
    x.globalAlpha = 1;
    x.filter = "none";
    x.clearRect(bx, by, bW, bH);
    x.save();
    x.beginPath();
    x.rect(bx, by, bW, bH);
    x.clip();

    // each sleeve is painted with its own underside shading
    const paintSleeve = (s) => {
      x.globalCompositeOperation = "source-over";
      drawGrid(x, G.img, s.dest, s.src);
      x.save();
      x.beginPath();
      s.dest[0].forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)));
      for (let k = s.SC; k >= 0; k--) x.lineTo(s.dest[s.RR][k].x, s.dest[s.RR][k].y);
      x.closePath();
      x.clip();
      x.globalCompositeOperation = "source-atop";
     
      const sg = x.createLinearGradient(gT.x, gT.y, gB.x, gB.y);
      sg.addColorStop(0, "rgba(255,255,255,0.08)");
      sg.addColorStop(0.55, "rgba(0,0,0,0.06)");
      sg.addColorStop(1, "rgba(0,0,0,0.34)");
      x.fillStyle = sg;
      x.fillRect(bx, by, bW, bH);
      x.restore();
    };
    // arms raised or out to the side: sleeve goes under the torso panel
    //  sleeves.filter((s) => !s.over).forEach(paintSleeve);

    drawGrid(x, G.tex, bodyDest, bodySrc);

    // cylinder + hem shading, only inside the torso outline
    x.save();
    x.beginPath();
    for (let r = 0; r <= ROWS; r++) {
      const q = bodyDest[r][0];
      r ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y);
    }
    for (let r = ROWS; r >= 0; r--) x.lineTo(bodyDest[r][COLS].x, bodyDest[r][COLS].y);
    x.closePath();
    x.clip();
    x.globalCompositeOperation = "source-atop";
    const a0 = add(Ct, ax, -hChest * 1.05), a1 = add(Ct, ax, hChest * 1.05);
    const gx = x.createLinearGradient(a0.x, a0.y, a1.x, a1.y);
    gx.addColorStop(0, "rgba(0,0,0,0.34)");
    gx.addColorStop(0.2, "rgba(0,0,0,0.10)");
    gx.addColorStop(0.5, "rgba(255,255,255,0.06)");
    gx.addColorStop(0.8, "rgba(0,0,0,0.10)");
    gx.addColorStop(1, "rgba(0,0,0,0.34)");
    x.fillStyle = gx;
    x.fillRect(bx, by, bW, bH);
    const h0 = add(Ct, down, torso * 0.75), h1 = add(Ct, down, bot);
    const gy = x.createLinearGradient(h0.x, h0.y, h1.x, h1.y);
    gy.addColorStop(0, "rgba(0,0,0,0)");
    gy.addColorStop(1, "rgba(0,0,0,0.16)");
    x.fillStyle = gy;
    x.fillRect(bx, by, bW, bH);
    x.restore();

    // armpit creases where sleeve meets body, and a soft collar shadow
    x.globalCompositeOperation = "source-atop";
    const shadowAt = (pt, rad, a) => {
      const rg = x.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, rad);
      rg.addColorStop(0, `rgba(0,0,0,${a})`);
      rg.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = rg;
      x.fillRect(pt.x - rad, pt.y - rad, rad * 2, rad * 2);
    };
    shadowAt(bodyDest[2][0], sw * 0.16, 0.3);
    shadowAt(bodyDest[2][COLS], sw * 0.16, 0.3);
    const neck = add(Ct, down, -0.10 * torso);
    shadowAt(neck, sw * 0.3, 0.25);
    sleeves.filter((s) => s.over).forEach(paintSleeve);

    // ---- real-scene folds + light -------------------------------------
    if (this.canFilter && opts.detail !== false) {
      const ac = this.alpha;
      if (ac.width !== bW || ac.height !== bH) {
        ac.width = bW;
        ac.height = bH;
      }
      const acx = ac.getContext("2d");
      acx.clearRect(0, 0, bW, bH);
      acx.drawImage(wk, bx, by, bW, bH, 0, 0, bW, bH);

      const dc = this.detail;
      const dw = Math.max(16, Math.round(bW / 3)), dh = Math.max(16, Math.round(bH / 3));
      if (dc.width !== dw || dc.height !== dh) {
        dc.width = dw;
        dc.height = dh;
      }
      const dx = dc.getContext("2d");
      // high-pass of the camera image = just the folds and light, not the colour of what you're wearing
      dx.globalAlpha = 1;
      dx.filter = "grayscale(1) blur(0.7px)";
      dx.drawImage(video, bx, by, bW, bH, 0, 0, dw, dh);
      dx.filter = "grayscale(1) blur(4px) invert(1)";
      dx.globalAlpha = 0.5;
      dx.drawImage(video, bx, by, bW, bH, 0, 0, dw, dh);
      dx.globalAlpha = 1;
      dx.filter = "none";

      x.globalCompositeOperation = "overlay";
      x.globalAlpha = opts.detailAmount ?? 0.42;
      x.filter = "contrast(2)";
      x.drawImage(dc, 0, 0, dw, dh, bx, by, bW, bH);
      x.filter = "none";
      x.globalAlpha = 1;
      x.globalCompositeOperation = "destination-in";
      x.drawImage(ac, 0, 0, bW, bH, bx, by, bW, bH);
    }

    // match the exposure of the room
    if (this.frame++ % 8 === 0) {
      this.tctx.drawImage(video, 0, 0, 8, 8);
      const d = this.tctx.getImageData(0, 0, 8, 8).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
      this.light += (s / 64 - this.light) * 0.3;
    }
    const exposure = clamp(0.62 + 0.75 * this.light, 0.7, 1.05);
    if (exposure < 1) {
      x.globalCompositeOperation = "source-atop";
      x.fillStyle = `rgba(0,0,0,${1 - exposure})`;
      x.fillRect(bx, by, bW, bH);
    }

    // neck hole + forearms that cross in front of the chest
    x.globalCompositeOperation = "destination-out";
    x.fillStyle = "#000";
    x.beginPath();
    x.ellipse(neck.x, neck.y, sw * 0.16, torso * 0.07, Math.atan2(ax.y, ax.x), 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#000";
    x.lineCap = "round";
    x.lineWidth = sw * 0.34;
    for (const [E, Wr] of [[p[13], p[15]], [p[14], p[16]]]) {
      if (!E || !Wr || E.v < 0.5 || Wr.v < 0.5) continue;
      const mx = (E.x + Wr.x) / 2, my = (E.y + Wr.y) / 2;
      if (Math.abs(mx - Ct.x) > hChest * 0.95 || my < Ct.y || my > Cb.y + torso * 0.1) continue;
      const tip = add(Wr, unit(sub(Wr, E)), len(sub(Wr, E)) * 0.3); // include the hand
      x.beginPath();
      x.moveTo(E.x, E.y);
      x.lineTo(tip.x, tip.y);
      x.stroke();
    }

    // trim to your real body outline
    if (opts.clip !== false && this.hasMask) {
      const kx = this.mask.width / W, ky = this.mask.height / H;
      x.globalCompositeOperation = "destination-in";
      if (this.canFilter) x.filter = "blur(1.2px)";
      x.drawImage(this.mask, bx * kx, by * ky, bW * kx, bH * ky, bx, by, bW, bH);
      x.filter = "none";
    }
    x.restore();
    x.globalCompositeOperation = "source-over";

    ctx.drawImage(wk, bx, by, bW, bH, bx, by, bW, bH);
  }
}