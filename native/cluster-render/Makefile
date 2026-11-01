# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu

# cluster-render: the one service that draws on the instrument cluster and
# the HUD for every app (README.md), and kit/, the pixel path it shares with
# producers that prepare frames: the 4:2:0 YUV atlas, dirty-tile planning,
# 4x4 packed fast-motion blocks, SIMD conversion and rounding, upload
# pacing, the frame clock and the map-area geometry.
#
#   make test                 every host test: the kit, slot arbitration, the
#                             RAMSES console reader, the upload governor, the
#                             stack, layers and compositor
#                             on a fake renderer, the service over its socket
#                             with the C++ client, and the Node client
#   make test-kit             the kit's tests alone (for producers that link it)
#   make test-x86             the C++ tests built and run with the unit's
#                             toolchain in Docker (x86-64: the SSE2 paths)
#   make test-kit-x86         the kit's alone, likewise
#   make target               head-unit binaries in build/target, built in
#                             Docker (Ubuntu 18.04 amd64: gcc 7.5, glibc 2.27,
#                             the unit's libstdc++ ABI): cluster-render, which
#                             starts the service of the unit's generation,
#                             cluster-render-idrive7 against stubs of the
#                             unit's libramses 19 and libvsomeip3 and
#                             cluster-render-idrive8 against a stub of
#                             iDrive 8's libramses 27, every import checked
#   make test-ramses ROOTFS=… every layer kind built by the unit's own libramses
#   make test-ramses27 ROOTFS=…  the same on an iDrive 8 unit's libramses 27

CXX     ?= c++
NODE    ?= node
PYTHON  ?= python3
BUILD   ?= build
IMAGE    = cluster-render-build        # the unit's toolchain ABI (docker/Dockerfile)

CXXFLAGS = -std=c++14 -O2 -g -Wall -Wextra -Werror
HOSTINC  = -Ikit -Iinclude -I. -Isrc -isystem dcsm/third_party/vsomeip/interface
CPPFLAGS = $(HOSTINC) -Iabi/include
CPPFLAGS27 = $(HOSTINC) -isystem abi/include/ramses27   # RAMSES 27.0.116's own headers (abi/ABI27.md)

