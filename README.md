# Faceless Studio

An autonomous faceless YouTube Shorts channel. Every day it:

1. **Finds a topic.** It pulls trend signals for the US and UK (Google Trends, Wikipedia top pages, Reddit, and YouTube trending if you add a key), and Claude picks one that fits your niche. Anything similar to a video from the last **90 days** is rejected, both by Claude and by a local similarity check.
2. **Researches and writes.** Claude (on your **Claude subscription**, through the Claude Code CLI in headless mode) verifies facts with web search and writes a 61–85 s script. The script opens on a hook, builds through escalating reveals, ends on a payoff that loops back to the start, and lists its sources.
3. **Picks the best style** for the topic (never the same one 3 days running):

   | Style | Look | Good for |
   |---|---|---|
   | `kinetic` | Apple-keynote motion graphics: huge type, springs, stat rings, 3D emoji orbits, exploding 3D models | tech, money, companies, lists |
   | `collage` | Ali Abdaal-style halftone paper collage: ransom letters, tape, flat colour | psychology, history, ideas |
   | `crayon` | Children's picture book drawn live in wax crayon, with boiling lines and hatching | animals, nature, origins, simple science |
   | `documentary` | Full-screen stock footage with push-ins, whip cuts and huge pop captions | wildlife, places, mysteries |
   | `blueprint3d` | Engineering blueprint: rotating 3D wireframes that explode into labelled parts | inventions, machines, space |
   | `mascot` | The channel's cartoon Earth hosts: lip-synced, eyes track the cards, expressions per scene, sunburst backgrounds, glitch cuts | weird everyday facts, body, light science |
   | `globe3d` | Real 3D Earth (Three.js): camera flies to places, pulsing pins, great-circle arcs, atmosphere glow | geography, migrations, "the only place where…" |
   | `newsflash` | News-explainer: graded footage, red EXPLAINED tags, lower-thirds, fact panels, press quotes, huge key words | new discoveries, studies, missions |

   Every video carries the **Earth Has Bugs** watermark (with a small glitch flicker) and ends on a branded end card (wordmark + @EarthHasBugs). The logos are in `assets/brand/`; replace those files to change them.

4. **Voices it.** Free Microsoft Edge neural voices (US and UK, rotated daily) with word-level timings, or Google Cloud TTS.
5. **Scores it.** The music bed and SFX are synthesized for each video, so there are no Content ID claims. The mix ducks the music under the voice and normalizes to −14 LUFS.
6. **Renders 1080×1920 at 30 fps.** Every frame is a pure function of time, rendered by headless Chrome.
7. **Runs QA.** Claude looks at one still per scene and patches broken scenes before the final render.
8. **Uploads and schedules.** It uploads to YouTube with `publishAt` (default 18:00 UTC, which is 7 pm UK and 2 pm New York) and the AI-disclosure flag set.

There's a dashboard at **http://localhost:3020** with run history, video previews, QA sheets, logs, settings and a "Make a video now" button.

## Setup (once)

```bash
cd faceless-studio
npm install
npm run fonts                       # downloads the OFL fonts the engines use
python -m pip install -U edge-tts numpy scipy
copy .env.example .env              # then fill it in (below)
npm run doctor                      # checks everything
npm start                           # dashboard → http://localhost:3020
```

**.env**

