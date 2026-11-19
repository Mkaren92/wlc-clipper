# WLC Clipper

A command-line tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, with burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires.

It works on files already on your disk. It does not download videos and it does not post anything.

## Requirements

- Node.js 22.12 or later
- `ffmpeg` and `ffprobe` on the PATH, built with libass (check: `ffmpeg -filters | grep subtitles`)
- Python 3 with the venv module, only for captions (on Ubuntu: `sudo apt install python3-venv`)

## Setup

```bash
npm install
npm run setup
```

`npm run setup` creates a `.venv` folder in the project and installs faster-whisper into it. The speech model (about 460 MB) is downloaded to `~/.cache/huggingface` the first time a clip is transcribed.

Without the setup step the tool still works: clips are made without captions and a warning says why.

## Quick start

```bash
# Look at a video
node src/cli.js probe in/video.mp4

# Make a 30-second clip with captions and a hook line
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --hook "He did NOT expect that"

# Watch it
xdg-open out/clip-001/clip.mp4
```

Run `npm link` once if you would rather type `clipper` than `node src/cli.js`. It adds the command to your global npm setup.

Put your source videos in a folder named `in/` (create it yourself; it is git-ignored). `xdg-open` is the Linux command for opening a file; use your system's own on another platform.

## Commands

| Command | What it does |
|---|---|
| `probe <file>` | Shows resolution, frame rate, duration, whether the video is vertical, and its audio tracks |
| `cut <file>` | Produces one finished clip in a new `out/clip-NNN` folder |
| `render <clip-folder>` | Renders an existing clip folder again, for example after fixing a word in its transcript |
| `check <clip-folder>` | Checks an existing clip and its `post.txt` against a brief |

Every command has built-in help: `node src/cli.js cut --help`.

### Options for `cut`

| Option | Meaning | Default |
|---|---|---|
| `--start <time>` | Start of the range | required |
| `--end <time>` | End of the range | required |
| `--layout <name>` | `center`, `blur` or `facecam` | `center` |
| `--crop-x <pixels>` | Left edge of the crop in source pixels, `center` layout only | centred |
| `--cam <x,y,w,h>` | Webcam rectangle in source pixels, required for `facecam` | none |
| `--trim <pixels>` | Cut this many pixels off every edge of the source first | `0` |
| `--hook <text>` | Line shown at the top for the first 2.5 seconds, up to 60 characters | none |
| `--no-captions` | Skip transcription and captions | captions on |
| `--lang <code>` | Language spoken in the video | `en` |
| `--brief <file>` | Campaign brief to follow and check the clip against | none |
| `--title <text>` | Title for `post.txt`, needs `--brief` | the hook |
| `--desc <text>` | Description for `post.txt`, needs `--brief` | empty |
| `--out <dir>` | Output folder | `./out` |

Times can be seconds (`754.5`), `mm:ss` (`12:34.5`) or `hh:mm:ss` (`1:02:03`).

### Layouts

- **`center`** crops a 9:16 column out of the frame. Move it sideways with `--crop-x`.
- **`blur`** keeps the whole frame in the middle, over a blurred copy that fills the screen. Use it when nothing may be cropped away.
- **`facecam`** stacks the webcam rectangle (given with `--cam`) above the middle of the gameplay.

`--trim` is for a thin border baked into a recording, such as a rounded frame. It is limited to 5% of the shorter side of the video.

```bash
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout blur --trim 14
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --crop-x 700
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout facecam --cam 1400,40,480,270
```

## What a clip folder contains

```
out/clip-001/
  clip.mp4            the finished video; this is what you upload
  post.txt            title, description and hashtags (only with --brief)
  work/
    transcript.json   the words that were heard, with their times
    meta.json         the options of the run, and the check results
    captions.ass      the subtitle file that was burned in
```

You only need `clip.mp4` to post. The `work` folder is what lets `render` and `check` run on the clip later.

A clip folder belongs to the machine it was made on: `meta.json` stores the full path of the source video, so `render` needs that video to still be there.

## Fixing a caption

