# Decisions and their reasons

The original spec is `docs/build-spec-v1.pdf`. It left some things undefined and contradicted itself in places, and the owner delegated those choices ("every undefined thing is up to you"). This file records each choice that is not obvious from the code, why it was made, and what was measured.

Measurements were taken on the first development machine: ffmpeg 4.4.2 (Ubuntu 22.04), Node 24, Python 3.10, faster-whisper 1.2.1, CPU only.

On a different ffmpeg version, `npm test` re-checks size, frame rate, length, picture-and-sound sync and the silent end-card tail. It does not re-check where text lands on screen: the pixel positions quoted below were measured by hand from rendered frames, so look at a frame again if the renderer changes.

## Stack

- **Node.js with a small Python script.** Python alone would have been simpler, since faster-whisper is a Python library. The owner is a JavaScript developer and wants to take part in development, so everything except `scripts/transcribe.py` is JavaScript.
- **Node 22.12 or later**, not 20 as in the spec. `commander` 15 and `vitest` 5 require it.
- **`child_process` through `src/run.js`**, not `execa`. One small wrapper was enough.
- **`npm audit` is clean** as of 2026-11-19. Earlier it reported high-severity findings in `picomatch`, inside `vitest`'s development-only dependencies, with a downgrade of `vitest` as the only offered fix; that was left alone, and a later install resolved it.

## Rendering

- **Frame rate is converted with the `fps` filter, never with `-r 30`.** The spec's recipes use `-r 30`. On a 60 fps source it put the picture two frames (67 ms) behind the sound; with `fps=30` at the start of the graph, picture and sound match to within one frame. That was measured by hand on 24, 25, 30, 59.94 and 60 fps sources, including an MKV with B-frames; the test suite covers the 60 fps case.
- **`-ss` and `-t` are both input options**, for the render and for the audio extract. With `-t` only on the output and an end card, the source kept playing under the card and its sound was heard in the tail. A test cuts a range that ends just before a beep and requires the clip to be silent.
- **Only the first audio track is used** (`-map 0:a:0?`), for the clip and for the transcriber. The spec's `-map 0:a?` copied every track of a multi-track recording into the clip.
- **ffmpeg runs inside the clip's `work/` folder** and the filter graph refers to `captions.ass` and `fonts` by bare name. A path with a quote, comma or bracket in it broke the `subtitles` filter. `fonts` is a temporary symbolic link to `assets/fonts`, removed after the render.
- **The clip is written to `clip.partial.mp4` and renamed.** A failed re-render leaves the previous `clip.mp4` intact.
- **`--trim` was added** (not in the spec). The owner's source recording has a rounded, coloured border baked into the frame, and 14 pixels removes it. It is capped at 5% of the shorter side so it stays a border remover and does not become a way to crop out logos, which the spec's guardrail forbids.
- **`--crop-x` is the left edge of the crop in source pixels**, clamped to the frame. The spec did not say what the offset was measured from.
- **`--crop-width` was added** (not in the spec), and "Show more of the picture" in the dashboard. On a 16:9 recording of a streamer the 9:16 column is 606 of 1920 pixels wide, and the streamer's face left it whenever they leaned. The crop can be made wider, up to the whole width; it is then shown whole over a blurred copy of itself, the same way the `blur` layout shows the whole frame. It is one fixed window for the whole clip: it does not follow anyone. A crop that follows a face would need a face detector to be installed, and was not built. A width at or below the column gives the plain column and the same filter graph as before, so clips made earlier render the same. A wider crop still fails a brief's `keepFullFrame`, which only the `blur` layout passes.
- **The watermark guardrail was reworded** to "no feature whose purpose is removing marks". As written in the spec it contradicted the `center` layout, which discards about two thirds of the frame width.

