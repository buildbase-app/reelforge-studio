# Roadmap

The roadmap is intentionally staged to prove feasibility before
expanding scope.

## Phase 0 --- Feasibility and legal gates

1.  Inspect the actual repository and identify current state.
2.  Verify current Remotion licensing for the intended product,
    source-code distribution, and buyer use case. Request written
    clarification if unclear.
3.  Confirm Motion Canvas package/license versions.
4.  Choose a supported OS/runtime matrix.
5.  Prove both engines render compatible short clips.
6.  Prove final assembly and output validation.
7.  Inventory all bundled dependencies and assets.

**Exit gate:** A reproducible demo combines one scene from each engine,
and the license model is viable or a documented alternative
business/distribution plan is approved.

## Phase 1 --- MVP vertical slice

1.  Scaffold UI and project schema.
2.  Create a static sample project.
3.  Add one Remotion template (e.g., kinetic title/product card).
4.  Add one Motion Canvas template (e.g., animated explainer/vector
    sequence).
5.  Add deterministic scene planner.
6.  Add media assembly and validation.
7.  Add render job states/logs.
8.  Add setup guide and tests.

**Exit gate:** Clean install renders one combined vertical MP4 without
an AI API key.

## Phase 2 --- Production polish

1.  Add 3 high-quality templates: kinetic typography, product showcase,
    educational explainer.
2.  Add brand tokens, captions, voice/music track metadata.
3.  Improve error handling, progress, cancellation, and retry.
4.  Add sample assets only after license checks.
5.  Improve visual QA and output metadata report.

## Phase 3 --- Agent-assisted planning

1.  Define role/skill contracts.
2.  Allow a brief to be converted into the canonical schema.
3.  Add plan review/approval UI.
4.  Add a quality-review stage with deterministic checks first.
5.  Add a structured-plan import/export contract for external chat/agent
    workflows.

## Phase 4 --- Optional provider adapters

1.  Choose local LLM runtime based on test results.
2.  Add a supported Claude Code adapter if the CLI workflow permits the
    intended use.
3.  Add a supported Codex adapter if the CLI workflow permits the
    intended use.
4.  Add clear cost, authentication, and permission indicators.
5.  Do not scrape private app sessions or bypass provider controls.

## Phase 5 --- Distribution and business validation

1.  Package source and deployment documentation.
2.  Test clean deployments on declared platforms.
3.  Define update/support/refund terms.
4.  Interview target users and run a demo with real workflows.
5.  Validate willingness to pay before expanding features.
6.  Prepare hackathon submission with truthful demo and verified
    metrics.

## Out of scope until evidence supports it

-   Large-scale autonomous generation across many providers.
-   Cloud rendering service operated by the seller.
-   Unlimited free AI generation.
-   Trend scraping or asset reuse without rights.
-   Marketplace and multi-tenant enterprise features.
