# Decisions and their reasons

The original spec is `docs/build-spec-v1.pdf`. It left some things undefined and contradicted itself in places, and the owner delegated those choices ("every undefined thing is up to you"). This file records each choice that is not obvious from the code, why it was made, and what was measured.

Measurements were taken on the first development machine: ffmpeg 4.4.2 (Ubuntu 22.04), Node 24, Python 3.10, faster-whisper 1.2.1, CPU only.

On a different ffmpeg version, `npm test` re-checks size, frame rate, length, picture-and-sound sync and the silent end-card tail. It does not re-check where text lands on screen: the pixel positions quoted below were measured by hand from rendered frames, so look at a frame again if the renderer changes.

## Stack

- **Node.js with a small Python script.** Python alone would have been simpler, since faster-whisper is a Python library. The owner is a JavaScript developer and wants to take part in development, so everything except `scripts/transcribe.py` is JavaScript.
- **Node 22.12 or later**, not 20 as in the spec. `commander` 15 and `vitest` 5 require it.
- **`child_process` through `src/run.js`**, not `execa`. One small wrapper was enough.
- **`npm audit` reports high-severity findings** in `picomatch`, inside `vitest`'s development-only dependencies. The only offered fix is downgrading `vitest`, so it was left alone.

## Rendering

- **Frame rate is converted with the `fps` filter, never with `-r 30`.** The spec's recipes use `-r 30`. On a 60 fps source it put the picture two frames (67 ms) behind the sound; with `fps=30` at the start of the graph, picture and sound match to within one frame. That was measured by hand on 24, 25, 30, 59.94 and 60 fps sources, including an MKV with B-frames; the test suite covers the 60 fps case.
- **`-ss` and `-t` are both input options**, for the render and for the audio extract. With `-t` only on the output and an end card, the source kept playing under the card and its sound was heard in the tail. A test cuts a range that ends just before a beep and requires the clip to be silent.
- **Only the first audio track is used** (`-map 0:a:0?`), for the clip and for the transcriber. The spec's `-map 0:a?` copied every track of a multi-track recording into the clip.
- **ffmpeg runs inside the clip's `work/` folder** and the filter graph refers to `captions.ass` and `fonts` by bare name. A path with a quote, comma or bracket in it broke the `subtitles` filter. `fonts` is a temporary symbolic link to `assets/fonts`, removed after the render.
- **The clip is written to `clip.partial.mp4` and renamed.** A failed re-render leaves the previous `clip.mp4` intact.
- **`--trim` was added** (not in the spec). The owner's source recording has a rounded, coloured border baked into the frame, and 14 pixels removes it. It is capped at 5% of the shorter side so it stays a border remover and does not become a way to crop out logos, which the spec's guardrail forbids.
- **`--crop-x` is the left edge of the crop in source pixels**, clamped to the frame. The spec did not say what the offset was measured from.
- **The watermark guardrail was reworded** to "no feature whose purpose is removing marks". As written in the spec it contradicted the `center` layout, which discards about two thirds of the frame width.

## Captions and on-screen text

- **Font: Liberation Sans Bold**, from the `liberation2` package, under the SIL Open Font License (text in `assets/licenses`). The spec's style names Arial, which is not installed on Linux, and the subtitle renderer silently substitutes whatever it finds. The render aborts if the bundled font file is missing.
- **Hook top margin is 240.** The hook's white box reaches 18 px above its text. At the spec's margin of 200 the box started at y=182, against the spec's own rule that nothing sits in the top 200 px; at 240 it starts at y=222.
- **The hook wraps and is limited to 60 characters.** The spec's file sets `WrapStyle: 2`, which disables wrapping, and a long hook ran off both edges. Hook lines carry `{\q0}`; 60 characters is two lines.
- **In the `facecam` layout the hook sits under the webcam panel** (margin 670), so it does not cover the face.
- **An on-screen disclosure is written before the hook** in the subtitle file. When both are on screen, the renderer stacks the earlier event above the later one; measured, their boxes touch and do not overlap.
- **End-card text uses the hook style at a bottom margin of 540.** Its box then ends at y=1397, level with the captions.
- **Wide caption lines are shrunk.** Captions never wrap, and an 18-character line of wide letters ran off the frame. `src/captions/width.js` estimates the width from the font's advance widths (one em is 77 px at the caption size, plus 12 px of outline; within 3 px of the rendered width on six test phrases when measured, and the test allows 10 px) and adds a scale tag when a line exceeds 960 px.
- **`--no-captions` skips only transcription.** In the spec it also skipped building the subtitle file, which would have removed the hook.

