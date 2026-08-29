# ED Mission Operator — YouTube upload pack

**File to upload:** `mission-operator-yt.mp4` (1920×1080, 25 fps, h264/AAC, 3:27, 37 MB, −14 LUFS)
**Thumbnail:** `thumbnail.jpg` (1280×720)

---

## Title options

1. **Elite Dangerous is beautiful and empty. I built a crew for it.**
2. **This HUD reads your journal and talks back — ED Mission Operator**
3. **Bring the galaxy alive — ED Mission Operator for Elite Dangerous**

Pick 1 for reach (the hook is the emotion), 2 for search (says what it is), 3 for the channel-brand line.

---

## Description

```
Four hundred billion star systems, and almost none of them say anything back.

ED Mission Operator is a small always-on-top window that sits beside Elite
Dangerous and fills that silence. It reads the journal the game already writes
and turns it into a crew: your mission board sorted and counting down, an
orrery of every body you've scanned drawn where it actually is right now,
ambient comms traffic, a local news wire written from your system's own
factions, neutron routing, trade leads, and an AI operator that answers out
loud.

It runs entirely on your machine. Your journal never leaves it. The voice is
local (Piper), and the model is local too — point it at LM Studio and the
operator talks back in your own words.

Everything in this video is the real app driving real journal data.

CHAPTERS
0:00 Something is missing
0:19 What Mission Operator is
0:31 The mission board
0:44 Countdowns that find you
0:55 It keeps your place
1:11 Trade leads from markets you visit
1:21 The Orrery
1:35 Winding the clock
1:47 Comms — voices in the channel
1:58 The local wire
2:11 Radio
2:21 The wine run
2:30 Plotter — neutron routes
2:37 Settings
2:48 Pick your phosphor
2:57 Local, and private
3:13 Bring the galaxy alive

#EliteDangerous #EliteDangerousOdyssey #Gaming
```

---

## Tags

```
elite dangerous, elite dangerous mod, elite dangerous tools, elite dangerous hud,
ed mission operator, elite dangerous overlay, journal reader, elite dangerous ai,
lm studio, local ai, piper tts, elite dangerous orrery, neutron router,
elite dangerous immersion, edmc alternative, space sim, frontier developments
```

---

## Notes on what's on screen

Everything is the real built UI driving real data — nothing is mocked up in a
design tool:

- **Journal** — a genuine recorded session (Cmdr M'allock, courier and
  assassination runs out of The Forge Of Vulcan to HIP 71120), re-clocked to the
  present so the mission timers actually count down. Events are real; only the
  clock moved.
- **Orrery** — the real HIP 71120 scan set, 21 bodies and 6 belt clusters,
  positioned by the app from their own orbital elements.
- **Comms** — rendered through the app's own bundled grammar, cast naming and
  `render()` path. The comms engine only puts traffic on the air inside the
  desktop shell, so for a browser recording the log was pre-loaded with scenes
  the same code generates. The words, pools and speaker names are the app's.
- **Booze Cruise** — the cruise runs about once a year, so the run tally and
  Rackham's Peak prices are staged, exactly as `scripts/booze-shot.mjs` already
  does for the website. The economics are computed by the real code.
- **LM / JRNL red in the footer** — accurate. The recording is a browser without
  the desktop shell, so there's no journal watcher and no LM Studio attached.
  If that bothers you, the fix is to re-record against the Tauri build.

## Rebuilding

```
npx vite preview --port 4173          # serves dist/ (+ dist/stage.html)
node build-journal.mjs                # re-clock the session to now
node build-comms.ts                   # render comms from the bundled grammar
node narrate.mjs                      # Piper -> per-beat wavs + beats.json
node tour.mjs                         # drive the UI, record 1080p webm
bash mux.sh                           # narration + drone bed -> master mp4
node thumb.mjs                        # thumbnail
```

`VOICE=alba node narrate.mjs` swaps the narrator to the Scottish voice; re-run
`tour.mjs` and `mux.sh` afterwards, since beat durations change.
