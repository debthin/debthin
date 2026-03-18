#!/usr/bin/env bash
# validate.sh - Sanity-check dist_output/ before upload
# Usage: bash scripts/validate.sh [dist_output] [--json path/to/status.json] [--cache-dir cached] [--built-at ISO8601] [--duration-seconds N]
DIST_OUTPUT="${1:-dist_output}"
ERRORS=0
WARNINGS=0
JSON_OUT=""
CACHE_DIR=""
BUILT_AT=""
DURATION_SECONDS=""
shift || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --json)             JSON_OUT="$2";          shift 2 ;;
        --cache-dir)        CACHE_DIR="$2";         shift 2 ;;
        --built-at)         BUILT_AT="$2";          shift 2 ;;
        --duration-seconds) DURATION_SECONDS="$2";  shift 2 ;;
        *) shift ;;
    esac
done
[[ -z "$BUILT_AT" ]] && BUILT_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# JSON accumulator - we build this as we go, emit at the end
# Using temp files to accumulate per-suite JSON blobs
JSON_TMPDIR=""
[[ -n "$JSON_OUT" ]] && JSON_TMPDIR=$(mktemp -d)
pass() { echo "  OK   $*"; }
info() { echo "  INFO $*"; }
warn() { echo "  WARN $*"; WARNINGS=$((WARNINGS+1)); }
fail() { echo "  FAIL $*"; ERRORS=$((ERRORS+1)); }
# JSON string escape (handles the subset we'll encounter in apt metadata)
json_str() { printf '%s' "$1" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()), end='')"; }
# Extract a field value from an InRelease file
inrelease_field() { grep "^$2:" "$1" 2>/dev/null | head -1 | cut -d' ' -f2-; }
# Components where zero packages is an error vs expected
CRITICAL_COMPONENTS="main universe"
is_critical_component() {
    local component=$1
    local c
    for c in $CRITICAL_COMPONENTS; do
        [[ "$c" == "$component" ]] && return 0
    done
    return 1
}
# ── Helpers ───────────────────────────────────────────────────────────────────
check_file() {
    local f=$1 min_size=${2:-1}
    if [[ ! -f "$f" ]]; then
        fail "missing: $f"
    elif [[ ! -s "$f" ]]; then
        fail "empty: $f"
    elif [[ $(python3 -c "import os,sys; print(os.path.getsize(sys.argv[1]))" "$f") -lt $min_size ]]; then
        fail "too small ($(python3 -c "import os,sys; print(os.path.getsize(sys.argv[1]))" "$f") bytes): $f"
    else
        pass "$f"
    fi
}
check_inrelease() {
    local f=$1
    if [[ ! -f "$f" ]]; then
        fail "missing: $f"; return
    fi
    if ! grep -q "^-----BEGIN PGP SIGNED MESSAGE-----" "$f"; then
        fail "not GPG signed: $f"; return
    fi
    local ok=1
    for field in Origin Label Suite Codename Date Architectures Components SHA256; do
        if ! grep -q "^$field:" "$f"; then
            fail "missing field $field: $f"; ok=0
        fi
    done
    local hash_count
    hash_count=$(awk '/^SHA256:/{found=1; next} found && /^ /{count++} END{print count+0}' "$f")
    if [[ "$hash_count" -eq 0 ]]; then
        fail "empty SHA256 section: $f"; ok=0
    fi
    [[ $ok -eq 1 ]] && pass "$f ($hash_count hashes)"
}
check_packages_gz() {
    local f=$1
    # Derive component from path: .../dists/suite/component/binary-arch/Packages.gz
    local component
    component=$(basename "$(dirname "$(dirname "$f")")")
    if [[ ! -f "$f" ]]; then
        fail "missing: $f"; return
    fi
    if ! gunzip -t "$f" 2>/dev/null; then
        fail "corrupt gzip: $f"; return
    fi
    local count
    count=$(gunzip -c "$f" | grep -c "^Package:" || true)
    # Backports/proposed are legitimately empty - always INFO regardless of component
    local suite
    suite=$(basename "$(dirname "$(dirname "$(dirname "$f")")")")
    local is_backports=0
    [[ "$suite" == *-backports || "$suite" == *-proposed || "$suite" == *-security ]] && is_backports=1
    if [[ $count -eq 0 ]]; then
        if [[ $is_backports -eq 0 ]] && is_critical_component "$component"; then
            fail "zero packages in critical component: $f"
        else
            info "zero packages (expected for $suite/$component): $f"
        fi
    else
        pass "$f ($count packages)"
    fi
}
# Minimum total packages across all suites in a release family (e.g. noble*)
RELEASE_MIN_PACKAGES=1000
verify_inrelease_hashes() {
    local suite_dir=$1
    local inrelease="$suite_dir/InRelease"
    [[ -f "$inrelease" ]] || return
    while IFS= read -r line; do
        [[ "$line" =~ ^\ +([a-f0-9]{64})\ +([0-9]+)\ +(.+)$ ]] || continue
        local expect_hash="${BASH_REMATCH[1]}"
        local expect_size="${BASH_REMATCH[2]}"
        local rel_path="${BASH_REMATCH[3]}"
        [[ "$rel_path" == *"/by-hash/"* ]] && continue
        [[ "$rel_path" == *"/i18n/"* ]] && continue
        [[ "$rel_path" != *".gz" ]] && continue
        local full_path="$suite_dir$rel_path"
        if [[ ! -f "$full_path" ]]; then
            fail "InRelease references missing file: $rel_path"
            continue
        fi
        local actual_hash actual_size
        actual_hash=$(sha256sum "$full_path" | cut -d' ' -f1)
        actual_size=$(python3 -c "import os,sys; print(os.path.getsize(sys.argv[1]))" "$full_path")
        if [[ "$actual_hash" != "$expect_hash" ]]; then
            fail "SHA256 mismatch: $rel_path"
        elif [[ "$actual_size" != "$expect_size" ]]; then
            fail "size mismatch: $rel_path (expected $expect_size got $actual_size)"
        fi
    done < "$inrelease"
}
check_config_json() {
    local f=$1
    if [[ ! -f "$f" ]]; then
        fail "missing: $f"
        return
    fi
    if ! jq -e . "$f" >/dev/null 2>&1; then
        fail "invalid JSON: $f"
        return
    fi
    if ! jq -e '.debian.suites' "$f" >/dev/null 2>&1; then
        fail "missing .debian.suites: $f"
        return
    fi
    local stable_suite
    stable_suite=$(jq -r '.debian.suites | to_entries[] | select(.value.aliases and (.value.aliases | index("stable"))) | .key' "$f")
    if [[ -z "$stable_suite" ]]; then
        fail "no debian suite has 'stable' in aliases: $f"
        return
    fi
    pass "$f (JSON valid, stable suite: $stable_suite)"
}

