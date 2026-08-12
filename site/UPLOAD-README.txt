ED MISSION OPERATOR — WEBSITE FOLDER
====================================

WHAT THIS IS
  A complete, self-contained website. No database, no PHP, no build step.

  index.html                              the page
  img/                                    screenshots + icons
  ED-Mission-Operator-1.0.2-setup.exe       the Windows installer (~131 MB)
  ED-Mission-Operator-1.0.2-amd64.deb       Linux beta, Ubuntu/Debian (~147 MB)
  ED-Mission-Operator-1.0.2-x86_64.AppImage Linux beta, any distro (~242 MB)

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
    index.html (search for "ED-Mission-Operator-1.0.2-setup.exe").
  * 1.0.2 adds the SYSTEM ARCHITECT tab: dock at a colonisation construction
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
  * All three installers are 1.0.2.

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
  * Everything else (fonts) loads from Google Fonts automatically.
