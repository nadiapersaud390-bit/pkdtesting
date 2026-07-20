# Price King Alcohol Management

Firebase-connected alcohol inventory and stock-count application.

## Active files

- `index.html` — management portal login and application entry.
- `pages/alcohol.html` — alcohol-count staff login and application entry.
- `assets/js/alcohol-management.js` — complete application logic.
- `assets/js/firebase-config.js` — Firebase project configuration.
- `assets/css/alcohol-management.css` — application styling.
- `assets/data/master-alcohol-list.csv` — built-in master alcohol catalogue.
- `assets/icons/favicon.svg` — application icon.
- `manifest.webmanifest` — web-app manifest.

Obsolete development snapshots and duplicate versioned files have been removed.

When the same product and bottle size are added to a count set again, the application increases the existing row quantity instead of creating another duplicate row. Existing duplicate rows for that product are consolidated during the update.
