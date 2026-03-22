ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
CONFIG_FILE := $(ROOT_DIR)/config.json

# Parse target combinations dynamically from the repository config
TARGETS := $(shell jq -r ' \
  ( \
    .debian | .arches as $$def | .suites | to_entries[] | \
    .key as $$s | (.value.arches // $$def)[] | "debian/\($$s)/\(.)" \
  ), \
  ( \
    .ubuntu | (.archive_arches + .ports_arches) as $$arch | .suites | to_entries[] | \
    .key as $$s | $$arch[] | "ubuntu/\($$s)/\(.)" \
  ), \
  ( \
    .raspbian | .arches as $$def | .suites | to_entries[] | \
    .key as $$s | (.value.arches // $$def)[] | "raspbian/\($$s)/\(.)" \
  ) \
' $(CONFIG_FILE))

# Uniformly stamp all built containers within the executing pool sequence
export BUILD_DATE := $(shell date +%Y%m%d_%H%M)

.PHONY: all clean $(TARGETS)

all: $(TARGETS)
	@echo ""
	@echo "==========================================="
	@echo " Build Run Complete!"
	@echo " Images generated in: $(ROOT_DIR)/images_output/images"
	@echo "==========================================="

# Route target paths straight to the single-thread builder wrapper
$(TARGETS):
	@./build.sh $@

clean:
	rm -rf $(ROOT_DIR)/.build_tmp
