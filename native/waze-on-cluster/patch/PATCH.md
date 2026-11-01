# The carplay patch, byte for byte

Four reversible edits to `/usr/bin/carplay` let waze-on-cluster receive the
CarPlay instrument-cluster map, at the size it displays, on a head unit coded
`KI_KOMBI_VARIANT` 7. `carplay_patch.js` applies, verifies and reverts them;
`patchd.js` runs it for the app and the install hooks, `woc-patch.sh` from a
shell.

## Builds

`carplay_locate.js` finds the four edit sites in each build by its code and
data, as each edit's "Found by" says, so the patch applies to any build in
which every site is found exactly once and passes its checks. A build where a
site is missing, found more than once or fails a check is not patchable; the
reason names what was not found, and `patchd` reports it as a conflict
(`not patchable: <reason>`). File offsets and virtual addresses are converted
through the ELF program headers, and function bounds come from the
`.eh_frame_hdr` search table; without that table there is no self-start or
resolution site.

`carplay_patch.js probe [<file>]` (`woc-patch.sh probe`) reads a binary and
prints its size, SHA-256 and GNU build-id, where each site is, how it reads,
and `patchable: yes` or `no` with every reason; it never writes.
`collect-logs.sh` includes its output.

**Proven builds**, listed by build-id in `carplay_patch.js`: the first edit
needs the whole file to be the shipped one, and any other content reads as
modified by something else. Another build counts as pristine when all four
sites read stock.

The offsets and bytes below are those of the build the patch was proven on:

| | |
|---|---|
| package | `carplay 22.28.3+gitr624+993efc1-r0.14` |
| file | `/usr/bin/carplay`, ELF x86-64 PIE, stripped |
| size | 3 484 912 bytes |
| sha256 | `ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50` |
| build-id | `5de62156575d737391ea42254e778a97dbbb51f8` |

In it, file offset equals virtual address in the ranges used here.

## Edit 1 — variant (ungate the second display)

CarPlay maps the raw coding value `KI_KOMBI_VARIANT` through a converter
jump table at `0x2ba4d4` (12 signed int32 offsets from the table base):

| raw | handler | internal value |
|---|---|---|
| 9 `ic_box_high` | `0x239790` | IC_HIGH (0) |
| 10 `ic_box_mid` | `0x2397e0` | IC_MID (1) |
| 0 | `0x2397d0` | NOT_ACTIVE (3) |
| everything else, incl. 7 `high_4_1` | `0x2397c0` | OTHER (2) |

OTHER fails the accessory-feature gate and the `ICSafeAreaProvider`
resolution builder, so the alternate display is never advertised. The patch
copies the IC_HIGH (or IC_MID) slot value into slot 7; only variant 7 is
affected.

