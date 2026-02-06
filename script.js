"use strict";

/**
 * Adds "speed-based" size + brightness for BACKGROUND particles:
 * - packed layout becomes [x, y, size, type+hover, speed01]
 * - bg particles compute speed01 from frame-to-frame velocity (smoothed)
 * - shader boosts bg alpha by speed01 (subtle)
 */
(() => {
  // =========================
  // Tunables
  // =========================
  const GRID_W = 200;
  const GRID_H = 70;
  const N_PARTICLES = GRID_W * GRID_H;

  const BG_REPEL_STRENGTH = 95;
  const BG_SPRING = 0.02;

  const TXT_REPEL_STRENGTH = 10;
  const TXT_SPRING = 0.14;
  const TXT_MAX_DISPLACEMENT = 6;

  const ANCHOR_LERP = 0.10;
  const VIS_LERP = 0.10;

  const TEXT_SAMPLE_STEP = 1; // DPR-aware in raster
  const TEXT_ALPHA_THRESHOLD = 34;

  const MENU_PARTICLE_MAX = 4600;
  const HEADING_PARTICLE_MAX = 4600;
  const BODY_PARTICLE_MAX = 8200;
  const BACK_PARTICLE_MAX = 1100;

  const DOM_TRACK_MS = 700;
  const BG_OVERSCAN = 1.08;

  const BACK_TOP_FRACTION = 0.86;
  const BACK_TOP_MIN_PX = 120;
  const BACK_TOP_MAX_PX_FROM_BOTTOM = 40;

  // Text clarity controls
  const TEXT_ALPHA = 0.62;
  const BG_ALPHA = 0.78;
  const TEXT_POINT_BASE = 4.05;
  const TEXT_POINT_HOVER = 1.70;

  // =========================
  // Mouse interaction
  // =========================
  const INTERACT_RADIUS_BG = 25;
  const INTERACT_RADIUS_TEXT = 60;

  const MAX_PUSH_BG = 2.2;
  const MAX_PUSH_TEXT = 1.6;

  const HOVER_LERP = 0.12;

  // =========================
  // NEW: speed → size/brightness mapping (bg only)
  // =========================
  const BG_SPEED_REF_PX_PER_FRAME = 0.01; // speed that maps to ~1.0 (tweak)
  const BG_SPEED_SMOOTH = 0.18;          // 0..1; higher = snappier
  const BG_SPEED_SIZE_BOOST = 3;      // size multiplier at speed01=1
  const BG_SPEED_ALPHA_BOOST = 0.5;     // alpha multiplier amount at speed01=1

  // =========================
  // DOM / content
  // =========================
  const ui = document.querySelector(".ui");
  const menu = document.getElementById("menu");
  const headerTitle = document.getElementById("headerTitle");
  const backBtn = document.getElementById("backBtn");

  if (!ui || !menu || !headerTitle || !backBtn) {
    throw new Error("Missing required UI elements (.ui, #menu, #headerTitle, #backBtn).");
  }

  const menuButtons = Array.from(menu.querySelectorAll(".menuItem"));

  const sections = {
    about: {
      title: "about me",
      body: [
        "Hi - I’m Oliver.",
        "I am currently an A Level student studying CS, Physics and Maths",
        "This is just an example website I wanted to make",
        "",
        "Hopefully it looks good on your browser.",
      ].join("\n"),
    },
    projects: {
      title: "projects",
      body: [
        "• Project One - short description",
        "• Project Two - short description",
        "• Project Three - short description",
        "",
        "Yeah, I don't know which projects to put in",
      ].join("\n"),
    },
    links: {
      title: "links",
      body: [
        "GitHub: https://github.com/openaw",
        "LinkedIn: https://www.linkedin.com/in/oliver-green-5431a7329/",
        "Email: seito.green@gmail.com",
        "Not clickable yet",
      ].join("\n"),
    },
  };

  let state = "menu";
  let activeKey = "about";

  function syncMenuInteractivity() {
    const inSection = state === "section";
    menu.style.pointerEvents = inSection ? "none" : "auto";

    for (let i = 0; i < menuButtons.length; i++) {
      const b = menuButtons[i];
      b.disabled = inSection;
      b.style.cursor = inSection ? "default" : "pointer";
    }

    backBtn.style.pointerEvents = "auto";
    backBtn.style.cursor = inSection ? "pointer" : "default";
  }

  // =========================
  // WebGL canvas
  // =========================
  const canvas = {
    elem: null,
    gl: null,
    program: null,
    width: 0,
    height: 0,
    uResolution: null,
    uBgAlpha: null,
    uTextAlpha: null,
    uBgSpeedAlphaBoost: null,

    init(options) {
      this.elem = document.querySelector("canvas");
      if (!this.elem) throw new Error("No <canvas> found on the page.");

      const gl =
        (this.gl =
          this.elem.getContext("webgl", options) ||
          this.elem.getContext("experimental-webgl", options));
      if (!gl) throw new Error("WebGL not supported.");

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(
        vs,
        `
        precision highp float;

        // NOTE: aPosition is still vec4, but now the buffer is interleaved with an extra float (aSpeed)
        attribute vec4 aPosition; // x,y,size,type+hover
        attribute float aSpeed;   // speed01 (bg only)

        uniform vec2 uResolution;

        varying float vTypeHover;
        varying float vSpeed;

        void main() {
          vTypeHover = aPosition.w;
          vSpeed = aSpeed;

          gl_PointSize = max(1.0, min(18.0, aPosition.z));
          gl_Position = vec4(
            ( aPosition.x / uResolution.x * 2.0) - 1.0,
            (-aPosition.y / uResolution.y * 2.0) + 1.0,
            0.0,
            1.0
          );
        }
      `
      );
      gl.compileShader(vs);

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(
        fs,
        `
        precision highp float;

        uniform float uBgAlpha;
        uniform float uTextAlpha;
        uniform float uBgSpeedAlphaBoost; // NEW

        varying float vTypeHover;
        varying float vSpeed;

        void main() {
          vec2 p = gl_PointCoord - vec2(0.5);
          float r = length(p);
          if (r > 0.5) discard;

          float core = smoothstep(0.5, 0.44, r);

          float rim = smoothstep(0.48, 0.40, r) - smoothstep(0.40, 0.32, r);
          rim = clamp(rim, 0.0, 1.0);

          float isText = step(0.5, vTypeHover);

          // decode hover from w:
          float hover = (isText > 0.5) ? (vTypeHover - 0.5) / 0.49 : vTypeHover / 0.49;
          hover = clamp(hover, 0.0, 1.0);

          float baseAlpha = mix(uBgAlpha, uTextAlpha, isText);

          // brighten on hover
          float boosted = baseAlpha * (1.0 + hover * 0.75);

          // NEW: speed-based alpha boost for BG only (subtle)
          float speedBoost = mix(1.0 + clamp(vSpeed, 0.0, 1.0) * uBgSpeedAlphaBoost, 1.0, isText);
          boosted *= speedBoost;

          float a = boosted * (0.90 * core + 0.22 * rim);
          gl_FragColor = vec4(1.0, 0.85, 0.25, a);
        }
      `
      );
      gl.compileShader(fs);

      const program = (this.program = gl.createProgram());
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.useProgram(program);

      this.uResolution = gl.getUniformLocation(program, "uResolution");
      this.uBgAlpha = gl.getUniformLocation(program, "uBgAlpha");
      this.uTextAlpha = gl.getUniformLocation(program, "uTextAlpha");
      this.uBgSpeedAlphaBoost = gl.getUniformLocation(program, "uBgSpeedAlphaBoost");

      return gl;
    },

    resize() {
      this.width = this.elem.width = this.elem.offsetWidth;
      this.height = this.elem.height = this.elem.offsetHeight;

      const gl = this.gl;
      gl.uniform2f(this.uResolution, this.width, this.height);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    },
  };

  // =========================
  // Pointer
  // =========================
  const pointer = {
    x: 0,
    y: 0,
    init() {
      this.x = canvas.width * 0.5;
      this.y = canvas.height * 0.5;

      const onMove = (e) => {
        const t = e.touches && e.touches.length ? e.touches[0] : null;
        this.x = t ? t.clientX : e.clientX;
        this.y = t ? t.clientY : e.clientY;
      };

      window.addEventListener("mousemove", onMove, { passive: true });
      window.addEventListener("touchstart", onMove, { passive: true });
      window.addEventListener("touchmove", onMove, { passive: true });
    },
  };

  // =========================
  // Particle system
  // =========================
  // NEW: 5 floats per particle: x,y,size,type+hover,speed01
  const STRIDE = 5;
  const packed = new Float32Array(N_PARTICLES * STRIDE);
  const particles = new Array(N_PARTICLES);

  function influence(dist, radius) {
    const t = 1 - Math.max(0, Math.min(1, dist / radius));
    return t * t * (3 - 2 * t);
  }

  class Particle {
    constructor(i, gx, gy, packedArray) {
      this.gx = gx;
      this.gy = gy;

      const base = i * STRIDE;
      this.p = packedArray.subarray(base, base + STRIDE);

      this.x = 0;
      this.y = 0;
      this.x0 = 0;
      this.y0 = 0;

      this.ax = 0;
      this.ay = 0;

      this.mode = "bg";
      this.v = 1;
      this.vt = 1;

      this.phase = Math.random() * Math.PI * 2;
      this.speed = 0.55 + Math.random() * 0.65;
      this.ampX = 0.25 + Math.random() * 0.45;
      this.ampY = 0.25 + Math.random() * 0.45;

      // hover
      this.hover = 0;
      this.hoverT = 0;

      // NEW: velocity tracking (for bg speed glow)
      this.prevX = 0;
      this.prevY = 0;
      this.spd01 = 0;

      this.setBGTarget(true);
    }

    bgAnchorForGrid(out) {
      const nx = (this.gx + 0.5) / GRID_W;
      const ny = (this.gy + 0.5) / GRID_H;

      out.x = (nx - 0.5) * canvas.width * BG_OVERSCAN + canvas.width * 0.5;
      out.y = (ny - 0.5) * canvas.height * BG_OVERSCAN + canvas.height * 0.5;
      return out;
    }

    setBGTarget(immediate = false) {
      this.mode = "bg";
      this.vt = 1;

      const a = this.bgAnchorForGrid(tmpXY);
      this.ax = a.x;
      this.ay = a.y;

      this.p[3] = 0.0 + this.hover * 0.49; // type+hover
      this.p[4] = this.spd01;              // speed01
      if (immediate) this.snapToAnchor();
    }

    setTextTarget(x, y, visible = true, immediate = false) {
      this.mode = "text";
      this.vt = visible ? 1 : 0;

      this.ax = x;
      this.ay = y;

      this.p[3] = 0.5 + this.hover * 0.49;
      this.p[4] = 0.0; // speed not used for text
      if (immediate) this.snapToAnchor();
    }

    setFadeOutToBG() {
      this.vt = 0;
      this.mode = "text";

      const a = this.bgAnchorForGrid(tmpXY);
      this.ax = a.x;
      this.ay = a.y;

      this.p[3] = 0.5 + this.hover * 0.49;
      this.p[4] = 0.0;
    }

    snapToAnchor() {
      this.x0 = this.ax;
      this.y0 = this.ay;
      this.x = this.x0;
      this.y = this.y0;

      // reset velocity baseline
      this.prevX = this.x;
      this.prevY = this.y;

      this.p[0] = this.x;
      this.p[1] = this.y;
    }

    step(now) {
      this.x0 += (this.ax - this.x0) * ANCHOR_LERP;
      this.y0 += (this.ay - this.y0) * ANCHOR_LERP;

      this.v += (this.vt - this.v) * VIS_LERP;

      const t = now * 0.001;

      const wobbleScale = this.mode === "text" ? 0.10 : 1.0;
      const wobbleX = Math.cos(t * this.speed + this.phase) * this.ampX * wobbleScale;
      const wobbleY = Math.sin(t * this.speed + this.phase) * this.ampY * wobbleScale;

      const tx0 = this.x0 + wobbleX;
      const ty0 = this.y0 + wobbleY;

      const dx = pointer.x - this.x;
      const dy = pointer.y - this.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-4;

      if (this.mode === "text") {
        const inf = influence(d, INTERACT_RADIUS_TEXT);
        this.hoverT = inf;

        const inv = 1.0 / d;
        let push = TXT_REPEL_STRENGTH * inf;
        if (push > MAX_PUSH_TEXT) push = MAX_PUSH_TEXT;

        const px = -push * dx * inv;
        const py = -push * dy * inv;

        this.x += px + (tx0 - this.x) * TXT_SPRING;
        this.y += py + (ty0 - this.y) * TXT_SPRING;

        const ox = this.x - tx0;
        const oy = this.y - ty0;
        const od = Math.sqrt(ox * ox + oy * oy) + 1e-4;
        if (od > TXT_MAX_DISPLACEMENT) {
          const m = TXT_MAX_DISPLACEMENT / od;
          this.x = tx0 + ox * m;
          this.y = ty0 + oy * m;
        }

        const size = TEXT_POINT_BASE + TEXT_POINT_HOVER * inf;
        this.p[2] = size * Math.max(0.0, this.v);

        // speed not used for text
        this.p[4] = 0.0;
      } else {
        const inf = influence(d, INTERACT_RADIUS_BG);
        this.hoverT = inf;

        const inv = 1.0 / d;
        let push = BG_REPEL_STRENGTH * inf;
        if (push > MAX_PUSH_BG) push = MAX_PUSH_BG;

        const px = -push * dx * inv;
        const py = -push * dy * inv;

        this.x += px + (tx0 - this.x) * BG_SPRING;
        this.y += py + (ty0 - this.y) * BG_SPRING;

        // --- NEW: compute bg speed01 from velocity (smoothed) ---
        const vx = this.x - this.prevX;
        const vy = this.y - this.prevY;
        this.prevX = this.x;
        this.prevY = this.y;

        const spd = Math.sqrt(vx * vx + vy * vy); // px / frame
        const target01 = Math.max(0, Math.min(1, spd / BG_SPEED_REF_PX_PER_FRAME));
        this.spd01 += (target01 - this.spd01) * BG_SPEED_SMOOTH;

        // Base size (as before) ...
        const baseSize = (0.70 + 0.85 * inf) * Math.max(0.25, this.v);

        // ... and NEW speed-based size boost (subtle)
        const boostedSize = baseSize * (1.0 + this.spd01 * BG_SPEED_SIZE_BOOST);
        this.p[2] = boostedSize;

        // Send speed01 to shader so alpha can brighten
        this.p[4] = this.spd01;
      }

      // smooth hover + encode into w
      this.hover += (this.hoverT - this.hover) * HOVER_LERP;
      if (this.hover < 0) this.hover = 0;
      else if (this.hover > 1) this.hover = 1;

      this.p[3] = (this.mode === "text" ? 0.5 : 0.0) + this.hover * 0.49;

      this.p[0] = this.x;
      this.p[1] = this.y;

      if (this.mode === "text" && this.v < 0.02) {
        const a = this.bgAnchorForGrid(tmpXY);
        const ddx = this.x0 - a.x;
        const ddy = this.y0 - a.y;
        if (ddx * ddx + ddy * ddy < 25) {
          this.setBGTarget(false);
          this.v = 1;
          this.vt = 1;
        }
      }
    }
  }

  const tmpXY = { x: 0, y: 0 };

  // =========================
  // Init WebGL
  // =========================
  const gl = canvas.init({
    alpha: true,
    stencil: false,
    antialias: true,
    depth: false,
  });

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.uniform1f(canvas.uBgAlpha, BG_ALPHA);
  gl.uniform1f(canvas.uTextAlpha, TEXT_ALPHA);
  gl.uniform1f(canvas.uBgSpeedAlphaBoost, BG_SPEED_ALPHA_BOOST); // NEW

  // attributes
  const aPosition = gl.getAttribLocation(canvas.program, "aPosition");
  const aSpeed = gl.getAttribLocation(canvas.program, "aSpeed"); // NEW
  gl.enableVertexAttribArray(aPosition);
  gl.enableVertexAttribArray(aSpeed);

  const positionBuffer = gl.createBuffer();

  // Create particles
  {
    let i = 0;
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        particles[i] = new Particle(i, gx, gy, packed);
        i++;
      }
    }
  }

  // =========================
  // Shuffled indices (stable mapping)
  // =========================
  const shuffled = new Uint32Array(N_PARTICLES);
  for (let i = 0; i < N_PARTICLES; i++) shuffled[i] = i;
  for (let i = N_PARTICLES - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  // =========================
  // Targets (flat arrays: [x,y,x,y,...])
  // =========================
  const menuTargets = [];
  const headingTargets = [];
  const bodyTargets = [];
  const backTargets = [];

  let headingCount = 0;
  let bodyCount = 0;
  let backCount = 0;

  function downsampleFlatXYInPlace(arr, maxPoints) {
    const points = (arr.length / 2) | 0;
    if (points <= maxPoints) return;

    const stride = Math.ceil(points / maxPoints);
    let w = 0;
    for (let i = 0; i < points; i += stride) {
      const j = i * 2;
      arr[w++] = arr[j];
      arr[w++] = arr[j + 1];
    }
    arr.length = w;
  }

  function assignTextTargetsFlat(targetsFlat, visible, immediate, offset) {
    const points = (targetsFlat.length / 2) | 0;
    for (let t = 0; t < points; t++) {
      const pi = shuffled[offset + t];
      const p = particles[pi];
      const idx = t * 2;
      p.setTextTarget(targetsFlat[idx], targetsFlat[idx + 1], visible, immediate);
    }
    return points;
  }

  function setRestToBG(excludeCount, immediate) {
    for (let i = excludeCount; i < N_PARTICLES; i++) {
      particles[shuffled[i]].setBGTarget(immediate);
    }
  }

  function fadeOutRangeInShuffle(start, count) {
    for (let i = 0; i < count; i++) {
      particles[shuffled[start + i]].setFadeOutToBG();
    }
  }

  // =========================
  // Reused offscreen canvas for rasterization
  // =========================
  const raster = {
    c: document.createElement("canvas"),
    ctx: null,
    dpr: 1,
    w: 0,
    h: 0,
    ensure() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(canvas.width * dpr));
      const h = Math.max(1, Math.floor(canvas.height * dpr));

      if (!this.ctx) this.ctx = this.c.getContext("2d", { willReadFrequently: true });

      if (this.w !== w || this.h !== h || this.dpr !== dpr) {
        this.dpr = dpr;
        this.w = this.c.width = w;
        this.h = this.c.height = h;
      }

      return this;
    },
  };

  function getFontFromElement(el) {
    const cs = getComputedStyle(el);
    return {
      fontSize: parseFloat(cs.fontSize) || 40,
      fontFamily: cs.fontFamily || "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      fontWeight: cs.fontWeight || "600",
    };
  }

  function centerOfRect(rect) {
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
  }

  function rasterTextAt(lines, xCss, yCss, opts, outFlatTargets) {
    const { fontSize, fontFamily, fontWeight, lineHeight, align = "center", baseline = "middle", maxWidth = null } =
      opts;

    raster.ensure();
    const { ctx, dpr, w, h } = raster;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

    let cy = yCss;

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];

      if (raw === "") {
        cy += lineHeight;
        continue;
      }

      if (!maxWidth) {
        ctx.fillText(raw, xCss, cy);
        cy += lineHeight;
        continue;
      }

      const words = raw.split(" ");
      let line = "";
      for (let n = 0; n < words.length; n++) {
        const test = line ? line + " " + words[n] : words[n];
        if (ctx.measureText(test).width > maxWidth && line) {
          ctx.fillText(line, xCss, cy);
          line = words[n];
          cy += lineHeight;
        } else {
          line = test;
        }
      }
      if (line) {
        ctx.fillText(line, xCss, cy);
        cy += lineHeight;
      }
    }

    const img = ctx.getImageData(0, 0, w, h).data;

    outFlatTargets.length = 0;

    const step = Math.max(1, Math.round(TEXT_SAMPLE_STEP * dpr));
    for (let py = 0; py < h; py += step) {
      const row = py * w * 4;
      for (let px = 0; px < w; px += step) {
        const a = img[row + px * 4 + 3];
        if (a > TEXT_ALPHA_THRESHOLD) {
          outFlatTargets.push(px / dpr, py / dpr);
        }
      }
    }
  }

  // =========================
  // Fixed back button position
  // =========================
  function setBackButtonFixedPosition() {
    const top = Math.max(
      BACK_TOP_MIN_PX,
      Math.min(canvas.height - BACK_TOP_MAX_PX_FROM_BOTTOM, canvas.height * BACK_TOP_FRACTION)
    );
    backBtn.style.top = `${Math.floor(top)}px`;
  }

  // =========================
  // Build targets matching DOM
  // =========================
  function buildMenuTargetsFromDOM() {
    menuTargets.length = 0;

    for (let i = 0; i < menuButtons.length; i++) {
      const btn = menuButtons[i];
      const rect = btn.getBoundingClientRect();
      const c = centerOfRect(rect);
      const f = getFontFromElement(btn);

      rasterTextAt(
        [btn.textContent.trim()],
        c.x,
        c.y,
        {
          fontSize: f.fontSize,
          fontFamily: f.fontFamily,
          fontWeight: "650",
          lineHeight: Math.floor(f.fontSize * 1.16),
          align: "center",
          baseline: "middle",
        },
        tmpFlatTargets
      );

      for (let j = 0; j < tmpFlatTargets.length; j++) menuTargets.push(tmpFlatTargets[j]);
    }

    downsampleFlatXYInPlace(menuTargets, MENU_PARTICLE_MAX);
  }

  function buildSectionTargetsFromDOM(sectionKey) {
    headingTargets.length = 0;
    bodyTargets.length = 0;
    backTargets.length = 0;

    headerTitle.textContent = sections[sectionKey].title;

    // Heading
    {
      const rect = headerTitle.getBoundingClientRect();
      const c = centerOfRect(rect);
      const f = getFontFromElement(headerTitle);

      rasterTextAt(
        [sections[sectionKey].title],
        c.x,
        c.y,
        {
          fontSize: f.fontSize,
          fontFamily: f.fontFamily,
          fontWeight: "620",
          lineHeight: Math.floor(f.fontSize * 1.1),
          align: "center",
          baseline: "middle",
        },
        headingTargets
      );

      downsampleFlatXYInPlace(headingTargets, HEADING_PARTICLE_MAX);
      headingCount = (headingTargets.length / 2) | 0;
    }

    // Body
    {
      const titleRect = headerTitle.getBoundingClientRect();
      const bodySize = Math.max(18, Math.min(30, Math.floor(canvas.width * 0.024)));
      const lineHeight = Math.floor(bodySize * 1.65);
      const maxWidth = Math.min(canvas.width * 0.82, 980);
      const bodyTop = titleRect.bottom + 16;

      const bodyLines = sections[sectionKey].body.split("\n");

      rasterTextAt(
        bodyLines,
        canvas.width * 0.5,
        bodyTop,
        {
          fontSize: bodySize,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
          fontWeight: "420",
          lineHeight,
          align: "center",
          baseline: "top",
          maxWidth,
        },
        bodyTargets
      );

      downsampleFlatXYInPlace(bodyTargets, BODY_PARTICLE_MAX);
      bodyCount = (bodyTargets.length / 2) | 0;
    }

    // Back
    {
      setBackButtonFixedPosition();

      const rect = backBtn.getBoundingClientRect();
      const c = centerOfRect(rect);
      const f = getFontFromElement(backBtn);
      const text = backBtn.textContent.trim() || "Back";

      rasterTextAt(
        [text],
        c.x,
        c.y,
        {
          fontSize: Math.max(16, f.fontSize || 18),
          fontFamily: f.fontFamily,
          fontWeight: "520",
          lineHeight: Math.floor((f.fontSize || 18) * 1.15),
          align: "center",
          baseline: "middle",
        },
        backTargets
      );

      downsampleFlatXYInPlace(backTargets, BACK_PARTICLE_MAX);
      backCount = (backTargets.length / 2) | 0;
    }
  }

  const tmpFlatTargets = [];

  // =========================
  // Apply layouts
  // =========================
  function applyMenuLayout(immediate = false) {
    buildMenuTargetsFromDOM();
    const used = assignTextTargetsFlat(menuTargets, true, immediate, 0);
    setRestToBG(used, immediate);
  }

  function applySectionLayout(sectionKey, immediate = false) {
    buildSectionTargetsFromDOM(sectionKey);

    let offset = 0;
    offset += assignTextTargetsFlat(headingTargets, true, immediate, offset);
    offset += assignTextTargetsFlat(bodyTargets, true, immediate, offset);
    offset += assignTextTargetsFlat(backTargets, true, immediate, offset);

    setRestToBG(offset, immediate);
  }

  function fadeSectionTextBackToBG() {
    fadeOutRangeInShuffle(headingCount, bodyCount + backCount);
  }

  // =========================
  // DOM tracking during transitions
  // =========================
  let domTrackUntil = 0;
  function trackDOMFor(ms) {
    domTrackUntil = performance.now() + ms;
  }

  function stepDOMTracking() {
    if (performance.now() > domTrackUntil) return;

    if (state === "section") setBackButtonFixedPosition();
    if (state === "section") applySectionLayout(activeKey, false);
    else applyMenuLayout(false);
  }

  // =========================
  // UI transitions
  // =========================
  function openSection(key) {
    activeKey = key;
    state = "section";
    syncMenuInteractivity();

    ui.classList.add("section-open");
    setBackButtonFixedPosition();

    applySectionLayout(key, false);
    trackDOMFor(DOM_TRACK_MS);
  }

  function closeSection() {
    state = "menu";
    syncMenuInteractivity();

    ui.classList.remove("section-open");
    fadeSectionTextBackToBG();
    trackDOMFor(DOM_TRACK_MS);

    setTimeout(() => {
      if (state === "menu") applyMenuLayout(false);
    }, 260);
  }

  menu.addEventListener("click", (e) => {
    if (state === "section") return;
    const btn = e.target.closest(".menuItem");
    if (!btn) return;
    openSection(btn.dataset.section);
  });

  backBtn.addEventListener("click", () => {
    if (state !== "section") return;
    closeSection();
  });

  // =========================
  // Resize
  // =========================
  function handleResize() {
    canvas.resize();

    gl.uniform1f(canvas.uBgAlpha, BG_ALPHA);
    gl.uniform1f(canvas.uTextAlpha, TEXT_ALPHA);
    gl.uniform1f(canvas.uBgSpeedAlphaBoost, BG_SPEED_ALPHA_BOOST);

    if (state === "section") setBackButtonFixedPosition();
    if (state === "section") applySectionLayout(activeKey, true);
    else applyMenuLayout(true);
  }
  window.addEventListener("resize", handleResize, false);

  // =========================
  // Start
  // =========================
  canvas.resize();
  pointer.init();
  syncMenuInteractivity();

  gl.uniform1f(canvas.uBgAlpha, BG_ALPHA);
  gl.uniform1f(canvas.uTextAlpha, TEXT_ALPHA);
  gl.uniform1f(canvas.uBgSpeedAlphaBoost, BG_SPEED_ALPHA_BOOST);

  applyMenuLayout(true);

  // =========================
  // Render loop
  // =========================
  function draw() {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

    // Interleaved buffer: [x,y,size,w,speed] = 5 floats
    const strideBytes = STRIDE * 4;

    // aPosition: vec4 at offset 0
    gl.vertexAttribPointer(aPosition, 4, gl.FLOAT, false, strideBytes, 0);

    // aSpeed: float at offset 16 bytes (4 floats * 4 bytes)
    gl.vertexAttribPointer(aSpeed, 1, gl.FLOAT, false, strideBytes, 16);

    gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, N_PARTICLES);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    stepDOMTracking();
    for (let i = 0; i < N_PARTICLES; i++) particles[i].step(now);
    draw();
  }

  requestAnimationFrame(loop);
})();
