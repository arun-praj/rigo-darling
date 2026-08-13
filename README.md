# RigoHR Attendance Assistant

Local, headed, scheduled assistant for the RigoHR employee dashboard. Requires Node.js 22.5 or newer for the built-in `node:sqlite` database driver.

## Safety behavior

- It only allows `app.rigohr.com/hr`, `/hr/clock/in`, `/hr/employee`, and the RigoHR login origin.
- Clock In/Clock Out actions are scheduled automatically. A pre-action email is sent approximately 15 minutes before the planned punch, and the local UI provides a cancellation control until execution.
- It verifies the current date's attendance row after clicking.
- Punch-out is blocked until at least 9 hours after the observed punch-in.
- Credentials are loaded from `.env`, never printed, and never committed.
- Failure evidence is not captured while a login/password field is present.
- Run logs can be expanded in the UI to view labeled pre-login, clock-gate, dashboard, and post-action screenshots when available.
- Verified, failed, and safety-blocked punch-in/punch-out runs send an SMTP notification when SMTP is configured and a recipient is saved in the UI. The mailer never falls back to the RigoHR username or SMTP login address.
- Notification delivery failures are logged separately and never change a verified attendance result to failed.
- SQLite stores the application configuration, weekly schedules, date overrides, recipients, scheduled actions, daily punch records, random seeds, and structured logs in `data/rigohr.sqlite`.
- Screenshots use Cloudflare R2 when `R2_ENDPOINT`, `R2_BUCKET` (or `R2_BUCKET_NAME`), `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` are configured. They are stored under the virtual folder prefix in `R2_PREFIX` (default: `rigohr-attendance`). The database stores the evidence object keys; local development falls back to `data/evidence/` only when no R2 settings are present.

## Run

```sh
npm install
npm run dev
```

`npm run dev` uses `tsx watch`, so the server automatically restarts when TypeScript source files change. Open [http://localhost:4317](http://localhost:4317). The browser opens in headed mode with a persistent local profile at `.browser-profile/`. The first run uses the values in `.env`; later runs reuse the browser session when available.

Use `npm run dev:once` when you want a single non-watching server process.

Copy `.env.example` when setting up another machine. Keep `.env` local. The first SQLite startup imports the existing `data/state.json` once; the JSON file is retained as a recoverable migration source.

## Authentication

The application shell and all application APIs require an authenticated session. The public `/login` page is the only sign-in route; there is no public registration route. Sessions are stored as one-year, HttpOnly cookies and remain active until expiry or until the user selects **Logout**.

On a fresh database, the first administrator is seeded from `RIGO_ADMIN_USERNAME` and `RIGO_ADMIN_PASSWORD` in the local `.env`. Only an administrator can create additional users from the **Admin user management** section. Passwords are stored as salted scrypt hashes, and are never written to logs or returned by the API.

## Default schedule

- Monday, Tuesday, Friday: Morning, 09:30–10:45 punch-in eligibility and 19:00–20:00 punch-out eligibility.
- Wednesday, Thursday: Evening, 12:30–13:45 punch-in eligibility and 22:00–23:00 punch-out eligibility.
- Saturday and Sunday: disabled.
- Minimum duration: 9 hours. Maximum duration: 10 hours.

Use the weekly table for recurring changes and Date override for one-off changes. The dashboard's **Check eligibility** button evaluates the schedule and records a dry-run log without clicking RigoHR. Automatic actions are only armed inside the 15-minute pre-punch window, and punch-out still requires a verified punch-in plus at least nine hours elapsed.

## Validation

```sh
npm run check
```

This runs the TypeScript build and unit tests. No live punch is performed by the test suite.
