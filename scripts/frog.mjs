import {access} from 'node:fs/promises';
import path from 'node:path';
import {argValue, projectPaths, root, run} from './lib.mjs';

const command = process.argv[2];
const projectId = argValue('--project', 'spiderman');
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(projectId)) throw new Error('Invalid project ID');
if (!['doctor', 'check', 'preview', 'final'].includes(command)) {
  throw new Error('Usage: node scripts/frog.mjs <doctor|check|preview|final> --project <id> [--align]');
}

const paths = await projectPaths(projectId);
const alignerPython = process.env.FROG_WHISPERX_PYTHON || path.join(root, '.venv-whisperx', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const required = [
  ['locked registry', paths.registryPath],
  ['locked shot plan', paths.designPath],
  ['locked transcript / timings', paths.alignmentPath],
  ['locked caption groups', paths.captionsPath],
  ['final VO', paths.speechPath],
  ['music', paths.musicPath],
  ...Object.entries(paths.sourcePaths).map(([id, file]) => [`RAW ${id}`, file]),
];
const missing = [];
for (const [label, file] of required) {
  if (!(await access(file).then(() => true).catch(() => false))) missing.push(`${label}: ${file}`);
}
if (command === 'doctor') {
  console.log(`PROJECT ${projectId}`);
  console.log(missing.length ? `MISSING\n- ${missing.join('\n- ')}` : 'All locked inputs and media are present.');
  for (const bin of ['ffmpeg', 'ffprobe', 'convert']) {
    try {
      await run(bin, ['-version'], {capture: true});
      console.log(`${bin}: available`);
    } catch {
      console.log(`${bin}: missing (required for preview/final)`);
      missing.push(bin);
    }
  }
  console.log(`Local alignment Python: ${await access(alignerPython).then(() => 'available').catch(() => 'missing (final requires WhisperX setup)')}`);
  console.log('Final needs local WhisperX alignment and a matching ASR audit. Story research, script, RAW licensing, and VO creation are upstream tasks.');
  process.exitCode = missing.length ? 1 : 0;
} else {
  if (missing.length) throw new Error(`Missing inputs:\n- ${missing.join('\n- ')}`);
  await run(process.execPath, [path.join(root, 'scripts', 'validate.mjs'), '--project', projectId]);
  if (command !== 'check') {
    const preset = command === 'final' ? 'final' : 'preview';
    // A final always requires fresh local alignment and ASR audit. Preview
    // defaults to the locked timings so a creator can review before setup.
    const auto = command === 'final' || process.argv.includes('--align');
    const script = auto ? 'auto-render.mjs' : 'render.mjs';
    await run(process.execPath, [path.join(root, 'scripts', script), '--project', projectId, '--preset', preset]);
    if (!auto) await run(process.execPath, [path.join(root, 'scripts', 'qc.mjs'), '--project', projectId, '--preset', preset]);
    console.log(`READY ${path.join(root, 'output', `${projectId}-${preset}.mp4`)}`);
  }
}
