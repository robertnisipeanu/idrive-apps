#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# shutdown_mark.sh — run by var-opt-ro.service (drop-in
# 50-waze-on-cluster.conf) at each head-unit shutdown, before /var/opt goes
# read-only. recmgr's reboot after a crash and a switch-off are both an NSM
# fast shutdown that stops no service, so carplay's state at that moment tells them apart
# for boot recovery (recovery.js): it writes "<boot id> running|failed|stopped"
# to <state dir>/shutdown. failed is a Result other than success. It writes
# nothing when carplay's state cannot be read, and always exits 0.
DIR=${WOC_STATE_DIR:-/var/opt/waze-on-cluster}
BOOT_ID=${WOC_BOOT_ID:-/proc/sys/kernel/random/boot_id}
SYSTEMCTL=${WOC_SYSTEMCTL:-systemctl}

[ -d "$DIR" ] || exit 0
boot=$(cat "$BOOT_ID" 2>/dev/null) || exit 0
show=$("$SYSTEMCTL" show carplay.service -p ActiveState -p Result 2>/dev/null) || exit 0
case "$show" in
  *Result=success*)
    case "$show" in
      *ActiveState=active*|*ActiveState=activating*|*ActiveState=reloading*) state=running ;;
      *) state=stopped ;;
    esac ;;
  *Result=*) state=failed ;;
  *) exit 0 ;;
esac
printf '%s %s\n' "$boot" "$state" > "$DIR/shutdown.tmp" && mv -f "$DIR/shutdown.tmp" "$DIR/shutdown"
exit 0