# ── Static files ──────────────────────────────────────────────────────────────
echo "=== Static files ==="
check_file "$DIST_OUTPUT/index.html" 1000
check_file "$DIST_OUTPUT/debthin-keyring.gpg" 100
check_file "$DIST_OUTPUT/debthin-keyring-binary.gpg" 100
check_config_json "$DIST_OUTPUT/config.json"

# ── Per-distro checks ─────────────────────────────────────────────────────────
for distro_dir in "$DIST_OUTPUT"/dists/*; do
    [[ -d "$distro_dir" ]] || continue
    distro=$(basename "$distro_dir")
    echo ""
    echo "=== $distro ==="
    suite_count=0
    for suite_dir in "$distro_dir"/*/; do
        [[ -d "$suite_dir" ]] || continue
        suite=$(basename "$suite_dir")
        suite_count=$((suite_count+1))
        echo "  -- $suite --"
        check_inrelease "$suite_dir/InRelease"
        verify_inrelease_hashes "$suite_dir"
        pkg_count=0
        while IFS= read -r -d '' f; do
            check_packages_gz "$f"
            pkg_count=$((pkg_count+1))
        done < <(find "$suite_dir" -name "Packages.gz" -print0 | sort -z)
        if [[ $pkg_count -eq 0 ]]; then
            fail "no Packages.gz files found under $suite"
        fi
        # Extract suite metadata for JSON
        if [[ -n "$JSON_TMPDIR" && -f "$suite_dir/InRelease" ]]; then
            suite_date=$(inrelease_field "$suite_dir/InRelease" "Date")
            suite_version=$(inrelease_field "$suite_dir/InRelease" "Version")
            suite_errors_before=$ERRORS
            # We'll write the per-arch counts after the family table loop below
            # Store suite metadata in a temp file keyed by distro/suite
            mkdir -p "$JSON_TMPDIR/$distro"
            printf '%s\t%s' "$suite_date" "$suite_version" > "$JSON_TMPDIR/$distro/$suite.meta"
        fi
    done
    if [[ $suite_count -eq 0 ]]; then
        fail "no suites found under $distro_dir"
    else
        echo "  $suite_count suite(s) checked"
    fi
    # ── Release family totals ─────────────────────────────────────────────────
    echo ""
    echo "  Package counts by release family:"
    # family_arch[family/arch] = total count across all suites in family
    unset family_arch family_total arches
    declare -A family_arch
    declare -A family_total
    arches=()
    for suite_dir in "$distro_dir"/*/; do
        [[ -d "$suite_dir" ]] || continue
        suite=$(basename "$suite_dir")
        family="${suite%%-*}"
        while IFS= read -r -d '' f; do
            if [[ "$f" == */headless/* ]]; then continue; fi
            arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
            count=$(gunzip -c "$f" | grep -c "^Package:" || true)
            family_arch["$family/$arch"]=$(( ${family_arch["$family/$arch"]:-0} + count ))
            family_total["$family"]=$(( ${family_total["$family"]:-0} + count ))
            # Track unique arches
            found=0
            for a in "${arches[@]:-}"; do [[ "$a" == "$arch" ]] && found=1 && break; done
            [[ $found -eq 0 ]] && arches+=("$arch")
        done < <(find "$suite_dir" -name "Packages.gz" -print0 2>/dev/null)
    done
    # Sort arches
    IFS=$'\n' arches=($(echo "${arches[*]}" | tr ' ' '\n' | sort)); unset IFS
    # Column widths
    max_family=0
    for family in "${!family_total[@]}"; do
        [[ ${#family} -gt $max_family ]] && max_family=${#family}
    done
    # Header - match the "  pass/fail  family" prefix width
    header=$(printf "           %-${max_family}s" "")
    for arch in "${arches[@]}"; do
        header=$(printf "%s  %8s" "$header" "$arch")
    done
    header=$(printf "%s  %8s" "$header" "TOTAL")
    echo "$header"
    # One row per family
    for family in $(echo "${!family_total[@]}" | tr ' ' '\n' | sort); do
        row=$(printf "    %-${max_family}s" "$family")
        arch_fail=0
        for arch in "${arches[@]}"; do
            val="${family_arch["$family/$arch"]:-0}"
            row=$(printf "%s  %8d" "$row" "$val")
            # Only check arches that are present for this family
            if [[ -v "family_arch[$family/$arch]" && $val -lt $RELEASE_MIN_PACKAGES ]]; then
                arch_fail=1
            fi
        done
        total="${family_total[$family]}"
        row=$(printf "%s  %8d" "$row" "$total")
        if [[ $arch_fail -eq 1 ]]; then
            fail "$row  (an arch is below threshold of $RELEASE_MIN_PACKAGES)"
        else
            pass "$row"
        fi
    done
    # ── Per-suite JSON emission ───────────────────────────────────────────────
    if [[ -n "$JSON_TMPDIR" ]]; then
        # Collect upstream counts from cache if available
        unset upstream_suite_arch
        declare -A upstream_suite_arch
        if [[ -n "$CACHE_DIR" && -d "$CACHE_DIR/$distro" ]]; then
            while IFS= read -r -d '' f; do
                rel_path="${f#$CACHE_DIR/$distro/}"
                suite="${rel_path%%/*}"
                arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
                ucount=$(gunzip -c "$f" 2>/dev/null | grep -c "^Package:" || true)
                upstream_suite_arch["$suite/$arch"]=$(( ${upstream_suite_arch["$suite/$arch"]:-0} + ucount ))
            done < <(find "$CACHE_DIR/$distro" -name "Packages.gz" -print0 2>/dev/null)
        fi
        # Build per-suite JSON blobs
        # suite_arch[suite/arch] was collected in family_arch but keyed by family (suite prefix)
        # Re-collect per actual suite for JSON accuracy
        unset suite_arch_json
        declare -A suite_arch_json
        for suite_dir in "$distro_dir"/*/; do
            [[ -d "$suite_dir" ]] || continue
            suite=$(basename "$suite_dir")
            while IFS= read -r -d '' f; do
                if [[ "$f" == */headless/* ]]; then continue; fi
                arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
                count=$(gunzip -c "$f" 2>/dev/null | grep -c "^Package:" || true)
                suite_arch_json["$suite/$arch"]=$(( ${suite_arch_json["$suite/$arch"]:-0} + count ))
            done < <(find "$suite_dir" -name "Packages.gz" -print0 2>/dev/null)
        done
        # Write distro JSON file
        {
            echo "{"
            first_suite=1
            for suite_dir in "$distro_dir"/*/; do
                [[ -d "$suite_dir" ]] || continue
                suite=$(basename "$suite_dir")
                [[ $first_suite -eq 0 ]] && echo ","
                first_suite=0
                suite_date=""
                suite_version=""
                if [[ -f "$JSON_TMPDIR/$distro/$suite.meta" ]]; then
                    IFS=$'\t' read -r suite_date suite_version < "$JSON_TMPDIR/$distro/$suite.meta"
                fi
                suite_errors=0
                # Count errors that are suite-specific (approximation: we track global ERRORS)
                # Valid flag is best-effort: no new errors during this suite's check
                printf '  %s: {' "$(json_str "$suite")"
                printf '"date": %s, ' "$(json_str "$suite_date")"
                [[ -n "$suite_version" ]] && printf '"version": %s, ' "$(json_str "$suite_version")"
                printf '"packages": {'
                first_arch=1
                for arch in "${arches[@]}"; do
                    key="$suite/$arch"
                    [[ -v "suite_arch_json[$key]" ]] || continue
                    count="${suite_arch_json[$key]}"
                    [[ $first_arch -eq 0 ]] && printf ', '
                    first_arch=0
                    printf '"%s": {"count": %d' "$arch" "$count"
                    if [[ -n "${upstream_suite_arch[$key]:-}" && ${upstream_suite_arch[$key]} -gt 0 ]]; then
                        upstream=${upstream_suite_arch[$key]}
                        printf ', "upstream_count": %d' "$upstream"
                    fi
                    printf '}'
                done
                printf '}}'
            done
            echo ""
            echo "}"
        } > "$JSON_TMPDIR/$distro.json"
    fi
done
# ── Assemble status.json ──────────────────────────────────────────────────────
if [[ -n "$JSON_OUT" && -n "$JSON_TMPDIR" ]]; then
    {
        printf '{\n'
        printf '  "built_at": %s,\n' "$(json_str "$BUILT_AT")"
        [[ -n "$DURATION_SECONDS" ]] && printf '  "duration_seconds": %d,\n' "$DURATION_SECONDS"
        printf '  "valid": %s,\n' "$( [[ $ERRORS -eq 0 ]] && echo true || echo false )"
        printf '  "errors": %d,\n' "$ERRORS"
        printf '  "warnings": %d,\n' "$WARNINGS"
        printf '  "distros": {\n'
        first_distro=1
        for distro_json in "$JSON_TMPDIR"/*.json; do
            [[ -f "$distro_json" ]] || continue
            distro_name=$(basename "$distro_json" .json)
            [[ $first_distro -eq 0 ]] && printf ',\n'
            first_distro=0
            printf '    %s: {"suites": ' "$(json_str "$distro_name")"
            cat "$distro_json"
            printf '}'
        done
        printf '\n  }\n}\n'
    } > "$JSON_OUT"
    echo "  Wrote $JSON_OUT"
    rm -rf "$JSON_TMPDIR"
fi
# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo "  Errors:   $ERRORS"
echo "  Warnings: $WARNINGS"
if [[ $ERRORS -gt 0 ]]; then
    echo "FAILED"
    exit 1
else
    echo "PASSED"
fi
