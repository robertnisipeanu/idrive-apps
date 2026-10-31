/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Logging to stderr (the journal under systemd). */
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

}  // namespace cld

#define log_error(...) ::cld::log('E', __VA_ARGS__)
#define log_warn(...)  ::cld::log('W', __VA_ARGS__)
#define log_info(...)  ::cld::log('I', __VA_ARGS__)
#define log_debug(...) do { if (::cld::log_verbose) ::cld::log('D', __VA_ARGS__); } while (0)

#endif
