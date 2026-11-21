import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { config } from './config.mjs';
import { HttpError } from './http.mjs';

const API_ROOT = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'FinalCog-local-importer',
};
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.3gp']);

function repoParts(owner, repo) {
  const safeOwner = String(owner || '').trim();
  const safeRepo = String(repo || '').trim().replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(safeOwner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(safeRepo)) {
    throw new HttpError(400, 'Enter a valid GitHub owner and repository name.');
  }
  return { owner: safeOwner, repo: safeRepo };
}

function authHeaders(accept = GITHUB_HEADERS.Accept) {
  const headers = { ...GITHUB_HEADERS, Accept: accept };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  return headers;
}

async function githubResponse(url, { fetchImpl = fetch, accept, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: authHeaders(accept),
      redirect: 'follow',
      signal: signal || AbortSignal.timeout(120_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach GitHub. Check the network and repository URL.');
  }
  if (!response.ok) {
    const status = response.status;
    const message = status === 401 || status === 403
      ? 'GitHub denied access. Check GITHUB_TOKEN permissions and repository access.'
      : status === 404
        ? 'That GitHub release, run, or asset was not found.'
        : status === 429
          ? 'GitHub rate limit reached. Add a GITHUB_TOKEN and try again later.'
          : `GitHub returned HTTP ${status}.`;
    throw new HttpError(status === 404 ? 404 : status === 429 ? 429 : 502, message);
  }
  return response;
}

async function githubJson(url, options = {}) {
  const response = await githubResponse(url, options);
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, 'GitHub returned an unreadable response.');
  }
}

function apiUrl(owner, repo, path) {
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

function videoAssets(assets = []) {
  return assets.filter(asset => VIDEO_EXTENSIONS.has(extname(asset.name || '').toLowerCase()));
}

export async function listGithubSources(ownerInput, repoInput, { fetchImpl = fetch } = {}) {
  const { owner, repo } = repoParts(ownerInput, repoInput);
  const [releaseData, runData] = await Promise.all([
    githubJson(apiUrl(owner, repo, '/releases?per_page=10'), { fetchImpl }),
    githubJson(apiUrl(owner, repo, '/actions/runs?per_page=5'), { fetchImpl }),
  ]);
  const runs = Array.isArray(runData.workflow_runs) ? runData.workflow_runs.slice(0, 5) : [];
  const artifactsByRun = await Promise.all(runs.map(async run => {
    const result = await githubJson(
      apiUrl(owner, repo, `/actions/runs/${encodeURIComponent(run.id)}/artifacts?per_page=100`),
      { fetchImpl },
    );
    return {
      id: run.id,
      title: run.display_title || run.name || `Workflow run ${run.id}`,
      branch: run.head_branch || '',
      createdAt: run.created_at || '',
      artifacts: (Array.isArray(result.artifacts) ? result.artifacts : [])
        .filter(item => !item.expired)
        .map(item => ({
          id: item.id,
          name: item.name,
          size: item.size_in_bytes || 0,
          expired: Boolean(item.expired),
        })),
    };
  }));

  return {
    owner,
    repo,
    releases: (Array.isArray(releaseData) ? releaseData : []).map(release => ({
      tag: release.tag_name,
      title: release.name || release.tag_name,
      publishedAt: release.published_at || '',
      assets: videoAssets(release.assets).map(asset => ({
        id: asset.id,
        name: asset.name,
        title: asset.label || asset.name,
        size: asset.size || 0,
      })),
    })),
    runs: artifactsByRun,
  };
}

function releaseUrlParts(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new HttpError(400, 'Enter a valid GitHub release asset URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash) {
    throw new HttpError(400, 'Use a direct https://github.com/OWNER/REPO/releases/download/... asset URL.');
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
  if (!match) throw new HttpError(400, 'That URL is not a GitHub release asset download link.');
  return {
    ...repoParts(decodeURIComponent(match[1]), decodeURIComponent(match[2])),
    tag: decodeURIComponent(match[3]),
    assetName: decodeURIComponent(match[4].split('/').at(-1)),
  };
}

function requestedRelease(args) {
  if (args.releaseUrl) return releaseUrlParts(args.releaseUrl);
  const { owner, repo } = repoParts(args.owner, args.repo);
  if (!args.tag) throw new HttpError(400, 'Provide a GitHub release tag or release asset URL.');
  return { owner, repo, tag: String(args.tag).slice(0, 200), assetName: args.assetName || '' };
}

async function downloadToFile(url, destination, { fetchImpl, accept, maxBytes }) {
  let apiUrlValue;
  try {
    apiUrlValue = new URL(url);
  } catch {
    throw new HttpError(502, 'GitHub returned an invalid asset download link.');
  }
  if (apiUrlValue.origin !== API_ROOT) {
    throw new HttpError(502, 'GitHub returned an unexpected asset download host.');
  }
  const response = await githubResponse(url, { fetchImpl, accept });
  const headerSize = Number(response.headers.get('content-length') || 0);
  if (headerSize > maxBytes) throw new HttpError(413, 'The GitHub video or artifact exceeds MAX_UPLOAD_MB.');
  if (!response.body) throw new HttpError(502, 'GitHub did not return a downloadable file.');
  let received = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new HttpError(413, 'The GitHub video or artifact exceeds MAX_UPLOAD_MB.'));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    limit,
    createWriteStream(destination, { flags: 'wx' }),
  );
  const metadata = await stat(destination);
  if (!metadata.size) throw new HttpError(400, 'The GitHub download was empty.');
  if (metadata.size > maxBytes) throw new HttpError(413, 'The GitHub video or artifact exceeds MAX_UPLOAD_MB.');
  return metadata.size;
}

