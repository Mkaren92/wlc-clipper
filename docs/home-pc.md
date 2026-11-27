# Home PC: what to do

What to do on the home PC so it has the same code and the same channels, clubs, logos, sounds and briefs as the office PC. Last updated 2026-11-27.

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

## Pull before starting the dashboard: it matters more now

Since 2026-11-27 a channel can be a **favourite** (the star on its row on the Sources page). The mark is kept in the channels list, which syncs, so a star made on one PC shows on the other. The new version writes the mark's field for every channel the first time it changes the list in any way (a star, a club, a new channel). An older version of the tool cannot read a channels list that has it: if the home PC's dashboard is started before `git pull`, its sync stops with "Sync is failing" and a message about the sources list. Nothing is lost or deleted. Stop the dashboard, run the commands under "Next time at home", and sync works again.

## Do these once after the pull of 2026-11-25

This pull changes the cards, removes the intro and adds the thumbnail, the title and description, and the leaning logo. Things made at home before it need a little care, once.

1. **Run the tests once.** They were not all run before this push (only the ones for what changed).

   ```bash
   cd ~/wlc-clipper
   npm test
   ```

   It should end with `Tests  607 passed`. If anything fails, open Claude Code in that folder and write: **"npm test fails after the pull of 2026-11-25. Show me what fails and fix it."**
2. **Save every match once.** Open **Cards**, choose a match, press **Save match and cards**; do it for each match. This redraws its cards in the new look and saves the two extra pictures the leaning logo needs. A match that had an intro card opens without it. Until a match is saved, its cards in a compilation are the old pictures and its logos stand still.
3. **Look through each compilation's timeline.**
   - An item that was an **intro card** now says its card was deleted from the match. Remove that item.
   - A card whose sound was a **video** (such as `intro.mp4`) says the video behind a card was removed. Choose another sound for it.
   - Press **Generate the video** once. That also gives the compilation its chapter times for the description.
4. **Tidy the sounds folder if needed.** Sync moves `intro.mp3` out of `sounds/` into `data/backups/sync/` by itself. A video there (`sounds/intro.mp4`) is no longer anything the tool knows, so sync leaves it where it is: nothing uses it, and you can delete or move it by hand. The goal, red card and full-time sounds arrive shortened to 3.0 seconds; the home PC's longer ones go to `data/backups/sync/`.
5. **The title and description text is typed per PC.** Compilations do not sync, so the sentences typed on the office PC (under "YouTube title and description") are not on the home PC. Type them once there too; new compilations then start with them.

Nothing new has to be installed, and nothing in this pull uses the graphics card differently. The leaning logo was measured with ffmpeg 4.4.2 on the office PC; if a goal or red card fails to generate at home, check `ffmpeg -version` and tell Claude Code what the page said.

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
- **A new goal sound arrived by sync** (`sounds/goal.wav`). The home PC's own older file of that name was moved to `data/backups/sync/`.
- **The result player on the Compilations page has no black bars** beside the picture any more.
- **The three sounds "made by the tool" are gone** from a card's sound list. Cards use your own files in `sounds/`, which sync.
- **The cards look different** (2026-11-25): goal, red and full-time cards show both clubs' logos with the score between them, and every card has the dark green, the pitch stripes, the white and the lime of the channel's artwork. In a compilation the logo of the club that scored, or had a player sent off, leans right and left three times; that needs each match saved once: open **Cards**, choose the match and press **Save match and cards**, then generate the compilation again. Card pictures do not sync. Card pictures do not sync and are drawn again only when a match is saved, so on the home PC open **Cards**, choose each match and press **Save match and cards** once; then generate the compilation again.
- **The intro card is gone, and so is a video behind a card** (2026-11-25). A compilation starts straight with a goal or a red card. Sync removes `sounds/intro.mp4` and `sounds/intro.mp3` from the home PC's `sounds/` folder and keeps them in `data/backups/sync/` there. A match that had an intro card opens without it.
- **A compilation has a YouTube thumbnail** (2026-11-25), under the timeline on the **Compilations** page: download it with "JPG 1280×720".
- **The goal, red card and full-time sounds are shorter** (3.0 s each, cut on 2026-11-25) and arrive by sync.
- **A compilation has a "YouTube title and description" panel** (2026-11-25), under the thumbnail: the chapter times and the fan channels are written for you, your own sentences are typed once, and there are title ideas, hashtags and tags worked out from the match. For chapters like `BAR 1-0 RMA`, type each team's short name on the **Cards** page.
- **Several videos, clips or parts can be deleted at once** (2026-11-27): tick the boxes in the left column of the Clips page and press the "Delete" button that appears.
- **A channel can be a favourite** (2026-11-27): press the star on its row on the Sources page and it is listed first. Favourites arrive by sync.
- **A download can have your own name** (2026-11-25): "Your own name for the file" on the **Download** page puts it in front of the file's name. The link, the times and the name stay in their boxes after a download.

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
