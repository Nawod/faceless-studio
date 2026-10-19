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
