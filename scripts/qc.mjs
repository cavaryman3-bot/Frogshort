import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {argValue, ffprobe, projectPaths, readJson, root, run} from './lib.mjs';

const projectId = argValue('--project', 'spiderman');
const preset = argValue('--preset', 'final');
if (!['preview', 'final'].includes(preset)) throw new Error(`Unknown preset: ${preset}`);
const paths = await projectPaths(projectId);
const {config} = paths;
const file = path.resolve(root, argValue('--file', `output/${projectId}-${preset}.mp4`));
const expected = preset === 'preview'
  ? {width: Math.round(config.canvas.width / 2), height: Math.round(config.canvas.height / 2)}
  : {width: config.canvas.width, height: config.canvas.height};
const probe = await ffprobe(file);
const video = probe.streams.find((stream) => stream.codec_type === 'video');
const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
const errors = [];

// Check the actual subtitle events produced for this render, including the
// interview label, so word accumulation cannot slip back into an export.
if (config.captions.revealMode === 'single-word') {
  const captions = await readJson(paths.captionsPath);
  const assPath = path.join(root, 'tmp', `${projectId}-${preset}`, 'captions.ass');
  const ass = await readFile(assPath, 'utf8').catch(() => null);
  if (!ass) {
    errors.push(`missing caption events: ${assPath}`);
  } else {
    const expected = captions.caption_groups.flatMap((group) => group.text.trim().split(/[\s-]+/).filter(Boolean));
    const actual = [...ass.matchAll(/^Dialogue: 2,[^,]*,[^,]*,[^,]*,(CAP_[^,]*),[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/gm)]
      .map(([, , text]) => text.replace(/\{[^}]*\}/g, '').split('\\N').at(-1).trim());
    const normalize = (word) => word.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (actual.length !== expected.length || actual.some((word, i) => word.includes(' ') || normalize(word) !== normalize(expected[i]))) {
      errors.push(`single-word captions mismatch: ${actual.length} visible events vs ${expected.length} locked words`);
    }
  }
}

if (!video) errors.push('missing video stream');
if (!audio) errors.push('missing audio stream');
if (video && (video.width !== expected.width || video.height !== expected.height)) {
  errors.push(`wrong dimensions ${video.width}x${video.height}`);
}
if (video && Math.abs(Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1]) - config.fps) > 0.001) {
  errors.push(`wrong fps ${video.r_frame_rate}`);
}
const duration = Number(probe.format.duration);
if (Math.abs(duration - config.durationSeconds) > 0.08) errors.push(`wrong duration ${duration}s`);

const black = await run(
  'ffmpeg',
  ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.12:pix_th=0.02', '-an', '-f', 'null', '-'],
  {capture: true},
);
const blackFrames = [...black.stderr.matchAll(/black_start:([0-9.]+).*black_end:([0-9.]+)/g)];
if (blackFrames.length) errors.push(`detected ${blackFrames.length} black segment(s)`);

const loudness = await run(
  'ffmpeg',
  ['-hide_banner', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
  {capture: true},
);
const integratedMatches = [...loudness.stderr.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)];
const peakMatches = [...loudness.stderr.matchAll(/Peak:\s+(-?[0-9.]+) dBFS/g)];
const integrated = integratedMatches.at(-1)?.[1] ?? 'unknown';
const peak = peakMatches.at(-1)?.[1] ?? 'unknown';

if (errors.length) throw new Error(`QC FAILED\n- ${errors.join('\n- ')}`);
console.log(`QC PASS ${file}`);
console.log(`  ${video.width}x${video.height} @ ${video.r_frame_rate} / ${duration.toFixed(3)}s`);
console.log(`  H.264 + AAC / ${video.nb_frames ?? 'frame count unavailable'} frames`);
console.log(`  Integrated loudness ${integrated} LUFS / true peak ${peak} dBFS`);
console.log('  no black segment >= 0.12s');
if (config.captions.revealMode === 'single-word') console.log('  single-word captions match locked text in render order');
