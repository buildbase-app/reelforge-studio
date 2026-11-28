# Test Plan and Acceptance Criteria

**Status (2026-11-23): the test plan written before the build; not a test
record.** Much of it is now covered by automated tests that run in CI (`pnpm
typecheck && RENDERWELD_REQUIRE_BROWSER=1 pnpm test`: unit tests, repository
contract tests on SQLite, PostgreSQL and MySQL, MCP and REST journeys against a
real server with the real engines, the Docker end-to-end suite on the release
image). The evidence lives with each feature, not here: test cases and results
in docs/STATUS.md §3, the STATUS table of docs/AGENT_PLATFORM.md (§10),
docs/providers/*.md, docs/tutorials/TEST_CASES.md and docs/PERFORMANCE.md. An
item below with no test there is still untested. Parts of this plan describe
things the product does not have (a built-in planner, a UI): the agent plans
and there is no web UI in v0.1 (D-014).

## 1. Unit tests

### Project schema

-   Accept valid versioned project manifest.
-   Reject missing schema version, duplicate scene IDs, negative
    durations, invalid frame rates, unsupported engine IDs, unknown
    asset IDs, invalid dimensions, and malformed props.
-   Verify total timeline duration and scene overlaps according to the
    declared policy.
-   Verify schema migration behavior when versions change.

### Planner

-   Given a brief, a plan can be represented in the canonical schema.
-   Imported plan validation reports all errors without crashing.
-   A plan never silently converts an unknown engine into another
    engine.

### Asset registry

-   Reject path traversal and unsafe file paths.
-   Warn when license/source metadata is absent.
-   Verify checksums when assets are imported.
-   Ensure secrets are not written into asset metadata.

### Render orchestration

-   Correctly transitions job states: queued → running →
    succeeded/failed/cancelled.
-   Failed subprocess returns a nonzero state and preserves diagnostic
    logs.
-   Cancellation terminates child processes where safe.
-   Retry does not overwrite a successful output without explicit
    policy.

## 2. Engine contract tests

### Remotion

-   Render a minimal composition at target dimensions and frame rate.
-   Verify expected duration and playable output.
-   Verify missing props produce a clear validation error.
-   Verify render failures preserve logs.

### Motion Canvas

-   Render a minimal scene at target dimensions and frame rate.
-   Verify expected duration and playable output.
-   Verify invalid scene/project configuration fails clearly.
-   Verify render failures preserve logs.

### Cross-engine end-to-end

-   Render one Remotion scene and one Motion Canvas scene in the same
    project.
-   Normalize both outputs.
-   Assemble them in order.
-   Use ffprobe or equivalent to verify dimensions, frame rate,
    duration, codecs, and audio streams.
-   Decode the output to detect corruption.
-   Extract frames around the transition to inspect black frames,
    flashes, incorrect scaling, or timing gaps.
-   Check audio start/end and synchronization.
-   Repeat on a clean environment.

## 3. Integration tests

-   App starts without provider credentials.
-   Importing a valid plan does not invoke a model.
-   Provider-disabled render can complete with static/sample content.
-   Missing FFmpeg or unsupported codec gives an actionable setup error.
-   Missing asset fails before final assembly or reports a clear
    fallback.
-   Render progress and final output path are surfaced to the UI.
-   Project export contains referenced files or clearly lists external
    dependencies.

## 4. Security and privacy tests

-   Search repository and artifacts for committed secrets.
-   Confirm `.env`, auth caches, tokens, and credentials are ignored.
-   Confirm project files and logs do not contain secrets.
-   Test filenames containing `../`, absolute paths, shell
    metacharacters, and Unicode.
-   Confirm generated shell commands are not executed without explicit
    policy/approval.
-   Confirm network requests are documented and provider-specific.
-   Confirm imported SVG/HTML/media are treated as untrusted input where
    relevant.

## 5. Visual quality review

For each template: - Render at 9:16 and review beginning, middle, end,
and scene transitions. - Check text is readable on mobile-size
preview. - Check safe margins and subtitle placement. - Check contrast
and brand consistency. - Check no unintended blank frames, overflow,
clipped text, or asset flicker. - Check motion has a clear hierarchy and
avoids unnecessary effects. - Check captions match narration when
captions are used. - Record human reviewer, date, source commit, and
findings.

## 6. Performance tests

Do not set performance claims before measuring. Record: - CPU, RAM, GPU,
OS, Node version, browser version, engine versions, FFmpeg build. -
Project duration, resolution, fps, scene count, asset count. -
Wall-clock render time, peak memory, output size. - Whether hardware
acceleration was enabled. - Repeat at least three times for a baseline
where feasible.

## 7. Release gate

A release candidate must include: - Reproducible installation
instructions. - CI results and test commands. - A sample rendered
output. - Dependency and asset license inventory. - Known limitations. -
Supported platform matrix. - No high-severity unresolved security or
licensing issue. - No claims that exceed verified behavior.
