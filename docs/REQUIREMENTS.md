# Requirements

Priority scale: **P0** required for MVP; **P1** important after MVP;
**P2** later.

## Functional requirements

### Projects and planning

-   **FR-001 P0:** User can create a project with title, brief, target
    audience, style, duration, aspect ratio, and language.
-   **FR-002 P0:** User can import and validate a versioned
    storyboard/project JSON.
-   **FR-003 P0:** The app displays a human-readable scene list and
    timing before rendering.
-   **FR-004 P0:** User must approve the plan before the initial render.
-   **FR-005 P1:** Agent roles/skills can be configured per workflow.
-   **FR-006 P1:** Agent output is recorded with a project/run ID and
    timestamp, excluding secrets.

### Animation engines

-   **FR-010 P0:** Remotion adapter renders at least one
    production-quality template.
-   **FR-011 P0:** Motion Canvas adapter renders at least one
    production-quality template.
-   **FR-012 P0:** Both engines are used in the same end-to-end demo
    project.
-   **FR-013 P0:** Engine failure is surfaced with logs and actionable
    next steps.
-   **FR-014 P1:** Scene templates expose validated props and reusable
    style tokens.
-   **FR-015 P1:** Scene selection can be rules-based before any
    model-based optimization.

### Audio and media

-   **FR-020 P0:** User can include an audio file they have rights to
    use.
-   **FR-021 P0:** Final output is assembled to MP4 with expected
    dimensions and duration.
-   **FR-022 P0:** App validates output file existence, metadata, and
    decodability.
-   **FR-023 P1:** Voiceover, captions, music, and sound effects have
    timeline metadata.
-   **FR-024 P1:** Audio loudness, clipping, and subtitle timing checks
    are added.

### Providers and cost control

-   **FR-030 P0:** The core render demo works without an AI API key.
-   **FR-031 P1:** App can import a plan produced externally without
    requiring direct chat-account access.
-   **FR-032 P1:** Optional provider adapters disclose required
    credentials, terms, and possible costs.
-   **FR-033 P1:** Provider calls with possible costs require configured
    credentials and a visible confirmation/policy.
-   **FR-034 P2:** Local LLM runtime integration, selected after a
    compatibility spike.
-   **FR-035 P2:** Supported CLI agent integrations, only where
    officially supported and permitted.

### Self-hosting and operations

-   **FR-040 P0:** A clean-install guide produces a working demo.
-   **FR-041 P0:** Render jobs show
    queued/running/succeeded/failed/cancelled states.
-   **FR-042 P0:** Logs and outputs are stored locally with clear paths.
-   **FR-043 P1:** Docker Compose deployment is provided if it works for
    both engines and supported platforms.
-   **FR-044 P1:** Backup/export of project files and referenced assets.
-   **FR-045 P1:** No required seller-operated service for core project
    creation and rendering.

### Asset rights

-   **FR-050 P0:** Every bundled asset has documented provenance and
    license.
-   **FR-051 P0:** User-provided assets are not represented as cleared
    for use by RenderWeld.
-   **FR-052 P1:** UI can warn when an asset lacks license metadata.
-   **FR-053 P1:** Attribution requirements can be exported with a
    project.

## Non-functional requirements

-   **NFR-001 Reliability:** Failed stages stop the pipeline and report
    which stage failed.
-   **NFR-002 Reproducibility:** Same project, assets, engine versions,
    and render settings should produce a functionally equivalent output;
    byte-for-byte reproducibility may not be possible.
-   **NFR-003 Performance:** Measure render time on documented hardware
    before publishing claims.
-   **NFR-004 Resource safety:** Limit concurrent renders and expose
    resource-heavy operations.
-   **NFR-005 Privacy:** Local by default; network calls are explicit
    and documented.
-   **NFR-006 Security:** Secrets are never stored in source control or
    project exports.
-   **NFR-007 Maintainability:** Engine adapters are isolated and have
    contract tests.
-   **NFR-008 Accessibility:** Core controls work by keyboard and have
    labels/status announcements.
-   **NFR-009 Portability:** Document OS support; do not claim platform
    compatibility until tested.
-   **NFR-010 Licensing:** Third-party licenses and redistribution
    rights are reviewed before release.
-   **NFR-011 Usability:** First-time user can create the sample project
    using documentation without needing to understand internal renderer
    details.
-   **NFR-012 Honest claims:** Product copy discloses
    hardware/provider/license costs and does not promise guaranteed
    virality or unbounded generation.

## MVP definition of done

The MVP is not complete until a fresh checkout can: 1. Install
dependencies using the documented method. 2. Launch the UI and
create/import the sample project. 3. Render one Remotion scene and one
Motion Canvas scene. 4. Assemble both into one playable 9:16 MP4. 5.
Verify output metadata and sample frames. 6. Run automated tests. 7.
Reproduce the output without an AI API key. 8. Display the relevant
dependency/license notices.
