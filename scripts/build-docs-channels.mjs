import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteSidebarSource } from './sidebarFilter.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(rootDir, 'docs');
const vitePressDir = path.join(docsDir, '.vitepress');
const distDir = path.join(vitePressDir, 'dist');
const tmpRootDir = path.join(rootDir, 'tmp');
const defaultSiteUrl = 'https://pels.barelysufficient.org';
const generatedChannelManifest = 'channels.json';

const channelBase = {
  live: '/',
  test: '/test/',
  dev: '/dev/',
};

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const env = options.env ?? process.env;

  console.log(`$ ${command} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function normalizeBase(base) {
  if (!base || base === '/') return '/';

  const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function stripRemotePrefix(ref) {
  return ref.replace(/^origin\//, '');
}

function displayRef(ref) {
  return stripRemotePrefix(ref)
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/heads\//, '');
}

function validateRef(ref) {
  if (ref.startsWith('-')) {
    throw new Error(`Invalid docs ref: ${ref}`);
  }

  return ref;
}

async function fetchRefs() {
  if (readEnv('PELS_DOCS_SKIP_FETCH') === '1') return;

  await run('git', [
    'fetch',
    '--force',
    '--tags',
    'origin',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
}

async function prepareDocsSource(channel, tmpDir) {
  const archivePath = path.join(tmpDir, `${channel.key}.tar`);
  const checkoutDir = path.join(tmpDir, channel.key);
  const sourceDir = path.join(checkoutDir, 'docs');

  await fs.mkdir(checkoutDir, { recursive: true });
  await run('git', ['archive', '--format=tar', `--output=${archivePath}`, '--', channel.ref, 'docs']);
  await run('tar', ['-xf', archivePath, '-C', checkoutDir]);

  const taggedSidebarPath = path.join(sourceDir, '.vitepress', 'sidebar.mts');
  const taggedSidebar = await readFileIfExists(taggedSidebarPath);

  await fs.rm(path.join(sourceDir, '.vitepress'), { recursive: true, force: true });
  await copyVitePressConfig(path.join(sourceDir, '.vitepress'));

  const sidebarPath = path.join(sourceDir, '.vitepress', 'sidebar.mts');
  if (taggedSidebar !== undefined) {
    await fs.writeFile(sidebarPath, taggedSidebar);
  } else {
    await filterSidebarToExistingPages(sidebarPath, sourceDir);
  }

  await rewriteRootRelativeHtmlLinks(sourceDir, channel.base);

  return sourceDir;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function pageExists(sourceDir, link) {
  if (link === '/') {
    return (await readFileIfExists(path.join(sourceDir, 'index.md'))) !== undefined;
  }

  const trimmed = link.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return (await readFileIfExists(path.join(sourceDir, 'index.md'))) !== undefined;
  }

  const candidates = [
    path.join(sourceDir, `${trimmed}.md`),
    path.join(sourceDir, trimmed, 'index.md'),
  ];

  for (const candidate of candidates) {
    if ((await readFileIfExists(candidate)) !== undefined) return true;
  }

  return false;
}

async function filterSidebarToExistingPages(sidebarPath, sourceDir) {
  const source = await readFileIfExists(sidebarPath);
  if (source === undefined) return;

  const rewritten = await rewriteSidebarSource(source, (link) => pageExists(sourceDir, link));

  if (rewritten !== source) {
    await fs.writeFile(sidebarPath, rewritten);
  }
}

async function copyVitePressConfig(targetDir) {
  const ignoredNames = new Set(['dist', '.temp', 'cache']);

  await fs.cp(vitePressDir, targetDir, {
    recursive: true,
    filter: (source) => !ignoredNames.has(path.basename(source)),
  });
}

async function walkFiles(dir, onFile) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkFiles(absolutePath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

async function rewriteRootRelativeHtmlLinks(sourceDir, base) {
  const normalizedBase = normalizeBase(base);
  if (normalizedBase === '/') return;

  await walkFiles(sourceDir, async (filePath) => {
    if (!/\.(?:md|html|vue)$/i.test(filePath)) return;

    const original = await fs.readFile(filePath, 'utf8');
    const rewritten = original.replace(/\bhref=(["'])\/(?!\/)([^"']*)\1/g, (_match, quote, target) => (
      `href=${quote}${normalizedBase}${target}${quote}`
    ));

    if (rewritten !== original) {
      await fs.writeFile(filePath, rewritten);
    }
  });
}

async function buildChannel(channel, allChannels, siteUrl, tmpDir) {
  const sourceDir = await prepareDocsSource(channel, tmpDir);
  const outDir = path.join(tmpDir, 'out', channel.key);
  const env = {
    ...process.env,
    PELS_DOCS_SITE_URL: siteUrl,
    PELS_DOCS_BASE: channel.base,
    PELS_DOCS_CHANNEL: channel.key,
    PELS_DOCS_OUT_DIR: outDir,
    PELS_DOCS_LIVE_REF: allChannels.live.ref,
    PELS_DOCS_TEST_REF: allChannels.test.ref,
    PELS_DOCS_DEV_REF: displayRef(allChannels.dev.ref),
  };

  await run('npx', ['vitepress', 'build', sourceDir], { env });

  const targetDir = channel.key === 'live'
    ? distDir
    : path.join(distDir, channel.key);

  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(outDir, targetDir, { recursive: true });
}

async function writeManifest(siteUrl, channels) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    siteUrl,
    channels: channels.map((channel) => ({
      key: channel.key,
      ref: channel.ref,
      displayRef: displayRef(channel.ref),
      path: channel.base,
      url: `${siteUrl}${channel.base}`,
    })),
  };

  await fs.writeFile(
    path.join(distDir, generatedChannelManifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

const appJson = await readJson(path.join(rootDir, 'app.json'));
const defaultReleaseRef = `v${appJson.version}`;
const siteUrl = (readEnv('PELS_DOCS_SITE_URL') ?? defaultSiteUrl).replace(/\/+$/, '');
const channels = [
  {
    key: 'live',
    ref: validateRef(readEnv('PELS_DOCS_LIVE_REF') ?? defaultReleaseRef),
    base: channelBase.live,
  },
  {
    key: 'test',
    ref: validateRef(readEnv('PELS_DOCS_TEST_REF') ?? readEnv('PELS_DOCS_LIVE_REF') ?? defaultReleaseRef),
    base: channelBase.test,
  },
  {
    key: 'dev',
    ref: validateRef(readEnv('PELS_DOCS_DEV_REF') ?? 'origin/main'),
    base: channelBase.dev,
  },
];
const channelByKey = Object.fromEntries(channels.map((channel) => [channel.key, channel]));
await fs.mkdir(tmpRootDir, { recursive: true });
const tmpDir = await fs.mkdtemp(path.join(tmpRootDir, 'docs-channels-'));

try {
  await fetchRefs();
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  for (const channel of channels) {
    console.log(`\nBuilding ${channel.key} docs from ${channel.ref} at ${channel.base}`);
    await buildChannel(channel, channelByKey, siteUrl, tmpDir);
  }

  await writeManifest(siteUrl, channels);
  console.log(`\nBuilt docs channels into ${path.relative(rootDir, distDir)}`);
} finally {
  if (readEnv('PELS_DOCS_KEEP_TMP') === '1') {
    console.log(`Keeping temporary docs workdir: ${tmpDir}`);
  } else {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
