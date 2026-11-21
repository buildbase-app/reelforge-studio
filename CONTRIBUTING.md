# Contributing

Thanks for helping improve ReelForge. Read `AGENTS.md` first (it is the shared
contract for people and coding agents), then `docs/STATUS.md`.

## Contributor licence agreement (draft, pending legal review)

ReelForge is offered under two licences (see `LICENSING.md`): PolyForm
Noncommercial for everyone, and a paid commercial licence. To accept your
contribution we need the right to include it under both. By opening a pull
request you confirm that:

1. you wrote the contribution, or have the right to submit it;
2. you grant BuildBase a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable licence to use, modify, sublicense and distribute your
   contribution under any licence, including the PolyForm Noncommercial
   License and the ReelForge Commercial License;
3. you grant a patent licence for any of your patent claims that your
   contribution necessarily infringes;
4. you keep the copyright in your contribution.

A CLA check will be added to pull requests before outside contributions are
accepted.

## How to contribute

- Open an issue first for anything bigger than a small fix.
- Keep changes small, tested and documented. Run
  `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test`.
- Never commit secrets.
