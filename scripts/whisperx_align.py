#!/usr/bin/env python3
"""Local transcript audit and fail-closed forced alignment for FROG projects."""

import argparse
import difflib
import hashlib
import json
import re
import sys
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NUMBER_FORMS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
    "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen",
    "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen",
    "18": "eighteen", "19": "nineteen", "20": "twenty", "30": "thirty",
    "40": "forty", "50": "fifty", "60": "sixty", "70": "seventy",
    "80": "eighty", "90": "ninety", "100": "one hundred",
}


def fail(message: str) -> None:
    print(f"AUTO-CAPTION BLOCKED: {message}", file=sys.stderr)
    raise SystemExit(2)


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def tokens(text: str) -> list[str]:
    # Ignore typography/punctuation but preserve spoken lexical differences.
    raw = [part.replace("'", "") for part in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+", text.lower())]
    normalized = []
    for part in raw:
        normalized.extend(NUMBER_FORMS.get(part, part).split())
    return normalized


def describe_diff(expected: list[str], actual: list[str]) -> str:
    matcher = difflib.SequenceMatcher(a=expected, b=actual, autojunk=False)
    issues = []
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            continue
        before = " ".join(expected[max(0, a0 - 3):min(len(expected), a1 + 3)]) or "<none>"
        heard = " ".join(actual[max(0, b0 - 3):min(len(actual), b1 + 3)]) or "<none>"
        issues.append(f"{tag}: script [{before}] vs audio [{heard}]")
    return "; ".join(issues[:8])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="spiderman")
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()

    project = ROOT / "projects" / args.project
    config = load_json(project / "project.json")
    alignment_path = project / config["locked"]["wordAlignment"]
    design_path = project / config["locked"]["editDesign"]
    speech_path = project / config["assets"]["speech"]
    locked = load_json(alignment_path)
    design = load_json(design_path)
    speech_hash = hashlib.sha256(speech_path.read_bytes()).hexdigest()
    if speech_hash != design["timing_authority"]["sha256"]:
        fail("VO master does not match the project lock; align only after final VO is locked")

    expected_words = [word["word"] for word in locked["words"]]
    expected = tokens(" ".join(expected_words))
    if len(expected) != len(locked["words"]):
        fail("locked transcript has a word that cannot be safely compared")
    if not expected:
        fail("locked transcript is empty")

    with wave.open(str(speech_path), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()

    try:
        import whisperx
    except ImportError:
        fail("WhisperX is not installed in the selected Python environment")

    print(f"ASR: {args.model} / {args.device} / {args.compute_type}", flush=True)
    asr = whisperx.load_model(args.model, args.device, compute_type=args.compute_type, language="en")
    audio = whisperx.load_audio(str(speech_path))
    transcript = asr.transcribe(audio, batch_size=args.batch_size)
    actual_segments = transcript.get("segments", [])
    actual = tokens(" ".join(segment.get("text", "") for segment in actual_segments))
    output_dir = ROOT / "tmp" / args.project
    output_dir.mkdir(parents=True, exist_ok=True)
    audit = {
        "project": args.project,
        "speech_sha256": speech_hash,
        "model": args.model,
        "expected_tokens": expected,
        "recognized_tokens": actual,
        "recognized_text": " ".join(segment.get("text", "").strip() for segment in actual_segments).strip(),
        "segments": [
            {"start": segment.get("start"), "end": segment.get("end"), "text": segment.get("text", "")}
            for segment in actual_segments
        ],
        "transcript_matches": actual == expected,
    }
    audit_path = output_dir / "whisperx-asr-audit.json"
    audit_path.write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    transcript_matches = actual == expected
    if transcript_matches:
        print(f"ASR audit matches approved script ({len(expected)} words)", flush=True)
    else:
        # ASR is fallible: keep the discrepancy visible, but don't let its
        # guessed transcript replace or veto the human-approved word lock.
        # The forced aligner below tests the locked words against the audio.
        print(f"ASR audit differs from approved script: {describe_diff(expected, actual)}", file=sys.stderr)
        print(f"Continuing with locked transcript; audit: {audit_path}", flush=True)

    try:
        import nltk
        nltk.data.find("tokenizers/punkt_tab/english")
    except LookupError:
        fail("WhisperX needs the local NLTK punkt_tab data once; install it during setup before alignment")

    align_model, metadata = whisperx.load_align_model(language_code="en", device=args.device)
    # Preserve the approved wording and split by locked edit/audio segment,
    # rather than inheriting ASR's broad or misplaced segment boundaries.
    grouped_words = []
    for source_word in locked["words"]:
        segment_id = source_word.get("segment_id", "WHOLE_VO")
        if not grouped_words or grouped_words[-1]["segment_id"] != segment_id:
            grouped_words.append({"segment_id": segment_id, "words": []})
        grouped_words[-1]["words"].append(source_word)

    forced_segments = []
    word_counts = []
    for group in grouped_words:
        segment_words = group["words"]
        segment_start = max(0.0, min(float(word["start"]) for word in segment_words) - 0.20)
        segment_end = min(duration, max(float(word["end"]) for word in segment_words) + 0.20)
        segment_text = " ".join(word["word"] for word in segment_words)
        segment_tokens = tokens(segment_text)
        if len(segment_tokens) != len(segment_words):
            fail(f"Locked segment {group['segment_id']} contains a non-1:1 tokenization")
        forced_segments.append({"start": segment_start, "end": segment_end, "text": segment_text})
        word_counts.append(len(segment_words))

    aligned = whisperx.align(
        forced_segments,
        align_model,
        metadata,
        audio,
        args.device,
        return_char_alignments=False,
    )
    aligned_segments = aligned.get("segments", [])
    if len(aligned_segments) != len(forced_segments):
        fail(f"aligner returned {len(aligned_segments)}/{len(forced_segments)} locked segments")
    observed = []
    for index, (segment, expected_count) in enumerate(zip(aligned_segments, word_counts), start=1):
        segment_words = segment.get("words", [])
        if len(segment_words) != expected_count:
            fail(f"aligner returned {len(segment_words)}/{expected_count} words in locked segment {index}")
        observed.extend(segment_words)
    if len(observed) != len(expected_words):
        fail(f"aligner returned {len(observed)}/{len(expected_words)} word timings")

    words = []
    prior_start = -1.0
    for index, (source_word, aligned_word, expected_token) in enumerate(
        zip(locked["words"], observed, expected), start=1
    ):
        start = aligned_word.get("start")
        end = aligned_word.get("end")
        observed_token = tokens(aligned_word.get("word", ""))
        if observed_token != [expected_token]:
            fail(f"word {index} token changed during forced alignment")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            fail(f"word {index} ({source_word['word']}) could not be aligned")
        score = aligned_word.get("score")
        if not isinstance(score, (int, float)) or score < 0.05:
            fail(f"word {index} ({source_word['word']}) has no reliable phoneme alignment score")
        if start < 0 or end <= start or end > duration + 0.02:
            fail(f"word {index} ({source_word['word']}) has invalid timing {start}-{end}")
        if start < prior_start:
            fail(f"word {index} ({source_word['word']}) is out of chronological order")
        prior_start = start
        item = {**source_word, "start": round(float(start), 4), "end": round(float(end), 4)}
        item["alignment_score"] = round(float(score), 4)
        words.append(item)

    output = output_dir / "whisperx-word-alignment.json"
    result = {
        **locked,
        "final_master_sha256": speech_hash,
        "final_master_duration_seconds": round(duration, 4),
        "alignment_method": "WhisperX wav2vec2 forced alignment of locked transcript; local ASR is diagnostic",
        "alignment_evidence": {
            **locked.get("alignment_evidence", {}),
            "method": "WhisperX local word-level forced alignment of locked transcript",
            "word_level_forced_alignment_completed": True,
            "manual_review_required": not transcript_matches,
        },
        "asr_model": args.model,
        "asr_transcript_matches_lock": transcript_matches,
        "recognized_transcript": " ".join(segment.get("text", "").strip() for segment in actual_segments).strip(),
        "words": words,
    }
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    audit_state = "matches" if transcript_matches else "differs from"
    print(f"PASS: forced-aligned {len(words)} locked words; ASR {audit_state} approved transcript")
    print(f"ALIGNMENT_FILE {output}")


if __name__ == "__main__":
    main()
