"""Transcribe one audio file with faster-whisper and print JSON to stdout.

Usage: transcribe.py <audio file> <language> <model size> [batched]

With "batched", the speech is cut into pieces where it pauses and several pieces are
transcribed at once (faster-whisper's BatchedInferencePipeline). That is for a whole
video's transcript, which "Suggested moments" reads; a clip's captions use the plain way,
which they were measured with.

Both use an NVIDIA graphics card when there is one that works, and the processor otherwise
(a whole video's transcript since 2026-11-23, captions since 2026-11-24, after measuring).

Output: {"language": "en", "device": "cuda", "words": [{"text": "He", "start": 0.32, "end": 0.48}, ...]}
Times are seconds from the start of the audio file. "device" says where it ran.
"""
import json
import os
import sys

path, lang, model_size = sys.argv[1], sys.argv[2], sys.argv[3]
batched = len(sys.argv) > 4 and sys.argv[4] == "batched"


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


# The card is tried whenever CLIPPER_TRANSCRIBE_DEVICE is not "cpu". Measured on the owner's
# GTX 1660 Ti: a whole video's transcript (2026-11-23), 5 minutes of a stream, processor 32.8 s,
# card 5.6 to 6.2 s with int8_float16 (float16 12.3 s), the same words. Captions on large-v3-turbo
# (2026-11-24), 60 s and 46 s of two streams: processor 80.2 and 64.4 s, card 9.3 and 9.2 s with
# int8_float16 (float16 36.7 s), 95 and 97% of words the same, starts the same in the median.
want_card = os.environ.get("CLIPPER_TRANSCRIBE_DEVICE", "auto") != "cpu"
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
from faster_whisper.audio import decode_audio  # noqa: E402

PIECE_SECONDS = 10.0
# How far from the 10-second mark the end of a piece may be moved to find a quiet moment.
PIECE_SLACK = 1.5


def pieces_of(sound, rate):
    """The start and end, in seconds, of each piece a clip's sound is listened to in."""
    import numpy as np

    total = len(sound) / rate
    frame = int(rate * 0.05)  # loudness is measured 20 times a second
    count = len(sound) // frame
    if count == 0:
        return [(0.0, total)]
    loud = np.sqrt(np.mean(sound[: count * frame].reshape(count, frame).astype(np.float64) ** 2, axis=1))
    pieces = []
    start = 0.0
    while total - start > PIECE_SECONDS + PIECE_SLACK:
        low = int((start + PIECE_SECONDS - PIECE_SLACK) / 0.05)
        high = int((start + PIECE_SECONDS + PIECE_SLACK) / 0.05)
        end = round((low + int(np.argmin(loud[low:high]))) * 0.05 + 0.025, 2)
        pieces.append((start, end))
        start = end
    pieces.append((start, round(total, 2)))
    return pieces


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


def captions_on(device):
    """A clip's captions on one device, read to the end (a failure shows while reading)."""
    if device == "cuda":
        model = WhisperModel(model_size, device="cuda", compute_type="int8_float16")
    else:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    # No voice-activity filter for captions (2026-11-22). Under loud game sound it dropped
    # whole sentences and put words up to 6.7 s before they were said; without it, a clip of
    # shouting gave 42 words instead of 4. Without it the model also writes "You" on silence
    # or noise; hallucination_silence_threshold removed that in every sample tried.
    # The sound is listened to in short pieces, each on its own (2026-11-24). Given a whole clip, the
    # recogniser skips stretches of it: on a 46-second clip of a loud stream it wrote words for 18 of
    # the seconds; given the same sound in pieces of about 10 seconds, for 37. Each piece ends at the
    # quietest moment near its end, so a word is not cut in two.
    sound = decode_audio(path, sampling_rate=16000)
    heard_all, info = [], None
    for start, end in pieces_of(sound, 16000):
        heard, info = model.transcribe(
            sound, language=lang, word_timestamps=True, vad_filter=False, hallucination_silence_threshold=2.0,
            clip_timestamps=[start, end],
        )
        heard_all.extend(list(heard))
    return heard_all, info


make = batched_on if batched else captions_on
device = "cpu"
segments = None
if lib_dirs:
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            segments, info = make("cuda")
            device = "cuda"
    except Exception as error:  # any failure of the card: the processor does it, as before
        print(f"The graphics card could not be used ({type(error).__name__}); using the processor.", file=sys.stderr)
        segments = None
if segments is None:
    segments, info = make("cpu")

words = []
for segment in segments:
    for word in segment.words or []:
        words.append({"text": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)})

print(json.dumps({"language": info.language, "device": device, "words": words}))
