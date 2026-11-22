/**
 * Writes the tutorial pages from cells.ts (prompts, manifests, expectations)
 * and the recorded proofs in docs/tutorials/proofs/*.json, so a page always
 * shows the prompt and the result of the run that proved it.
 *
 *   pnpm tutorials:docs           # write docs/tutorials/**
 *   pnpm tutorials:docs --check   # exit 1 if a page is out of date
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENTS, AGENT_INFO, CELL_ENGINES, ENGINE_INFO, expectationFor, projectIdFor, promptFor, type AgentId, type CellEngine } from './cells';
import type { Proof } from './prove';
import { REPO } from './lib/studio';

const DOCS = join(REPO, 'docs/tutorials');
const RF = 'http://127.0.0.1:4321';

/** Test-case id of a cell: TUT-01..25 in matrix order. */
export function caseId(agent: AgentId, engine: CellEngine): string {
  const n = AGENTS.indexOf(agent) * CELL_ENGINES.length + CELL_ENGINES.indexOf(engine) + 1;
  return `TUT-${String(n).padStart(2, '0')}`;
}

export function loadProof(agent: AgentId, engine: CellEngine, dir = join(DOCS, 'proofs')): Proof | null {
  const f = join(dir, `${agent}-${engine}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Proof) : null;
}

const day = (iso: string) => iso.slice(0, 10);

/** Matrix cell text. */
export function statusOf(agent: AgentId, engine: CellEngine, p: Proof | null): string {
  if (p?.status === 'passed') return `✅ proven ${day(p.date)}`;
  if (p?.status === 'failed') return `❌ failed ${day(p.date)}`;
  return `📝 documented, not proven (${AGENT_INFO[agent].blocked ?? 'not run yet'})`;
}

const fence = (lang: string, body: string) => '```' + lang + '\n' + body.trimEnd() + '\n```';

/** Short matrix text: the full reason is on the cell's page and in TEST_CASES.md. */
export function matrixStatus(agent: AgentId, engine: CellEngine, p: Proof | null): string {
  if (p?.status === 'passed') return `✅ ${day(p.date)}`;
  if (p?.status === 'failed') return `❌ failed ${day(p.date)}`;
  return `📝 not proven: ${AGENT_INFO[agent].short ?? 'not run yet'}`;
}

// ---------------------------------------------------------------- shared blocks

function studioBlock(rel: string): string {
  return `### 1. Start the studio

Pick one. Both serve REST on \`${RF}/v1\` and MCP on \`${RF}/mcp\`.

**A. Docker (release image, needs a licence key).** The Personal licence is
free (PolyForm Noncommercial 1.0.0, claimed with a BuildBase account on the
ReelForge store); commercial use needs a commercial licence.

${fence(
  'bash',
  `git clone https://github.com/buildbase-app/reelforge-studio && cd reelforge-studio
export REELFORGE_SECRET_KEY=$(openssl rand -base64 32)       # keep a copy: it encrypts stored secrets
docker compose up -d --build                                 # 127.0.0.1:4321, hardened defaults
docker compose exec reelforge reelforge licence activate <YOUR-LICENCE-KEY>
docker compose exec reelforge reelforge keys create --name agent --scopes read,write,render`
)}

**B. From a checkout with pnpm (local development only).** \`pnpm dev\` sets
\`REELFORGE_LICENCE_MODE=off\`, which skips the licence check. That is for
developing on your own machine only, never for a real install; the release
image does not allow it.

${fence(
  'bash',
  `pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell   # Chrome Headless Shell for every engine
pnpm keys:create --name agent --scopes read,write,render       # prints rf_... once
pnpm dev`
)}

Keep the printed key in an environment variable, not in files you commit:

${fence('bash', `export RF=${RF}\nexport REELFORGE_API_KEY=rf_...      # the key printed above\nexport KEY=$REELFORGE_API_KEY`)}

More: [DEPLOY.md](${rel}DEPLOY.md), [CONFIG.md](${rel}CONFIG.md), [licence](${rel}DEPLOY.md#licence).`;
}

function commonTroubleshooting(): string {
  return `| Symptom | Cause and fix |
| --- | --- |
| \`401 unauthorized\` | Missing or wrong key. Send \`Authorization: Bearer rf_...\`; check it with \`curl -H "Authorization: Bearer $KEY" $RF/v1/capabilities\`. |
| \`403 forbidden_host\` on \`/mcp\` | The Host header is not allowed (DNS-rebinding protection). Use \`127.0.0.1\`/\`localhost\`, or set \`REELFORGE_PUBLIC_URL\` / \`REELFORGE_ALLOWED_HOSTS\`. |
| \`403 licence_required\` / \`licence_invalid\` on a render | Activate a licence key (\`reelforge licence activate <key>\`; Personal is free). \`REELFORGE_LICENCE_MODE=off\` exists for local development from a checkout only. |
| \`403 forbidden\` (scope) | The key lacks a scope: rendering needs \`render\`, creating projects \`write\`. Create a key with \`--scopes read,write,render\`. |
| An engine shows \`available: false\` | \`REELFORGE_CHROMIUM_PATH\` is unset or wrong (checkout), or the image is not the release image. \`get_capabilities\` says how to fix it. |
| \`invalid_manifest\` | \`details.issues\` lists every problem with its path, e.g. \`scenes.1.props.headline\`. Fix all and send again. |
| The job stays \`running\` for minutes | Rendering is CPU-bound; one 8 s reel took 35 to 120 s on a shared 4-core machine. Wait with \`get_job\` \`waitSeconds: 45\` (or \`?wait=50\`); \`get_job_logs\` shows the stage. |
| \`render_failed\` with a timeout on an html or hyperframes scene | One scene ran past \`render.sceneTimeoutSeconds\` (default 900 s). On a slow machine raise \`REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS\`. |
| html, hyperframes or motion-canvas renders fail in Docker | The container needs the seccomp profile \`deployment/seccomp/chrome.json\` for Chromium's sandbox (\`docker compose\` sets it); see [DEPLOY.md](../../DEPLOY.md). |`;
}

function engineNotes(engine: CellEngine): string {
  const notes: Record<CellEngine, string> = {
    remotion: 'Remotion (`kinetic-title`): 1.5 to 8 s per scene, headline up to 60 characters. The first Remotion render bundles the composition and is slower; `pnpm prebuild:engines` (done in the Docker image) avoids that.',
    'motion-canvas': 'Motion Canvas (`animated-explainer`): 2 to 20 s, a title and 1 to 4 points (up to 90 characters each; long points wrap).',
    html: 'HTML (`html-title`): 1 to 12 s, headline up to 80 characters, optional kicker and subline. The html engine also takes raw `{ html, css }` instead of a template, and renders without network access (no remote scripts or resources).',
    hyperframes: 'HyperFrames (`hyperframes-title`): 1 to 12 s, headline up to 80 characters and a subline, a GSAP timeline rendered by the local HyperFrames renderer. Scenes render without network access: a composition cannot load remote scripts, fonts or images (import assets into the studio first).',
    'multi-engine':
      'Multi-engine: every scene is rendered by its own engine at the same size and frame rate, then joined with hard cuts to the frame. Each scene keeps its template\'s duration range (Remotion at most 8 s, Motion Canvas at least 2 s).',
  };
  return notes[engine];
}

function expectedOutput(agent: AgentId, engine: CellEngine): string {
  const e = ENGINE_INFO[engine];
  const x = expectationFor(agent, engine);
  const llm = AGENT_INFO[agent].llm;
  const timing = x.frames ? `exactly ${x.frames} frames (${x.frames / 30} s)` : `${x.minSeconds} to ${x.maxSeconds} s (the agent picks the timing within the brief; the frame count matches the duration)`;
  return `- A job that ends \`succeeded\`, and a render with \`final.mp4\`, \`poster.png\` and \`render-manifest.json\`.
- \`final.mp4\`: H.264 ${x.width}x${x.height} at ${x.fps} fps, ${timing}, with an AAC track (silent: no music was set).
- Scenes: ${e.engines.length > 1 ? `one per engine, in the order ${e.engines.join(' → ')}` : `only the \`${e.engines[0]}\` engine (template \`${e.templates[0]}\`)`}.${llm ? '\n- Texts: written by the agent about the topic in the prompt, so they differ from run to run.' : ''}`;
}

function proofSection(agent: AgentId, engine: CellEngine, p: Proof | null): string {
  const id = caseId(agent, engine);
  if (!p) {
    const why = AGENT_INFO[agent].blocked ?? 'not run yet';
    return `## Proof

**Not proven yet** (${why}). Nothing on this page has been run for this
cell; treat the steps as documented, not verified. To prove it once the
blocker is gone:

${fence('bash', `pnpm tutorials:prove ${agent} ${engine} --record   # then: pnpm tutorials:docs`)}

Test case: ${id} in [TEST_CASES.md](../TEST_CASES.md).`;
  }
  const lines = [
    `## Proof`,
    '',
    p.status === 'passed' ? `**Passed** (${id} in [TEST_CASES.md](../TEST_CASES.md)).` : `**Failed** (${id} in [TEST_CASES.md](../TEST_CASES.md)). Problems:\n\n${p.problems.map((x) => `- ${x.split('\n')[0]}`).join('\n')}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Date | ${p.date.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} |`,
    `| Studio | ReelForge Studio ${p.studioVersion}, commit \`${p.commit}\`, started from a checkout with \`REELFORGE_LICENCE_MODE=off\` (local development only) |`,
    `| Reproduce | \`pnpm tutorials:prove ${agent} ${engine}\` |`,
    `| Command the proof ran | \`${p.command.replace(/\|/g, '\\|')}\` |`,
  ];
  if (p.llm) lines.push(`| Model | ${p.llm.model ?? 'n/a'}; ${p.llm.turns ?? 'n/a'} turns; ${p.toolCalls.length} tool calls; ${p.llm.durationMs ? Math.round(p.llm.durationMs / 1000) + ' s' : 'n/a'} agent time${p.llm.costUsd ? `; ${p.llm.costUsd.toFixed(3)} USD` : ''} |`);
  lines.push(
    `| Project / job / render | \`${p.projectId}\` / \`${p.jobId}\` / \`${p.renderId}\` |`,
    `| Render time | ${p.renderSeconds ?? 'n/a'} s (job start to finish, shared 4-core CPU, one render at a time) |`,
    `| Scene engines | ${p.sceneEngines.join(', ') || 'n/a'} |`
  );
  if (p.probe)
    lines.push(
      `| ffprobe | ${p.probe.width}x${p.probe.height}, ${p.probe.fps} fps, ${p.probe.frames} frames (full decode), ${p.probe.durationSeconds} s, ${p.probe.videoCodec} + ${p.probe.audioCodec ?? 'no audio'}, ${Math.round(p.probe.sizeBytes / 1024)} KB |`
    );
  lines.push('', `Tool calls, in order (${p.toolCalls.length}):`, '', p.toolCalls.map((c, i) => `${i + 1}. \`${c}\``).join('\n'));
  if (p.llm?.reply) lines.push('', 'The agent\'s final reply (signed links redacted):', '', p.llm.reply.split('\n').map((l) => `> ${l}`).join('\n'));
  const note = loadNotes()[`${agent}-${engine}`];
  if (note) lines.push('', `**Note on this proof:** ${note}`);
  if (p.poster) lines.push('', `Poster frame (40 % into the reel, 270 px wide):`, '', `![Poster frame of the ${agent} ${engine} proof](../proofs/${p.poster})`);
  lines.push('', `The full transcript, the MP4 and \`proof.json\` stay outside the repository (\`$TUTORIAL_OUT/${agent}/${engine}/\`); re-run the command to get your own.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- per agent

function claudeSteps(engine: CellEngine): string {
  const prompt = promptFor('claude-code', engine);
  return `### 2. Connect Claude Code to the studio

Interactive use: add the server once (it is stored in your Claude Code config).

${fence('bash', `claude mcp add --transport http reelforge ${RF}/mcp \\\n  --header "Authorization: Bearer $REELFORGE_API_KEY"\nclaude mcp list        # reelforge: ... - ✔ connected`)}

Headless use (what the proof runs): a config file passed with \`--mcp-config\`.
Create it with mode 600; it holds the key ([template](../../../examples/tutorials/claude-mcp.json)):

${fence('bash', `umask 077\nprintf '{"mcpServers":{"reelforge":{"type":"http","url":"%s/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$RF" "$REELFORGE_API_KEY" > mcp.json`)}

### 3. Ask for the reel

The exact prompt:

${fence('text', prompt)}

Interactive: start \`claude\` and paste it. Headless, with only the studio's
tools and a bounded number of turns:

${fence(
  'bash',
  `claude -p "$(cat prompt.txt)" --model sonnet \\
  --mcp-config mcp.json --strict-mcp-config \\
  --tools "" --allowedTools mcp__reelforge \\
  --max-turns 25 --output-format stream-json --verbose > transcript.jsonl`
)}

- \`--strict-mcp-config\` ignores every other MCP server you have configured.
- \`--tools ""\` turns the built-in tools (shell, files, web) off; \`--allowedTools mcp__reelforge\` pre-approves the studio's tools so \`-p\` mode does not stop for permission.
- \`--max-turns 25\` bounds the cost; this task needs about 8 to 12 turns.

### 4. Download and check the reel

Claude replies with the job and render ids. Download with the key (or open the
signed \`downloadUrl\` from \`get_render_output\`, valid about an hour):

${fence('bash', `curl -fsS -H "Authorization: Bearer $KEY" -o reel.mp4 "$RF/v1/renders/<renderId>/output"\nffprobe -v error -count_frames -select_streams v:0 \\\n  -show_entries stream=width,height,r_frame_rate,nb_read_frames:format=duration -of compact reel.mp4`)}`;
}

function codexSteps(engine: CellEngine): string {
  const prompt = promptFor('codex', engine);
  return `### 2. Install Codex and connect it to the studio

Install the Codex CLI and sign in the way OpenAI documents (an OpenAI API key
or a ChatGPT plan, under OpenAI's terms):

${fence('bash', 'npm i -g @openai/codex\ncodex login            # or: export OPENAI_API_KEY=... for API-key use')}

Add the studio to \`~/.codex/config.toml\` ([template](../../../examples/tutorials/codex-config.toml)).
The key stays in your environment, not in the file:

${fence('toml', `[mcp_servers.reelforge]\nurl = "${RF}/mcp"\nbearer_token_env_var = "REELFORGE_API_KEY"`)}

${fence('bash', 'export REELFORGE_API_KEY=rf_...\ncodex mcp list         # reelforge should be listed')}

### 3. Ask for the reel

The exact prompt:

${fence('text', prompt)}

Interactive: run \`codex\` and paste it. Headless (what the proof script runs):

${fence(
  'bash',
  `codex exec --json --skip-git-repo-check --sandbox read-only \\
  -c 'mcp_servers.reelforge.url="${RF}/mcp"' \\
  -c 'mcp_servers.reelforge.bearer_token_env_var="REELFORGE_API_KEY"' \\
  -c 'approval_policy="never"' \\
  "$(cat prompt.txt)" > transcript.jsonl`
)}

VERIFY against \`codex exec --help\` of your version: the \`-c\` keys follow the
config file; older Codex versions needed \`experimental_use_rmcp_client = true\`
for Streamable HTTP servers, and the \`--json\` event names have changed between
versions (the proof script reads \`item.completed\` events of type
\`mcp_tool_call\`).

### 4. Download and check the reel

${fence('bash', `curl -fsS -H "Authorization: Bearer $KEY" -o reel.mp4 "$RF/v1/renders/<renderId>/output"\nffprobe -v error -count_frames -select_streams v:0 \\\n  -show_entries stream=width,height,r_frame_rate,nb_read_frames:format=duration -of compact reel.mp4`)}`;
}

function sdkSteps(engine: CellEngine): string {
  const m = ENGINE_INFO[engine].manifest;
  return `### 2. Get the client script

[\`examples/tutorials/mcp-client.mjs\`](../../../examples/tutorials/mcp-client.mjs)
is a complete MCP client with the official TypeScript SDK and no language
model: it connects over Streamable HTTP with the Bearer key, lists the tools
and calls them one by one. In this repository the SDK is already installed;
elsewhere:

${fence('bash', 'mkdir reelforge-client && cd reelforge-client && npm init -y\nnpm i @modelcontextprotocol/sdk@1.32.2\n# copy mcp-client.mjs and the manifest next to it')}

The heart of it:

${fence(
  'js',
  `const client = new Client({ name: 'reelforge-tutorial', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(\`\${base}/mcp\`), {
  requestInit: { headers: { Authorization: \`Bearer \${key}\` } },
}));
await client.callTool({ name: 'create_project', arguments: { manifest } });
const { job } = JSON.parse((await client.callTool({ name: 'render_project', arguments: { projectId } })).content[0].text);
// get_job { jobId, waitSeconds: 45 } until "succeeded", then get_render_output { jobId }`
)}

### 3. The manifest

[\`${m}\`](../../../${m}):

${fence('json', readFileSync(join(REPO, m), 'utf8'))}

### 4. Run it

${fence('bash', `REELFORGE_URL=$RF REELFORGE_API_KEY=$KEY node examples/tutorials/mcp-client.mjs ${m}`)}

It prints one line per tool call, the job progress, then the render (size,
frames, duration, whether the poster image came back) and a \`RESULT {...}\`
line. Download the MP4 as in the REST tutorial:
\`curl -fsS -H "Authorization: Bearer $KEY" -o reel.mp4 "$RF/v1/renders/<renderId>/output"\`.

### Other MCP clients

Cursor, Windsurf, VS Code and Zed connect to the same endpoint with the same
header; their configuration snippets are in [other-clients.md](other-clients.md)
(**config documented, not proven**). Then give them the prompt from the
[Claude Code tutorial](../claude-code/${engine}.md#3-ask-for-the-reel).`;
}

function restSteps(engine: CellEngine): string {
  const m = ENGINE_INFO[engine].manifest;
  const id = projectIdFor('rest', engine);
  return `### 2. The manifest

[\`${m}\`](../../../${m}):

${fence('json', readFileSync(join(REPO, m), 'utf8'))}

### 3. Make the reel with curl

Step by step (needs \`curl\`, \`jq\`, \`ffprobe\`):

${fence(
  'bash',
  `# 1. What can this server render?
curl -fsS -H "Authorization: Bearer $KEY" $RF/v1/capabilities | jq -c '[.engines[] | {id, available}]'

# 2. Create the project (the manifest's projectId is "${readJson(m).projectId}"; we rename it)
jq '.projectId = "${id}"' ${m} \\
  | curl -fsS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d @- $RF/v1/projects

# 3. Validate: errors block a render, warnings do not
curl -fsS -X POST -H "Authorization: Bearer $KEY" $RF/v1/projects/${id}/validate | jq '{ok, summary}'

# 4. Render: 202 with a job at once
JOB=$(curl -fsS -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' \\
  $RF/v1/projects/${id}/renders | jq -r .job.id)

# 5. Wait: each call long-polls up to 50 s and returns as soon as the job finishes
while :; do
  S=$(curl -fsS -H "Authorization: Bearer $KEY" "$RF/v1/jobs/$JOB?wait=50" | tee job.json | jq -r .status)
  [ "$S" = queued ] || [ "$S" = running ] || break
done
jq '{status, result: .result | {renderId, frames, durationSeconds}}' job.json

# 6. Download and check
RENDER=$(jq -r .result.renderId job.json)
curl -fsS -H "Authorization: Bearer $KEY" -o final.mp4 $RF/v1/renders/$RENDER/output
ffprobe -v error -count_frames -select_streams v:0 \\
  -show_entries stream=width,height,r_frame_rate,nb_read_frames:format=duration -of compact final.mp4`
)}

The same as one script that fails on any error: [\`examples/tutorials/rest.sh\`](../../../examples/tutorials/rest.sh)

${fence('bash', `RF=$RF KEY=$KEY examples/tutorials/rest.sh ${m} ${id} final.mp4`)}

Live progress instead of polling: \`curl -N -H "Authorization: Bearer $KEY" $RF/v1/jobs/$JOB/events\` (Server-Sent Events).

### 4. The same with fetch

[\`examples/tutorials/rest-fetch.mjs\`](../../../examples/tutorials/rest-fetch.mjs) (Node 22, no dependencies) makes the same calls:

${fence('bash', `REELFORGE_URL=$RF REELFORGE_API_KEY=$KEY node examples/tutorials/rest-fetch.mjs ${m} ${id} final.mp4`)}

### Automation tools

n8n, Make and Zapier can run the same calls with their HTTP nodes:
[automation.md](automation.md) (**documented, not proven**).`;
}

function localSteps(engine: CellEngine): string {
  const prompt = promptFor('local-ai', engine);
  return `### 2. Install the local model runtime and a model

[node-llama-cpp](https://node-llama-cpp.withcat.ai) runs GGUF models in Node on
the CPU (prebuilt binaries from npm, no compiler). The tested model is
Qwen3-4B-Instruct-2507, 4-bit (Q4_K_M, 2.5 GB, Apache-2.0); it needs about
4 GB of free RAM with an 8k context. Keep both outside the studio checkout:

${fence(
  'bash',
  `mkdir -p ~/reelforge-local-ai && cd ~/reelforge-local-ai && npm init -y
npm i node-llama-cpp@3.22.3 @modelcontextprotocol/sdk@1.32.2
curl -L --fail -o Qwen3-4B-Instruct-2507-Q4_K_M.gguf \\
  https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`
)}

The download comes from \`huggingface.co\` and its CDN; behind a strict egress
proxy allow those hosts first.

### 3. Run the local agent

[\`scripts/tutorials/local-agent.mjs\`](../../../scripts/tutorials/local-agent.mjs)
is the whole agent: the MCP SDK client lists the studio's tools, offers the
model a small subset (\`list_templates\`, \`create_project\`, \`validate_project\`,
\`update_scene\`, \`render_project\`, \`get_job\`, \`get_render_output\`),
turns each tool's JSON Schema into a grammar so the model can only produce
well-formed arguments, and loops until \`get_render_output\` has returned a
render (or 25 tool calls are used). Two things it does for small models: a
call the model writes as text (a pretty-printed \`<tool_call>\` block) is run
like a native one, and when the history outgrows the 4k context the session
restarts from the prompt plus a one-line recap of the progress.

The exact prompt:

${fence('text', prompt)}

${fence(
  'bash',
  `REELFORGE_URL=$RF REELFORGE_API_KEY=$KEY \\
LOCAL_AGENT_MODULES=~/reelforge-local-ai \\
LOCAL_AGENT_MODEL=~/reelforge-local-ai/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \\
  node scripts/tutorials/local-agent.mjs "$(cat prompt.txt)"`
)}

With **Ollama** or **llama.cpp's \`llama-server --jinja\`** instead (any
OpenAI-compatible endpoint with tool calling; **documented, not proven**):

${fence('bash', `LOCAL_AGENT_BACKEND=openai LOCAL_AGENT_BASE_URL=http://127.0.0.1:11434/v1 LOCAL_AGENT_MODEL=qwen2.5:7b-instruct \\\nREELFORGE_URL=$RF REELFORGE_API_KEY=$KEY node scripts/tutorials/local-agent.mjs "$(cat prompt.txt)"`)}

### 4. Download and check the reel

${fence('bash', `curl -fsS -H "Authorization: Bearer $KEY" -o reel.mp4 "$RF/v1/renders/<renderId>/output"\nffprobe -v error -count_frames -select_streams v:0 \\\n  -show_entries stream=width,height,r_frame_rate,nb_read_frames:format=duration -of compact reel.mp4`)}`;
}

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
}

const PREREQS: Record<AgentId, string> = {
  'claude-code': '- Claude Code CLI (the proof used 2.1.330), signed in the way Anthropic supports for your plan or API key.',
  codex: '- OpenAI Codex CLI and an OpenAI account (API key or ChatGPT plan).',
  'mcp-sdk': '- Node.js 22 and `@modelcontextprotocol/sdk` 1.32.2 (already in this repository).',
  rest: '- `curl`, `jq` and `ffprobe` (or Node.js 22 for the fetch version).',
  'local-ai': '- Node.js 22, about 3 GB of disk for the model and 4 GB of free RAM; no GPU needed (a GPU makes it faster).',
};

const AGENT_DOES: Record<AgentId, string> = {
  'claude-code': 'Claude reads the tool list, looks up the template props, writes the manifest itself and works through the studio workflow:',
  codex: 'Codex should work through the same workflow as Claude Code (not observed yet):',
  'mcp-sdk': 'The script makes these calls, always in this order (no model involved):',
  rest: 'The REST calls, in order (each MCP tool has a REST route: [AGENT_PLATFORM.md §6](../../AGENT_PLATFORM.md)):',
  'local-ai': 'The local model gets the prompt and the tool subset; the agent loop executes every tool call it makes and feeds the result back:',
};

const TYPICAL: Record<AgentId, string[]> = {
  'claude-code': ['list_templates', 'create_project', 'validate_project', 'render_project', 'get_job (repeated)', 'get_render_output'],
  codex: ['list_templates', 'create_project', 'validate_project', 'render_project', 'get_job (repeated)', 'get_render_output'],
  'mcp-sdk': ['get_capabilities', 'list_templates', 'list_projects (and delete_project on a re-run)', 'create_project', 'validate_project', 'render_project', 'get_job (repeated, waitSeconds 45)', 'get_render_output'],
  rest: ['GET /v1/capabilities', 'POST /v1/projects', 'POST /v1/projects/:id/validate', 'POST /v1/projects/:id/renders', 'GET /v1/jobs/:id?wait=50 (repeated)', 'GET /v1/renders/:id/output'],
  'local-ai': ['list_templates', 'create_project', 'validate_project', 'render_project', 'get_job (repeated)', 'get_render_output'],
};

const AGENT_TROUBLE: Record<AgentId, string> = {
  'claude-code': `| \`claude mcp list\` shows the server as failed | The studio is not running, the URL is wrong or the header is missing. \`curl -s $RF/healthz\` should answer. |
| \`-p\` stops with a permission error for a tool | Add \`--allowedTools mcp__reelforge\` (all studio tools) or name the tools one by one. |
| \`error_max_turns\` | The task needed more turns; raise \`--max-turns\` or make the prompt more specific (name the engine and template). |
| The agent uses another server's tools | Add \`--strict-mcp-config\` so only \`--mcp-config\` servers load. |`,
  codex: `| \`codex mcp list\` does not show reelforge | The config file is not \`~/.codex/config.toml\` (or \`$CODEX_HOME/config.toml\`), or the TOML table name is wrong. |
| The MCP server fails to start or times out | \`REELFORGE_API_KEY\` is not exported in the shell that runs Codex, or the studio is not reachable. |
| Tool calls wait for approval in \`exec\` | Set \`approval_policy = "never"\` for headless runs (VERIFY the key for your version). |`,
  'mcp-sdk': `| \`Cannot find package '@modelcontextprotocol/sdk'\` | Run the script from this repository, or \`npm i @modelcontextprotocol/sdk@1.32.2\` next to it. |
| \`fetch failed\` / \`ECONNREFUSED\` | The studio is not running on \`REELFORGE_URL\`. |
| A tool result has \`isError: true\` | The script prints the error body and stops; the \`code\` and \`details\` say what to fix. |`,
  rest: `| \`curl: (22) ... 4xx\` | \`-f\` makes curl fail on an HTTP error; run the call without \`-f\` to see the JSON error body. |
| \`409 version_conflict\` | Another writer changed the project; read it again (\`GET /v1/projects/:id\`) and retry. |
| The download is 404 | The render was deleted by retention, or the id is a job id: use \`.result.renderId\` of the job. |`,
  'local-ai': `| Very slow first answer | The model reads the system prompt and tool schemas first (a few thousand tokens); on 4 CPU cores that takes a minute or more. Later turns reuse the cache. |
| The model invents template props | It gets the \`invalid_manifest\` error with every path and usually fixes it in the next call; a bigger model (7B) makes fewer mistakes. |
| \`NOT done after 25 tool calls\` | Raise \`LOCAL_AGENT_MAX_TOOL_CALLS\`, make the prompt more specific, or use a bigger model. |
| Out of memory | Lower \`LOCAL_AGENT_CONTEXT\` (e.g. 6144) or use a smaller quantization. |`,
};

export function cellPage(agent: AgentId, engine: CellEngine, p: Proof | null): string {
  const a = AGENT_INFO[agent];
  const e = ENGINE_INFO[engine];
  const steps = { 'claude-code': claudeSteps, codex: codexSteps, 'mcp-sdk': sdkSteps, rest: restSteps, 'local-ai': localSteps }[agent](engine);
  const status = statusOf(agent, engine, p);
  const banner =
    p?.status === 'passed'
      ? `> **Status: ${status}.** The steps below were run end to end; the [Proof](#proof) section has the result.`
      : p?.status === 'failed'
        ? `> **Status: ${status}.** The last proof run failed; see [Proof](#proof) for why.`
        : `> **Status: ${status}.** Written from the documented interfaces; not run end to end yet.`;
  return `<!-- Generated by scripts/tutorials/docs.ts from cells.ts and proofs/${agent}-${engine}.json. Edit those, then run pnpm tutorials:docs. -->

# ${a.title} + ${e.title}

${banner}

Make a short vertical reel with ${e.engines.length > 1 ? 'scenes from all four engines' : `the ${e.title} engine`}, driven by ${a.title.replace(/ \(.*\)$/, '')}.
Matrix and other combinations: [tutorials README](../README.md).

## Prerequisites

- A running ReelForge Studio and an API key with the \`read,write,render\` scopes (step 1).
- A licence key for a real install (the Personal licence is free), or \`REELFORGE_LICENCE_MODE=off\` from a checkout for local development only.
${PREREQS[agent]}

## Steps

${studioBlock('../../')}

${steps}

## What the agent does

${AGENT_DOES[agent]}

${TYPICAL[agent].map((t, i) => `${i + 1}. \`${t}\``).join('\n')}

${p?.toolCalls.length ? `The proof run's actual calls are listed under [Proof](#proof).` : ''}

## Expected output

${expectedOutput(agent, engine)}

${engineNotes(engine)}

## Troubleshooting

${commonTroubleshooting()}
${AGENT_TROUBLE[agent]}

${proofSection(agent, engine, p)}
`.replace(/\n{3,}/g, '\n\n');
}

export function readmePage(proofs: Map<string, Proof | null>): string {
  const head = `| Agent | ${CELL_ENGINES.map((e) => ENGINE_INFO[e].title).join(' | ')} |\n| --- | ${CELL_ENGINES.map(() => '---').join(' | ')} |`;
  const rows = AGENTS.map(
    (a) => `| **${AGENT_INFO[a].label}** | ${CELL_ENGINES.map((e) => `[${matrixStatus(a, e, proofs.get(`${a}-${e}`) ?? null)}](${a}/${e}.md)`).join(' | ')} |`
  ).join('\n');
  return `<!-- Generated by scripts/tutorials/docs.ts. Edit it, then run pnpm tutorials:docs. -->

# Tutorials: every agent with every engine

ReelForge Studio is driven by agents over MCP or REST and renders with four
engines. Each cell below is a step-by-step tutorial **and** a reproducible
proof: the same prompt or script, run against a real studio, with the output
checked by ffprobe. A cell is ✅ only after such a run passed; everything else
says why it is not proven.

${head}
${rows}

✅ proven on that date (a real run passed every check) · 📝 documented, not
proven, with the reason · ❌ a proof run failed (the page has the cause).
Click a cell for its tutorial.

What the columns mean: one reel per engine (Remotion \`kinetic-title\`,
Motion Canvas \`animated-explainer\`, HTML \`html-title\`, HyperFrames
\`hyperframes-title\`), and a **multi-engine** reel with one scene from each,
joined to the frame. Reels are 8 to 9 s, 1080x1920, 30 fps.

Why some cells are not proven:

${notProven(proofs)}

Other clients without their own row (Cursor, Windsurf, VS Code, Zed) use the
same MCP endpoint: [mcp-sdk/other-clients.md](mcp-sdk/other-clients.md)
(config documented, not proven). Automation tools (n8n, Make, Zapier):
[rest/automation.md](rest/automation.md) (documented, not proven).

## Start here (first reel in about 5 minutes)

1. **Run the studio with Docker** and activate your licence key (the Personal
   licence is free):

${indent(fence('bash', `git clone https://github.com/buildbase-app/reelforge-studio && cd reelforge-studio
export REELFORGE_SECRET_KEY=$(openssl rand -base64 32)   # keep a copy
docker compose up -d --build
docker compose exec reelforge reelforge licence activate <YOUR-LICENCE-KEY>`), 3)}

2. **Create a key for your agent** (printed once):

${indent(fence('bash', 'docker compose exec reelforge reelforge keys create --name claude --scopes read,write,render\nexport REELFORGE_API_KEY=rf_...'), 3)}

3. **Connect Claude Code**:

${indent(fence('bash', `claude mcp add --transport http reelforge ${RF}/mcp \\\n  --header "Authorization: Bearer $REELFORGE_API_KEY"`), 3)}

4. **Ask for a reel**: start \`claude\` and paste the prompt from
   [Claude Code + HTML](claude-code/html.md#3-ask-for-the-reel). Claude creates
   the project, renders it and replies with the render id; the tutorial shows
   how to download and check the MP4.

Developing on the studio itself instead? \`pnpm dev\` from a checkout runs
without a licence (\`REELFORGE_LICENCE_MODE=off\`, local development only); see
step 1B of any tutorial.

## Reproduce a proof

${fence(
  'bash',
  `export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm tutorials:prove rest html            # one cell
pnpm tutorials:prove mcp-sdk all          # a whole row
pnpm tutorials:prove claude-code remotion --record   # also update docs/tutorials/proofs/
pnpm tutorials:docs                       # regenerate these pages from cells.ts and the proofs`
)}

The proof script starts a studio from the checkout (licence mode off: local
development only) unless \`REELFORGE_URL\` and \`REELFORGE_API_KEY\` point at
one, runs the agent, then checks on its own over REST that the job
succeeded, that the project uses the cell's engines, and that the MP4 has the
right size, frame rate, decoded frame count, duration and codecs. Artefacts
(transcript, MP4, poster, \`proof.json\`) go to \`$TUTORIAL_OUT\` (default
\`$TMPDIR/reelforge-tutorials\`), never into the repository. Test cases:
[TEST_CASES.md](TEST_CASES.md).
`;
}

