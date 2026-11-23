# WLC Clipper

A tool that turns a local video file and a time range into a finished vertical clip: 1080×1920, 30 fps, with burned-in captions, an optional hook line, and the on-screen text and hashtags a campaign brief requires.

You can use it two ways, and mix them freely:

- **From the command line**, with `node src/cli.js` (see [Commands](#commands)).
- **From a dashboard in your browser**, with `npm run dashboard` (see [Dashboard](#dashboard)).

Optionally, an AI service can suggest which moments to clip and fix caption mistakes (see [AI help](#ai-help)).

The dashboard also has pages for building a longer video out of several pieces: [match cards and compilations](#match-cards-and-compilations), and [Combine](#combine-two-videos), which puts two videos side by side. A [My data](#my-data-moving-to-another-computer) page carries your channels, clubs, logos, sounds and briefs to another computer.

It works on files on your disk and it does not post anything. The one way video comes in from outside is [`fetch`](#sources-and-fetching), which takes part of a YouTube video, or a whole one up to 3 hours, from a channel in your sources list, where you add only channels that have agreed. The Sources page also looks up those channels' profile pictures and subscriber counts, and shows which of them are live.

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

- **Cut:** pick a video in the left column. It plays on the left and stays in view while you set the range, the layout, the text and the brief on the right. Drag the bright window over the video to place the crop (for the facecam layout, two boxes: the yellow one over the webcam, with any shape or 16:9, 4:3 or 1:1 under "Webcam shape", and the blue one over the content shown below it; each is moved and resized on its own). With the center layout, the "Show more of the picture" slider makes the crop wider, for a person who moves out of the narrow column. The bar at the bottom of the screen always shows what will be made, anything that is in the way, and "Cut the clip". Swear words in the captions and the hook are drawn as `F*CK` and muffled in the voice; two boxes under "Text" turn either off for the clip.
- **Keys for the player:** Space plays and pauses, the left and right arrows move one second (a tenth with Shift), I sets the start, O sets the end, and P plays the range. They do nothing while you are typing in a box, and they go by the key's place on the keyboard, so they work on a keyboard set to another alphabet.
- **Activity:** while a clip is being cut, rendered again, fetched, combined, or searched for moments, the left column says what is happening and at which step, under "Activity". It is there on every page and after a reload. You can start another cut meanwhile; it waits its turn. When something is ready, it offers "Open". Anything waiting or running has a **Stop** button: the work ends within a few seconds, what it was making is thrown away, and the next job in line starts. Nothing that was already finished is touched.
- **Deleting a video:** each video in the left column has a trash icon. It asks once, then deletes the file from `in/`. Clips already cut from it stay, but can no longer be rendered again, because rendering reads the source. A compilation that uses the video will not build until the item is taken out. It is not possible while a clip is being made.
- **Deleting a clip:** each clip in the left column has a trash icon. It asks once, then deletes the clip's whole folder: the video, the post text and the working files. This cannot be undone. It is not possible while a clip is being made.
- **Clip:** watch the result, download it, see each brief rule as passed or failed, copy the post text, and fix caption words by typing over them. "Save words and render again" rebuilds the clip.
- **Download:** paste a YouTube link from one of your channels and bring a part of the video, or the whole of it, into `in/`; or paste a finished live stream and get the moments its chat exploded as clips (see [Sources and fetching](#sources-and-fetching)).
- **My data:** keeps what you chose to carry the same on every computer through a private GitHub repository of yours, by itself; and, as a fallback, one file to download and load on another computer (see [My data](#my-data-moving-to-another-computer)).
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

- **It starts with four leagues**, each club with a name and a main colour. La Liga and the Premier League hold the twenty clubs of the 2026–27 season. "Europe" holds 22 leading clubs of Italy, France, Germany and Portugal. "Champions League" holds the 36 clubs of the 2026–27 league phase. It is a starting point: clubs go up and down every year, and the colours are approximate.
- **A club in two leagues is two entries**, for example Real Madrid in La Liga and in the Champions League. A logo or colour changed on one is not changed on the other.
- **A list you already have is not changed by an update of the tool.** The starting list is written out once, the first time, and is yours from then on.
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

"Update pictures and subscribers" fetches the profile picture of every channel in the saved list from YouTube and keeps each as a small round picture in `data/source-pictures/`. It also reads each channel's subscriber count, shown at the end of its row (hover over it for the full number and the day it was read). YouTube gives that number rounded, and not at all for a channel that hides it. The page shows them next to the names, and a compilation draws a channel's picture beside its name wherever it is credited. Press it again after adding a channel, or when a channel changes its picture; a compilation generated afterwards uses the new one. `description.txt` is plain text, so it has no pictures. The trash icon on a row asks once and then removes the channel at once, with its picture and subscriber count; videos already fetched from it stay.

The list is shown with the most subscribers first, and each row has a small arrow icon that opens the channel on YouTube in a new tab.

The page also shows **who is live**. A channel that is broadcasting on YouTube is marked LIVE and moved to the top of the list; the mark opens the stream, and hovering over it shows when it started, how many are watching and its title. The Sources button in the left column shows the number of live channels on every page. YouTube is asked when the dashboard is opened and then every five minutes while it is on screen, and "Check who is live" asks at once. A part of a stream can be fetched only after it has ended.

Under **"Supports"** on a channel's row you can mark the club the streamer supports, chosen from your own [leagues and clubs](#leagues-and-clubs). Click the cell, type to find a club, and click it: it is saved at once and shows as a small logo on the row. Choosing another club changes it, and choosing the same one again takes it off. A club that is in two leagues is listed once.

To add a channel quickly, press "Add a channel", paste only its address, and press the round arrows on its row. The channel's name, picture and subscriber count are filled in from YouTube and the channel is saved to the list. A name you typed yourself is kept, so on a channel you already have the button only refreshes the picture and the count. Change the name afterwards if you want another spelling, and press "Save the list".

The **Download** page (its own button in the left column) brings a part of a YouTube video, or the whole of one, into `in/`. Paste the link, give "From" and "To" or tick "Whole video", and press Download. The page checks the link and the length while you type, says so if the link is a stream one of your channels is broadcasting right now, and shows the progress with a Stop button. When it is done it names the file and offers "Open it to cut". Under "You can download from" it lists the channels in your list. The rules:

- **Only from a channel in your list.** The channel is read from the video itself, so a link to anyone else's video is refused.
- **A part of up to 3 hours (20 minutes until 2026-11-21), or the whole video of up to 3 hours.** For a part you give a start and an end. For a whole video the length is read from YouTube, and a video over 3 hours, or one whose length YouTube does not give, is refused before anything is downloaded. A whole video is large (a 19½-minute one was 280 MB; a three-hour watchalong may be 2 to 3 GB), so delete it once it is clipped. "Suggest moments" works on videos up to 60 minutes.
- **Quick.** 20 minutes came down in about 16 seconds on a 100 Mbit/s line, and a whole video of about an hour and a half in about 20 seconds. The tool asks YouTube for the video in small slices, a few at a time, which YouTube sends at full speed; asked for in one go, YouTube sends it at little more than playback speed. If that ever stops working, the tool falls back to the slow way by itself, and says so: the progress line reads "the slow way", and the page shows why when it is done.
- **Up to 1080p, with the picture exactly as YouTube sends it.** A video can only be cut without loss at certain frames, so the part starts up to a few seconds before the time you gave; the tool says by how much. Set the exact start when you cut.
- **YouTube links to one video only.** Playlists and channel links are refused.
- **Not from a stream that is still live.** A live stream can only be recorded as it happens; a part cannot be cut out of it. Wait until the stream has ended and plays as an ordinary video. A stream that has only just ended is refused too, until YouTube has finished preparing it.

The file is named after the channel, the video and the range, such as `channel-name_<video id>_1h02m00s-1h05m00s.mp4`; a whole video is named from 0 to its length, such as `channel-name_<video id>_0m00s-1h31m10s.mp4`. It then works like any other video in `in/`. When you add it to a compilation, its credit is filled in with the channel's name, and `description.txt` lists that channel's link next to the credit.

**Clips from a stream's chat**, the second section of the Download page, works the other way round: paste the link of a **finished live stream**, optionally a few words (`goal, penalty`), and how many clips you want (6), and press "Get the clips". The tool reads the stream's chat and its top comments (not the video), finds its best moments, and downloads only those parts: 30 seconds before to 30 seconds after each one, so 1-minute clips (15 and 15 at first, 20 and 20 for 40-second clips, then 30 and 30 on 2026-11-22). Change the seconds under "Seconds before and after".

A best moment is found two ways:

- **Where chat reacted**, not where it was merely busy. Laughing (lol, lmao, kekw, 😂, 💀), hype (**W**, let's go, pog, sheesh, 🔥), shock (omg, no way, wtf, yooo), a loss (**L**, rip, F, unlucky) and "clip it" count; commands (`!me`), poll votes ("1", "3"), a plain "yes" or "no" answering the streamer, and the same sentence pasted by many people do not. A shouted "YESSSS" or "NOOOOO" counts. The words are in `src/chat/reactions.js`, one list per kind, to add to. A chat moment is taken 5 seconds before the chat, since people type after they see it.
- **Where viewers pointed in the comments**: "3:45:40 the jump scare", "9:59:42 THE ONE SHOWER SCENE". Two or more comments pointing at the same moment rank as high as anything, and the clip covers all of their times. A moment both chat and comments found rises to the top.

- **With words**, moments where at least two messages (or a comment) hold them come first; if there are fewer than you asked for, the rest are the best other moments, and the page says how many matched. A word from the Football or Gaming words brings its group: "goal" also counts gol, golazo and GOOOOL.
- **Without words**, the best moments.
- Each clip says why it was chosen: how many people reacted and how ("31 people: shock 21, laughing 9"), and what viewers wrote.
- **A quiet chat** is handled too: the tool asks less of it until it finds enough moments, but a chat of a few messages a minute is mostly greetings and side talk, so it finds fewer real moments. Only the words and like counts of comments are used, never who wrote them.
- **Only a finished live stream has a chat.** An uploaded video has comments, not chat, and is refused with a message saying so.
- The clips are ordinary videos in `in/`, named by the stream and their time, such as `papillon_<id>_2h09m15s-2h09m45s.mp4`, with an "Open" button for each. The stream's chat is kept (`data/chats/youtube-<id>.json`), so asking again, or fetching the chat of one of these clips on the cutting screen, does not download it again.
- Asking again gives the same parts, since they come from the same chat. Tick **"Skip parts already suggested for this stream"** for new ones: every part of that stream you were given before (kept in `data/chats/suggested/<id>.json`, on this computer only), and every part of it already in `in/`, is left out, and the next-best moments are taken instead. When none are left, it says so.

On a 2 h 14 min watchalong, six clips took 2 minutes: 21 s to read 1,421 chat messages, then 15 to 22 s a clip. Reading the comments takes a few seconds. A busy chat takes longer to read: an 11-hour stream with 54,000 messages took tens of minutes, because the downloader reads the chat replay in order, piece by piece.

From the command line:

```bash
node src/cli.js fetch "https://www.youtube.com/watch?v=..." --start 1:02:00 --end 1:05:00
node src/cli.js fetch "https://www.youtube.com/watch?v=..." --whole
```

It needs the downloader program `yt-dlp`, which `npm run setup` installs into `.venv` next to the transcriber. YouTube changes often; when fetching stops working, run `npm run setup` again to update it.

The list is saved in `data/sources.json`, which is not part of the repository.

### Signing in to YouTube

After many lookups from one connection, YouTube may answer every request with "Sign in to confirm you're not a bot" for a few hours. To get past it, give the downloader a YouTube sign-in: a cookies file saved from your browser.

**Use a spare Google account, not your main one.** YouTube can flag or suspend an account it sees being used by a downloader. The file is a login: anyone who has it is signed in as that account.

1. In Chrome, add the extension **Get cookies.txt LOCALLY** (check the name exactly; it saves the file on your computer and sends it nowhere). Allow it in Incognito in the extension's settings.
2. Open an **Incognito** window, sign in to YouTube with the spare account, then open `https://www.youtube.com/robots.txt` in the same tab.
3. Click the extension and press **Export** for `youtube.com`. Then **close the Incognito window** without signing out, so the saved sign-in stays valid.
4. Move the file into the project, in a WSL terminal (the extension saves it in your Downloads folder, with a name like `www.youtube.com_cookies.txt`):

   ```bash
   cd ~/wlc-clipper
   mv /mnt/c/Users/<you>/Downloads/www.youtube.com_cookies.txt data/youtube-cookies.txt
   ```

From then on the downloader uses it for every YouTube request: video downloads, chat replays, channel pictures and the live check. No restart is needed. The tool makes the file readable by you only, never prints it, and leaves it out of "My data"; `data/` is not in the repository. To sign out, delete `data/youtube-cookies.txt`. If YouTube refuses again even so, save the file again: sign-ins expire.

**What is saved when.** The club a streamer supports and the removal of a channel are saved the moment you make them. A name or an address you type is saved with "Save the list" or with the row's sync arrows, and the browser asks before a reload would lose one.

**Backups.** Before the channels list or the clubs list is changed, the list as it was is copied into `data/backups/sources/` (the newest 40 copies) or `data/backups/clubs/` (the newest 5). Each copy is named by its date and time. To go back to one, stop the dashboard and copy it over the list, for example:

```bash
cp "data/backups/sources/2026-11-20T18-22-45-123Z.json" data/sources.json
```

## My data: moving to another computer

The public repository holds the code. What you have made or added stays on the computer it was made on, unless you carry it. The **My data** page carries the part you chose in two ways: **Sync with GitHub**, which keeps it the same on every computer by itself, and one file to download and load by hand.

**What travels, either way:**

- your channels, with the club each streamer supports, their pictures and subscriber counts
- your leagues and clubs, with all their logos
- your sound files, among them a video used behind the intro card
- your overlay images (the logos in `overlays/`)
- your briefs

**What stays on the computer it was made on:** source videos, parts, clips, combinations, compilations, and matches with their cards. Your AI key and your YouTube sign-in are never carried; copy the file `.env` by hand if you use one.

### Sync with GitHub

Your data goes to a **private** repository of your own on GitHub, separate from the public one with the code. Each computer needs `git` and an SSH key that your GitHub account accepts (`ssh -T git@github.com` must greet you by name).

1. On GitHub make a new repository: any name, such as `wlc-clipper-data`, **Private**, nothing else ticked.
2. On the computer that has your data, open "My data", paste the repository's address (as the browser shows it is fine), press "Check this address", then "Connect and send".
3. On every other computer do the same. The page shows what is on GitHub beside what is there and asks whose lists to keep: choose "Take GitHub's data onto this computer".

The steps for a second computer, with what to do when GitHub does not know it yet, are in [docs/home-pc.md](docs/home-pc.md).

From then on nothing needs pressing. The dashboard syncs when it starts and within a minute of a change, here or on the other computer. The section shows "In sync", what last arrived or was sent, and has "Sync now". The "My data" button in the left column shows "check sync" when something needs a look.

- **The tool refuses** the repository that holds the code, and a repository that is public.
- **Changed on both computers before they synced:** different channels or clubs are put together. If the very same channel or club was changed on both, the one sent first is kept, the page says which, and the other is still in the repository's history.
- **Nothing is deleted here.** A file that was replaced or removed on the other computer is moved into `data/backups/sync/` (the newest 20 rounds are kept). When a computer connects, its lists as they were are kept in `data/backups/before-connect-<date and time>/`.
- **No internet:** nothing changes, and your work is sent on the next try.
- **"Save the list" on the Sources page** is refused when the list changed since the page read it (a sync brought something from the other computer). Reload the page and make the change again; anything typed and not saved is lost by the reload.
- "Disconnect" stops syncing on that computer. Its data stays, and so does what is on GitHub.

### By hand, with one file

**To take your work to another computer:**

1. Here, open "My data" and press "Download my data". The file is a few tens of megabytes.
2. On the other computer, install the project from GitHub (on Windows, follow [docs/install-windows.md](docs/install-windows.md)) and start the dashboard.
3. There, open "My data", choose the file under "Load my data", look at what it shows, and press "Load it".

**What a load does.** You are first shown what the file holds beside what that computer has, and a list of what would be replaced. Nothing changes until you press "Load it". Then:

- A file from the data file takes the place of the file with the same name there. Your channels list, your clubs list and the subscriber counts are replaced whole.
- **Nothing is deleted.** Whatever is replaced is moved into a folder named `data/backups/before-load-<date and time>/`, which the tool never cleans out. To undo a load, copy things back from there.
- Anything on that computer that the file does not hold is left as it is, including everything that stays local.

**Coming back** works the same way: download on the other computer, load here. Load the newer file onto the older computer, not the other way round: the page warns when the file has fewer channels, clubs or logos than the computer you are loading onto.

The file is an ordinary `.tar` file, so any archive program can open it.

## AI help

Two optional features use an AI service. Everything else works without them.

- **Suggested moments:** proposes ranges worth clipping, each with a reason, a hook, a title and a description. They can also come from a finished stream's chat, found on your computer (see [Moments from the chat](#moments-from-the-chat)).
- **Caption fixes:** proposes corrections for words the transcriber misheard, such as names.
- **Hooks:** "Suggest" beside the hook box on the cutting screen proposes three hooks for the clip you are setting up, about the moment and how the streamer feels rather than what they say: one about the reaction, one about the stakes, one question. It is given the words spoken in the range, the streamer's name (from the sources list, or the channel tag), where the voice is much louder than usual (measured on your computer; only times and decibels are sent, never the sound), and, if you tick "Let Suggest use chat's reactions", how many chat messages of each kind (laughing, shock, hype, fail) reacted to the range (never the messages or who wrote them). Click one to put it in the box; change it as you like. It uses the whole-video transcript if one was already made, and otherwise transcribes only the range (a few seconds). With a brief, a hook that breaks one of its rules (a word the screen must show, a forbidden word) is marked.

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

Only text: the video's transcript, or a clip's caption words, plus the brief's rules and your event words and guidance. With the AI check of chat moments ticked, also the chat messages' words and times. For hook suggestions, also the streamer's name, the times and loudness (in decibels) of stretches where the voice is much louder than usual, and, if ticked, how many chat messages of each kind reacted. Never who wrote a chat message. The video, the audio and file names stay on your computer. Speech is still turned into text locally by Whisper.

In testing, suggestions for a 10-minute video took about 6 seconds either way once the transcript existed. With OpenAI it used about 5,300 tokens in and 550 out, around two cents.

### Using it

In the dashboard, "Suggested moments" is on the cutting screen. Choose where the moments come from: **Transcript** (as before), **Chat** or **Both**. With Transcript, press "Suggest moments": the first time on a video it transcribes the whole video, which takes a few minutes; the transcript is kept in `out/.cache` for next time. The AI's answer is kept too, per video and per set of inputs, so the same inputs give the same list at once; tick "Ask again" for a new answer. Changing the event words or the guidance asks the AI again without transcribing again.

Moments appear as one list and as marks above the timeline. Each shows its time, which can be edited, its score, where it was found (transcript, chat or both) and its label. "Send to cut" fills in the range, hook, title and description for you to check before cutting. Clicking a moment's number jumps the video there. The moment you are working on is highlighted, and one you have sent for cutting is marked "Already cut". Filters show only the moments from one source, or with one label.

**What to look for** (optional, used by both sources):

- **Events**: groups of words, each with a name, such as Goal: goal, gol, golazo, what a goal. "Football" and "Gaming" load a ready set you can change. Words are matched whole, any case, with accents and stretched letters ignored: "GOOOOL" counts as "gol", and "pen" does not match "open".
- **Guidance**: a sentence on what a good moment is for this video, such as "big reactions to goals and referee decisions".

With events or guidance, the AI is told about them, is shown the transcript lines where the words were found (as leads to check, not as facts), and names the event each moment is, or none. Without them, it is asked exactly what it was asked before.

### Moments from the chat

A finished live stream's chat shows where viewers reacted. The tool finds bursts of chat on your computer: where many different people wrote much more than usual. Nothing is sent anywhere for this, and the video is not transcribed.

1. Open the video and, under "Chat", paste the stream's link and press "Fetch the chat", or import a chat file (JSON or CSV with a time and a text per message). Only the chat is downloaded, never the video, and only from a channel in your [Sources list](#sources-and-fetching). A stream that is live, or has only just ended, has no chat replay yet.
2. **Offset**: how far into the stream your video begins. For a part downloaded on the Download page it is filled in from the file's name. Change it if the chat and the video do not line up.
3. Choose Chat or Both. The chat's moments appear straight away, with a chart of messages across the video: the bursts, the usual rate, a line for each event, and the transcript's moments along the top. Click the chart to jump there.
4. **Chat settings** change the list as you type: how many times the usual rate a burst must be (3), how many messages per 5 seconds at least (8), and how many seconds before and after to keep (15 and 10). A quiet chat needs lower numbers. With events, choose whether event words raise a moment, are required, or are ignored.
5. **AI check** (off unless you tick it): asks the AI, in one request, what happened in each chat moment, from the chat's words and, if the video was already transcribed, what the streamer said. It sends the messages' words and times, never who wrote them. When the AI and the event words disagree, the moment is marked "needs review" and both are shown. If the check fails, the event words' labels are kept.

With **Both**, a moment found by both sources becomes one item tagged with both, and those rise to the top of the list. A moment only one source found is kept. A chat moment shows what was said in it, if the video was transcribed; a transcript moment shows how busy the chat was.

Chats are kept in `data/chats/`, one per video, and stay on this computer: they are not in the "My data" file.

On a clip's screen, "Suggest fixes" marks the caption words it would change. Hover a marked word to see the original, edit as you like, then press "Save words and render again".

From the command line:

```bash
node src/cli.js suggest in/video.mp4 --count 5
node src/cli.js suggest in/video.mp4 --brief briefs/forgegui-basic.json
node src/cli.js suggest in/video.mp4 --preset football --guidance "big reactions to goals"
node src/cli.js suggest in/video.mp4 --terms my-terms.json --again
```

It prints each moment with a `cut` command for its range, and its event when there is one. Videos longer than 60 minutes are refused. `--terms` reads a JSON file such as `[{ "label": "Goal", "terms": ["goal", "gol"] }]`, `--preset` is `football` or `gaming`, and `--again` asks the AI again instead of showing the answer kept for the same inputs. Moments from the chat are in the dashboard only.

## Commands

| Command | What it does |
|---|---|
| `probe <file>` | Shows resolution, frame rate, duration, whether the video is vertical, and its audio tracks |
| `cut <file>` | Produces one finished clip in a new folder in `out/`, named after the hook |
| `render <clip-folder>` | Renders an existing clip folder again, for example after fixing a word in its transcript |
| `check <clip-folder>` | Checks an existing clip and its `post.txt` against a brief |
| `suggest <file>` | Asks an AI service for moments worth clipping (see [AI help](#ai-help)) |
| `extract <file>` | Saves a part of a video as it is, at the original size (see [Plain parts](#plain-parts)) |
| `fetch <link>` | Brings part of a YouTube video (`--start`, `--end`), or a whole one up to 3 hours (`--whole`), into `in/`, from a channel in your sources list (see [Sources and fetching](#sources-and-fetching)) |

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
| `--game <x,y,w,h>` | Content rectangle in source pixels for `facecam`, shown below the webcam | the middle of the gameplay |
| `--blur <x,y,w,h,start,end[,black]>` | Blur a part of the frame (source pixels) for part of the clip (seconds from the clip's start); `,black` blacks it out instead. Repeat for more boxes, up to 20 (see [Blur boxes](#blur-boxes)) | none |
| `--trim <pixels>` | Cut this many pixels off every edge of the source first | `0` |
| `--hook <text>` | Line shown at the top at the start of the clip, up to 60 characters | none |
| `--hook-seconds <seconds>` | How long the hook stays on screen; `0` keeps it for the whole clip | `2.5` |
| `--tag <text>` | The streamer's channel, such as `@theburntpeanut`, up to 40 characters, drawn in capitals at the top for all the footage (not on the end card). The hook then sits just under it. On the cutting screen, a video fetched from a channel in the sources list offers that channel's handle with one click | none |
| `--no-captions` | Skip transcription and captions | captions on |
| `--no-censor` | Show swear words in the captions and the hook as they are. Without it they are drawn with a letter covered (`F*CK`, `SH*T`); the voice, the saved transcript and `post.txt` are not changed. On the page: "Cover swear words (F*CK)" | covered |
| `--no-muffle` | Leave the sound as it is while a swear word is spoken. Without it the sound is muffled over the middle of each such word (about 60% of it), so you hear that something is said, and how the word begins and ends, but not the word. Needs captions (they give the word times); a word the speech recogniser missed is not muffled. On the page: "Muffle them in the voice" | muffled |
| `--lang <code>` | Language spoken in the video | `en` |
| `--brief <file>` | Campaign brief to follow and check the clip against | none |
| `--title <text>` | Title for `post.txt` | the hook |
| `--desc <text>` | Description for `post.txt` | empty |
| `--overlay <file>` | A PNG or WebP shown for the whole clip: a logo, or a full 9:16 picture (see [Logo overlay](#logo-overlay)) | none |
| `--overlay-width <pixels>` | The logo's width in the clip | `220` |
| `--overlay-position <corner>` | `top-left`, `top-right`, `bottom-left` or `bottom-right` | `top-left` |
| `--overlay-margin <pixels>` | Distance from the corner's edges | `40` |
| `--overlay-offset <pixels>` | Moves the logo down (or up, with a minus sign), for example into the gameplay half of the facecam layout | `0` |
| `--out <dir>` | Output folder | `./out` |

Times can be seconds (`754.5`), `mm:ss` (`12:34.5`) or `hh:mm:ss` (`1:02:03`).

### Layouts

- **`center`** crops a 9:16 column out of the frame. Move it sideways with `--crop-x`. The column is about a third of a 16:9 picture, so a person who moves can leave it. `--crop-width` makes the crop wider: it is then shown whole in the middle of the screen, with a blurred copy of itself above and below. At the full width of the video it looks like `blur`.
- **`blur`** keeps the whole frame in the middle, over a blurred copy that fills the screen. Use it when nothing may be cropped away.
- **`facecam`** stacks the webcam rectangle (given with `--cam`) above the middle of the gameplay. The webcam panel takes the rectangle's shape, so nothing of a 4:3 or square webcam is cut off: full width, as tall as that shape makes it (606 px for 16:9, 810 for 4:3, 1080 for a square), between 480 and 1152 px so the gameplay keeps at least 40% of the screen. A webcam wider or taller than that loses a little of its edges. The hook sits just under the webcam panel. The content below is its own rectangle (`--game`, the blue box on the page), chosen apart from the webcam: in the bottom panel's shape it fills the panel, in another shape it is shown whole with a blurred copy of itself filling the rest, so nothing chosen is cut off ("Fit to the panel" makes it the panel's shape). Without `--game`, the middle of the gameplay is taken. Clips made before this keep their 640-pixel panel and their content when rendered again.

`--trim` is for a thin border baked into a recording, such as a rounded frame. It is limited to 5% of the shorter side of the video.

```bash
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout blur --trim 14
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --crop-x 700
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --crop-width 1000 --crop-x 200
node src/cli.js cut in/video.mp4 --start 1:00 --end 1:30 --layout facecam --cam 1400,40,480,270
```

## Blur boxes

For something the apps would take a clip down for, such as nudity in game footage: a part of the picture is blurred, or blacked out, for a few seconds.

- **On the cutting screen**, layout step: go to where it shows, press "Add a blur box", drag the pink box over it and resize it from its corner. Set "From" and "To" (seconds in the video; "Now" takes where the video is). The box is solid while the video is inside its time and dashed outside it. Choose Blur or Black.
- **A box stays where it is drawn.** If the thing moves, add another box for the next seconds.
- **The blur is strong on purpose**: the box is shrunk to a sixteenth and grown back before it is blurred, so only its colours are left.
- **It is applied to the source frames before the layout**, so it covers the same thing in every layout, and it is saved in `meta.json`, so a render again keeps it.
- From the command line: `--blur 700,300,120,120,1.5,4` (x, y, width, height in the source video's pixels, then start and end in seconds from the clip's start), and `,black` at the end for a black box.

## Logo overlay

Some campaigns require their logo on screen for the whole clip. Put the logo (PNG or WebP, with a see-through background) in the project's `overlays/` folder, then choose it under "Overlay" in the layout step of the cutting screen, or pass `--overlay`.

- **It is shown from the first frame to the last**, end card included, and under the captions, so they stay on top. There is no timing option, on purpose.
- **A picture of the clip's 9:16 shape is a full-frame overlay**, laid over the whole frame. **Anything else is a logo**, scaled to its width (220 px) and placed in a corner with a margin (40 px), moved down or up by the offset.
- **The page warns** when the logo would cover the captions, reach into the bottom 15% of the frame (where the apps put their own text and buttons), or leave the frame, and shows where it lands in a small sketch of the clip.
- **A brief can set it**, so every clip for that campaign gets it, whatever is chosen on the page:

  ```json
  "overlay": { "image": "overlays/kreekcraft-logo.png", "width": 220, "position": "top-left", "margin": 40, "offsetY": 660 }
  ```

  A relative image path is looked for from the folder you run the tool in, then next to the brief file. The checks then fail a clip rendered without that overlay.
- `overlays/` is not part of the repository, and travels in "My data".

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
| `overlay` | A logo or full-frame picture for every clip: `image`, and optionally `width`, `position`, `margin`, `offsetY` (see [Logo overlay](#logo-overlay)) |
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
- Word times are corrected from the sound: the speech recogniser often starts a word too early, where the word before it ended, so the tool moves such a word to where the voice actually begins, also when game sound or music plays underneath.
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

- Download a video over 3 hours, or anything from a channel that is not in your sources list
- Upload or post anywhere
- Cut a clip on its own: the AI only suggests moments, and you choose
- Follow a moving speaker
- Remove watermarks or logos
