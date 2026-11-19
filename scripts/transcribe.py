"""Transcribe one audio file with faster-whisper and print JSON to stdout.

Usage: transcribe.py <audio file> <language> <model size>

Output: {"language": "en", "words": [{"text": "He", "start": 0.32, "end": 0.48}, ...]}
Times are seconds from the start of the audio file.
"""
import json
import sys

from faster_whisper import WhisperModel

path, lang, model_size = sys.argv[1], sys.argv[2], sys.argv[3]

model = WhisperModel(model_size, device="cpu", compute_type="int8")
segments, info = model.transcribe(path, language=lang, word_timestamps=True, vad_filter=True)

words = []
for segment in segments:
    for word in segment.words:
        words.append({"text": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)})

print(json.dumps({"language": info.language, "words": words}))
