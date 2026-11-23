"""Transcribe one audio file with faster-whisper and print JSON to stdout.

Usage: transcribe.py <audio file> <language> <model size> [batched | filtered]

With "batched", the speech is cut into pieces where it pauses and several pieces are
transcribed at once (faster-whisper's BatchedInferencePipeline). That is for a whole
video's transcript, which "Suggested moments" reads; a clip's captions use the plain way,
which they were measured with.

With "filtered", it is the plain way with the voice-activity filter on. A clip's captions
ask for it only as a second pass, to fill the stretches where the plain pass heard nothing
(src/transcribe/fill.js).

A whole video's transcript ("batched") uses an NVIDIA graphics card when there is one that
works, and the processor otherwise; captions always use the processor, as they were measured.

Output: {"language": "en", "device": "cuda", "words": [{"text": "He", "start": 0.32, "end": 0.48}, ...]}
Times are seconds from the start of the audio file. "device" says where it ran.
"""
import json
import os
import sys

path, lang, model_size = sys.argv[1], sys.argv[2], sys.argv[3]
batched = len(sys.argv) > 4 and sys.argv[4] == "batched"
filtered = len(sys.argv) > 4 and sys.argv[4] == "filtered"


def nvidia_lib_dirs():
    """Where `npm run setup` put NVIDIA's cuBLAS and cuDNN inside .venv, if it did (only on a PC with a card)."""
    try:
        import nvidia  # the namespace package of the nvidia-*-cu12 wheels
    except ImportError:
        return []
    dirs = []
    for base in getattr(nvidia, "__path__", []):
        for name in ("cublas", "cudnn"):
            lib = os.path.join(base, name, "lib")
            if os.path.isdir(lib):
                dirs.append(lib)
    return dirs


# The card is tried only for a whole video's transcript, and only when CLIPPER_TRANSCRIBE_DEVICE
# is not "cpu". Measured on the owner's GTX 1660 Ti on 2026-11-23, 5 minutes of a stream:
# processor 32.8 s, card 5.6 to 6.2 s with int8_float16 (float16 took 12.3 s), the same words.
want_card = batched and os.environ.get("CLIPPER_TRANSCRIBE_DEVICE", "auto") != "cpu"
lib_dirs = nvidia_lib_dirs() if want_card else []
if lib_dirs:
    # The libraries are found by the system's loader, which reads LD_LIBRARY_PATH only when a
    # program starts, so the script starts itself again once with the path set. Same process id,
    # so a stop still reaches it.
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if not all(d in current.split(":") for d in lib_dirs):
        env = dict(os.environ, LD_LIBRARY_PATH=":".join(lib_dirs + ([current] if current else [])))
        os.execve(sys.executable, [sys.executable] + sys.argv, env)

from faster_whisper import BatchedInferencePipeline, WhisperModel  # noqa: E402

# Measured on the owner's machine (16 cores under WSL) on 2026-11-21, 116 s of speech: plain with
# faster-whisper's own 4 threads 48 s, plain with 12 threads 228 s (more threads made it slower),
# batched with 4 threads 16 s, with 8 threads 13 s. So batched uses 8 and plain keeps 4, as the
# captions were measured with. CLIPPER_TRANSCRIBE_THREADS overrides both.
threads = int(os.environ.get("CLIPPER_TRANSCRIBE_THREADS") or (min(8, os.cpu_count() or 4) if batched else 4))


def batched_on(device):
    """A whole video's transcript on one device, read to the end (a failure shows while reading)."""
    if device == "cuda":
        model = WhisperModel(model_size, device="cuda", compute_type="int8_float16")
    else:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, info = BatchedInferencePipeline(model=model).transcribe(
        path, language=lang, word_timestamps=True, batch_size=8
    )
    return list(segments), info


device = "cpu"
if batched:
    segments = None
    if lib_dirs:
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                segments, info = batched_on("cuda")
                device = "cuda"
        except Exception as error:  # any failure of the card: the processor does it, as before
            print(f"The graphics card could not be used ({type(error).__name__}); using the processor.", file=sys.stderr)
            segments = None
    if segments is None:
        segments, info = batched_on("cpu")
elif filtered:
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    # The second pass for captions: the filter on, for what the plain pass skipped (2026-11-23).
    segments, info = model.transcribe(path, language=lang, word_timestamps=True, vad_filter=True)
else:
    # No voice-activity filter for captions (2026-11-22). Under loud game sound it dropped
    # whole sentences and put words up to 6.7 s before they were said; without it, a clip of
    # shouting gave 42 words instead of 4. Without it the model also writes "You" on silence
    # or noise; hallucination_silence_threshold removed that in every sample tried.
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, info = model.transcribe(
        path, language=lang, word_timestamps=True, vad_filter=False, hallucination_silence_threshold=2.0
    )

words = []
for segment in segments:
    for word in segment.words or []:
        entry = {"text": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)}
        # How sure the recogniser is of the word (0 to 1). Only the second pass is asked for it:
        # its words are taken only when it is sure enough.
        if filtered:
            entry["p"] = round(word.probability, 2)
        words.append(entry)

print(json.dumps({"language": info.language, "device": device, "words": words}))
