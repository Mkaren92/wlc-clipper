# WLC Clipper

A Node.js tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires. It is a personal tool for one owner. It can be used from the command line or from a dashboard in the browser, which is a small web server that only this machine can reach.

The repository is https://github.com/Mkaren92/wlc-clipper and it is public.

Read these before changing behaviour:

- `README.md`: how the tool is used, every command and flag, the brief format.
- `docs/decisions.md`: where the code departs from the spec and why, with the measurements behind each choice. Check it before "fixing" something that looks odd.
- `docs/roadmap.md`: what is built, what the owner still owes, what comes next.
- `docs/install-windows.md`: installing on Windows through WSL. Keep its versions, sizes and expected outputs true when setup, the commands or the test count change.
- `docs/build-spec-v1.pdf`: the original spec. The code and `docs/decisions.md` win where they differ from it.

## Commands

```bash
npm install                 # Node dependencies
npm run setup               # Python .venv with faster-whisper and yt-dlp; ask the owner first (see below)
npm test                    # vitest; some tests run the real ffmpeg
node src/cli.js --help      # the command line: probe, cut, render, check, suggest, extract, fetch
npm run dashboard           # build the pages, then serve them at http://127.0.0.1:4517
npm run dev:web             # only while editing the pages: live reload on port 4518
```

Needs Node 22.12 or later, and `ffmpeg` and `ffprobe` on the PATH built with libass. Captions and `fetch` also need Python 3 with the venv module. It has only been run on Linux. On Windows it is meant to run inside WSL 2 with Ubuntu 22.04; `docs/install-windows.md` is the step-by-step guide, and it says which of its steps were run and which were written from Microsoft's documentation.

## On a new machine

1. Run `npm install` and `npm test`. These install only the dependencies the project already declares, so they need no extra permission.
2. Check `ffmpeg -version`. The measurements in `docs/decisions.md` were taken on 4.4.2.
3. Captions need three things that each install or download something. Ask the owner before each one:
   - the system's Python venv package, if it is missing (`sudo apt install python3-venv` on Ubuntu)
   - `npm run setup`, which installs faster-whisper and yt-dlp with pip into `.venv`
   - the first `cut` with captions on, which downloads the speech model (about 460 MB) to `~/.cache/huggingface`
4. Source videos go in `in/`. Clips come out in `out/`, plain parts in `parts/`, and saved matches, cards, combinations, compilations, the sources list and the channels' pictures in `data/`. The owner's own sound files for cards go in `sounds/`. The tool creates all five. They are git-ignored, so none comes with a clone.

Clip folders do not move between machines. `work/meta.json` stores the absolute path of the source video and of the end-card image, so `render` fails on a clip whose source is not at that path.

## How it is put together

A `cut` runs these steps in order (`src/cut.js`):

1. Probe the source with `ffprobe` (`src/probe.js`).
2. With `--brief`: load it (`src/brief/schema.js`) and run the rules that can be judged already (`src/brief/check.js`). A failure stops the run here, before any folder exists.
3. Create the clip folder, write `work/meta.json`, and with a brief write `post.txt` (`src/brief/postText.js`).
4. Extract the range's sound and transcribe it (`src/render.js`, `src/transcribe/`, `scripts/transcribe.py`).
5. Move word times off the pauses (`src/captions/pauses.js`), apply the brief's word fixes (`src/brief/replacements.js`), and write `work/transcript.json`.
6. Group words into caption lines and write the subtitle file (`src/captions/group.js`, `src/captions/ass.js`, `src/captions/width.js`).
7. Build the filter graph for the layout (`src/layout.js`) and run one `ffmpeg` pass (`src/render.js`).
8. Run all the brief's rules on the result and save them in `work/meta.json`.

`render` repeats steps 6 to 8 from the files in `work/`. `check` repeats only the rules of step 8 and writes nothing.

`src/ai/` holds the two optional AI features: `suggest.js` proposes moments from a whole-video transcript and `fixWords.js` proposes corrections to caption words. They talk to a service only through the small interface in `client.js`, which picks one of two: `claudeCli.js` runs the Claude Code command line (`claude -p`) with the login it already has, and `openai.js` uses an API key. `src/env.js` reads settings from `.env`.