/** One bullet per agent with cells that are not ✅, with the reason from cells.ts or the failed proof. */
function notProven(proofs: Map<string, Proof | null>): string {
  const out: string[] = [];
  for (const a of AGENTS) {
    const open = CELL_ENGINES.filter((e) => proofs.get(`${a}-${e}`)?.status !== 'passed');
    if (!open.length) continue;
    const failed = open.filter((e) => proofs.get(`${a}-${e}`)?.status === 'failed');
    const notRun = open.filter((e) => !proofs.get(`${a}-${e}`));
    const parts: string[] = [];
    if (notRun.length) parts.push(`${notRun.map((e) => ENGINE_INFO[e].title).join(', ')}: ${AGENT_INFO[a].blocked ?? 'not run yet'}`);
    if (failed.length) parts.push(`${failed.map((e) => ENGINE_INFO[e].title).join(', ')}: the proof run failed (see the page for the cause)`);
    out.push(`- **${AGENT_INFO[a].label}**: ${parts.join('; ')}.`);
  }
  return out.length ? out.join('\n') : '- None: every cell is proven.';
}

function indent(s: string, n: number): string {
  return s
    .split('\n')
    .map((l) => (l ? ' '.repeat(n) + l : l))
    .join('\n');
}

export function testCasesPage(proofs: Map<string, Proof | null>, extra: { id: string; what: string; how: string; result: string; date: string }[]): string {
  const rows: string[] = [];
  for (const a of AGENTS)
    for (const e of CELL_ENGINES) {
      const p = proofs.get(`${a}-${e}`) ?? null;
      const result = p?.status === 'passed' ? '✅ pass' : p?.status === 'failed' ? `❌ fail: ${p.problems[0]?.split('\n')[0]}` : `📝 not run (${AGENT_INFO[a].blocked ?? 'not run yet'})`;
      rows.push(
        `| ${caseId(a, e)} | ${AGENT_INFO[a].label} makes a ${ENGINE_INFO[e].title} reel; job succeeds, engines match, ffprobe passes | \`pnpm tutorials:prove ${a} ${e}\` ([page](${a}/${e}.md)) | ${result} | ${p ? day(p.date) : 'n/a'} |`
      );
    }
  for (const x of extra) rows.push(`| ${x.id} | ${x.what} | ${x.how} | ${x.result} | ${x.date} |`);
  return `<!-- Generated by scripts/tutorials/docs.ts. Edit it, then run pnpm tutorials:docs. -->

# Tutorial test cases

Every ✅ cell in the [matrix](README.md) maps to a passing case here. A cell
case passes only when all of these hold, checked by the proof script itself
(not by the agent's reply): the render job \`succeeded\`; the project's scenes use
exactly the cell's engines; the downloaded \`final.mp4\` is H.264 1080x1920 at
30 fps with an AAC track; a full decode counts as many frames as the duration
needs; the duration is exact for scripted rows (240 or 270 frames) and within
6 to 12 s for LLM rows.

| ID | What | How | Result | Date |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

/** Notes on individual proofs (earlier failed attempts and their causes), keyed `<agent>-<engine>`. */
function loadNotes(): Record<string, string> {
  const f = join(DOCS, 'proofs/notes.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

/** Extra cases (not cells): recorded in proofs/extra.json by hand after running them. */
function loadExtra(): { id: string; what: string; how: string; result: string; date: string }[] {
  const f = join(DOCS, 'proofs/extra.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

export function allPages(): Map<string, string> {
  const pages = new Map<string, string>();
  const proofs = new Map<string, Proof | null>();
  for (const a of AGENTS)
    for (const e of CELL_ENGINES) {
      const p = loadProof(a, e);
      proofs.set(`${a}-${e}`, p);
      pages.set(join(DOCS, a, `${e}.md`), cellPage(a, e, p));
    }
  pages.set(join(DOCS, 'README.md'), readmePage(proofs));
  pages.set(join(DOCS, 'TEST_CASES.md'), testCasesPage(proofs, loadExtra()));
  return pages;
}

function main() {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [file, body] of allPages()) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === body) continue;
    if (check) stale.push(file.slice(REPO.length + 1));
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      console.log(`wrote ${file.slice(REPO.length + 1)}`);
    }
  }
  if (stale.length) {
    console.error(`out of date (run pnpm tutorials:docs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
