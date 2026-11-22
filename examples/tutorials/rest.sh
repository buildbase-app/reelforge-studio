#!/usr/bin/env bash
# Make a reel with nothing but curl and jq: create the project, render it,
# long-poll the job (?wait=), download the MP4 and check it with ffprobe.
#
#   export RF=http://127.0.0.1:4321 KEY=rf_...
#   examples/tutorials/rest.sh examples/tutorials/html.json [projectId] [out.mp4]
#
# The last line it prints is `RESULT {json}`.
set -euo pipefail
: "${RF:?set RF to the studio URL, e.g. http://127.0.0.1:4321}"
: "${KEY:?set KEY to an API key (rf_...) with the read,write,render scopes}"
MANIFEST=${1:?usage: rest.sh <manifest.json> [projectId] [out.mp4]}
PROJECT=${2:-$(jq -r .projectId "$MANIFEST")}
OUT=${3:-final.mp4}
AUTH=(-H "Authorization: Bearer $KEY")
JSON=(-H 'content-type: application/json')
CALLS=()

# 1. What can this server render?
curl -fsS "${AUTH[@]}" "$RF/v1/capabilities" | jq -c '[.engines[] | {id, available}]'
CALLS+=("GET /v1/capabilities")

# 2. Create the project (delete an earlier one of the same id first, so the script can be re-run).
if curl -fsS -o /dev/null "${AUTH[@]}" "$RF/v1/projects/$PROJECT" 2>/dev/null; then
  curl -fsS -X DELETE "${AUTH[@]}" "$RF/v1/projects/$PROJECT" > /dev/null
  CALLS+=("DELETE /v1/projects/$PROJECT")
fi
jq --arg id "$PROJECT" '.projectId = $id' "$MANIFEST" \
  | curl -fsS "${AUTH[@]}" "${JSON[@]}" -d @- "$RF/v1/projects" | jq -c '{project: .meta.id, version: .meta.version}'
CALLS+=("POST /v1/projects")

# 3. Validate: errors block a render, warnings do not.
curl -fsS -X POST "${AUTH[@]}" "$RF/v1/projects/$PROJECT/validate" | jq -e -c '{ok, summary}'
CALLS+=("POST /v1/projects/$PROJECT/validate")

# 4. Start the render; it answers 202 with a job at once.
JOB=$(curl -fsS -X POST "${AUTH[@]}" "${JSON[@]}" -d '{}' "$RF/v1/projects/$PROJECT/renders" | jq -r .job.id)
CALLS+=("POST /v1/projects/$PROJECT/renders")
echo "job $JOB"

# 5. Long-poll: each call waits up to 50 s and returns as soon as the job finishes.
while :; do
  STATUS=$(curl -fsS "${AUTH[@]}" "$RF/v1/jobs/$JOB?wait=50")
  CALLS+=("GET /v1/jobs/$JOB?wait=50")
  S=$(jq -r .status <<< "$STATUS")
  echo "  $S $(jq -r '.progress.stage // ""' <<< "$STATUS")"
  case $S in succeeded) break ;; failed|cancelled) jq . <<< "$STATUS"; exit 1 ;; esac
done
RENDER=$(jq -r .result.renderId <<< "$STATUS")

# 6. Download the MP4 (the Bearer key works; so does the signed downloadUrl without a key).
curl -fsS "${AUTH[@]}" -o "$OUT" "$RF/v1/renders/$RENDER/output"
CALLS+=("GET /v1/renders/$RENDER/output")

# 7. Check it: size, frame rate, decoded frame count, duration.
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_read_frames:format=duration -of compact "$OUT"

printf 'RESULT %s\n' "$(jq -cn --arg p "$PROJECT" --arg j "$JOB" --arg r "$RENDER" --arg o "$OUT" \
  '{projectId: $p, jobId: $j, renderId: $r, output: $o, toolCalls: ($ARGS.positional | map({name: ., input: {}}))}' --args "${CALLS[@]}")"
