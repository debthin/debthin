#!/usr/bin/env bash
# validate.sh - Sanity-check dist_output/ before upload
# Usage: bash scripts/debthin/validate.sh [dist_output] [--json path/to/status.json] [--cache-dir cached] [--built-at ISO8601] [--duration-seconds N]
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
json_str() { jq -R -r '@json' <<< "$1"; }
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
    elif [[ $(( $(wc -c < "$f") )) -lt $min_size ]]; then
        fail "too small ($(( $(wc -c < "$f") )) bytes): $f"
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
# Cache for package counts keyed by filepath.
# Populated on first decompression, reused for family totals and JSON.
declare -A PKG_COUNTS

check_packages_gz() {
    local f=$1
    local component
    component=$(basename "$(dirname "$(dirname "$f")")")    
    if [[ ! -f "$f" ]]; then
        fail "missing: $f"; return
    fi
    # Single decompression: validate gzip integrity AND count packages
    local count
    count=$(gunzip -c "$f" 2>/dev/null | grep -c "^Package:" || true)
    if [[ -z "$count" ]]; then
        fail "corrupt gzip: $f"; return
    fi
    PKG_COUNTS["$f"]=$count
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
        actual_size=$(( $(wc -c < "$full_path") ))
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

# ── Per-distro validation (parallel) ──────────────────────────────────────────
# Each distro runs in a subshell writing output to a temp file.
# Error/warning counts are written to sidecar files for aggregation.

RESULT_DIR=$(mktemp -d)

validate_distro() {
    local distro_dir=$1
    local distro=$(basename "$distro_dir")
    local out="$RESULT_DIR/$distro.out"
    local errors=0 warnings=0

    # Local versions of pass/fail/warn that count locally
    _pass() { echo "  OK   $*"; }
    _info() { echo "  INFO $*"; }
    _warn() { echo "  WARN $*"; warnings=$((warnings+1)); }
    _fail() { echo "  FAIL $*"; errors=$((errors+1)); }

    {
        echo ""
        echo "=== $distro ==="
        local suite_count=0

        # Per-file package count cache (local to this subshell)
        declare -A _PKG_COUNTS

        for suite_dir in "$distro_dir"/*/; do
            [[ -d "$suite_dir" ]] || continue
            local suite=$(basename "$suite_dir")
            suite_count=$((suite_count+1))
            echo "  -- $suite --"

            # InRelease checks
            local f="$suite_dir/InRelease"
            if [[ ! -f "$f" ]]; then
                _fail "missing: $f"
            elif ! grep -q "^-----BEGIN PGP SIGNED MESSAGE-----" "$f"; then
                _fail "not GPG signed: $f"
            else
                local ok=1
                for field in Origin Label Suite Codename Date Architectures Components SHA256; do
                    if ! grep -q "^$field:" "$f"; then
                        _fail "missing field $field: $f"; ok=0
                    fi
                done
                local hash_count
                hash_count=$(awk '/^SHA256:/{found=1; next} found && /^ /{count++} END{print count+0}' "$f")
                if [[ "$hash_count" -eq 0 ]]; then
                    _fail "empty SHA256 section: $f"; ok=0
                fi
                [[ $ok -eq 1 ]] && _pass "$f ($hash_count hashes)"
            fi

            # InRelease hash verification
            if [[ -f "$suite_dir/InRelease" ]]; then
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
                        _fail "InRelease references missing file: $rel_path"
                        continue
                    fi
                    local actual_hash actual_size
                    actual_hash=$(sha256sum "$full_path" | cut -d' ' -f1)
                    actual_size=$(( $(wc -c < "$full_path") ))
                    if [[ "$actual_hash" != "$expect_hash" ]]; then
                        _fail "SHA256 mismatch: $rel_path"
                    elif [[ "$actual_size" != "$expect_size" ]]; then
                        _fail "size mismatch: $rel_path (expected $expect_size got $actual_size)"
                    fi
                done < "$suite_dir/InRelease"
            fi

            # Packages.gz checks (single decompression per file)
            local pkg_count=0
            while IFS= read -r -d '' pf; do
                pkg_count=$((pkg_count+1))
                if [[ ! -f "$pf" ]]; then
                    _fail "missing: $pf"; continue
                fi
                local count
                count=$(gunzip -c "$pf" 2>/dev/null | grep -c "^Package:" || true)
                if [[ -z "$count" ]]; then
                    _fail "corrupt gzip: $pf"; continue
                fi
                _PKG_COUNTS["$pf"]=$count
                local component
                component=$(basename "$(dirname "$(dirname "$pf")")")
                local s
                s=$(basename "$(dirname "$(dirname "$(dirname "$pf")")")")
                local is_backports=0
                [[ "$s" == *-backports || "$s" == *-proposed || "$s" == *-security ]] && is_backports=1
                if [[ $count -eq 0 ]]; then
                    if [[ $is_backports -eq 0 ]] && is_critical_component "$component"; then
                        _fail "zero packages in critical component: $pf"
                    else
                        _info "zero packages (expected for $s/$component): $pf"
                    fi
                else
                    _pass "$pf ($count packages)"
                fi
            done < <(find "$suite_dir" -name "Packages.gz" -print0 | sort -z)
            if [[ $pkg_count -eq 0 ]]; then
                _fail "no Packages.gz files found under $suite"
            fi

            # ── Required packages check ───────────────────────────────────────
            # Verify that packages listed in required_packages/ are present
            # in the generated Packages.gz for this suite.
            local repo_root
            repo_root=$(cd "$DIST_OUTPUT/.." && pwd)
            local req_file=""
            if [[ -f "$repo_root/required_packages/$distro/$suite.txt" ]]; then
                req_file="$repo_root/required_packages/$distro/$suite.txt"
            elif [[ -f "$repo_root/required_packages/$distro.txt" ]]; then
                req_file="$repo_root/required_packages/$distro.txt"
            fi

            if [[ -n "$req_file" ]]; then
                # Build a set of all packages available across all main arches
                local all_available
                all_available=$(find "$suite_dir" -path "*/main/binary-*/Packages.gz" -print0 | \
                    xargs -0 -I{} sh -c 'gunzip -c "$1" 2>/dev/null' _ {} | \
                    grep "^Package: " | sed 's/^Package: //' | sort -u)

                local req_missing=0
                while IFS= read -r pkg; do
                    [[ -z "$pkg" || "$pkg" == \#* ]] && continue
                    if ! echo "$all_available" | grep -qx "$pkg"; then
                        _fail "required package '$pkg' missing from $suite Packages.gz (from $req_file)"
                        req_missing=$((req_missing+1))
                    fi
                done < "$req_file"
                if [[ $req_missing -eq 0 ]]; then
                    _pass "all required packages present for $suite ($(grep -cv '^\(#\|$\)' "$req_file") checked)"
                fi
            fi

            # Suite metadata for JSON
            if [[ -n "$JSON_TMPDIR" && -f "$suite_dir/InRelease" ]]; then
                local suite_date suite_version
                suite_date=$(inrelease_field "$suite_dir/InRelease" "Date")
                suite_version=$(inrelease_field "$suite_dir/InRelease" "Version")
                mkdir -p "$JSON_TMPDIR/$distro"
                printf '%s\t%s' "$suite_date" "$suite_version" > "$JSON_TMPDIR/$distro/$suite.meta"
            fi
        done

        if [[ $suite_count -eq 0 ]]; then
            _fail "no suites found under $distro_dir"
        else
            echo "  $suite_count suite(s) checked"
        fi

        # ── Release family totals ─────────────────────────────────────────────
        echo ""
        echo "  Package counts by release family:"
        declare -A family_arch family_total
        local arches=()
        for suite_dir in "$distro_dir"/*/; do
            [[ -d "$suite_dir" ]] || continue
            local suite=$(basename "$suite_dir")
            local family="${suite%%-*}"
            while IFS= read -r -d '' pf; do
                if [[ "$pf" == */headless/* ]]; then continue; fi
                local arch
                arch=$(basename "$(dirname "$pf")" | sed 's/binary-//')
                local count=${_PKG_COUNTS["$pf"]:-0}
                family_arch["$family/$arch"]=$(( ${family_arch["$family/$arch"]:-0} + count ))
                family_total["$family"]=$(( ${family_total["$family"]:-0} + count ))
                local found=0
                for a in "${arches[@]:-}"; do [[ "$a" == "$arch" ]] && found=1 && break; done
                [[ $found -eq 0 ]] && arches+=("$arch")
            done < <(find "$suite_dir" -name "Packages.gz" -print0 2>/dev/null)
        done
        IFS=$'\n' arches=($(echo "${arches[*]}" | tr ' ' '\n' | sort)); unset IFS
        local max_family=0
        for family in "${!family_total[@]}"; do
            [[ ${#family} -gt $max_family ]] && max_family=${#family}
        done
        local header
        header=$(printf "           %-${max_family}s" "")
        for arch in "${arches[@]}"; do
            header=$(printf "%s  %8s" "$header" "$arch")
        done
        header=$(printf "%s  %8s" "$header" "TOTAL")
        echo "$header"
        for family in $(echo "${!family_total[@]}" | tr ' ' '\n' | sort); do
            local row
            row=$(printf "    %-${max_family}s" "$family")
            local arch_fail=0
            for arch in "${arches[@]}"; do
                local val="${family_arch["$family/$arch"]:-0}"
                row=$(printf "%s  %8d" "$row" "$val")
                if [[ -v "family_arch[$family/$arch]" && $val -lt $RELEASE_MIN_PACKAGES ]]; then
                    arch_fail=1
                fi
            done
            local total="${family_total[$family]}"
            row=$(printf "%s  %8d" "$row" "$total")
            if [[ $arch_fail -eq 1 ]]; then
                _fail "$row  (an arch is below threshold of $RELEASE_MIN_PACKAGES)"
            else
                _pass "$row"
            fi
        done

        # ── Per-suite JSON emission ───────────────────────────────────────────
        if [[ -n "$JSON_TMPDIR" ]]; then
            declare -A upstream_suite_arch
            if [[ -n "$CACHE_DIR" && -d "$CACHE_DIR/$distro" ]]; then
                while IFS= read -r -d '' pf; do
                    local rel_path="${pf#$CACHE_DIR/$distro/}"
                    local suite="${rel_path%%/*}"
                    local arch
                    arch=$(basename "$(dirname "$pf")" | sed 's/binary-//')
                    local count_file="${pf%.gz}.count"
                    local ucount
                    if [[ -f "$count_file" ]]; then
                        ucount=$(<"$count_file")
                    else
                        ucount=$(gunzip -c "$pf" 2>/dev/null | grep -c "^Package:" || echo 0)
                    fi
                    upstream_suite_arch["$suite/$arch"]=$(( ${upstream_suite_arch["$suite/$arch"]:-0} + ucount ))
                done < <(find "$CACHE_DIR/$distro" -name "Packages.gz" -print0 2>/dev/null)
            fi
            declare -A suite_arch_json
            for suite_dir in "$distro_dir"/*/; do
                [[ -d "$suite_dir" ]] || continue
                local suite=$(basename "$suite_dir")
                while IFS= read -r -d '' pf; do
                    if [[ "$pf" == */headless/* ]]; then continue; fi
                    local arch
                    arch=$(basename "$(dirname "$pf")" | sed 's/binary-//')
                    local count=${_PKG_COUNTS["$pf"]:-0}
                    suite_arch_json["$suite/$arch"]=$(( ${suite_arch_json["$suite/$arch"]:-0} + count ))
                done < <(find "$suite_dir" -name "Packages.gz" -print0 2>/dev/null)
            done
            {
                echo "{"
                local first_suite=1
                for suite_dir in "$distro_dir"/*/; do
                    [[ -d "$suite_dir" ]] || continue
                    local suite=$(basename "$suite_dir")
                    [[ $first_suite -eq 0 ]] && echo ","
                    first_suite=0
                    local suite_date="" suite_version=""
                    if [[ -f "$JSON_TMPDIR/$distro/$suite.meta" ]]; then
                        IFS=$'\t' read -r suite_date suite_version < "$JSON_TMPDIR/$distro/$suite.meta"
                    fi
                    printf '  %s: {' "$(json_str "$suite")"
                    printf '"date": %s, ' "$(json_str "$suite_date")"
                    [[ -n "$suite_version" ]] && printf '"version": %s, ' "$(json_str "$suite_version")"
                    printf '"packages": {'
                    local first_arch=1
                    for arch in "${arches[@]}"; do
                        local key="$suite/$arch"
                        [[ -v "suite_arch_json[$key]" ]] || continue
                        local count="${suite_arch_json[$key]}"
                        [[ $first_arch -eq 0 ]] && printf ', '
                        first_arch=0
                        printf '"%s": {"count": %d' "$arch" "$count"
                        if [[ -n "${upstream_suite_arch[$key]:-}" && ${upstream_suite_arch[$key]} -gt 0 ]]; then
                            printf ', "upstream_count": %d' "${upstream_suite_arch[$key]}"
                        fi
                        printf '}'
                    done
                    printf '}}'
                done
                echo ""
                echo "}"
            } > "$JSON_TMPDIR/$distro.json"
        fi
    } > "$out" 2>&1

    # Write error/warning counts for parent to aggregate
    echo "$errors"   > "$RESULT_DIR/$distro.errors"
    echo "$warnings" > "$RESULT_DIR/$distro.warnings"
}

# Launch all distro validations in parallel
PIDS=()
for distro_dir in "$DIST_OUTPUT"/dists/*; do
    [[ -d "$distro_dir" ]] || continue
    validate_distro "$distro_dir" &
    PIDS+=($!)
done

# Wait for all and collect exit codes
WAIT_FAIL=0
for pid in "${PIDS[@]}"; do
    wait "$pid" || WAIT_FAIL=1
done

# Dump buffered output sequentially and aggregate counts
for distro_dir in "$DIST_OUTPUT"/dists/*; do
    [[ -d "$distro_dir" ]] || continue
    distro=$(basename "$distro_dir")
    [[ -f "$RESULT_DIR/$distro.out" ]] && cat "$RESULT_DIR/$distro.out"
    ERRORS=$(( ERRORS + $(<"$RESULT_DIR/$distro.errors") ))
    WARNINGS=$(( WARNINGS + $(<"$RESULT_DIR/$distro.warnings") ))
done
rm -rf "$RESULT_DIR"
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
