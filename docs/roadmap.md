# Roadmap

Last updated 2026-11-23. Update this file when something here changes.

## Built

Version 1 of the spec is complete: all three "evenings".

- `probe`, and `cut` with the `center`, `blur` and `facecam` layouts; the facecam's webcam panel takes the webcam's shape (any shape, or 16:9, 4:3, 1:1), and its content is a box of its own
- Transcription, word-timed captions, hook line; captions that keep time with a streamer shouting over game sound (2026-11-22)
- `render` to rebuild a clip after editing its transcript
- Briefs: validation, `post.txt`, the rule checks, on-screen disclosure, end card, `check`
- Beyond the spec: `--trim`, `--crop-width` (a wider crop over a blurred copy), `keepFullFrame`, `replacements`, the `work/` subfolder, a hook time setting, clip folders named after the hook, deleting clips and videos from the dashboard, and plain parts (`extract`)
- A dashboard in the browser (`npm run dashboard`): cut with a visual range and crop, view clips with their checks and post text, fix caption words
- Two more dashboard pages: a card maker (goal, red card and full-time cards, saved per match, exported as PNG in two sizes) and a compilation builder (videos and cards in order, credits, one final video with a description file)
- A redesigned dashboard on a five-colour palette that can be swapped (`web/src/theme.js`), with a palette chooser, keys for the player, and the cut button always in view
- Sounds under the cards of a compilation, each card shown as long as its sound: a computer voice saying "Goool", a tragic chord and a soft whistle made by the tool, or the owner's own files from `sounds/`
- An intro card for a match: both clubs with their icons and names and "V" or the score, with the owner's intro sound under it
- A video behind a card: a video file in `sounds/` gives the card its sound and a moving background
- A second video beside a reaction in a compilation: split screen while it runs, then the reaction full screen
- A Combine page: two videos side by side with a live preview to line them up by eye, a side, a start and a shown part for each, a main video that takes the whole screen at the end, and the result offered to compilations
- A list of leagues and clubs (name, colour, logo) to fill a match's teams from, starting with La Liga and the Premier League as of 2026–27, a "Europe" league of leading Italian, French, German and Portuguese clubs, and the 36 clubs of the 2026–27 Champions League
- The club a streamer supports, chosen from the owner's clubs, saved as it is chosen and shown as a logo on the row
- Backups: a copy of the channels list and of the clubs list is kept before every change (`data/backups/`)
- My data: one file to download with what the owner chose to carry (channels with clubs, pictures and counts, leagues and clubs with logos, sounds, briefs, overlay images), and a two-step load on another machine that never deletes
- Sync with GitHub: the same data kept the same on every computer by itself, through a private repository of the owner's; connected on the first machine on 2026-11-23
- Who is live: channels in the list that are broadcasting are marked LIVE, listed first and counted in the side column
- A Stop button for anything waiting or running, in "Activity"
- A sources list and `fetch`: part of a YouTube video or a whole one, each up to 3 hours (parts were capped at 20 minutes until 2026-11-21), from a channel in the list (the owner adds a channel only once it has agreed)
- Fast fetching: 20 minutes in about 16 s instead of 11 minutes, and a whole video of about 1.5 hours in about 20 s, through a relay that asks YouTube for slices (`src/rangeRelay.js`)
- A Download page for `fetch`: paste a link and a range or tick "Whole video", with the checks shown while typing, progress, Stop, "Open it to cut", and the reason shown when a fetch had to go the slow way (the form used to be on the Sources page)
- Channel pictures: the profile picture of each channel in the list, fetched on request and drawn beside its name where it is credited in a compilation; a sync button on a row fills a new channel's name and picture from its address, and each row shows the channel's subscriber count from the last lookup
- Clips from a stream's chat on the Download page: a finished live stream's link, optional words and a number; the best moments, from where chat reacted (laughing, W, L, "clip it"; not commands, polls or pasted messages) and where viewers pointed in the comments, are downloaded as parts
- Suggested moments from the transcript, the chat of a finished stream, or both merged: event terms (with Football and Gaming presets) and guidance that steer both, a chart of the chat, edits, filters, and an optional AI check of chat moments
- Blur boxes: a part of the frame blurred or blacked out for some seconds, drawn on the cutting screen or with `--blur`
- A logo overlay for the whole clip: a logo in a corner or a full-frame picture, chosen on the cutting screen, with `--overlay`, or set by a brief (checked)
- Hook suggestions: "Suggest" beside the hook box proposes three hooks for the clip being set up
- AI help, optional, through Claude Code's command line (no key) or OpenAI (with a key): `suggest` and "Suggest moments" propose ranges with a hook, title and description; "Suggest fixes" proposes caption word corrections

547 tests pass on the first development machine (Linux, ffmpeg 4.4.2). None of them cover the dashboard's pages, none call the real AI service, and none reach YouTube.

## Waiting on the owner

