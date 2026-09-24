# FROG Simple V1

Deterministic local renderer for FROGshort. The creative decisions are locked in JSON; rendering does not call an LLM and does not spend model credits.

## Terminal entry point (local)

From this folder, with Node.js 20+, FFmpeg, FFprobe, and ImageMagick available:

```bash
node scripts/frog.mjs doctor --project spiderman
node scripts/frog.mjs check --project spiderman
node scripts/frog.mjs preview --project spiderman
# When local WhisperX is installed and the script, VO and RAW are locked:
node scripts/frog.mjs preview --project spiderman --align
node scripts/frog.mjs final --project spiderman
```

`preview` writes `output/<project>-preview.mp4` and runs media and caption QC. `final` always runs local ASR + forced alignment, blocks on transcript disagreement, and writes `output/<project>-final.mp4` only after the gates pass. The project config locks `captions.revealMode: "single-word"`; after each render QC checks the actual `.ass` events against the approved caption text, catching repeated/cumulative words. For this pilot, a final export is still blocked pending a verified alignment: the existing V3 timestamps are explicitly review estimates. The previously approved V4 is a review preview, not a verified final.

### What can be automated today

After a story's facts, source clips, edit plan, approved script and final voice file are supplied and locked, the terminal can validate source/audio hashes, align captions locally, render, and run QC. The output is deterministic for the same inputs. RAW, VO, music and rendered videos are deliberately excluded from Git; a clone alone cannot reproduce the Spider-Man render without those assets.

Story research and source verification, choosing a safe hook, sourcing usable RAW, approving the script, and producing the ElevenLabs voice in the current no-API setup are **not** automated by this repository. A story title or URL alone is insufficient to generate a trustworthy finished clip. Automated arrow placement and factual/visual review also need a case-specific check. The sensible next increment is one new story through this terminal entry point with a source manifest and final VO, then automate only the repeated preparation steps observed in that run. Grill Me is useful when choosing policy, sourcing and approval boundaries for that increment; it is not needed to lock this caption rule.

## Requirements

- Node.js 20+
- FFmpeg and FFprobe on `PATH`
- ImageMagick `convert` on `PATH` (used only to draw the deterministic hook arrow)

## Spider-Man pilot

The active Spider-Man project is a **V3 review preview**. It keeps the source hashes and 18-shot picture timeline, removes a detached `work` after the interview quote from the speech master, and retimes 113 caption words using measured silence intervals. These word timings are review estimates, not a completed word-level forced alignment. The original V2 locks remain in `source-lock/` for reference. The renderer blocks a V3 final while the review estimate is active.

The approved V4 caption treatment shows **one active word only**: `HIS → NAME → WAS`, never `HIS → HIS NAME → HIS NAME WAS`. The caption group still controls wording and punctuation; the final VO controls timings.

```powershell
npm run validate
npm run preview
npm run qc:preview
```

## Automatic local captions (no LLM/API)

After the one-time local setup and model download, use:

```powershell
npm run auto-preview
npm run auto-render
```

The automatic path does four things in order:

1. Transcribes the final VO locally with WhisperX and writes an ASR audit.
2. Uses the approved locked transcript as the alignment text. ASR disagreement is recorded as a diagnostic; it does not replace the approved words or automatically stop the run.
3. Force-aligns each locked audio segment to the same VO and checks word count, timestamps, chronology, and alignment confidence.
4. A review preview can render with fresh timings and a visible ASR audit. A final render is blocked if ASR and the locked transcript disagree; resolve that transcript discrepancy first. Passing both alignment and transcript gates runs media QC.

The approved script and creative caption wording remain locked. Only timestamps are regenerated. Group end times are derived from the new word alignment, not copied from an old timing file. Missing words from the aligner, low-confidence timings, invalid timestamps, or timing outside the audio block rendering.

ASR and forced alignment answer different questions: ASR guesses what was spoken; forced alignment asks where a supplied transcript fits. An ASR disagreement is not proof that the word lock is wrong, and a forced alignment pass is not proof that the word lock is complete. If the human-approved transcript itself is wrong, the alignment can still try to fit it to nearby audio. For that reason, ASR mismatches remain visible in `tmp/<project>/whisperx-asr-audit.json`; unresolved mismatches need transcript review before publishing. This gate is designed to prevent timing drift and silent guessing, not to claim mathematical certainty or guarantee zero human review on every recording.

### One-time aligner setup

WhisperX is a local Python model, separate from the video renderer. Its first setup downloads Python packages and model weights; inference then runs locally and uses no paid LLM/API. Downloads and any library telemetry are separate from inference; this prototype has not been verified in fully offline mode. On Windows, run the project under WSL2 so WhisperX's Linux audio/model dependencies behave consistently. Install the CPU-only version once:

```bash
python3.12 -m venv .venv-whisperx
source .venv-whisperx/bin/activate
python -m pip install --upgrade pip
python -m pip install torch==2.8.0+cpu torchaudio==2.8.0+cpu torchvision==0.23.0+cpu --index-url https://download.pytorch.org/whl/cpu
python -m pip install whisperx==3.8.6 --extra-index-url https://download.pytorch.org/whl/cpu
python -m nltk.downloader punkt_tab
```

Then run `npm run auto-preview` from the same project directory. The first pass downloads the `small.en` ASR model and its English alignment model. If local CPU runtime is too slow or it misrecognizes a proper name, run with a stronger model via Node arguments, for example `node scripts/auto-render.mjs --project spiderman --preset preview --model medium.en`. Any disagreement with the approved script blocks rendering instead of silently accepting guessed captions.

WhisperX's model output is still not a mathematical guarantee of what a listener hears. The alignment gate prevents missing, low-score, or invalid word timings; the ASR audit flags possible transcript issues without treating ASR as ground truth. Overlapping voices, ambiguous names, or unresolved transcript disagreements may still need a human decision before publishing. The Spider-Man pilot recorded one such disagreement in `docs/SPIDERMAN_ASR_CHECK.md`. Treat the automatic renderer as a prototype until a full alignment pass has been reviewed against the VO.

Outputs:

- `output/spiderman-preview.mp4` — 540×960 V3 review render
- `output/spiderman-final.mp4` — previous V2 output; do not treat it as the V3 result

Only the review preview has been rerendered with V3 timing. The older final output has not been updated and has not passed the new ASR gate.

## Rules enforced before rendering

- Speech-master SHA-256 must match the lock.
- Every used RAW file must match the source registry.
- Shots must be frame-contiguous.
- Final duration must not exceed 59 seconds.
- Captions cannot lead their aligned words.
- Every active alignment word must have an ordered, in-range start/end time.
- Christopher cannot appear unmasked before 28.53 seconds.
- The Spider-Man project explicitly locks source `SRC_03` to appear no earlier than 28.53 seconds; other projects must define their own reveal rule if needed.
- No captions are allowed in the final afterglow from 43.988 seconds.

## Repository policy

Git tracks the renderer, project configuration, locked JSON, fonts, and documentation. RAW, voice, music, temporary files, and rendered outputs are ignored. Keep media outside Git and place it in `projects/<case>/assets/` using the filenames declared by `project.json`.

This V1 deliberately excludes automatic story research, AI B-roll, complex transitions, upload automation, and per-render creative decisions.
