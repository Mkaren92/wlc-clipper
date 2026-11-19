# WLC Clipper

A Node.js command-line tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires. It is a personal tool for one owner. It has no server and opens no ports.

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

Needs Node 22.12 or later, and `ffmpeg` and `ffprobe` on the PATH built with libass. Captions also need Python 3 with the venv module.

On a new machine: run `npm install` and `npm test`, check `ffmpeg -version`, and ask before running `npm run setup`. Source videos go in `in/` and clips come out in `out/`; both are git-ignored, so neither exists after a fresh clone.

## How it is put together

A `cut` runs these steps in order (`src/cut.js`):

1. Probe the source with `ffprobe` (`src/probe.js`).
2. With `--brief`: load it (`src/brief/schema.js`) and stop now if the clip cannot satisfy it.
3. Extract the range's sound and transcribe it (`src/render.js`, `src/transcribe/`, `scripts/transcribe.py`).
4. Move word times off the pauses (`src/captions/pauses.js`) and apply the brief's word fixes (`src/brief/replacements.js`).
5. Group words into caption lines and write the subtitle file (`src/captions/group.js`, `ass.js`, `width.js`).
6. Build the filter graph for the layout (`src/layout.js`) and run one `ffmpeg` pass (`src/render.js`).
7. Write `post.txt` (`src/brief/postText.js`) and run the brief's rules (`src/brief/check.js`).

`src/cli.js` defines the commands and flags. `src/run.js` spawns programs. `src/time.js` parses and formats timestamps. `src/types.js` holds the shared JSDoc types.

A clip folder holds `clip.mp4` and `post.txt` for the owner, and a `work/` subfolder with `meta.json`, `transcript.json` and `captions.ass` for the tool. `render` and `check` rebuild from `work/`. Folders from before `work/` existed have those files next to `clip.mp4` and must keep working.

## Rules that must hold

Each of these exists because something broke or the spec demands it. The evidence is in `docs/decisions.md`.

- **Never use ffmpeg's `-r` output option.** The frame rate is set by the `fps` filter at the start of the graph. `-r 30` put the picture two frames behind the sound.
- **`-ss` and `-t` both go before `-i`.** Limiting only the output lets the source keep playing under the end card.
- **Never put a path inside a filter graph.** ffmpeg runs in the clip's `work/` folder and the graph names `captions.ass` and `fonts` bare. Paths passed as their own arguments are fine.
- **Keep only the first audio track** (`0:a:0?`), mixed to stereo.
- **Spawn with an argument array** through `src/run.js`. No shell strings.
- **Text drawn on the video goes through `cleanOverlayText`**, because `{`, `}` and `\` are control characters in subtitle files.
- **The caption font is bundled** (`assets/fonts`), and `src/captions/width.js` holds widths measured for that font. Changing the font means re-measuring the widths, the hook position and the end-card text position.
- **Every option of a run is saved in `meta.json`.** A new option needs a field there and a default in `readMeta`, so older clip folders still render.
- **`render` never rewrites `post.txt`**, and checks read `post.txt` from disk, because the owner edits it by hand.
- **The brief wins.** Brief files are validated strictly, and an unknown field is an error.
- **Do not invent a campaign's rules.** A brief is written from text the owner supplies.
- **Guardrails from the spec:** local files only, no downloading; no uploading or posting; no feature whose purpose is removing watermarks or logos. `--trim` is capped at 5% of the shorter side for that reason.

## How to work here

- **Plain JavaScript.** The owner is a JavaScript developer and wants to read and change this code. Keep ES modules with JSDoc types: no TypeScript, no build step, and no second language beyond the small Python transcriber script.
- **Tests with every change.** `npm test` must pass before a change is called done. Add a test for each new rule or flag.
- **Measure ffmpeg behaviour, do not assume it.** `test/cut.test.js` generates a source with a white flash and a beep at a known time; use it to prove timing, sync and silence. Check a claim about what a clip looks like by rendering a frame and looking at it.
- **Ask before installing or downloading anything**: system packages, pip packages, speech models. Wait for a clear yes, and do not look for another route if a step is refused. The owner's disk has been nearly full.
- **Ask before anything that sends data out**, such as the planned `suggest` command, which sends transcripts to an LLM service.
- **Do not commit or push unless asked.**
- **Say what was verified and what was not.** A passing test suite does not show that a clip looks or sounds right.
- **Write for the owner in plain language**, with commands ready to copy, including the `cd` into the project folder.
