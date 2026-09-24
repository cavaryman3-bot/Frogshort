import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  argValue,
  escapeAss,
  escapeFilterPath,
  hexToAss,
  root,
  run,
  secondsToAss,
} from './lib.mjs';
import {validateProject} from './validate.mjs';

const projectId = argValue('--project', 'spiderman');
const preset = argValue('--preset', 'preview');
const alignmentPath = argValue('--alignment');
if (!['preview', 'final'].includes(preset)) throw new Error(`Unknown preset: ${preset}`);

const locked = await validateProject(projectId, {alignmentPath});
const {paths, design} = locked;
const alignment = locked.alignment;
const captions = locked.captions;
const {config} = paths;
if (config.captions.revealMode !== 'single-word') {
  throw new Error('Caption style lock: captions.revealMode must be single-word');
}
if (preset === 'final' && alignment.alignment_evidence?.manual_review_required) {
  throw new Error('FINAL RENDER BLOCKED: active caption timing is a review estimate; approve a verified word alignment first.');
}
const outputWidth = preset === 'preview' ? 540 : config.canvas.width;
const outputHeight = preset === 'preview' ? 960 : config.canvas.height;
const outputFile = path.join(root, 'output', `${projectId}-${preset}.mp4`);
const workDir = path.join(root, 'tmp', `${projectId}-${preset}`);
const shotDir = path.join(workDir, 'shots');
const assFile = path.join(workDir, 'captions.ass');
const concatFile = path.join(workDir, 'concat.txt');

await rm(workDir, {recursive: true, force: true});
await mkdir(shotDir, {recursive: true});
await mkdir(path.dirname(outputFile), {recursive: true});

const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: FROG,${config.captions.fontFamily},${config.captions.fontSize},${hexToAss(config.captions.textColor)},${hexToAss(config.captions.activeColor)},${hexToAss(config.captions.outlineColor)},&H55000000,-1,0,0,0,100,100,0,0,1,7,2,5,40,40,0,1
Style: DOC,Montserrat,50,${hexToAss(config.captions.textColor)},${hexToAss(config.captions.activeColor)},${hexToAss(config.captions.outlineColor)},&H66000000,-1,0,0,0,100,100,0,0,1,5,1,2,55,55,0,1
Style: WATERMARK,Montserrat,30,&HAAFFFFFF,&HAAFFFFFF,&H88000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,7,32,32,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const wordsByIndex = new Map(alignment.words.map((word) => [word.index, word]));
const dialogue = [];
const normalizeWord = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
for (const group of captions.caption_groups) {
  const style = group.style === 'DOCUMENTARY_LOWER_THIRD' ? 'DOC' : 'FROG';
  const anchorY = style === 'DOC' ? config.captions.documentaryY : config.captions.anchorY;
  const alignedWords = [];
  for (let index = group.word_index_start; index <= group.word_index_end; index += 1) {
    const aligned = wordsByIndex.get(index);
    if (!aligned) throw new Error(`${group.caption_id} references missing word ${index}`);
    alignedWords.push(aligned);
  }

  // Keep approved wording and punctuation. Alignment supplies timing only.
  // Split hyphenated compounds into the spoken words that make them up.
  // Show each word by itself; do not accumulate earlier words in the group.
  const displayTokens = group.text.trim().split(/\s+/);
  const revealUnits = [];
  let sourceIndex = 0;
  for (const displayToken of displayTokens) {
    const parts = displayToken.split('-');
    const mappedParts = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const target = normalizeWord(part);
      let combined = '';
      let consumed = 0;
      while (sourceIndex + consumed < alignedWords.length && combined.length < target.length) {
        combined += normalizeWord(alignedWords[sourceIndex + consumed].word);
        consumed += 1;
        if (combined === target) break;
      }
      if (!consumed || combined !== target) {
        throw new Error(
          `${group.caption_id} text "${displayToken}" does not match aligned word "${alignedWords[sourceIndex]?.word ?? 'EOF'}"`,
        );
      }
      const sourceSpan = alignedWords.slice(sourceIndex, sourceIndex + consumed);
      sourceIndex += consumed;
      mappedParts.push({
        sourceSpan,
        text: part,
      });
    }
    for (const mapped of mappedParts) {
      revealUnits.push({
        text: mapped.text,
        start: mapped.sourceSpan[0].start,
      });
    }
  }
  if (sourceIndex !== alignedWords.length) {
    throw new Error(`${group.caption_id} display text leaves aligned word(s) unused`);
  }

  for (let active = 0; active < revealUnits.length; active += 1) {
    const current = revealUnits[active];
    const next = revealUnits[active + 1];
    const start = current.start;
    const groupEnd = wordsByIndex.get(group.word_index_end)?.end;
    const end = next ? next.start : groupEnd;
    if (end <= start) continue;
    const visible = `{\\c${hexToAss(config.captions.activeColor)}\\blur1.1}${escapeAss(current.text)}`;
    const label = style === 'DOC' && config.captions.documentarySpeaker
      ? `{\\fs30\\c&H00B5F4FF&}${escapeAss(config.captions.documentarySpeaker)}\\N{\\fs50}`
      : '';
    dialogue.push(
      `Dialogue: 2,${secondsToAss(start)},${secondsToAss(end)},${style},${group.caption_id},0,0,0,,{\\an5\\pos(${config.captions.anchorX},${anchorY})}${label}${visible}`,
    );
  }
}
dialogue.push(`Dialogue: 1,0:00:00.00,${secondsToAss(config.durationSeconds)},WATERMARK,FROG,0,0,0,,FROGshort`);
await writeFile(assFile, assHeader + dialogue.join('\n') + '\n', 'utf8');

