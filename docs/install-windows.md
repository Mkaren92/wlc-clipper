# Installing WLC Clipper on Windows

This guide takes a Windows computer with nothing installed to a working WLC Clipper: the command line, the dashboard in the browser, captions, and fetching from YouTube. Follow the steps in order. Each step ends with a check and what the check should print; do not go on until it does.

It is written so that a developer, or an AI assistant with a terminal, can follow it without asking anything.

## Read this first

**WLC Clipper runs on Linux. On Windows it runs inside WSL 2**, which is Microsoft's own way to run a real Ubuntu Linux inside Windows. You use it from a terminal window, and the dashboard opens in your normal Windows browser.

**Running it directly on Windows (PowerShell, no WSL) is not supported.** It has never been run that way, and the code has Linux-only spots (listed in [Why not directly on Windows](#why-not-directly-on-windows)). Do not try to work around them; use WSL.

**What has been checked, and what has not:**

| Part of this guide | Status |
|---|---|
| Steps 4 to 9 (system packages, Node, the project, tests, first clip, dashboard) | Run on 2026-11-20 on Ubuntu 22.04.5, from a fresh copy cloned from GitHub. This is the same Ubuntu that step 2 installs. |
| Step 7 (`npm run setup`) | Run on the development machine when the project was built, not repeated on the fresh copy. |
| Steps 1 to 3 (installing WSL) and everything that touches Windows itself (the browser reaching the dashboard, Explorer paths) | Written from Microsoft's documentation. Not run by the author, who has no Windows machine. |

If a Windows step behaves differently from what is written here, the [Troubleshooting](#troubleshooting) section and Microsoft's page are the place to look: https://learn.microsoft.com/windows/wsl/install

## Requirements

| What | Needed |
|---|---|
| Windows | Windows 11, or Windows 10 version 2004 or later (build 19041 or later), 64-bit |
| Rights | An administrator account, for step 2 only |
| Processor | Virtualization switched on in the BIOS/UEFI (it is on most computers sold in the last years) |
| Disk | About 10 GB free, plus room for your videos. A one-hour 1080p video is several GB. |
| Internet | Needed for the install, for captions the first time (a 1.6 GB download), and for fetching from YouTube |
| Browser | Chrome. The dashboard has only been tried in Chrome. |

What gets installed, and the versions it was built and measured with:

| Thing | Version known to work | Where it comes from |
|---|---|---|
| Ubuntu (inside WSL 2) | 22.04 LTS | step 2 |
| ffmpeg and ffprobe | 4.4.2 | Ubuntu's own package, step 4 |
| Python | 3.10 | comes with Ubuntu 22.04 |
| Node.js | 24 (22.12 or later is required) | nvm, step 5 |
| Project packages | as listed in `package-lock.json` | `npm install`, step 6 (about 150 MB) |
| faster-whisper, yt-dlp and its YouTube solver (`yt-dlp-ejs`) | 1.2.1 and the newest | `npm run setup`, step 7 (about 520 MB) |
| Speech model | Whisper `large-v3-turbo` for captions, `small` for whole-video transcripts | downloaded when first used (about 1.6 GB and 460 MB) |

**Use Ubuntu 22.04, not a newer one.** Ubuntu 22.04 gives exactly ffmpeg 4.4.2 and Python 3.10, which is what every measurement in `docs/decisions.md` was taken on. Ubuntu 24.04 gives ffmpeg 6 and Python 3.12; the project has not been run there.

**For an AI assistant following this guide:** `CLAUDE.md` in the project says to ask the owner before installing or downloading anything beyond `npm install`. Steps 2, 4, 5 and 7, and the first clip with captions, each install or download something. Ask before each, and do not look for another route if one is refused.

---

## Step 1: Check your Windows version

1. Press the Windows key, type `winver`, press Enter.
2. Read the window that opens.

**It should say:** Windows 11 (any version), or Windows 10 with "Version 2004" or higher and "OS Build 19041" or higher.

If it is older, run Windows Update first. The rest of this guide will not work on an older build.

## Step 2: Install WSL with Ubuntu 22.04

1. Press the Windows key, type `PowerShell`.
2. Right-click "Windows PowerShell" and choose **Run as administrator**. Answer Yes.
3. Type this and press Enter:

   ```powershell
   wsl --install -d Ubuntu-22.04
   ```

4. Wait until it finishes, then **restart the computer**.
5. After the restart, a window titled Ubuntu opens by itself and finishes the install. If it does not, press the Windows key, type `Ubuntu`, and open "Ubuntu 22.04".
6. It asks for a **new UNIX username** and a **new password**. Choose any; they have nothing to do with your Windows account. Use a lower-case username with no spaces. When you type the password nothing appears on screen; that is normal. Remember it: `sudo` asks for it later.

**Check.** In PowerShell (it need not be administrator this time):

```powershell
wsl --list --verbose
```

**It should print** a line with `Ubuntu-22.04` and `2` in the VERSION column, like this:

```
  NAME            STATE           VERSION
* Ubuntu-22.04    Running         2
```

If things differ:

- **The command prints WSL's help text instead of installing.** WSL is already on this computer. Run `wsl --list --online` to see the names on offer, then `wsl --install -d Ubuntu-22.04` again.
- **The install stops at 0.0%.** Run `wsl --install --web-download -d Ubuntu-22.04`.
- **VERSION shows 1.** Run `wsl --set-version Ubuntu-22.04 2`.
- **A message says virtualization is not enabled.** Restart into the BIOS/UEFI settings, switch on the setting called Intel VT-x, Intel Virtualization Technology, AMD-V or SVM Mode, save, and repeat this step.
- **`Ubuntu-22.04` is not in the list from `wsl --list --online`.** Install the oldest Ubuntu LTS that is listed. The project has not been run on it, so run step 6's tests carefully and expect to look at failures.

## Step 3: Open the Ubuntu terminal

Every command from here on is typed in the **Ubuntu** window, not in PowerShell.

Open it: Windows key, type `Ubuntu`, Enter. The line you type on ends with `$`.

**Check:**

```bash
lsb_release -ds
```

**It should print** `Ubuntu 22.04` followed by a point number and `LTS`, for example `Ubuntu 22.04.5 LTS`.

Tip: to paste into the Ubuntu window, right-click, or press Ctrl+Shift+V.

## Step 4: Install the system programs

```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv git curl ca-certificates
```

`sudo` asks for the password from step 2. This downloads a few hundred MB and takes a few minutes.

**Check 1:**

```bash
ffmpeg -version | head -1
python3 --version
git --version
```

**It should print** `ffmpeg version 4.4.2-0ubuntu0.22.04.1` (the start of the line), `Python 3.10.` and a number, and `git version` and a number.

**Check 2**, that this ffmpeg has every piece the project uses:

```bash
for f in subtitles loudnorm flite rubberband overlay hstack bbox; do ffmpeg -hide_banner -filters 2>/dev/null | grep -qE " $f " && echo "filter $f: yes" || echo "filter $f: NO"; done
for e in libx264 aac libopus; do ffmpeg -hide_banner -encoders 2>/dev/null | grep -qE " $e " && echo "encoder $e: yes" || echo "encoder $e: NO"; done
```

**It should print** ten lines, all ending in `yes`. If any says `NO`, this is not Ubuntu 22.04's ffmpeg; go back to step 2.

## Step 5: Install Node.js

Ubuntu's own Node.js is far too old. Install a current one with nvm, a small tool that manages Node versions for your user only (no `sudo`).

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
source ~/.bashrc
nvm install 24
```

**Check:**

```bash
node -v
npm -v
```

**It should print** `v24.` and a number, then a number for npm. Any Node from `v22.12` up works; 24 is what the project was built on.

If `nvm` is "not found" after the first command, close the Ubuntu window, open it again, and run `nvm install 24`.

## Step 6: Get the project and test it

Keep the project inside Ubuntu's own home folder. **Do not put it under `/mnt/c/`** (your Windows drive seen from Ubuntu): it is many times slower there.

```bash
cd ~
git clone https://github.com/Mkaren92/wlc-clipper.git
cd wlc-clipper
npm install
```

**It should end with** a line like `added … packages` and `found 0 vulnerabilities`. Lines about "funding" are harmless.

Now run the project's own tests. They use the real ffmpeg on small videos they make themselves, and need nothing else:

```bash
npm test
```

This takes two to three minutes and uses every processor core.

**It should end with** two lines like these, with no failed count:

```
 Test Files  25 passed (25)
      Tests  596 passed (596)
```

The numbers grow as the project grows. What matters is that everything passed. If a test fails, see [Troubleshooting](#troubleshooting) before going on.

## Step 7: Install captions and fetching

This step is needed for captions (speech turned into text) and for fetching YouTube videos (a part, or a whole one up to 3 hours). Without it everything else still works: clips are made without captions, and fetching is switched off.

```bash
npm run setup
```

It creates a folder `.venv` in the project and downloads about 520 MB into it. It takes a few minutes. On a PC with an NVIDIA graphics card it also downloads NVIDIA's libraries for it, about 2 GB more, so that transcripts (captions, and a whole video's for "Suggest moments") run on the card; it says so ("Found ... installing NVIDIA's libraries"). Without a card it prints "No NVIDIA graphics card found" and the transcripts use the processor.

**It should end with:**

```
Done. The speech model itself is downloaded the first time a clip is transcribed.
```

If it says it could not create the virtual environment, run `sudo apt install -y python3-venv` and then `npm run setup` again.

## Step 8: Make a first clip

This makes a small test video, so you need no video of your own yet.

```bash
mkdir -p in
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440" -t 12 -c:v libx264 -pix_fmt yuv420p -c:a aac in/sample.mp4
node src/cli.js probe in/sample.mp4
```

**It should print:**

```
Resolution  1280x720
Frame rate  30 fps
Duration    0:12.00 (12.00 s)
Vertical    no
Audio       1 track
```

Now cut a clip from it. `--no-captions` is used because the test video has no speech:

```bash
node src/cli.js cut in/sample.mp4 --start 2 --end 8 --hook "First clip" --no-captions
```

**It should end with:**

```
Wrote /home/<you>/wlc-clipper/out/first-clip/clip.mp4
1080x1920, 30 fps, 6.00 s, layout center, no captions
```

To see the clip, open the project folder in Windows Explorer (note the dot at the end) and go into `out`, then `first-clip`:

```bash
explorer.exe .
```

**About captions:** the first clip you cut *with* captions (that is, without `--no-captions`, from a video with speech) downloads the speech model, about 1.6 GB, into `~/.cache/huggingface`. That happens once.

## Step 9: Start the dashboard

```bash
npm run dashboard
```

**It should print:**

```
WLC Clipper dashboard: http://127.0.0.1:4517
Press Ctrl+C to stop.
```

Leave this window open. In Windows, open **Chrome** and go to:

```
http://localhost:4517
```

**You should see** the WLC Clipper page with "Clips", "Cards", "Combine", "Compilations" and "Sources" on the left, and `sample.mp4` in the list of videos.

To stop the dashboard, click the Ubuntu window and press Ctrl+C.

The dashboard answers only this computer, and only at `localhost:4517` or `127.0.0.1:4517`. Any other address is refused on purpose.

If port 4517 is already used by something else, start it on another port and open that one instead:

```bash
CLIPPER_PORT=4600 npm run dashboard
```

**The install is complete.** The rest of this guide is about using it on Windows.

---

## Where your files are

The project's folders, all inside `~/wlc-clipper`:

| Folder | What is in it |
|---|---|
| `in/` | The videos you work from. Put source videos here. |
| `out/` | Finished clips, one folder each, with `clip.mp4` inside |
| `parts/` | Plain parts saved with "Save this part as it is" |
| `data/` | Matches and cards, combinations, compilations, your sources list and the channels' pictures |
| `sounds/` | Your own sound and video files for cards |
| `overlays/` | Logos and pictures shown over a whole clip |

These six folders, and the file `.env`, are yours. They are never sent to GitHub and are not part of a download of the project. The tool creates the folders when it needs them.

**To see the folders from Windows,** either run `explorer.exe .` in the project folder in Ubuntu, or type this into the address bar of Windows Explorer, with your Ubuntu username in place of `<you>`:

```
\\wsl.localhost\Ubuntu-22.04\home\<you>\wlc-clipper
```

On an older Windows 10 the same place is `\\wsl$\Ubuntu-22.04\home\<you>\wlc-clipper`.

You can drag videos into `in` there, and copy finished clips out.

**To copy a video from your Windows Downloads folder** with a command, with your Windows username in place of `<name>`:

```bash
cp "/mnt/c/Users/<name>/Downloads/my video.mp4" ~/wlc-clipper/in/
```

In the dashboard you can also drop files onto the Compilations page, and download finished videos with their download links.

## Using it every day

1. Open Ubuntu (Windows key, type `Ubuntu`, Enter).
2. Type:

   ```bash
   cd ~/wlc-clipper
   npm run dashboard
   ```

3. Open http://localhost:4517 in Chrome.
4. When you are done, press Ctrl+C in the Ubuntu window.

How to use each page, and every command and option, is in [`README.md`](../README.md).

## Optional: AI help

Suggested moments and caption fixes need an AI service. Everything else works without one. There are two ways; see "AI help" in the README for the details.

- **OpenAI, with an API key.** In the project folder, with your key in place of `your-key-here`:

  ```bash
  printf 'OPENAI_API_KEY=%s\n' 'your-key-here' > .env
  ```

  Then restart the dashboard. The file `.env` is never sent to GitHub. Never put the key anywhere else.

- **Claude, through Claude Code.** Install Claude Code inside Ubuntu (not in Windows) by following https://claude.com/claude-code, run `claude` once and log in. Nothing else is needed.

## Bringing your work from another computer

The project itself comes from GitHub. Your own files do not.

**By itself, through GitHub.** If the old computer is connected under "Sync with GitHub" on the dashboard's "My data" page, connect this one too and your data arrives and stays the same on both. This computer needs an SSH key that GitHub accepts (these steps were written from GitHub's documentation and not run on Windows):

```bash
ssh-keygen -t ed25519 -C "wlc-clipper"      # press Enter at each question
cat ~/.ssh/id_ed25519.pub                     # copy the line it prints
```

On GitHub open Settings, "SSH and GPG keys", "New SSH key", paste the line and save. Then check, answering `yes` to the question about the host:

```bash
ssh -T git@github.com
```

It must greet you by your GitHub name. Then, in the dashboard, open "My data", paste the address of your private data repository, press "Check this address", and choose "Take GitHub's data onto this computer".

**By hand**, for what sync does not carry (videos, clips, compilations, matches) or without GitHub, copy these from the old computer into the same places in `~/wlc-clipper` on the new one:

| Copy | Why |
|---|---|
| `in/` and `parts/` | Your videos. Compilations and combinations find a video by its file name in these folders. |
| `data/` | Matches, cards, combinations, compilations, the sources list, channel pictures |
| `sounds/` | Your sound files for cards |
| `.env` | Your AI key, if you use one |

What to expect afterwards:

- **Compilations and combinations open and can be generated again.** The first generate makes every piece again, so it takes as long as the first time.
- **Finished clips in `out/` play, but cannot be rendered again.** A clip remembers the full path of its source video on the computer it was made on. Cut it again from the video if you need a change.
- **Do not copy `node_modules/` or `.venv/`.** Steps 6 and 7 make them fresh.

## Updating to a newer version

```bash
cd ~/wlc-clipper
git pull
npm install
npm run setup
```

`npm run setup` also brings the YouTube downloader up to date. Run it whenever fetching stops working: YouTube changes often.

## Troubleshooting

| What you see | What to do |
|---|---|
| `wsl` is not recognized, in PowerShell | Windows is too old. Do step 1. |
| `node: command not found`, or `nvm: command not found` | Close the Ubuntu window, open it again. If it is still missing, repeat step 5. |
| `npm install` warns about an unsupported engine | Node is older than 22.12. Run `nvm install 24`, then `npm install` again. |
| `npm test` fails with ffmpeg errors that name a filter or an encoder (`No such filter`, `Unknown encoder`) | Run check 2 of step 4. This ffmpeg is missing a piece; it must be Ubuntu 22.04's own package. |
| `npm test` fails in another way | Run it once more; a very slow or busy computer can hit a time limit. If the same test fails again, copy the lines under `FAIL` and report them. |
| `Could not create the virtual environment` | `sudo apt install -y python3-venv`, then `npm run setup` again. |
| `Port 4517 is already in use` | Another program, or a dashboard you already started, has it. Close the other Ubuntu window, or use `CLIPPER_PORT=4600 npm run dashboard` and open `http://localhost:4600`. |
| The browser says the site cannot be reached | Check the Ubuntu window still shows the dashboard running. Use `http://localhost:4517` exactly. If it still fails, stop the dashboard, run `wsl --shutdown` in PowerShell, open Ubuntu again and start the dashboard again. |
| The page says "The dashboard pages are not built yet" | Stop it, run `npm run build`, start it again. |
| The page shows an error "The dashboard only answers its own page on this machine" | You opened it by another address. Use `http://localhost:4517`. |
| A clip is made without captions and a warning mentions the transcriber | Step 7 was skipped or failed. Run `npm run setup`. |
| Fetching from YouTube fails | Run `npm run setup` to update the downloader. Check the channel is in your Sources list; only those can be fetched from. If a download on the Download page says it came "the slow way", it shows why. |
| A video does not play in the dashboard but cuts fine | The browser cannot play that file type. The start and end can still be typed, and the clip is made. |
| Everything is very slow | Check the project is in `~/wlc-clipper` and not under `/mnt/c/`. Making video uses every processor core for about as long as the video plays. |
| The disk fills up | The big folders are `in/`, `out/`, `parts/` and `data/compilations/`. Delete videos you no longer need from the dashboard. |

## Removing it

- **Only the project:** in Ubuntu, `rm -rf ~/wlc-clipper`. This deletes your videos, clips and data too; copy what you want to keep first.
- **The speech model:** `rm -rf ~/.cache/huggingface`.
- **Ubuntu altogether:** in PowerShell, `wsl --unregister Ubuntu-22.04`. This deletes everything inside it.

## Why not directly on Windows

For a developer who wonders, or who wants to add Windows support later. These are the known Linux-only spots; there may be more, since nothing has been run on Windows:

- **The Python program is looked for at `.venv/bin/python`** (`scripts/setup.js`, `src/transcribe/fasterWhisper.js`, `src/fetch.js`), and setup starts `python3`. On Windows a virtual environment has `.venv\Scripts\python.exe` and the command is `python`. Setting `CLIPPER_PYTHON` covers the two modules but not the setup script.
- **Each render makes a symbolic link to the fonts folder** (`src/render.js`, `src/compilation/build.js`). On Windows that needs Developer Mode or administrator rights.
- **Programs are started without a shell** (`src/run.js`), which on Windows does not find commands that are `.cmd` files, such as `claude`.
- **ffmpeg must have libass, libx264, flite and rubberband.** Which Windows builds of ffmpeg include all of them has not been checked.
- **Every measurement in `docs/decisions.md` was taken on ffmpeg 4.4.2.** Windows builds are much newer.

Inside WSL none of this matters, because the project sees a normal Ubuntu.
