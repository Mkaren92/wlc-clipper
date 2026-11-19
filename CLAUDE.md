# WLC Clipper

A Node.js command-line tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires. It is a personal tool for one owner. It has no server and opens no ports.

The repository is https://github.com/Mkaren92/wlc-clipper and it is public.

Read these before changing behaviour:

- `README.md`: how the tool is used, every command and flag, the brief format.
- `docs/decisions.md`: where the code departs from the spec and why, with the measurements behind each choice. Check it before "fixing" something that looks odd.
- `docs/roadmap.md`: what is built, what the owner still owes, what comes next.
- `docs/build-spec-v1.pdf`: the original spec. The code and `docs/decisions.md` win where they differ from it.

## Commands

```bash
npm install                 # Node dependencies
npm run setup               # Python .venv with faster-whisper; ask the owner first (see below)
npm test                    # vitest; some tests run the real ffmpeg
node src/cli.js --help      # the tool itself: probe, cut, render, check
```

Needs Node 22.12 or later, and `ffmpeg` and `ffprobe` on the PATH built with libass. Captions also need Python 3 with the venv module. It has only been run on Linux.

## On a new machine

1. Run `npm install` and `npm test`. These install only the dependencies the project already declares, so they need no extra permission.
2. Check `ffmpeg -version`. The measurements in `docs/decisions.md` were taken on 4.4.2.
3. Captions need three things that each install or download something. Ask the owner before each one:
   - the system's Python venv package, if it is missing (`sudo apt install python3-venv` on Ubuntu)
   - `npm run setup`, which installs faster-whisper with pip into `.venv`
   - the first `cut` with captions on, which downloads the speech model (about 460 MB) to `~/.cache/huggingface`
4. Source videos go in `in/`, which has to be created by hand. Clips come out in `out/`, which the tool creates. Both are git-ignored, so neither comes with a clone.

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

`src/cli.js` defines the commands and flags. `src/run.js` spawns programs. `src/time.js` parses and formats timestamps. `src/types.js` holds the shared JSDoc types.

A clip folder holds `clip.mp4` and `post.txt` for the owner, and a `work/` subfolder with `meta.json`, `transcript.json` and `captions.ass` for the tool. Folders from before `work/` existed have those files next to `clip.mp4` and must keep working.

## Rules that must hold

Each of these exists because something broke or the spec demands it. The evidence is in `docs/decisions.md`.

- **Never use ffmpeg's `-r` output option.** The frame rate is set by the `fps` filter at the start of the graph. `-r 30` put the picture two frames behind the sound.
- **`-ss` and `-t` both go before `-i`.** Limiting only the output lets the source keep playing under the end card.
- **Never put a path inside a filter graph.** ffmpeg runs in the clip's `work/` folder and the graph names `captions.ass` and `fonts` bare. Paths passed as their own arguments are fine.
- **Keep only the first audio track** (`0:a:0`), mixed to stereo.
- **Spawn with an argument array**, never a shell string. The tool does it through `src/run.js`.
- **Text drawn on the video goes through `cleanOverlayText`**, because `{`, `}` and `\` are control characters in subtitle files.
- **The caption font is bundled** (`assets/fonts`), and `src/captions/width.js` holds widths measured for that font. Changing the font means re-measuring the widths, the hook position and the end-card text position.
- **Everything `render` needs is saved in `work/meta.json`**: the source, the range, the layout options, the hook, and a copy of the brief. The title and description are not there; they live in `post.txt`.
- **`render` never rewrites `post.txt`**, and checks read `post.txt` from disk, because the owner edits it by hand.
- **The brief wins.** Where a brief and one of the tool's defaults disagree, the brief's value is used, and the checks report anything the tool could not satisfy.
- **Brief files are validated strictly.** An unknown field is an error, so a misspelled rule cannot silently never run.
- **Do not invent a campaign's rules.** A brief is written from text the owner supplies.
- **Guardrails from the spec:** local files only, no downloading; no uploading or posting; no feature whose purpose is removing watermarks or logos. `--trim` is capped at 5% of the shorter side for that reason.

## Adding a flag to `cut`

1. Define it in `src/cli.js` and pass it to `cut()`.
2. Add the parameter to `cut()` in `src/cut.js`.
3. If it changes the render: add it to the `meta` object, to the `Meta` type in `src/types.js`, and give it a default in `readMeta` so older clip folders still render.
4. Add a test, and a row in the options table in `README.md`.
5. If it departs from the spec, add an entry to `docs/decisions.md` with the reason.

## How to work here

- **Plain JavaScript.** The owner is a JavaScript developer and wants to read and change this code. Keep ES modules with JSDoc types: no TypeScript, no build step, and no second language beyond the small Python transcriber script.
- **Tests with every change.** `npm test` must pass before a change is called done. Add a test for each new rule or flag.
- **Measure ffmpeg behaviour, do not assume it.** `test/cut.test.js` generates a source with a white flash and a beep at a known time; use it to prove timing, sync and silence.
- **Look at the picture.** The tests do not cover where text lands on screen. To check, save a frame and open it:

  ```bash
  ffmpeg -ss 1 -i out/clip-001/clip.mp4 -frames:v 1 frame.png
  ```

- **Ask before installing or downloading anything** beyond `npm install`: system packages, pip packages, speech models, global npm changes such as `npm link`. Wait for a clear yes, and do not look for another route if a step is refused.
- **Ask before anything that sends data out**, such as the planned `suggest` command, which sends transcripts to an LLM service.
- **Do not commit or push unless asked.** The repository is public, so check new files for names, paths and keys before they go up.
- **Say what was verified and what was not.** A passing test suite does not show that a clip looks or sounds right.
- **Write for the owner in plain language**, with commands ready to copy, including the `cd` into the project folder.
- **Keep these files current.** When behaviour changes, update `README.md`, `docs/decisions.md` and `docs/roadmap.md` in the same change.
