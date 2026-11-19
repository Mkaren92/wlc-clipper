# Roadmap

Last updated 2026-11-19. Update this file when something here changes.

## Built

Version 1 of the spec is complete: all three "evenings".

- `probe`, and `cut` with the `center`, `blur` and `facecam` layouts
- Transcription, word-timed captions, hook line
- `render` to rebuild a clip after editing its transcript
- Briefs: validation, `post.txt`, the rule checks, on-screen disclosure, end card, `check`
- Beyond the spec: `--trim`, `keepFullFrame`, `replacements`, the `work/` subfolder

156 tests pass on the first development machine (Linux, ffmpeg 4.4.2).

## Waiting on the owner

- **A brief for the real campaign.** The only brief, `briefs/forgegui-basic.json`, is the example from the spec. The owner's test footage is football commentary, which it does not fit. Write a brief only from campaign text the owner supplies.
- **The Stitch brief.** Stitch is a second campaign: the spec lists "two real brief files (ForgeGUI and Stitch)" and gives no rules for it.
- **The ForgeGUI logo.** The spec's example refers to `assets/forgegui-logo.png`, which was never supplied, so the example brief has no `image` line and its end card is plain.
- **A verdict on caption timing** in continuous speech, judged by eye on real clips. Only word starts after pauses were measured.
- **Whether the `small` speech model is accurate enough.** A larger model needs about 1.5 GB more disk and is slower.

## Not verified

- `replacements` and the spoken forbidden-term rule ran on made-up transcripts, not real speech.
- The `facecam` layout was not tried on a recording that has a real webcam box.
- The end card was tried with generated test pictures, not with a real logo.
- Captions in a language other than English. Caption widths are only known for A to Z, digits and a few signs.
- Nothing has been run on Windows or macOS. Windows would need work first: the transcriber's path is `.venv/bin/python`, and each render makes a symbolic link to the fonts folder.

## Next: version 1.1, suggested moments

`clipper suggest <file> --count 5 --brief <file>` is in the spec and is not built. It would transcribe the whole source, send the transcript to an LLM through OpenRouter, and print candidate ranges for `clipper cut`. The reply is to be validated with `zod`, and each range snapped to word boundaries and to the brief's length limits.

It needs an OpenRouter API key from the owner and sends transcripts to an outside service, so it starts only on the owner's explicit go. Keep the key in an environment variable, never in a brief or in the repository. The variable's name and the model to use are not decided; settle both with the owner. It does not depend on the items under "Waiting on the owner".

## Later, only if clipping proves worth it

From the spec:

- Visual highlight detection with a video-understanding model
- Face detection to choose the crop position automatically
- A small review interface for approving and adjusting clips (the only item that would need a port; pick an uncommon one, make it configurable, and check it is free)
- Batch mode: several ranges from one source in one run
