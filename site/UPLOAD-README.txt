ED MISSION OPERATOR — WEBSITE FOLDER
====================================

WHAT THIS IS
  A complete, self-contained website. No database, no PHP, no build step.

  index.html                              the page
  img/                                    screenshots + icons
  ED-Mission-Operator-0.2.0-setup.exe       the Windows installer (~131 MB)
  ED-Mission-Operator-0.2.0-amd64.deb       Linux beta, Ubuntu/Debian (~147 MB)
  ED-Mission-Operator-0.2.0-x86_64.AppImage Linux beta, any distro (~212 MB)

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
    index.html (search for "ED-Mission-Operator-0.2.0-setup.exe").
  * 0.2.0 adds the operator's long-term memory + optional screen glances
    (two new screenshots in img/: hud-memory.png, hud-memory-settings.png —
    remember to upload those too).
  * When you ship a new version, copy the new setup .exe here, rename it to
    match, and update the version number + file name in index.html
    (it appears in 2 places: the download button and step 01).
  * Everything else (fonts) loads from Google Fonts automatically.
