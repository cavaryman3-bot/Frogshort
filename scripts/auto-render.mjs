import path from 'node:path';
import {argValue, readJson, root, run} from './lib.mjs';

const projectId = argValue('--project', 'spiderman');
const preset = argValue('--preset', 'preview');
const model = argValue('--model', 'small.en');
const device = argValue('--device', 'cpu');
if (!['preview', 'final'].includes(preset)) throw new Error(`Unknown preset: ${preset}`);

const platformPython = process.platform === 'win32'
  ? path.join(root, '.venv-whisperx', 'Scripts', 'python.exe')
  : path.join(root, '.venv-whisperx', 'bin', 'python');
const python = process.env.FROG_WHISPERX_PYTHON || platformPython;
const alignmentFile = path.join(root, 'tmp', projectId, 'whisperx-word-alignment.json');

await run(python, [
  path.join(root, 'scripts', 'whisperx_align.py'),
  '--project', projectId,
  '--model', model,
  '--device', device,
  '--compute-type', device === 'cpu' ? 'int8' : 'float16',
]);

const auditFile = path.join(root, 'tmp', projectId, 'whisperx-asr-audit.json');
const audit = await readJson(auditFile);
if (preset === 'final' && !audit.transcript_matches) {
  throw new Error(
    `FINAL RENDER BLOCKED: ASR disagrees with the locked transcript. ` +
    `Alignment was still attempted and saved for diagnosis. Review ${auditFile} ` +
    `and the alignment report before publishing. Use --preset preview for a review render.`,
  );
}

await run(process.execPath, [
  path.join(root, 'scripts', 'render.mjs'),
  '--project', projectId,
  '--preset', preset,
  '--alignment', alignmentFile,
]);

const outputFile = path.join(root, 'output', `${projectId}-${preset}.mp4`);
await run(process.execPath, [
  path.join(root, 'scripts', 'qc.mjs'),
  '--project', projectId,
  '--file', outputFile,
  '--preset', preset,
]);

console.log(`AUTO-RENDER PASS ${outputFile}`);