- **Quality check, 2026-11-19.** The owner felt the outputs looked poor. Each output was compared frame by frame with the same picture made without compression loss: a part against its source scored SSIM 0.997 and 48.7 dB, a centre clip 0.996 and 48.7 dB, a compilation segment straight from the source 0.997 and 51.6 dB, and one made from a part (encoded twice) 0.995 and 49.0 dB. So the encoding settings (`crf 18`) are not the cause. The causes found: the test source is 1280×720 at about 1.5 Mbps of video and 48 kbps of sound, already soft before the tool touches it; the centre layout enlarges a 404-pixel column 2.7 times and a compilation enlarges 720p 1.5 times; and 60 fps sources lose half their frames at 30 fps. A sharper scaler (lanczos) and added sharpening were tried on one frame and made no visible difference, so neither was adopted.

## Captions and on-screen text

- **Font: Liberation Sans Bold**, from the `liberation2` package, under the SIL Open Font License (text in `assets/licenses`). The spec's style names Arial, which is not installed on Linux, and the subtitle renderer silently substitutes whatever it finds. The render aborts if the bundled font file is missing.
- **Hook top margin is 240.** The hook's white box reaches 18 px above its text. At the spec's margin of 200 the box started at y=182, against the spec's own rule that nothing sits in the top 200 px; at 240 it starts at y=222.
- **The hook wraps and is limited to 60 characters.** The spec's file sets `WrapStyle: 2`, which disables wrapping, and a long hook ran off both edges. Hook lines carry `{\q0}`; 60 characters is two lines.
- **The hook's time on screen is a setting** (`--hook-seconds`, and "Hook time" in the dashboard), added at the owner's request. The spec fixed it at 2.5 seconds, which stays the default. 0 means the whole clip, which is the footage only: the hook never sits on the end card. A time longer than the clip is cut to the clip.
- **In the `facecam` layout the hook sits under the webcam panel** (margin 670), so it does not cover the face.
- **An on-screen disclosure is written before the hook** in the subtitle file. When both are on screen, the renderer stacks the earlier event above the later one; measured, their boxes touch and do not overlap.
- **End-card text uses the hook style at a bottom margin of 540.** Its box then ends at y=1397, level with the captions.
- **Wide caption lines are shrunk.** Captions never wrap, and an 18-character line of wide letters ran off the frame. `src/captions/width.js` estimates the width from the font's advance widths (one em is 77 px at the caption size, plus 12 px of outline; within 3 px of the rendered width on six test phrases when measured, and the test allows 10 px) and adds a scale tag when a line exceeds 960 px.
- **`--no-captions` skips only transcription.** In the spec it also skipped building the subtitle file, which would have removed the hook.

## Transcription

- **faster-whisper, model `small`, `int8`, on the CPU**, as in the spec. About 5 seconds for a 30-second clip. The model makes mistakes with names. `npm run setup` installs the latest faster-whisper without pinning a version; 1.2.1 is the one that was tested.
- **Word times are moved off pauses** (`src/captions/pauses.js`). With the spec's settings the first word after a pause was timed 0.25 to 0.6 seconds early, because the model stretches it back over the silence, so its caption appeared before it was spoken. Pauses are found with ffmpeg as stretches at least 15 dB quieter than the clip's average level for 0.25 seconds or more. A relative level means background music simply yields no pauses. This is separate from the grouping rule in `src/captions/group.js`, which starts a new caption line after a gap of more than 0.4 seconds between two words' times.
- **A punctuated prompt for the model was tried and rejected.** It improved timing but inserted words at the start of clips. Tighter voice-detection settings did not improve timing consistently.
- **When the transcriber is not installed, the clip is made without captions and a warning is printed.** An error would have broken every `cut` on a machine without Python set up.
- **`clipper render` re-renders from an edited `work/transcript.json`.** The spec said a run could be "resumed" without defining how; this is the one way.
- **Whisper stays local.** On 2026-11-19 the owner considered replacing it with a hosted speech-to-text service (no Python, about 950 MB of disk freed, likely better accuracy, but paid per minute and the audio is uploaded) and chose to keep the local model. A text model such as Claude cannot replace it, since it does not take audio. A hosted service could still be added later as an option behind the interface in `src/transcribe/`.
- **Timing of words in the middle of continuous speech has not been measured.** The owner was asked to judge it by eye.

