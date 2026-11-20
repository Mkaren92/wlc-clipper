# WLC Clipper

A tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, with burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires.

You can use it two ways, and mix them freely:

- **From the command line**, with `node src/cli.js` (see [Commands](#commands)).
- **From a dashboard in your browser**, with `npm run dashboard` (see [Dashboard](#dashboard)).

Optionally, an AI service can suggest which moments to clip and fix caption mistakes (see [AI help](#ai-help)).

The dashboard also has pages for building a longer video out of several pieces: [match cards and compilations](#match-cards-and-compilations), and [Combine](#combine-two-videos), which puts two videos side by side.

It works on files on your disk and it does not post anything. The one way video comes in from outside is [`fetch`](#sources-and-fetching), which takes part of a YouTube video from a channel in your sources list, where you add only channels that have agreed. The Sources page can also fetch those channels' profile pictures, to show beside their names.

## Requirements

- Node.js 22.12 or later
- `ffmpeg` and `ffprobe` on the PATH, built with libass (check: `ffmpeg -filters | grep subtitles`)
- Python 3 with the venv module, only for captions and for fetching from YouTube (on Ubuntu: `sudo apt install python3-venv`)

It has only been run on Linux. **On Windows**, it runs inside WSL: follow [docs/install-windows.md](docs/install-windows.md), a step-by-step guide from an empty computer to a first clip.

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
- **Activity:** while a clip is being cut, rendered again, fetched, combined, or searched for moments, the left column says what is happening and at which step, under "Activity". It is there on every page and after a reload. You can start another cut meanwhile; it waits its turn. When something is ready, it offers "Open".
- **Deleting a video:** each video in the left column has a trash icon. It asks once, then deletes the file from `in/`. Clips already cut from it stay, but can no longer be rendered again, because rendering reads the source. A compilation that uses the video will not build until the item is taken out. It is not possible while a clip is being made.
- **Deleting a clip:** each clip in the left column has a trash icon. It asks once, then deletes the clip's whole folder: the video, the post text and the working files. This cannot be undone. It is not possible while a clip is being made.
- **Clip:** watch the result, download it, see each brief rule as passed or failed, copy the post text, and fix caption words by typing over them. "Save words and render again" rebuilds the clip.
- **Unsaved changes:** the card, combine, compilation and sources pages show "Changes not saved" until you save, and their Save button stays in view.

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

Three things keep their own colours whatever the palette: match cards, which use the teams' colours, the crop window drawn over the video, which has to show on any footage, and the black behind a video player.

The Clips page and the command line do the same things and share the same `out/` and `parts/` folders, so you can mix them. The Cards, Combine and Compilations pages exist only in the dashboard, and so does the sources list; fetching works from both.

## Match cards and compilations

These dashboard pages are for "goal reaction" compilations: streamers' reaction clips, with a card between them that says what just happened in the match. A third page, [Combine](#combine-two-videos), puts a reaction and the goal itself side by side. Open them with the buttons at the top left of the dashboard.

### Cards

1. Press "New match". Choose a league and then the home and away club from your list (see [Leagues and clubs](#leagues-and-clubs)): that fills in each team's name, colour and logo, and the competition. Or type the two teams and pick their colours yourself. You can change anything for this match afterwards, and optionally add a date. These are shared by every card of the match.
2. Optionally add a club icon for each team: a picture from your own computer, which is shrunk and kept with the match. The tool does not fetch crests. Icons are shown on the intro card.
3. Add cards:
   - **Intro:** the opening card. It shows both clubs with their icons and names, and "V" between them, or the score if you switch it on. A team without an icon gets its first letter on its colour.
   - **Goal:** scoring team, scorer, assist, minute (with added time, such as 45+2), goal type, and the score after the goal. The assist is left out for a penalty and an own goal.
   - **Red card:** player, team, minute, straight red or second yellow, and optionally the score.
   - **Full time:** the final score and the scorers. The lists are filled in from the goal cards; you can edit them, and "Fill from the goal cards" refreshes them.
4. The preview on the right updates as you type, in either size.
5. "Save match and cards" stores the match and a picture of each card in both sizes, which is what a compilation uses. "Export PNG" downloads one card at 1920×1080 or 1080×1920.

Every match and every card has a trash icon. It asks once, then deletes for good. Deleting a card of a saved match takes effect straight away, without pressing Save; deleting a match removes its cards and their pictures with it.

Cards are text with team colours as plain blocks. The only pictures are the club icons you add yourself, on the intro card: no league logos or photos, and nothing fetched. Club crests belong to the clubs, so whether to use one is your call. Cards are drawn with the font bundled in `assets/fonts`, so they look the same on every machine.

To add a goal type, add a line to `GOAL_TYPES` in `src/cards/config.js`.

### Leagues and clubs

"Leagues and clubs", at the top of the Cards page, is your own list of teams to choose from when you start a match.

- **It starts with three leagues**, La Liga, the Premier League and Serie A, each with twenty clubs: a name and a main colour. They were written down from memory of the 2025–26 season, as a starting point, so check them: clubs go up and down every year.
- **A club is a name, a colour and a logo.** The logo is a picture you add from your own computer; none comes with the list and the tool fetches none. Club crests belong to the clubs, so using one is your call.
- **Add a league** with "New league", for example "Countries" for national teams, and add clubs to whichever league is chosen. Rename or recolour a club by changing it in place, and delete with the trash icon. Deleting a league deletes its clubs.
- **Changes are saved as you make them**, in `data/clubs.json`.
- **A match keeps its own copy** of what it took from a club. Changing or deleting a club later does not change matches you already made.

### Compilations

1. Press "New compilation", name it, and choose the size: 1920×1080 or 1080×1920, both 30 fps.
2. Add videos. Anything already in the project (`in/`, your parts, your clips, and the videos made on the [Combine page](#combine-two-videos)) is added without copying. You can also choose files from your computer or drop them on the page; those are copied into `in/`, so they take that much more disk space.
3. Add cards from a saved match. A card plays a sound while it is shown (see [Sounds under cards](#sounds-under-cards)).
4. Put the items in order by dragging them, or with "Up" and "Down". For each video you can set a start and end in seconds, [a second video shown beside it](#a-second-video-beside-a-reaction), and a credit, the streamer, chosen from the channels on the [Sources page](#sources-and-fetching). The channel's picture and name are shown in the bottom left corner for the whole clip, on a dark plate with a pale edge and a soft shadow so they stand out on any footage. A channel with no picture yet shows its name only; press sync on its row in Sources to get the picture. For each card you choose its sound and, if you want, how long it is shown (by default, as long as its sound). The total length is shown under the list.
5. Press "Generate the video". Each item shows its progress. When it is done the video plays on the page, with a download link.

Next to the video, `description.txt` lists the credits (each streamer once, in order, with the channel's address when the name matches a channel in your [sources list](#sources-and-fetching)) and chapter times taken from where the cards fall, starting at 0:00. Players usually want at least three chapters of ten seconds or more before they show them.

Each compilation in the list has a trash icon, which deletes it with its final video and description after asking once. The trash icon on a timeline item only takes that item out of the timeline.

#### A second video beside a reaction

A video in the timeline can have another video shown beside it, for a streamer's reaction with the goal they are reacting to. Tick "Show another video beside it" on the reaction, choose the other video, and set its start and end if you want only part of it.

- **While the second video runs, the screen is split**, and each video fills its half with the middle of its picture. In a wide compilation the reaction is on the left half and the second video on the right: the middle 50% of each. In a tall compilation the second video is on top and the reaction below.
- **When the second video ends, the reaction fills the screen**, on the very next frame. The reaction plays through without a break; only how it is shown changes. A 10-second reaction with a 5-second goal gives 5 seconds split and 5 seconds full.
- **Sound:** the reaction's sound runs throughout at its usual level. For the second video's sound there are three choices under "Its sound": quiet, under the reaction (about 70–30, and what a new one starts with); as loud as the reaction (about 50–50); or off.
- **Both are cropped to their middle** in the split, so a streamer who sits to one side, or a goal near the edge of the picture, is partly cut off there. To choose the part shown, the side, or how the two line up, use the [Combine page](#combine-two-videos) instead.
- A second video longer than the reaction is cut off when the reaction ends.

Both videos are files already in the project: put the goal footage in `in/` like any other video.

#### Sounds under cards

Every card in a compilation has a sound under it, and is shown exactly as long as that sound plays. Left on "Automatic", a goal card gets a voice saying "Goool", a red card gets a tragic chord, and a full-time card gets a soft whistle. An intro card is silent until you supply a sound for it. On each card in the timeline you can choose another sound or "No sound", and "Listen" plays it before you generate.

- **The built-in sounds are made by the tool**: the voice is the computer voice inside ffmpeg with its vowel stretched, and the other two are plain tones. They are not recordings, so nothing is downloaded and nobody's rights are involved. They are also only stand-ins: listen to them, and use your own where you want the real thing.
- **Your own sounds, the easy way:** put a file named `intro`, `goal`, `red` or `fulltime` in the project's `sounds/` folder (for example `goal.mp3`, a recording of yourself shouting it). Every card of that kind left on "Automatic" then uses it, with nothing to choose.
- **Your own sounds, card by card:** any other audio file in `sounds/` (`.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.flac`) can be chosen on a card after a reload. Use only sounds you are allowed to use. The folder is not part of the repository.
- **A video as a moving background:** a video file in `sounds/` (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`) can be put under a card too. Its sound plays, and its picture moves behind the card, dimmed a little so the words stay readable. Named after a kind of card, such as `intro.mp4`, it is used for every card of that kind, ahead of a sound file of the same name. The card maker's preview still shows the plain background; the video appears in the compilation. After adding the first video, open the match in the card maker and press "Save match and cards" once, so each card gets the see-through picture this needs.
- **The card's length follows the sound.** Leave "Shown for" empty and the card lasts as long as its sound, or 3 seconds with no sound. Type a number to fix the length yourself: a longer sound is then faded out as the card ends, and after a shorter one the rest of the card is silent. The sound never carries on into the next clip.
- **Loudness is levelled**, a little under the clips, so a quiet file and a loud one come out alike. The soft whistle is played quieter still.
- **Compilations made before this** get the automatic sounds the next time you press "Generate the video". Their cards keep the 3 seconds they were saved with; empty the "Shown for" box to make a card follow its sound.

Everything is kept in `data/`: matches in `data/matches`, and each compilation in `data/compilations/<name>` with its `timeline.json`, `final.mp4` and `description.txt`. A compilation can be reopened, changed and generated again. Only the items you changed are made again, so a second run is quick, and a run that failed carries on from where it stopped.

Clips of any size and frame rate can be mixed. Each is fitted inside the chosen size with black bars where needed, and its loudness is levelled so that clips from different streams sit together.

## Combine two videos

The Combine page puts two videos side by side, such as a streamer's reaction and the goal being reacted to, and makes one video of them. You line them up by watching, not by typing numbers blind.

1. Press "New combination", name it, and choose the size: wide (left and right) or tall (top and bottom).
2. Choose the left video and the right video from your videos, parts and clips.
3. Mark one as the **main video**. It sets the length of the result, and it gets the whole screen once the other video has ended.
4. Set where each video starts with its slider; the preview shows that frame at once. Press "Play both" to watch and hear them together, and nudge a start by 0.1 s or 1 s until they are in step. "Ends at" cuts a video short.
5. Choose the part of each video that shows while the screen is split: zoom in, and move left or right, up or down. This is how a streamer who sits off-centre is brought into view.
6. Choose how the screen is shared while it is split: equal (50–50), or the main video larger (60–40 or 70–30).
7. Choose the sound: the main video in front with the other quieter (about 70 to 30), both about the same, or only the main video. The balance in the preview is only rough.
8. Press "Make the combined video". It plays on the page when it is done.

The preview and the finished video are worked out by the same code, so what you see is what is made. "Swap sides" puts the two videos the other way round.

To use a combined video, open Compilations and add it from the "Combined" list under "Add videos". It is then an ordinary item: it can have a credit, a start and an end. If you change a combination afterwards, make its video again; the list marks one whose settings have changed since it was made.

Each combination is kept in `data/combinations/<name>` with its settings and `combined.mp4`.

## Sources and fetching

The Sources page keeps the list of channels you take clips from: a name and the channel's address for each. Add a channel only once it has agreed to let you use its videos; being in the list is what allows fetching from it.

"Get the channels' pictures" fetches the profile picture of every channel in the saved list from YouTube and keeps each as a small round picture in `data/source-pictures/`. The page shows them next to the names, and a compilation draws a channel's picture beside its name wherever it is credited. Press it again after adding a channel, or when a channel changes its picture; a compilation generated afterwards uses the new one. `description.txt` is plain text, so it has no pictures. Removing a channel removes its picture.

To add a channel quickly, press "Add a channel", paste only its address, and press the round arrows on its row. The channel's name and picture are filled in from YouTube and the channel is saved to the list. A name you typed yourself is kept, so on a channel you already have the button only refreshes the picture. Change the name afterwards if you want another spelling, and press "Save the list".

"Fetch part of a video" on the same page brings a part of a YouTube video into `in/`:

- **Only from a channel in your list.** The channel is read from the video itself, so a link to anyone else's video is refused.
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
| `fetch <link>` | Brings part of a YouTube video into `in/`, from a channel in your sources list (see [Sources and fetching](#sources-and-fetching)) |

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

- Download whole videos, or anything from a channel that is not in your sources list
- Upload or post anywhere
- Cut a clip on its own: the AI only suggests moments, and you choose
- Follow a moving speaker
- Remove watermarks or logos
