"use strict";

/*
 * Dino Runner — endless-runner core (original code and pixel art).
 * Runs solo, or as the local simulation of a multiplayer race:
 * every client gets the same RNG seed => identical obstacle course.
 * Each client simulates only its own dino; remote players render
 * as colored "ghost" dinos driven by network state packets.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  width: 800,
  height: 300,
  groundY: 260,
  scale: 2,

  startSpeed: 6,
  maxSpeed: 13,
  acceleration: 0.0012,

  gravity: 0.6,
  jumpVelocity: -11,
  dropBoost: 0.9,

  minGap: 260,
  maxGapExtra: 350,
  firstSpawnDistance: 400, // px of travel before the first obstacle

  scoreDivisor: 40,       // distance px per score point (~9 pts/sec at start)
  birdScore: 300,
  nightEvery: 700,
  nightFade: 0.35,

  stepTime: 1 / 120,      // fixed simulation timestep (determinism across clients)

  touchHoldMs: 260,       // touch held longer than this = duck, shorter = jump
  ghostInterpDelay: 0.1,  // render ghosts this many seconds in their past (smoothing)
  ghostMaxExtrap: 0.25,   // max seconds to extrapolate a silent ghost forward

  colors: {
    day:   { fg: "#535353", bg: "#f7f7f7" },
    night: { fg: "#e8e8e8", bg: "#1b1b1b" },
  },
};

// ---------------------------------------------------------------------------
// Pixel-art sprites. '.'/' ' = empty, anything else = pixel.
// ---------------------------------------------------------------------------
const DINO_BODY = [
  "........XXXXXXXXXX..",
  "........X.XXXXXXXX..",
  "........XXXXXXXXXX..",
  "........XXXXXXXXXX..",
  "........XXXXX.......",
  "........XXXXXXXX....",
  "X.......XXXX........",
  "X......XXXXX........",
  "XX....XXXXXX.X......",
  "XXX..XXXXXXXXX......",
  "XXXXXXXXXXXXX.......",
  ".XXXXXXXXXXXX.......",
  "..XXXXXXXXXXX.......",
  "...XXXXXXXXX........",
  "....XXXXXXX.........",
  ".....XXXXX..........",
];

const DINO_LEGS = {
  stand: [
    ".....XX..XX.........",
    ".....X....X.........",
    ".....X....X.........",
    ".....XX...XX........",
  ],
  run1: [
    ".....XX..XX.........",
    ".....X....X.........",
    ".....X....X.........",
    ".....XX.............",
  ],
  run2: [
    ".....XX..XX.........",
    ".....X....X.........",
    "..........X.........",
    "..........XX........",
  ],
};

const DINO_DUCK = {
  body: [
    "..................XXXXXXXX",
    "..................X.XXXXXX",
    "XX................XXXXXXXX",
    "XXX....XXXXXXXXXXXXXXXX...",
    "XXXXXXXXXXXXXXXXXXXXXXXXX.",
    ".XXXXXXXXXXXXXXXXXXXX.....",
    "..XXXXXXXXXXXXXXXXXX......",
    "...XXXXXXXXXXXXXXXX.......",
  ],
  legs1: [
    ".....XX.....XX............",
    ".....XX.....XX............",
    ".....XX...................",
  ],
  legs2: [
    ".....XX.....XX............",
    "............XX............",
    "............XX............",
  ],
};

const CACTUS_SMALL = [
  "....XX...",
  "....XX..X",
  "X...XX..X",
  "X...XX..X",
  "X...XX..X",
  "X...XX..X",
  "XX..XX.XX",
  ".XXXXXXX.",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
  "....XX...",
];

const CACTUS_LARGE = [
  ".....XXX.....",
  ".....XXX....X",
  ".....XXX....X",
  "XX...XXX....X",
  "XX...XXX....X",
  "XX...XXX....X",
  "XX...XXX...XX",
  "XX...XXX..XXX",
  "XXX..XXX.XXX.",
  ".XXXXXXXXXX..",
  "..XXXXXXX....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
  ".....XXX.....",
];

const BIRD = {
  up: [
    "......X.............",
    "......XX............",
    "......XXX...........",
    "......XXXX..........",
    "XX....XXXXX.........",
    ".XXX.XXXXXXXXXXXXXX.",
    "..XXXXXXXXXXXXXXXXXX",
    "...XXXXXXXXXXXXX....",
    "....XXXXXXXXXX......",
  ],
  down: [
    "XX..................",
    ".XXX.XXXXX..........",
    "..XXXXXXXXXXXXXXXXX.",
    "...XXXXXXXXXXXXXXXXX",
    "....XXXXXXXXXXXX....",
    "......XXXX..........",
    "......XXX...........",
    "......XX............",
    "......X.............",
  ],
};

const CLOUD = [
  "........XXXX........",
  "......XXXXXXXX......",
  "..XXXXXXXXXXXXXX....",
  ".XXXXXXXXXXXXXXXXX..",
  "XXXXXXXXXXXXXXXXXXXX",
];

function spriteSize(map, scale) {
  return { w: map[0].length * scale, h: map.length * scale };
}

function drawSprite(ctx, map, x, y, scale, color) {
  ctx.fillStyle = color;
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    let c = 0;
    while (c < row.length) {
      if (row[c] !== "." && row[c] !== " ") {
        let run = c;
        while (run < row.length && row[run] !== "." && row[run] !== " ") run++;
        ctx.fillRect(x + c * scale, y + r * scale, (run - c) * scale, scale);
        c = run;
      } else {
        c++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Seedable RNG — same seed on every client => identical obstacle course.
// ---------------------------------------------------------------------------
class RNG {
  constructor(seed = Math.floor(Math.random() * 2 ** 31)) {
    this.s = seed >>> 0;
  }
  next() {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }
  range(min, max) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
}

// ---------------------------------------------------------------------------
// Dino — one per player. The local dino is physics-driven; remote ("ghost")
// dinos are driven by network state packets and interpolated.
// ---------------------------------------------------------------------------
class Dino {
  constructor(color = null, name = "") {
    this.color = color; // null = theme foreground
    this.name = name;
    this.x = 40;
    this.labelRow = 0;
    this.avatarImg = null; // face sticker drawn over the head
    this.reset();
  }

  setAvatarUrl(url) {
    this.avatarImg = null;
    if (!url) return;
    // old captures were circle-cropped JPEGs; new stickers (png/webp) have
    // the oval cut-out and white edge baked in
    this.avatarLegacy = url.startsWith("data:image/jpeg");
    const img = new Image();
    img.onload = () => { this.avatarImg = img; };
    img.src = url;
  }

  reset() {
    this.x = 40;
    this.y = 0;          // height above ground (0 = on ground)
    this.vy = 0;
    this.jumping = false;
    this.ducking = false;
    this.dead = false;
    this.animTime = 0;
    this.score = 0;      // ghosts carry their reported score
    this.samples = [];   // ghost state packets: {d, y, duck, recvAt}
    this.deathD = null;  // course distance at which a ghost died
  }

  get hitbox() {
    const s = CFG.scale;
    if (this.ducking && !this.jumping) {
      const w = DINO_DUCK.body[0].length * s;
      const h = (DINO_DUCK.body.length + 3) * s;
      return { x: this.x + 2, y: this.groundTop() + 2, w: w - 4, h: h - 4 };
    }
    const w = DINO_BODY[0].length * s;
    const h = (DINO_BODY.length + 4) * s;
    return { x: this.x + 4 * s, y: this.groundTop() + 2, w: w - 7 * s, h: h - 4 };
  }

  groundTop() {
    const s = CFG.scale;
    const h = this.ducking && !this.jumping
      ? (DINO_DUCK.body.length + 3) * s
      : (DINO_BODY.length + 4) * s;
    return CFG.groundY - h - this.y;
  }

  jump() {
    if (!this.jumping && !this.dead) {
      this.jumping = true;
      this.vy = CFG.jumpVelocity;
    }
  }

  // local physics step (fixed dt)
  update(dt, downHeld) {
    this.animTime += dt;
    if (this.jumping) {
      let g = CFG.gravity;
      if (downHeld) g += CFG.dropBoost;
      this.vy += g * dt * 60;
      this.y -= this.vy * dt * 60;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.jumping = false;
      }
    }
    this.ducking = downHeld && !this.jumping;
  }

  addSample(d, y, duck) {
    this.samples.push({ d, y, duck, recvAt: performance.now() });
    if (this.samples.length > 6) this.samples.shift();
  }

  draw(ctx, fg, running) {
    const s = CFG.scale;
    const color = this.color || fg;
    const frame = Math.floor(this.animTime * 10) % 2;

    if (this.ducking && !this.jumping && !this.dead) {
      const top = this.groundTop();
      drawSprite(ctx, DINO_DUCK.body, this.x, top, s, color);
      const legs = frame === 0 ? DINO_DUCK.legs1 : DINO_DUCK.legs2;
      drawSprite(ctx, legs, this.x, top + DINO_DUCK.body.length * s, s, color);
      this.drawFace(ctx, this.x + 21.5 * s, top + 2.5 * s, 16 * s);
      return;
    }

    const top = this.groundTop();
    drawSprite(ctx, DINO_BODY, this.x, top, s, color);
    let legs;
    if (this.dead || this.jumping || !running) legs = DINO_LEGS.stand;
    else legs = frame === 0 ? DINO_LEGS.run1 : DINO_LEGS.run2;
    drawSprite(ctx, legs, this.x, top + DINO_BODY.length * s, s, color);

    if (this.dead) {
      ctx.fillStyle = color;
      ctx.fillRect(this.x + 9 * s, top + 1 * s, s, s);
    }

    this.drawFace(ctx, this.x + 13 * s, top + 1 * s, 21 * s);
  }

  // photo sticker over the head — face cut-out, larger than the pixel head
  // so it pokes above the body like a real sticker slapped on the dino
  drawFace(ctx, cx, cy, size) {
    if (!this.avatarImg) return;
    if (this.avatarLegacy) {
      const r = size * 0.36;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(this.avatarImg, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      return;
    }
    // keep the sticker's natural aspect: height = size, width follows
    const iw = this.avatarImg.width, ih = this.avatarImg.height;
    const h = size;
    const w = size * (iw / ih);
    ctx.drawImage(this.avatarImg, cx - w / 2, cy - h / 2, w, h);
  }

  drawLabel(ctx, fg) {
    if (!this.name) return;
    ctx.fillStyle = this.color || fg;
    ctx.font = "bold 11px 'Courier New', monospace";
    ctx.textAlign = "left";
    const y = this.groundTop() - 8 - this.labelRow * 12 - (this.avatarImg ? 16 : 0);
    ctx.fillText(this.name, this.x + 4, Math.max(12, y));
  }
}

// ---------------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------------
class Obstacle {
  constructor(kind, x, rng) {
    this.kind = kind;
    this.x = x;
    this.animTime = 0;

    const s = CFG.scale;
    if (kind === "smallCactus" || kind === "largeCactus") {
      const map = kind === "smallCactus" ? CACTUS_SMALL : CACTUS_LARGE;
      this.count = rng.int(1, kind === "smallCactus" ? 3 : 2);
      this.map = map;
      const size = spriteSize(map, s);
      this.w = size.w * this.count + (this.count - 1) * s;
      this.h = size.h;
      this.y = CFG.groundY - this.h;
    } else {
      this.map = BIRD.up;
      const size = spriteSize(BIRD.up, s);
      this.w = size.w;
      this.h = size.h;
      // low (must jump), mid (duck or jump), high (run under)
      const level = rng.pick([0, 1, 2]);
      const ys = [CFG.groundY - this.h - 4, CFG.groundY - this.h - 30, CFG.groundY - this.h - 78];
      this.y = ys[level];
    }
  }

  update(dt, speed) {
    this.x -= speed * dt * 60;
    this.animTime += dt;
  }

  get offscreen() { return this.x + this.w < 0; }

  get hitbox() {
    return { x: this.x + 3, y: this.y + 3, w: this.w - 6, h: this.h - 6 };
  }

  draw(ctx, fg) {
    const s = CFG.scale;
    if (this.kind === "bird") {
      const frame = Math.floor(this.animTime * 6) % 2;
      drawSprite(ctx, frame === 0 ? BIRD.up : BIRD.down, this.x, this.y, s, fg);
    } else {
      const size = spriteSize(this.map, s);
      for (let i = 0; i < this.count; i++) {
        drawSprite(ctx, this.map, this.x + i * (size.w + s), this.y, s, fg);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scenery (own RNG stream so it never disturbs the shared obstacle course)
// ---------------------------------------------------------------------------
class Cloud {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  update(dt, speed) { this.x -= speed * 0.2 * dt * 60; }
  get offscreen() { return this.x + CLOUD[0].length * CFG.scale < 0; }
  draw(ctx, fg) {
    ctx.save();
    ctx.globalAlpha *= 0.55;
    drawSprite(ctx, CLOUD, this.x, this.y, CFG.scale, fg);
    ctx.restore();
  }
}

class Ground {
  constructor(rng) {
    this.offset = 0;
    this.marks = [];
    let x = 0;
    while (x < CFG.width * 2) {
      this.marks.push({ x, w: rng.int(4, 14), dy: rng.pick([3, 5, 7]) });
      x += rng.int(30, 90);
    }
    this.stripW = CFG.width * 2;
  }
  update(dt, speed) {
    this.offset = (this.offset + speed * dt * 60) % this.stripW;
  }
  draw(ctx, fg) {
    ctx.fillStyle = fg;
    ctx.fillRect(0, CFG.groundY, CFG.width, 2);
    for (const m of this.marks) {
      let x = m.x - this.offset;
      if (x < -20) x += this.stripW;
      if (x > CFG.width) continue;
      ctx.fillRect(x, CFG.groundY + m.dy, m.w, 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
const STATE = {
  IDLE: 0,       // menus in front, scene idles behind
  WAITING: 1,    // solo: press space to start
  COUNTDOWN: 2,  // net: 3..2..1
  RUNNING: 3,
  SPECTATE: 4,   // net: local dino dead, watching survivors
  OVER: 5,
};

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = "solo";
    this.dino = new Dino();
    this.ghosts = new Map(); // playerId -> Dino
    this.highScore = Number(localStorage.getItem("dino-high-score") || 0);
    this.downHeld = false;
    this.onDeath = null;     // set by the net layer: (score) => {}
    this.countdownEnd = 0;
    this.acc = 0;

    this.resetWorld();
    this.state = STATE.IDLE;

    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
    this.bindInput();
  }

  resetWorld(seed = Math.floor(Math.random() * 2 ** 31)) {
    this.rng = new RNG(seed);                             // obstacle stream
    this.sceneryRng = new RNG((seed ^ 0x5bd1e995) >>> 0); // clouds/ground stream
    this.speed = CFG.startSpeed;
    this.distance = 0;
    this.score = 0;
    this.night = false;
    this.nightBlend = 0;
    this.obstacles = [];
    this.nextSpawnAt = CFG.firstSpawnDistance;
    this.clouds = [new Cloud(120, 60), new Cloud(420, 95), new Cloud(650, 45)];
    this.ground = new Ground(this.sceneryRng);
    this.scoreFlash = 0;
    this.acc = 0;
    this.dino.reset();
    for (const g of this.ghosts.values()) g.reset();
  }

  // -- entry points ---------------------------------------------------------
  startSolo() {
    this.mode = "solo";
    this.ghosts.clear();
    this.dino.color = null;
    this.dino.name = "";
    this.refreshLocalAvatar();
    this.resetWorld();
    this.state = STATE.WAITING;
  }

  refreshLocalAvatar() {
    if (this.mode === "solo") this.dino.setAvatarUrl(localStorage.getItem("dino-avatar"));
  }

  startNet(seed, roster, localId, countdownMs) {
    this.mode = "net";
    this.ghosts.clear();
    let row = 0;
    for (const p of roster) {
      if (p.id === localId) {
        this.dino.color = p.color;
        this.dino.name = p.name;
        this.dino.labelRow = 0;
        this.dino.setAvatarUrl(p.avatar);
      } else {
        const g = new Dino(p.color, p.name);
        g.labelRow = (row++ % 3) + 1;
        g.setAvatarUrl(p.avatar);
        this.ghosts.set(p.id, g);
      }
    }
    this.resetWorld(seed);
    this.countdownEnd = performance.now() + countdownMs;
    this.state = STATE.COUNTDOWN;
  }

  applyState(id, msg) {
    const g = this.ghosts.get(id);
    if (g && !g.dead) {
      g.addSample(msg.d || 0, msg.y, msg.duck);
      g.score = msg.score;
    }
  }

  applyDeath(id, score) {
    const g = this.ghosts.get(id);
    if (g) {
      g.dead = true;
      g.y = 0;
      g.score = score;
      // freeze the corpse at the course position where they died — it then
      // scrolls away with the world, past the obstacle that killed them
      const last = g.samples[g.samples.length - 1];
      g.deathD = last ? last.d : this.distance;
    }
  }

  freezeNet() { this.state = STATE.OVER; }

  toIdle() {
    this.mode = "solo";
    this.ghosts.clear();
    this.dino.color = null;
    this.dino.name = "";
    this.refreshLocalAvatar();
    this.resetWorld();
    this.state = STATE.IDLE;
  }

  // -- input ----------------------------------------------------------------
  bindInput() {
    const press = (jump) => {
      if (this.state === STATE.WAITING) {
        this.state = STATE.RUNNING;
        if (jump) this.dino.jump();
      } else if (this.state === STATE.RUNNING) {
        if (jump) this.dino.jump();
      } else if (this.state === STATE.OVER && this.mode === "solo") {
        this.startSolo();
        this.state = STATE.RUNNING;
      }
    };

    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        press(true);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        this.downHeld = true;
      } else if (e.code === "Enter" && this.state === STATE.OVER && this.mode === "solo") {
        press(false);
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "ArrowDown") this.downHeld = false;
    });

    // Touch / mouse: tap = jump, hold = duck (release ends the duck).
    // Listens on the whole page — players naturally tap below the game so
    // their finger doesn't cover the action. Real UI (buttons, inputs,
    // links, overlay screens) is excluded and behaves normally.
    this.touchHoldTimer = null;
    this.touchDucking = false;

    const isUiTarget = (e) =>
      e.target.closest && e.target.closest("#screens, button, input, a, kbd") !== null;

    document.addEventListener("pointerdown", (e) => {
      if (isUiTarget(e)) return;
      e.preventDefault();
      if (this.state !== STATE.RUNNING) {
        press(true);
        return;
      }
      this.touchHoldTimer = setTimeout(() => {
        this.touchHoldTimer = null;
        this.touchDucking = true;
        this.downHeld = true;
      }, CFG.touchHoldMs);
    });

    const endTouch = (jump) => {
      if (this.touchHoldTimer) {
        clearTimeout(this.touchHoldTimer);
        this.touchHoldTimer = null;
        if (jump && this.state === STATE.RUNNING) this.dino.jump();
      }
      if (this.touchDucking) {
        this.touchDucking = false;
        this.downHeld = false;
      }
    };
    document.addEventListener("pointerup", (e) => {
      if (isUiTarget(e)) return;
      e.preventDefault();
      endTouch(true);
    });
    document.addEventListener("pointercancel", () => endTouch(false));
    window.addEventListener("blur", () => endTouch(false));
  }

  // -- simulation -----------------------------------------------------------
  spawnIfNeeded() {
    if (this.distance < this.nextSpawnAt) return;
    const kinds = ["smallCactus", "largeCactus"];
    // course-distance based, NOT this.score: the local score freezes on death,
    // and the obstacle stream must stay identical on every client's screen
    if (Math.floor(this.distance / CFG.scoreDivisor) > CFG.birdScore) kinds.push("bird");
    this.obstacles.push(new Obstacle(this.rng.pick(kinds), CFG.width + 20, this.rng));
    const gap = (CFG.minGap + this.rng.next() * CFG.maxGapExtra) * (0.7 + this.speed / CFG.maxSpeed);
    this.nextSpawnAt = this.distance + gap;
  }

  collide(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  step(dt) {
    this.speed = Math.min(CFG.maxSpeed, this.speed + CFG.acceleration * dt * 60);
    this.distance += this.speed * dt * 60;
    const newScore = Math.floor(this.distance / CFG.scoreDivisor);
    if (newScore !== this.score) {
      if (newScore > 0 && newScore % 100 === 0) this.scoreFlash = 1.2;
      if (newScore > 0 && newScore % CFG.nightEvery === 0) this.night = !this.night;
      if (!this.dino.dead) this.score = newScore;
    }
    if (this.scoreFlash > 0) this.scoreFlash -= dt;

    if (!this.dino.dead) this.dino.update(dt, this.downHeld);
    this.ground.update(dt, this.speed);

    for (const c of this.clouds) c.update(dt, this.speed);
    this.clouds = this.clouds.filter((c) => !c.offscreen);
    if (this.clouds.length < 3 && this.sceneryRng.next() < 0.01) {
      this.clouds.push(new Cloud(CFG.width + 30, this.sceneryRng.range(30, 120)));
    }

    this.spawnIfNeeded();
    for (const o of this.obstacles) o.update(dt, this.speed);
    this.obstacles = this.obstacles.filter((o) => !o.offscreen);

    if (this.state === STATE.RUNNING) {
      const box = this.dino.hitbox;
      for (const o of this.obstacles) {
        if (this.collide(box, o.hitbox)) {
          this.localDeath();
          break;
        }
      }
    }
  }

  localDeath() {
    this.dino.dead = true;
    this.dino.ducking = false;
    if (this.mode === "solo") {
      this.state = STATE.OVER;
      if (this.score > this.highScore) {
        this.highScore = this.score;
        localStorage.setItem("dino-high-score", String(this.highScore));
      }
    } else {
      this.state = STATE.SPECTATE; // world keeps moving; watch the survivors
      if (this.onDeath) this.onDeath(this.score);
    }
  }

  update(dtReal) {
    const target = this.night ? 1 : 0;
    const blendStep = dtReal / CFG.nightFade;
    if (this.nightBlend < target) this.nightBlend = Math.min(target, this.nightBlend + blendStep);
    if (this.nightBlend > target) this.nightBlend = Math.max(target, this.nightBlend - blendStep);

    if (this.state === STATE.COUNTDOWN && performance.now() >= this.countdownEnd) {
      this.state = STATE.RUNNING;
    }

    if (this.state === STATE.RUNNING || this.state === STATE.SPECTATE) {
      this.acc += dtReal;
      while (this.acc >= CFG.stepTime) {
        this.step(CFG.stepTime);
        this.acc -= CFG.stepTime;
      }
      this.updateGhosts(dtReal);
    }
  }

  // Ghosts are rendered in the sender's time frame: each packet carries the
  // sender's course distance `d`, and since all clients scroll the identical
  // course, drawing the ghost at x = 40 - (myDistance - theirD) places it
  // exactly over the obstacles it was actually facing. Network delay becomes
  // a small trailing x-offset instead of mistimed jumps ("phantom collisions").
  updateGhosts(dtReal) {
    const now = performance.now();
    const pxPerSec = this.speed * 60;
    for (const g of this.ghosts.values()) {
      g.animTime += dtReal;
      if (g.dead) {
        if (g.deathD != null) g.x = 40 - (this.distance - g.deathD);
        continue;
      }
      const s = g.samples;
      if (!s.length) continue;
      const latest = s[s.length - 1];
      // estimate their current distance (their world kept scrolling since the
      // packet was sent), then step back a little so we interpolate between
      // real samples instead of guessing
      const age = Math.min(CFG.ghostMaxExtrap, (now - latest.recvAt) / 1000);
      const dTarget = latest.d + pxPerSec * (age - CFG.ghostInterpDelay);
      let y, duck, dRender;
      if (dTarget >= latest.d) {
        y = latest.y;
        duck = latest.duck;
        dRender = dTarget;
      } else {
        let i = s.length - 1;
        while (i > 0 && s[i - 1].d > dTarget) i--;
        const a = s[Math.max(0, i - 1)];
        const b = s[i];
        const span = b.d - a.d;
        const t = span > 0 ? Math.min(1, Math.max(0, (dTarget - a.d) / span)) : 1;
        y = a.y + (b.y - a.y) * t;
        duck = b.duck;
        dRender = Math.max(dTarget, s[0].d);
      }
      g.y = Math.max(0, y);
      g.ducking = duck && g.y < 4;
      // clamp living ghosts on screen: a peer whose clock/network lags far
      // behind would otherwise trail off the left edge and vanish entirely
      g.x = Math.max(4, Math.min(CFG.width - 80, 40 - (this.distance - dRender)));
    }
  }

  // -- rendering ------------------------------------------------------------
  themeColors() {
    const d = CFG.colors.day, n = CFG.colors.night;
    const mix = (a, b) => {
      const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
      const ch = (p, sh) => (p >> sh) & 255;
      const t = this.nightBlend;
      const r = Math.round(ch(pa, 16) + (ch(pb, 16) - ch(pa, 16)) * t);
      const g = Math.round(ch(pa, 8) + (ch(pb, 8) - ch(pa, 8)) * t);
      const bl = Math.round(ch(pa, 0) + (ch(pb, 0) - ch(pa, 0)) * t);
      return `rgb(${r},${g},${bl})`;
    };
    return { fg: mix(d.fg, n.fg), bg: mix(d.bg, n.bg) };
  }

  drawScore(ctx, fg) {
    ctx.fillStyle = fg;
    ctx.font = "bold 16px 'Courier New', monospace";
    ctx.textAlign = "right";
    const flashing = this.scoreFlash > 0 && Math.floor(this.scoreFlash * 8) % 2 === 0;
    if (!flashing) ctx.fillText(String(this.score).padStart(5, "0"), CFG.width - 20, 30);
    if (this.mode === "solo" && this.highScore > 0) {
      ctx.globalAlpha = 0.55;
      ctx.fillText("HI " + String(this.highScore).padStart(5, "0"), CFG.width - 90, 30);
      ctx.globalAlpha = 1;
    }
  }

  drawCenterText(ctx, fg) {
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    if (this.state === STATE.WAITING) {
      ctx.font = "bold 18px 'Courier New', monospace";
      ctx.fillText("PRESS SPACE TO START", CFG.width / 2, 120);
    } else if (this.state === STATE.COUNTDOWN) {
      const remaining = Math.max(0, this.countdownEnd - performance.now());
      ctx.font = "bold 48px 'Courier New', monospace";
      ctx.fillText(String(Math.ceil(remaining / 1000)), CFG.width / 2, 130);
      ctx.font = "bold 14px 'Courier New', monospace";
      ctx.fillText("GET READY", CFG.width / 2, 160);
    } else if (this.state === STATE.SPECTATE) {
      if (Math.floor(performance.now() / 500) % 2 === 0) {
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.fillText("ELIMINATED — WATCHING", CFG.width / 2, 40);
      }
    } else if (this.state === STATE.OVER && this.mode === "solo") {
      ctx.font = "bold 22px 'Courier New', monospace";
      ctx.fillText("G A M E  O V E R", CFG.width / 2, 105);
      const cx = CFG.width / 2, cy = 145;
      ctx.strokeStyle = fg;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 16, -0.4, Math.PI * 1.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 8, cy - 20);
      ctx.lineTo(cx + 22, cy - 16);
      ctx.lineTo(cx + 10, cy - 6);
      ctx.closePath();
      ctx.fillStyle = fg;
      ctx.fill();
    }
  }

  render() {
    const ctx = this.ctx;
    const { fg, bg } = this.themeColors();

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CFG.width, CFG.height);
    document.body.style.background = bg;

    for (const c of this.clouds) c.draw(ctx, fg);
    this.ground.draw(ctx, fg);
    for (const o of this.obstacles) o.draw(ctx, fg);

    const animating = this.state === STATE.RUNNING || this.state === STATE.SPECTATE;
    for (const g of this.ghosts.values()) {
      if (g.x < -70 || g.x > CFG.width) continue; // corpse scrolled away / not yet visible
      ctx.globalAlpha = g.dead ? 0.25 : 0.5;
      g.draw(ctx, fg, animating);
      ctx.globalAlpha = 0.9;
      g.drawLabel(ctx, fg);
      ctx.globalAlpha = 1;
    }
    this.dino.draw(ctx, fg, animating || this.state === STATE.COUNTDOWN);
    if (this.mode === "net") this.dino.drawLabel(ctx, fg);

    this.drawScore(ctx, fg);
    this.drawCenterText(ctx, fg);
  }

  loop(t) {
    const dt = Math.min(0.05, (t - this.lastTime) / 1000);
    this.lastTime = t;
    this.update(dt);
    this.render();
    requestAnimationFrame((tt) => this.loop(tt));
  }
}

window.STATE = STATE;
window.game = new Game(document.getElementById("game"));
