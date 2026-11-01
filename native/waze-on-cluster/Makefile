# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# waze-on-cluster. See README.md.
#
#   make test                 host build + NAL, RTP, receive queue and catch-up, backlog, stream health,
#                             keyframe wait, the map feed
#                             against the shared renderer, the kit's tests, patcher,
#                             patchd patch/install activation/DLT, capture and
#                             boot-recovery tests
#   make test-x86             the C++ host tests built and run with the unit's toolchain
#                             in Docker (x86-64: the SSE2 paths against their scalar twins)
#   make test-firmware ROOTFS=<dir>
#                             DLT capture against the firmware's own dlt-daemon,
#                             libdlt, dlt-receive and /etc/dlt.conf, in Docker
#   make target               head-unit binary build/target/waze-on-cluster,
#                             built in Docker (Ubuntu 18.04 amd64: gcc 7.5,
#                             glibc 2.27, the unit's libstdc++ ABI), linked
#                             against stubs of the unit's libmfxhw64, libva,
#                             libva-drm and the IAS AVB bridge, every import
#                             checked
#
# The map is drawn by the shared cluster renderer (CR, ../cluster-render),
# whose client and kit are compiled in, and whose tree holds the log, the
# config, the unit's ABI tools and the build image this build uses.

CXX     ?= c++
NODE    ?= node
PYTHON  ?= python3
BUILD   ?= build
IMAGE    = cluster-render-build        # the unit's toolchain ABI

CR      ?= ../cluster-render
KIT      = $(CR)/kit
CXXFLAGS = -std=c++14 -O2 -g -Wall -Wextra -Werror
CPPFLAGS = -I. -Isrc -I$(KIT) -I$(CR)/include -Iabi/include -I$(CR)/src

T = $(BUILD)/target

