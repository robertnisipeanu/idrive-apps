/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Settings: a key = value file, then -s key=value overrides in order.
 * Unknown keys are an error. The built-in keys and defaults are
 * cluster-demo's; a tool adds its own with define(). */
#ifndef CLD_CONFIG_H
#define CLD_CONFIG_H

#include <map>
#include <string>

namespace cld {

class Config {
public:
    Config();

    /* Register an extra key and its default, for a tool that reuses this
     * Config with keys beyond cluster-demo's own. Idempotent; a key already
     * present keeps its value. Call before load()/set_pair(). */
    void define(const char *key, const char *def);

    bool load(const std::string &path, std::string *err);
    bool set_pair(const std::string &pair, std::string *err);

    std::string str(const char *key) const;
    long num(const char *key) const;
    /* "w x h" or "wxh"; false when unset or malformed. */
    bool size(const char *key, unsigned *w, unsigned *h) const;
    /* An unset value (empty) for slot keys means "not configured". */
    bool has(const char *key) const;

private:
    bool set(const std::string &key, const std::string &value, std::string *err);
    std::map<std::string, std::string> values_;
};

}  // namespace cld

#endif
