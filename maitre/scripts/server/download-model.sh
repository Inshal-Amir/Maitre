#!/usr/bin/env bash
# Download the configured model at its PINNED revision to MAITRE_MODEL_DIR (outside git), then verify it and
# record SHA-256 sums. With MAITRE_MODEL_FILE set (llamacpp) only that GGUF file is fetched and must match
# MAITRE_MODEL_SHA256 (plus the vision file MAITRE_MMPROJ_FILE / MAITRE_MMPROJ_SHA256 when set); otherwise (vllm) the safetensors snapshot is fetched. GPU PC only - never on the Mac.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
: "${MAITRE_MODEL_REPO:?}" "${MAITRE_MODEL_REVISION:?}" "${MAITRE_MODEL_SUBDIR:?}" "${MAITRE_MODEL_DIR:?}"
[[ "$MAITRE_MODEL_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "MAITRE_MODEL_REVISION must be a full 40-character commit sha"
DEST="$MAITRE_MODEL_DIR/$MAITRE_MODEL_SUBDIR"
mkdir -p "$DEST"
command -v uvx >/dev/null || die "uv is required (https://docs.astral.sh/uv/)"
hf() { uvx --from 'huggingface_hub[hf_xet]==1.*' hf download "$MAITRE_MODEL_REPO" --revision "$MAITRE_MODEL_REVISION" --local-dir "$DEST" "$@"; }

if [ -n "${MAITRE_MODEL_FILE:-}" ]; then
  # A split GGUF is named by its first shard (...-00001-of-0000N.gguf); llama.cpp loads the rest from the same
  # folder. MAITRE_MODEL_SHA256 then lists one sha256 per shard, comma separated, in shard order.
  files=("$MAITRE_MODEL_FILE")
  if [[ "$MAITRE_MODEL_FILE" =~ ^(.*-)00001-of-([0-9]{5})\.gguf$ ]]; then
    files=(); for ((i = 1; i <= 10#${BASH_REMATCH[2]}; i++)); do
      files+=("$(printf '%s%05d-of-%s.gguf' "${BASH_REMATCH[1]}" "$i" "${BASH_REMATCH[2]}")"); done
  fi
  IFS=, read -ra sums <<<"${MAITRE_MODEL_SHA256:-}"
  if [ -n "${MAITRE_MMPROJ_FILE:-}" ]; then files+=("$MAITRE_MMPROJ_FILE"); sums+=("${MAITRE_MMPROJ_SHA256:-}"); fi
  [ "${#sums[@]}" -eq "${#files[@]}" ] || die "MAITRE_MODEL_SHA256 needs ${#files[@]} sha256 value(s), comma separated; got ${#sums[@]}"
  for s in "${sums[@]}"; do [[ "$s" =~ ^[0-9a-f]{64}$ ]] || die "not a 64-character sha256 in MAITRE_MODEL_SHA256: $s"; done
  need_gb=$((30 * ${#files[@]}))
  free_gb=$(df -BG --output=avail "$DEST" | tail -1 | tr -dc 0-9)
  [ "$free_gb" -ge "$need_gb" ] || die "only ${free_gb} GB free at $DEST; need about ${need_gb} GB"
  say "downloading $MAITRE_MODEL_REPO/$MAITRE_MODEL_FILE (${#files[@]} file(s)) @ ${MAITRE_MODEL_REVISION:0:12} -> $DEST (resumable)"
  hf "${files[@]}"
  say "verifying sha256 (takes a few minutes)"
  for i in "${!files[@]}"; do echo "${sums[$i]}  ${files[$i]}"; done | (cd "$DEST" && sha256sum -c -) \
    || die "checksum mismatch: delete the failed file(s) under $DEST and download again"
  ( cd "$DEST" && sha256sum "${files[@]}" >SHA256SUMS )
else
  say "downloading $MAITRE_MODEL_REPO @ $MAITRE_MODEL_REVISION -> $DEST"
  hf --exclude '*.gguf' --exclude '*.onnx' --exclude 'original/*'
  for f in config.json tokenizer_config.json; do [ -f "$DEST/$f" ] || die "missing $f in download"; done
  ls "$DEST"/*.safetensors >/dev/null 2>&1 || die "no .safetensors weights found"
  ( cd "$DEST" && find . -type f ! -name 'SHA256SUMS' ! -path './.cache/*' -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS )
fi

cat >"$DEST/MAITRE-PROVENANCE.txt" <<TXT
repository: $MAITRE_MODEL_REPO
revision:   $MAITRE_MODEL_REVISION
file:       ${MAITRE_MODEL_FILE:-(full snapshot)}
downloaded: $(date -u +%Y-%m-%dT%H:%M:%SZ)
host:       $(hostname)
files:      see SHA256SUMS
TXT
du -sh "$DEST"
say "done: $MODEL_PATH"