const scaledSafeHeight = Math.round(config.canvas.safeHeight * outputHeight / config.canvas.height);
const scaledSafeY = Math.round(config.canvas.safeY * outputHeight / config.canvas.height);
const arrowPng = path.join(workDir, 'hook-arrow.png');
const arrowScale = outputWidth / 1080;
await run('convert', [
  '-size', `${Math.round(400 * arrowScale)}x${Math.round(420 * arrowScale)}`,
  'xc:none',
  '-stroke', '#ff334f',
  '-strokewidth', String(Math.max(6, Math.round(16 * arrowScale))),
  '-fill', 'none',
  '-draw',
  `path 'M ${340 * arrowScale},${40 * arrowScale} C ${316 * arrowScale},${146 * arrowScale} ${224 * arrowScale},${272 * arrowScale} ${80 * arrowScale},${355 * arrowScale} M ${150 * arrowScale},${340 * arrowScale} L ${80 * arrowScale},${355 * arrowScale} L ${110 * arrowScale},${289 * arrowScale}'`,
  arrowPng,
]);

const shotFiles = [];
for (const shot of design.edit_decisions) {
  const source = paths.sourcePaths[shot.source_id];
  const override = config.visualOverrides[shot.shot_id];
  const shotFrames = shot.output_frame_out_exclusive - shot.output_frame_in;
  const sourceDuration = shot.source_out_seconds - shot.source_in_seconds;
  const shotFile = path.join(shotDir, `${shot.shot_id}.mp4`);
  const inputArgs = ['-hide_banner', '-loglevel', 'error', '-ss', String(shot.source_in_seconds), '-i', source];
  const filterParts = [];
  let sourceLabel = 'base';
  const freeze = override.hookFreezeSeconds ?? 0;
  const outputDuration = shotFrames / config.fps;
  const trailingPad = Math.max(0.1, outputDuration - sourceDuration - freeze + 0.1);
  filterParts.push(
    `[0:v]setpts=PTS-STARTPTS,fps=${config.fps},eq=contrast=1.04:saturation=1.04:gamma=1.01,` +
      `tpad=start_mode=clone:start_duration=${freeze}:stop_mode=clone:stop_duration=${trailingPad}[${sourceLabel}]`,
  );
  filterParts.push(
    `[${sourceLabel}]split=2[bgsrc][fgsrc]`,
    `[bgsrc]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,` +
      `crop=${outputWidth}:${outputHeight},boxblur=18:2,eq=brightness=-0.14:saturation=0.72[bg]`,
  );
  if (override.mode === 'contain') {
    filterParts.push(
      `[fgsrc]scale=${outputWidth}:${scaledSafeHeight}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[composed]`,
    );
  } else {
    const cropWidthExpr = `ih*${override.cropAspect ?? 0.75}`;
    const focusExpr = `min(max(iw*${override.focusX}-${cropWidthExpr}/2\\,0)\\,iw-${cropWidthExpr})`;
    if (override.mode === 'portrait') {
      filterParts.push(
        `[fgsrc]crop=${cropWidthExpr}:ih:${focusExpr}:0,scale=${outputWidth}:-2[fg]`,
        `[bg][fg]overlay=0:(H-h)/2[composed]`,
      );
    } else {
      filterParts.push(
        `[fgsrc]crop=${cropWidthExpr}:ih:${focusExpr}:0,scale=${outputWidth}:${scaledSafeHeight}[fg]`,
        `[bg][fg]overlay=0:${scaledSafeY}[composed]`,
      );
    }
  }
  if (override.arrow) {
    inputArgs.push('-loop', '1', '-i', arrowPng);
    const arrowWidth = Math.round(400 * outputWidth / 1080);
    const arrowX = Math.round(outputWidth * 0.5);
    const arrowY = Math.round(outputHeight * 0.26);
    filterParts.push(
      `[1:v]scale=${arrowWidth}:-1[arrow]`,
      `[composed][arrow]overlay=${arrowX}:${arrowY}:enable='lt(t\\,${freeze})'[outv]`,
    );
  } else {
    filterParts.push('[composed]null[outv]');
  }
  await run('ffmpeg', [
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-frames:v', String(shotFrames),
    '-r', String(config.fps),
    '-an',
    '-c:v', 'libx264',
    '-preset', preset === 'preview' ? 'veryfast' : 'medium',
    '-crf', preset === 'preview' ? '30' : '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', shotFile,
  ]);
  shotFiles.push(shotFile);
  console.log(`SHOT ${shot.shot_id} ${shotFrames}f`);
}

