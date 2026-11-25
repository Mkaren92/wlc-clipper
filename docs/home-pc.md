# Home PC: what to do

What to do on the home PC so it has the same code and the same channels, clubs, logos, sounds and briefs as the office PC. Last updated 2026-11-25.

The data lives in the private repository https://github.com/Mkaren92/wlc-clipper-data. The code lives in the public one, https://github.com/Mkaren92/wlc-clipper.

The home PC was connected on 2026-11-23/24 and sync works between the two PCs. So the part to follow now is the first one. "First time on a new PC" at the end is only for a PC that was never connected.

## Next time at home

Do these in this order, **before starting the dashboard**. The order matters: an old version of the tool may not know a kind of data a newer one saves, so get the new code first and only then let it sync.

If the dashboard is still running from last time, stop it first: Ctrl+C in its terminal.

```bash
cd ~/wlc-clipper
git status
git pull
npm install
npm run dashboard
```

If the project is in another folder, `cd` there instead. Then open http://127.0.0.1:4517.

- `git status` should say `nothing to commit, working tree clean`. If it lists changed files, or says `Your branch is ahead of 'origin/main'`, there is work on the home PC that was never pushed. Do not delete the folder or clone again. Open Claude Code in that folder and write: **"I have work here that was never pushed. Get the latest main from GitHub, put it together with my work here, run the tests, and commit-push."**
- `npm run setup` is **not** needed. Nothing new has to be installed.

## What is different after this pull (code of 2026-11-25)

- **Captions use a larger speech model.** The first clip cut with captions downloads it once: about 1.6 GB, a few minutes. Check there is room first with `df -h ~`. Later clips do not download anything.
- **Captions take longer than before**, because of that model. On the office PC a 60-second clip takes about 2 minutes to make. The home PC's graphics card makes the picture faster, but captions do not use the card.
- **Do not put the line `CLIPPER_CAPTION_MODEL=small` in the file `.env`.** It switches the larger model off, and captions then miss the streamer under loud game sound.
- **Captions write every voice in the sound**: the streamer, other players and the game's characters. Remove the wrong lines on the clip's page.
- **"My data" has only "Sync with GitHub" now.** "Download my data" and "Load my data" are gone.
- **The cutting screen has "−5 s" and "+5 s" buttons**, and the keys J and L do the same.
- **Fetching a whole video works again.** It failed on some videos with "The download failed".
- "Cover swear words (F*CK)" and "Muffle them in the voice" are two checkboxes on the cutting screen, as before.
- **Hook suggestions read like a viewer reacting** ("you did NOT just do that to a spotless car"), not like a report of what the streamer did.
- **The dashboard has one look, the dark one.** The "Colours" chooser at the bottom of the left column is gone.
- **The intro card's score stands on a dark box** when a video plays behind the card. Card pictures do not sync, so on the home PC open **Cards**, choose each match and press **Save match and cards** once; then generate the compilation again.
- **A new intro video and a new goal sound arrive by sync** (`sounds/intro.mp4`, `sounds/goal.wav`). The home PC's own older files of those names are moved to `data/backups/sync/`.
- **The result player on the Compilations page has no black bars** beside the picture any more.
- **The three sounds "made by the tool" are gone** from a card's sound list. Cards use your own files in `sounds/`, which sync.
- **The cards look different** (2026-11-25): goal, red and full-time cards show both clubs' logos with the score between them, and every card has the dark green, white and lime of the channel's artwork. Card pictures do not sync and are drawn again only when a match is saved, so on the home PC open **Cards**, choose each match and press **Save match and cards** once; then generate the compilation again.

Tried on the office PC on 2026-11-24 and removed the same day, so the home PC never gets it and needs nothing for it: a "Drop game voices" checkbox and a voice sample for each channel. One voice sample that was uploaded then is still in the data repository (`data/source-voices/`, two files). Nothing uses it and it is not copied to the home PC.

## Quick check after the pull

1. Open **My data**: it shows "In sync" and no Download or Load buttons.
2. Open **Sources**: the channels are there (58 on 2026-11-24).
3. Cut one short clip with captions. The first one waits for the 1.6 GB download.

## Day to day

Nothing needs pressing, on either PC. Each dashboard syncs when it starts and within a minute of a change. The "My data" page shows what last arrived and what was sent, and has a "Sync now" button.

Videos, clips, parts, combinations, compilations and match cards do not travel. They stay on the PC they were made on.

The AI key does not travel either. If the home PC needs it, copy the file `.env` by hand.

## If something goes wrong

- **"GitHub could not be reached at that address, or this PC is not allowed in"**: run `ssh -T git@github.com`. It must say `Hi Mkaren92! You've successfully authenticated`. If not, do step 2 of "First time on a new PC".
- **"Sync is busy with something else"**: wait a few seconds and press again.
- **"Sync is failing" or "check sync" in the left column**: open "My data" and read the message. Nothing is deleted by a failed sync.
- **A file is missing or looks wrong after a sync**: files a sync replaced or removed are in `data/backups/sync/`.
- **`git pull` refuses because of local changes**: do not force it. Use the sentence for Claude Code in "Next time at home".
- **Captions miss words**: check that `.env` has no line `CLIPPER_CAPTION_MODEL=small`:

  ```bash
  cd ~/wlc-clipper
  grep -c '^CLIPPER_CAPTION_MODEL=' .env
  ```

  It should print `0`, or say there is no such file.

## First time on a new PC

Only for a PC that was never connected. The home PC is done.

### 1. Get the code

In the terminal (on Windows: the Ubuntu terminal). `docs/install-windows.md` has the full install for Windows.

```bash
cd ~/wlc-clipper
git pull
npm install
```

### 2. Check that GitHub knows this PC

```bash
ssh -T git@github.com
```

- It says `Hi Mkaren92! You've successfully authenticated`: good, go to step 3.
- It asks `Are you sure you want to continue connecting`: type `yes` and press Enter.
- It says `Permission denied (publickey)`: this PC has no key on GitHub yet. Make one:

  ```bash
  ssh-keygen -t ed25519 -C "wlc-clipper home"
  cat ~/.ssh/id_ed25519.pub
  ```

  Press Enter at each question of the first command. Copy the one line the second command prints. On GitHub open Settings, "SSH and GPG keys", "New SSH key", paste the line, save. Then run `ssh -T git@github.com` again.

### 3. Start the dashboard

```bash
npm run dashboard
```

Open http://127.0.0.1:4517 in the browser.

### 4. Connect

1. Open **My data** in the left column.
2. Under "Sync with GitHub", paste this address:

   ```
   https://github.com/Mkaren92/wlc-clipper-data
   ```

3. Press **Check this address**. A table shows what is on GitHub beside what is on this PC.
4. Press **Take GitHub's data onto this computer**.

After a few seconds the section shows "In sync". Open Sources and Cards to see the channels, clubs and logos.

**Do not press "Send this computer's lists to GitHub instead".** That would put the new PC's lists in place of the ones on GitHub. (The old ones would still be in the repository's history, but there is no reason to go there.)

The new PC's lists as they were before connecting are kept in `data/backups/before-connect-<date and time>/`.
