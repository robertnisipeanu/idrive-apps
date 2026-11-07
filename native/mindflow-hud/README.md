# mindflow-hud

The HUD map service (prototype). What it shows, how it works and the known issues:
[`apps/robertn_hud_map`](../../apps/robertn_hud_map/README.md).

| File | |
|---|---|
| `store_supervisor.js` | runs `service.js`, restarts it after a crash or a missed heartbeat |
| `service.js` | settings socket (`/dev/shm/mindflow-hud/control.sock`), position and guidance feeds from the app |
| `map_feed.js` | the car's fix (BMW `Positioning`) as the renderer's feed; BMW's map-matched location without GNSS |
| `runtime.js`, `scene.js`, `kernel.js`, `labels.js`, `settings.js` | the HUD scene: roads, labels, turn panel, through `cluster_render_client.js` |
| `roads.js` | Mapbox Streets vector tiles around the car (`mapbox.json`: the public token) |
| `cameras.js`, `camera_regions.js` | fixed speed cameras from OpenStreetMap |
| `net_route.js`, `net_broker.js` | outbound HTTPS from uid 5000 (`hmi_5000`): the Store gives root no internet |
| `vendor/` | npm modules, installed as `node_modules/` (component.json) |

Node 8 (the unit's): no `https.get(url, options, callback)`, no optional chaining.