## Transcription

- **faster-whisper, model `small`, `int8`, on the CPU**, as in the spec. About 5 seconds for a 30-second clip. The model makes mistakes with names. `npm run setup` installs the latest faster-whisper without pinning a version; 1.2.1 is the one that was tested.
- **Word times are moved off pauses** (`src/captions/pauses.js`). With the spec's settings the first word after a pause was timed 0.25 to 0.6 seconds early, because the model stretches it back over the silence, so its caption appeared before it was spoken. Pauses are found with ffmpeg as stretches at least 15 dB quieter than the clip's average level for 0.25 seconds or more. A relative level means background music simply yields no pauses. This is separate from the grouping rule in `src/captions/group.js`, which starts a new caption line after a gap of more than 0.4 seconds between two words' times.
- **A punctuated prompt for the model was tried and rejected.** It improved timing but inserted words at the start of clips. Tighter voice-detection settings did not improve timing consistently.
- **When the transcriber is not installed, the clip is made without captions and a warning is printed.** An error would have broken every `cut` on a machine without Python set up.
- **`clipper render` re-renders from an edited `work/transcript.json`.** The spec said a run could be "resumed" without defining how; this is the one way.
- **Timing of words in the middle of continuous speech has not been measured.** The owner was asked to judge it by eye.

## Briefs, post text and checks

- **`captionMustInclude` was renamed `descriptionMustInclude`.** In the spec "caption" meant both the post's text and the burned-in subtitles. In this tool it only means the subtitles. The old name is rejected with a message.
- **`--title` and `--desc` were added.** The spec's `post.txt` needed a title and description but had no source for them. The title defaults to the hook.
- **Rules that can be judged early are checked before rendering**, and a failure stops the run before a clip folder is made. The spec checked only after the render.
- **A failed rule after rendering leaves the clip but exits with an error code.** A forbidden term found in the captions may be a transcription mistake the owner can fix.
- **Forbidden terms are also looked for in the transcript, the disclosure and the end-card text.** The spec checked only the title, description and hook. Terms match whole words, ignoring case.
- **The end card is appended after the footage** as a silent tail, and counts toward the brief's length limit. The spec covered the last seconds of the footage with it, which hid content. `--start` and `--end` now always mean what is shown.
- **The end-card image is optional and is placed over a plain dark card.** Placed straight over the footage, a logo with a transparent background would let the frozen last frame show through. This was checked by hand with two generated pictures, one opaque and one with a transparent background; the tests cover only the filter graph's text.
- **`keepFullFrame` was added.** A brief that needs the whole source frame visible passes only with the `blur` layout.
- **`replacements` was added** for words the transcriber gets wrong every time, such as brand names. A key may be several words. They are applied once, when a clip is cut, and the result is saved in the transcript.
- **`platforms` is only printed in the to-do list**, and all optional hashtags are appended after the required ones. The spec did not say what either did.
- **Brief files are validated strictly.** A misspelled field is an error, not a rule that silently never runs.
- **Each clip's `meta.json` keeps a copy of the brief** it was made with, so a later render does not depend on the brief file. It also stores the source video and the end-card image as absolute paths, so a clip folder cannot be re-rendered on another machine.

## Clip folder

- **Working files live in `work/`.** The owner asked for clip folders that show only `clip.mp4` and `post.txt`. Folders with the older flat layout are still read.
