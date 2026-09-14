/* =========================================================
   NO FINISH LINE - game logic
   Reads settings from config.js (loaded before this file).
   ========================================================= */

// ---------- grab elements from the page ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const GROUND_Y = H - 70; // y position of the ground line

const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const loseScoreEl = document.getElementById('loseScore');
const startOverlay = document.getElementById('startOverlay');
const loseOverlay = document.getElementById('loseOverlay');
const startBtn = document.getElementById('startBtn');
const retryBtn = document.getElementById('retryBtn');
const videoContainer = document.getElementById('videoContainer');
const fakeCloseBtn = document.getElementById('fakeCloseBtn');
const noEscapeToast = document.getElementById('noEscapeToast');

// secret-ending (win) overlay elements
const winOverlay = document.getElementById('winOverlay');
const winScoreEl = document.getElementById('winScore');
const winVideoContainer = document.getElementById('winVideoContainer');
const fakeCloseBtnWin = document.getElementById('fakeCloseBtnWin');
const noEscapeToastWin = document.getElementById('noEscapeToastWin');
const endgameContent = document.getElementById('endgameContent');

//best score, saved in the browser between visits
let best = Number(localStorage.getItem('nfl_best') || 0);
bestEl.textContent = best;

// drawing colors 
const COLORS = {
  ground: '#3a2a52',
  groundTop: '#e8b339',
  spike: '#e2543a',
  player: '#f3ece0',
  playerEye: '#241a33',
  hazardGap: '#150f20'
};

// ---------- game state ----------
let state = 'idle'; // 'idle' | 'running' | 'dead'
let worldSpeed = DIFFICULTY_CONFIG.startSpeed;
let elapsed = 0;    // ms since the current run started
let distance = 0;   // raw distance travelled this run

// ---------- the player ----------
const player = {
  x: 110,
  y: GROUND_Y - 34,
  w: 30,
  h: 34,
  vy: 0,
  onGround: true,
  squash: 0 // used for a little stretch/squash animation
};

const GRAVITY = 0.62;
const JUMP_V = -12.4;

/* =========================================================
   TERRAIN GENERATION
   The world is a list of "segments" scrolling left.
   Each segment is either solid ground (maybe with spikes)
   or a gap you have to jump over.
   ========================================================= */
let segments = [];
let nextSpawnX = 0;

function resetWorld(){
  segments = [];
  worldSpeed = DIFFICULTY_CONFIG.startSpeed;
  elapsed = 0;
  distance = 0;

  // start with a long, safe, flat stretch so the run always begins fairly
  segments.push({ x: 0, w: DIFFICULTY_CONFIG.safeStartWidth, type: 'ground', spikes: [] });
  nextSpawnX = DIFFICULTY_CONFIG.safeStartWidth;

  player.y = GROUND_Y - player.h;
  player.vy = 0;
  player.onGround = true;
  player.squash = 0;
  scoreEl.textContent = '0';
}

function rand(a, b){ return a + Math.random() * (b - a); }

// creates the next chunk of terrain ahead of the player
function spawnSegment(){
  // difficulty ramps from 0 to 1 over rampUpTimeMs, then stays at 1
  const difficulty = Math.min(elapsed / DIFFICULTY_CONFIG.rampUpTimeMs, 1);

  const gapChance = DIFFICULTY_CONFIG.baseGapChance + difficulty * 0.18;
  const spikeChance = DIFFICULTY_CONFIG.baseSpikeChance + difficulty * 0.22;

  if (Math.random() < gapChance) {
    // a pit to jump over, sized so it's always jumpable
    const gapW = rand(60, 95 + difficulty * 25);
    segments.push({ x: nextSpawnX, w: gapW, type: 'gap', spikes: [] });
    nextSpawnX += gapW;

    // followed by a landing stretch - kept generous and rarely spiked
    // right after a gap, so you get a breather after each jump
    const groundW = rand(260, 420);
    const spikes = [];
    if (Math.random() < spikeChance * 0.5) {
      spikes.push({ x: rand(80, groundW - 100), w: 24 });
    }
    segments.push({ x: nextSpawnX, w: groundW, type: 'ground', spikes });
    nextSpawnX += groundW;

  } else {
    // plain ground, sometimes with one spike (rarely two, only later on)
    const groundW = rand(300, 460);
    const spikes = [];
    if (Math.random() < spikeChance) {
      spikes.push({ x: rand(70, groundW - 90), w: 24 });
      if (Math.random() < difficulty * 0.25) {
        spikes.push({ x: rand(70, groundW - 90), w: 24 });
      }
    }
    segments.push({ x: nextSpawnX, w: groundW, type: 'ground', spikes });
    nextSpawnX += groundW;
  }
}

/* =========================================================
   UPDATE - runs every frame while state === 'running'
   ========================================================= */
