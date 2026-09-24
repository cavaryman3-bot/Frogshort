import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

export const projectPaths = async (projectId) => {
  const projectDir = path.join(root, 'projects', projectId);
  const configPath = path.join(projectDir, 'project.json');
  const config = await readJson(configPath);
  const resolveProject = (relative) => path.resolve(projectDir, relative);
  return {
    root,
    projectDir,
    configPath,
    config,
    registryPath: resolveProject(config.locked.sourceRegistry),
    designPath: resolveProject(config.locked.editDesign),
    alignmentPath: resolveProject(config.locked.wordAlignment),
    captionsPath: resolveProject(config.locked.captionGroups),
    speechPath: resolveProject(config.assets.speech),
    musicPath: resolveProject(config.assets.music),
    sourcePaths: Object.fromEntries(
      Object.entries(config.assets.sources).map(([id, relative]) => [id, resolveProject(relative)]),
    ),
  };
};

export const assertFile = async (file, label = file) => {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing ${label}: ${file}`);
  return info;
};

export const sha256 = async (file) => {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
};

export const run = (command, args, {cwd = root, capture = false} = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({stdout, stderr});
      reject(new Error(`${command} exited ${code}\n${stderr}`));
    });
  });

export const ffprobe = async (file) => {
  const {stdout} = await run(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    {capture: true},
  );
  return JSON.parse(stdout);
};

export const argValue = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

export const secondsToAss = (seconds) => {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centis = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
};

export const hexToAss = (hex) => {
  const clean = hex.replace('#', '');
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `&H00${b}${g}${r}`.toUpperCase();
};

export const escapeAss = (value) =>
  String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('\n', '\\N');

export const escapeFilterPath = (file) =>
  path.resolve(file).replaceAll('\\', '/').replace(':', '\\:').replaceAll("'", "\\'");