`src/part.js` is the one thing that is not a clip: `extract` saves a time range of a video as it is, at the original size, into `parts/`.

`src/cards/` draws match cards: `templates.js` has one function per kind of card that returns SVG, `measure.js` fits text without a browser, `config.js` holds the lists of goal and red-card types, `match.js` saves a match with its cards, and `clubs.js` keeps the owner's list of leagues and clubs (`data/clubs.json`) that a match's teams can be filled in from. `src/compilation/` joins videos and cards into one video: `timeline.js` is the saved format, `build.js` renders it, `description.js` writes the credits and chapters, and `sounds.js` holds the sounds played under cards: the built-in ones, made by ffmpeg, and the owner's files in `sounds/`. `src/combine/` puts two videos side by side and makes one video of them: `layout.js` holds the sums (lengths, the two halves, which part of a video shows) and touches no file, so the page's preview uses it too, `combination.js` is the saved format (`data/combinations/<id>/`), and `build.js` renders it. A compilation can use the result, as one more folder of videos named `combined`. All three are used only from the dashboard.

`src/sources.js` is the list of channels and whether each has agreed, `src/fetch.js` brings part of a YouTube video into `in/` with `yt-dlp`, and `src/pictures.js` fetches the profile picture of each channel in that list (`data/source-pictures/`), which a compilation draws beside the channel's name where it is credited. They are the only code that takes anything from outside.

`src/cli.js` defines the commands and flags. `src/run.js` spawns programs. `src/time.js` parses and formats timestamps. `src/types.js` holds the shared JSDoc types.

### The dashboard

- `server/` is an Express server (`server/app.js`) that exposes the same engine functions over HTTP. It adds nothing of its own beyond listing files and running slow work as background jobs (`server/jobs.js`). `server/index.js` starts it.
- `server/cards.js`, `server/combinations.js`, `server/compilations.js` and `server/sources.js` hold the routes for the four extra pages, and `web/src/pages/` holds the pages (`CardMaker.vue`, `Combiner.vue`, `CompilationBuilder.vue`, `Sources.vue`). The buttons at the top of the left column switch pages; the page is kept after `#` in the address.
- `web/` is a Vue 3 app built with Vite into `web/dist`, which the server serves. `theme.js` holds the colour palettes and works out every colour from them, `style.css` holds the styles every page shares, `NewClip.vue` is the cutting screen, `FramePicker.vue` draws the layout over the video, `ClipView.vue` shows a finished clip, `api.js` holds every call to the server, and `jobs.js` keeps the list of work in progress that the side column and the screens read.
- The command line and the dashboard are two front ends to `src/`. Behaviour belongs in `src/`, so both get it.

A clip folder is named after the clip's hook (`out/barca-wants-who`, then `-2`, `-3` when taken), or `clip-NNN` when there is no hook. It holds `clip.mp4` and `post.txt` for the owner, and a `work/` subfolder with `meta.json`, `transcript.json` and `captions.ass` for the tool. Folders from before `work/` existed have those files next to `clip.mp4` and must keep working.

## Rules that must hold

Each of these exists because something broke or the spec demands it. The evidence is in `docs/decisions.md`.

