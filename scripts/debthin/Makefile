# Makefile for debthin package index pipeline.
# Orchestrates fetch → filter → headless → sign → validate → upload.
#
# Usage:
#   make -j8                       # full parallel build
#   make filter                    # just filter (fetches as needed)
#   make sign-debian/bookworm      # sign a single release
#   make NO_UPLOAD=1               # build without uploading
#
# All targets are config-driven: suite/arch/component combinations are
# parsed dynamically from config.json via jq.

ROOT_DIR  := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
CONFIG    := $(ROOT_DIR)/config.json
SCRIPTS   := $(ROOT_DIR)/scripts/debthin
CACHE     := $(ROOT_DIR)/.tmp_cache
OUTPUT    := $(ROOT_DIR)/dist_output

GPG_KEY_ID  ?= C2564E8797299A499FCABFE052BBA2F43AEC90C5
NO_UPLOAD   ?= 0
R2_ACCOUNT_ID ?=
R2_ACCESS_KEY ?=
R2_SECRET_KEY ?=
R2_BUCKET     ?= debthin

export CONFIG_FILE := $(CONFIG)

PYTHON_CMD := $(ROOT_DIR)/.venv/bin/python3

BUILT_AT := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Dynamic target generation from config.json ───────────────────────────────
#
# Distro/suite pairs use slash-delimited single tokens (debian/bookworm)
# which work correctly with $(foreach).

# Distro/suite pairs for filter, headless, and sign targets
DISTRO_SUITES := $(shell jq -r ' \
  to_entries[] | .key as $$d | \
  (.value.upstream // .value.upstream_archive // .value.upstream_ports // null) as $$up | \
  if $$up == null then empty else \
    .value.suites | keys[] | "\($$d)/\(.)" \
  end \
' $(CONFIG))

# ── Phony targets ────────────────────────────────────────────────────────────

.PHONY: all fetch filter headless sign validate upload stage clean
.PHONY: $(addprefix filter-,$(DISTRO_SUITES))
.PHONY: $(addprefix headless-,$(DISTRO_SUITES))
.PHONY: $(addprefix sign-,$(DISTRO_SUITES))

# Default target: full pipeline
all: upload

# ── Virtual Environment ──────────────────────────────────────────────────────

VENV_MARKER := $(ROOT_DIR)/.venv/.installed

$(VENV_MARKER): $(ROOT_DIR)/requirements.txt
	@echo "Establishing isolated virtual environment..." >&2
	@python3 -m venv $(ROOT_DIR)/.venv
	@$(ROOT_DIR)/.venv/bin/pip install -r $(ROOT_DIR)/requirements.txt >/dev/null 2>&1
	@touch $(VENV_MARKER)

# ── Phase 1: Fetch ───────────────────────────────────────────────────────────
# Fetch all upstream Packages.gz and InRelease files natively across multithreads.

PARALLEL ?= 8

fetch: $(VENV_MARKER)
	@echo "Phase 1: fetching upstream indexes (parallel=$(PARALLEL))..." >&2
	@$(PYTHON_CMD) $(SCRIPTS)/fetch.py $(CONFIG) --parallel $(PARALLEL)

# ── Phase 2: Filter ─────────────────────────────────────────────────────────
# Apply allowlist filtering per distro/suite.
# Each filter-distro/suite is an independent target parallelised by make -j.

FILTER_TARGETS := $(addprefix filter-,$(DISTRO_SUITES))

filter: $(FILTER_TARGETS)

$(FILTER_TARGETS): filter-%: fetch
	@$(PYTHON_CMD) $(SCRIPTS)/filter.py $(subst /, ,$*)

# ── Phase 2.5: Headless ─────────────────────────────────────────────────────
# Merge components + updates into deduplicated headless suites.

HEADLESS_TARGETS := $(addprefix headless-,$(DISTRO_SUITES))

headless: $(HEADLESS_TARGETS)

$(HEADLESS_TARGETS): headless-%: filter-%
	@bash $(SCRIPTS)/headless.sh $(subst /, ,$*)

# ── Phase 3: Sign ────────────────────────────────────────────────────────────
# Generate Release files and GPG-sign per distro/suite.

sign: headless
	@echo "Phase 3: signing..." >&2
	@GPG_KEY_ID=$(GPG_KEY_ID) $(PYTHON_CMD) $(SCRIPTS)/sign_all.py $(OUTPUT) $(CONFIG)

# Per-release signing targets (parallel-safe, no file overlap)
$(addprefix sign-,$(DISTRO_SUITES)): sign-%: headless
	@GPG_KEY_ID=$(GPG_KEY_ID) $(PYTHON_CMD) $(SCRIPTS)/sign_all.py $(OUTPUT) $(CONFIG)

# ── Phase 4: Stage ───────────────────────────────────────────────────────────
# Copy static assets into dist_output and clean up.

stage: sign
	@echo "Staging static assets..." >&2
	@cp $(ROOT_DIR)/static/index.html           $(OUTPUT)/
	@cp $(ROOT_DIR)/static/favicon.ico           $(OUTPUT)/
	@cp $(CONFIG)                                $(OUTPUT)/
	@cp $(ROOT_DIR)/static/debthin-keyring.gpg   $(OUTPUT)/
	@cp $(ROOT_DIR)/static/debthin-keyring-binary.gpg $(OUTPUT)/
	@find $(OUTPUT) -name "Packages" -not -name "*.gz" -delete

# ── Phase 5: Validate ───────────────────────────────────────────────────────
# Hard gate: must pass before any upload proceeds.

validate: stage
	@echo "Validating dist_output/..." >&2
	@$(PYTHON_CMD) $(SCRIPTS)/validate.py $(OUTPUT) \
		--json $(OUTPUT)/status.json \
		--cache-dir $(CACHE) \
		--built-at "$(BUILT_AT)" \
		--duration-seconds 0

# ── Phase 6: Upload ─────────────────────────────────────────────────────────
# Upload to R2. Gated behind validation.

upload: validate
ifeq ($(NO_UPLOAD),1)
	@echo "Skipping Cloudflare R2 upload (NO_UPLOAD=1)." >&2
else
	@echo "Uploading to Cloudflare R2..." >&2
	@$(PYTHON_CMD) $(SCRIPTS)/r2_upload.py \
		--dir $(OUTPUT) \
		--account "$(R2_ACCOUNT_ID)" \
		--access-key "$(R2_ACCESS_KEY)" \
		--secret-key "$(R2_SECRET_KEY)" \
		--bucket "$(R2_BUCKET)"
endif

# ── Cleanup ──────────────────────────────────────────────────────────────────

clean:
	rm -rf $(CACHE) $(OUTPUT)
