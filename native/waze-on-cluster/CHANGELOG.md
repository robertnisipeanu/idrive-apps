# Changelog

## Unreleased

`hud_black_background` is saved in `map.state.conf` and changed live by the
render's `{"cmd":"hud","hud_black_background":"0"|"1"}` and patchd's
`{"cmd":"hud-black-background","on":0|1}`, per driver profile; the render's
status carries it. Changed, the newest picture is scaled again at once.

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

