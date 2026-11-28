// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "keys.h"

void define_keys(cld::Config *cfg)
{
    cfg->define("fifo_path", "/run/waze-on-cluster/alt.h264");
    cfg->define("carplay_group", "video");
    cfg->define("udp_port", "20557");
    cfg->define("avb_stream", "media_transport.avb_streaming.15");
    cfg->define("drm_device", "/dev/dri/renderD128");
    cfg->define("tex_size", "1088x480");
    cfg->define("src_crop", "");
    cfg->define("map_rect", "");
    cfg->define("dirty_threshold", "8");
    cfg->define("dirty_settle_ms", "1000");
    cfg->define("stall_ms", "6000");
    cfg->define("idle_ms", "60000");
    cfg->define("freeze_ms", "10000");
    cfg->define("freeze_min_fps", "3");
    cfg->define("blank_ms", "10000");
    cfg->define("alt_screen_port", "6031");
    cfg->define("alt_screen_uid", "13002");
    cfg->define("target_fps", "30");
    cfg->define("picture_fps", "0");
    cfg->define("pan_blocks", "1");
    cfg->define("tex_level_bits", "2");
    cfg->define("gpu_copy", "1");
    cfg->define("hosted_vpp_scale", "0");
    cfg->define("always_packed", "0");
    cfg->define("hide_bmw_guidance", "1");
    cfg->define("turn_card", "off");
    cfg->define("turn_card_state_file", "/var/opt/waze-on-cluster/state/turn-card.state.conf");
    /* The turn card's manoeuvres from the navigation's route box
     * (guidance_link.h); 0: the app's example only. */
    cfg->define("guidance", "1");
    cfg->define("state_file", "/var/opt/waze-on-cluster/state/waze-on-cluster.state.conf");
    cfg->define("map_state_file", "/var/opt/waze-on-cluster/map.state.conf");
    cfg->define("features_file", "/var/opt/waze-on-cluster/features.conf");
    cfg->define("cluster", "1");
    cfg->define("hud", "0");
    cfg->define("hud_fps", "10");
    cfg->define("hud_width_pct", "0");
    cfg->define("hud_offset_x", "0");
    cfg->define("hud_offset_y", "0");
    cfg->define("hud_keep_shown", "0");
    cfg->define("hud_scale_down", "1");
    cfg->define("hud_round_corners", "1");
    cfg->define("hud_black_background", "1");
    cfg->define("render_socket", "/dev/shm/cluster-render/render.sock");
    cfg->define("log_file", "/var/opt/waze-on-cluster/log/waze-on-cluster.log");
    cfg->define("log_file_kb", "512");
}