# component.json's version, compiled into the binary for its log file.
VERSION := $(shell sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' component.json)

RAMSES_SONAME = libramses-shared-lib-wayland-ivi-egl-es-3-0.so.19.0
RAMSES27_SONAME = libramses-shared-lib-wayland-ivi-egl-es-3-0.so.27.0
T = $(BUILD)/target
H = $(BUILD)/host

KIT_SRC  = kit/dirty_tiles.cpp kit/yuv_atlas.cpp kit/block_pack.cpp
CORE_SRC = src/slots.cpp src/governor.cpp src/stack.cpp src/layer.cpp src/video_layer.cpp src/mesh_layer.cpp \
           src/asset.cpp src/compositor.cpp \
           src/server.cpp src/service.cpp src/dcsm2_port.cpp src/dcsm27_port.cpp src/ramses_console.cpp \
           client/protocol.cpp src/log.cpp
CORE_H   = $(wildcard src/*.h kit/*.h include/cluster_render/*.h)
UNIT_SRC = src/main.cpp src/unit_idrive7.cpp src/graph_ramses19.cpp src/dcsm2_link.cpp src/config.cpp dcsm/dcsm_client.cpp
UNIT8_SRC = src/main.cpp src/unit_idrive8.cpp src/graph_ramses27.cpp src/config.cpp
LAUNCH_SRC = src/main.cpp src/launch.cpp src/generation.cpp src/config.cpp client/protocol.cpp src/log.cpp
CLIENT_SRC = client/client.cpp client/protocol.cpp

.PHONY: all test test-cpp test-js test-kit test-x86 test-kit-x86 target target-in-docker test-ramses test-ramses27 clean

all: test

test: test-kit test-cpp test-js

test-cpp: $(H)/log_test $(H)/slots_test $(H)/governor_test $(H)/compositor_test $(H)/service_test $(H)/dcsm2_port_test \
		$(H)/ramses_console_test $(H)/dcsm27_port_test $(H)/generation_test
	$(H)/log_test
	$(H)/slots_test
	$(H)/ramses_console_test
	$(H)/governor_test
	$(H)/compositor_test
	$(H)/dcsm2_port_test
	$(H)/dcsm27_port_test
	$(H)/generation_test
	$(H)/service_test

test-js: $(H)/host_service
	$(NODE) js/test/client_test.js $(H)/host_service

test-kit: $(H)/map_upload_test $(H)/yuv_atlas_test $(H)/frame_clock_test $(H)/block_pack_test
	$(H)/map_upload_test
	$(H)/yuv_atlas_test
	$(H)/frame_clock_test
	$(H)/block_pack_test

test-x86:
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/cluster-render" -w /w/cluster-render $(IMAGE) \
		make -s BUILD=$(BUILD)/x86 CXX=g++ test-kit test-cpp

test-kit-x86:
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/cluster-render" -w /w/cluster-render $(IMAGE) \
		make -s BUILD=$(BUILD)/x86 CXX=g++ test-kit

# ---- host tests -------------------------------------------------------------
$(H)/log_test: test/log_test.cpp src/log.cpp src/log.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/log_test.cpp src/log.cpp -lpthread

$(H)/slots_test: test/slots_test.cpp src/slots.cpp src/slots.h src/governor.cpp src/governor.h src/log.cpp
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/slots_test.cpp src/slots.cpp src/governor.cpp src/log.cpp -lpthread

$(H)/ramses_console_test: test/ramses_console_test.cpp src/ramses_console.cpp src/ramses_console.h src/log.cpp
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/ramses_console_test.cpp src/ramses_console.cpp src/log.cpp -lpthread

$(H)/governor_test: test/governor_test.cpp src/governor.cpp src/governor.h src/log.cpp
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/governor_test.cpp src/governor.cpp src/log.cpp -lpthread

$(H)/compositor_test: test/compositor_test.cpp test/fake_graph.h $(CORE_SRC) $(KIT_SRC) $(CORE_H)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/compositor_test.cpp $(CORE_SRC) $(KIT_SRC) -lpthread

$(H)/dcsm2_port_test: test/dcsm2_port_test.cpp src/dcsm2_port.cpp src/slots.cpp src/governor.cpp src/log.cpp \
		$(CORE_H)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/dcsm2_port_test.cpp src/dcsm2_port.cpp src/slots.cpp src/governor.cpp \
		src/log.cpp -lpthread

$(H)/dcsm27_port_test: test/dcsm27_port_test.cpp src/dcsm27_port.cpp src/slots.cpp src/governor.cpp src/log.cpp \
		$(CORE_H)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/dcsm27_port_test.cpp src/dcsm27_port.cpp src/slots.cpp src/governor.cpp \
		src/log.cpp -lpthread

$(H)/generation_test: test/generation_test.cpp src/generation.cpp src/generation.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/generation_test.cpp src/generation.cpp

$(H)/service_test: test/service_test.cpp test/fake_graph.h test/fake_port.h $(CORE_SRC) $(KIT_SRC) client/client.cpp \
		$(CORE_H)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/service_test.cpp $(CORE_SRC) $(KIT_SRC) client/client.cpp -lpthread

$(H)/host_service: test/host_service.cpp test/fake_graph.h test/fake_port.h $(CORE_SRC) $(KIT_SRC) $(CORE_H)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(HOSTINC) -o $@ test/host_service.cpp $(CORE_SRC) $(KIT_SRC) -lpthread

$(H)/map_upload_test: test/map_upload_test.cpp kit/map_geometry.cpp kit/map_geometry.h \
		kit/dirty_tiles.cpp kit/dirty_tiles.h kit/upload_pacer.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Ikit -o $@ test/map_upload_test.cpp kit/map_geometry.cpp kit/dirty_tiles.cpp

$(H)/yuv_atlas_test: test/yuv_atlas_test.cpp kit/yuv_atlas.cpp kit/yuv_atlas.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Ikit -o $@ test/yuv_atlas_test.cpp kit/yuv_atlas.cpp

$(H)/block_pack_test: test/block_pack_test.cpp kit/block_pack.cpp kit/block_pack.h kit/yuv_atlas.cpp \
		kit/yuv_atlas.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Ikit -o $@ test/block_pack_test.cpp kit/block_pack.cpp kit/yuv_atlas.cpp -lpthread

$(H)/frame_clock_test: test/frame_clock_test.cpp kit/frame_clock.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Ikit -o $@ test/frame_clock_test.cpp

# ---- target binary (in Docker) ----------------------------------------------
target:
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/cluster-render" -w /w/cluster-render $(IMAGE) \
		make -s BUILD=$(BUILD) target-in-docker

target-in-docker: $(T)/cluster-render $(T)/cluster-render-idrive7 $(T)/cluster-render-idrive8 \
	$(T)/libcluster_render_client.a

$(T)/stub/$(RAMSES_SONAME): abi/libramses19.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/ramses_stub.c
	gcc -shared -Wl,-soname,$(RAMSES_SONAME) -o $@ $(@D)/ramses_stub.c

$(T)/stub/$(RAMSES27_SONAME): abi/libramses27.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/ramses27_stub.c
	gcc -shared -Wl,-soname,$(RAMSES27_SONAME) -o $@ $(@D)/ramses27_stub.c

$(T)/stub/libvsomeip3.so.3: dcsm/abi/libvsomeip3.so.3.symbols
	mkdir -p $(@D)
	$(PYTHON) dcsm/tools/abi.py stub $< $(@D)/vsomeip_stub.S
	g++ -shared -nostdlib -Wl,-soname,libvsomeip3.so.3 -o $@ $(@D)/vsomeip_stub.S

STUBS = $(T)/stub/$(RAMSES_SONAME) $(T)/stub/libvsomeip3.so.3

# Starts the service of the unit's generation (src/unit.h): needs neither
# libramses.
$(T)/cluster-render: $(LAUNCH_SRC) $(CORE_H)
	mkdir -p $(@D)
	g++ $(CXXFLAGS) $(HOSTINC) -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread -o $@ $(LAUNCH_SRC)
	$(PYTHON) tools/ramses_abi.py check-imports $@ abi/libramses19.symbols

$(T)/cluster-render-idrive7: $(CORE_SRC) $(KIT_SRC) $(UNIT_SRC) $(CORE_H) $(STUBS) component.json
	g++ $(CXXFLAGS) $(CPPFLAGS) -DCR_VERSION='"$(VERSION)"' -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread \
		-o $@ $(CORE_SRC) $(KIT_SRC) $(UNIT_SRC) $(STUBS)
	$(PYTHON) tools/ramses_abi.py check-imports $@ abi/libramses19.symbols
	$(PYTHON) dcsm/tools/abi.py check $@ dcsm/abi/libvsomeip3.so.3.symbols

$(T)/cluster-render-idrive8: $(CORE_SRC) $(KIT_SRC) $(UNIT8_SRC) $(CORE_H) $(T)/stub/$(RAMSES27_SONAME) component.json
	g++ $(CXXFLAGS) $(CPPFLAGS27) -DCR_VERSION='"$(VERSION)"' -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread \
		-o $@ $(CORE_SRC) $(KIT_SRC) $(UNIT8_SRC) $(T)/stub/$(RAMSES27_SONAME)
	$(PYTHON) tools/ramses_abi.py check-imports $@ abi/libramses27.symbols

# Every layer kind on the unit's own libramses (TCP, no renderer).
test-ramses:
	@test -n "$(ROOTFS)" || { echo "set ROOTFS to a copy of the unit's root filesystem"; exit 2; }
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/cluster-render" \
		-v "$(ROOTFS):/rootfs:ro" -w /w/cluster-render $(IMAGE) \
		sh -c 'make -s BUILD=$(BUILD) $(T)/ramses_check && \
		/rootfs/lib/ld-linux-x86-64.so.2 --library-path /rootfs/lib:/rootfs/usr/lib $(T)/ramses_check \
		> $(T)/ramses_check.log 2>&1; rc=$$?; grep -v "Info " $(T)/ramses_check.log; \
		if grep -q "\[ Error \]" $(T)/ramses_check.log; then echo "FAIL libramses logged errors"; exit 1; fi; exit $$rc'

$(T)/ramses_check: test/ramses_check.cpp test/fake_port.h src/graph_ramses19.cpp $(CORE_SRC) $(KIT_SRC) $(CORE_H) \
		$(T)/stub/$(RAMSES_SONAME)
	g++ $(CXXFLAGS) $(CPPFLAGS) -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread -o $@ test/ramses_check.cpp \
		src/graph_ramses19.cpp $(CORE_SRC) $(KIT_SRC) $(T)/stub/$(RAMSES_SONAME)

# The same on iDrive 8's libramses 27 (TCP, no renderer).
test-ramses27:
	@test -n "$(ROOTFS)" || { echo "set ROOTFS to a copy of an iDrive 8 unit's root filesystem"; exit 2; }
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/cluster-render" \
		-v "$(ROOTFS):/rootfs:ro" -w /w/cluster-render $(IMAGE) \
		sh -c 'make -s BUILD=$(BUILD) $(T)/ramses_check27 && \
		/rootfs/lib/ld-linux-x86-64.so.2 --library-path /rootfs/lib:/rootfs/usr/lib $(T)/ramses_check27 \
		> $(T)/ramses_check27.log 2>&1; rc=$$?; grep -v "Info " $(T)/ramses_check27.log; \
		if grep -q "\[ Error \]" $(T)/ramses_check27.log; then echo "FAIL libramses logged errors"; exit 1; fi; exit $$rc'

$(T)/ramses_check27: test/ramses_check.cpp test/fake_port.h src/graph_ramses27.cpp $(CORE_SRC) $(KIT_SRC) $(CORE_H) \
		$(T)/stub/$(RAMSES27_SONAME)
	g++ $(CXXFLAGS) $(CPPFLAGS27) -DCRS_RAMSES27 -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -pthread -o $@ \
		test/ramses_check.cpp src/graph_ramses27.cpp $(CORE_SRC) $(KIT_SRC) $(T)/stub/$(RAMSES27_SONAME)

# The C++ client for native producers on the unit, as a static library.
$(T)/libcluster_render_client.a: $(CLIENT_SRC) include/cluster_render/client.h include/cluster_render/protocol.h
	mkdir -p $(T)/client
	g++ $(CXXFLAGS) -Iinclude -c client/client.cpp -o $(T)/client/client.o
	g++ $(CXXFLAGS) -Iinclude -c client/protocol.cpp -o $(T)/client/protocol.o
	ar rcs $@ $(T)/client/client.o $(T)/client/protocol.o

clean:
	rm -rf $(BUILD)
