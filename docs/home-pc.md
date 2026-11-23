# Home PC: getting my data

What to do on the home PC so it has the same channels, clubs, logos, sounds and briefs as the office PC, and keeps them the same by itself. Written 2026-11-23, when the office PC was connected.

The data lives in the private repository https://github.com/Mkaren92/wlc-clipper-data. The code lives in the public one, https://github.com/Mkaren92/wlc-clipper.

## 1. Get the new code

In the terminal (on Windows: the Ubuntu terminal), in the project folder:

```bash
cd ~/wlc-clipper
git pull
npm install
```

If the project is in another folder, `cd` there instead.

## 2. Check that GitHub knows this PC

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

## 3. Start the dashboard

```bash
npm run dashboard
```

Open http://127.0.0.1:4517 in the browser.

## 4. Connect

1. Open **My data** in the left column.
2. Under "Sync with GitHub", paste this address:

   ```
   https://github.com/Mkaren92/wlc-clipper-data
   ```

3. Press **Check this address**. A table shows what is on GitHub beside what is on this PC. GitHub should show about 55 channels and 96 clubs.
4. Press **Take GitHub's data onto this computer**.

After a few seconds the section shows "In sync". Open Sources and Cards to see the channels, clubs and logos.

**Do not press "Send this computer's lists to GitHub instead".** That would put the home PC's lists in place of the office ones. (The office ones would still be in the repository's history, but there is no reason to go there.)

## After that

Nothing needs pressing, on either PC. Each dashboard syncs when it starts and within a minute of a change. The "My data" page shows what last arrived and what was sent, and has a "Sync now" button.

Videos, clips, parts, combinations, compilations and match cards do not travel. They stay on the PC they were made on.

The AI key does not travel either. If the home PC needs it, copy the file `.env` by hand.

## If something goes wrong

- **"GitHub could not be reached at that address, or this PC is not allowed in"**: step 2 did not pass. Do it again.
- **"Sync is busy with something else"**: wait a few seconds and press again.
- **"Sync is failing" or "check sync" in the left column**: open "My data" and read the message. Nothing is deleted by a failed sync.
- **Something looks wrong after connecting**: the home PC's lists as they were before are in `data/backups/before-connect-<date and time>/`. Files a sync replaced are in `data/backups/sync/`.
- **Fallback without GitHub**: "Download my data" on one PC and "Load my data" on the other still work, lower on the same page.

A change going between two real PCs was not tried before this was written; the first sync at home is that test. If it fails, write down the message on the page.