function update(dt){
  elapsed += dt;

  // speed ramps from startSpeed up to maxSpeed over rampUpTimeMs
  const rampProgress = Math.min(elapsed / DIFFICULTY_CONFIG.rampUpTimeMs, 1);
  worldSpeed = DIFFICULTY_CONFIG.startSpeed +
    rampProgress * (DIFFICULTY_CONFIG.maxSpeed - DIFFICULTY_CONFIG.startSpeed);

  distance += worldSpeed * dt / 16.67;
  const displayScore = Math.floor(distance / 8);
  scoreEl.textContent = displayScore;

  // secret ending: reach the configured distance and the run ends in a win
  if (displayScore >= DIFFICULTY_CONFIG.winDistanceMeters) {
    win();
    return;
  }

  // scroll all terrain left
  for (const seg of segments) seg.x -= worldSpeed;
  nextSpawnX -= worldSpeed;

  // drop segments that are fully off-screen behind the player
  while (segments.length && segments[0].x + segments[0].w < -20) segments.shift();

  // keep generating terrain ahead of the visible area
  while (nextSpawnX < W + 400) spawnSegment();

  // --- physics: gravity + vertical position ---
  player.vy += GRAVITY;
  player.y += player.vy;

  // find which segment the player is currently above
  const px = player.x + player.w / 2;
  let underSeg = null;
  for (const seg of segments) {
    if (px >= seg.x && px <= seg.x + seg.w) { underSeg = seg; break; }
  }
  const isOverGap = underSeg && underSeg.type === 'gap';

  if (!isOverGap) {
    // solid ground under the player - land if falling onto it
    if (player.y + player.h >= GROUND_Y) {
      if (!player.onGround) player.squash = 6; // landing squash effect
      player.y = GROUND_Y - player.h;
      player.vy = 0;
      player.onGround = true;
    } else {
      player.onGround = false;
    }
  } else {
    player.onGround = false; // nothing to stand on - keep falling
  }

  if (player.squash > 0) player.squash -= 0.5;

  // death #1: fell all the way through a gap
  if (player.y > H + 40) {
    die();
    return;
  }

  // death #2: touched a spike
  if (underSeg && underSeg.type === 'ground') {
    const f = DIFFICULTY_CONFIG.hitboxForgiveness;
    for (const sp of underSeg.spikes) {
      const spikeX = underSeg.x + sp.x;
      const spikeTopY = GROUND_Y - 22;
      const overlapsX =
        player.x + f < spikeX + sp.w &&
        player.x + player.w - f > spikeX;
      const overlapsY = player.y + player.h > spikeTopY + 4;
      if (overlapsX && overlapsY) {
        die();
        return;
      }
    }
  }
}

/* =========================================================
   DRAW - renders the current frame to the canvas
   ========================================================= */
function draw(){
  ctx.clearRect(0, 0, W, H);

  // faint background dots for a little depth
  ctx.fillStyle = 'rgba(243,236,224,0.05)';
  for (let i = 0; i < 6; i++) {
    const bx = ((i * 180) - (elapsed * 0.03) % 180 + 1800) % (W + 200) - 100;
    ctx.beginPath();
    ctx.arc(bx, 60 + (i % 3) * 40, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // terrain
  for (const seg of segments) {
    if (seg.type === 'ground') {
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(seg.x, GROUND_Y, seg.w, H - GROUND_Y);
      ctx.fillStyle = COLORS.groundTop;
      ctx.fillRect(seg.x, GROUND_Y, seg.w, 5);

      for (const sp of seg.spikes) {
        const sx = seg.x + sp.x;
        ctx.fillStyle = COLORS.spike;
        ctx.beginPath();
        ctx.moveTo(sx, GROUND_Y);
        ctx.lineTo(sx + sp.w / 2, GROUND_Y - 22);
        ctx.lineTo(sx + sp.w, GROUND_Y);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.fillStyle = COLORS.hazardGap;
      ctx.fillRect(seg.x, GROUND_Y, seg.w, H - GROUND_Y);
    }
  }

  // player, with a little squash/stretch based on jump/landing
  ctx.save();
  const sq = player.squash;
  ctx.translate(player.x + player.w / 2, player.y + player.h);
  ctx.scale(1 + sq * 0.01, 1 - sq * 0.02);
  ctx.translate(-player.w / 2, -player.h);
  ctx.fillStyle = COLORS.player;
  ctx.fillRect(0, 0, player.w, player.h);
  ctx.fillStyle = COLORS.playerEye;
  ctx.fillRect(player.w - 10, 8, 5, 5);
  ctx.restore();
}

/* =========================================================
   PLAYER INPUT
   ========================================================= */
function jump(){
  if (state !== 'running') return;
  if (player.onGround) {
    player.vy = JUMP_V;
    player.onGround = false;
    player.squash = -6;
  }
}

/* =========================================================
   VIDEO INJECTION
   Builds either a <video> or a YouTube embed inside a given
   container, based on a video config object from config.js
   (either VIDEO_CONFIG or WIN_VIDEO_CONFIG). Shared by both
   the lose screen and the secret-ending win screen.

   onFinished() is called once the video actually finishes -
   that's the only thing that unlocks what comes next.
   ========================================================= */

// loads the YouTube IFrame Player API script once, the first
// time it's actually needed, and caches the loading promise
let youtubeApiPromise = null;
function loadYouTubeApi(){
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    // YouTube calls this global function once its API is ready
    window.onYouTubeIframeAPIReady = () => resolve();
  });
  return youtubeApiPromise;
}

function buildVideo(config, container, mountId, onFinished){
  container.innerHTML = ''; // clear whatever was there before

  if (config.mode === 'youtube') {
    // build a placeholder div for the YouTube Player API to take over
    const mount = document.createElement('div');
    mount.id = mountId;
    container.appendChild(mount);

    loadYouTubeApi().then(() => {
      new YT.Player(mountId, {
        videoId: config.youtubeId,
        playerVars: { autoplay: 1, mute: 0, rel: 0, controls: 1 },
        events: {
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) onFinished();
          }
        }
      });
    });

  } else {
    // 'local' or 'remote' both use a plain <video> tag,
    // just pointed at a different source. Controls are turned
    // off so the video can't be scrubbed past the end to skip it.
    const video = document.createElement('video');
    video.playsInline = true;
    video.controls = false;
    video.autoplay = true;
    video.src = config.mode === 'local' ? config.localFile : config.remoteUrl;
    video.addEventListener('ended', onFinished);
    container.appendChild(video);
    video.play().catch(() => {}); // ignore if the browser blocks autoplay
  }
}