| Key | Where to get it |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` in a terminal (it uses your Claude subscription). The CLI that ships with the desktop app works: `"%APPDATA%\Claude\claude-code\<version>\<id>\claude.exe" setup-token` |
| `PEXELS_API_KEY` | Free at https://www.pexels.com/api/ (needed for the documentary and collage styles) |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | Google Cloud console → enable **YouTube Data API v3** → OAuth client of type **Desktop app**. The client from `sparky_curiosity_bot` works too. |
| `YOUTUBE_API_KEY` (optional) | Same project → API key, used for YouTube trending discovery |

Then open the dashboard and click **Connect YouTube**. Pick the channel (Brand Accounts are listed) and approve.

**Run it daily without you.** In PowerShell from the project folder, run:

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

This registers two tasks: a daily run at `runAtLocal` (06:30 by default) that can wake the PC and catches up if it was off, and the dashboard at logon. The dashboard also has a built-in scheduler. Both share a lock, so a day never gets two videos.

## Important before you rely on it

- **YouTube API audit.** Videos uploaded from a Google Cloud project that hasn't been audited are **locked to private**. Apply for the audit via the YouTube API Services form, which usually takes a few weeks. Until then, publish each scheduled video by hand in YouTube Studio.
- **Monetization.** The YouTube Partner Program does not monetize "inauthentic" (mass-produced or repetitive) content. This app fights that with five distinct styles, researched scripts with cited sources, no reused footage within 90 days, unique music, rotating voices and the AI-disclosure flag. Still, look over the first week of videos, keep the niche tight, and consider recording your own voice for some videos later. Monetization isn't guaranteed; YouTube reviews channels by hand.
- **Claude usage** counts against your subscription's limits: about one Opus planning call with web search plus one Sonnet QA call per day.
- **Not used:** onetake (its licence is non-commercial only). The engines borrow ideas, not code, from Lemo-Opuscar (crayon-book grammar, MIT) and the awesome-opus-5.5 case studies (pure-function-of-time rendering, stills before the full render).

## Hosting on Render (free tier)

The free tier (512 MB RAM, 0.1 CPU, sleeps after 15 minutes idle, no cron) **can't render video**. Headless Chrome plus ffmpeg needs about 2 GB and real CPU. Keep the worker on this PC. Render would only make sense for a read-only status page, so it isn't set up. For true 24/7 operation, use a ~$20–40/month VPS (4 vCPU / 8 GB) with this same code.

## Daily quota and publish slots

`config/channel.json → schedule` (also editable in the dashboard settings):

- `runAtLocal` (06:30): when the day's production starts.
- `videosPerDay` (3): the app keeps making videos one after another until today's quota is met. It retries failures (up to 3 extra attempts a day) and makes a replacement when QA holds one back.
- `publishSlotsUTC` (13:00, 18:00, 22:00 UTC, which is 9am / 2pm / 6pm New York and 2pm / 7pm / 11pm UK): each upload takes the next free slot, so videos never pile onto one time.

The quota runs by itself while the dashboard is open (`npm start`), or from Windows Task Scheduler (`scripts/install-task.ps1`) even if the dashboard is closed.

## Visual relevance checks

Every plan names its **subject** (with a stock-photo search and a drawing), and every scene has a photo search for what it shows. A validator sends plans back to Claude when scenes don't picture their narration, when crayon has too few drawings, or when drawings are too simple. Claude's QA then reviews a still of every scene for relevance and layout and fixes failing scenes, for up to 2 rounds. A video still scoring below 5/10 is **held**, not uploaded, and the quota makes a replacement.

Tools: `node src/tools/fix-visuals.js <runId>` re-plans and re-renders an existing run's visuals. `node src/tools/respread.js [--apply]` spreads already-scheduled uploads across free slots.

## If a run stops halfway

Every stage is saved as it finishes. If the app or PC stops mid-run, the dashboard marks that run **interrupted** the next time it starts:

- **Resume** continues from the last finished stage, keeping the topic, script, voice and footage.
- **Start over** redoes everything for that run, with a new topic.
- **Cancel** (on the live progress panel) stops a run at the next safe point; you can resume it later.

If today's scheduled run was interrupted, the scheduler resumes it automatically (at most twice). A run counts as alive only while it keeps refreshing its lock every 20 s, so a crashed process can never block new runs for long.

## Commands

| | |
|---|---|
| `npm start` | dashboard + scheduler |
| `npm run daily` | make today's video now and upload it |
| `npm run make` | make a video without uploading |
| `node src/daily.js --style crayon --force` | force a style or an extra video |
| `node src/daily.js --resume <runId>` | resume a failed run from its last stage |
| `node src/daily.js --plan my-plan.json --no-upload` | render your own script |
| `node src/preview.js <style>` + `node src/tools/stills.js …` | preview engines without Claude or TTS |

Runs live in `data/runs/<id>/` (plan, voice, stills, QA sheet, `final.mp4`).

## Facebook Page (Reels)

Every video can also be scheduled as a **Reel** on your Facebook Page, in the same publish slot as YouTube. Facebook allows 3–90 s per Reel (longer videos go to YouTube only). Uploads use the Graph API Reels endpoint (`start` → upload → `finish` with `video_state=SCHEDULED`), and every Reel is labelled AI-generated.

One-time setup (you can reuse the Meta app you made for Silver Health Guide):
1. Go to https://developers.facebook.com → **My Apps**. Open your existing app, or **Create app** with the use case **"Manage everything on your Page"**.
2. In **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**, add `http://localhost:3020/fb/callback`.
3. Put the app's ID and secret in `.env` as `FB_APP_ID=` and `FB_APP_SECRET=`, then restart the dashboard.
4. In the dashboard's **Facebook Page** card, click **Connect Facebook Page**, log in, and tick the Earth Has Bugs Page. The app keeps a Page token that doesn't expire.

