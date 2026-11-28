// SPDX-License-Identifier: GPL-3.0-or-later
/* Host test of the settings keys (keys.h), as the program loads them: the
 * shipped waze-on-cluster.conf with only the defined keys (no extra_keys),
 * and every key the program reads by name defined. A key the conf sets but
 * the program does not define stops it before its first log line, so the
 * service restarts until the Store puts the version before back (as an
 * early build of the turn card did, with its guidance key); a key read but
 * not defined is always empty. Run from the tool's directory: it reads
 * waze-on-cluster.conf and src/. */
#include <dirent.h>

#include <cstdio>
#include <fstream>
#include <regex>
#include <set>
#include <sstream>
#include <string>

#include "config.h"
#include "keys.h"

static int failures;

static void ok(const std::string &name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name.c_str());
    if (!cond) failures++;
}

/* The keys a source file reads by name: cfg.num("x"), cfg.str("x"),
 * cfg.has("x"), cfg.size("x", ...). */
static void read_keys(const std::string &path, std::set<std::string> *keys)
{
    std::ifstream f(path);
    std::stringstream all;
    all << f.rdbuf();
    const std::string text = all.str();
    static const std::regex use(R"(\bcfg(?:\.|->)(?:num|str|has|size)\("([a-z0-9_]+)\")");
    for (std::sregex_iterator it(text.begin(), text.end(), use), end; it != end; ++it)
        keys->insert((*it)[1].str());
}

int main()
{
    std::string err;
    cld::Config shipped;
    define_keys(&shipped);
    const bool loads = shipped.load("waze-on-cluster.conf", &err);
    ok("the shipped waze-on-cluster.conf loads with the defined keys" + (loads ? std::string() : ": " + err), loads);
    ok("guidance is on as shipped", shipped.num("guidance") == 1);

    cld::Config defaults;
    define_keys(&defaults);
    ok("guidance is on by default", defaults.num("guidance") == 1);
    std::string bad;
    ok("an undefined key is still refused", !defaults.set_pair("no_such_key=1", &bad) && !bad.empty());

    std::set<std::string> keys;
    DIR *d = opendir("src");
    ok("src/ opens (the test runs from the tool's directory)", d != nullptr);
    if (d) {
        while (dirent *e = readdir(d)) {
            const std::string name = e->d_name;
            if (name.size() > 4 && name.compare(name.size() - 4, 4, ".cpp") == 0)
                read_keys("src/" + name, &keys);
        }
        closedir(d);
    }
    ok("the program's reads found (turn_card, guidance, log_file among them)",
       keys.count("turn_card") && keys.count("guidance") && keys.count("log_file"));
    std::string undefined;
    for (const std::string &k : keys)
        if (!defaults.values().count(k))
            undefined += " " + k;
    ok("every key the program reads by name is defined" + (undefined.empty() ? std::string() : ", not:" + undefined),
       undefined.empty());

    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
