import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BUILTIN_THEMES,
  builtinTheme,
  mergeTokens,
  theme as themeSchema,
  type ProjectThemeRef,
  type Theme,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { ApiError, conflict, invalidManifest, notFound } from './errors';
import { readJson, writeJsonAtomic } from './fsutil';

export interface ThemeEntry extends Theme {
  builtin: boolean;
}

/** Built-in themes (read-only) plus operator/agent themes in <dataDir>/themes/<id>.json. */
export class ThemeStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'themes');
  }

  async list(): Promise<ThemeEntry[]> {
    const custom: ThemeEntry[] = [];
    try {
      for (const f of (await readdir(this.root)).sort()) {
        if (!f.endsWith('.json')) continue;
        const t = await readJson<Theme>(join(this.root, f));
        if (t) custom.push({ ...t, builtin: false });
      }
    } catch {
      // no custom themes yet
    }
    return [...BUILTIN_THEMES.map((t) => ({ ...t, builtin: true })), ...custom];
  }

  async get(id: string): Promise<ThemeEntry> {
    const b = builtinTheme(id);
    if (b) return { ...b, builtin: true };
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw notFound('theme', id);
    const t = await readJson<Theme>(join(this.root, `${id}.json`));
    if (!t) throw notFound('theme', id, { available: (await this.list()).map((x) => x.id) });
    return { ...t, builtin: false };
  }

  private parse(input: unknown): Theme {
    const r = themeSchema.safeParse(input);
    if (!r.success) {
      throw invalidManifest(
        r.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message })),
        'the theme is invalid'
      );
    }
    return r.data;
  }

  async create(input: unknown): Promise<ThemeEntry> {
    const t = this.parse(input);
    if (builtinTheme(t.id)) throw conflict(`"${t.id}" is a built-in theme; choose another id`);
    if (await readJson(join(this.root, `${t.id}.json`))) throw conflict(`theme "${t.id}" already exists`);
    await writeJsonAtomic(join(this.root, `${t.id}.json`), t);
    return { ...t, builtin: false };
  }

  async put(id: string, input: unknown): Promise<ThemeEntry> {
    if (builtinTheme(id)) throw new ApiError('builtin_theme', 409, `"${id}" is a built-in theme and cannot be changed; create a new theme instead`);
    const t = this.parse({ ...(input as object), id });
    await writeJsonAtomic(join(this.root, `${id}.json`), t);
    return { ...t, builtin: false };
  }

  async delete(id: string): Promise<void> {
    if (builtinTheme(id)) throw new ApiError('builtin_theme', 409, `"${id}" is a built-in theme and cannot be deleted`);
    await this.get(id);
    await rm(join(this.root, `${id}.json`), { force: true });
  }

  /** Tokens for a project's theme reference (id, or base + inline tokens). */
  async resolve(ref: ProjectThemeRef): Promise<ThemeTokens> {
    if (typeof ref === 'string') return (await this.get(ref)).tokens;
    return mergeTokens((await this.get(ref.base)).tokens, ref.tokens);
  }
}
