/* =========================================================
   VIDEO CONFIG
   This is the only file you need to touch to change what
   plays when you lose. Set VIDEO_CONFIG.mode to one of:

     "local"   - play a video file you put in the /videos folder
     "youtube" - embed a YouTube video by its ID
     "remote"  - play a video from a direct URL on the internet

   Only the setting matching your chosen "mode" is used;
   the others are ignored, so you can leave them filled in.
   ========================================================= */

const VIDEO_CONFIG = {

  // Which source to use: "local" | "youtube" | "remote"
  mode: "local",

  // ---- mode: "local" ----
  // Put your own video file in the videos/ folder (e.g. videos/lose.mp4)
  // and put its filename here.
  localFile: "videos/loose3.mp4",

  // ---- mode: "youtube" ----
  // The video ID is the part after "v=" in a YouTube URL.
  // e.g. for https://www.youtube.com/watch?v=dQw4w9WgXcQ
  // the ID is:                                dQw4w9WgXcQ
  youtubeId: "dQw4w9WgXcQ",

  // ---- mode: "remote" ----
  // A direct link to an .mp4 file hosted somewhere online.
  // This is the default so the game works right out of the box.
  remoteUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
};


/* =========================================================
   WIN VIDEO CONFIG
   Same idea as VIDEO_CONFIG above, but for the secret ending
   (reaching DIFFICULTY_CONFIG.winDistanceMeters below). This
   video is the "troll" - it plays the same trapped/no-escape
   way as the lose video, then leads into the thanks-for-playing
   screen once it finishes.
   ========================================================= */

const WIN_VIDEO_CONFIG = {
  mode: "local",
  localFile: "videos/win.mp4",
  youtubeId: "dQw4w9WgXcQ",
  remoteUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
};


/* =========================================================
   DIFFICULTY CONFIG
   Tune how forgiving the game is. Higher numbers = harder,
   except where noted.
   ========================================================= */

const DIFFICULTY_CONFIG = {
  // How fast the ground scrolls at the very start (lower = easier)
  startSpeed: 3.0,

  // The fastest the game will ever get (lower = easier)
  maxSpeed: 7.0,

  // How many milliseconds it takes to ramp from start to max speed.
  // Set high on purpose so difficulty keeps climbing gradually across
  // a full run toward the secret ending, instead of maxing out early.
  rampUpTimeMs: 90000,

  // How wide the safe, obstacle-free stretch is at the start (pixels)
  safeStartWidth: 900,

  // Base chance (0 to 1) that a new segment is a gap instead of solid ground
  baseGapChance: 0.18,

  // Base chance (0 to 1) that solid ground includes spikes
  baseSpikeChance: 0.40,

  // Extra forgiveness (in pixels) shaved off each side of the player's
  // hitbox when checking spike collisions - higher = more forgiving
  hitboxForgiveness: 8.5,

  // Distance (in the same units shown on the DISTANCE counter) that
  // triggers the secret ending. The game still bills itself as
  // unwinnable, so most players will never intentionally reach this.
  winDistanceMeters: 2000
};