const concatText = shotFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
await writeFile(concatFile, concatText, 'utf8');

const musicGain = config.audio.musicGain;
const duckGain = config.audio.musicGainDuringInterview;
const audioFilter =
  `[1:a]atrim=0:${config.durationSeconds},asetpts=PTS-STARTPTS[speech];` +
  `[2:a]atrim=0:${config.durationSeconds},asetpts=PTS-STARTPTS,` +
  `volume=if(between(t\\,${config.audio.interviewDuckStart}\\,${config.audio.interviewDuckEnd})\\,${duckGain}\\,${musicGain})[music];` +
  `[speech][music]amix=inputs=2:duration=longest:normalize=0,` +
  `loudnorm=I=${config.audio.targetLufs}:TP=${config.audio.truePeakDb}:LRA=11[aout]`;
const videoFilter = `subtitles='${escapeFilterPath(assFile)}':fontsdir='${escapeFilterPath(path.join(root, 'fonts'))}'[vout]`;

await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', concatFile,
  '-i', paths.speechPath,
  '-stream_loop', '-1', '-i', paths.musicPath,
  '-filter_complex', `[0:v]${videoFilter};${audioFilter}`,
  '-map', '[vout]', '-map', '[aout]',
  '-t', String(config.durationSeconds),
  '-r', String(config.fps),
  '-c:v', 'libx264',
  '-preset', preset === 'preview' ? 'veryfast' : 'medium',
  '-crf', preset === 'preview' ? '29' : '18',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', preset === 'preview' ? '128k' : '192k',
  '-movflags', '+faststart',
  '-y', outputFile,
]);

console.log(`RENDERED ${outputFile}`);
