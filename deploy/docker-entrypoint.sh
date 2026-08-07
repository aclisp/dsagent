#!/bin/sh
# Seed the default skills into the (volume-backed) skills dir, then run the server.
# /root/.dscode is a named volume, so image content there only reaches fresh volumes;
# copying missing defaults on every start guarantees the bundled skills are present
# without ever overwriting user skills.
set -e

DEFAULT_SKILLS_DIR=/usr/local/share/dscode/default-skills
SKILLS_DIR="${DSCODE_HOME:-/root/.dscode}/skills"

mkdir -p "$SKILLS_DIR"
for skill in "$DEFAULT_SKILLS_DIR"/*; do
  [ -d "$skill" ] || continue
  name=$(basename "$skill")
  if [ ! -e "$SKILLS_DIR/$name" ]; then
    cp -a "$skill" "$SKILLS_DIR/$name"
  fi
done

exec "$@"