# HUD map (prototype)

A clean road map on the BMW head-up display: the streets around the car, drawn in perspective over the road, with
street names, speed camera points and the car's own position. It is rendered on the head unit through
[cluster-render](../../native/cluster-render), so it sits in the HUD next to BMW's own speed readout, speed limit and
assist icons, which keep showing as before.

![The HUD map on the road](docs/hud-photos.png)

*Four photos from the driver's seat at night. The photos were heavily denoised; the HUD itself looks sharper.*

### More photos and videos

More photos from the car:

![The HUD map on the road](https://github.com/user-attachments/assets/c11b3abf-9749-4a10-b6e7-bc62819fdd7e)
![The HUD map on the road](https://github.com/user-attachments/assets/05ebd69c-ce94-47df-a005-f25fa88bfe4d)
![The HUD map on the road](https://github.com/user-attachments/assets/6a7f8c52-4434-4e38-8680-a4d52330d329)

Videos from the driver's seat. They open in the browser: GitHub plays videos inline only in issues and pull
requests, not in files like this one.

- [Video 1](https://github.com/user-attachments/assets/6fa58a4a-5cb2-4a51-b8ae-4a8932183d87)
- [Video 2](https://github.com/user-attachments/assets/bf8d6595-37d4-4793-89fb-b4f7f7898d25)
- [Video 3](https://github.com/user-attachments/assets/fad76b84-9017-4ef1-9498-51e3c0ac606b)

This is a **prototype**: it runs on the car it was developed on (iDrive 7 MGU, P18_23w44.2-1-3) and needs more work
before it is a finished app. See [Known issues](#known-issues).

| Component | |
|---|---|
| [`native/mindflow-hud`](../../native/mindflow-hud) | the HUD map service: road tiles, the HUD scene, camera points |
| `apps/robertn_hud_map` | the iDrive app: settings page (size, position, zoom, horizon, road brightness, camera warnings), and the feed of the car's position and turn guidance to the service |

## Why

The goal was a HUD map that is very clean and looks as close to native as possible. Showing Google Maps or Waze
themselves on the HUD (overlaying and masking their picture) never got there: the result always looked busy and
distracting on a HUD. Drawing our own map from vector road data gives thin, bright road lines on black, which a HUD
shows as floating lines over the road, and nothing else.

Placing the car on such a map from the phone's picture (tracking the position of Google Maps' or Waze's arrow) was also
tried; nothing worked as well as having real geometry to draw.

## How it works

Position and maneuver guidance come from published SOME/IP interfaces. Destination capture additionally reads
`aapd` through a bounded, firmware-specific native reader; see the route section below.

1. **Car position.** The app subscribes to BMW navigation's `Positioning` interface: `rawPositionData` (the GNSS fix:
   position, heading, fix type, UTC time) and `currentLocation` (BMW's own map-matched, dead-reckoned position). Without
   a satellite fix (garage, tunnel) the map follows `currentLocation`, so it shows at once when the car starts.
2. **Map.** The service downloads Mapbox Streets vector tiles around the car and ahead of it (Node 8 on the unit, no
   browser), and draws the roads as a perspective scene, oriented to the direction of travel, with the current road's
   name and the names of the streets ahead. The scene goes to cluster-render's HUD target, at most one geometry update
   per part per second (the renderer's limit), with an automatic retry if the renderer ever refuses a frame.
3. **Turn guidance.** When Android Auto navigates, `aapd` converts Google Maps' maneuvers into BMW guidance events and
   pushes them into BMW navigation. BMW's own HUD reads them from the `GuidanceEventList` view `HUD.RB.Main`. The app
   reads the same list, read-only (`getViewConfig`, then `queryContent` every 500 ms like the HUD), and the service
   draws the next maneuver: turn arrow, roundabout exit, distance and road. The HUD map and BMW's own HUD guidance
   share one HUD display slot, so while the map shows, the turn guidance has to come from us.
4. **Network.** The Store refuses internet access for root, so the service, which stays root, opens its HTTPS
   connections through a small helper running as `hmi_5000` (uid 5000, the tool's `"uids"`), and gets the connected
   sockets back.

### Destination capture and route geometry

Active phone guidance starts bounded destination capture. The bundled reader validates the supported `aapd`
binary fingerprint, observes its navigation callback using hardware breakpoints, and records address text.
This is firmware-specific process instrumentation, not a published BMW destination interface. An unsupported
binary cannot provide automatic destination capture. Destination reading starts automatically;
the reader returns only destination text over a bounded pipe, without recording or exporting diagnostic logs.

The captured address is geocoded with Mapbox, using the first result, then Vela's Google web-route approach
returns candidate geometry. This does not use the Google Routes API. The fastest candidate is selected initially.
Once the vehicle moves, repeated disagreement with the phone's upcoming maneuver triggers correction. Phone
turns remain authoritative; conflicting geometry is clipped, completed streets are removed, and local street
prediction remains available when a complete route cannot be established. Ambiguous address text can still resolve
to the wrong place; distance and ETA similarity alone do not prove the destination.

The published waypoint distance/time may refer to the first stop rather than the final destination. Consumers
must retain explicit scope rather than infer it from a field name. Synthetic regression tests cover route selection,
correction, stale data and rendering; they do not establish live-car behavior for every firmware or route.

## Features

- Road map around the car from Mapbox vector tiles: thin bright lines on black, fading with distance, so only the
  roads float over the road ahead; current road name and the names of the streets ahead.
- The car's position from BMW positioning, with BMW's map-matched position as the fallback without GNSS.
- **Speed camera points**: fixed cameras from OpenStreetMap (regional packs in [Vela](https://github.com/PimpinPumpkin/Vela)'s
  public road-features format, downloaded once and cached on the unit, plus live Overpass queries), matched to the
  direction of travel, with an icon on the map and a warning.
- Settings page in iDrive: on/off, zoom, map size, position (left/right/up/down), viewing distance, horizon, road
  opacity, camera warnings.
- Leaves BMW's own speed, speed limit and assist icons visible.

## Known issues

- The current navigation/capture integration needs on-car validation; the synthetic tests do not replace it.
- Destination capture supports only its fingerprinted firmware; the Google web response format may change.
- **Speed camera data over Overpass**: `overpass-api.de` refuses the TLS of the unit's Node 8, so only the regional
  packs work there.
- The map uses one public Mapbox token, shipped in `native/mindflow-hud/mapbox.json`. A private
  `mindflow-hud-routing` tool (`/var/opt/mindflow-hud-routing/current/routing.json`, `{"mapbox_token": "pk..."}`)
  overrides it.
- Tested on one car (G-series, iDrive 7, HUD). Positions, sizes and timings are tuned by eye.

## License

GPL-3.0-or-later (`LICENSE`). The build script is the one from `apps/robertn_waze_cluster`. Vendored npm modules in
`native/mindflow-hud/vendor` keep their own licenses (BSD-3-Clause, MIT, ISC).
