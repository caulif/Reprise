import { chmod, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { sha256, writeAtomic } from '../core/identity.js';
import { pathContainedBy } from '../core/paths.js';
import { HistoricalDeliveryManifestSchema, HistoricalDeliverySelectionSchema, HistoricalDeliveryReceiptSchema, type HistoricalDeliveryManifest, type TaskCase } from '../core/schema.js';
import { captureGitTree, assertCapturePath } from '../infrastructure/historical-git-capture.js';
import { redactModelVisibleText } from '../infrastructure/agent/model-input.js';
import { publishFrozenDirectory } from '../products/shared/freeze-publish.js';
import { validateHistoricalArtifactBytes } from '../products/shared/historical-artifact-files.js';

type FileCapture = { kind: 'captured_file' | 'user_selected_substitute'; sourcePath: string; logicalPath: string; expectedHash: string; userInstruction?: string; originalStatus?: 'unavailable' | 'not_verified' };
type GitCapture = { kind: 'git_snapshot'; repository: string; commit: string };
export type CaptureHistoricalDeliveryInput = {
  dataDir: string; taskCase: TaskCase; selectionBasis: string; source: FileCapture | GitCapture; now: string;
};

function deliveryRoot(caseDir: string): string {
  return join(dirname(dirname(caseDir)), 'historical-deliveries', caseDir.split(/[\\/]/).pop()!);
}

export async function readCapturedHistoricalFile(path: string): Promise<Buffer> {
  assertCapturePath(`capture/${basename(path)}`);
  if (!(await lstat(path)).isFile()) throw new Error('Historical input must be a regular file.');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Historical input exceeds the file budget.');
    const buffer = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const chunk = await file.read(buffer, read, buffer.length - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    if (read !== info.size) throw new Error('Historical input changed while being captured.');
    return buffer.subarray(0, read);
  } finally { await file.close(); }
}

export async function captureHistoricalDelivery(input: CaptureHistoricalDeliveryInput): Promise<{ selectionId: string; manifestHash: string }> {
  const caseDir = join(resolve(input.dataDir), 'cases', input.taskCase.caseId);
  const root = deliveryRoot(caseDir);
  const selectionId = `delivery-${randomUUID()}`;
  const target = join(root, selectionId);
  const staging = join(root, `.staging-${selectionId}`);
  const basis = redactModelVisibleText(input.selectionBasis).text;
  let capture: HistoricalDeliveryManifest['capture'];
  let files: { logicalPath: string; bytes: Buffer; executable?: boolean }[];
  if (input.source.kind === 'git_snapshot') {
    const git = await captureGitTree(input.source.repository, input.source.commit);
    files = git.files;
    capture = { kind: 'git_snapshot', commit: git.commit, tree: git.tree, capturedAt: input.now, selectionBasis: basis };
  } else {
    assertCapturePath(input.source.logicalPath);
    const bytes = await readCapturedHistoricalFile(input.source.sourcePath);
    if (sha256(bytes) !== input.source.expectedHash) throw new Error('Historical file changed or has an incorrect expected hash.');
    files = [{ logicalPath: input.source.logicalPath, bytes }];
    const common = { capturedAt: input.now, selectionBasis: basis, expectedHash: input.source.expectedHash };
    capture = input.source.kind === 'captured_file' ? { ...common, kind: 'captured_file' } : {
      ...common, kind: 'user_selected_substitute', originalStatus: input.source.originalStatus ?? 'not_verified',
      userInstruction: redactModelVisibleText(input.source.userInstruction ?? '').text,
    };
  }
  if (!input.taskCase.privacy.allowBinary && files.some(file => file.bytes.includes(0) || !Buffer.from(file.bytes.toString('utf8')).equals(file.bytes))) throw new Error('Historical binary capture is not authorized by this case.');
  const manifest: HistoricalDeliveryManifest = {
    schemaVersion: 2, sourceHash: input.taskCase.provenance.sourceHash, caseId: input.taskCase.caseId,
    selectionId, extractorVersion: 'host-capture/1', capture, issues: [],
    artifacts: files.map((file, index) => ({ artifactId: `${selectionId}-${index}`, bundleId: selectionId,
      logicalPath: file.logicalPath, byteLength: file.bytes.length, contentHash: sha256(file.bytes),
      ...(input.source.kind === 'git_snapshot' ? { gitMode: file.executable ? '100755' as const : '100644' as const } : {}),
      origin: input.source.kind, sourceRefs: [`artifact:${selectionId}`], finality: 'final' })),
  };
  if (!Value.Check(HistoricalDeliveryManifestSchema, manifest)) throw new Error('Historical capture failed schema validation.');
  validateHistoricalArtifactBytes({ manifest, files: files.map((file, index) => ({ artifactId: manifest.artifacts[index]!.artifactId, bytes: file.bytes })) });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = sha256(body);
  const selection = { schemaVersion: 1, caseId: manifest.caseId, sourceHash: manifest.sourceHash, selectionId, manifestHash };
  if (!Value.Check(HistoricalDeliverySelectionSchema, selection)) throw new Error('Historical selection failed schema validation.');
  const receipt = { schemaVersion: 1, caseId: manifest.caseId, selectionId, sourceHash: manifest.sourceHash,
    origin: input.source.kind, sourceLocator: resolve(input.source.kind === 'git_snapshot' ? input.source.repository : input.source.sourcePath) };
  if (!Value.Check(HistoricalDeliveryReceiptSchema, receipt)) throw new Error('Invalid historical capture receipt.');
  await mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const path = join(staging, 'files', selectionId, ...file.logicalPath.split('/'));
      await writeAtomic(path, file.bytes);
      if (file.executable && process.platform !== 'win32') await chmod(path, 0o755);
    }
    await writeAtomic(join(staging, 'manifest.json'), body);
    await writeAtomic(join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    await publishFrozenDirectory(staging, target);
    await writeAtomic(join(root, 'SELECTED.json'), `${JSON.stringify(selection, null, 2)}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { selectionId, manifestHash };
}

/** A missing selection is legacy input; corrupt or misbound selections fail closed. */
export async function selectedHistoricalDelivery(caseDir: string, taskCase: TaskCase): Promise<{ root: string; manifest: HistoricalDeliveryManifest } | undefined> {
  const base = deliveryRoot(caseDir);
  let body: string;
  try { body = await readFile(join(base, 'SELECTED.json'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const selection: unknown = JSON.parse(body);
  if (!Value.Check(HistoricalDeliverySelectionSchema, selection)) throw new Error('Invalid historical delivery selection.');
  if (selection.caseId !== taskCase.caseId || selection.sourceHash !== taskCase.provenance.sourceHash) throw new Error('Historical delivery selection belongs to a different case/source.');
  const root = join(base, selection.selectionId);
  if (!pathContainedBy(await realpath(base), await realpath(root))) throw new Error('Historical selection escapes its capture directory.');
  const manifestBody = await readFile(join(root, 'manifest.json'), 'utf8');
  const manifest: unknown = JSON.parse(manifestBody);
  if (!Value.Check(HistoricalDeliveryManifestSchema, manifest) || sha256(manifestBody) !== selection.manifestHash
    || manifest.caseId !== selection.caseId || manifest.sourceHash !== selection.sourceHash || manifest.selectionId !== selection.selectionId) throw new Error('Historical delivery manifest identity mismatch.');
  if (manifest.artifacts.some(a => a.origin !== manifest.capture.kind || a.bundleId !== manifest.selectionId)) throw new Error('Historical delivery provenance conflict.');
  if (manifest.capture.kind === 'git_snapshot' && manifest.artifacts.some(a => a.gitMode === undefined)) throw new Error('Historical tree is missing file modes.');
  if (manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0) > 256 * 1024 * 1024) throw new Error('Historical delivery exceeds the total byte budget.');
  if (manifest.capture.kind !== 'git_snapshot' && (manifest.artifacts.length !== 1 || manifest.artifacts[0]!.contentHash !== manifest.capture.expectedHash)) throw new Error('Historical file capture identity conflict.');
  return { root, manifest };
}