## Briefs, post text and checks

- **`captionMustInclude` was renamed `descriptionMustInclude`.** In the spec "caption" meant both the post's text and the burned-in subtitles. In this tool it only means the subtitles. The old name is rejected with a message.
- **`--title` and `--desc` were added.** The spec's `post.txt` needed a title and description but had no source for them. The title defaults to the hook.
- **`post.txt` is written whenever there is a brief, a title or a description.** At first it needed a brief, and the dashboard hid the two fields until one was chosen. The owner looked for them and did not find them, and the title and description from an AI suggestion were being dropped. Without a brief the file holds the title and description only: no hashtags, and no rules are checked.
- **Rules that can be judged early are checked before rendering**, and a failure stops the run before a clip folder is made. The spec checked only after the render.
- **A failed rule after rendering leaves the clip but exits with an error code.** A forbidden term found in the captions may be a transcription mistake the owner can fix.
- **Forbidden terms are also looked for in the transcript, the disclosure and the end-card text.** The spec checked only the title, description and hook. Terms match whole words, ignoring case.
- **The end card is appended after the footage** as a silent tail, and counts toward the brief's length limit. The spec covered the last seconds of the footage with it, which hid content. `--start` and `--end` now always mean what is shown.
- **The end-card image is optional and is placed over a plain dark card.** Placed straight over the footage, a logo with a transparent background would let the frozen last frame show through. This was checked by hand with two generated pictures, one opaque and one with a transparent background; the tests cover only the filter graph's text.
- **`keepFullFrame` was added.** A brief that needs the whole source frame visible passes only with the `blur` layout.
- **`replacements` was added** for words the transcriber gets wrong every time, such as brand names. A key may be several words. They are applied once, when a clip is cut, and the result is saved in the transcript.
- **`platforms` is only printed in the to-do list**, and all optional hashtags are appended after the required ones. The spec did not say what either did.
- **Brief files are validated strictly.** A misspelled field is an error, not a rule that silently never runs.
- **Each clip's `meta.json` keeps a copy of the brief** it was made with, so a later render does not depend on the brief file. It also stores the source video and the end-card image as absolute paths, so a clip folder cannot be re-rendered on another machine.

## AI help

The spec planned one AI feature for version 1.1: `clipper suggest`, through OpenRouter. On 2026-11-19 the owner asked to connect AI and offered an OpenAI key, so it was built on OpenAI directly. The same day the owner asked whether the Claude command line could be used instead of a key, and it was added as a second service and made the default where it is installed.

