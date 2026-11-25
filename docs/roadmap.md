# Roadmap

Last updated 2026-11-25. Update this file when something here changes.

## Built

Version 1 of the spec is complete: all three "evenings".

- `probe`, and `cut` with the `center`, `blur` and `facecam` layouts; the facecam's webcam panel takes the webcam's shape (any shape, or 16:9, 4:3, 1:1), and its content is a box of its own
- Transcription, word-timed captions, hook line; captions that keep time with a streamer shouting over game sound (2026-11-22)
- `render` to rebuild a clip after editing its transcript
- Briefs: validation, `post.txt`, the rule checks, on-screen disclosure, end card, `check`
- Beyond the spec: `--trim`, `--crop-width` (a wider crop over a blurred copy), `keepFullFrame`, `replacements`, the `work/` subfolder, a hook time setting, clip folders named after the hook, deleting clips and videos from the dashboard, and plain parts (`extract`)
- A dashboard in the browser (`npm run dashboard`): cut with a visual range and crop, view clips with their checks and post text, fix caption words
- Two more dashboard pages: a card maker (goal, red card and full-time cards, saved per match, exported as PNG in two sizes) and a compilation builder (videos and cards in order, credits, one final video with a description file)
- A redesigned dashboard on a five-colour palette that can be swapped (`web/src/theme.js`), one dark look since 2026-11-24 (two light palettes and the chooser were removed at the owner's word), keys for the player, and the cut button always in view
- Sounds under the cards of a compilation, each card shown as long as its sound: the owner's own files from `sounds/` (the three sounds the tool made were removed on 2026-11-24, at the owner's word)
- An intro card for a match: both clubs with their icons and names and "V" or the score, with the owner's intro sound under it
- A video behind a card: a video file in `sounds/` gives the card its sound and a moving background
- Goal, red and full-time cards with both clubs' icons and the score between them (2026-11-25). Six layouts with a chooser were built that day; the owner looked at them all and kept this one, and the rest was removed
- The cards in the colours of the owner's channel artwork (2026-11-25): its dark green behind every card, white words, and its lime on "FULL TIME" and the intro card's "V"
- A second video beside a reaction in a compilation: split screen while it runs, then the reaction full screen
- Sync marks on the Combine page (2026-11-24): mark the goal in one video and the reaction in the other, and the two meet on the same frame; the reaction's start is locked to the marks
- A Combine page: two videos side by side with a live preview to line them up by eye, a side, a start and a shown part for each, a main video that takes the whole screen at the end, and the result offered to compilations
- A list of leagues and clubs (name, colour, logo) to fill a match's teams from, starting with La Liga and the Premier League as of 2026–27, a "Europe" league of leading Italian, French, German and Portuguese clubs, and the 36 clubs of the 2026–27 Champions League
- The club a streamer supports, chosen from the owner's clubs, saved as it is chosen and shown as a logo on the row
- Backups: a copy of the channels list and of the clubs list is kept before every change (`data/backups/`)
- Sync with GitHub: the same data kept the same on every computer by itself, through a private repository of the owner's; connected on the first machine on 2026-11-23, working between both of the owner's PCs since 2026-11-24, when the older "Download my data" and "Load my data" were removed
- Who is live: channels in the list that are broadcasting are marked LIVE, listed first and counted in the side column
- A Stop button for anything waiting or running, in "Activity"
- A sources list and `fetch`: part of a YouTube video or a whole one, each up to 3 hours (parts were capped at 20 minutes until 2026-11-21), from a channel in the list (the owner adds a channel only once it has agreed)
- Fast fetching: 20 minutes in about 16 s instead of 11 minutes, and a whole video of about 1.5 hours in about 20 s, through a relay that asks YouTube for slices (`src/rangeRelay.js`)
- A Download page for `fetch`: paste a link and a range or tick "Whole video", with the checks shown while typing, progress, Stop, "Open it to cut", and the reason shown when a fetch had to go the slow way (the form used to be on the Sources page)
- Channel pictures: the profile picture of each channel in the list, fetched on request and drawn beside its name where it is credited in a compilation; a sync button on a row fills a new channel's name and picture from its address, and each row shows the channel's subscriber count from the last lookup
- Clips from a stream's chat on the Download page: a finished live stream's link, optional words and a number; the best moments, from where chat reacted (laughing, W, L, "clip it"; not commands, polls or pasted messages) and where viewers pointed in the comments, are downloaded as parts
- Twitch beside YouTube (2026-11-23): a Twitch channel as its own row in the sources list, with its picture, follower count and LIVE mark; past broadcasts downloaded on the Download page (a part or the whole, up to 3 hours); and chat moments and clips from a broadcast's chat imported as a TwitchDownloader file, since Twitch does not let the tool read a chat itself
- Suggested moments from the transcript, the chat of a finished stream, or both merged: event terms (with Football and Gaming presets) and guidance that steer both, a chart of the chat, edits, filters, and an optional AI check of chat moments
- Blur boxes: a part of the frame blurred or blacked out for some seconds, drawn on the cutting screen or with `--blur`
- A logo overlay for the whole clip: a logo in a corner or a full-frame picture, chosen on the cutting screen, with `--overlay`, or set by a brief (checked)
- Swear words covered in the captions and the hook (`F*CK`, `SH*T`), and the voice muffled for the length of each such word; two boxes on the cutting screen, both on unless unticked (2026-11-23); the muffle covers the middle 60% of the word
- Captions under loud game sound (2026-11-24): the larger speech model `large-v3-turbo` for captions, heard in pieces of about 10 seconds, because given a whole clip it skips stretches of it (a second pass over silent stretches was tried for a day and removed: it wrote lines nobody said)
- Faster "Suggest moments" (2026-11-23): a whole video's transcript runs on an NVIDIA card where there is one (a 38-minute video in 52 s instead of about 4 minutes on the home PC's GTX 1660 Ti), and can be made straight after a download so it is ready when the video is opened; a hook's range is transcribed the same fast way (46 s of a stream in 5 s instead of 26 s)
- Suggested moments hear the streamer: "Use where the streamer gets loud" tells the AI where the voice is much louder than usual (2026-11-23), up to 20 moments can be asked for, and videos up to 3 hours (60 minutes before)
- Clips from a part: "Cut clips from this part" puts a part under Videos (the same file, linked) and opens it on the cutting screen (2026-11-23)
- Captions on the graphics card (2026-11-24): the larger model in pieces, 60 s of a stream in about 9 s instead of 80 on the home PC; a whole 60-second clip in 28 s instead of 99
- Faster clips (2026-11-23): the picture made on an NVIDIA card where there is one, and the blurred background made about 6 times faster on every PC; a 30-second blur clip in about 32 s on the home PC, over a minute before
- Hook suggestions: "Suggest" beside the hook box proposes three hooks for the clip being set up, about the moment and the feeling rather than the words (2026-11-22): it is given the streamer's name, where the voice is loud, and, when ticked, counts of chat's reactions; written in a viewer's voice about what happens in the clip, not as a report of what the streamer did (2026-11-24)
- A channel tag: the streamer's channel (`@theburntpeanut`) drawn at the top for all the footage, with the hook just under it; `--tag`, or the box on the cutting screen, which offers the handle of a fetched video's channel (2026-11-22)
- Clips from a stream's chat are 1 minute (30 s before and after) since 2026-11-22, and "Skip parts already suggested" gives new parts when asking a stream again
- AI help, optional, through Claude Code's command line (no key) or OpenAI (with a key): `suggest` and "Suggest moments" propose ranges with a hook, title and description; "Suggest fixes" proposes caption word corrections

