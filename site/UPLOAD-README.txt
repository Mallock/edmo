ED MISSION OPERATOR — WEBSITE FOLDER
====================================

WHAT THIS IS
  A complete, self-contained website. No database, no PHP, no build step.

  index.html                              the page
  img/                                    screenshots + icons
  fonts/                                  the two webfonts, self-hosted
  ED-Mission-Operator-1.0.4-setup.exe       the Windows installer (~131 MB)
  ED-Mission-Operator-1.0.4-amd64.deb       Linux beta, Ubuntu/Debian (~147 MB)
  ED-Mission-Operator-1.0.4-x86_64.AppImage Linux beta, any distro (~231 MB)

HOW TO PUT IT ON YOUR WEB HOTEL
  1. Open your web hotel's File Manager (or connect with FTP, e.g. FileZilla).
  2. Go into the public_html folder (sometimes called www or htdocs).
  3. Upload the CONTENTS of this folder (index.html, img folder, the .exe)
     — not the "site" folder itself, unless you want the page at /site/.
  4. Visit your domain in a browser. Done.

NOTES
  * The installer is ~131 MB. Browser-based file managers sometimes limit
    uploads (often to 100 MB) — if the .exe upload fails, use FTP instead,
    or upload it to a file service and change the download link in
    index.html (search for "ED-Mission-Operator-1.0.4-setup.exe").
  * 1.0.4 adds the ORRERY tab: the system map, at the size of a HUD. Every
    Scan the game writes carries the body's whole orbit — semi-major axis,
    eccentricity, inclination, periapsis, ascending node, mean anomaly and
    period — so the tab is arithmetic rather than a picture: it places each
    body where it actually is at this instant, and a warp control runs the
    clock forward to show where it will be. Nothing is simulated and nothing
    drifts, because every frame solves the same equations at a different time.
    Stars, planets, barycentres, and belt clusters drawn as the bands they
    are; the body you are on is ringed; tap anything for its distance, its
    orbital period and its eccentricity. Distances are compressed per level —
    the only way a moon stays visible around a planet 400 ls from its star —
    and the card always says which mode it is in, with a switch to true
    distances. It draws only what you have scanned: no third-party database,
    no bodies guessed into position. There is a new screenshot for it in
    img/hud-orrery.png, first in the gallery.
    It also counts every scan you have EVER taken, not just this session. The
    honk does not carry orbits — FSSDiscoveryScan says how many bodies are out
    there and lists the signal sources, but the orbital elements only ever ride
    on a Scan — and the session bootstrap replays one journal or two. So
    arriving in a system now re-reads the whole journal history on disk for
    that system and fills the map before you touch the FSS. Measured on a real
    install: 126 scans spread over 510 journal files, found in under a second,
    drawn as 36 bodies and 12 ring bands. Nothing is guessed; elements are
    constants, so a body scanned in 2025 is in the same orbit today.
    The map frames itself to the bodies it actually has, so it fills the panel
    instead of leaving a margin, and anything that would still be drawn on top
    of something else is nudged apart until you can count them — 21 overlapping
    pairs became none on a real 36-body system, for an average move of 2.7
    pixels. Scroll to zoom, drag to pan, double-click to reframe. The
    separation never runs in true-distance mode.
    Every body is named, not just the stars, with names taking the first free
    space around their body and appearing as zooming opens more up. Bodies are
    drawn as lit spheres, with the terminator facing the star that actually
    lights them, so the day side on screen is the day side in the game. Their
    surfaces are GENERATED rather than downloaded — no texture files ship with
    the app and nothing is fetched: the class the journal reports (icy, rocky,
    metal-rich, gas giant) picks a palette and a grain, drawn with SVG noise on
    the GPU and switched on only once you zoom far enough to see a surface.
    The grain is invention and stays generic; it is not a picture of that
    particular world. Landable bodies keep a green rim.
    Tapping a body opens its card: distances, orbital period, eccentricity,
    surface temperature, atmosphere, volcanism, tidal lock, and gravity in G —
    which goes amber past 2 G and red past 3, because that is the number that
    writes off ships. Landable bodies also list their surface materials,
    richest first, with how many of each you are already carrying, since the
    app has been tracking your material grid all along. Rarity does the
    shouting rather than the percentage: iron at 21% stays grey when you hold
    300 of it, while tellurium at 1% with none held is the line that tells you
    to land. Bodies nobody has walked on are flagged "first footfall".
    Also in 1.0.4: the local wire no longer reprints itself. Two stories with
    different headlines could carry the same four faction percentages and both
    got printed, because the duplicate check compared words and what repeats
    is never the prose — it is the facts. Stories are now judged on their
    figures and proper names, the desk rotation advances by a whole edition
    instead of one desk, and the edition counter survives a restart. The wire
    also waits for the engine instead of colliding with a spoken beat, and it
    is allowed to think before it writes.

  * 1.0.3 adds the LOCAL WIRE tab: a fictional news feed for the system you
    are in, written by your own local AI from a brief of things the journal
    says are true — the faction board with real influence figures, the
    stations and signals, the markets you have read, the construction sites,
    and the doors that have refused you docking. Six desks take turns (civic,
    industry, economy, crime, sport, life) so it reads as a paper rather than
    an almanac. The economy desk is a genuine market report: what a price did
    since you last read that board, the spread between two stations in the
    system, and who is paying over the odds. It also keeps continuity — the
    teams, bars and people it invents are recorded and reused, so the dock
    league fields the same two crews next edition instead of new ones. It may
    invent people and gossip; it may not invent a faction, a station or a
    price, and a made-up name shaped like a real place is dropped unprinted.
    Configurable cadence from every 10 minutes to hourly, or Off with a
    "New edition" button. Off by default — it costs one model call per edition.
    Also in 1.0.3:
      - the operator no longer gets stuck on one subject. A visit tally was on
        EVERY beat once you settled in a system, so a hauling run produced
        "Nine times in two days?", "you still haven't found an exit sign" and
        "the view's big enough for nine visits" in one session. The tally now
        rides only on a callback beat, docking has its own angle, and a
        same-subject gate resamples a third beat in a row about one thing.
      - exobiology now sweeps the whole journal history on disk for completed
        samples. It replayed one previous session, so a genus sampled months
        ago counted as missing and the app reported more uncollected species
        than were really on the rock.
      - removed the construction-site "no large pad" warning. The game reports
        Large 0 for orbital construction sites and it is simply wrong — the
        warning fired while docked there in a large ship.
  * 1.0.2 added the SYSTEM ARCHITECT tab: dock at a colonisation construction
    site and its whole requirement becomes a shopping list, ordered by what you
    can act on rather than alphabetically. Tons already in your hold come
    first, then what this station sells, then everything on sale in the build's
    OWN system (no jump — the galaxy-wide search deliberately excludes the
    system you are standing in, which is why a crater outpost holding 371,309 t
    of steel never used to appear), then the wider galaxy. Lines are grouped by
    seller so the stop clearing the most of the build leads; each shows price,
    stock, landing pad and how old the report is, with anything over a week
    flagged as a rumour. Every market you dock at is folded in and OVERRIDES
    community data for that station, and a shelf you found empty is never
    suggested again. It counts trips against your real hold and credits
    contributions the moment you make them. The galaxy lookups are
    the same opt-in Ardent switch as the market searches; without them the tab
    still works from the markets you have visited yourself.
    Also in 1.0.2: the carrier "clear to jump" callout no longer repeats every
    five minutes, and no longer fires at all unless a jump was actually plotted.
  * 1.0.1 added the ROUTE PLOTTER tab: a neutron-highway route for the ship
    (plotted against the real jump range the game reports), and the whole
    fleet-carrier trip jump by jump — which the game will not plot at all.
    Every stop copies to the clipboard, and the next one is copied
    automatically on arrival, so a carrier run is jump-paste-jump instead of
    looking each system up by hand. Above the list sits the tritium: the burn
    for the whole trip, the depot and tonnage read from the journal, what is
    still missing and how many ship-loads that is, which stops have icy rings
    to mine it at, and a warning when the load will not fit aboard. Opt-in —
    it uses the same Spansh switch as the trade routes (Settings -> Trade
    leads -> online route search), and the plotter tab has a button to turn it
    on in place. The operator reads the same route: it calls each waypoint out
    loud and knows about a shortfall before it advises on tritium.
  * 1.0.0 was the self-contained release: the app can now install its OWN AI.
    Settings -> AI engine -> "This app (no other software needed)" fetches a
    small llama.cpp runtime (Vulkan, ~30 MB, works on AMD/Intel/NVIDIA) plus a
    Gemma vision model (~4-6 GB, picked to fit the user's graphics card). The
    download shows progress, resumes after a cancel, and the engine is started
    and stopped by the app. LM Studio still works and stays supported - pick it
    in the same dropdown - so existing users lose nothing.
    Also in 1.0: the copilot follows the whole session (events + screen) and
    reacts in context, with a tunable involvement level; exobiology sampling
    ranges and payout estimates; and four opt-in community lookups the operator
    calls only when asked (Spansh routes, galaxy-wide markets via Ardent
    Insight, the EDAstro exploration catalogue, and the Galnet news wire).
  * All three installers are 1.0.4.

    Windows:  npm run tauri build
              -> src-tauri/target/release/bundle/nsis/

    Linux:    docker build -f Dockerfile.linux --target artifacts \
                  -o type=local,dest=./linux-dist .
              -> linux-dist/  (.deb + .AppImage)

    The Docker path is the one these files were built with and needs nothing
    installed but Docker Desktop: the container brings its own Debian, Node,
    Rust and Linux Piper voices, and never touches the Windows node_modules or
    target directories. It also avoids the WSL trap below.

    Building in WSL instead works, but use a PURELY LINUX PATH — WSL's interop
    appends the Windows PATH, and linuxdeploy walks every entry and dies on
    /mnt/c/WINDOWS/... permission errors:
      export PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    Run scripts/fetch-tts.sh first if src-tauri/resources/tts-linux is missing.
    Note the AppImage comes out ~231 MB from Debian bookworm (Docker) against
    ~211 MB from Ubuntu 24.04 (WSL) — linuxdeploy bundles a slightly different
    GTK stack. Both run; only the stated size on the page needs to match.
  * When you ship a new version, copy the new setup .exe here, rename it to
    match, and update the version number + file name in index.html
    (it appears in the version strip, the download button, and step 01).
  * The fonts are SELF-HOSTED in fonts/ (Michroma + Saira, ~90 KB, OFL-1.1
    with the licence texts alongside them). They used to come from Google
    Fonts, which meant every visitor's IP reached Google before they got as
    far as the page's "no cloud, no telemetry" section — the page now makes
    no third-party request at all. Upload the fonts/ folder with the rest;
    if it is missing the page still reads, but falls back to a system sans.
