#!/usr/bin/env bash
# usage: run-k6.sh <label> <profile> [extra -e KEY=VAL ...]   (results -> reports/<label>/)
cd "$(dirname "$0")" || exit 1
label=$1; profile=$2; shift 2; mkdir -p reports/$label
MSYS_NO_PATHCONV=1 docker run --rm -i -v "$(pwd -W):/work" -w /work grafana/k6:latest run --quiet \
  -e PROFILE=$profile "$@" --summary-export=/work/reports/$label/k6-summary.json \
  --out json=/work/reports/$label/k6-points.json scripts/rest.js 2>&1 | tee reports/$label/k6-stdout.txt | tail -60
