ED MISSION OPERATOR — WEBSITE FOLDER
====================================

WHAT THIS IS
  A complete, self-contained website. No database, no PHP, no build step.

  index.html                              the page
  img/                                    screenshots + icons
  ED-Mission-Operator-0.3.0-setup.exe       the Windows installer (~131 MB)
  ED-Mission-Operator-0.3.0-amd64.deb       Linux beta, Ubuntu/Debian (~147 MB)
  ED-Mission-Operator-0.3.0-x86_64.AppImage Linux beta, any distro (~230 MB)

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
    index.html (search for "ED-Mission-Operator-0.3.0-setup.exe").
  * 0.3.0 adds real-time ship awareness (fuel/heat/shields/interdiction
    callouts, docking-pad announcements, fuel-scoop route warnings), loadout
    fit-checks (cargo / cabins / mining rig), engineering-material and
    exploration-value ledgers, and support for donation, scan, hack, sabotage,
    smuggling and on-foot (Odyssey) missions. The AI operator can also call
    tools to read your LIVE data (current market, ship, missions, Spansh
    routes) before answering — so it no longer sends you to buy sold-out goods
    — and large-pad ships get large-pad-only trade routes.
  * All three installers are 0.3.0. The Linux .deb + .AppImage were built in a
    Debian bookworm container (Docker) via `npm run tauri build`; rebuild them
    the same way (or on a Linux host per README "Linux") when you ship again.
  * When you ship a new version, copy the new setup .exe here, rename it to
    match, and update the version number + file name in index.html
    (it appears in the version strip, the download button, and step 01).
  * Everything else (fonts) loads from Google Fonts automatically.
