ED MISSION OPERATOR — WEBSITE FOLDER
====================================

WHAT THIS IS
  A complete, self-contained website. No database, no PHP, no build step.

  index.html                              the page
  img/                                    screenshots + icons
  fonts/                                  the two webfonts, self-hosted
  ED-Mission-Operator-1.9.0-setup.exe       the Windows installer (~132 MB)
  ED-Mission-Operator-1.9.0-amd64.deb       Linux beta, Ubuntu/Debian (~147 MB)
  ED-Mission-Operator-1.9.0-x86_64.AppImage Linux beta, any distro (~231 MB)

HOW TO PUT IT ON YOUR WEB HOTEL
  1. Open your web hotel's File Manager (or connect with FTP, e.g. FileZilla).
  2. Go into the public_html folder (sometimes called www or htdocs).
  3. Upload the CONTENTS of this folder (index.html, img folder, the .exe)
     — not the "site" folder itself, unless you want the page at /site/.
  4. Visit your domain in a browser. Done.

NOTES
  * The installer is ~132 MB. Browser-based file managers sometimes limit
    uploads (often to 100 MB) — if the .exe upload fails, use FTP instead,
    or upload it to a file service and change the download link in
    index.html (search for "ED-Mission-Operator-1.9.0-setup.exe").
  * 1.9.0 tidies SETTINGS and lets you pick the instrument's colour.

    FIVE CATEGORIES INSTEAD OF ONE LONG SCROLL. The drawer had grown to
    fifteen sections and about 3,700 pixels of column: turning the radio down
    meant scrolling past model downloads, long-term memory and trade
    thresholds to reach it. It is now AI · Audio · Feeds · HUD · Data, named
    for what you are trying to change rather than for which part of the code
    owns it. The tallest category is a third of the old height — 71% less
    scroll — and most of them fit one screen. The rail sits above the
    scrolling area, because a menu that scrolls away with the content would
    not have fixed anything.

    Two things that only showed up once it was driven in a browser: closing
    and reopening the drawer used to dump you back at the top, so it now
    remembers where you were for as long as the app is running; and the
    seventeen-row offline voice catalogue — a shelf you visit once and scroll
    past forever — is folded behind a disclosure with the count on it.

    INSTRUMENT COLOUR: AMBER, GREEN, RED OR GREY. It repaints the INSTRUMENT —
    the window edge, the header, the title, section headings, gauges, sliders,
    focus rings, the footer rule. It deliberately does NOT repaint the four
    signal colours, because on this HUD a colour is a fact: amber is money and
    the standing job, cyan a destination, green delivered, red expiry. A theme
    that recoloured those would be a theme that made the panel lie.

    Each alternative sits at lower chroma than the signal hue it stands
    nearest, which is what stops a green instrument swallowing a green
    "delivered" — dim furniture, bright readout, the arrangement every real
    cockpit already uses. Red is the night setting, and not as a gimmick: red
    is the one instrument colour that leaves your dark adaptation intact.

    Section headings used to be cyan, which spent a signal colour on a label.
    They follow the instrument now, and cyan means something again.

    New screenshot: img/hud-settings.png.

  * 1.8.0 adds the RADIO tab.

    THE DIAL, OUT OF THE SETTINGS DRAWER. Every station is one click away on
    its own tab, with the volume, the on/off and the follow-the-work toggle
    beside it. Changing the record mid-haul no longer means opening Settings
    and scrolling past the AI engine to get there.

    AN OLD-SCHOOL ANALYSER. Twenty-four segmented bars, green through amber to
    red, with white peak caps that hang where the bar last reached and then
    fall. Blocks and a falling cap say more at a glance than a smooth curve,
    which is why every hi-fi on earth drew them that way for thirty years.

    TEN MORE STATIONS, AND NOT MORE OF THE SAME. The dial went from thirteen
    to twenty-three, deliberately widening past ambient and rock: instrumental
    hip-hop and liquid trap (Fluid), vintage soul off the 45s (Seven Inch
    Soul), dark industrial (Doomed), vaporwave, IDM, and DEF CON Radio's
    music-for-hacking channel — plus four from NIGHTRIDE FM, which is the
    synthwave/darksynth/EBM end: Nightride, Darksynth, Datawave and EBSM.

    Nightride publishes metadata differently from SomaFM — one event stream
    carrying every channel rather than a JSON document per channel — so the
    player now subscribes and the track name arrives when it CHANGES instead
    of up to thirty seconds later. Every stream and every metadata endpoint
    was checked live from a real browser origin, which matters: curl sends no
    Origin header, so a host can answer curl happily and still refuse the app.

    AND IT STAYS ON SCREEN. The HUD switches its own view as the session moves
    — the orrery takes the panel on arrival, the commodities take it at a
    market — and each of those used to take the radio off the screen with it.
    So a strip sits at the bottom under every other tab: the bars, and what is
    playing. One click on it opens the full set.

    IT IS FED FROM THE BUS, NOT THE STREAM. The tap hangs off the music bus
    gain — the last point before the speakers — so when the operator cuts in
    and the radio ducks, the bars dip with it. The display explains the
    quiet instead of contradicting it.

    TUNED BY MEASUREMENT, NOT BY EYE. The first version pinned its bass bars
    at the ceiling and left the top four dead: bins are linear in frequency
    and hearing is not, and a 128 kbps stream is low-passed near 16 kHz, so
    bars fed from above that can never move. A browser harness plays real
    station bytes through the real graph and reads the canvas back, which is
    how the log spacing, the tilt and the decibel window were chosen. It also
    checks the picture CHANGES between frames — a frozen analyser and a broken
    one look identical in a screenshot.

    New screenshot: img/hud-radio.png, captured from the real UI with a real
    stream playing.

  * 1.7.0 adds the BOOZE CRUISE tab.

    THE RUN TO RACKHAM'S PEAK. The annual wine haul, tracked the way the
    construction architect tracks a build: is the party on, what a load is
    worth with YOUR ship at the prices YOU saw, how much wine is left on the
    carrier, and how many trips that is.

    THE HOLIDAY IS READ FROM THE PRICE, NEVER FROM A DATE. Wine sells at the
    peak for about 33,000 cr/t normally and north of 270,000 during the public
    holiday — a gap nothing crosses by accident. So the tab works the year the
    event moves, and a market nobody has read says "nobody has looked" rather
    than "the party is off". The panel also says how old the price is: a stale
    270,000 is exactly the number that would send somebody 5,000 ly to a party
    that already ended.

    THE LAP IS MEASURED. The ETA comes from the median gap between your own
    deliveries, not from a guide — with anything over three hours treated as a
    night's sleep rather than a lap. Credits per hour over a rolling window,
    and a tally of loads, tons and credits that survives a relog.

    IT DOES NOT PREDICT THE HOLIDAY. The community says plainly that the cruise
    is a bet, and a made-up countdown would send people across the galaxy on a
    number this app invented. It reports; it does not forecast.

    Also: the peak has no large pad, and the tab says so while you are still in
    the bubble. And a pasted Loadout now registers on the manual-import path,
    which it never did — every panel doing hold arithmetic was working without
    a hold.

    New screenshot: img/hud-booze.png. It is captured from the real UI with
    demonstration data, because the holiday runs about once a year; the caption
    on the page says so.

  * 1.6.0 puts MUSIC on the radio and widens the voice catalogue.

    THE THIRD BUS. Internet radio you can have on while you work — thirteen
    curated stations, from deep space ambient and real NASA mission audio to
    seventies album rock, frontier americana, and Galaxy News Radio. It is not
    a second player bolted on: the stream routes through the app's own audio
    graph, so it DUCKS properly — hard (-20 dB) under the operator, only
    thinned (-9 dB) under comms traffic, the way a cab radio behaves when
    someone talks over it. Stations that do not permit routing still play and
    duck by volume, using the same arithmetic.

    THE DIAL FOLLOWS THE WORK. The session arc already knows whether this is a
    mining shift or a passenger run, so the station follows: the rings get
    drone, long hauls get rock, the black gets ambient. Pick a station by hand
    and the follow switch turns itself off — a deliberate choice is not
    overruled. The current track shows on the HUD.

    OFF BY DEFAULT, AND SAID SO. This is the app's only CONTINUOUS internet
    connection; everything else is a one-shot you clicked. It ships off, the
    privacy section names it, and Settings carries SomaFM's donate link —
    they are listener-supported and advert-free, and this is exactly what
    their public channel directory is for.

    NINE MORE VOICES. The Piper catalogue goes from eight to seventeen (Alan,
    Aru, HFC female/male, Bryce, John, Norman, Kristin, Kusal). Every one is
    also new PEOPLE on the comms: the cast multiplies each voice by timbre
    shifts, so a busy channel finally sounds like a crowd.

    TALK, NOT TELEGRAPHY. The comms prompt had accumulated a stack of
    compression rules until every line came out as coded command-fragments.
    They are replaced by a conversation contract — complete sentences, real
    questions and answers, explaining as half of what radio is for, and a
    testable bar: a stranger overhearing should be able to follow it.

  * 1.5.0 overhauled the COMMS WRITING and added a second model.

    RADIO THAT SOUNDS LIKE PEOPLE. A week of live sessions and simulated
    batteries taught one law: a small model imitates what is vivid in front
    of it far more than it obeys instructions. Everything quotable was
    removed from the prompt (worked examples were surfacing verbatim in
    scenes), trouble now comes from people rather than equipment (no more
    beacons "flickering" for drama — a beacon is just the navigation stop,
    and the data says so), tonnage figures never reach the air (a build
    order is a shopping list, not a crisis), names shrink with familiarity
    the way regulars actually talk, and the parser strips narration the
    model occasionally dresses its radio in. The writer's rolling transcript
    resets once on upgrade (v3) to shed habits learned under the old prompt.

    234 SITUATIONS x 25 MOMENTS. The situation table tripled (petty
    bureaucracy, personality clashes, overheard history, fatigue, small
    victories, mistakes), and every scene now also carries a MOMENT — routine
    and efficient, quietly suspicious, unexpectedly warm, slightly absurd —
    an axis independent of the subject. The register/moment pairing does not
    repeat for 3,575 consecutive scenes.

    A SECOND MODEL, EARNED. Gemma 4 12B QAT joins the catalogue as the
    quality tier: the best scene discipline of five candidates tested
    (comms 10/10, tools clean), at about twice E4B's time per line — a pace
    the scene scheduling absorbs. Vision included; the fast-generation
    helper engages on the graphics card (measured slower on CPU, so it
    stays off there). Four other models failed the same bench that week:
    a Qwen fine-tune (retired after one day), the official Qwen3.5-9B, a
    Llama MoE (called a tool when told "hello"), all measured, all declined.
    E4B remains the default and the speed pick.

    Also: comms timeouts no longer paint a red "last error" that outlives
    the problem — errors clear on the next successful scene.

  * 1.4.0 added THE CAMPAIGN — the story that follows you between systems —
    and rewrote the feature section of the page into bullet points.

    THE CAMPAIGN SPINE. Everything narrative used to reset at the jump: the
    dossier and cast are per-system, the session arc per-session. Now a small
    persistent campaign travels with you: a PURSUER (the faction working
    against you) and a PATRON (the one you keep helping), both ELECTED from
    journal evidence — interdictions, crimes, failed and completed contracts,
    reputation — never invented, with decay and hysteresis so threads neither
    flap nor last for ever. Each carries a six-segment threat clock that ticks
    on real events; a filled clock comes to a head in all three voices. A
    standing VOW is derived from what you actually fly. All of it is computed
    in code from the journal — the AI voices read it, they never write it.

    THREE VOICES, ONE BOUNDARY. The comms traffic gossips about the threads
    (it may invent), the local wire covers the gossip AS gossip, and the
    operator only ever states what really happened — anything fictional it
    passes on is attributed as "heard on comms", which is factually true.

    ORACLE COMMANDS. Type or speak "reveal a detail", "advance a threat"
    (moves the dominant clock one segment — never the last, payoffs come from
    real events only), or "flashback" (retells a real chronicle episode).

    ON THE HUD. A compact strip under the ship status: pursuer and patron
    with clock pips, and the current vow. "Reset campaign" lives in Settings.

    THE PAGE. The feature manifest was prose walls; it is bullet points now.
    New comms screenshot (img/hud-comms.png) in the gallery; architect, news
    and settings screenshots refreshed from 1.4.0.

  * 1.3.0 let the AI run on the PROCESSOR, made the wire and the traffic
    far more reliable — and REMOVED LM STUDIO SUPPORT.

    ONE ENGINE. The app's own bundled llama.cpp is now the only engine.
    Supporting two meant every model quirk existed twice: vision detection had
    two code paths with two failure modes, the capability map came from LM
    Studio's private API and silently did not exist on the bundled engine, and
    connection errors blamed LM Studio for faults in our own engine. GGUF
    model+projector pairs already on disk (from LM Studio or anywhere else)
    are still discovered and reused in place — only the second server is gone.

    ON THE PROCESSOR. The graphics card is what the game needs, so the AI can
    now be moved off it — Settings -> AI engine -> "Run the AI on". On a strong
    CPU this is not a sacrifice: measured on a Ryzen 7 9800X3D against an RX
    7800 XT, prompt reading went 2.7x faster, answers came 41% quicker, and
    3.6 GB of graphics memory went back to Elite. The card stays the default,
    because on an ordinary processor it is still the faster place.

    FASTER GENERATION. Gemma models now fetch a ~99 MB multi-token prediction
    helper that drafts several tokens per pass and verifies them together:
    generation 8 -> 15 tokens a second, a radio exchange 2.5 s -> 2.0 s, for
    about 200 MB. Output is identical; only the speed changes. Existing
    installs pick it up on the next engine start — no re-download.

    TWO MORE MODELS. Qwen 3.5 4B for anyone running on the processor — half the
    weight of the others, still sees the screen, and the quickest of everything
    tested on a CPU — and Llama 3.1 8B for a livelier voice. Vision is now OPTIONAL, which is what let a text-only model
    in at all; the copilot reads the journal with or without a screenshot, and
    only the opt-in screen glance is lost. The app tunes itself per family —
    reasoning, tool use, screen reading, repetition — from measurements.

    THE WIRE FILES DIFFERENTLY. One story at a time, as prose, instead of the
    whole edition as JSON. That was the paper's most fragile part: a model whose
    punctuation slipped lost the entire edition however well it wrote. A bad
    story now costs that story, not the paper.

    TRAFFIC THAT KEEPS TALKING. Several faults could each silence the comms
    channel for a whole session — a writer that never handed itself back, a
    repetition filter that could never learn because learning required speaking,
    and a writer that declined to start whenever the operator was busy. All
    three are fixed, and the Comms panel now reports exactly why anything was
    dropped rather than just how many.

    LESS REPETITION EVERYWHERE. Every briefing the app builds capped its lists
    and always took the first few, so a system with six factions showed the same
    four for ever and the model saw identical input every time. The lists now
    rotate, so everything gets its turn, and the tone each piece is pitched in
    rotates too.

  * 1.2.0 fixed COMMS and changed what it promises.

    THE FIX: on the bundled engine comms produced nothing at all. The writer
    capped each request at 220 tokens, which is generous for two lines of radio
    and far short of what a reasoning model spends THINKING before it writes —
    so every request was cut off mid-thought, came back with an empty answer,
    and was scored as unparseable. Measured on a live install: 49 attempts, 49
    drops, 0 transmissions. Reasoning is now switched off for this path (the
    operator still reasons, where it earns its keep) and the ceiling raised for
    the models that cannot switch it off. Same scene, same prompt: 4.1 s and 449
    tokens before, 0.34 s and 15 after, and it actually reaches the air.

    THE CHANGE: comms is no longer fact-checked, and this reverses what 1.1.0
    said below. The fence that kept every scene inside a list of licensed names
    was discarding roughly nine scenes in ten to catch inventions that were
    never doing any harm — nothing downstream reads comms and it never addresses
    you. Instead the AI is handed a real briefing on the system (the faction
    board with influence figures, the stations, the signals the FSS found, how
    far out the nearest port is, whether you are docked) and allowed to invent
    freely on top of it. Grounding by material rather than by rule. THE
    OPERATOR, THE WIRE AND THE COPILOT ARE STILL FACT-CHECKED — those speak to
    you and you act on them. Treat the traffic as atmosphere, not intelligence.
    The per-transmission source chips are gone with the fence; the Comms tab now
    reports how many scenes reached the air, how many dropped, and why.

    Also in 1.2.0: the tab-switching described under 1.0.4 ("the HUD now
    switches tabs with the game") was written up but never actually implemented.
    It works now, and has a toggle in Settings -> HUD.

  * 1.1.0 added COMMS TRAFFIC and THE RADIO. NOTE: the fact-checking described
    in this entry was removed in 1.2.0 — see above.

    COMMS TRAFFIC is other people on other channels — traffic control working a
    queue, hauliers on the open channel, a fleet carrier broadcasting at
    everyone, your own crew on the intercom. Mostly they do not care that you
    exist, which is what makes the ones who do land. A transmission is a SCENE,
    not a line: a call and a response, because two voices imply two people who
    exist whether or not you are listening.

    Everything it states is TRUE. Every scene is built from a brief — the exact
    names and figures it may use, each tagged with where it came from. A
    haulier grumbling that they have "taken another 380 off Bertrandite at
    Hurston Ring" is quoting your own market memory: a price you actually saw,
    at a station you actually docked at. Anything the AI writes is checked back
    against that brief BEFORE it is spoken, and a scene that reached for a
    faction, a station or a number nobody licensed is thrown away whole. So the
    chatter doubles as intelligence, and silence is always the safe failure.
    Old prices are spoken as old ("last I looked, three days back"), and
    anything past a week is not mentioned at all.

    Range is real. Station traffic is gated on the actual distance to the port,
    taken from the orrery, and fades in as you close — so a distant station
    sounds distant, and a port the app cannot place stays silent rather than
    being invented. Deep space is not a distance threshold; it is what is left
    when nobody is in reach.

    Voices come back. A callsign heard in a system is remembered, keeps the
    same voice, and turns up again next time you are there. Ships you ACTUALLY
    hear on the game's comms can be enrolled into that cast, so the fiction has
    a spine of things that genuinely happened. Threads run across sessions:
    something set up gets complicated, and eventually turns.

    It knows when to shut up. Chatter thins as pressure rises — the opposite of
    what the operator does — and in a firefight or a hull emergency every
    ambient channel goes silent. The sudden absence of noise you had stopped
    noticing is the cheapest tension in the app and costs nothing to generate.
    The operator keeps talking through all of it; that contrast is the point.

    The Comms tab lists every channel, its signal strength, and when one is
    shut, WHY. Every transmission is logged with its speakers, so the whole
    feature works with the sound off, and anything carrying reported
    intelligence is marked with its sources one tap away. The template file is
    plain text and yours to extend — declare your own ship names and lines and
    they join the rotation. OFF BY DEFAULT: enable it in Settings.

    THE RADIO applies to every spoken word, not just the traffic — the
    operator, the wire and the saga too. A bandpass into the telephone band, a
    little soft-clip saturation, a noise bed that opens and closes with the
    transmission, the odd crackle, a squelch gap before speech and a roger beep
    after it. Distance degrades it. Underneath there are two buses: the
    operator is on priority, ambient traffic ducks about 14 dB underneath it
    and DROPS rather than queues when it backs up, so a dock worker's joke can
    never come between you and a hull-breach callout. Piper voices only —
    Windows' own speech engine gives no access to its output, so with system
    voices the radio character is skipped.

    (A Comms screenshot was added to the gallery in 1.4.0: img/hud-comms.png.)

  * 1.0.4 adds the ORRERY tab: the system map, at the size of a HUD. Every
    Scan the game writes carries the body's whole orbit — semi-major axis,
    eccentricity, inclination, periapsis, ascending node, mean anomaly and
    period — so the tab is arithmetic rather than a picture: it places each
    body where it actually is at this instant, and a warp control runs the
    clock forward to show where it will be. Nothing is simulated and nothing
    drifts, because every frame solves the same equations at a different time.
    Stars, planets, barycentres, and belt clusters drawn as the bands they
    are; the body you are on is ringed; tap anything for its distance, its
    orbital period and its eccentricity. Planet distances are TO SCALE — a
    1,900 ls leg draws at half a 4,000 ls cluster, the proportion you fly —
    and only moons are spread, which is the only way one 1 ls out stays
    visible. The map opens following your ship, a little zoomed in. The card
    always says which mode it is in, with a switch to exact distances. It draws only what you have scanned: no third-party database,
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
    Docks are marked too — stations, outposts, settlements and construction
    depots, beside the body they belong to. They are not bodies and never get
    scanned, so a surface port uses the world the journal names and an orbital
    one is matched by distance from the arrival star (both report it, and they
    agree to a fraction of a light-second). Unmatched docks are left undrawn
    rather than parked beside the wrong planet; fleet carriers are skipped
    entirely, since they jump and this table is saved.
    The ship is also drawn PARKED — docked or dropped at a station, a filled
    cyan chevron marks the exact dock, with "You are at ..." under the map.
    Flying toward a station you have never visited, the card says the
    destination is not mapped yet instead of showing nothing. The history
    sweep now collects every dock you ever visited too, so stations from old
    sessions appear at boot, with their names labelled once you zoom in.
    The HUD now switches tabs with the game (toggleable in Settings): opening
    a market while a colonisation build is on the books shows the architect's
    shopping list, undocking brings back the system map — no clicking the HUD
    mid-flight.
    A RECENTER chip snaps the camera to your ship — parked or mid-leg — and
    keeps following it; while following, zoom anchors on the ship so you can
    wheel in and out without losing it. In supercruise the zoom is DYNAMIC:
    wide at departure, tightening as you close on the destination, easing
    back out when the target leaves the map. Touch the wheel and it is
    yours; a new leg re-arms it. Dragging the map or double-clicking
    lets go, and the chip flips back to RECENTER, one tap from resuming.
    Your ship shows on the map as the LEG you are flying — from where you
    dropped to supercruise toward whatever you have targeted — with progress
    drawn as a band rather than a dot. Elite reports no in-system position at
    all (the status file has flags, fuel, cargo and the nav target, nothing
    else), so a precise marker would be invented. The band's width comes from
    real measurement: across this commander's journals the same 4,697 ls run
    took 137, 162 and 304 seconds on different days, and a 0.8 ls hop took as
    long as either. It slides as you fly and is replaced by fact on arrival.
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
  * All three installers are 1.9.0.

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
