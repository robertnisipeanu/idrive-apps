# Native destination reader

The Node.js service starts `destination-reader`, a static Linux x86-64 helper.
No Python interpreter or adapter runtime is installed. The helper returns one
bounded JSON result after restoring debug registers and detaching. It uses the
same firmware hash, callback and address-vector layout as the previous reader.
No captured destination files or diagnostic logs are written.

The helper requires the existing permission to trace `aapd`. It does not change
tracing policy or write target code/data. It briefly stops threads to inspect the
callback and restores the hardware debug registers on cleanup. Unsupported
firmware, existing breakpoints and changed thread topology cause capture to abort.
An abnormal helper termination still locks out further captures in the JS client.

## Build

On Linux x86-64 with GCC, libc development files and OpenSSL development files:

```sh
sh build-destination-reader.sh
```

The checked-in executable is built statically, including the SHA-256 implementation
from OpenSSL and the C runtime. `reader-licenses/` contains their distribution
copyright/license notices. Build tools are not needed on the car.
The source and build script allow rebuilding against replacement libraries.

Recorded build environment: Ubuntu 24.04, GCC 13.3.0,
libc6-dev 2.39-0ubuntu8.9, libssl-dev 3.0.13-0ubuntu3.16.
Upstream sources: https://www.gnu.org/software/libc/ and https://www.openssl.org/source/;
Ubuntu package sources are available through `apt source glibc openssl` for these
versions. Only the SHA-256 primitives are used; no OpenSSL networking is used.

## Tests

From this directory on Linux:

```sh
gcc -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined \
  test/destination_reader_test.c -lcrypto -pthread -ldl -o /tmp/hud-reader-test
ASAN_OPTIONS=detect_leaks=0 /tmp/hud-reader-test
node test/destination_capture_test.js
```

The native test traces only its own controlled child processes. The test-only
profile is compiled into the test executable, never the production helper.
Tests cover Unicode text, malformed strings and vectors, timeouts, cancellation,
multiple threads, target exit, unexpected signals, final observation selection,
wrong firmware/callback rejection, clean detach and debug-register restoration.
The JS tests exercise the JSON handoff and rejection paths.

These are Linux integration tests, not a live-car test. Confirm automatic capture,
route resolution, cancellation and repeated navigation sessions on the car before
treating this as a vehicle-validated replacement.
