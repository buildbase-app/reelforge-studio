# Dependency advisories: status

This file records known advisories in dependencies, whether ReelForge Studio is
affected, and why. Update it whenever `pnpm audit` or Dependabot reports something
new. The release image is also scanned by Trivy in CI (fixable HIGH/CRITICAL must
be 0).

## Fixed

| Date | Package | Advisories | Fix |
| --- | --- | --- | --- |
| 2026-11-21 | `vitest` 3.2.7 and its `tinypool`, `vite-node`/`vite`, `esbuild`, `@vitest/mocker` | 2 critical (tinypool prototype pollution), 1 high, 11 moderate/low (vite dev server, vitest mocker) | `vitest` ^4.1.12. Test tooling only: never in the release image. All 418 tests pass unchanged. |

## Not affected (vulnerable code not reachable)

| Package | Where | Advisories | Why not affected |
| --- | --- | --- | --- |
| `vite` 5.4.21 (and its `esbuild` 0.21) | `@renderweld/engine-motion-canvas`, in the image | 1 high, 7 moderate, 1 low: all in Vite's **dev server** (`server.fs.allow`/`deny`, the `.map` handler for optimized deps, `launch-editor`, cross-origin middleware) and esbuild's **dev server** CORS | The studio only calls Vite's `build()` API (`packages/engine-motion-canvas/src/render.ts`) to produce the Motion Canvas bundle. It never starts Vite's or esbuild's dev server. The bundle is served by the studio's own static server, bound to 127.0.0.1, with a path-traversal check. The fixes exist only in Vite 6.4.4+, and `@motion-canvas/vite-plugin` 3.17.2 supports Vite 4 and 5 only. **Revisit** when Motion Canvas supports Vite 6, or if the engine ever starts a dev server. |

## How to check

```bash
pnpm audit
```

The paths in the output show where a package comes from: `.>vitest>…` is test
tooling, `packages__engine-…>…` ships in the image.