595 tests pass on the first development machine (Linux, ffmpeg 4.4.2). None of them cover the dashboard's pages, none call the real AI service, and none reach YouTube or Twitch.

## Waiting on the owner

- **A brief for the real campaign.** The only brief, `briefs/forgegui-basic.json`, is the example from the spec. The owner's test footage is football commentary, which it does not fit. Write a brief only from campaign text the owner supplies.
- **The Stitch brief.** Stitch is a second campaign: the spec lists "two real brief files (ForgeGUI and Stitch)" and gives no rules for it.
- **The ForgeGUI logo.** The spec's example refers to `assets/forgegui-logo.png`, which was never supplied, so the example brief has no `image` line and its end card is plain.
- **A verdict on caption timing** in continuous speech, judged by eye on real clips. Word starts after pauses were measured, and since 2026-11-22 starts under game sound (the clip "what-just-happened-here", rendered again with the fix): watch it and say whether the captions now land with the shouts.
- **How to keep two downloader runs from rewriting the YouTube sign-in at once.** yt-dlp writes the cookies file back when it ends, and the live check runs beside a fetch or a chat download, so two can write it at the same moment and spoil it. Ways out: run downloader calls one at a time (the live check would then wait behind a long fetch), or hand each call a copy of the file (the rules say never to copy it). Found in review on 2026-11-22; not yet seen to happen.

