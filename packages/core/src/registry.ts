import {
  templatePropsJsonSchema,
  type TemplateCatalog,
  type TemplateDefinition,
} from '@renderweld/project-schema';
import { ApiError } from './errors';
import type { EnginePlugin, ProviderPlugin, RenderBackend, SpeechToTextPlugin, StorageDriver, TemplateInfo } from './plugins';

/** Plugins registered at startup. Unknown ids are rejected with the installed list. */
export class PluginRegistry {
  private engines = new Map<string, EnginePlugin>();
  private providers = new Map<string, ProviderPlugin>();
  private backends = new Map<string, RenderBackend>();
  private storages = new Map<string, StorageDriver>();
  private sttProviders = new Map<string, SpeechToTextPlugin>();
  private catalogCache: TemplateCatalog | null = null;

  registerEngine(p: EnginePlugin): this {
    if (this.engines.has(p.id)) throw new Error(`engine "${p.id}" is already registered`);
    this.engines.set(p.id, p);
    this.catalogCache = null;
    return this;
  }
  registerProvider(p: ProviderPlugin): this {
    if (this.providers.has(p.id)) throw new Error(`provider "${p.id}" is already registered`);
    this.providers.set(p.id, p);
    return this;
  }
  registerBackend(b: RenderBackend): this {
    if (this.backends.has(b.id)) throw new Error(`backend "${b.id}" is already registered`);
    this.backends.set(b.id, b);
    return this;
  }
  registerStt(p: SpeechToTextPlugin): this {
    if (this.sttProviders.has(p.id)) throw new Error(`speech-to-text provider "${p.id}" is already registered`);
    this.sttProviders.set(p.id, p);
    return this;
  }
  registerStorage(s: StorageDriver): this {
    this.storages.set(s.id, s);
    return this;
  }

  listEngines(): EnginePlugin[] {
    return [...this.engines.values()];
  }
  listProviders(): ProviderPlugin[] {
    return [...this.providers.values()];
  }
  listBackends(): RenderBackend[] {
    return [...this.backends.values()];
  }
  listStt(): SpeechToTextPlugin[] {
    return [...this.sttProviders.values()];
  }
  listStorages(): StorageDriver[] {
    return [...this.storages.values()];
  }

  engine(id: string): EnginePlugin {
    const e = this.engines.get(id);
    if (!e) throw new ApiError('unknown_engine', 400, `unknown engine "${id}"; installed: ${[...this.engines.keys()].join(', ') || '(none)'}`);
    return e;
  }
  provider(id: string): ProviderPlugin {
    const p = this.providers.get(id);
    if (!p) throw new ApiError('unknown_provider', 404, `unknown provider "${id}"; installed: ${[...this.providers.keys()].join(', ') || '(none)'}`);
    return p;
  }
  backend(id: string): RenderBackend {
    const b = this.backends.get(id);
    if (!b) throw new ApiError('unknown_backend', 400, `unknown render backend "${id}"; installed: ${[...this.backends.keys()].join(', ') || '(none)'}`);
    return b;
  }
  stt(id: string): SpeechToTextPlugin {
    const p = this.sttProviders.get(id);
    if (!p) throw new ApiError('unknown_stt_provider', 404, `unknown speech-to-text provider "${id}"; installed: ${[...this.sttProviders.keys()].join(', ') || '(none)'}`);
    return p;
  }
  storage(id: string): StorageDriver {
    const s = this.storages.get(id);
    if (!s) throw new Error(`storage driver "${id}" is not registered`);
    return s;
  }

  /** Engines and templates installed here, for manifest validation. */
  catalog(): TemplateCatalog {
    if (!this.catalogCache) {
      const templates: Record<string, TemplateDefinition> = {};
      for (const e of this.engines.values()) for (const t of e.templates()) templates[t.id] = t;
      this.catalogCache = { engines: [...this.engines.keys()], templates };
    }
    return this.catalogCache;
  }

  templateInfos(engine?: string): TemplateInfo[] {
    const out: TemplateInfo[] = [];
    for (const e of this.engines.values()) {
      if (engine && e.id !== engine) continue;
      for (const t of e.templates()) {
        out.push({
          id: t.id,
          engine: e.id,
          description: t.description,
          minSeconds: t.minSeconds,
          maxSeconds: t.maxSeconds,
          themeTokens: t.themeTokens,
          propsSchema: templatePropsJsonSchema(t),
        });
      }
    }
    return out;
  }
}
