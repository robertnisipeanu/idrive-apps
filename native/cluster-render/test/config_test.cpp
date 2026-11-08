/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the settings parser (config.h), focused on int_value: a
 * typo in a numeric setting must not silently parse as 0. For the upload
 * budget 0 means "no limit", so a non-numeric upload_kb_per_s parsing as 0
 * would disable the limit that keeps the cluster from being flooded. */
#include <cstdio>
#include <string>

#include "../src/config.h"

using namespace cld;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

/* A Config with one key set to `value` (no key is set when value is null). */
static Config with(const char *value)
{
    Config cfg;
    cfg.define("upload_kb_per_s", "5500");   /* main.cpp adds this key via define() */
    if (value) {
        std::string err;
        bool okset = cfg.set_pair(std::string("upload_kb_per_s=") + value, &err);
        if (!okset) std::printf("     set_pair rejected '%s': %s\n", value, err.c_str());
    }
    return cfg;
}

static bool parses(const char *value, long expect)
{
    long out = -123;
    return with(value).int_value("upload_kb_per_s", &out) && out == expect;
}

static bool rejects(const char *value)
{
    long out = -123;
    return !with(value).int_value("upload_kb_per_s", &out);
}

int main()
{
    /* Clean integers parse, in every base strtol(…, 0) accepts. */
    ok("plain decimal", parses("5500", 5500));
    ok("zero stays zero (no limit, intentional)", parses("0", 0));
    ok("hex", parses("0x1000", 0x1000));
    ok("leading/trailing spaces are trimmed by set_pair", parses("  8000  ", 8000));

    /* The dangerous cases: a typo must be rejected, not read as 0. */
    ok("non-numeric is rejected", rejects("abcd"));
    ok("empty is rejected", rejects(""));
    ok("trailing unit is rejected", rejects("5500k"));
    ok("thousands separator is rejected", rejects("8,000"));
    ok("letter-O-for-zero is rejected", rejects("O8000"));
    ok("invalid octal (08000) is rejected", rejects("08000"));

    /* The default is a clean integer, so a stock config always parses. */
    long out = 0;
    ok("built-in default parses", Config().int_value("fps", &out) && out == 30);

    /* num() keeps its lenient behaviour for the many non-critical callers. */
    ok("num() still lenient for others", with("abcd").num("upload_kb_per_s") == 0);

    return failures ? 1 : 0;
}
