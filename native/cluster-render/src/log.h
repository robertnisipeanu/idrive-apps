/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Logging to stderr (the journal under systemd), and optionally to a file
 * that outlives the journal's few minutes on the unit (log_to_file). */
#ifndef CLD_LOG_H
#define CLD_LOG_H

#include <stdint.h>
#include <string>
#include <vector>

namespace cld {

extern int log_verbose;
/* Errors logged so far (tests check it). */
extern int log_errors;
/* The name each line carries in the journal. */
extern const char *log_name;

/* Monotonic milliseconds. */
int64_t now_ms();

void log(char level, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

/* The last lines logged, kept for the control socket's owner (from any
 * thread). Appends lines after sequence number *seq to out and advances
 * *seq; a *seq of 0 gets the whole backlog. */
void log_lines_since(uint64_t *seq, std::vector<std::string> *out);

/* From now on every line is also appended to path as
 * "YYYY-MM-DD HH:MM:SS.mmm L text" (UTC wall clock, L the level letter).
 * A line that would take the file past max_bytes first renames it to
 * path.1, replacing that, and starts a new one: at most about twice
 * max_bytes on disk. Opening writes a line with name, version (when not
 * empty) and the pid. When path cannot be opened, or a write fails later,
 * one warning goes to stderr and file logging stops; nothing else changes.
 * An empty path, or a second call, closes the file first. */
bool log_to_file(const std::string &path, size_t max_bytes, const char *name, const char *version);

/* log_file_kb in bytes: 16 to 16384 KB, otherwise (with a warning) 512 KB,
 * so a log setting never stops a service. */
size_t log_file_cap(long kb);

/* "YYYY-MM-DD HH:MM:SS.mmm", UTC, for milliseconds since the epoch. */
std::string utc_time(int64_t unix_ms);

}  // namespace cld

#define log_error(...) ::cld::log('E', __VA_ARGS__)
#define log_warn(...)  ::cld::log('W', __VA_ARGS__)
#define log_info(...)  ::cld::log('I', __VA_ARGS__)
#define log_debug(...) do { if (::cld::log_verbose) ::cld::log('D', __VA_ARGS__); } while (0)

#endif
