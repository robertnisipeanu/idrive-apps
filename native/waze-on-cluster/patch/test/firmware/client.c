// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A DLT application on the firmware's libdlt that logs a marker line. */
#include <unistd.h>

extern int dlt_register_app(const char *apid, const char *description);
extern int dlt_register_context(void *ctx, const char *ctid, const char *description);
extern int dlt_log_string(void *ctx, int level, const char *text);

int main(void)
{
    char ctx[128] = {0};
    dlt_register_app("WOCT", "capture test");
    dlt_register_context(ctx, "WOCT", "capture test");
    for (;;) {
        dlt_log_string(ctx, 4, "Adding display: capture-test");
        usleep(100000);
    }
}