// clicking either fake X shakes it and flashes "THERE IS NO ESCAPE" -
// it never actually closes the overlay. One handler, reused for both
// the lose and win screens, each with its own little timer.
function makeEscapeHandler(btnEl, toastEl){
  let timer = null;
  return () => {
    btnEl.classList.remove('shake');
    void btnEl.offsetWidth; // restart the animation
    btnEl.classList.add('shake');

    toastEl.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => toastEl.classList.remove('show'), 1200);
  };
}
const tryToEscapeLose = makeEscapeHandler(fakeCloseBtn, noEscapeToast);
const tryToEscapeWin = makeEscapeHandler(fakeCloseBtnWin, noEscapeToastWin);

/* =========================================================
   GAME OVER (lose) FLOW
   ========================================================= */
function die(){
  state = 'dead';

  const finalScore = Math.floor(distance / 8);
  if (finalScore > best) {
    best = finalScore;
    localStorage.setItem('nfl_best', String(best));
    bestEl.textContent = best;
  }
  loseScoreEl.textContent = finalScore;

  retryBtn.hidden = true; // stays hidden until the video finishes
  buildVideo(VIDEO_CONFIG, videoContainer, 'ytPlayerMount', () => {
    retryBtn.hidden = false;
  });
  loseOverlay.classList.add('show');
}

/* =========================================================
   SECRET ENDING (win) FLOW
   Reached only by hitting DIFFICULTY_CONFIG.winDistanceMeters.
   Same "no escape" trapped-video trick as the lose screen, but
   once the video ends it reveals the credits instead of a
   retry button - this really is the end.
   ========================================================= */
function win(){
  state = 'won';

  const finalScore = Math.floor(distance / 8);
  if (finalScore > best) {
    best = finalScore;
    localStorage.setItem('nfl_best', String(best));
    bestEl.textContent = best;
  }
  winScoreEl.textContent = finalScore;

  endgameContent.hidden = true; // stays hidden until the video finishes
  buildVideo(WIN_VIDEO_CONFIG, winVideoContainer, 'ytPlayerMountWin', () => {
    winVideoContainer.innerHTML = '';
    endgameContent.hidden = false;
  });
  winOverlay.classList.add('show');
}

function startRun(){
  resetWorld();
  state = 'running';
  startOverlay.classList.remove('show');
  loseOverlay.classList.remove('show');
  winOverlay.classList.remove('show');
  noEscapeToast.classList.remove('show');
  noEscapeToastWin.classList.remove('show');
  videoContainer.innerHTML = ''; // stop any playing video
  winVideoContainer.innerHTML = '';
  lastT = performance.now();
  requestAnimationFrame(loop);
}

let lastT = 0;
function loop(t){
  if (state !== 'running') return;
  const dt = Math.min(t - lastT, 40); // cap dt so tab-switching doesn't cause a huge jump
  lastT = t;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

/* =========================================================
   EVENT LISTENERS
   ========================================================= */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    if (state === 'idle') startRun();
    else jump();
  }
});

canvas.addEventListener('pointerdown', () => {
  if (state === 'idle') startRun();
  else if (state === 'running') jump();
});

startBtn.addEventListener('click', startRun);
retryBtn.addEventListener('click', startRun);
fakeCloseBtn.addEventListener('click', tryToEscapeLose);
fakeCloseBtnWin.addEventListener('click', tryToEscapeWin);

// draw one static frame before the player hits "start"
resetWorld();
draw();
