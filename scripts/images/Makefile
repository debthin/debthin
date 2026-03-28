# Makefile for debthin container image pipeline.
# Orchestrates build → prune → manifest → upload.
#
# Usage:
#   make -j$(nproc)              # full parallel build + upload
#   make build                   # build all targets only
#   make NO_UPLOAD=1             # build + manifest without uploading
#
# Targets are config-driven: distro/suite/arch combinations parsed
# from config.json, filtered by existing YAML templates.

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
CONFIG_FILE := $(ROOT_DIR)/config.json
SCRIPTS  := $(ROOT_DIR)/scripts/images
OUTPUT   := $(ROOT_DIR)/images_output

NO_UPLOAD     ?= 0
R2_ACCOUNT_ID ?=
R2_ACCESS_KEY ?=
R2_SECRET_KEY ?=
FORCE         ?= 0
TMPFS_SIZE    ?= 288M

# Parse target combinations dynamically from the repository config
RAW_TARGETS := $(shell jq -r ' \
  ( \
    .debian | .arches as $$def | .suites | to_entries[] | \
    .key as $$s | (.value.arches // $$def)[] | "debian/\($$s)/\(.)" \
  ), \
  ( \
    .ubuntu | ["amd64", "arm64"] as $$arch | .suites | to_entries[] | \
    .key as $$s | $$arch[] | "ubuntu/\($$s)/\(.)" \
  ), \
  ( \
    .raspbian | .arches as $$def | .suites | to_entries[] | \
    .key as $$s | (.value.arches // $$def)[] | "raspbian/\($$s)/\(.)" \
  ) \
' $(CONFIG_FILE))

# Filter to targets with a matching build profile (distro/suite or distro/suite.arch)
PROFILES_DIR := $(SCRIPTS)/build-profiles
TARGETS := $(foreach t,$(RAW_TARGETS),$(if $(or \
  $(wildcard $(PROFILES_DIR)/$(word 1,$(subst /, ,$(t)))/$(word 2,$(subst /, ,$(t)))),\
  $(wildcard $(PROFILES_DIR)/$(word 1,$(subst /, ,$(t)))/$(word 2,$(subst /, ,$(t))).$(word 3,$(subst /, ,$(t))))\
),$(t)))

# Split targets into native-arch (run first) and cross-arch (run after).
# Native builds populate caches (ca-certificates etc.) that cross-arch reuses.
HOST_ARCH := $(shell dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
NATIVE_TARGETS := $(foreach t,$(TARGETS),$(if $(filter $(HOST_ARCH),$(word 3,$(subst /, ,$(t)))),$(t)))
CROSS_TARGETS  := $(filter-out $(NATIVE_TARGETS),$(TARGETS))

# Daily build stamp (YYYYMMDD)
export BUILD_DATE := $(shell date +%Y%m%d)
export FORCE
export TMPFS_SIZE

.PHONY: all build build-native build-cross prune manifest upload clean $(TARGETS)

# Default: full pipeline
all: upload

# ── Phase 1: Build ───────────────────────────────────────────────────────────
# Native-arch targets run first (populates ca-certs cache etc.), then cross-arch.

build: build-native build-cross
	@echo ""
	@echo "==========================================="
	@echo " Build complete"
	@echo " Images in: $(OUTPUT)/images"
	@echo "==========================================="

build-native: $(NATIVE_TARGETS)

build-cross: build-native $(CROSS_TARGETS)

$(TARGETS):
	@./build-image.sh $@

# ── Phase 2: Prune ───────────────────────────────────────────────────────────
# Keep only the 5 most recent version directories per distro/suite/arch.

KEEP_VERSIONS ?= 5

prune: build
	@echo "Pruning old builds (keeping $(KEEP_VERSIONS) per target)..." >&2
	@find $(OUTPUT)/images -mindepth 5 -maxdepth 5 -type d | \
		sort | \
		awk -F/ '{ key=$$1; for(i=2;i<=NF-1;i++) key=key"/"$$i; a[key]=a[key]" "$$0 } \
		END { for(k in a) { n=split(a[k],dirs," "); \
			if(n > $(KEEP_VERSIONS)) { \
				for(i=1; i<=n-$(KEEP_VERSIONS); i++) \
					print dirs[i] } } }' | \
		while read -r d; do echo "  pruning $$d" >&2; rm -rf "$$d"; done

# ── Phase 3: Manifest ───────────────────────────────────────────────────────
# Generate registry-state.json from the remaining image tree.

manifest: prune
	@echo "Generating registry-state.json..." >&2
	@python3 $(SCRIPTS)/generate_image_manifest.py --dir $(OUTPUT)

# ── Phase 4: Upload ─────────────────────────────────────────────────────────
# Upload image files, static assets, and manifest to R2.

upload: manifest
ifeq ($(NO_UPLOAD),1)
	@echo "Skipping R2 upload (NO_UPLOAD=1)." >&2
else
	@echo "Uploading to R2..." >&2
	@python3 $(SCRIPTS)/r2_upload_images.py \
		--dir $(OUTPUT) \
		--account "$(R2_ACCOUNT_ID)" \
		--access-key "$(R2_ACCESS_KEY)" \
		--secret-key "$(R2_SECRET_KEY)"
endif

# ── Cleanup ──────────────────────────────────────────────────────────────────

clean:
	rm -rf $(ROOT_DIR)/.build_tmp $(OUTPUT)