- **Two features, both proposals only:** suggested moments (with a hook, title and description for each) and caption word fixes. The owner presses the button that cuts or saves.
- **Whisper still does the transcription, locally.** A text model cannot take audio, and the owner chose to keep the local model (see Transcription).
- **Two services behind one interface** (`src/ai/client.js`): Claude through `claude -p`, and OpenAI. `CLIPPER_AI` chooses; with no choice, Claude is used when the `claude` program is on the PATH. Claude needs no key and no separate bill, at the price of sharing the owner's plan limits and working only where Claude Code is installed and logged in.
- **How Claude Code is called:** `claude -p --output-format json --json-schema <schema> --tools "" --strict-mcp-config --no-session-persistence --model sonnet --system-prompt <instructions>`, with the transcript on standard input, from the temporary folder. The answer is read from `structured_output` in the JSON it prints. Checked on Claude Code 2.1.328.
- **The schema's `$schema` line must be removed** before it is passed to `--json-schema`. zod adds it, and the command line then fails with "no schema with key or ref". The first real run failed for this reason while the tests passed, because tests use a stand-in service.
- **`--bare` is not used.** It was left out so the command line keeps using its normal login.
- **Model `gpt-6.2-sol` for OpenAI**, the middle of OpenAI's current range, confirmed available by listing the key's models. `CLIPPER_AI_MODEL` changes it. Model names were taken from OpenAI's documentation on that day, not from memory.
- **The official `openai` package with its zod helper** (`zodTextFormat`, `responses.parse`), checked offline against the installed zod 4 before use.
- **The schema sent to the model is plain**: every field required, no length or range rules. Limits are enforced afterwards in `tidyMoments` and `tidyFixes`, which also survive an answer that is wrong in every field.
- **Suggested times are moved onto real words** of the transcript, with 0.1 s before the first and 0.25 s after the last, and a moment that is too long is shortened at a word.
- **Each suggestion is run through the brief's ordinary rules** and shown with what it would fail. The model is told the rules but is not trusted to follow them.
- **The whole-video transcript is kept in `out/.cache`**, named by the file's name, size and date, because making it takes minutes: 137 seconds for a 10-minute video on the first development machine, against a few seconds once kept.
- **Videos over 60 minutes are refused** with a message, not cut short silently.
- **A word fix replaces exactly one word with one word.** That keeps the word times valid. It cannot remove a stray word: "the Sandro Martinez" became "the Lisandro Martínez".
- **`suggest` prints only numbers in its `cut` command.** A hook written by a model, pasted into a shell line, could run commands.
- **Measured through Claude Code on the same video:** four moments in 6.4 seconds once the transcript existed, and through the dashboard's server three moments and one word fix (Sandra to Lisandro). An earlier single test corrected "noses" to "notifications", where OpenAI had proposed "notis".
- **Measured through OpenAI on the owner's 10-minute video:** 5,295 tokens in and 545 out for four moments, all four sensible and inside the length limits. In the dashboard, "Suggest moments", "Use this", the timeline marks and "Suggest fixes" were pressed and worked; the fixes proposed were noses to notis, Sandro to Lisandro, and Martinez to Martínez.
- **The suggestion in use is highlighted** in the list, on the timeline and above the range fields, and stays highlighted while the range is adjusted by hand. The owner lost track of which suggestion was being cut. Suggestions sent for cutting are marked "Already cut" until the page is reloaded.
- **Not verified:** the "Already cut" mark in a browser, a suggestion run with a brief against the real service, saving AI word fixes and re-rendering from the page, and how good the suggestions are on other kinds of video.

## Dashboard

The spec ruled out a web interface for version 1 and listed "a small review interface" under later ideas. The owner asked for a dashboard with Vue and a Node API once version 1 worked, because choosing times and crop positions from the command line means guessing.

