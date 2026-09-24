import {argValue, assertFile, ffprobe, projectPaths, readJson, sha256} from './lib.mjs';

const fail = (errors, message) => errors.push(message);

export const validateProject = async (projectId, {alignmentPath = null} = {}) => {
  const paths = await projectPaths(projectId);
  const {config} = paths;
  const [registry, design, alignment, captions] = await Promise.all([
    readJson(paths.registryPath),
    readJson(paths.designPath),
    readJson(alignmentPath ?? paths.alignmentPath),
    readJson(paths.captionsPath),
  ]);
  const errors = [];
  const warnings = [];

  await Promise.all([
    assertFile(paths.speechPath, 'speech master'),
    assertFile(paths.musicPath, 'music'),
    ...Object.entries(paths.sourcePaths).map(([id, file]) => assertFile(file, id)),
  ]);

  const speechHash = await sha256(paths.speechPath);
  if (speechHash !== design.timing_authority.sha256) {
    fail(errors, `Speech master hash mismatch: ${speechHash}`);
  }
  if (alignment.final_master_sha256 && alignment.final_master_sha256 !== speechHash) {
    fail(errors, 'Word alignment was generated from a different speech master');
  }

  const usedSourceIds = new Set(design.edit_decisions.map((shot) => shot.source_id));
  for (const sourceId of usedSourceIds) {
    const record = registry.sources.find((source) => source.source_id === sourceId);
    const file = paths.sourcePaths[sourceId];
    if (!record || !file) {
      fail(errors, `No registered asset mapping for ${sourceId}`);
      continue;
    }
    const hash = await sha256(file);
    if (hash !== record.sha256) fail(errors, `${sourceId} hash mismatch: ${hash}`);
  }

  const speechProbe = await ffprobe(paths.speechPath);
  const speechDuration = Number(speechProbe.format.duration);
  if (Math.abs(speechDuration - alignment.final_master_duration_seconds) > 0.005) {
    fail(errors, `Speech duration ${speechDuration}s does not match lock ${alignment.final_master_duration_seconds}s`);
  }

  if (config.durationSeconds > config.guards.maxDurationSeconds) {
    fail(errors, `Duration ${config.durationSeconds}s exceeds ${config.guards.maxDurationSeconds}s`);
  }

  const shots = design.edit_decisions;
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const expectedFrames = shot.output_frame_out_exclusive - shot.output_frame_in;
    if (expectedFrames <= 0) fail(errors, `${shot.shot_id} has no output frames`);
    if (!config.visualOverrides[shot.shot_id]) fail(errors, `${shot.shot_id} has no visual override`);
    if (i > 0) {
      const previous = shots[i - 1];
      if (shot.output_frame_in !== previous.output_frame_out_exclusive) {
        fail(errors, `${shot.shot_id} is not frame-contiguous with ${previous.shot_id}`);
      }
    }
  }

  const totalFrames = shots.at(-1).output_frame_out_exclusive;
  if (totalFrames !== Math.round(config.durationSeconds * config.fps)) {
    fail(errors, `Timeline frames ${totalFrames} do not equal configured duration`);
  }

  const words = alignment.words;
  const groups = captions.caption_groups;
  if (!words.length) fail(errors, 'Alignment has no word timings');
  words.forEach((word, index) => {
    if (word.index !== index + 1) fail(errors, `Alignment word index ${word.index} is not sequential at position ${index + 1}`);
  });
  let previousStart = -1;
  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) {
      fail(errors, `Word ${word.index} has invalid timing`);
      continue;
    }
    if (word.start < previousStart) fail(errors, `Word ${word.index} is out of chronological order`);
    if (word.start < 0 || word.end > speechDuration + 0.02) {
      fail(errors, `Word ${word.index} falls outside the final speech master`);
    }
    previousStart = word.start;
  }
  for (const group of groups) {
    const first = words[group.word_index_start - 1];
    const last = words[group.word_index_end - 1];
    if (!first || !last) {
      fail(errors, `${group.caption_id} references missing word indices`);
      continue;
    }
    // The renderer derives each group's visible interval from the active
    // alignment file. Static group times are metadata only and may be stale.
    if (first.start >= config.guards.textFreeStartSeconds || last.end > config.guards.textFreeStartSeconds) {
      fail(errors, `${group.caption_id} violates text-free afterglow`);
    }
  }

  if (config.guards.identityReveal) {
    const {sourceId, notBeforeSeconds} = config.guards.identityReveal;
    const identityShot = shots.find((shot) => shot.source_id === sourceId);
    if (!identityShot || identityShot.output_start_seconds < notBeforeSeconds) {
      fail(errors, `Identity source ${sourceId} appears before ${notBeforeSeconds}s`);
    }
  }

  if (errors.length) {
    throw new Error(`VALIDATION FAILED\n- ${errors.join('\n- ')}`);
  }

  console.log(`PASS ${projectId}`);
  console.log(`  ${shots.length} shots / ${totalFrames} frames / ${config.durationSeconds.toFixed(3)}s`);
  console.log(`  ${words.length} aligned words / ${groups.length} caption groups`);
  console.log(`  source and speech hashes locked`);
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  return {paths, registry, design, alignment, captions};
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const projectId = argValue('--project', 'spiderman');
  const alignmentPath = argValue('--alignment');
  await validateProject(projectId, {alignmentPath});
}