Backup option: paste a Page access token from the Graph API Explorer under "Or paste a Page access token".
Turn Facebook off with the card's checkbox. Videos already on YouTube get a **Schedule on Facebook** button in the Runs list.

## Queue and topic pool

- **Queue:** type a topic (optionally an angle and a style) to have it made next. Queued topics are made first, in order. You can reorder them, make one now, or remove them. A failed item goes back into the queue once, then stays marked "failed" with a Retry button.
- **Topic pool:** Claude researches about 20 checked ideas in one cheap Sonnet call, using today's US/UK trend signals plus evergreen formats. Each automatic video takes the best fresh idea, rotating categories. The pool refills itself in the background when fewer than `topics.bankMin` ideas remain. You can also click **Research 20 more ideas**, add your own, queue one, or reject one.
- Nothing too close to a video from the last 90 days gets in, and the same topic can't be queued twice.
- **Savings:** the trend scan and topic hunt now run once per 20 videos instead of once per video. In director mode the planner writes only the script and a one-line note per beat on what we see; template visuals are made only if a film falls back to the templates.

## TikTok (drafts)

Each finished video is sent to your **TikTok inbox as a draft**. TikTok notifies you; open the notification, paste the caption (the video's panel in the dashboard has a **Copy caption** button), turn on **AI-generated content**, and post, ideally at the same time as YouTube. Every finished video without a draft also gets its own **Send to TikTok drafts** button.
Why drafts: TikTok only allows fully automatic posting after it audits the app, and until then everything posted is private. Drafts need no audit. The drafts API also takes no caption, which is why you paste it.

One-time setup:
1. Go to https://developers.tiktok.com → **Manage apps → Connect an app**. Choose the **Desktop** platform, because TikTok's web platform doesn't accept `localhost` redirect addresses.
2. Add the products **Login Kit** and **Content Posting API**. Under Content Posting API, turn on **Upload** (you don't need Direct Post). Request the scopes `user.info.basic` and `video.upload`.
3. In Login Kit, add the redirect URI `http://localhost:3020/tt/callback`.
4. Put the **Client key** and **Client secret** in `.env` as `TIKTOK_CLIENT_KEY=` and `TIKTOK_CLIENT_SECRET=`, then restart the dashboard.
5. In the dashboard's **TikTok** card, click **Connect TikTok** and log in. The connection lasts about a year and refreshes itself.

While your TikTok app is in **sandbox** (not yet reviewed), only the accounts added as sandbox target users can connect: add your account there. To use it with a live app, submit the app for review with the Upload scope (drafts don't need the Direct Post audit).
