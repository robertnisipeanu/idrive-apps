/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* Host test for the settings (settings.h, config.h): the shipped
 * cluster-render.conf loads with every key known; id8_<name>_<field> taken
 * for any target name and each generation-8 field, every other unknown key
 * still refused, and by a Config without the family (waze-on-cluster's)
 * too; key += adding each entry once; a target declared by its keys alone
 * loaded on iDrive 8. Drop-ins, on files it writes: a widget target added;
 * read in the order of their paths, across patterns, a file matched twice
 * once, a skipped one not stopping the next, the earlier of two with one
 * content kept; drop_ins empty reading none; and every bad one skipped
 * whole with why, the settings as before it: an unknown key or line, a
 * missing scene id, a content or scene id another target's, a scene id not
 * allowed, a list set rather than added to, another key or another
 * target's key set, a symlink, writable by the group or others, another
 * owner.
 *
 *   settings_test   (from cluster-render's folder) */
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "../src/settings.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string dir;

/* The service's settings before the drop-ins, drop_ins this test's
 * folders: b's pattern first. */
static cld::Config base()
{
    cld::Config c;
    define_keys(&c);
    std::string err;
    c.set_pair("drop_ins = " + dir + "/b/*.conf " + dir + "/a/*.conf", &err);
    return c;
}

static void clear()
{
    const int r = std::system(("rm -f " + dir + "/a/* " + dir + "/b/*").c_str());
    (void)r;
}

static void put(const std::string &name, const std::string &text, mode_t mode = 0644)
{
    std::ofstream(dir + "/" + name) << text;
    chmod((dir + "/" + name).c_str(), mode);
}

static std::vector<std::string> read_drop_ins(cld::Config *c, uid_t owner = getuid())
{
    std::vector<std::string> report;
    load_drop_ins(c, owner, &report);
    return report;
}

static bool starts(const std::string &s, const std::string &with) { return s.compare(0, with.size(), with) == 0; }

/* A widget target as a tool ships it (cluster-render.conf's example). */
static std::string widget(const std::string &name = "mywidget", const std::string &content = "43204020",
                          const std::string &scene = "0x4d4755000020")
{
    const std::string k = "id8_" + name + "_";
    return "# " + name + "\n"
           "id8_targets += " + name + "\n"
           "id8_scene_ids_allowed += " + scene + "\n" +
           k + "category = 43100301\n" + k + "content = " + content + "\n" + k + "scene_id = " + scene + "\n" +
           k + "size = 2240x896\n" + k + "linger_ms = 3000\n" + k + "description = My widget\n" + k +
           "order = 60\n" + k + "focus = 0\n";
}

static std::string without(std::string text, const std::string &line)
{
    const size_t at = text.find(line);
    if (at != std::string::npos)
        text.erase(at, text.find('\n', at) + 1 - at);
    return text;
}

/* text as the only drop-in: skipped, why naming want, the settings as
 * before it. */
static bool skipped(const std::string &text, const std::string &want, mode_t mode = 0644, uid_t owner = getuid())
{
    clear();
    put("a/50-test.conf", text, mode);
    cld::Config c = base();
    const std::map<std::string, std::string> before = c.values();
    const std::vector<std::string> report = read_drop_ins(&c, owner);
    const bool r = report.size() == 1 && starts(report[0], "skipped " + dir + "/a/50-test.conf: ") &&
                   report[0].find(want) != std::string::npos && c.values() == before;
    for (size_t i = 0; !r && i < report.size(); i++)
        std::printf("     %s\n", report[i].c_str());
    return r;
}

static bool refused(cld::Config *c, const std::string &pair)
{
    std::string err;
    return !c->set_pair(pair, &err) && starts(err, "unknown setting ");
}

int main()
{
    char tmpl[] = "/tmp/settings_test.XXXXXX";
    if (!mkdtemp(tmpl))
        return 1;
    dir = tmpl;
    mkdir((dir + "/a").c_str(), 0755);
    mkdir((dir + "/b").c_str(), 0755);
    std::string err;

    {
        cld::Config c;
        define_keys(&c);
        ok("the shipped cluster-render.conf loads", c.load("cluster-render.conf", &err));
        ok("drop_ins as shipped",
           c.str("drop_ins") == "/var/opt/cluster-render/conf.d/*.conf /var/opt/*/current/cluster-render.d/*.conf");
    }

    {
        cld::Config c;
        define_keys(&c);
        bool all = true;
        for (const char *f : {"category", "content", "scene_id", "size", "linger_ms", "description", "order",
                              "preview", "background_id", "layouts", "focus"})
            all = all && c.set_pair(std::string("id8_mine2_") + f + " = 1", &err) &&
                  c.str((std::string("id8_mine2_") + f).c_str()) == "1";
        ok("id8_<name>_<field>: every generation-8 field taken for a new name", all);
        ok("id8_<name>_<field>: unset, empty", !c.has("id8_other_size") && c.str("id8_other_order").empty());
        ok("unknown field refused", refused(&c, "id8_mine_colour = red"));
        ok("upper case name refused", refused(&c, "id8_Mine_size = 64x64"));
        ok("name with _ refused", refused(&c, "id8_my_widget_size = 64x64"));
        ok("empty name refused", refused(&c, "id8__size = 64x64") && refused(&c, "id8_size = 64x64"));
        ok("other prefixes refused", refused(&c, "id7_mine_size = 64x64") && refused(&c, "mine_size = 64x64") &&
                                         refused(&c, "foo = 1") && refused(&c, "foo += 1"));
        cld::Config plain;
        ok("a Config without the family refuses them", refused(&plain, "id8_mine_size = 64x64"));
    }

    {
        cld::Config c;
        define_keys(&c);
        ok("+= appends each entry once",
           c.set_pair("id8_targets += mine, widget,mine", &err) && c.str("id8_targets") == "map,hud,guide,widget,popup,mine");
        ok("+= to an empty value", c.set_pair("id8_mine_layouts+=1", &err) && c.str("id8_mine_layouts") == "1");
        ok("= still replaces", c.set_pair("id8_targets = popup", &err) && c.str("id8_targets") == "popup");
    }

    {
        cld::Config c;
        define_keys(&c);
        for (const char *p : {"id8_targets += mine", "id8_scene_ids_allowed += 0x4d4755000020", "id8_mine_category = 43100301",
                              "id8_mine_content = 43204020", "id8_mine_scene_id = 0x4d4755000020", "id8_mine_size = 2240x896",
                              "id8_mine_linger_ms = 2000"})
            c.set_pair(p, &err);
        std::vector<TargetSpec> t;
        const bool loaded = load_targets(c, 8, &t, &err);
        ok("a target by its keys alone loads on iDrive 8",
           loaded && t.size() == 6 && t[5].name == "mine" && t[5].slot == 43100301 && t[5].content == 43204020 &&
               t[5].scene_id == 0x4d4755000020ull && t[5].width == 2240 && t[5].height == 896 && t[5].linger_ms == 2000);
        cld::Config d;
        define_keys(&d);
        d.set_pair("id8_targets += mine", &err);
        t.clear();
        ok("a new target with no keys refused", !load_targets(d, 8, &t, &err) && err.find("must be set") != std::string::npos);
    }

    {
        clear();
        put("a/50-mywidget.conf", widget());
        cld::Config c = base();
        const std::vector<std::string> report = read_drop_ins(&c);
        std::vector<TargetSpec> t;
        ok("a drop-in adds a widget target",
           report.size() == 1 && report[0] == "loaded " + dir + "/a/50-mywidget.conf" &&
               c.str("id8_targets") == "map,hud,guide,widget,popup,mywidget" && load_targets(c, 8, &t, &err) &&
               t.size() == 6 && t[5].name == "mywidget" && t[5].content == 43204020 &&
               c.str("id8_mywidget_description") == "My widget" && c.str("id8_widget_description") == "Cluster renderer");
    }

    {
        clear();
        put("b/05-z.conf", widget("z", "43204022", "0x4d4755000022"));
        put("a/20-y.conf", widget("y", "43204021", "0x4d4755000021"));
        put("a/10-x.conf", widget("x", "43204020", "0x4d4755000020"));
        put("a/15-bad.conf", "fps = 10\n");
        cld::Config c = base();
        const std::vector<std::string> report = read_drop_ins(&c);
        ok("in the order of their paths, across patterns; a skipped one does not stop the next",
           report.size() == 4 && report[0] == "loaded " + dir + "/a/10-x.conf" && starts(report[1], "skipped " + dir + "/a/15-bad.conf") &&
               report[2] == "loaded " + dir + "/a/20-y.conf" && report[3] == "loaded " + dir + "/b/05-z.conf" &&
               c.str("id8_targets") == "map,hud,guide,widget,popup,x,y,z");
    }

    {
        clear();
        put("a/10-x.conf", widget("x", "43204020", "0x4d4755000020"));
        put("a/20-y.conf", widget("y", "43204020", "0x4d4755000021"));
        cld::Config c = base();
        const std::vector<std::string> report = read_drop_ins(&c);
        ok("two with one content: the earlier kept",
           report.size() == 2 && starts(report[0], "loaded ") && starts(report[1], "skipped ") &&
               report[1].find("its content is target x's") != std::string::npos &&
               c.str("id8_targets") == "map,hud,guide,widget,popup,x" && !c.has("id8_y_content"));
    }

    {
        clear();
        put("a/10-x.conf", widget("x"));
        cld::Config c = base();
        c.set_pair("drop_ins = " + dir + "/a/*.conf " + dir + "/a/10-*", &err);
        ok("a file matched twice read once", read_drop_ins(&c).size() == 1);
        cld::Config none = base();
        none.set_pair("drop_ins =", &err);
        const std::map<std::string, std::string> before = none.values();
        ok("drop_ins empty: none read", read_drop_ins(&none).empty() && none.values() == before);
    }

    const std::string w = widget();
    ok("unknown key: skipped", skipped(w + "id8_mywidget_colour = red\n", "50-test.conf:12: unknown setting id8_mywidget_colour"));
    ok("a line that is no setting: skipped", skipped(w + "mywidget\n", "expected key=value"));
    ok("missing scene id: skipped",
       skipped(without(w, "id8_mywidget_scene_id"), "id8_mywidget_scene_id must be set"));
    ok("another target's content: skipped",
       skipped(widget("mywidget", "43204001"), "target mywidget: its content is target widget's"));
    ok("another target's scene id: skipped",
       skipped(widget("mywidget", "43204020", "0x4d4755000001"), "target mywidget: its scene id is target widget's"));
    ok("scene id not allowed: skipped",
       skipped(without(w, "id8_scene_ids_allowed"), "scene id 0x4d4755000020 is not in id8_scene_ids_allowed"));
    ok("id8_targets set, not added to: skipped",
       skipped(w + "id8_targets = mywidget\n", "id8_targets set: a drop-in only adds to it (+=)"));
    ok("id8_scene_ids_allowed set: skipped",
       skipped(w + "id8_scene_ids_allowed = 0x4d4755000020\n", "id8_scene_ids_allowed set"));
    ok("another key: skipped", skipped(w + "fps = 10\n", "fps set: a drop-in sets only the id8_ keys of the targets it adds"));
    ok("another target's key: skipped", skipped(w + "id8_widget_order = 1\n", "id8_widget_order set"));
    ok("a shipped target added again, its key set: skipped",
       skipped("id8_targets += widget\nid8_widget_focus = 1\n", "id8_widget_focus set"));
    ok("writable by the group: skipped", skipped(w, "writable by its group or others", 0664));
    ok("writable by others: skipped", skipped(w, "writable by its group or others", 0646));
    ok("another owner: skipped", skipped(w, "not owned by uid " + std::to_string((unsigned long)getuid() + 1), 0644,
                                         getuid() + 1));
    {
        clear();
        put("real.conf", w);
        const int r = symlink((dir + "/real.conf").c_str(), (dir + "/a/50-test.conf").c_str());
        cld::Config c = base();
        const std::map<std::string, std::string> before = c.values();
        const std::vector<std::string> report = read_drop_ins(&c);
        ok("a symlink: skipped", r == 0 && report.size() == 1 && report[0] == "skipped " + dir + "/a/50-test.conf: a symlink" &&
                                     c.values() == before);
    }

    const int removed = std::system(("rm -rf " + dir).c_str());
    (void)removed;
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
