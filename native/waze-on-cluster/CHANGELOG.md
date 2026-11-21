# Changelog

## Unreleased

A head unit that is short of CPU can run the map at a lower frame rate:
`target_fps` and `picture_fps` can be set in
`/var/opt/waze-on-cluster/features.conf` (README, "A lower frame rate").
Without them nothing changes.

## 0.11.0

CarPlay's cluster map patch is applied in CarPlay's memory each time it
starts, and `/usr/bin/carplay` stays as it ships: no write of the system
partition to patch, remove or recover it. Updating from an earlier version
puts the original file back and keeps the map, with at most one head-unit
restart; where CarPlay already runs the earlier patch, none.

## 0.10.12

The diagnostic journal is kept in memory and written to storage only around
failures and at shutdown, which greatly reduces writes to the head unit's
storage.

