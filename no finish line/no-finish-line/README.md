# No Finish Line

A tiny platformer that's *mostly* unwinnable — just survive as long as
you can. When you die, a video plays. If you somehow survive to the
secret ending, a different video plays, and then it's just over.

## Files

```
no-finish-line/
├── index.html          the page structure
├── css/
│   └── style.css       all visual styling
├── js/
│   ├── config.js        <-- edit this to change videos or difficulty
│   └── game.js           the game logic (physics, terrain, drawing)
├── videos/
│   └── README.txt       instructions for adding your own local videos
└── README.md            this file
```

## Running it

Just open `index.html` in a browser. No install, no server needed.

## Changing the "you lost" video

Open `js/config.js` and edit `VIDEO_CONFIG`:

- **Your own video file** — set `mode: "local"`, drop an `.mp4` into
  `videos/`, and point `localFile` at it.
- **A YouTube video** — set `mode: "youtube"` and paste the video ID
  (the part after `v=` in the URL) into `youtubeId`.
- **A link to a video already online** — set `mode: "remote"` and put
  the direct `.mp4` URL in `remoteUrl`. This is the default, so the
  game works right away with no setup.

## Changing the secret-ending video

`js/config.js` has a second, separate settings block called
`WIN_VIDEO_CONFIG` — it works exactly the same way as `VIDEO_CONFIG`
above (same `mode` / `localFile` / `youtubeId` / `remoteUrl` fields),
it just controls the video shown on the win screen instead of the
lose screen. If you're using a local file for this one, drop it in
`videos/` too (e.g. `videos/win.mp4`) and point `localFile` at it.

## Reaching the secret ending

In `js/config.js`, under `DIFFICULTY_CONFIG`, the `winDistanceMeters`
setting controls how far you need to run to trigger it — it's `2000`
by default, matching the number shown on the DISTANCE counter in
game. Change that number to make the secret ending easier or harder
to reach.

## Adjusting difficulty

Also in `js/config.js`, under `DIFFICULTY_CONFIG`:

- `startSpeed` / `maxSpeed` — how fast the game starts and how fast it
  eventually gets. Lower both for an easier game.
- `rampUpTimeMs` — how long (in milliseconds) it takes to reach max
  speed. It's set fairly high by default so difficulty keeps climbing
  gradually across a full run toward the secret ending, rather than
  maxing out early and staying there.
- `safeStartWidth` — how much obstacle-free ground you get before the
  first hazard shows up.
- `baseGapChance` / `baseSpikeChance` — how often gaps/spikes appear.
- `hitboxForgiveness` — extra pixels shaved off the player's hitbox
  when checking spike collisions, so near-misses don't kill you.

The current defaults are tuned to ramp up steadily but stay beatable
by the time you'd reach 2000m — hard, not impossible.

## The "no escape" screens

Both the lose screen and the secret-ending win screen work the same
way: the video takes over the entire screen, and there's an X button
in the corner that doesn't actually close anything — clicking it
shakes and flashes "THERE IS NO ESCAPE" instead. The only way through
is to let the video finish playing.

- On the **lose screen**, finishing the video reveals a "RUN AGAIN"
  button.
- On the **win screen**, finishing the video reveals the actual
  ending: a "THANKS FOR PLAYING!" message with a credit line. There's
  no button there — that's the joke. Refresh the page to play again.

This works the same way for all video modes (local file, remote URL,
or YouTube) — YouTube videos use the official YouTube IFrame Player
API in the background so the game can tell when the video has
actually ended.

## Changing the credit

The "a game by CJLG" line lives directly in `index.html` — search for
`endgameContent` and edit the text inside the `<p class="credit">`
tag.

A note on content: keep whatever videos you use to something you're
comfortable putting in front of people involuntarily and on a loop —
this mechanic is a joke about being "trapped," not a reason to use
genuinely distressing material.

