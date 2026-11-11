# GOSTA — نظام مخزون الفروع الموحد

Branch inventory system: Google Apps Script web app, container-bound to a Google Sheet (the Sheet is the database).

```
src/Code.js      server code (Apps Script)
src/index.html   web app UI (served by doGet)
```

## Status of this baseline

The first commit is a **copy pasted from the Apps Script editor**, not a `clasp pull`.
That means it is unverified against what is actually deployed, and it is missing
`appsscript.json` (the manifest: timezone, OAuth scopes, web-app access settings).
Step 3 below closes that gap. Until it's done, treat this repo as a snapshot, not the source of truth.

## One-time setup (on your Mac)

1. Install clasp and log in:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
   Also enable the Apps Script API at https://script.google.com/home/usersettings.

2. Get the script ID: open the Google Sheet → Extensions → Apps Script →
   Project Settings (gear icon) → copy **Script ID**.

3. Verify this baseline against production (do NOT skip):
   ```bash
   git clone <this repo> gosta && cd gosta
   mkdir .verify && cd .verify
   clasp clone <SCRIPT_ID>
   ls                                   # list every file the live project really has
   diff Code.js ../src/Code.js          # file names may differ (e.g. Code.js vs code.js)
   diff index.html ../src/index.html
   ```
   - If the live project has **more files** than `Code.js` + `index.html`, copy them into `src/`.
   - Copy `appsscript.json` into `src/` — it is required.
   - Any diff means the pasted copy was not what's deployed. Use the `.verify` version.
   Then commit and delete `.verify/`.

4. Link the repo to the script:
   ```bash
   cp .clasp.json.example .clasp.json   # then paste the Script ID into it
   ```

## Working rules

- **`clasp push` overwrites the entire live project** with what's in `src/` — files missing
  locally get deleted on the server. Always `clasp pull` and check `git status` before pushing.
- Nobody edits in the online Apps Script editor anymore. If someone does, `clasp pull`
  immediately and commit, or their change will be wiped by the next push.
- Push code ≠ release. Employees use the **deployed version**; after `clasp push`, create a new
  deployment version (`clasp deploy` or Deploy → Manage deployments) and note the version in the commit.
- Never commit `.clasprc.json` (it holds your Google credentials).