- **For the work PC, from the home PC (2026-11-24).** After `git pull`, run `npm run setup` once: it installs `yt-dlp-ejs`, the solver YouTube's JavaScript puzzle needs, without which a signed-in lookup fails with "could not be looked up" (on the home PC the sign-in was off for a day because of that); if `nvidia-smi --query-gpu=name --format=csv` finds a card there, it also installs the card's libraries. With no NVIDIA card, transcripts (captions, whole videos, hooks) and the clip's picture are made on the processor, exactly as before. The Combine page's sync marks and each video's own player need nothing; the owner tried them on the home PC and they work. Combinations stay on the PC they were made on (they do not sync), so one made at home is not on the work PC. On the home PC captions now run on its card (see "Captions on the graphics card" in `docs/decisions.md`): a word can start up to about 0.3 s apart between a clip made there and one made here, so compare caption timing between the two PCs with that in mind. The card code in `scripts/transcribe.py` and `src/render.js` can only be tried on the home PC: keep its fallback to the processor when changing those files, and leave a note here if it needs trying there.
- **Pull the new code on every PC before adding the first Twitch channel.** A PC with older code cannot read a channels list that has a Twitch address, so its sync would stop with a message until it is updated.
- **TwitchDownloader**, if Twitch chat is wanted: a free program to save a past broadcast's chat as JSON. It is the owner's to install.

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
- The Combine page in the owner's hands, beyond the sync marks (which the owner used on 2026-11-24 and confirmed work). It was driven by script: a whole run on generated test videos with a frame counter, and a preview of two of the owner's own videos (a fetched part and a phone recording), which played in step within about 0.03 s. Lining up a real reaction by eye and ear is the owner's to judge.
- How a combined video sounds. Levels were measured, not listened to.
- The LIVE mark on one of the owner's own channels: none was live when it was built.
- Sync beyond what has happened so far. Between the owner's two PCs it has carried changes from home to the first PC (channels, among them the first Twitch row, and pictures; 2026-11-24), and the owner reports it works at home. A clash (the same channel changed on both before a sync) and a removal have only been run between scratch machines with a repository in a folder.
- Why the first real connect lost its copy's `.git` folder halfway (nothing was sent; the second try worked). Sync actions now run one at a time, which is the likely cause but was not proven.
- The clubs set on 45 of the owner's channels on 2026-11-20. They were worked out from each channel's own description, tags and recent titles after the owner's own marks were lost; five were told to the owner as less certain, ten channels were left without a club, and the owner has not yet confirmed them.
- Stop pressed on a fast fetch from the page. A stop was tried through the engine (`fetchVideo`); the owner has fetched from the page (a whole video of about 1.5 hours in about 20 s, 2026-11-21) but has not pressed Stop on one. The owner's first dashboard fetch with it fell back to the slow way for a reason that was not recorded; retries and a visible reason were added after it, and have not yet been seen on a real dashboard fetch.
- Clips from a stream's chat after the change to reactions and comments, pressed from the page; the choice was replayed on the 11-hour stream's saved chat and comments, and the clips were not watched.
- Clips from a stream's chat on a busy watchalong. On the one real stream tried, a quiet community chat, few of the explosions were match moments. Not yet pressed from the page (the request was run through the engine; the page was only looked at and typed into).
- Suggested moments on a real football watchalong with a busy chat (the brief's acceptance check). It was run on a made-up match chat and on the real, quiet chat of one stream; the real service was not used, only a stand-in, so neither the steered prompt nor the AI check of chat moments has been answered by Claude or OpenAI.
- The blur boxes on the cutting screen, driven in a browser (drawn, moved, resized, timed); the render was measured by tests and a frame of real footage.
- The overlay controls on the cutting screen, driven in a browser, and a real cut with a brief that sets an overlay. The render was measured by tests and frames; the page only built.
- Twitch on the pages: the Download page (a Twitch link, the chat file beside "Clips from a stream's chat"), the Sources page (a Twitch row, its sync button, "followers") and the import note on the cutting screen were built, not driven in a browser.
- Twitch for real beyond one past broadcast: a 1-minute part, the live check, the picture and the follower count were run through the engine on 2026-11-23. A whole broadcast, a broadcast still being recorded, a subscriber-only one, a real TwitchDownloader file and clips from a real Twitch chat were not tried.
- How long Twitch's web interface keeps answering without a sign-in. If it stops, the LIVE mark, pictures and follower counts for Twitch rows say they could not be had; downloads also depend on it, through the downloader.
- How YouTube treats a muffled swear word. Its guidelines name only bleeping and muting as obscured. The owner listened to a muffled "What the fuck" on 2026-11-23 and liked it; the rest was measured (see `docs/decisions.md`).
- Telling the streamer's voice from game characters' voices: five ways were measured on 2026-11-24 and none was kept (see `docs/decisions.md`); captions write every voice, and the owner removes lines on the clip page.
- Captions with the larger speech model beyond three of the owner's clips: how often it still writes a game character's line, and how often it mishears shouting.
- The word list for covering and muffling, in long use: which words it misses, and whether it ever covers a name.
- Hook suggestions beyond six of the owner's clips, all of one channel and one game, asked from a script with the real service on 2026-11-24 (the streamer's name and the loud stretches went with them; chat's reactions did not). The button itself was not pressed after the change, and the "use chat's reactions" checkbox was only built. Whether the hooks are good is the owner's call.
- The channel tag box on the cutting screen and the "Skip parts already suggested" checkbox on the Download page, driven in a browser (both pages were built only); and a clip with a channel tag and covered swear words together (each is tested alone).
- The YouTube sign-in with a real cookies file. The tests use a stand-in for the downloader; whether a saved sign-in gets past "confirm you're not a bot", and for how long, was not seen.
- Whether the chat defaults (3×, 8 messages, 5 people per 5 s) suit the owner's channels. On the one channel on this machine they find nothing.
- The Download page in a browser, beyond the owner's own use. The owner has downloaded from it (11 minutes in about 13 s, a whole video of about 1.5 hours in about 20 s), but Claude has not driven it in a browser or read its console, and its "slow way" notice has not been seen.
- The sync button on the owner's real list. It was run on a test copy with one channel. "Update pictures and subscribers" was pressed on the real list when it had fourteen channels. The downloader also warned that it will stop supporting Python 3.10, which this machine has.
- Which player showed the fetched part out of step. The file is now the same for every player, but the owner has not yet confirmed it plays in step.
- A compilation saved with one of the removed tool-made sounds, opened in a browser: the page offers "A sound the tool made (removed): choose another"; that was built and not looked at, since none of the owner's compilations has one.
- Whether the owner meant the supplied intro video to play behind the intro card. It was built that way on a reading of one sentence.
- The new goal, red and full-time cards, and the cards' new colours, in a finished compilation. They were looked at as pictures, with the owner's own match and its real icons in the dashboard; no compilation was generated with them, and none was put over a video. The owner's older matches keep their old card pictures until each is saved once on the Cards page.
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

- Refreshing an open Sources page by itself when a sync brings a change; now it shows the older list until reloaded, and refuses "Save the list"
- Covering swear words in `post.txt` titles too, where YouTube is strictest; and turning the cover or the muffle on or off for a clip that is already made
- On the Combine page: a delay before the second video comes in, and removing the older "Show another video beside it" option from Compilations if the page replaces it
- A credits card at the end of a compilation, listing each streamer with their picture
- A dark plate behind the small grey lines of a card that lies over a video; and the banner's pitch stripes behind the cards, if the owner wants more of the artwork than its colours
- A faster encoder setting for compilations (`superfast`: about two thirds of the time, the same quality, twice the file size)
- A time limit on a fetch, as a second safety beside the Stop button and the refusal of live streams
- Ending the dashboard's running jobs when it is stopped with Ctrl+C. On 2026-11-21 a restart during a slow fetch left its ffmpeg running, holding a deleted 276 MB file, until it was ended by hand
- A notice when a channel in the list goes live
- Using the club a streamer supports elsewhere, such as choosing streamers by club when building a compilation for a match
- Recording a live stream from now on for a set number of minutes, offered when the owner asked about fetching from a live stream
- A screen for creating and editing briefs, so the JSON is not edited by hand
- An option to keep the source's frame rate (60 fps) in clips and compilations, offered after the quality check of 2026-11-19 (see `docs/decisions.md`)
- Cutting several ranges in one go
- Deleting a whole caption line with one click on the clip page
- Separating the streamer's voice from the game sound before recognition, if the larger model still misses words
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