| | offset | bytes |
|---|---|---|
| slot 7 original | `0x2ba4f0` | `ec f2 f7 ff` → OTHER |
| → IC_HIGH | `0x2ba4f0` | `bc f2 f7 ff` (slot 9's value) |
| → IC_MID | `0x2ba4f0` | `0c f3 f7 ff` (slot 10's value) |

**Found by** the converter's code, `cmp byte [rdi],n ; ja ; movzx eax,byte
[rdi] ; lea rdx,[rip+table] ; movsxd rax,[rdx+rax*4] ; add rax,rdx ; jmp
rax`. Other switches share the shape, so each table of at least 11 slots is
decoded through its handlers (`mov dword [rsi],value`); the converter is the
only switch mapping 9 → IC_HIGH, 10 → IC_MID, 0 → NOT_ACTIVE and every other
value to one shared OTHER table value, with slot 7 holding that OTHER value
(stock) or slot 9's or 10's (patched). The stock and patched slot values are
read from the table itself.

The app applies IC_HIGH; IC_MID (`--panel mid`) keeps its stock 1920x720
geometry.

## Edit 2 — sink (where the stream goes)

The second-stream Cinemo sink URL at `0x2a20b0` is, as shipped:

```
avb://media_transport.avb_streaming.15?mime_type=video/H264    (59 bytes + NUL)
```

`mime_type=video/H264` keeps the H.264 undecoded; the stream is RTP (payload
type 96, single NAL units and FU-A; VERIFIED on a car capture). The modes:

- **avb** (what the app applies; an apply without `--sink`): the stock sink,
  which the render joins as an extra receiver.
- **udp**: `--sink udp://127.0.0.1:20557?mime_type=video/H264`. `udp://` and
  `tcp://` map to Cinemo's `NmeVfsSocket`, a stream sink. That the bridge
  accepts it and sends the same RTP is INFERRED, not verified on a car.
- **fifo**: `--capture <fifo>` writes `file://<fifo>?mime_type=video/H264`.
  The projection bridge rejects a `file://` sink on the car
  (`configureProjectionBridge` fails).

A replacement is NUL-padded to 59 bytes; a longer URL is refused. The NUL
run after the slot and the next string are never written. The render listens
on all three sinks.

**Found by** the string after it, `mCarPlay->GetDisplaySource( …`: the slot
is its own NUL-terminated string ending 1 to 16 NULs before that string, and
holds either the stock URL above or a `udp://`, `tcp://` or `file://` URL no
longer than it. Exactly one such slot must exist. A build whose stock URL
differs is not patchable: the render joins stream 15.

## Edit 3 — self-start

With Edits 1 and 2 CarPlay advertises the display, but the stream never
starts: `AlternateDisplays` waits for NavController to forward a
`requestStream` command (`ProjectedModeGuiding.streamCommandChanged`), and on
this build NavController's `Guidance.requestStream` is an unimplemented stub.
The fix makes CarPlay start the stream itself.

`requestStream()` (`0x181810`) needs no stored config: it calls `ShowUI` and
`ForceKeyframe` through `mCinemoCarPlay` (`[this+0x28]`) with the URL and UUID
from `CarPlayConstantsRepository`, skips when `mStreamStatus` (`[this+0x48]`)
is already 2, and ends with `setStreamStatus(STREAMING)`.

`AlternateDisplays::onSuggestUi()` (`0x1816f0`), once the display is
available and not streaming, calls `setStreamStatus(this, AVAILABLE)` at
`0x18176c` with `this` in `rdi`. The patch retargets that call:

| | offset | bytes |
|---|---|---|
| original | `0x18176c` | `e8 ef fd ff ff` → `call setStreamStatus` (`0x181560`) |
| self-start | `0x18176c` | `e8 9f 00 00 00` → `call requestStream` (`0x181810`) |

Only the rel32 changes. NavController then receives STREAMING where stock
sends AVAILABLE; it is inert either way, and these messages never reach the
phone. Both guards make it one-shot per session. Every mode applies it.

**Found by** name. setStreamStatus, requestStream and onSuggestUi are the
functions that load their own function-name strings (`void
…AlternateDisplays::setStreamStatus(…`, `…::requestStream()`,
`…::onSuggestUi()`) with a rip-relative `lea`, each string from one function
only. requestStream must also load the `mCinemoCarPlay->ShowUI(` and
`mCinemoCarPlay->ForceKeyframe(` checks and call setStreamStatus. The site is
onSuggestUi's one call to either function, with AVAILABLE stored as its
argument (`mov dword [rsp+…],1`) in the 24 bytes before it. Its stock and
self-start rel32 are computed from the functions' virtual addresses.

**Exception risk.** `ShowUI` and `ForceKeyframe` are each followed by a
result check (`0x18189b`, `0x1818da`) that calls the throw helper `0x250980`
on error, and the call site has only a cleanup handler. An uncaught throw
would kill CarPlay, which on a stock restart list reboots the head unit, and
could repeat at every phone connection. Disable map, or boot recovery
(below), restores the stock call path, which has no throw.

### Keyframe cadence

CarPlay forces exactly one keyframe, inside `requestStream` (`0x1818ca`, the
binary's only `ForceKeyframe` reference). On a 90 s car capture the phone
sent SPS, PPS and an IDR only at stream start, twice within the first second,
then non-IDR slices only. A decoder that misses the start never syncs. So
the render runs from boot with its sources listening, starts the decoder at
the stream's first SPS, and decodes whether or not the map is shown. A lost
RTP packet costs only the NAL unit it carried: the decoder decodes through it
and the map shows smudges until the phone codes those areas again (README
"Losses"). `probe.txt` counts `seq_gaps` and its `late-join:` line reads
`RISK` on this stream.

### Stream resync

A render that missed the start (it restarted), or whose decoder gave up its
sequence after decode errors in a row, decodes nothing until a new stream,
and nothing on the head unit asks the phone for a keyframe. A new CarPlay
session brings a new stream, so `patchd` restarts CarPlay the way it
activates a patch:

- About once a second the render writes `stream.json`: how long the stream
  has arrived with no frame decoded and no SPS or IDR. A decoded frame or the
  stream stopping resets it; a keyframe seen since the last decoded frame
  holds it at 0, since a new stream would not fix a decoder that fails on a
  keyframe.
- `patchd` reads it every 2 s, as a small regular file opened without
  following links and without blocking; a report older than 5 s counts as
  none. Past 15 s it SIGKILLs CarPlay's main PID and starts the unit, only
  when recmgr loaded CarPlay's restart entry this boot and no apply, revert
  or reboot runs.
- Attempts are spaced 2 min, then 10 min, then 30 min, at most 6 per
  head-unit start; 10 min without a wait resets the spacing. The counts live
  in `/dev/shm/waze-on-cluster/resync.json`, so they survive a `patchd`
  restart and clear at a head-unit start. Each attempt, and each held one
  with its reason, is in `patchd`'s log.
- From the first report of a wait, `patchd` decides whether a resync would
  go and records it in the same file: `waiting` true and `held`, null when
  it would go or why not. Both clear when the wait ends, and at each
  `patchd` start. The render reads it each second: its status says `Stream
  lost — restarting CarPlay` only with `waiting` true and `held` null, and
  `Stream lost — reconnect CarPlay` otherwise; its log and `probe.txt` give
  the reason.

On the car the stream resumed after a CarPlay restart; the restart also ends
the main-screen session until the phone reconnects. With a stock restart list
the resync is held and the map waits for a reconnect.

## Edit 4 — resolution

Stock IC_HIGH advertises a 1920x900 display (234x110 mm), so the phone renders
at that size and the map would be scaled twice. Edit 4 advertises the size
the map is shown at: the cluster's central map area, 1088x480 px at
138x61 mm, the view area the full frame. The decoder then passes the picture
through unscaled.

The IC_HIGH builder in `ICSafeAreaProvider` (`0x20ca30`) fills its object from
four `movabs` immediates; only the 8 immediate bytes after each 2-byte opcode
change:

| field | immediate at | stock | patched (default) |
|---|---|---|---|
| mm (→ `+0x10`) | `0x20ca32` | `ea000000 6e000000` (234x110) | `8a000000 3d000000` (138x61) |
| px (→ `+0x08`, `+0x18`) | `0x20ca54` | `80070000 84030000` (1920x900) | `40040000 e0010000` (1088x480) |
| view x,y (u16) + safe width | `0x20ca66` | `00000000 64020000` | `00000000 f8010000` |
| safe height + safe x,y (u16) | `0x20ca74` | `0e020000 0202c000` | `70010000 1e014800` |

The getters at `0x20ce00`–`0x20cf40` read these fields; the config built from
them (`0x2078f1`) is what `SetVideoParams` and the view-area report carry.
The IC_MID builder (`0x20caa0`) is never written: `--panel mid` advertises
stock 1920x720, and switching high → mid restores the IC_HIGH immediates, so
the binary carries one panel's geometry at a time. `--res WxH` (even, up to
1920x1080) picks another pixel size at the same physical size; `--res stock`
keeps stock. The size is negotiated at phone connection, so it applies from
the next CarPlay session after CarPlay restarts.

**Found by** the `ICSafeAreaProvider` constructor, the function that loads
its name string. It calls exactly two geometry builders: functions holding
one `movabs rdx` (the mm pair) before `mov [rdi+0x10],rdx ; movabs rax ; mov
[rdi+8],rax ; mov [rdi+0x18],rax ; movabs rax ; mov [rdi+0x20],rax ; movabs
rax ; mov [rdi+0x28],rax`. The IC_HIGH builder is the one called on
the true branch of the constructor's call to its IC_HIGH check, a small
function doing `mov eax,[rdi] ; test eax,eax ; sete al` (or
`cmp dword [rdi],0 ; sete al`); the `test al,al` and
`je` or `jne` after that call give the branch.

This tool's geometry has its 138x61 mm physical size, the view area at (0,0)
and a safe area inside the frame. A stock geometry has another physical size
and a safe area inside the frame; any other geometry is not recognised.
`--res stock` and `--panel mid` write the backup's stock immediates back.

### Safe area

The phone draws the map across the whole view area (Cinemo's `viewAreas`)
and keeps its UI, such as the manoeuvre banner, inside the safe area; a car
capture of the stock geometry shows exactly that. With a full-frame safe area
the banner lands in the top-left corner, under the cluster's gauge mask.

The default safe area is **504x368 at (286, 72)** (x 286–790, y 72–440):

- x: BMW's own IC_MID safe area (504x456 at (708, 153) on the panel) lies
  inside the map area at (422, 134); in map-area coordinates it spans
  x 286–790, between the native speed readout (to x ≈ 170) and consumption
  readout (from x ≈ 800).
- y: the native model badge covers the top of the area to y ≈ 64; at y 72 the
  gauge mask's top-left corner is already lit; 440 is where the mask's lower
  falloff starts.

`--safe WxH+X+Y` writes another (at least 16x16, inside the frame), `--safe
full` the whole frame; `--res` scales the default. `patchd` reports `res` and
`safe`, and the app offers Enable map when either differs from the default.
A high-panel binary with stock geometry reads as partially patched.

## Activation

The running CarPlay keeps its old binary until it next starts. A `systemctl
stop` or `restart` of `carplay.service` power-cycles the head unit, and
recmgr reboots it when a service its restart list (read only at boot) does
not name dies. So `patchd` restarts CarPlay itself only when `carplay` is in both
`[Whitelist]` and `[WhitelistExitSuccess]` of `/etc/recmgr-restartlist.conf` as recmgr loaded it this boot
(the file while it is older than the boot, else the deploy tool's copy taken
at boot): it SIGKILLs the main PID, waits for systemd to reap it, runs
`systemctl start carplay.service` and waits for `is-active`. No main PID, a
failed start or a unit that stays inactive is an error, never a fallback to
stop or restart.

Otherwise (the stock list) a change is deferred:

- the binary is written (backup, verify, atomic rename) with `/` read-write
  only for the write, and the running binary is kept hard-linked as
  `<target>.woc-running`, so no replaced file stays open and `/` can return
  to read-only;
- `/dev/shm/waze-on-cluster/activation-pending`
  (`{"action":"apply"|"revert","reason":…}`, 0644, readable by the app while
  `patchd` is not running) marks it until the next start;
- `patchd` reports `carplay: deferred` and `pending: apply|revert`; the app
  shows `Patch pending — reboot to activate` or
  `Removal pending — reboot to finish` and a **Restart head unit** button.

A change that puts back the bytes CarPlay is running moves the kept link
back to `<target>`; nothing is pending.

**`reboot`.** `patchd` takes `{"cmd":"reboot"}` only while a change is
pending and no other operation runs, once, and answers with `reboot-reply`.
It runs `systemctl reboot`, never a CarPlay stop or restart.

### The `.woc-running` link

It exists only while a process runs the binary it links and that binary is
not `<target>`'s own file:

| When | What happens to it |
|---|---|
| a change is written while CarPlay runs `<target>` | created; kept while CarPlay runs it |
| a change puts CarPlay's running bytes back | moved back to `<target>` |
| `patchd` restarts CarPlay | removed |
| `patchd` starts, or any later write window | removed once nothing runs it |
| the tool is removed | `deactivate` removes one that holds nothing; a held one goes to the deploy tool (`"removeWhenUnused"`), which removes it once nothing runs it, at the latest at a later start |

It never outlives its process by more than one head-unit start.

### Install-time activation

The deploy tool (`mgu-deploy` 0.7.0 and later) runs `patchd.js activate` as
root after each install and update, and `patchd.js deactivate` before a
removal deletes anything. Both write as above under the shared remount lock
and **never stop, kill or restart CarPlay**, even where recmgr would allow
it. The hook's last stdout line, `{"status":…,"reboot":"patch written; takes
effect at the next head-unit start"}`, makes the deploy tool mark a restart
pending, which the Store shows.

| On disk | `activate` | `deactivate` |
|---|---|---|
| the pristine build, no backup of ours | applies Enable map's patch (pending) | nothing |
| a patch of ours, any configuration | brings it to Enable map's (pending), or nothing if it is already | reverts our edits (pending), drops our backup |
| the original with our backup (Disable map was used) | nothing: the map stays off | drops our backup |
| a change already pending | nothing (still reports the restart); after a removal's revert, applies again | a pending apply is undone (nothing pending); a pending revert becomes the removal's; our backup goes |
| a patch of ours plus another tool's edit elsewhere | updates ours, keeps theirs | reverts ours, keeps theirs, drops our backup |
| a build with an edit site not found or not recognised | nothing: a conflict | nothing |
| a proven build modified by something else, or any build with one of our edits and no backup of ours | nothing: a conflict | nothing (the patcher refuses) |
| `carplay.service` starting another program (an `ExecStart` in a unit or drop-in under `/etc` or `/run/systemd/system`) | nothing: a conflict | reverts our patch |

A conflict is not a failure: the hook exits 0 with `conflict` in its result,
`patchd` reports it, and the app shows it with Enable map, which applies only
on request (the patcher still refuses a binary it cannot patch). A hook exits
non-zero only when it changed nothing and could not do its job (`/` would not
remount, the patcher failed), so the deploy tool rolls the install back or
keeps the tool installed. Once the binary is written the hook exits 0, even
if `/` stayed writable (the next boot mounts it read-only).

Removal drops the backup (`carplay_patch.js revert --drop-backup`), so a
later install patches like a fresh one.

**Removal.** The Store removes the app, then the tool. After `deactivate`
the deploy tool stops and removes the tool's units, recmgr entries and
`/var/opt/waze-on-cluster`; the renderer releases the map's slot, and the
capture restores the DLT tracing mode as it stops.

## Reversibility

Before the first edit the patcher copies the binary to `<target>.woc-orig`,
checks the copy, and records the original's SHA-256, build-id and version in
`<target>.woc-orig.json`. `apply` and `revert` re-check the backup: its
recorded SHA-256, a pristine build (above), and the same build as the target
(size, build-id and every site). `revert` restores only the edits' regions
from it, so another tool's change elsewhere stays; it then confirms all four
edits read original (and the whole file matches the backup when nothing else
changed). The stock geometry `apply` writes back (`--res stock`, `--panel
mid`) is the backup's. `revert --force` writes the whole backup, also over a
binary it does not recognise. Every write is an atomic rename.

## Boot recovery

On a stock restart list a CarPlay crash reboots the head unit with the
patched binary still on disk: a boot loop with no HMI to turn the map off.
`recovery.js` (`waze-on-cluster-recovery.service`, root) breaks it with the
same `carplay_patch.js revert` Disable map uses. **It never kills, restarts
or reboots anything**; it only replaces the binary on disk, keeping the
running one linked as `<target>.woc-running`.

A counter in `/var/opt/waze-on-cluster/boot-recovery.json` (fsync'd) arms each
boot that comes up patched. A boot that neither reaches a healthy CarPlay
(active for 60 s continuously) nor shuts down cleanly (SIGTERM) counts as
failed at the next boot; after 2 in a row the next boot restores the
original. A healthy CarPlay clears the counter. It acts only on a recognised
patched form of the backup's build with a verified backup; a stock or
firmware-replaced binary is left alone and the counter cleared. A shared
remount lock (`remount_lock.js`) keeps it and `patchd` from remounting `/` at
once; recovery yields to `patchd`.

## Tests

`make test` runs them all. The binary tests take `CARPLAY_BIN`, a copy of the
unit's carplay 22.28.3 (the SHA above), and are skipped without it; the
repository carries no BMW binary.

- `locate_test.js`: on synthetic builds written by `synthetic_carplay.js`
  (no BMW bytes), every site found, also at other offsets, addresses and code
  order and in its patched state; a signature found twice refused as
  ambiguous; damaged sites refused with their reason; apply, verify, probe
  and a byte-exact revert on a build outside the proven list. With
  `CARPLAY_BIN`, the sites are the offsets above.
- `patch_test.js`: the sites the probe reports, the SHA gate, both panels,
  the sink inside its slot, the call retarget, region-bounded diffs,
  idempotence, partial patches (an Edit-1-only binary among them), the
  geometry and safe area, byte-exact revert, a build outside the proven list,
  a backup of another build refused.
- `patchd_patch_test.js`, `patchd_activate_test.js`: `patchd` and both hooks
  on a copy, against a fake `/proc`, `mount`, `systemctl` and recmgr list:
  both activation branches, every row of the install table, the marker, the
  link's lifetime, `/` read-only after every path, and no `systemctl`, `kill`
  or `reboot` from the hooks.
- `patchd_resync_test.js`, `recovery_test.js`: the resync's timing and
  limits; the boot counter, the remount lock and a real restore on a copy.