- **A brief for the real campaign.** The only brief, `briefs/forgegui-basic.json`, is the example from the spec. The owner's test footage is football commentary, which it does not fit. Write a brief only from campaign text the owner supplies.
- **The Stitch brief.** Stitch is a second campaign: the spec lists "two real brief files (ForgeGUI and Stitch)" and gives no rules for it.
- **The ForgeGUI logo.** The spec's example refers to `assets/forgegui-logo.png`, which was never supplied, so the example brief has no `image` line and its end card is plain.
- **A verdict on caption timing** in continuous speech, judged by eye on real clips. Word starts after pauses were measured, and since 2026-11-22 starts under game sound (the clip "what-just-happened-here", rendered again with the fix): watch it and say whether the captions now land with the shouts.
- **Whether the `small` speech model is accurate enough.** A larger model needs about 1.5 GB more disk and is slower.
- **How to keep two downloader runs from rewriting the YouTube sign-in at once.** yt-dlp writes the cookies file back when it ends, and the live check runs beside a fetch or a chat download, so two can write it at the same moment and spoil it. Ways out: run downloader calls one at a time (the live check would then wait behind a long fetch), or hand each call a copy of the file (the rules say never to copy it). Found in review on 2026-11-22; not yet seen to happen.

- **Disk space on the first machine.** On 2026-11-23 it was 99% full (2.7 GB free); a long fetch is refused when there is too little room.

## Known faults, not yet fixed

Found in a review on 2026-11-22. They are in the pages, which need driving in a browser after a change, so they were left for a session that does that.

- The AI check's verdicts on chat moments live only in the open "Suggested moments" panel: leave the video and come back, or press "Show" on the finished job, and they are gone.
- Hook suggestions live only on the cutting screen, and their job is hidden from "Activity": leave the screen while it runs and the hooks are lost without notice.
- Editing a moment's start or end in the list does not move its mark above the timeline.
- The cutting screen works out whether the webcam box is cropped with its own sum, not one from `src/layout.js`.
- Space on a section heading in the moments panel plays the video instead of opening the section.
- A blur box that reaches into the clip by less than 0.005 s is sent with no length, and the cut then fails.
- A long run of comment times, each within 25 s of the next, keeps clips near it out even where they would not overlap the clip actually cut.

## Not verified

