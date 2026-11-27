# Optional speech-to-text layer (faster-whisper)

`transcribe_captions` turns an uploaded voice-over into word-timed captions with a
local speech-to-text program (issue #300, D-114, [docs/CAPTIONS.md](../../docs/CAPTIONS.md#speech-to-text)).
The release image does not include it: Python, [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(MIT) and a Whisper model add about 800 MB with the `tiny` model and more with larger
ones. Without it speech-to-text is simply off (`get_capabilities` → `captions.stt.available: false`).

## Build the layer

From the repository root, on top of the image you run:

```bash
docker build -t reelforge-studio:release .
docker build -f deployment/stt/Dockerfile \
  --build-arg BASE=reelforge-studio:release \
  --build-arg WHISPER_MODEL=small \
  -t reelforge-studio:release-stt .
```

It installs Python 3, a virtual environment in `/opt/reelforge/stt` with
`faster-whisper==1.2.1` and `av==18.0.0` (PyAV 19 removed an argument faster-whisper
1.2.1 passes, checked 2026-11-23), downloads the model into
`/opt/reelforge/whisper-models` **at build time**, installs
[`reelforge-whisper`](reelforge-whisper) as `/usr/local/bin/reelforge-whisper`, sets
`RENDERWELD_STT_MODEL` and `RENDERWELD_STT_MODEL_DIR`, and switches back to UID 10001.
It runs with the release image's hardening (`--read-only`, no network needed at run
time). Behind a TLS-intercepting proxy pass its CA bundle:
`--secret id=extra_ca,src=/path/to/ca.crt`.

Models (`WHISPER_MODEL`): `tiny`, `base`, `small` (default), `medium`, `large-v3`,
`distil-large-v3`, `turbo`, or a `.en` variant (`small.en`, ...) for English only.
Larger models are more accurate and slower; on a CPU `small` with `int8` is a fair
default. A GPU needs a CUDA base image and `RENDERWELD_STT_DEVICE=cuda`,
`RENDERWELD_STT_COMPUTE_TYPE=float16` (not tested).

## Without Docker

```bash
python3 -m venv /opt/reelforge/stt
/opt/reelforge/stt/bin/pip install faster-whisper==1.2.1 av==18.0.0
/opt/reelforge/stt/bin/python -c "from faster_whisper import download_model; download_model('small', cache_dir='/opt/reelforge/whisper-models')"
install -m 0755 deployment/stt/reelforge-whisper /opt/reelforge/stt/bin/reelforge-whisper
sed -i '1s|.*|#!/opt/reelforge/stt/bin/python3 -I|' /opt/reelforge/stt/bin/reelforge-whisper
export RENDERWELD_STT_COMMAND=/opt/reelforge/stt/bin/reelforge-whisper \
       RENDERWELD_STT_MODEL=small RENDERWELD_STT_MODEL_DIR=/opt/reelforge/whisper-models
```

The model download is the only network access; if it uses Hugging Face's Xet storage
and that host is blocked, set `HF_HUB_DISABLE_XET=1`.

## The program's contract

`reelforge-whisper --input FILE --model NAME|DIR [--model-dir DIR] --language auto|xx
--compute-type T --device cpu|cuda|auto --output json` prints
`{ "language", "languageProbability", "duration", "words": [{ "text", "start", "end", "probability" }], "engine": {...} }`
and exits 0; 2 for bad arguments, 3 when the model is not available offline, 4 when the
file cannot be transcribed. It forces Hugging Face offline mode before importing the
library and loads the model with `local_files_only=True`, so it never downloads at run
time. Any program with this contract can be set as `captions.stt.command`.

## Checked

- 2026-11-23: built on `debian:bookworm-slim` with `WHISPER_MODEL=tiny`, then run with
  `--network none --read-only` as UID 10001 (the layer's `USER`) on a FFmpeg `flite` sentence: language `en`,
  12 word timings. The layer on top of the release image was not built (VERIFY in the
  image e2e).
- `packages/core/test/stt.test.ts` runs the real program when `reelforge-whisper` (or
  `RENDERWELD_STT_COMMAND`) is installed, with `RENDERWELD_STT_MODEL` / `RENDERWELD_STT_MODEL_DIR`;
  otherwise it is skipped.

## Licences

None of this is in the release image or a sale; the layer is built by the operator.
faster-whisper 1.2.1: MIT (SYSTRAN). Its dependencies: CTranslate2 (MIT), PyAV (BSD-3-Clause;
its wheels bundle FFmpeg libraries, LGPL), tokenizers (Apache-2.0), huggingface_hub
(Apache-2.0), onnxruntime (MIT; runs the bundled Silero VAD model, MIT). Whisper model weights:
MIT (OpenAI); the CTranslate2 conversions `Systran/faster-whisper-*` on Hugging Face: MIT.
Checked from the package metadata on 2026-11-23; VERIFY each model card before choosing another
model.