- **Two front ends, one engine.** `server/` calls the same functions as `src/cli.js`. The only additions to `src/` were an optional progress callback, `describeLayouts`, and three small functions for reading and saving a clip folder's files.
- **Express and Vue with Vite**, chosen with the owner. No UI library, router or store: there are two screens.
- **Port 4517**, because 3000, 8000 and 8080 are taken on the owner's machine. `CLIPPER_PORT` changes it.
- **It listens on `127.0.0.1` and checks `Host` and `Origin`.** The server can start ffmpeg and read the `in/` folder, so it must not be reachable from the network or from other web pages in the browser. Express listens on every network interface unless told otherwise.
- **Express passes a failure to start to the `listen` callback.** The first version printed "dashboard running" when the port was already in use.
- **One background job at a time**, polled by the page. A cut takes about a minute, far too long for one request.
- **The crop frame drawn over the video uses the engine's own numbers.** Checked by dragging the frame in the browser, cutting, and comparing a frame of the clip with the same crop taken from the source: they matched, and `cropX` in `meta.json` equalled the value on screen.
- **Progress lives in one shared list (`web/src/jobs.js`), not in each screen.** The owner started a cut, moved to another video, came back, and found no sign of it: each screen had kept its own progress and lost it when left. The owner offered two fixes, freezing the screen or showing the state; showing it was chosen because the server queues jobs, so work can continue. The list is read from the server, so it also survives a reload. Checked in Chrome: the bar stayed across screens, came back after a reload in the middle of a cut, and "Open" led to the new clip.
- **Clips can be deleted from the list**, at the owner's request: a trash icon, one confirmation in place, then the whole folder is removed for good. The owner asked for deletion, so nothing is moved to a trash folder. Two guards: `removeClip` deletes only a folder that holds a clip's `meta.json`, and the server refuses while any job is queued or running, since the folder could be the one in use. Deleting the newest clip frees its number, so the next cut reuses it. Checked in Chrome on a scratch folder: Cancel left the clip, Delete removed its folder and returned to the video screen.
- **Videos can be deleted from the list too**, at the owner's request, with the same trash icon and one confirmation. The confirmation says how many clips were cut from the video, because those clips can no longer be rendered again once their source is gone. Compilations that use the video are not counted; generating one then fails with "No such video." until the item is taken out.
- **Custom player buttons instead of the browser's own controls**, because the crop frame lies over the video and would cover them.
- **The start and end can always be typed**, so a file the browser cannot play can still be cut.
- **Clips are served uncached with a version number in the address.** A re-render replaces `clip.mp4` in place, and the browser would otherwise show the old one.
- **Saving the post text re-runs the clip's checks and stores them** (`recheck` in `src/cut.js`), so the clip page and the clip list show the result of the edit. The command line's `check` still changes nothing.
- **`npm run dev:web` drops the browser's `Origin` header in its proxy.** The pages are then served from port 4518, and the API would otherwise refuse them as another site. Checked: a POST through the proxy reaches the API, the same POST sent straight to the API is refused.
- **Verified in Chrome on the first development machine**, by pressing the page's own controls: the slider, the step buttons, "Set start here" and "Set end here", Play and Pause, "Play the range" stopping at the end mark and Play continuing after it; a cut with a dragged crop and a trim; a caption fix with re-render; a cut with the example brief; and an edit to the post text turning a rule to Fail on the clip page and in the clip list. The first version passed a scripted check while "Set start here", "Save and check again" and replay after "Play the range" were all broken, because the script had filled in the fields directly. Press the real controls.
- **Not verified:** a cut made with the facecam box from the page, any browser other than Chrome, and narrow screens.

## Plain parts

The owner asked for a way to take a piece of a video as it is: original size, no hook, no speech-to-text, kept in one folder apart from the clips.

- **Called "parts", with the command `extract`.** "Trim" was avoided because `--trim` already means cutting pixels off the edges, and "crop" already means choosing part of the frame.
- **One folder, `parts/`, with single files** named from the source and the range (`1_1m00s-1m30s.mp4`, then `_2` if that exists). A part has no working files, so it needs no folder of its own.
- **The picture is encoded again, not copied.** Copying is instant and lossless but can only start at a keyframe, so a part could begin several seconds early. Encoding makes the range exact: in the test a part starting between keyframes had its flash and beep within one frame of where they should be. The cost is time, about 17 seconds for 30 seconds of 720p at 60 fps.
- **Everything else is kept:** the size, the frame rate and every audio track. That is the opposite of a clip, which is 30 fps with one audio track.
- **A file being written starts with a dot** and is renamed when finished, so the dashboard never lists a half-written part.
- **Checked in Chrome on a scratch folder:** "Save this part as it is" showed its progress in the status bar, the part appeared under "Parts" and not under "Clips", it opened and played at 1280×720, and the trash icon deleted it.

## Match cards and compilations

The owner asked for two more dashboard pages, to build "goal reaction" compilations: reaction clips with a card between them describing what happened. The request came with ffmpeg commands "tested with ffmpeg 6.1". They were tried on this machine's 4.4.2 before any page was built.

