# robertn_waze_cluster

The HMI app for [waze-on-cluster](../../native/waze-on-cluster), which shows
the CarPlay cluster map (Waze, Apple Maps or Google Maps) on the instrument
cluster of an iDrive 7 (MGU) head unit. Everything is done from the HMI; no
shell is needed.

Install it from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). It requires
waze-on-cluster 0.7.11, which brings the cluster renderer and writes the
CarPlay patch as it installs; one head-unit start activates it. After that
the map is on the cluster whenever CarPlay streams it, whether or not this
app is open.

Set **Instrument cluster > Central display area** to **Map view**: the Waze
map replaces the stock map while CarPlay's cluster stream shows a map, and
the stock map is back when the stream ends or shows none. Until a navigation
app draws on the cluster (in Waze or Google Maps, once a route starts), the
stock map stays and the page shows `Waiting for the phone's map — start
navigation`. **Off** works too, with an empty centre
instead of the stock map. With Route preview or Assisted Driving View the
cluster's own content takes the centre. After changing the setting, CarPlay
may need reconnecting before the map returns: the change can freeze the
phone's cluster stream, and the page then shows `Map frozen — reconnect
CarPlay` while the stock map (in Off, an empty centre) shows.

To remove, remove the app in the Store, then the Waze tool, which reverts
the patch.

## HUD

Contributed by [eroobeeroo](https://github.com/eroobeeroo): the map (Waze or
Google Maps) on the head-up display instead of the cluster. **Show map on**
switches between them. On the HUD the frames are scaled on the head unit to
the size shown, the corners are rounded and a night map's background is made
black, which the HUD shows as nothing, so the roads, route and labels float
in view. The map steps aside while the HUD's media and list pop-ups show. The
choice and the HUD map size are kept for each driver profile.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | the patch and map state: `Patch pending — reboot to activate`, `Removal pending — reboot to finish`, `Original — enable the map`, `Not patched — <reason>`, `Applying patch…`, `Patched — waiting for CarPlay`, `Waiting for the phone's map — start navigation`, `Stream lost — reconnect CarPlay`, `Starting map…`, `Showing: Waze map — 16 frames/s …`, `Map frozen — reconnect CarPlay`, `Map error: …`, `Patch service unavailable (reboot may be needed)` |
| setup | `Set Instrument cluster > Central display area to Map view`, always shown |
| Enable map | applies the patch; shown while it is off, unknown or out of date and no change is pending |
| Disable map | reverts the patch, which turns the map off; shown while patched and no change is pending |
| Show map on: Cluster / HUD | moves the map between the instrument cluster and the head-up display at once; kept for the next start and per driver profile |
| HUD map size | Standard (about 57 % of the HUD's width), 70 %, 85 % or 40 %, resized at once; kept like Show map on. Enabled while the map goes to the HUD |
| Restart head unit | a normal system reboot; shown only while a written change waits for the next head-unit start |
| Capture logs (5 min) / Stop capture | a bounded DLT capture for diagnostics; start it, then reconnect CarPlay |
| Logs | opens the Logs page |
| 30 rows | both tools' log lines, newest first, tagged `map:` / `patch:` |

The **Logs** page (`ST_OnlineApps_WazeClusterLogs`, a child of the main
page):

| Row | What it does |
|---|---|
| Save logs | saves an archive of the tools' logs, kept journal and status (waze-on-cluster README, "Logs") |
| status | `Saving…`, `Saved <name>`, `<n> saved`, `No logs saved`, `Not enough space`, `Logs too large`, `Save failed`, `Logs unavailable — restart head unit`, `Connecting…` |
| QR code | the download address, for a phone on the car's Wi-Fi hotspot; blank without one |
| address | `http://172.16.222.97:8475/<token>/`, or `Wi-Fi hotspot off` |
| 5 rows | the saved archives, newest first, with their size |

The app holds the logs socket while the Logs page is visible; the logs
service serves the archives while it is held and for 15 minutes after a
save. The QR code is a PNG in `/dev/shm/robertn_waze_cluster_qr_<uid>/`
(`src/qr.js`, with Project Nayuki's QR code generator, `src/qrcodegen.js`),
replaced when the address changes and removed when the app shuts down.

`Starting map…` shows while the cluster renderer starts; a map error shows
only when the renderer stays unreachable for 15 s. Before the patch daemon
runs (right after the install), the pending patch is read from
`/dev/shm/waze-on-cluster/activation-pending`.

## The sockets

Unix stream sockets, newline-delimited JSON, group `tm_oap_app`. The app
holds the first two while one of its pages is visible and the third while
the Logs page is, and retries each once a second; the tools keep running
when it closes them.

- **Render** `/dev/shm/waze-on-cluster/ctl.sock`, read-only:
  `{"ev":"status","state","target","page","reason","upload_cap_kb_per_s","upload_reason"}`
  (`state` idle, starting, showing, frozen or error), `{"ev":"log","line"}`.
- **Patch daemon** `/dev/shm/waze-on-cluster/patch.sock` (root). The app sends
  `{"cmd":"apply","panel":"high","mode":"avb"}`, `{"cmd":"revert"}`,
  `{"cmd":"reboot"}`, `{"cmd":"capture-start"|"capture-stop"}`. The daemon sends
  `{"ev":"status","state","panel","mode","res","safe","carplay","reason","pending","conflict"}`
  (`state` original, patched, unknown, busy or error; `carplay: "deferred"`
  while a change waits for the next start), `{"ev":"capture",…}`,
  `{"ev":"reboot-reply","ok","reason"}` and `{"ev":"log","line"}`.
- **Logs** `/dev/shm/waze-on-cluster/logs.sock`; a connection starts the
  logs service. The app sends `{"cmd":"save"}`. The service sends
  `{"ev":"state","url","saving","error","saved","archives":[{"name","size","mtime"}]}`
  on connect and on each change (`url` null without the hotspot's address;
  `error` `no-space`, `too-large` or `failed`).

A patch with another sink, panel, size (not `1088x480`) or safe area (not
`504x368+286+72`) shows `Patched — Enable map to update the patch`.

## Build and test

```sh
node tools/test_control.js           # the socket client against fake sockets
node tools/test_page.js              # the page against a fake SDK and HMI
node tools/build.js                  # robertn_waze_cluster@0.5.0.src.tgz
node tools/build.js --sdk <donor>    # also robertn_waze_cluster@0.5.0.tgz
```

The app ships as a source package (`mgu-app.json`; `"build": "unit"` in the
catalog). The repository carries no oap-sdk, which is BMW's: the head unit's
deploy tool links the app against the unit's own oap-sdk and takes the
package's entry point from the unit's own packages. To build the OAP tgz
locally, pass a donor bundle with `--sdk` (or `MGU_SDK_DONOR`), for example
the one `mgu-deploy.sh sdk-donor` takes from the unit. The tests need no
donor.

`node tools/fakes.js <render.sock> <patch.sock>` runs both fakes by hand;
Enter starts or stops a fake CarPlay stream.

| Path | |
|---|---|
| `src/robertn_waze_cluster.js` | the app |
| `src/waze_cluster_control.js` | the render and patch socket clients and the status logic |
| `src/logs_control.js` | the logs socket client |
| `src/qr.js`, `src/qrcodegen.js` | the QR code PNG; Project Nayuki's generator (MIT, `LICENSE-qrcodegen.txt`) |
| `tools/` | build, fakes, tests, icon |
| `robertn_waze_cluster@0.5.0/` | the package tree (manifest, RHMI UI, config) |

## License

GPL-3.0-or-later (`LICENSE`). Third-party files keep their own licenses.
