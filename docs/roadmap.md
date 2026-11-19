# Roadmap

Last updated 2026-11-19. Update this file when something here changes.

## Built

Version 1 of the spec is complete: all three "evenings".

- `probe`, and `cut` with the `center`, `blur` and `facecam` layouts
- Transcription, word-timed captions, hook line
- `render` to rebuild a clip after editing its transcript
- Briefs: validation, `post.txt`, the rule checks, on-screen disclosure, end card, `check`
- Beyond the spec: `--trim`, `keepFullFrame`, `replacements`, the `work/` subfolder, a hook time setting, clip folders named after the hook, deleting clips, and plain parts (`extract`)
- A dashboard in the browser (`npm run dashboard`): cut with a visual range and crop, view clips with their checks and post text, fix caption words
- Two more dashboard pages: a card maker (goal, red card and full-time cards, saved per match, exported as PNG in two sizes) and a compilation builder (videos and cards in order, credits, one final video with a description file)
- AI help, optional, through Claude Code's command line (no key) or OpenAI (with a key): `suggest` and "Suggest moments" propose ranges with a hook, title and description; "Suggest fixes" proposes caption word corrections

241 tests pass on the first development machine (Linux, ffmpeg 4.4.2). None of them cover the dashboard's pages, and none call the real AI service.

## Waiting on the owner

- **A brief for the real campaign.** The only brief, `briefs/forgegui-basic.json`, is the example from the spec. The owner's test footage is football commentary, which it does not fit. Write a brief only from campaign text the owner supplies.
- **The Stitch brief.** Stitch is a second campaign: the spec lists "two real brief files (ForgeGUI and Stitch)" and gives no rules for it.
- **The ForgeGUI logo.** The spec's example refers to `assets/forgegui-logo.png`, which was never supplied, so the example brief has no `image` line and its end card is plain.
- **A verdict on caption timing** in continuous speech, judged by eye on real clips. Only word starts after pauses were measured.
- **What exactly looks wrong.** The owner felt quality was poor across clips, parts and cards. Measurement put it on the source file, not the tool; the owner was asked whether it is blur, blocks, choppy motion or sound, and on which output.
- **Whether the `small` speech model is accurate enough.** A larger model needs about 1.5 GB more disk and is slower.

## Not verified

- `replacements` and the spoken forbidden-term rule ran on made-up transcripts, not real speech.
- The `facecam` layout was not tried on a recording that has a real webcam box.
- The end card was tried with generated test pictures, not with a real logo.
- Captions in a language other than English. Caption widths are only known for A to Z, digits and a few signs.
- The dashboard was tried in Chrome only, and its facecam box was placed but never used for a real cut.
- Nothing has been run on Windows or macOS. Windows would need work first: the transcriber's path is `.venv/bin/python`, and each render makes a symbolic link to the fonts folder.

## Next

Nothing is decided. Ideas the owner has been offered:

- A screen for creating and editing briefs, so the JSON is not edited by hand
- An option to keep the source's frame rate (60 fps) in clips and compilations, offered after the quality check of 2026-11-19 (see `docs/decisions.md`)
- Cutting several ranges in one go
- A larger local speech model, if caption mistakes prove a problem (about 1.5 GB more disk)
- AI word fixes from the command line; they exist only in the dashboard

## Later, only if clipping proves worth it

From the spec:

- Visual highlight detection with a video-understanding model
- Face detection to choose the crop position automatically
- Batch mode: several ranges from one source in one run