The transcriber makes mistakes, especially with names. To correct one:

1. Open `work/transcript.json` in the clip folder and change the word's `"text"`.
2. Render the clip again:

```bash
node src/cli.js render out/clip-001
```

This skips transcription, so it is quicker than a new `cut`. If the render fails, the old `clip.mp4` is left as it was.

For a word that is wrong in every clip, such as a brand name, put a fix in the brief's `replacements`. It is applied when a clip is cut, so it fixes clips made from then on; clips that already exist still need their transcript edited.

## Briefs

A brief is a JSON file with one campaign's rules. With `--brief`, the tool:

- stops before rendering if the clip cannot satisfy the brief (too long, a banned word in the title, and so on)
- draws the brief's on-screen disclosure and end card
- writes `post.txt` with the hashtags in the required order
- prints a PASS or FAIL line for each rule, then the list of things to do by hand

```bash
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 \
  --hook "He did NOT expect that" --desc "Built in one evening." \
  --brief briefs/forgegui-basic.json
```

If any rule fails, the command exits with an error code. A rule that can only be judged after rendering, such as a banned word in the captions, still leaves the clip in place.

### Brief fields

Only `id` is required. A misspelled field name is an error.

| Field | Meaning |
|---|---|
| `id` | Name of the brief |
| `platforms` | Where to post; printed in the to-do list |
| `minSeconds`, `maxSeconds` | Allowed clip length, end card included |
| `hashtags.required` | Hashtags that must be in the post |
| `hashtags.strictOrder` | `true` if the required hashtags must keep this order |
| `hashtags.optional` | Hashtags added after the required ones |
| `descriptionMustInclude` | The description needs at least one of these terms |
| `onScreenTextMustInclude` | Each term must appear in the hook, the on-screen disclosure or the end-card text |
| `forbiddenTerms` | Must not appear in the title, description, on-screen text or captions |
| `disclosure.mode` | `hashtag`, `onscreen` or `none` |
| `disclosure.text` | The hashtag, or the line drawn at the top for the first 3 seconds |
| `endCard.seconds` | Length of the card shown after the footage, up to 10 |
| `endCard.text` | Text on the card |
| `endCard.image` | Picture centred on the card (optional) |
| `keepFullFrame` | `true` if the whole source frame must stay visible; only the `blur` layout passes |
| `replacements` | Fixes for transcribed words, such as `{ "forge gooey": "ForgeGUI" }` |
| `manualChecks` | Reminders printed after the checks |

A relative `endCard.image` path is looked for from the folder you run the tool in, then next to the brief file.

The end card is added after the footage as a silent tail, so a 30-second range with a 3-second card gives a 33-second clip.

`briefs/forgegui-basic.json` is a complete example.

### Checking a clip later

```bash
# Against the brief it was made with
node src/cli.js check out/clip-001

# Against another brief
node src/cli.js check out/clip-001 --brief briefs/other.json
```

`check` reads `post.txt` as it stands on disk, so it catches edits you made by hand. It changes nothing.

## Captions

- Words are grouped into lines of at most three words or 18 characters.
- A new line starts after a gap of more than 0.4 seconds between words, or at the end of a sentence.
- Text is upper case, white with a black outline, in the lower part of the frame.
- The font is Liberation Sans Bold, bundled in `assets/fonts` so clips look the same on every machine.
- Line widths are known for the letters A to Z, digits and a few signs. Other letters are treated as very wide, so captions in another alphabet come out smaller than they need to be.

Transcription uses the Whisper `small` model on the CPU. On the machine this was built on, a 30-second clip takes about 5 seconds to transcribe and about a minute in total.

To use a different Python than `.venv/bin/python`, set the `CLIPPER_PYTHON` environment variable to its path.

## Tests

```bash
npm test
```

Some tests run the real `ffmpeg` on a small generated video, so `ffmpeg` and `ffprobe` must be installed. They do not need the transcriber.

## What it does not do

- Download video from any site
- Upload or post anywhere
- Choose the moments for you
- Follow a moving speaker
- Remove watermarks or logos
