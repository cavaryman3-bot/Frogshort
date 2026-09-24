# Spider-Man pilot: ASR check

## Result

- Input: locked `FINAL_SPEECH_MASTER_V2.wav`
- Local ASR: WhisperX `small.en`, CPU / int8
- ASR transcript was compared with the approved word lock.
- In the original workflow, alignment and rendering did not run because the transcript gate found a mismatch.
- No new final video was produced from this ASR run.

## Differences found

After treating `20` and `twenty` as equivalent, one ASR pass produced these differences:

- The approved text has `at work` after `a superhero event`; ASR did not recognize those words there.
- ASR produced an extra `work` after `I got you`.

The ASR text around this passage was:

> A 20-year-old, fresh from a superhero event. I just told the man. I said, don't worry. I got you. Work. He admitted he worried people might think he looked ridiculous.

This is one model's transcript, not proof that the approved narration is wrong. The first workflow revision treated this difference as a hard stop before alignment, which was too early: the ASR result should be audited, while the locked text should still be passed through forced alignment. Final export should remain blocked until any ASR disagreement is resolved.

## What remains unverified

WhisperX's forced-alignment step could not run here because its local `punkt_tab` tokenizer data was missing, and the configured proxy rejected NLTK's remote fetch for security. No attempt was made to bypass that restriction. The ASR transcript audit is stored locally under `tmp/spiderman/whisperx-asr-audit.json` and is not part of the source lock.

The next valid check is to resolve which words are actually audible in the VO around the narrator-to-interview transition, then align the confirmed wording to the VO. Do not update the locked script or ship captions based on this single ASR result alone.

## Follow-up: disputed `work` after the interview quote

The creator confirmed hearing `work` after “I got you” in the exact speech-master sample. The previous conclusion checked only the silence from 34.898s to 35.228s and missed the spoken interval **beginning at 35.228s**. In V2, that next interval is labeled `He` in the word lock, while ASR reports `work`; then the voice goes quiet again from 35.613s to 36.319s. The first V2 caption `HIS` starts at 26.21s, inside a separate silence from 26.113s to 27.233s. This explains the early captions the creator reported. The silence intervals and ASR transcript support a shifted lock and an out-of-place word; they do not provide exact acoustic boundaries for every word.

## V3 review correction

- Preserve all V2 source-lock files and the V2 speech master.
- Make `FINAL_SPEECH_MASTER_V3_REVIEW.wav` from V2 `[0, 35.228)` followed by `[36.3188, 45.480458)`, removing the detached `work` and subsequent silence after the interview.
- Omit `at work` from the approved **review** caption text: the V2 edit did not keep the phrase together, and ASR recognized the narrator as ending at `event` before the interview.
- Retarget phrase intervals from measured silence anchors and interpolate word starts within each phrase; keep the authentic interview bite unchanged.
- Point the opening arrow at the red Jeep in the actual opening frame. Extend the final active shot to 44.4s so captions finish before the text-free afterglow.

The V3 word times are explicitly marked as review estimates. The direct MP4 preview is for listening and visual review. Final rendering remains blocked until actual word-level alignment is verified and any transcript disagreement is resolved.