# component.json's version, compiled into the binary for its log file.
VERSION := $(shell sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' component.json)

# The capture, decode and map feed (own files), the kit's atlas, packing and
# geometry, and the shared renderer's client.
WOC_SRC = src/main.cpp src/video_producer.cpp src/freeze_watch.cpp src/alt_screen.cpp src/map_feed.cpp src/control.cpp src/h264_source.cpp \
          src/udp_source.cpp src/avb_source.cpp src/framing_probe.cpp src/rtp_h264.cpp \
          src/decoder_msdk.cpp src/nal_reader.cpp src/stream_health.cpp $(KIT)/map_geometry.cpp $(KIT)/yuv_atlas.cpp \
          $(KIT)/block_pack.cpp
CR_SRC  = $(CR)/client/client.cpp $(CR)/client/protocol.cpp
SRC     = $(WOC_SRC) $(CR_SRC) $(CR)/src/config.cpp $(CR)/src/log.cpp

.PHONY: all test test-cpp test-x86 test-firmware target target-in-docker clean

all: test

# ---- host tests (no unit libraries) ---------------------------------------
test: test-cpp
	$(NODE) patch/test/locate_test.js
	$(NODE) patch/test/patch_test.js
	$(NODE) patch/test/patchd_patch_test.js
	$(NODE) patch/test/patchd_activate_test.js
	$(NODE) patch/test/patchd_resync_test.js
	$(NODE) patch/test/patchd_dlt_test.js
	$(NODE) patch/test/dlt_capture_test.js
	$(NODE) patch/test/recovery_test.js

test-cpp: $(BUILD)/host/nal_reader_test $(BUILD)/host/rtp_h264_test $(BUILD)/host/udp_probe_test \
		$(BUILD)/host/map_feed_test $(BUILD)/host/keyframe_wait_test $(BUILD)/host/freeze_watch_test \
		$(BUILD)/host/alt_screen_test $(BUILD)/host/packet_queue_test $(BUILD)/host/backlog_test \
		$(BUILD)/host/stream_health_test
	$(BUILD)/host/nal_reader_test
	$(BUILD)/host/rtp_h264_test test/data/stream15_start.rtp
	$(BUILD)/host/udp_probe_test
	$(BUILD)/host/map_feed_test
	$(BUILD)/host/keyframe_wait_test
	$(BUILD)/host/freeze_watch_test
	$(BUILD)/host/alt_screen_test
	$(BUILD)/host/packet_queue_test
	$(BUILD)/host/backlog_test
	$(BUILD)/host/stream_health_test
	$(MAKE) -C $(CR) test-kit BUILD=$(abspath $(BUILD))/kit

test-x86:
	docker build -q --platform linux/amd64 -t $(IMAGE) $(CR)/docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w" -v "$(abspath $(CR)):/cr" -w /w $(IMAGE) \
		make -s BUILD=$(BUILD)/x86 CR=/cr CXX=g++ test-cpp

test-firmware:
	@test -n "$(ROOTFS)" || { echo "set ROOTFS (a copy of the unit's root file system)"; exit 2; }
	sh patch/test/firmware/run.sh "$(ROOTFS)"

$(BUILD)/host/nal_reader_test: test/nal_reader_test.cpp src/nal_reader.cpp src/nal_reader.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/nal_reader_test.cpp src/nal_reader.cpp

$(BUILD)/host/rtp_h264_test: test/rtp_h264_test.cpp src/rtp_h264.cpp src/rtp_h264.h src/gap_settler.h src/nal_reader.cpp src/nal_reader.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/rtp_h264_test.cpp src/rtp_h264.cpp src/nal_reader.cpp

$(BUILD)/host/udp_probe_test: test/udp_probe_test.cpp src/udp_source.cpp src/udp_source.h \
		src/framing_probe.cpp src/framing_probe.h $(CR)/src/log.cpp
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -I$(CR)/src -o $@ test/udp_probe_test.cpp src/udp_source.cpp src/framing_probe.cpp $(CR)/src/log.cpp -lpthread

# The map feed against the shared renderer's service on fake display
# backends, over its socket: every service source but the units' backends,
# the starter and its main.
CR_CORE = $(filter-out $(addprefix $(CR)/src/,main.cpp graph_ramses19.cpp dcsm2_link.cpp config.cpp log.cpp \
                         unit_idrive7.cpp unit_idrive8.cpp graph_ramses27.cpp launch.cpp generation.cpp), \
          $(wildcard $(CR)/src/*.cpp)) $(wildcard $(KIT)/*.cpp)
$(BUILD)/host/map_feed_test: test/map_feed_test.cpp src/map_feed.cpp src/map_feed.h $(CR_CORE) $(CR_SRC) \
		$(CR)/src/log.cpp $(wildcard $(CR)/src/*.h $(CR)/include/cluster_render/*.h $(CR)/test/*.h)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -I$(KIT) -I$(CR)/include -I$(CR) -I$(CR)/src -isystem $(CR)/dcsm/third_party/vsomeip/interface \
		-o $@ test/map_feed_test.cpp src/map_feed.cpp $(filter-out $(CR)/client/protocol.cpp,$(CR_CORE)) $(CR_SRC) \
		$(CR)/src/log.cpp -lpthread

$(BUILD)/host/keyframe_wait_test: test/keyframe_wait_test.cpp src/keyframe_wait.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/keyframe_wait_test.cpp

$(BUILD)/host/freeze_watch_test: test/freeze_watch_test.cpp src/freeze_watch.cpp src/freeze_watch.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/freeze_watch_test.cpp src/freeze_watch.cpp

$(BUILD)/host/alt_screen_test: test/alt_screen_test.cpp src/alt_screen.cpp src/alt_screen.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/alt_screen_test.cpp src/alt_screen.cpp

$(BUILD)/host/packet_queue_test: test/packet_queue_test.cpp src/packet_queue.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/packet_queue_test.cpp -lpthread

$(BUILD)/host/backlog_test: test/backlog_test.cpp src/backlog.h $(KIT)/frame_clock.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -I$(KIT) -o $@ test/backlog_test.cpp

$(BUILD)/host/stream_health_test: test/stream_health_test.cpp src/stream_health.cpp src/stream_health.h $(CR)/src/log.cpp
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -I$(CR)/src -o $@ test/stream_health_test.cpp src/stream_health.cpp $(CR)/src/log.cpp -lpthread

# ---- target binary (in Docker) --------------------------------------------
target:
	docker build -q --platform linux/amd64 -t $(IMAGE) $(CR)/docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w" -v "$(abspath $(CR)):/cr" -w /w $(IMAGE) \
		make -s BUILD=$(BUILD) CR=/cr target-in-docker

target-in-docker: $(T)/waze-on-cluster

# Link-only stubs exporting the unit libraries' symbols. Each carries the real
# SONAME, so the binary records the right DT_NEEDED.
$(T)/stub/libmfxhw64.so: abi/libmfx.symbols
	mkdir -p $(@D)
	$(PYTHON) $(CR)/tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	gcc -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c

$(T)/stub/libva.so.1: abi/libva.symbols
	mkdir -p $(@D)
	$(PYTHON) $(CR)/tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	gcc -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c

$(T)/stub/libva-drm.so.1: abi/libva-drm.symbols
	mkdir -p $(@D)
	$(PYTHON) $(CR)/tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	gcc -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

$(T)/stub/libias-media_transport-avb_ufipc_bridge.so.1: abi/libias_avb.symbols
	mkdir -p $(@D)
	$(PYTHON) $(CR)/tools/ramses_abi.py stub-source $< > $(@D)/ias_avb_stub.c
	gcc -shared -Wl,-soname,libias-media_transport-avb_ufipc_bridge.so.1 -o $@ $(@D)/ias_avb_stub.c

STUBS = $(T)/stub/libmfxhw64.so $(T)/stub/libva.so.1 $(T)/stub/libva-drm.so.1 \
        $(T)/stub/libias-media_transport-avb_ufipc_bridge.so.1

$(T)/waze-on-cluster: $(SRC) $(STUBS) component.json
	g++ $(CXXFLAGS) $(CPPFLAGS) -DWOC_VERSION='"$(VERSION)"' -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread \
		-o $@ $(SRC) $(STUBS)
	$(PYTHON) $(CR)/dcsm/tools/abi.py check $@ $(CR)/dcsm/abi/libvsomeip3.so.3.symbols   # loader, glibc/libstdc++ limits
	$(PYTHON) tools/woc_abi.py check-imports $@ --prefix MFX va ias_ -- \
		abi/libmfx.symbols abi/libva.symbols abi/libva-drm.symbols abi/libias_avb.symbols

clean:
	rm -rf $(BUILD)
