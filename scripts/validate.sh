#!/usr/bin/env bash
# validate.sh - Sanity-check dist_output/ before upload
# Usage: bash scripts/validate.sh [dist_output]

DIST_OUTPUT="${1:-dist_output}"
ERRORS=0
WARNINGS=0

pass() { echo "  OK   $*"; }
info() { echo "  INFO $*"; }
warn() { echo "  WARN $*"; WARNINGS=$((WARNINGS+1)); }
fail() { echo "  FAIL $*"; ERRORS=$((ERRORS+1)); }

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
    elif [[ $(stat -c%s "$f") -lt $min_size ]]; then
        fail "too small ($(stat -c%s "$f") bytes): $f"
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
        [[ "$rel_path" != *".gz" ]] && continue

        local full_path="$suite_dir$rel_path"
        if [[ ! -f "$full_path" ]]; then
            fail "InRelease references missing file: $rel_path"
            continue
        fi
        local actual_hash actual_size
        actual_hash=$(sha256sum "$full_path" | cut -d' ' -f1)
        actual_size=$(stat -c%s "$full_path")
        if [[ "$actual_hash" != "$expect_hash" ]]; then
            fail "SHA256 mismatch: $rel_path"
        elif [[ "$actual_size" != "$expect_size" ]]; then
            fail "size mismatch: $rel_path (expected $expect_size got $actual_size)"
        fi
    done < "$inrelease"
}

# ── Static files ──────────────────────────────────────────────────────────────

echo "=== Static files ==="
check_file "$DIST_OUTPUT/index.html" 1000
check_file "$DIST_OUTPUT/debthin-keyring.gpg" 100
check_file "$DIST_OUTPUT/debthin-keyring-binary.gpg" 100

# ── Per-distro checks ─────────────────────────────────────────────────────────

for distro_dir in "$DIST_OUTPUT"/*/dists; do
    [[ -d "$distro_dir" ]] || continue
    distro=$(basename "$(dirname "$distro_dir")")

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
    IFS=$'
' arches=($(echo "${arches[*]}" | tr ' ' '
' | sort)); unset IFS

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
    for family in $(echo "${!family_total[@]}" | tr ' ' '
' | sort); do
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
done

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