- **The request's commands were changed in two places, to follow rules this project had already measured:** `fps=30` in the filter graph in place of `-r 30`, and `-ss` and `-t` both before `-i`.
- **Each segment is given an explicit output length**, and a clip's sound is padded to it, so picture and sound are equally long in every segment.
- **Joining without encoding again works here.** Five segments made from unlike sources (1280×720 at 60 fps, 640×480 at 25 fps with no sound, a tall 24 fps MKV, and two cards) had identical stream settings and joined into 15.03 s against a sum of 15.0 s. A flash and beep in the last clip stayed within one frame of each other. The whole file plays about 21 ms later than the sum of its parts, a fixed amount that does not grow with more segments.
- **Card pictures are made in the browser, not on the server.** ffmpeg needs a PNG and the templates return SVG. Drawing it in the browser needs no new package, and uses the same SVG as the preview. The page saves both sizes of every card when a match is saved, so a compilation can be generated again later without the card maker open.
- **The font has to be written into the SVG before it is drawn.** Checked in Chrome: the same line of text ended at 746 px with the bundled font written in and at 809 px without it. The saved PNGs were 1920×1080 and 1080×1920 and matched the preview.
- **Text is fitted with a table of the font's letter widths** (`src/cards/measure.js`), not by measuring in a browser, so a card is the same in the page and in a test. Names of 25 and more characters, a two-digit score and the characters `<`, `&` and `>` were rendered and looked at in both sizes.
- **The tall card is laid out separately**, not shrunk from the wide one: the minute goes under the title, the teams are stacked around the score, and each scorer list has its team's name over it.
- **"Fill from the goal cards" runs only when pressed**, so scorer lines edited by hand are not overwritten. A new full-time card starts filled in.
- **A video in a timeline is named by its folder and its name there** (`in`, `parts` or `clips`), never by a path, like everything else the page sends.
- **A file chosen in the browser is copied into `in/`.** A page cannot tell the server where the original is. The copy is streamed to disk, checked against free space first, and skipped when the same file is already there. Videos already in the project are added without copying.
- **A segment's file name is a hash of what went into it**: the size chosen, the source file's path, size and date, the start, end and credit, or the card picture and its length. Checked: a second run reused all five segments, changing one credit made only that segment again, and touching a source file made only its segment again. In the browser check a run that failed on its second item reused the first on the next run.
- **The credit label is burned in the same way as captions**, from a subtitle file with the bundled font, on a canvas the size of the compilation. It sits bottom left.
- **Chapter times come from the lengths the segments really have**, rounded down to the second. A "Start" chapter is added at 0:00 when the video does not open with a card.
- **Loudness is levelled per clip** (`loudnorm`, one pass), as in the request. It did not move the sound in time.
- **Free space is checked before generating**, at roughly 5 MB for each second of video plus a margin.
- **`data/` is git-ignored.** It holds the owner's matches and videos, and the repository is public.
- **The pages are switched by a value kept after `#` in the address**, with no router. The first version read it only when the page loaded, so changing the address by hand did nothing.
- **Two bugs the browser check found that the tests had not:** the page sent the server's own `final` and `description` fields back when saving, which the strict format refused; and a relative folder path left ffmpeg unable to find a video, because it runs inside the work folder. Both are fixed and now covered by tests.
- **Deleting uses the same trash icon everywhere** (`web/src/components/TrashButton.vue`): clips, parts, matches, cards, compilations and timeline items. The first version of the two new pages had small text buttons, and the owner asked for delete options that were already there. Deleting a card of a saved match now saves the match at once, so the card and its pictures are really gone; before, it only disappeared until the next reload unless Save was pressed. Checked in Chrome: Cancel kept the card, Delete removed it on the server, and deleting a match and a compilation removed them from the lists and the server.
- **Checked in Chrome on a scratch folder:** a match with a goal, a second goal, a red card and a full-time card; live preview; the assist disappearing for a penalty; the full-time lists filling in and staying edited; duplicate and delete for cards and matches; then a compilation of two cards and two clips with credits, reordered with "Up" and by drag events, generated to 12.02 s against a sum of 12.0 s, with the credits and chapters in `description.txt`, and reopened after a reload.
- **Not verified:** choosing or dropping files in the browser (the upload route is tested, the page's use of it is not), a real mouse drag (the drag handlers were driven by script), a tall compilation from the page (the engine's tall preset is tested), and any browser other than Chrome.

## Sources and fetching

Both specs ruled out downloading. The owner later asked to bring in parts of other channels' watchalong videos, and the two agreed on a narrow form of it.