function extractSingleVideo(zipPath, destination, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new HttpError(400, 'The GitHub Actions artifact is not a valid ZIP file.'));
        return;
      }
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      const matches = [];
      zip.on('error', () => fail(new HttpError(400, 'The GitHub Actions ZIP could not be read.')));
      zip.on('entry', entry => {
        const name = String(entry.fileName || '').replaceAll('\\', '/');
        if (!name.endsWith('/') && VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) matches.push(entry);
        zip.readEntry();
      });
      zip.on('end', () => {
        if (settled) return;
        if (matches.length !== 1) {
          fail(new HttpError(400, matches.length
            ? 'The GitHub Actions artifact contains multiple videos; include one video per artifact.'
            : 'The GitHub Actions artifact does not contain a supported video.'));
          return;
        }
        const entry = matches[0];
        if (entry.uncompressedSize > maxBytes) {
          fail(new HttpError(413, 'The extracted video exceeds MAX_UPLOAD_MB.'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new HttpError(400, 'The video could not be extracted from the GitHub Actions artifact.'));
            return;
          }
          let extractedBytes = 0;
          const limit = new Transform({
            transform(chunk, encoding, callback) {
              extractedBytes += chunk.length;
              if (extractedBytes > maxBytes) {
                callback(new HttpError(413, 'The extracted video exceeds MAX_UPLOAD_MB.'));
                return;
              }
              callback(null, chunk);
            },
          });
          pipeline(stream, limit, createWriteStream(destination, { flags: 'wx' })).then(async () => {
            if (settled) return;
            const metadata = await stat(destination);
            if (metadata.size > maxBytes) {
              fail(new HttpError(413, 'The extracted video exceeds MAX_UPLOAD_MB.'));
              return;
            }
            settled = true;
            zip.close();
            resolvePromise({
              filePath: destination,
              filename: basename(entry.fileName.replaceAll('\\', '/')),
              archivePath: entry.fileName,
              size: metadata.size,
            });
          }).catch(error => fail(error instanceof HttpError
            ? error
            : new HttpError(400, 'The video could not be extracted from the GitHub Actions artifact.')));
        });
      });
      zip.readEntry();
    });
  });
}

export async function downloadGithubVideo(args, {
  tempDir,
  fetchImpl = fetch,
  maxBytes = config.maxUploadBytes,
} = {}) {
  if (!tempDir) throw new Error('A temporary directory is required for GitHub downloads.');
  await mkdir(tempDir, { recursive: true });

  if (args.runId || args.artifactName) {
    const { owner, repo } = repoParts(args.owner, args.repo);
    const runId = String(args.runId || '').trim();
    const artifactName = String(args.artifactName || '').trim();
    if (!/^\d{1,20}$/.test(runId) || !artifactName || artifactName.length > 255) {
      throw new HttpError(400, 'Provide a valid GitHub Actions run ID and artifact name.');
    }
    const artifactData = await githubJson(
      apiUrl(owner, repo, `/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100`),
      { fetchImpl },
    );
    const artifact = (artifactData.artifacts || []).find(item => item.name === artifactName && !item.expired);
    if (!artifact) throw new HttpError(404, 'That GitHub Actions artifact is unavailable or expired.');
    if (artifact.size_in_bytes > maxBytes) throw new HttpError(413, 'The GitHub Actions artifact exceeds MAX_UPLOAD_MB.');
    const zipPath = resolve(tempDir, `${randomUUID()}.zip`);
    const videoPath = resolve(tempDir, `${randomUUID()}.video`);
    await downloadToFile(artifact.archive_download_url, zipPath, {
      fetchImpl,
      accept: 'application/vnd.github+json',
      maxBytes,
    });
    const extracted = await extractSingleVideo(zipPath, videoPath, maxBytes);
    return {
      ...extracted,
      title: basename(extracted.filename, extname(extracted.filename)),
      source: {
        provider: 'github-actions',
        owner,
        repo,
        runId,
        artifactName,
        fileName: extracted.archivePath,
        downloadedAt: new Date().toISOString(),
      },
    };
  }

  const release = requestedRelease(args);
  const releaseData = await githubJson(
    apiUrl(release.owner, release.repo, `/releases/tags/${encodeURIComponent(release.tag)}`),
    { fetchImpl },
  );
  const assets = videoAssets(releaseData.assets);
  const asset = release.assetName
    ? assets.find(item => item.name === release.assetName)
    : assets.length === 1 ? assets[0] : null;
  if (!asset) {
    if (!assets.length) throw new HttpError(404, 'That release has no supported video assets.');
    throw new HttpError(400, 'Choose the exact video asset name; the release has more than one video.');
  }
  if (asset.size > maxBytes) throw new HttpError(413, 'The GitHub release video exceeds MAX_UPLOAD_MB.');
  const destination = resolve(tempDir, `${randomUUID()}${extname(asset.name).toLowerCase()}`);
  const size = await downloadToFile(asset.url, destination, {
    fetchImpl,
    accept: 'application/octet-stream',
    maxBytes,
  });
  const title = asset.label || basename(asset.name, extname(asset.name));
  return {
    filePath: destination,
    filename: basename(asset.name),
    size,
    title,
    source: {
      provider: 'github-release',
      owner: release.owner,
      repo: release.repo,
      tag: release.tag,
      fileName: asset.name,
      downloadedAt: new Date().toISOString(),
    },
  };
}

