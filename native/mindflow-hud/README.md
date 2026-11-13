# HUD map service

Road tiles, phone maneuver guidance, destination capture, inferred route geometry and HUD rendering.
See [the app documentation](../../apps/robertn_hud_map/README.md) for behavior and limitations.

`component.json` lists the complete installed payload, including the standalone native destination reader.
The reader needs no Python runtime. Build instructions, tests and library provenance are in [DESTINATION-READER.md](DESTINATION-READER.md); bundled libraries retain their license notices.
Private routing credentials and captured car data are not part of this source package.

## Validation

Run from the repository root:

```sh
node native/mindflow-hud/test/navigation_display_test.js
node native/mindflow-hud/test/navigation_state_test.js
node native/mindflow-hud/test/navigation_progress_test.js
node release/release.js check mindflow-hud robertn_hud_map
```

`test/route_mismatch_sim_test.js` is a closed-loop missed-turn simulation (simulated phone, Vela, GPS error and renderer; about 2 minutes). Run one case with `node native/mindflow-hud/test/route_mismatch_sim_test.js zigzag --noise typical --hz 5 --trace`; `urban` GPS error is a stress level that only fails with `--strict`.

The release check builds committed HEAD twice. The app uses `package/` and requires `mindflow-hud: next`;
release stamping resolves that dependency to the actual native release version. Both new components start at 0.6.26.

Outbound DNS uses `/run/mgu-uplink/lease.json`. Route responses allow at most 16 MiB decoded JSON and 8 MiB compressed data. Portuguese postal-code queries must match the returned country and postcode; postcode coordinates represent an area, not a doorstep.

Map width and height adjust independently from 25-200% in 5% steps. Width expands symmetrically around the car arrow; height stretches only the area above it. The existing overall size and position controls still apply, and the turn panel remains independently positioned.

Use Adjusting: Street text to move the next-turn street name or change its font size. Street text On/Off and box width/height have dedicated controls. The box is bottom-right anchored; extra lines grow upward in reading order. Width is 25-200% of 300 px, height is 75-300% of 60 px, and font size is 50-200% of 15 px. Names exceeding the box end with an ellipsis. These controls do not affect map road labels.

Current street box: On/Off controls the name beneath the position arrow independently from next-turn street text. It defaults to On.

Automatic destination text searches cities/localities as well as addresses and streets. Exact city-name matches are ranked by distance; automatic text candidates beyond 1500 km are rejected (explicit coordinates remain supported). This guard can reject legitimate long-distance trips and does not prove a nearby candidate is correct.

When a full route is missing or mismatches phone guidance, the renderer uses loaded roads for a short inferred cyan line. It matches heading and upcoming turn direction/distance, preferring the named outgoing road when available. It stops at ambiguity, shows up to 100 m after a matched turn, respects available one-way/level metadata, and requires fresh phone guidance. Missing tiles, ambiguous roads, roundabout exits and U-turns can prevent outgoing geometry. Tile geometry does not encode every legal turn restriction; phone guidance remains authoritative.

Turn and street panels are constrained to a 40 px inset of the 800x480 canvas. Centre uses the selected panel dimensions to centre it at (400,240). Existing saved offsets are retained where in bounds; Reset display settings applies the new inward defaults. Physical HUD cropping may differ from the canvas.
