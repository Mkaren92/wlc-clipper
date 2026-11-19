# WLC Clipper

A tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, with burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires.

You can use it two ways, and mix them freely:

- **From the command line**, with `node src/cli.js` (see [Commands](#commands)).
- **From a dashboard in your browser**, with `npm run dashboard` (see [Dashboard](#dashboard)).

Optionally, an AI service can suggest which moments to clip and fix caption mistakes (see [AI help](#ai-help)).

The dashboard also has two pages for building a longer video out of several pieces: [match cards and compilations](#match-cards-and-compilations).

It works on files on your disk and it does not post anything. The one way video comes in from outside is [`fetch`](#sources-and-fetching), which takes part of a YouTube video from a channel you have marked as agreed.

## Requirements

- Node.js 22.12 or later
- `ffmpeg` and `ffprobe` on the PATH, built with libass (check: `ffmpeg -filters | grep subtitles`)
- Python 3 with the venv module, only for captions and for fetching from YouTube (on Ubuntu: `sudo apt install python3-venv`)

## Setup

```bash
npm install
npm run setup
```

`npm run setup` creates a `.venv` folder in the project and installs two things into it: faster-whisper, which turns speech into text for captions, and yt-dlp, the downloader behind [`fetch`](#sources-and-fetching). The speech model (about 460 MB) is downloaded to `~/.cache/huggingface` the first time a clip is transcribed.

Running it again leaves faster-whisper as it is and brings yt-dlp up to date.

Without the setup step the tool still works: clips are made without captions and a warning says why, and fetching is switched off.

## Quick start

```bash
# Look at a video
node src/cli.js probe in/video.mp4

# Make a 30-second clip with captions and a hook line
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --hook "He did NOT expect that"

# Watch it
xdg-open out/he-did-not-expect-that/clip.mp4
```

Run `npm link` once if you would rather type `clipper` than `node src/cli.js`. It adds the command to your global npm setup.

Put your source videos in a folder named `in/` (it is git-ignored, and the dashboard creates it if it is missing). `xdg-open` is the Linux command for opening a file; use your system's own on another platform.

## Dashboard

The same tool with a page in your browser, for choosing the range and the crop by looking at the video.

```bash
npm run dashboard
```

Then open http://127.0.0.1:4517. Stop it with Ctrl+C.

- **Cut:** pick a video in the left column. It plays on the left and stays in view while you set the range, the layout, the text and the brief on the right. Drag the bright window over the video to place the crop (or the yellow box for the facecam layout). With the center layout, the "Show more of the picture" slider makes the crop wider, for a person who moves out of the narrow column. The bar at the bottom of the screen always shows what will be made, anything that is in the way, and "Cut the clip".
- **Keys for the player:** Space plays and pauses, the left and right arrows move one second (a tenth with Shift), I sets the start, O sets the end, and P plays the range. They do nothing while you are typing in a box, and they go by the key's place on the keyboard, so they work on a keyboard set to another alphabet.
- **Activity:** while a clip is being cut, rendered again, fetched, or searched for moments, the left column says what is happening and at which step, under "Activity". It is there on every page and after a reload. You can start another cut meanwhile; it waits its turn. When something is ready, it offers "Open".
- **Deleting a video:** each video in the left column has a trash icon. It asks once, then deletes the file from `in/`. Clips already cut from it stay, but can no longer be rendered again, because rendering reads the source. A compilation that uses the video will not build until the item is taken out. It is not possible while a clip is being made.
- **Deleting a clip:** each clip in the left column has a trash icon. It asks once, then deletes the clip's whole folder: the video, the post text and the working files. This cannot be undone. It is not possible while a clip is being made.
- **Clip:** watch the result, download it, see each brief rule as passed or failed, copy the post text, and fix caption words by typing over them. "Save words and render again" rebuilds the clip.
- **Unsaved changes:** the card, compilation and sources pages show "Changes not saved" until you save, and their Save button stays in view.

Only this computer can reach the dashboard; it is not visible on your network.

It uses port 4517, so it runs alongside other local projects on the usual ports (3000, 8000, 8080). Start it in its own terminal and leave that open. If 4517 is taken, pick another port and open that address instead:

```bash
CLIPPER_PORT=4600 npm run dashboard
```

`npm run dashboard` builds the pages each time it starts, which takes a second or two. While a clip renders, ffmpeg uses every CPU core for about a minute.

### Colours

The dashboard's colours come from a palette of five: the page, a tint, a highlight, a primary colour and the text colour. Three palettes come with it: Clay, which a browser starts with, Lagoon and Night. Choose one under "Colours" at the bottom of the left column; the choice is remembered in that browser.

To add your own, add one entry to `PALETTES` in `web/src/theme.js`:

```js
sunset: { name: 'Sunset', background: '#fff8f1', surface: '#ffe3c8', highlight: '#ffd166', primary: '#9c3d00', ink: '#3b1d0f' },
```

Everything else (borders, quiet text, hover colours, the text on buttons) is worked out from those five, and moved where needed so that text stays readable. The tint may be a strong colour: it is thinned with the page colour until text reads on it. The highlight marks step numbers, counts and "this one". Results (passed, failed, waiting) are always green, red and amber, whatever the palette, so a palette with an orange highlight does not make "passed" look like a warning. Set `DEFAULT_PALETTE` in the same file to change what a new browser starts with. `npm test` checks every palette for readable contrast.

Two things keep their own colours whatever the palette: match cards, which use the teams' colours, and the crop window drawn over the video, which has to show on any footage.

The Clips page and the command line do the same things and share the same `out/` and `parts/` folders, so you can mix them. The Cards and Compilations pages exist only in the dashboard, and so does the sources list; fetching works from both.

## Match cards and compilations

These two dashboard pages are for "goal reaction" compilations: streamers' reaction clips, with a card between them that says what just happened in the match. Open them with the buttons at the top left of the dashboard.

### Cards

1. Press "New match" and enter the two teams, their colours, and optionally the competition and date. These are shared by every card of the match.
2. Add cards:
   - **Goal:** scoring team, scorer, assist, minute (with added time, such as 45+2), goal type, and the score after the goal. The assist is left out for a penalty and an own goal.
   - **Red card:** player, team, minute, straight red or second yellow, and optionally the score.
   - **Full time:** the final score and the scorers. The lists are filled in from the goal cards; you can edit them, and "Fill from the goal cards" refreshes them.
3. The preview on the right updates as you type, in either size.
4. "Save match and cards" stores the match and a picture of each card in both sizes, which is what a compilation uses. "Export PNG" downloads one card at 1920×1080 or 1080×1920.

Every match and every card has a trash icon. It asks once, then deletes for good. Deleting a card of a saved match takes effect straight away, without pressing Save; deleting a match removes its cards and their pictures with it.

Cards are text only, with team colours as plain blocks: no crests, logos or photos. They are drawn with the font bundled in `assets/fonts`, so they look the same on every machine.

To add a goal type, add a line to `GOAL_TYPES` in `src/cards/config.js`.

### Compilations

1. Press "New compilation", name it, and choose the size: 1920×1080 or 1080×1920, both 30 fps.
2. Add videos. Anything already in the project (`in/`, your parts, your clips) is added without copying. You can also choose files from your computer or drop them on the page; those are copied into `in/`, so they take that much more disk space.
3. Add cards from a saved match.
4. Put the items in order by dragging them, or with "Up" and "Down". For each video you can set a start and end in seconds and a credit, the streamer's name, which is shown in the bottom left corner for the whole clip. For each card you set how long it is shown (3 seconds by default). The total length is shown under the list.
5. Press "Generate the video". Each item shows its progress. When it is done the video plays on the page, with a download link.

Next to the video, `description.txt` lists the credits (each streamer once, in order, with the channel's address when the name matches an agreed channel in your [sources list](#sources-and-fetching)) and chapter times taken from where the cards fall, starting at 0:00. Players usually want at least three chapters of ten seconds or more before they show them.

Each compilation in the list has a trash icon, which deletes it with its final video and description after asking once. The trash icon on a timeline item only takes that item out of the timeline.

Everything is kept in `data/`: matches in `data/matches`, and each compilation in `data/compilations/<name>` with its `timeline.json`, `final.mp4` and `description.txt`. A compilation can be reopened, changed and generated again. Only the items you changed are made again, so a second run is quick, and a run that failed carries on from where it stopped.

Clips of any size and frame rate can be mixed. Each is fitted inside the chosen size with black bars where needed, and its loudness is levelled so that clips from different streams sit together.

## Sources and fetching

The Sources page keeps a list of the channels you take clips from: name, channel address, a status (asked, agreed or declined) and a note of where and when they answered.

"Fetch part of a video" on the same page brings a part of a YouTube video into `in/`:

- **Only from a channel marked "Agreed".** The channel is read from the video itself, so a link to anyone else's video is refused.
- **A part, not the whole video.** You give a start and an end, up to 20 minutes. Long watchalongs are several gigabytes; a part is small.
- **Up to 1080p, with the picture exactly as YouTube sends it.** A video can only be cut without loss at certain frames, so the part starts up to a few seconds before the time you gave; the tool says by how much. Set the exact start when you cut.
- **YouTube links to one video only.** Playlists and channel links are refused.

The file is named after the channel, the video and the range, such as `channel-name_<video id>_1h02m00s-1h05m00s.mp4`, and then works like any other video in `in/`. When you add it to a compilation, its credit is filled in with the channel's name, and `description.txt` lists that channel's link next to the credit.

From the command line:

```bash
node src/cli.js fetch "https://www.youtube.com/watch?v=..." --start 1:02:00 --end 1:05:00
```

It needs the downloader program `yt-dlp`, which `npm run setup` installs into `.venv` next to the transcriber. YouTube changes often; when fetching stops working, run `npm run setup` again to update it.

The list is saved in `data/sources.json`, which is not part of the repository.

## AI help

Two optional features use an AI service. Everything else works without them.

- **Suggested moments:** proposes ranges worth clipping, each with a reason, a hook, a title and a description.
- **Caption fixes:** proposes corrections for words the transcriber misheard, such as names.

Both only propose. Nothing is cut, saved or rendered until you press the button yourself.

### Setting it up

There are two services to choose from.

**Claude, through Claude Code.** If [Claude Code](https://claude.com/claude-code) is installed and you have logged in (run `claude` once), nothing else is needed: the tool runs it in the background with the login it already has. No API key. It counts against your Claude plan's usage.

**OpenAI, with an API key.** Put the key in a file named `.env` in the project folder:

```bash
printf 'OPENAI_API_KEY=%s\n' 'your-key-here' > .env
```

`.env` is git-ignored, so the key is never pushed.

When both are available, Claude is used. To choose yourself, add a line to `.env`:

```
CLIPPER_AI=openai
```

or `CLIPPER_AI=claude`. Restart the dashboard after changing `.env`.

| Service | Default model | Setting to change it |
|---|---|---|
| Claude Code | `sonnet` | `CLIPPER_CLAUDE_MODEL`, for example `haiku` or `opus` |
| OpenAI | `gpt-6.2-sol` | `CLIPPER_AI_MODEL`, for example `gpt-6-luna` |

### What is sent

Only text: the video's transcript, or a clip's caption words, plus the brief's rules. The video, the audio and file names stay on your computer. Speech is still turned into text locally by Whisper.

In testing, suggestions for a 10-minute video took about 6 seconds either way once the transcript existed. With OpenAI it used about 5,300 tokens in and 550 out, around two cents.

### Using it

In the dashboard, press "Suggest moments" on the cutting screen. The first time on a video it transcribes the whole video, which takes a few minutes; the transcript is kept in `out/.cache` for next time. Suggestions appear as a list and as marks above the timeline. "Use this" fills in the range, hook, title and description for you to check before cutting. The suggestion you are working on is highlighted in the list and on the timeline, and one you have sent for cutting is marked "Already cut".

On a clip's screen, "Suggest fixes" marks the caption words it would change. Hover a marked word to see the original, edit as you like, then press "Save words and render again".

From the command line:

```bash
node src/cli.js suggest in/video.mp4 --count 5
node src/cli.js suggest in/video.mp4 --brief briefs/forgegui-basic.json
```

It prints each moment with a `cut` command for its range. Videos longer than 60 minutes are refused.

## Commands

| Command | What it does |
|---|---|
| `probe <file>` | Shows resolution, frame rate, duration, whether the video is vertical, and its audio tracks |
| `cut <file>` | Produces one finished clip in a new folder in `out/`, named after the hook |
| `render <clip-folder>` | Renders an existing clip folder again, for example after fixing a word in its transcript |
| `check <clip-folder>` | Checks an existing clip and its `post.txt` against a brief |
| `suggest <file>` | Asks an AI service for moments worth clipping (see [AI help](#ai-help)) |
| `extract <file>` | Saves a part of a video as it is, at the original size (see [Plain parts](#plain-parts)) |
| `fetch <link>` | Brings part of a YouTube video into `in/`, from an agreed channel (see [Sources and fetching](#sources-and-fetching)) |

Every command has built-in help: `node src/cli.js cut --help`.

### Options for `cut`

| Option | Meaning | Default |
|---|---|---|
| `--start <time>` | Start of the range | required |
| `--end <time>` | End of the range | required |
| `--layout <name>` | `center`, `blur` or `facecam` | `center` |
| `--crop-x <pixels>` | Left edge of the crop in source pixels, `center` layout only | centred |
| `--crop-width <pixels>` | Width of the crop in source pixels, `center` layout only. Wider than the 9:16 column shows more of the picture, over a blurred copy | the 9:16 column |
| `--cam <x,y,w,h>` | Webcam rectangle in source pixels, required for `facecam` | none |
| `--trim <pixels>` | Cut this many pixels off every edge of the source first | `0` |
| `--hook <text>` | Line shown at the top at the start of the clip, up to 60 characters | none |
| `--hook-seconds <seconds>` | How long the hook stays on screen; `0` keeps it for the whole clip | `2.5` |
| `--no-captions` | Skip transcription and captions | captions on |
| `--lang <code>` | Language spoken in the video | `en` |
| `--brief <file>` | Campaign brief to follow and check the clip against | none |
| `--title <text>` | Title for `post.txt` | the hook |
| `--desc <text>` | Description for `post.txt` | empty |
| `--out <dir>` | Output folder | `./out` |

Times can be seconds (`754.5`), `mm:ss` (`12:34.5`) or `hh:mm:ss` (`1:02:03`).

### Layouts

- **`center`** crops a 9:16 column out of the frame. Move it sideways with `--crop-x`. The column is about a third of a 16:9 picture, so a person who moves can leave it. `--crop-width` makes the crop wider: it is then shown whole in the middle of the screen, with a blurred copy of itself above and below. At the full width of the video it looks like `blur`.
- **`blur`** keeps the whole frame in the middle, over a blurred copy that fills the screen. Use it when nothing may be cropped away.
- **`facecam`** stacks the webcam rectangle (given with `--cam`) above the middle of the gameplay.

`--trim` is for a thin border baked into a recording, such as a rounded frame. It is limited to 5% of the shorter side of the video.

```bash
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout blur --trim 14
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --crop-x 700
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --crop-width 1000 --crop-x 200
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout facecam --cam 1400,40,480,270
```

## Plain parts

Sometimes you only want a piece of the video as it is: the same size and shape, with no reframing, no hook, no captions and no transcription.

```bash
node src/cli.js extract in/video.mp4 --start 1:00 --end 1:30
```

In the dashboard, set the start and end on the cutting screen and press "Save this part as it is". The layout, hook and brief settings are ignored for it.

Parts are kept apart from clips: all of them go into one folder, `parts/`, as single files named after the source and the range, such as `video_1m00s-1m30s.mp4`. The dashboard lists them under "Parts" in the left column, where you can play or delete them. To save somewhere else from the command line, add `--out <folder>`.

A part keeps the original size, frame rate and every audio track. It starts and ends exactly where you asked, because the picture is encoded again and not just copied; a 30-second part of a 720p video took about 17 seconds to make.

## What a clip folder contains

A clip's folder is named after its hook: the hook "Barca wants WHO?" gives `out/barca-wants-who`. If that name is taken, a number is added (`barca-wants-who-2`). A clip cut without a hook gets the next free number: `clip-001`, `clip-002` and so on. The `cut` command prints the folder it wrote.

```
out/barca-wants-who/
  clip.mp4            the finished video; this is what you upload
  post.txt            title, description and hashtags (with a brief, a title or a description)
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
node src/cli.js render out/barca-wants-who
```

This skips transcription, so it is quicker than a new `cut`. If the render fails, the old `clip.mp4` is left as it was.

In the dashboard, open the clip, type over the wrong word under "Captions", and press "Save words and render again".

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
node src/cli.js check out/barca-wants-who

# Against another brief
node src/cli.js check out/barca-wants-who --brief briefs/other.json
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

Some tests run the real `ffmpeg` on a small generated video, so `ffmpeg` and `ffprobe` must be installed, built with the `libx264`, `aac` and `libopus` encoders (check: `ffmpeg -encoders | grep -E "libx264|libopus"`). They do not need the transcriber or the downloader, and they never reach YouTube or an AI service.

The tests cover the engine and the dashboard's server. They do not cover the dashboard's pages; check those by opening them in a browser.

To work on the pages with live reload, run the dashboard in one terminal and `npm run dev:web` in another, then open http://127.0.0.1:4518.

## What it does not do

- Download whole videos, or anything from a channel not marked as agreed
- Upload or post anywhere
- Cut a clip on its own: the AI only suggests moments, and you choose
- Follow a moving speaker
- Remove watermarks or logos