- **Never use ffmpeg's `-r` output option.** The frame rate is set by the `fps` filter at the start of the graph. `-r 30` put the picture two frames behind the sound.
- **`-ss` and `-t` both go before `-i`.** Limiting only the output lets the source keep playing under the end card.
- **Never put a path inside a filter graph.** ffmpeg runs in the clip's `work/` folder and the graph names `captions.ass` and `fonts` bare. Paths passed as their own arguments are fine.
- **Keep only the first audio track** (`0:a:0`), mixed to stereo. A plain part (`src/part.js`) is the exception: it is meant to be the source unchanged, so it keeps every audio track, the original size and the original frame rate.
- **Spawn with an argument array**, never a shell string. The tool does it through `src/run.js`.
- **Text drawn on the video goes through `cleanOverlayText`**, because `{`, `}` and `\` are control characters in subtitle files.
- **The caption font is bundled** (`assets/fonts`), and `src/captions/width.js` holds widths measured for that font. Changing the font means re-measuring the widths, the hook position and the end-card text position.
- **Everything `render` needs is saved in `work/meta.json`**: the source, the range, the layout options, the hook, and a copy of the brief. The title and description are not there; they live in `post.txt`.
- **`render` never rewrites `post.txt`**, and checks read `post.txt` from disk, because the owner edits it by hand.
- **The brief wins.** Where a brief and one of the tool's defaults disagree, the brief's value is used, and the checks report anything the tool could not satisfy.
- **Brief files are validated strictly.** An unknown field is an error, so a misspelled rule cannot silently never run.
- **Do not invent a campaign's rules.** A brief is written from text the owner supplies.
- **The dashboard listens on `127.0.0.1` only**, and `onlyThisMachine` in `server/app.js` refuses requests whose `Host` or `Origin` is not its own. Without that, any web page open in the owner's browser could start cuts.
- **The browser sends names, never paths.** A video is a file name in `in/`, a clip a folder name in `out/`, a brief a file name in `briefs/`; the server resolves them.
- **One job at a time.** Two cuts at once could pick the same clip folder.
- **A clip is deleted only through `removeClip` in `src/cut.js`**, which refuses any folder without a clip's `meta.json`. The page asks for confirmation first, in the page itself and not with a browser dialog, and the server refuses while a job is running. A video in `in/` and a part are deleted by name with the same two safeguards.
- **Work in progress is not kept inside a screen.** The pages read it from `web/src/jobs.js`, which asks the server (`GET /api/jobs`), so progress is still shown after moving to another screen or reloading.
- **The pages name no colour.** Every colour is a token (`--bg`, `--accent`, `--bad` and the rest) that `web/src/theme.js` works out from a five-colour palette, so a palette can be swapped by changing five values. `test/theme.test.js` holds each palette to readable contrast. A result (passed, failed, waiting) uses `--good`, `--bad` and `--warn`, never `--highlight`, which is green in one palette and orange in another. Three exceptions, on purpose: match cards use the teams' colours, the crop window over the video (`FramePicker.vue`) has fixed colours so it shows on any footage, and a player's stage is black, with white for the words on it (`Combiner.vue`, and the background of the result players).
- **Nothing is fetched to draw the pages.** System fonts and drawn-in icons (`web/src/components/Icon.vue`) only: no web fonts, icon sets or style libraries from outside.
- **The player's keys are ignored while a box, list or slider has the keyboard.** On a button or link only Space and Enter are left to it, because a button is where the keyboard is after choosing a video or pressing Play. Keys are matched on `event.code`, not `event.key`, so they work on the owner's non-Latin keyboard layout. The listener is removed when the cutting screen goes away.
- **The pages do not redo the engine's arithmetic.** The crop windows drawn over the video come from `describeLayouts` in `src/layout.js`.
- **A re-rendered clip keeps its address**, so the pages add a version number to it and the server sends it uncached. Otherwise the browser replays the old clip.
- **The AI key lives only in `.env` or the environment.** Never write it into a file that is tracked, a brief, `meta.json`, a log, or a message to the owner, and never print `.env` or `process.env`. To check that it is set, count the line (`grep -c '^OPENAI_API_KEY=' .env`).
- **Only the entry points read `.env`**: `src/cli.js` and `server/index.js`, through `loadEnv`. If a module the tests import loaded it, `npm test` could spend the owner's money. Tests use a stand-in for the AI service.
- **What a model returns is untrusted.** It is validated in our own code (`tidyMoments`, `tidyFixes`), checked against the brief with the ordinary rules, and only ever shown as a proposal: nothing is cut, saved or rendered without the owner pressing a button. Model-written text never goes into a shell command; `suggest` prints only numbers in its `cut` line.
- **Error messages about the AI service are written here**, not passed on from the service, whose own text can repeat part of the key.
- **Only text leaves the machine**: transcript words and the brief's rules. No audio, no video, no file names or paths.
- **Claude Code is run as a question-answerer and nothing else**: with `--tools ""` so it cannot read or change files, `--strict-mcp-config` so no connected services load, `--no-session-persistence`, and from the system's temporary folder so it does not read this project's `CLAUDE.md`. Do not loosen any of these.
- **A card's preview and its PNG come from the same template function.** The PNG is drawn in the browser (`web/src/cardPng.js`), which writes the bundled font into the SVG first: a picture drawn from SVG cannot load a font from outside itself and would silently use another one.
- **The clubs list is the owner's, and starts from memory.** `src/cards/clubs.js` seeds three leagues with club names and one colour each, written from memory of the 2025–26 season and said to be so in the page. Do not present it as current or complete, do not fetch a list or logos from anywhere to correct it, and do not add logos to the seed. A club's logo is the same owner-chosen small PNG as a match's icon. A match copies what it takes from a club, so the list can change without changing saved matches.
- **Everything a person types into a card is escaped** (`escapeXml`), and a team colour is used only if it is a plain `#rrggbb` value.
- **Cards are text and plain colour, except club icons on the intro card.** The owner asked for icons on 2026-11-19, which lifted the earlier "text only" rule for that one thing. An icon is a picture the owner chooses from their own computer; the page shrinks it to a small PNG that is stored with the match (`isIcon` in `src/cards/config.js`). Never fetch, bundle or suggest a source for crests, and add no league logos, player photos or broadcast images.
- **The built-in sounds are made, not recorded.** `src/compilation/sounds.js` builds each with ffmpeg: a computer voice (ffmpeg's `flite` source, stretched with `rubberband`) and plain tones. Do not bundle, fetch or download sound recordings; a real recording comes only from the owner, as a file in `sounds/`. Change `SOUND_VERSION` when a built-in sound's recipe changes, or old copies and the segments made with them are reused.
- **Nobody can hear the built-in sounds while building them.** The owner rejected the first three. Check what can be measured (length, level, pitch, and the voice with the local speech recogniser), say plainly that they were not listened to, and leave the verdict to the owner.
- **A card with no length is shown as long as its sound**, rounded up to a whole frame, or 3 seconds when silent. A length the owner typed is kept: a longer sound is faded out at the card's end, a shorter one is followed by silence. A sound never carries into the next item.
- **A video in `sounds/` goes behind the card as well as under it.** The card is then drawn from its see-through picture (`-clear.png`, saved by the card maker next to the ordinary one) over the video. Keep the ordinary picture path as it is; a card with no see-through picture fails at plan time with a message to save its match again. The video is brought to 30 fps first in the graph like every other source, its last frame is held when the card outlasts it, and its sound is never looped. A video beats a sound file of the same name.
- **"Automatic" prefers the owner's file**: a file in `sounds/` named `intro`, `goal`, `red` or `fulltime` takes the built-in sound's place for that kind of card (`automaticSounds`).
- **A sound file is named, never given as a path**, like videos: a plain file name in `sounds/` with a sound file's ending. Its format is stated in the filter chain before it is used, because a file may not say how its channels are laid out.
- **A video with a second video beside it is still one segment, as long as the first video.** The screen is split while the second runs and given to the first from the frame it ends (`besideArgs` in `src/compilation/build.js`). The first video's sound keeps its level throughout: the second's is added with `amix` set not to scale its inputs. An item with no second video must be planned and made exactly as before, so its existing segments stay valid; the second video's details go into the recipe only when there is one.
- **The Combine page's preview and the combined video come from the same sums.** `src/combine/layout.js` works out the length, how long the screen is split, how it is shared between the two (the main video has 50, 60 or 70 percent) and which part of each video shows; `Combiner.vue` draws the preview from it and `src/combine/build.js` builds the ffmpeg graph from it. Keep that file free of Node imports, and put any new setting's arithmetic there, not in the page. Both videos start together at the beginning of the result; the page lines them up by moving each one's start.
- **In the preview the main video is the clock.** The page reads its position each frame and pulls the other video back when it drifts more than 0.15 s. Both videos are stopped when the page goes away. The sound balance in the preview is only rough, and the page says so.
- **A combined video is named by its combination's id**, in the folder `combined`, and is offered to compilations only once it has been made. `made-from.json` beside it holds the settings it was made from, which is how the page marks one whose settings have changed since. It is encoded once here (`veryfast`, CRF 14) and again by the compilation; change those settings only with a new measurement (see `docs/decisions.md`).
- **Every segment of a compilation has the same settings and an explicit length**, which is what lets them be joined without encoding again. A change to the segment settings in `src/compilation/build.js` must also change `RECIPE`, or old segments would be reused.
- **A segment is reused only when everything that went into it is unchanged.** Its file name is a hash of those things, and it is written under a partial name first.
- **Paths handed to ffmpeg from `build.js` are absolute**, because ffmpeg runs inside the work folder. `list.txt` holds only names the tool made, never one a person typed.
- **`fetch` is one of two exceptions to "local files only" (channel pictures, below, are the other), and it stays narrow.** It takes YouTube links to a single video, a time range of at most 20 minutes and never a whole video, and only from a channel whose entry in the sources list is marked `agreed`. The channel is read from the video's own data, not from anything typed. Do not widen any of these, add other sites, or add a way around the sources list, without the owner asking for exactly that. Since 2026-11-20 the Sources page shows no status: the owner adds a channel only once it has agreed, on their word, and every entry added is saved as `agreed`. The check in the engine is unchanged.
- **Channel pictures are the second and last thing taken from outside, at the owner's request on 2026-11-20.** `src/pictures.js` fetches the profile picture of a channel only if it is in the saved sources list and marked `agreed`, and only after the channel YouTube reports for that address passes the same test as a video's channel (`agreedSourceOf`). The picture is the thumbnail named `avatar_uncropped`, its address must be `https` on one of YouTube's two picture hosts (`checkPictureUrl`), redirects are refused, and what comes back is decoded by ffmpeg and drawn again as a round 256-pixel PNG; the bytes that came are deleted. Nothing but those PNGs is kept, they are removed with their channel, and the request to fetch them names no channel: the server uses the saved list. Do not fetch any other picture (banners, video thumbnails, anyone not in the list), and this does not lift the rule against fetching club crests.
- **The sync button on a channel's row is the owner adding that channel.** `syncSource` in `src/pictures.js` takes only the row's id, address and typed name, asks YouTube about that one address, saves the channel into the list as `agreed`, then fetches its picture by the rule above. A name the owner typed is never replaced, because credits, pictures and the names of fetched files are matched on it. A name taken from YouTube is outside text: it is made one plain line of at most 80 characters, shown in the box for the owner to change, and still goes through `filePrefix`, `cleanOverlayText` and the list's own checks wherever it is used. An address already in the list under another row is refused.
- **A credit gets a picture only when it is spelled like the channel's name** (capitals aside), and a hash of what the picture shows goes into the segment's recipe only then (not its date, so fetching the same picture again remakes nothing), so an item with no picture is planned and made exactly as before. The picture is the last input and is laid on after the name (`creditLayout` in `src/compilation/build.js` places both).
- **A credit is drawn on a plate that is fitted by measuring.** The dark plate, its pale edge, its shadow and the white ring for the picture are subtitle drawings in the same file as the name (`creditSubtitles`), so no path enters the graph. The name's width is measured by drawing it alone and reading ffmpeg's `bbox` (`measureCredit`), because a name can hold any letters and `src/captions/width.js` knows only capitals. Change the `credit-2` marker in `planVideo` when the credit's look changes, or old segments are reused.
- **A link handed to the downloader goes after `--`** and has been rebuilt from a checked video id, so it can never be read as an option.
- **A fetched part has nothing hidden at its start.** `removeHiddenLeadIn` in `src/fetch.js` rewrites every download so the picture and the sound both begin at zero; the picture is copied, never encoded again. Without it the sound played almost 3 s away from the picture. A download that cannot be rewritten is removed, not kept.
- **A fetched file is named by the tool**: the channel's name from the sources list, the video id that was checked in the link, and the range. Nothing the downloader reports goes into a file name.
- **Running `npm run setup` again must not change the transcriber.** It updates `yt-dlp` only; faster-whisper stays at the version the captions were tested with.
- **Guardrails from the spec:** local files only apart from `fetch` and the channels' pictures; no uploading or posting; no feature whose purpose is removing watermarks or logos. `--trim` is capped at 5% of the shorter side for that reason.

## Adding a flag to `cut`

1. Define it in `src/cli.js` and pass it to `cut()`. For the dashboard, add it to `cutRequest` in `server/app.js` and to the form in `web/src/components/NewClip.vue`.
2. Add the parameter to `cut()` in `src/cut.js`.
3. If it changes the render: add it to the `meta` object, to the `Meta` type in `src/types.js`, and give it a default in `readMeta` so older clip folders still render.
4. Add a test, and a row in the options table in `README.md`.
5. If it departs from the spec, add an entry to `docs/decisions.md` with the reason.

## How to work here

- **Plain JavaScript.** The owner is a JavaScript developer and wants to read and change this code. Keep ES modules with JSDoc types: no TypeScript, and no second language beyond the small Python transcriber script. `src/` and `server/` run as they are, with no build step. Only `web/` is built, by Vite. The pages are plain Vue single-file components with no UI library, router or store.
- **Run the whole test suite only before a commit or push. This is the owner's firm rule.** `npm test` takes about a minute and the owner does not want it run after every change. While working on a change, run only the tests that cover it, by file or by name:

  ```bash
  npx vitest run test/compilation.test.js            # one file
  npx vitest run test/cards.test.js -t "intro card"  # tests whose name matches
  ```

  The full `npm test` is run once, as part of "Before every push" below, and it must pass there. Do not run it at any other time unless the owner asks.
- **Add a test for each new rule or flag**, in the file that covers that part of the code.
- **Measure ffmpeg behaviour, do not assume it.** `test/cut.test.js` generates a source with a white flash and a beep at a known time; use it to prove timing, sync and silence.
- **Open the dashboard in a browser after changing it.** Nothing tests the pages; `test/server.test.js` covers only the server. A page that builds is not a page that works: drive one cut and one caption fix, and read the browser console.
- **Look at the picture.** The tests do not cover where text lands on screen. To check, save a frame and open it:

  ```bash
  ffmpeg -ss 1 -i out/clip-001/clip.mp4 -frames:v 1 frame.png
  ```

- **Ask before installing or downloading anything** beyond `npm install`: system packages, pip packages, speech models, global npm changes such as `npm link`. Wait for a clear yes, and do not look for another route if a step is refused.
- **Ask before anything that sends data out**, such as the planned `suggest` command, which sends transcripts to an LLM service.
- **Do not commit or push unless asked.** When asked, follow "Before every push" below.
- **Say what was verified and what was not.** A passing test suite does not show that a clip looks or sounds right.
- **Write for the owner in plain language**, with commands ready to copy, including the `cd` into the project folder.

## Before every push

This is the owner's standing rule: the README and the knowledge files are brought up to date before anything is pushed, every time. A push that leaves them describing the old behaviour is not finished.

Go through each file against what changed since the last push (`git diff origin/main` shows it), and edit what is no longer true:

1. `README.md`: commands, flags, the brief fields, how to start things, what a clip folder contains.
2. `CLAUDE.md`: the description at the top, the commands, how the code is put together, the rules, and the checklists.
3. `docs/decisions.md`: an entry for each new choice that is not obvious from the code, with the reason and what was measured.
4. `docs/roadmap.md`: what is built, what is waiting on the owner, what is not verified, what comes next, and the "Last updated" date.

Read the whole of each file, not only the section you expect to change: a new feature usually makes a sentence somewhere else false. Then run `npm test`, and say in the report which of the four files changed and which needed nothing.

The repository is public, so before committing look through what is staged for keys: `git diff --cached | grep -nE 'sk-[A-Za-z0-9_-]{12}|API_KEY=.'` must find nothing but placeholder text, and `git check-ignore .env` must succeed.
