"""Transcribe one audio file with faster-whisper and print JSON to stdout.

Usage: transcribe.py <audio file> <language> <model size> [batched]

With "batched", the speech is cut into pieces where it pauses and several pieces are
transcribed at once (faster-whisper's BatchedInferencePipeline). That is for a whole
video's transcript, which "Suggested moments" reads; a clip's captions use the plain way,
which they were measured with.

Output: {"language": "en", "words": [{"text": "He", "start": 0.32, "end": 0.48}, ...]}
Times are seconds from the start of the audio file.
"""
import json
import os
import sys

from faster_whisper import BatchedInferencePipeline, WhisperModel

path, lang, model_size = sys.argv[1], sys.argv[2], sys.argv[3]
batched = len(sys.argv) > 4 and sys.argv[4] == "batched"

# Measured on the owner's machine (16 cores under WSL) on 2026-11-21, 116 s of speech: plain with
# faster-whisper's own 4 threads 48 s, plain with 12 threads 228 s (more threads made it slower),
# batched with 4 threads 16 s, with 8 threads 13 s. So batched uses 8 and plain keeps 4, as the
# captions were measured with. CLIPPER_TRANSCRIBE_THREADS overrides both.
threads = int(os.environ.get("CLIPPER_TRANSCRIBE_THREADS") or (min(8, os.cpu_count() or 4) if batched else 4))

model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
if batched:
    segments, info = BatchedInferencePipeline(model=model).transcribe(
        path, language=lang, word_timestamps=True, batch_size=8
    )
else:
    # No voice-activity filter for captions (2026-11-22). Under loud game sound it dropped
    # whole sentences and put words up to 6.7 s before they were said; without it, a clip of
    # shouting gave 42 words instead of 4. Without it the model also writes "You" on silence
    # or noise; hallucination_silence_threshold removed that in every sample tried.
    segments, info = model.transcribe(
        path, language=lang, word_timestamps=True, vad_filter=False, hallucination_silence_threshold=2.0
    )

words = []
for segment in segments:
    for word in segment.words or []:
        words.append({"text": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)})

print(json.dumps({"language": info.language, "words": words}))