- **Only channels marked as agreed.** The sources list (`data/sources.json`) holds each channel with a status. `fetch` refuses any video whose channel is not marked `agreed`. The status is set by the owner; the tool does not check it with anyone.
- **The channel comes from the video's own data** (its channel id or handle, as the downloader reports them), matched against the address in the sources list. A link cannot pass itself off as another channel's.
- **A time range, never a whole video**, of at most 20 minutes. Watchalongs run for hours and the owner's disk had about 4 GB free; a goal reaction is a minute or two.
- **YouTube links to one video only**, rebuilt from the 11-character video id before use, and passed to the downloader after `--`.
- **`yt-dlp`, installed into `.venv` by `npm run setup`** and brought up to date each time setup runs, because YouTube changes often and old versions stop working. faster-whisper is installed in a separate step without `--upgrade`, so running setup again for the downloader does not change the transcriber.
- **The file is named from the id checked in the link**, not from what the downloader reports, and a download that cannot be rewritten (see below) is removed. The rewrite works in a file whose name does not end in a video's extension, so the videos list never shows it half done.
- **No keyframe forcing.** The part is cut where the stream allows, which can be a few seconds before the asked start. That avoids encoding the picture again, and the exact start is set later when cutting.
- **A fetched part is rewritten so that nothing in it is hidden** (`removeHiddenLeadIn` in `src/fetch.js`). A part cut without encoding begins at the picture's last keyframe before the asked start, and the sound begins somewhere else again. The downloader's file marks both lead-ins as "skip this" (an edit list). On the first real fetch, 2026-11-19, a 70 s part of a 1080p60 AV1 video had 2.97 s of picture and 4.98 s of sound hidden this way, and the owner saw the sound almost 3 s away from the picture. Read by ffmpeg the file was in step (loudness against movement fitted best within 0.5 s, and clearly worse at 2 s and 3 s either way), so the content was right and the skipping was what went wrong. Which player misread it was not established. In Chrome, two frames taken after a seek were closer to the right picture than to the one 2.97 s earlier, but by a thin margin, and playback from the start was not measured.
  - The rewrite copies the picture as it is from its first frame, and cuts or pads the sound to begin at the same instant, encoding only the sound (AAC, 192 kbit/s). The part then starts up to one keyframe gap early (7 s in that video) and plays the same with the marks honoured or ignored.
  - The lead-in is measured by reading the same packet twice, found by its place in the file: once as the file asks to be played and once with `-ignore_editlist 1`. The difference between the two times is the lead-in.
  - Measured on that file after the rewrite: the picture is identical frame for frame (same MD5 over all 4378 frames), the sound sits 2.9666 s later than before, which is the picture's lead-in of 2.9667 s, and both streams start at 0.
  - Encoding the picture again would give an exact start, but costs a generation of quality on footage that is encoded once more in every clip and compilation.
  - A lead-in under 0.1 s on the sound alone is left: that is the ordinary start-up of a sound encoder, and every player handles it.
- **Credits carry the channel's link.** A fetched file is named after its channel, so the compilation page fills in the credit, and `description.txt` adds the channel's address for agreed channels.
- **The sources list is not in the repository.** It is the owner's own record.
- **Verified against YouTube by the owner's own fetches** on 2026-11-19 (yt-dlp 2026.10.21): two parts came down as 1080p AV1 with Opus sound in MP4. The tests use a stand-in for the downloader, and make their own files with a hidden lead-in for the rewrite; they never reach YouTube. Not yet checked: a part fetched after the rewrite was added, end to end.

## Clip folder

- **A clip folder is named after its hook**, at the owner's request: numbers said nothing about what a clip was. The hook is lower-cased and everything that is not a letter or a digit becomes a dash, cut at a word to 50 characters; a taken name gets `-2`, `-3`. With no hook, or a hook with nothing usable in it, the folder is the next free `clip-NNN` as before. Older numbered folders keep working. The dashboard lists clips newest first by the folder's creation time, since the names no longer sort by age, and it accepts a clip name made only of letters, digits and dashes.
- **Working files live in `work/`.** The owner asked for clip folders that show only `clip.mp4` and `post.txt`. Folders with the older flat layout are still read.
