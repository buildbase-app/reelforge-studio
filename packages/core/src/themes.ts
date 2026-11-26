import {
  BUILTIN_THEMES,
  builtinTheme,
  mergeTokens,
  theme as themeSchema,
  type ProjectThemeRef,
  type Theme,
  type ThemeTokens,
} from '@renderweld/project-schema';
import { ApiError, conflict, invalidManifest, notFound } from './errors';
import type { ThemeRepository } from './repositories';

export interface ThemeEntry extends Theme {
  builtin: boolean;
}

/** Built-in themes (read-only, in code) plus operator/agent themes (ThemeRepository). */
export class ThemeStore {
  constructor(private readonly repo: ThemeRepository) {}

  async list(): Promise<ThemeEntry[]> {
    const custom = (await this.repo.list()).map((t) => ({ ...t, builtin: false }));
    return [...BUILTIN_THEMES.map((t) => ({ ...t, builtin: true })), ...custom];
  }

  async get(id: string): Promise<ThemeEntry> {
    const b = builtinTheme(id);
    if (b) return { ...b, builtin: true };
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw notFound('theme', id);
    const t = await this.repo.get(id);
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
    await this.repo.insert(t, new Date().toISOString());
    return { ...t, builtin: false };
  }

  async put(id: string, input: unknown): Promise<ThemeEntry> {
    if (builtinTheme(id)) throw new ApiError('builtin_theme', 409, `"${id}" is a built-in theme and cannot be changed; create a new theme instead`);
    const t = this.parse({ ...(input as object), id });
    await this.repo.put(t, new Date().toISOString());
    return { ...t, builtin: false };
  }

  async delete(id: string): Promise<void> {
    if (builtinTheme(id)) throw new ApiError('builtin_theme', 409, `"${id}" is a built-in theme and cannot be deleted`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || !(await this.repo.delete(id))) throw notFound('theme', id);
  }

  /** Tokens for a project's theme reference (id, or base + inline tokens). */
  async resolve(ref: ProjectThemeRef): Promise<ThemeTokens> {
    if (typeof ref === 'string') return (await this.get(ref)).tokens;
    return mergeTokens((await this.get(ref.base)).tokens, ref.tokens);
  }
}
