#!/bin/sh
# Seed bundled defaults into DSCODE_HOME, then run the server.
set -e

DEFAULT_FILES_DIR=/usr/local/share/dscode/default-files
DEFAULT_SKILLS_DIR=/usr/local/share/dscode/default-skills
DSCODE_HOME_DIR="${DSCODE_HOME:-/root/.dscode}"
SKILLS_DIR="$DSCODE_HOME_DIR/skills"

seed_file() {
  source=$1
  target=$2
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    cp -a "$source" "$target"
  fi
}

mkdir -p "$DSCODE_HOME_DIR"
seed_file "$DEFAULT_FILES_DIR/APPEND_SYSTEM.md" "$DSCODE_HOME_DIR/APPEND_SYSTEM.md"
seed_file "$DEFAULT_FILES_DIR/AGENTS.md" "$DSCODE_HOME_DIR/AGENTS.md"

mkdir -p "$SKILLS_DIR"
for skill in "$DEFAULT_SKILLS_DIR"/*; do
  [ -d "$skill" ] || continue
  name=$(basename "$skill")
  if [ ! -e "$SKILLS_DIR/$name" ]; then
    cp -a "$skill" "$SKILLS_DIR/$name"
  fi
done

exec "$@"