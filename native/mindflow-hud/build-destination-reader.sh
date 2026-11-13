#!/bin/sh
# Build on Linux x86-64: gcc, libc development files and libssl-dev required.
# The installed helper has no interpreter or dynamic-library dependency.
set -eu
cd "$(dirname "$0")"
export LC_ALL=C
${CC:-gcc} -std=c11 -O2 -Wall -Wextra -Werror -static \
  -ffile-prefix-map="$PWD"=. -Wl,--build-id=none \
  destination_reader.c -lcrypto -pthread -ldl -o destination-reader.new
strip destination-reader.new
chmod 755 destination-reader.new
mv destination-reader.new destination-reader
sha256sum destination-reader
