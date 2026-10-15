import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { CodingTrialImageSchema, CodingTrialRenderSchema, CodingTrialTransformSchema } from '../core/schema.js';
import { pathContainedBy } from '../core/paths.js';
import { ToolPreconditionRejected } from '../core/tool-precondition-rejected.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import { workspaceTools } from '../infrastructure/recovery-workspace-tools.js';
import { renderFrozenArtifact, type ArtifactRenderer } from '../infrastructure/artifact-renderer.js';
import { boundedPng, IMAGE_LIMITS } from '../infrastructure/image-limits.js';
import { transformPng } from '../infrastructure/png-transform.js';
import { isComparisonBrowserShellCommand } from './comparison-shell-deny.js';

function withCodingShellBoundary(tools: AgentToolDefinition[]): AgentToolDefinition[] {
  return tools.map(tool => !['exec_command', 'write_stdin'].includes(tool.name) ? tool : { ...tool, async execute(params, signal, owner) {
    const command = tool.name === 'exec_command' ? (params as { cmd?: unknown }).cmd : (params as { chars?: unknown }).chars;
    if (typeof command === 'string' && (isComparisonBrowserShellCommand(command) || /\b(?:Stop-Process|taskkill|killall|pkill|kill)\b/i.test(command))) {
      return { content: 'Use render_browser for browser work, including your own working HTML and DOM inspect actions. Direct browser launches and process termination are disabled. The browser tool owns and cleans up its isolated processes.',
        details: { denied: true, code: 'process_boundary' } };
    }
    return tool.execute(params, signal, owner);
  } });
}

export function createCodingComparisonTools(input: { sourceRoot: string; workRoot: string; render?: ArtifactRenderer; transform?: typeof transformPng }): AgentToolDefinition[] {
  const reject = (message: string): never => { throw new ToolPreconditionRejected('invalid_path', message); };
  const locate = async (path: string) => {
    if (isAbsolute(path)) return reject('Use source/ for inputs or a relative working file path.');
    const source = path.replaceAll('\\', '/').startsWith('source/');
    const root = await realpath(source ? input.sourceRoot : input.workRoot);
    const requested = resolve(root, source ? path.slice(7) : path);
    if (!pathContainedBy(root, requested)) return reject('Path escapes the task directory.');
    let actual: string;
    try { actual = await realpath(requested); }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return reject('File does not exist; choose a task file path.');
      throw error;
    }
    if (!pathContainedBy(root, actual)) return reject('Link escapes the task directory.');
    if (!(await stat(actual)).isFile()) return reject('Choose a regular file.');
    return { root, actual, entry: relative(root, actual) };
  };
  const image = async (path: string): Promise<AgentToolResult> => {
    const bytes = await readFile((await locate(path)).actual);
    if (bytes.length > IMAGE_LIMITS.bytes || !boundedPng(bytes)) return { content: 'Image is not a bounded PNG; render a smaller PNG first.' };
    return { content: `Image: ${path}`, contentBlocks: [{ type: 'text', text: `Image: ${path}` }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] };
  };
  const tools = workspaceTools(input.workRoot, {
    role: 'comparison', allowBinary: true, allowShell: true, managedExecution: true, processLogRoot: input.workRoot,
    mounts: { source: input.sourceRoot }, allowWrite: () => true, completionPaths: new Set(),
    homeRoot: join(input.workRoot, '.home'),
    shellEnv: { REPRISE_SOURCE_MOUNT: input.sourceRoot },
  }).map(tool => ({ ...tool, ...(['read', 'ls', 'grep', 'find'].includes(tool.name) ? { executionMode: 'parallel' as const } : {}) }));
  return withCodingShellBoundary([...tools, {
    name: 'view_image', executionMode: 'parallel', parameters: CodingTrialImageSchema,
    description: 'See a PNG at a task-relative path, including browser screenshots. No media registration or evidence ID required.',
    async execute(params) {
      if (!Value.Check(CodingTrialImageSchema, params)) return { content: 'Supply path.' };
      return image(params.path);
    },
  }, {
    name: 'render_browser', parameters: CodingTrialRenderSchema,
    description: 'Open source/ or a working HTML/SVG/image file in an isolated browser. Screenshot images returned by default. Supports viewport, sampleTimesMs, geometryQueries, media preferences and ordered click/fill/key/scroll/wait/inspect actions. inspect returns element text/value/state/bounds: use it to read data from your own instrumented working HTML too. Fresh page per call; replay all actions. Use the same tool for your report. No registration or submission required.',
    async execute(params, signal) {
      if (!Value.Check(CodingTrialRenderSchema, params)) return { content: 'Invalid browser parameters.' };
      const file = await locate(params.path);
      const output = `screenshots/${randomUUID()}`;
      const rendered = await (input.render ?? renderFrozenArtifact)({
        bundleRoot: file.root, entryRelativePath: file.entry,
        viewport: { width: params.viewport?.width ?? 1280, height: params.viewport?.height ?? 900, scale: 1 },
        sampleTimesMs: params.sampleTimesMs ?? [0], outputRoot: join(input.workRoot, output), signal,
        ...(params.actions ? { actions: params.actions } : {}), ...(params.media ? { media: params.media } : {}),
        ...(params.geometryQueries ? { geometryQueries: params.geometryQueries } : {}),
      });
      if (!rendered.ok) return { content: JSON.stringify(rendered) };
      const paths = rendered.frames.map(frame => relative(input.workRoot, frame.pngPath).replaceAll('\\', '/'));
      const content = JSON.stringify({ screenshots: paths, frames: rendered.frames.map((frame, index) => ({ path: paths[index], sampleTimeMs: frame.sampleTimeMs, actualTimeMs: frame.actualTimeMs, geometry: frame.geometrySample })), measured: rendered.measured, diagnostics: rendered.diagnostics });
      const blocks: NonNullable<AgentToolResult['contentBlocks']>[number][] = [{ type: 'text', text: content }];
      if (params.includeImages !== false) {
        let total = 0;
        for (const path of paths.slice(0, IMAGE_LIMITS.count)) {
          const viewed = await image(path);
          const block = viewed.contentBlocks?.find(block => block.type === 'image');
          if (block && (total += Buffer.byteLength(block.data, 'base64')) <= IMAGE_LIMITS.totalBytes) blocks.push(block);
        }
      }
      return { content, contentBlocks: blocks };
    },
  }, {
    name: 'transform_image', parameters: CodingTrialTransformSchema,
    description: 'Crop a PNG using original pixel coordinates and resize it to width/height. Returns a working PNG path and its image. No registration required.',
    async execute(params, signal) {
      if (!Value.Check(CodingTrialTransformSchema, params)) return { content: 'Supply path, crop, width and height.' };
      const bytes = await readFile((await locate(params.path)).actual);
      if (!boundedPng(bytes) || params.crop.x + params.crop.width > bytes.readUInt32BE(16) || params.crop.y + params.crop.height > bytes.readUInt32BE(20)
        || params.width * params.height > IMAGE_LIMITS.pixels) return { content: 'Crop/output is outside image bounds.' };
      const output = await (input.transform ?? transformPng)(bytes, params, signal);
      await mkdir(join(input.workRoot, 'images'), { recursive: true });
      const path = `images/${randomUUID()}.png`;
      await writeFile(join(input.workRoot, path), output);
      return image(path);
    },
  }]);
}
