Put your own "you lost" or "you won" video here.

For the lose video:
1. Drop an .mp4 file into this folder, e.g.:
     lose.mp4
2. Open js/config.js and set, under VIDEO_CONFIG:
     mode: "local"
     localFile: "videos/lose.mp4"   <- match the filename you used

For the secret-ending win video:
1. Drop an .mp4 file into this folder, e.g.:
     win.mp4
2. Open js/config.js and set, under WIN_VIDEO_CONFIG:
     mode: "local"
     localFile: "videos/win.mp4"   <- match the filename you used

That's it - the game will play those files whenever you die or
reach the secret ending.

Prefer YouTube instead? You don't need this folder at all -
just set mode: "youtube" and youtubeId: "..." under VIDEO_CONFIG
and/or WIN_VIDEO_CONFIG in js/config.js.
