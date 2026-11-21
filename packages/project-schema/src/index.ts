import { z } from 'zod';
import { project, type Project, type Scene } from './project';

export * from './project';
export * from './templates';

export interface ValidationIssue {
  /** Dotted path into the manifest, e.g. "scenes.1.props.headline". */
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; project: Project; warnings: ValidationWarning[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validate an untrusted manifest (an imported agent plan, a file from disk).
 * Never throws for bad input: every problem is reported at once so a user or
 * an agent can fix them in one pass (TEST_PLAN §1, Planner).
 */
export function parseProject(input: unknown): ParseResult {
  const result = project.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        message: i.message,
      })),
    };
  }
  return { ok: true, project: result.data, warnings: collectWarnings(result.data) };
}

function collectWarnings(p: Project): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  p.assets.forEach((a, i) => {
    if (!a.license) {
      warnings.push({
        path: `assets.${i}.license`,
        message: `asset "${a.id}" has no license metadata; make sure you have the rights to use it`,
      });
    }
  });
  return warnings;
}

export interface TimelineScene extends Scene {
  startFrame: number;
  endFrame: number;
}

/** Scenes with their computed start and end frames (end exclusive). */
export function timeline(p: Project): TimelineScene[] {
  let cursor = 0;
  return p.scenes.map((s) => {
    const start = cursor;
    cursor += s.durationFrames;
    return { ...s, startFrame: start, endFrame: cursor };
  });
}

export function totalFrames(p: Project): number {
  return p.scenes.reduce((n, s) => n + s.durationFrames, 0);
}

/**
 * JSON Schema for the manifest, for external agents (Claude Code, Codex) that
 * write plans. It describes the shape only; cross-field rules such as template
 * props and timing are enforced by `parseProject`.
 */
export function projectJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(project, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}
