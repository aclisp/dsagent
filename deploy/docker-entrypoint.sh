#!/bin/sh
# Configure runtime APT defaults, seed bundled defaults into DSCODE_HOME, then run the server.
set -e

DEFAULT_FILES_DIR=/usr/local/share/dscode/default-files
DEFAULT_SKILLS_DIR=/usr/local/share/dscode/default-skills
DSCODE_HOME_DIR="${DSCODE_HOME:-/root/.dscode}"
SKILLS_DIR="$DSCODE_HOME_DIR/skills"
APT_SOURCES_FILE=/etc/apt/sources.list.d/debian.sources
APT_PIPELINE_FILE=/etc/apt/apt.conf.d/99dscode-pipeline-depth

configure_runtime_apt() {
  runtime_mirror=${DSCODE_RUNTIME_APT_MIRROR-mirrors.tuna.tsinghua.edu.cn}
  runtime_pipeline_depth=${DSCODE_RUNTIME_APT_PIPELINE_DEPTH-0}

  if [ ! -f "$APT_SOURCES_FILE" ]; then
    return 0
  fi

  case "$runtime_mirror" in
    '') ;;
    *[!A-Za-z0-9.-]*)
      echo "warning: invalid DSCODE_RUNTIME_APT_MIRROR; keeping the image source" >&2
      ;;
    *)
      if ! sed -i -E "s#(https?://)[^/[:space:]]+(/debian[^[:space:]]*)#\1${runtime_mirror}\2#g" "$APT_SOURCES_FILE"; then
        echo "warning: unable to configure the runtime APT mirror" >&2
      fi
      ;;
  esac

  case "$runtime_pipeline_depth" in
    '')
      if ! rm -f "$APT_PIPELINE_FILE"; then
        echo "warning: unable to remove the runtime APT pipeline override" >&2
      fi
      ;;
    *[!0-9]*)
      echo "warning: invalid DSCODE_RUNTIME_APT_PIPELINE_DEPTH; keeping the existing setting" >&2
      ;;
    *)
      if ! printf 'Acquire::http::Pipeline-Depth "%s";\n' "$runtime_pipeline_depth" > "$APT_PIPELINE_FILE"; then
        echo "warning: unable to configure the runtime APT pipeline depth" >&2
      fi
      ;;
  esac
}

configure_runtime_apt

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
