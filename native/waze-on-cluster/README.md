# waze-on-cluster

Shows the CarPlay instrument-cluster map (Waze, Apple Maps or Google Maps)
on the instrument cluster of a BMW with an iDrive 7 head unit (MGU), which
the stock software does not do. It runs as root tools on the head unit and is
driven from the HMI by the companion app
[robertn_waze_cluster](../../apps/robertn_waze_cluster).

CarPlay sends the cluster map only as H.264 video, with no map data, so this
is a video pipeline:

1. **Ungate the second display.** A reversible, SHA-pinned patch to
   `/usr/bin/carplay` makes `KI_KOMBI_VARIANT` 7 resolve to a supported
   cluster variant, makes CarPlay start the cluster stream itself, and
   advertises the size the map is shown at ([patch/PATCH.md](patch/PATCH.md)).
2. **Capture.** CarPlay sends the stream as RTP to its stock media-bus sink,
   AVB stream `media_transport.avb_streaming.15`; the render joins it as an
   extra receiver, in-process. It also listens on a local UDP port and a FIFO,
   which other sink patches can point at.
3. **Decode.** RTP is depacketised to H.264 Annex B (`src/rtp_h264.*`) and
   decoded with the unit's Intel Media SDK / VAAPI on `/dev/dri/renderD128`
   to the picture's own Y, U and V planes.
4. **Draw.** Each frame goes to the shared cluster renderer,
   [cluster-render](../cluster-render), as a
   video layer (`src/map_feed.*`). The renderer owns the RAMSES participant,
   the DCSM slots and one upload budget for all its clients.

## Install and remove

Install the app `robertn_waze_cluster` from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). The
app requires this tool (0.5.0); this tool requires `cluster-render` 0.1.0 and
`mgu-deploy` 0.7.0, the deploy tool version that runs activate and deactivate
hooks. Requirements resolve across catalog sources.

**Install.** The deploy tool runs `patchd.js activate` as root. It writes the
patch Enable map writes, keeps the running binary linked, and never stops,
kills or restarts CarPlay. The Store shows a restart pending; the app shows
`Patch pending — reboot to activate`. One head-unit start runs the patched
CarPlay and starts this tool's services. The hook leaves CarPlay as it is,
and the app says why and offers Enable map, when Disable map was used, when
the binary is not the known build or something else modified it, or when
`carplay.service` starts another program. An update brings an older patch of
ours up to date.

**Remove.** In the Store, remove the app, then the tool (refused while the
app is installed). `patchd.js deactivate` reverts only our byte regions,
keeps other tools' edits and drops our backup; the deploy tool then removes
this tool's services and files. The renderer and the deploy tool stay. The
next head-unit start runs the original CarPlay. Details: PATCH.md
"Install-time activation".

## Using it

On the app's page, **Enable map** asks the root patch daemon `patchd` to
apply the patch and **Disable map** reverts it, which turns the feature off:
without the patch the phone sends no cluster stream. A change takes effect
when CarPlay next starts. `patchd` restarts CarPlay at once only where recmgr
loaded `carplay` in both restart lists at this boot (PATCH.md "Activation");
otherwise the app shows **Restart head unit**, a normal system reboot.

Then connect the iPhone to CarPlay. Waze needs its server-side flag 1006 for
the alternate display. The phone sends SPS, PPS and an IDR only at the start
of a stream, so the render service runs from boot, joins the media bus at
once (retrying every second until the AVB bridge is up), and decodes from the
stream's first SPS whether or not the map is shown. The app need not be open.

The map comes up at the first decoded frame in the native central-map slot
`0x100` (scene `0x010004f0`, 1088x480), under the gauges. `stall_ms` (6 s)
after the frames stop it is taken down and the slot returns to the cluster's
own content; the next stream maps it again. While frames flow, a session the
cluster ends (the stock map taking the slot back, a refusal, no answer) is
started again after 2, 5, 10, 20, then every 30 s. The app shows
`Starting map…` while the renderer starts, and a map error only when the
renderer stays unreachable for 15 s.

A render that missed the stream's start decodes nothing until a new stream.
Where recmgr allows a CarPlay restart, `patchd` restarts CarPlay after 15 s of
stream with no keyframe, rate-limited (PATCH.md "Stream resync"); elsewhere,
reconnect the phone. If a patched CarPlay crash-loops,
`waze-on-cluster-recovery.service` restores the original binary on disk
(PATCH.md "Boot recovery").

From a shell, `waze-on-cluster -c <conf> run map|panel|hud` (`sail` is an
alias of `map`) sets the target until the service restarts and prints the
status.

## Status and diagnostics