- The Windows guide (`docs/install-windows.md`) on a real Windows computer. Its Ubuntu steps were run from a fresh copy cloned from GitHub; installing WSL, and the browser and Explorer on the Windows side, were written from Microsoft's documentation and not run.
- The Combine page in the owner's hands. It was driven by script: a whole run on generated test videos with a frame counter, and a preview of two of the owner's own videos (a fetched part and a phone recording), which played in step within about 0.03 s. Lining up a real reaction by eye and ear is the owner's to judge.
- How a combined video sounds. Levels were measured, not listened to.
- The LIVE mark on one of the owner's own channels: none was live when it was built.
- Sync between two real computers. Against the real GitHub only the first send and a stand-in for the home PC in a scratch folder were run; changes going both ways, a clash and a removal were run between scratch machines with a repository in a folder. The home PC also needs its own SSH key on GitHub.
- Why the first real connect lost its copy's `.git` folder halfway (nothing was sent; the second try worked). Sync actions now run one at a time, which is the likely cause but was not proven.
- "Load my data" on a second real computer. The round trip was run between two scratch dashboards on this machine, with a copy of the owner's real lists; loading on Windows inside WSL was not tried. The browser round trip was run before the contents were narrowed to what the owner chose; after that the engine and server tests were run again, and the download was checked on the real dashboard.
- The clubs set on 45 of the owner's channels on 2026-11-20. They were worked out from each channel's own description, tags and recent titles after the owner's own marks were lost; five were told to the owner as less certain, ten channels were left without a club, and the owner has not yet confirmed them.
- Stop pressed on a fast fetch from the page. A stop was tried through the engine (`fetchVideo`); the owner has fetched from the page (a whole video of about 1.5 hours in about 20 s, 2026-11-21) but has not pressed Stop on one. The owner's first dashboard fetch with it fell back to the slow way for a reason that was not recorded; retries and a visible reason were added after it, and have not yet been seen on a real dashboard fetch.
- Clips from a stream's chat after the change to reactions and comments, pressed from the page; the choice was replayed on the 11-hour stream's saved chat and comments, and the clips were not watched.
- Clips from a stream's chat on a busy watchalong. On the one real stream tried, a quiet community chat, few of the explosions were match moments. Not yet pressed from the page (the request was run through the engine; the page was only looked at and typed into).
- Suggested moments on a real football watchalong with a busy chat (the brief's acceptance check). It was run on a made-up match chat and on the real, quiet chat of one stream; the real service was not used, only a stand-in, so neither the steered prompt nor the AI check of chat moments has been answered by Claude or OpenAI.
- The blur boxes on the cutting screen, driven in a browser (drawn, moved, resized, timed); the render was measured by tests and a frame of real footage.
- The overlay controls on the cutting screen, driven in a browser, and a real cut with a brief that sets an overlay. The render was measured by tests and frames; the page only built.
- A hook suggestion from the real AI service. Only a stand-in answered in the tests; the button was looked at on the dashboard, not pressed.
- The YouTube sign-in with a real cookies file. The tests use a stand-in for the downloader; whether a saved sign-in gets past "confirm you're not a bot", and for how long, was not seen.
- Whether the chat defaults (3×, 8 messages, 5 people per 5 s) suit the owner's channels. On the one channel on this machine they find nothing.
- The Download page in a browser, beyond the owner's own use. The owner has downloaded from it (11 minutes in about 13 s, a whole video of about 1.5 hours in about 20 s), but Claude has not driven it in a browser or read its console, and its "slow way" notice has not been seen.
- The sync button on the owner's real list. It was run on a test copy with one channel. "Update pictures and subscribers" was pressed on the real list when it had fourteen channels. The downloader also warned that it will stop supporting Python 3.10, which this machine has.
- Which player showed the fetched part out of step. The file is now the same for every player, but the owner has not yet confirmed it plays in step.
- How the second set of built-in card sounds sounds. The owner rejected the first set on 2026-11-19. The second was measured and the voice checked with the speech recogniser, but not listened to. A real "Goool" needs a recording from the owner, as `sounds/goal.mp3`.
- Whether the owner meant the supplied intro video to play behind the intro card. It was built that way on a reading of one sentence.
- The colours in the starting list of clubs. Which clubs are in La Liga and the Premier League was checked for 2026–27; the colours are still from memory.
- The redesigned dashboard in long use. The owner looked at it and accepted it on 2026-11-19; before that it was looked at in screenshots from a hidden Chrome and its main actions were run by script. A real mouse drag of the crop on the new layout, a screen reader and browsers other than Chrome were not tried.
- The wider crop (`--crop-width`) on a clip the owner has judged. One frame from a real video was looked at, and one cut was made from the page.

The owner was told about the rest on 2026-11-19 and accepted them as they are, along with the result of the quality check (the softness comes from the source file).

- `replacements` and the spoken forbidden-term rule ran on made-up transcripts, not real speech.
- The `facecam` layout was not tried on a recording that has a real webcam box.
- The end card was tried with generated test pictures, not with a real logo.
- Captions in a language other than English. Caption widths are only known for A to Z, digits and a few signs.
- The dashboard was tried in Chrome only, and its facecam box was placed but never used for a real cut.
- Nothing has been run on Windows or macOS. Windows would need work first: the transcriber's path is `.venv/bin/python`, and each render makes a symbolic link to the fonts folder.

## Next

Nothing is decided. Ideas the owner has been offered:

- Removing "Download my data" and "Load my data", or folding them under one line, once the home PC has synced (the owner agreed on 2026-11-23 to keep them until then)
- Refreshing an open Sources page by itself when a sync brings a change; now it shows the older list until reloaded, and refuses "Save the list"
- On the Combine page: a delay before the second video comes in, and removing the older "Show another video beside it" option from Compilations if the page replaces it
- A credits card at the end of a compilation, listing each streamer with their picture
- A faster encoder setting for compilations (`superfast`: about two thirds of the time, the same quality, twice the file size)
- A time limit on a fetch, as a second safety beside the Stop button and the refusal of live streams
- Ending the dashboard's running jobs when it is stopped with Ctrl+C. On 2026-11-21 a restart during a slow fetch left its ffmpeg running, holding a deleted 276 MB file, until it was ended by hand
- A notice when a channel in the list goes live
- Using the club a streamer supports elsewhere, such as choosing streamers by club when building a compilation for a match
- Recording a live stream from now on for a set number of minutes, offered when the owner asked about fetching from a live stream
- A screen for creating and editing briefs, so the JSON is not edited by hand
- An option to keep the source's frame rate (60 fps) in clips and compilations, offered after the quality check of 2026-11-19 (see `docs/decisions.md`)
- Cutting several ranges in one go
- A larger local speech model, if caption mistakes prove a problem (about 1.5 GB more disk)
- AI word fixes from the command line; they exist only in the dashboard
- Moments from the chat, and clips from a stream's chat, on the command line; they exist only in the dashboard
- A time range for clips from chat, and a faster chat download: asking the chat replay from a point in the stream (needs the owner's decision: it calls YouTube's own interface, not the downloader), or at least stopping once past the range's end
- The AI choosing the final clips from the best candidates, with the streamer's words in each window transcribed (only those few minutes); needs Claude Code working in WSL
- The streamer's own voice as a signal: where the stream gets loud (shouting "GOAL"), measured from its sound alone, which is a small download; it would find match moments that a quiet chat misses
- Leaving common words ("he", "is", "the") out of a chat moment's top words; on the real chat they crowded out the telling ones
- Ending a chat moment's window at the end of its busiest bucket rather than its start, so longer buckets do not cut a burst short

## Later, only if clipping proves worth it

From the spec:

- Visual highlight detection with a video-understanding model
- Face detection to choose the crop position automatically
- Batch mode: several ranges from one source in one run
