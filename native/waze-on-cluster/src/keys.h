// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The settings keys this tool reads beyond the shared Config's own, with
 * their defaults. The Config refuses a key nobody defined, so the shipped
 * waze-on-cluster.conf loads only when every key it sets is here, and a key
 * read but not defined is always empty: test/keys_test.cpp checks both. */
#ifndef WOC_KEYS_H
#define WOC_KEYS_H

#include "config.h"

/* Registered before any conf is loaded, so Config accepts them. */
void define_keys(cld::Config *cfg);

#endif
