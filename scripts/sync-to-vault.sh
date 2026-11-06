#!/usr/bin/env bash
#
# Sync the built Cypher plugin into an Obsidian vault's plugin folder.
#
# Usage:
#   ./scripts/sync-to-vault.sh                 # build + copy to the default vault
#   ./scripts/sync-to-vault.sh --no-build      # copy only (use existing main.js)
#   ./scripts/sync-to-vault.sh /path/to/vault  # target a different vault
#
# Vault resolution order:
#   1. explicit argument
#   2. $CYPHER_VAULT environment variable
#   3. DEFAULT_VAULT below
#
# After syncing, reload the plugin in Obsidian:
#   Ctrl/Cmd+P -> "Reload app without saving"
# or disable/enable Cypher in Settings -> Community plugins.

set -euo pipefail

DEFAULT_VAULT="${HOME}/vaults/Abdo"
PLUGIN_ID="cypher"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUILD=true
VAULT=""

for arg in "$@"; do
  case "${arg}" in
    --no-build) BUILD=false ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "Unknown option: ${arg}" >&2
      exit 2
      ;;
    *) VAULT="${arg}" ;;
  esac
done

if [[ -z "${VAULT}" ]]; then
  VAULT="${CYPHER_VAULT:-${DEFAULT_VAULT}}"
fi

if [[ ! -d "${VAULT}/.obsidian" ]]; then
  echo "error: '${VAULT}' does not look like an Obsidian vault (no .obsidian directory)." >&2
  echo "Pass the vault path explicitly: $0 /path/to/vault" >&2
  exit 1
fi

DEST="${VAULT}/.obsidian/plugins/${PLUGIN_ID}"
mkdir -p "${DEST}"

if [[ "${BUILD}" == true ]]; then
  echo "==> Building plugin..."
  (cd "${REPO_ROOT}" && npm run build)
fi

# main.js is gitignored/untracked-by-build; verify it exists before copying.
if [[ ! -f "${REPO_ROOT}/main.js" ]]; then
  echo "error: ${REPO_ROOT}/main.js not found. Run without --no-build first." >&2
  exit 1
fi

echo "==> Syncing to ${DEST}"
for file in main.js manifest.json styles.css; do
  if [[ ! -f "${REPO_ROOT}/${file}" ]]; then
    echo "error: missing build artifact '${file}'" >&2
    exit 1
  fi
  cp -f "${REPO_ROOT}/${file}" "${DEST}/${file}"
  printf '    %s\n' "${file}"
done

# Never touch data.json, orama_db.json, or index_meta.json: those live only in the
# vault and hold the user's settings and vector index.
echo "==> Done. Reload Obsidian: Ctrl/Cmd+P -> \"Reload app without saving\""