Once a second the render writes, in `/run/waze-on-cluster/` (mode 0644):
`status.json`, the status the app shows (`state` idle, starting, showing or
error; `page`; `reason`; the shared upload cap as `upload_cap_kb_per_s` and
why as `upload_reason`, also in the app's status event); `probe.txt`, the
sources, the depacketiser (`rtp: packets nals aus seq_gaps dropped bad`), the
decoder, the late-join verdict, the noise filter's tile differences and the
renderer's own status; and `stream.json`, for `patchd`'s resync. `patchd`
answers `{"cmd":"logs"}` with CarPlay, AVB and DLT marker lines and its own
log.

Sockets: `/dev/shm/waze-on-cluster/ctl.sock` (the render's status and log,
group `tm_oap_app`; a connection also starts the service) and
`/dev/shm/waze-on-cluster/patch.sock` (`patchd`, `root:tm_oap_app`, 0660).
The app's README lists both protocols.

## Map size and upload

**Size.** The map covers the cluster's central map area, the stock map's
1088x480 rect on the 1920x720 panel (138x61 mm). The patch advertises exactly
that, so the phone renders those pixels, the decoder passes them through
unscaled and the texture maps onto the area one to one. In the whole-panel
slot `0x203` the map is centred at (416, 120) with everything around it
transparent. `tex_size` must equal the size the patch advertises.

**Texture.** The planes are packed into one R8 atlas, Y in rows 0–479 and U
and V side by side in rows 480–719 (783,360 B), which the renderer's shader
converts as full-range BT.601. The renderer keeps one persistent buffer and
writes only changed 64x64 tiles in place, one flush per update, so the
cluster never shows a half-written frame. (A new texture per frame held the
map to 3–4 frames a second on the car.)

**Noise filter** (`dirty_threshold` 8, `dirty_settle_ms` 1000). The phone
keeps coding residuals on a still map, mostly within 3 levels. A tile is
written only when it differs from what the cluster holds by more than the
threshold, or after `dirty_settle_ms`; a parked map costs about 1.6 updates a
second.

**Fast motion** (`pan_blocks` 1). An update whose exact write costs more than
261,120 B and more than the budget allows goes as 4x4 colour blocks at a
third of the bytes, slightly softer (38.8 dB mean on a recorded Waze capture;
street names and icons readable). The next update the budget covers, or a
quarter second later, brings the exact picture back. `waze-on-cluster
bench-pack <I420 file>` times the packing on the unit.

**Rate.** `target_fps` (30) is a ceiling on an exact grid; only the newest
frame waits, so the map skips ahead and never shows a backlog. Real Waze sent
up to about 16 frames a second on the car.

**Upload budget.** The budget belongs to cluster-render and is shared by all
its clients: a 6000 KB/s ceiling, stepping down by 500 KB/s to 2000 KB/s on
sustained congestion and recovering slowly. Set it with `upload_kb_per_s` in
`/var/opt/cluster-render/cluster-render.local.conf`. This tool's own
`upload_kb_per_s` and `upload_burst_ms` keys are accepted and ignored with a
warning naming that file. On the car 8000 KB/s made the cluster flash black;
6000 KB/s stayed smooth with packed motion and no failed writes, and real
Waze transitions peaked at about 3.2 MB/s. Every head-unit participant shares
the link to the cluster, so an upload that outruns it can drop other contents
too. Details: the cluster-render README.

Settings are in `waze-on-cluster.conf` (documented inline). Overrides go in
`/var/opt/waze-on-cluster/waze-on-cluster.local.conf`, which updates keep.

## The patch

`patch/carplay_patch.js` (Node 8, no dependencies) makes four edits, each
validated against the one known build (whole-file SHA-256, plus anchor bytes
around each region), after a verified full backup:

| Edit | What it does | Where |
|---|---|---|
| variant | jump-table slot for `KI_KOMBI_VARIANT` 7 → IC_HIGH or IC_MID | 4 B at `0x2ba4f0` |
| sink | second-stream sink URL: stock `avb://`, or `udp://…`, `file://…` | ≤ 59 B at `0x2a20b0` |
| selfstart | `onSuggestUi`'s `setStreamStatus(AVAILABLE)` call → `requestStream()` | rel32 at `0x18176c` |
| resolution | IC_HIGH geometry → 1088x480 px at 138x61 mm, safe area 504x368+286+72 | four 8 B immediates at `0x20ca32`–`0x20ca7c` |

`patchd` and the install hook apply `--panel high` with the stock sink.
`woc-patch.sh` is the shell path, for experiments: `status`, `verify`,
`revert [--force]`, and `apply high|mid` with `--avb` (the app's sink), no
flag (`udp://127.0.0.1:20557`), `--capture` (FIFO) or `--sink <url>`, plus
`--res WxH|stock` and `--safe WxH+X+Y|full`. It remounts `/` read-write only
for the write. **Never `systemctl stop` or `restart` carplay**: that
power-cycles the head unit, and so does any CarPlay death unless recmgr
loaded `carplay` in both restart lists at this boot. `revert` refuses a
binary it does not recognise as a patched form of the backup
(`/usr/bin/carplay.woc-orig`) unless given `--force`.

## Safety

- The patch is the only change to a BMW binary. It is reversible, SHA-pinned
  and fully backed up, refuses an unknown or otherwise-modified build, is
  written by atomic rename, and takes effect at the next CarPlay start.
  Removal reverts our edits only.
- `patchd` runs as root. It accepts only `apply` (panel `high|mid`, mode
  `avb|udp|fifo`), `revert`, `reboot`, `status`, `logs` and the capture
  commands; no value reaches a shell or a path. It checks `/` is read-only
  again after every write. It applies no patch on its own; its only
  unrequested action is the rate-limited stream resync. `reboot` is honoured
  only while a change is pending.
- No debug arming: the services are normal units whitelisted in recmgr.
- Nothing is mapped on the cluster before the first decoded frame or after
  the frames stop. The map never alters the gauges' data.
- The render runs as `hmi_5000` with the groups `video` (the DRM render
  node), `mgu_ufipc` (the AVB bridge's shared memory; the receiver fails
  without it) and `tm_oap_app` (the renderer's socket).

## Diagnostic capture

CarPlay's projection-config markers are on DLT only during a phone
connection. Press **Capture logs**, then reconnect the phone; the window lasts
up to 5 minutes and **Stop capture** ends it early. `patchd` keeps the
markers until it restarts. The capture service is a root service, so it
starts only after a reboot following its install.

`waze-on-cluster-capture.service` sends BMW's DLT control request (service
`0xf13`, as `dlt-control -u -z 1`) over `/run/dlt-files/dlt-ctrl.sock`, waits
for the acknowledgement and checks the TCP 3490 listener through procfs. It
never edits DLT configuration or restarts CarPlay. It refuses unless a DLT
client is registered, the listener is closed and the newest state record in
`/run/logntrace/` says unambiguously whether tracing was OFF or BUFFER. It
records ownership under `/run/woc-dlt-capture` before turning tracing on, and
restores the recorded mode at the deadline, on stop and in `ExecStopPost`
(also after SIGKILL). A failed restore shows as `restore_failed` in the app,
is retried every 5 s and blocks a new capture. DLT is shared ECU-wide:
restoring closes its TCP clients, and no other tracing tool should run during
a capture.

## Verified, and open

Verified on a car with real CarPlay Waze: the alternate display, the AVB
capture (RTP payload type 96, single NAL units and FU-A), the decode, the map
in slot `0x100` under the gauges with normal colours, readable text and
correct transitions. A 10-packet slice of a car capture is the depacketiser's
golden test (`test/data/stream15_start.rtp`).

Open: that the phone's SPS is exactly the advertised 1088x480; how packed
motion reads during a long fast pan while driving; whether the alternate
display survives iOS and Waze updates (flag 1006 is server-side). Waze sends
no guidance metadata, so this shows map pixels, not data-driven directions.

## Building and testing

```sh
make test                         # host tests: NAL, RTP, keyframe wait, the map feed against
                                  # cluster-render, the renderer's kit, patch/patchd/recovery/DLT
make test-x86                     # the C++ tests with the unit's toolchain in Docker (SSE2 paths)
make target                       # build/target/waze-on-cluster in Docker, imports checked
make test-firmware ROOTFS=<dir>   # DLT capture against the unit's own dlt-daemon in Docker
```

`CR` names cluster-render's tree, `../cluster-render` by default. Its tree
also gives the log, the config, the unit's ABI tools and the build image.
The target builds in Ubuntu 18.04 (gcc 7.5, glibc 2.27, the unit's libstdc++ ABI) against
link-only stubs of the unit's libmfx, libva, libva-drm and IAS AVB bridge
(`abi/*.symbols`), with every import checked.

The patch tests run against a copy of the unit's `/usr/bin/carplay`
(carplay 22.28.3, sha256
`ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50`) named by
`CARPLAY_BIN`; without it they are skipped (`SKIP`). The repository carries
no BMW binary. `test-firmware` runs the unit's own dlt-daemon, libdlt and
dlt-receive from `ROOTFS`, an extracted root file system of the unit.

## License

GPL-3.0-or-later (`LICENSE`). `abi/include/mfx/` is a subset of the Intel
Media SDK headers under the MIT license (`abi/include/mfx/LICENSE`).
Third-party files keep their own licenses.
