#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

link_tree() {
    local source="$1" target="$2" path relative destination linked
    local -a files=() conflicts=()

    while IFS= read -r -d '' path; do files+=("$path"); done < <(find "$source" \( -type f -o -type l \) -print0)

    while IFS= read -r -d '' path; do
        linked=$(readlink "$path" || true)
        [[ "$linked" == "$source"/* && ! -e "$path" ]] && rm "$path"
    done < <(find "$target" -type l -print0 2>/dev/null || true)

    for path in "${files[@]}"; do
        relative=${path#"$source"/}
        destination="$target/$relative"
        if [[ -e "$destination" || -L "$destination" ]]; then
            [[ -L "$destination" && "$(readlink "$destination")" == "$path" ]] || conflicts+=("$destination")
        fi
    done

    ((${#conflicts[@]} == 0)) || { printf 'Refusing to overwrite local files:\n%s\n' "${conflicts[@]}" >&2; return 1; }

    for path in "${files[@]}"; do
        relative=${path#"$source"/}
        destination="$target/$relative"
        mkdir -p "$(dirname "$destination")"
        [[ -e "$destination" || -L "$destination" ]] || ln -s "$path" "$destination"
    done
}

mkdir -p "$HOME/.pi/agent" "$HOME/.config/herdr" "$HOME/.config/opencode"
link_tree "$root/pi" "$HOME/.pi/agent"
link_tree "$root/herdr" "$HOME/.config/herdr"
link_tree "$root/opencode" "$HOME/.config/opencode"

# Remove stale herdr agent definition symlinks from global pi discovery
# These were previously linked from pi/skills/herdr-* and pi/extensions/herdr-*
shopt -s nullglob
for stale in "$HOME/.pi/agent/skills"/herdr-* "$HOME/.pi/agent/extensions"/herdr-*; do
    [ -L "$stale" ] && rm "$stale"
done
shopt -u nullglob
