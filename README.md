# Rebuild & Build: two-year training plans

Standalone static site hosted with Vercel. One page, three plans (switch in Settings):

- **Back-safe**: Calm → Restart → Rebuild, then six 16-week cycles of Strength base, Hypertrophy and Athletic power. Daily back and leg check-ins drive green/amber/red guidance, a back- and side-extension ladder rebuilds the strained muscles, and barbell back squats, barbell RDLs and running sprints unlock only after the barbell gate on the Back care tab (the first 6 barbell sessions are always a gentle intro). No deadlifts.
- **Build (2-year)**: the same two-year structure for any healthy adult, without the back-care work: a Start phase to learn the lifts, a 6-week Foundation, then the same six cycles built on the back squat, bench press, RDL from the rack, overhead press and pull-ups, with sprints, jumps, bounds, throws and a progressive core plan. Five main days plus an optional sixth. No deadlifts.
- **Build + Neck care**: the Build plan for people with long-lasting neck pain. Adds a daily 10-minute Neck Care routine (chin tucks, range of motion, upper-back mobility, stretches), a daily neck check-in that drives green/amber/red guidance, a six-step neck strength ladder, a neck setup cue on every lift that can load the neck, and automatic amber-day swaps (machines instead of a bar on the shoulders, supported pressing instead of the barbell overhead press, no hanging, sprints or jumps).

All plans rotate accessories and progress core and athletic work from cycle to cycle, deload in the last week of every block, and re-test benchmarks at the end of each cycle.

Workout progress, notes, and profile settings are saved in the current browser using local storage, with a separate log for each plan. By default nothing leaves the device. If you turn on **Sync across devices** in Settings, the page makes a random 20-character sync code and stores the log in the site’s Redis database under a hash of that code, with no name, email or account. Open the sync link (or enter the code) on another device to use the same log there; logs are merged day by day and the most recently edited version of each day is kept. Anyone with the code or link can see and change that log, so share it only with your own devices. The page loads its typefaces from Google Fonts.

## Sync setup

Sync runs through one serverless function, `api/sync.js`, with no build step and no dependencies.

1. In the Vercel project, add the Upstash Redis integration (Storage → Upstash → Redis). It provides either `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL` and `KV_REST_API_TOKEN`; either pair works.
2. Redeploy. Until both variables are set, the page keeps working and saves on the device only; Settings shows sync as paused.

Local testing: `node tools/dev-server.js` (optional port, default 8765) serves the page and the sync function. Without Upstash variables it uses an in-memory store that is cleared when the server stops. `http://localhost:8765` and `http://127.0.0.1:8765` keep separate browser storage, so they work as two devices.

General guidance only, not medical advice.
