// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* libwocpatch.so: applies waze-on-cluster's carplay or aapd edits to the
 * running process's memory, before the program's own code runs. The file on
 * disk is never written (PATCH.md "In memory").
 *
 * carplay.service and aapd.service load it with LD_PRELOAD only when their
 * boot step armed this start: it wrote /run/woc-preload/<name>.env, which
 * the tool's drop-in names with EnvironmentFile=-, so without that file the
 * service starts as it ships. The env names the plan (WOC_PATCH_PLAN) and
 * the result file (WOC_PATCH_RESULT).
 *
 * The plan is made by the patcher's `plan` (carplay_patch.js,
 * aapd_patch.js), as root, from the binary on disk with the patcher's own
 * locator and checks: the build-id, and one line per edit region with its
 * address, the bytes the build ships there and the bytes to write. This
 * library finds nothing by itself. It applies every edit or none:
 *
 *   - the main program's GNU build-id must be the plan's: any other program
 *     (one the service starts, inheriting LD_PRELOAD) is left alone and
 *     writes no result;
 *   - the plan must be whole (a known version, every line well formed, its
 *     closing line with the edit count) and hold only kinds this library
 *     knows;
 *   - every region must lie in one PT_LOAD of the main program, inside its
 *     file-backed part and outside PT_GNU_RELRO, and read exactly its stock
 *     bytes.
 *
 * A plan may also name files the program reads in place of others
 * (`redirect <from> <to>`: aapd reads the copy of aapd.conf with the
 * cluster geometry in place of /etc/aapd.conf). Once every edit is applied,
 * and only then, each open of `from` for reading, by its exact path, opens
 * `to`: open, open64, openat, openat64, their _FORTIFY_SOURCE forms, fopen,
 * fopen64, freopen and freopen64, which the library exports for that,
 * while `to` exists (an open of `from` goes through as it is otherwise).
 * Every other call, and every call in a process the plan was not applied
 * to, goes to the C library unchanged. The C library's own functions are
 * looked up (dlsym) as the library starts, before the program's code runs;
 * a call another library's constructor makes before that looks its
 * function up then. One the C library lacks ends the process (abort).
 *
 * A plan that cannot be read or parsed names no program: it is reported on
 * stderr only, and the result file is left as it is.
 * Then each page is made writable, the bytes written, the page given its
 * segment's protection back, and every region read back. A code page stays
 * executable while it is written (read, write and execute for that
 * moment): libraries' constructors start threads before this one runs
 * (libdlt's dlt_receiver and dlt_segmented in carplay), and a page they
 * might run must never lose execute. None of them runs the program's own
 * code yet: its constructors and main have not run, and the edits are in
 * that code and its read-only data. A failure before
 * any write changes nothing; one after (an mprotect refused) makes every
 * page writable again, writes the stock bytes back and restores the
 * protections. Only a page that cannot get its protection back ends the
 * process (abort), which boot recovery counts as a crash of an armed
 * start. The result, applied or not and why, goes to WOC_PATCH_RESULT (a
 * file the boot step created for the service's user; never created here) and
 * to stderr, the journal.
 *
 * Built with the unit's toolchain (gcc 7.5, glibc 2.27). Exports the open
 * functions above and nothing else.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <link.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define PLAN_MAX (32 * 1024)
#define EDITS_MAX 32
#define BYTES_MAX 128
#define NAME_MAX_ 32
#define ID_MAX 64
#define PAGES_MAX (EDITS_MAX * 2)
#define REDIRECTS_MAX 4
#define PATH_MAX_ 128

struct redirect {
    char from[PATH_MAX_];
    char to[PATH_MAX_];
};

struct edit {
    char name[NAME_MAX_];
    uintptr_t vaddr;
    size_t len;
    unsigned char stock[BYTES_MAX];
    unsigned char patched[BYTES_MAX];
    unsigned char *at;
    int prot;               /* the segment's protection */
};

struct plan {
    unsigned char build_id[ID_MAX];
    size_t build_id_len;
    struct edit edits[EDITS_MAX];
    int n;
    struct redirect redirects[REDIRECTS_MAX];
    int nr;
};

/* The redirects in force: set once, by the constructor, after every edit
 * is applied; read by the open functions of every thread. */
static struct redirect active[REDIRECTS_MAX];
static int nactive;

struct image {
    uintptr_t base;
    const ElfW(Phdr) *phdr;
    int phnum;
    int found;
};

static struct plan plan;
static char why[256];

static void because(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(why, sizeof why, fmt, ap);
    va_end(ap);
}

/* The main program is the first object dl_iterate_phdr reports. */
static int first_object(struct dl_phdr_info *info, size_t size, void *data) {
    struct image *img = data;
    (void)size;
    img->base = info->dlpi_addr;
    img->phdr = info->dlpi_phdr;
    img->phnum = info->dlpi_phnum;
    img->found = 1;
    return 1;
}

/* The main program's GNU build-id, from its PT_NOTE segments in memory. */
static int build_id(const struct image *img, const unsigned char **id, size_t *len) {
    for (int i = 0; i < img->phnum; i++) {
        const ElfW(Phdr) *p = &img->phdr[i];
        if (p->p_type != PT_NOTE) continue;
        const unsigned char *at = (const unsigned char *)(img->base + p->p_vaddr), *end = at + p->p_memsz;
        while (at + sizeof(ElfW(Nhdr)) <= end) {
            const ElfW(Nhdr) *nh = (const ElfW(Nhdr) *)at;
            size_t name = (nh->n_namesz + 3) & ~(size_t)3, desc = (nh->n_descsz + 3) & ~(size_t)3;
            const unsigned char *n = at + sizeof *nh, *d = n + name;
            if (d + desc > end) break;
            if (nh->n_type == NT_GNU_BUILD_ID && nh->n_namesz == 4 && memcmp(n, "GNU", 4) == 0) {
                *id = d;
                *len = nh->n_descsz;
                return 0;
            }
            at = d + desc;
        }
    }
    return -1;
}

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

/* Lowercase hex of exactly 2*max bytes or fewer; returns the byte count, -1 when malformed. */
static long unhex(const char *s, size_t slen, unsigned char *out, size_t max) {
    if (slen == 0 || slen % 2 || slen / 2 > max) return -1;
    for (size_t i = 0; i < slen; i += 2) {
        int hi = hexval((unsigned char)s[i]), lo = hexval((unsigned char)s[i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i / 2] = (unsigned char)(hi << 4 | lo);
    }
    return (long)(slen / 2);
}

/* The next space-separated field of a line, or NULL. */
static const char *field(const char **at, const char *end, size_t *len) {
    const char *s = *at;
    while (s < end && *s == ' ') s++;
    if (s >= end) return NULL;
    const char *e = s;
    while (e < end && *e != ' ') e++;
    *len = (size_t)(e - s);
    *at = e;
    return s;
}

static int is(const char *s, size_t len, const char *word) { return len == strlen(word) && memcmp(s, word, len) == 0; }

/* The plan (the patcher's plan, "wocplan 1"):
 *   wocplan 1
 *   build-id <hex>
 *   edit <name> <vaddr hex> <stock hex> <patched hex>     (one per region)
 *   redirect <from> <to>                                  (any number up to
 *                                                          REDIRECTS_MAX;
 *                                                          absolute paths)
 *   end <edit count>
 * Any other line, kind or version refuses the plan. */
static int parse_plan(const char *text, size_t size) {
    const char *at = text, *end = text + size;
    int lines = 0, ended = 0;
    memset(&plan, 0, sizeof plan);
    while (at < end) {
        const char *nl = memchr(at, '\n', (size_t)(end - at));
        if (!nl) { because("plan: last line not ended"); return -1; }
        const char *p = at;
        size_t l1 = 0, l2 = 0, l3 = 0, l4 = 0, l5 = 0;
        const char *k = field(&p, nl, &l1);
        at = nl + 1;
        if (ended) { because("plan: lines after its end"); return -1; }
        if (!k) { because("plan: empty line"); return -1; }
        if (lines++ == 0) {
            const char *v = field(&p, nl, &l2);
            if (!is(k, l1, "wocplan") || !v || !is(v, l2, "1") || field(&p, nl, &l3)) { because("plan: not a version 1 plan"); return -1; }
        } else if (is(k, l1, "build-id")) {
            const char *v = field(&p, nl, &l2);
            long n = v ? unhex(v, l2, plan.build_id, ID_MAX) : -1;
            if (n <= 0 || field(&p, nl, &l3)) { because("plan: bad build-id"); return -1; }
            plan.build_id_len = (size_t)n;
        } else if (is(k, l1, "edit")) {
            if (plan.n >= EDITS_MAX) { because("plan: more than %d edits", EDITS_MAX); return -1; }
            struct edit *e = &plan.edits[plan.n];
            const char *nm = field(&p, nl, &l2), *va = field(&p, nl, &l3), *st = field(&p, nl, &l4), *pa = field(&p, nl, &l5);
            size_t l6 = 0;
            if (!nm || !va || !st || !pa || field(&p, nl, &l6) || l2 >= NAME_MAX_) { because("plan: bad edit line %d", lines); return -1; }
            memcpy(e->name, nm, l2);
            uintptr_t v = 0;
            for (size_t i = 0; i < l3; i++) {
                int h = hexval((unsigned char)va[i]);
                if (h < 0 || i >= 2 * sizeof v) { because("plan: bad address on line %d", lines); return -1; }
                v = v << 4 | (uintptr_t)h;
            }
            long ns = unhex(st, l4, e->stock, BYTES_MAX), np = unhex(pa, l5, e->patched, BYTES_MAX);
            if (ns <= 0 || ns != np) { because("plan: bad bytes on line %d", lines); return -1; }
            e->vaddr = v;
            e->len = (size_t)ns;
            plan.n++;
        } else if (is(k, l1, "redirect")) {
            if (plan.nr >= REDIRECTS_MAX) { because("plan: more than %d redirects", REDIRECTS_MAX); return -1; }
            struct redirect *r = &plan.redirects[plan.nr];
            const char *from = field(&p, nl, &l2), *to = field(&p, nl, &l3);
            if (!from || !to || field(&p, nl, &l4) || l2 >= PATH_MAX_ || l3 >= PATH_MAX_ || from[0] != '/' || to[0] != '/' ||
                memchr(from, 0, l2) || memchr(to, 0, l3)) {
                because("plan: bad redirect line %d", lines);
                return -1;
            }
            memcpy(r->from, from, l2);
            memcpy(r->to, to, l3);
            plan.nr++;
        } else if (is(k, l1, "end")) {
            const char *v = field(&p, nl, &l2);
            char num[16];
            if (!v || l2 >= sizeof num || field(&p, nl, &l3)) { because("plan: bad end line"); return -1; }
            memcpy(num, v, l2);
            num[l2] = 0;
            if (strtol(num, NULL, 10) != plan.n) { because("plan: %d edits, its end says %s", plan.n, num); return -1; }
            ended = 1;
        } else {
            because("plan: unknown line kind on line %d", lines);
            return -1;
        }
    }
    if (!ended) { because("plan: no end line (cut short)"); return -1; }
    if (!plan.build_id_len) { because("plan: no build-id"); return -1; }
    if (!plan.n) { because("plan: no edits"); return -1; }
    return 0;
}

static int read_file(const char *path, char *buf, size_t max, size_t *size) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t got = 0;
    for (;;) {
        ssize_t r = read(fd, buf + got, max - got);
        if (r < 0 && errno == EINTR) continue;
        if (r < 0) { close(fd); return -1; }
        if (r == 0) break;
        got += (size_t)r;
        if (got == max) { close(fd); errno = EFBIG; return -1; }
    }
    close(fd);
    *size = got;
    return 0;
}

static int threads(void) {
    static char buf[4096];
    size_t n;
    if (read_file("/proc/self/status", buf, sizeof buf - 1, &n) < 0) return -1;
    buf[n] = 0;
    char *t = strstr(buf, "\nThreads:");
    return t ? atoi(t + 9) : -1;
}

/* The other threads' names (/proc/self/task/<tid>/comm), for the log. */
static void thread_names(char *out, size_t max) {
    out[0] = 0;
    DIR *d = opendir("/proc/self/task");
    if (!d) return;
    struct dirent *e;
    size_t len = 0;
    while ((e = readdir(d)) && len + 24 < max) {
        if (e->d_name[0] == '.' || atol(e->d_name) == (long)getpid()) continue;
        char path[300], comm[32];
        size_t got = 0;
        snprintf(path, sizeof path, "/proc/self/task/%s/comm", e->d_name);
        if (read_file(path, comm, sizeof comm - 1, &got) < 0) continue;
        while (got && (comm[got - 1] == '\n')) got--;
        comm[got] = 0;
        for (char *c = comm; *c; c++)
            if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') || *c == '_' || *c == '-')) *c = '_';
        len += (size_t)snprintf(out + len, max - len, "%s%s", len ? "," : "", comm);
    }
    closedir(d);
}

/* Every region inside one file-backed PT_LOAD part, no two overlapping. */
static int place(const struct image *img) {
    for (int i = 0; i < plan.n; i++) {
        struct edit *e = &plan.edits[i];
        const ElfW(Phdr) *seg = NULL;
        for (int j = 0; j < img->phnum; j++) {
            const ElfW(Phdr) *p = &img->phdr[j];
            if (p->p_type == PT_LOAD && e->vaddr >= p->p_vaddr && e->vaddr + e->len <= p->p_vaddr + p->p_filesz) { seg = p; break; }
        }
        if (!seg) { because("%s: 0x%lx is not in a loaded part of the program", e->name, (unsigned long)e->vaddr); return -1; }
        for (int j = 0; j < img->phnum; j++) {
            const ElfW(Phdr) *p = &img->phdr[j];
            if (p->p_type == PT_GNU_RELRO && e->vaddr < p->p_vaddr + p->p_memsz && p->p_vaddr < e->vaddr + e->len) {
                because("%s: 0x%lx is in the relocated read-only data", e->name, (unsigned long)e->vaddr);
                return -1;
            }
        }
        e->at = (unsigned char *)(img->base + e->vaddr);
        e->prot = (seg->p_flags & PF_R ? PROT_READ : 0) | (seg->p_flags & PF_W ? PROT_WRITE : 0) | (seg->p_flags & PF_X ? PROT_EXEC : 0);
        for (int k = 0; k < i; k++) {
            const struct edit *o = &plan.edits[k];
            if (e->vaddr < o->vaddr + o->len && o->vaddr < e->vaddr + e->len) { because("%s overlaps %s", e->name, o->name); return -1; }
        }
    }
    return 0;
}

struct page { uintptr_t at; int prot; };

static int pages_of(struct page *pages, long psz) {
    int n = 0;
    for (int i = 0; i < plan.n; i++) {
        const struct edit *e = &plan.edits[i];
        uintptr_t first = (uintptr_t)e->at & ~(uintptr_t)(psz - 1), last = ((uintptr_t)e->at + e->len - 1) & ~(uintptr_t)(psz - 1);
        for (uintptr_t pg = first; pg <= last; pg += (uintptr_t)psz) {
            int seen = 0;
            for (int k = 0; k < n; k++) if (pages[k].at == pg) { seen = 1; if (pages[k].prot != e->prot) return -1; }
            if (seen) continue;
            if (n >= PAGES_MAX) return -1;
            pages[n].at = pg;
            pages[n].prot = e->prot;
            n++;
        }
    }
    return n;
}

static void put_stock(int upto) {
    for (int i = 0; i < upto; i++) memcpy(plan.edits[i].at, plan.edits[i].stock, plan.edits[i].len);
}

/* All or nothing. 0 when applied. */
static int apply(void) {
    static struct page pages[PAGES_MAX];
    long psz = sysconf(_SC_PAGESIZE);
    if (psz <= 0) { because("no page size"); return -1; }
    for (int i = 0; i < plan.n; i++) {
        const struct edit *e = &plan.edits[i];
        if (memcmp(e->at, e->stock, e->len) != 0) {
            because("%s at 0x%lx does not read as the plan's stock bytes%s", e->name, (unsigned long)e->vaddr,
                    memcmp(e->at, e->patched, e->len) == 0 ? " (it reads patched: a patched file on disk?)" : "");
            return -1;
        }
    }
    int n = pages_of(pages, psz);
    if (n < 0) { because("edit pages: too many, or one in two segments"); return -1; }
    int opened = 0;
    for (; opened < n; opened++) {
        if (mprotect((void *)pages[opened].at, (size_t)psz, PROT_READ | PROT_WRITE | (pages[opened].prot & PROT_EXEC)) != 0) break;
    }
    if (opened < n) {
        int err = errno;
        for (int k = 0; k < opened; k++)
            if (mprotect((void *)pages[k].at, (size_t)psz, pages[k].prot) != 0) {
                static const char msg[] = "wocpatch: a page could not get its protection back; aborting\n";
                (void)!write(2, msg, sizeof msg - 1);
                abort();
            }
        because("mprotect writable: %s", strerror(err));
        return -1;
    }
    for (int i = 0; i < plan.n; i++) memcpy(plan.edits[i].at, plan.edits[i].patched, plan.edits[i].len);
    const char *bad = NULL;
    for (int i = 0; i < plan.n; i++) if (memcmp(plan.edits[i].at, plan.edits[i].patched, plan.edits[i].len) != 0) { bad = "the written bytes did not read back"; break; }
    if (bad) put_stock(plan.n);
    int failed = 0;
    for (int k = 0; k < n; k++) if (mprotect((void *)pages[k].at, (size_t)psz, pages[k].prot) != 0) failed++;
    if (failed) {
        /* A page kept its writable protection: every page writable again
         * (each was, a moment ago), the stock bytes back, then each page its
         * segment's protection. The program cannot run with a page that does
         * not get it back. */
        static const char msg[] = "wocpatch: a page could not get its protection back; aborting\n";
        for (int k = 0; k < n; k++)
            if (mprotect((void *)pages[k].at, (size_t)psz, PROT_READ | PROT_WRITE | (pages[k].prot & PROT_EXEC)) != 0) {
                (void)!write(2, msg, sizeof msg - 1);
                abort();
            }
        put_stock(plan.n);
        for (int k = 0; k < n; k++)
            if (mprotect((void *)pages[k].at, (size_t)psz, pages[k].prot) != 0) {
                (void)!write(2, msg, sizeof msg - 1);
                abort();
            }
        bad = "mprotect: a page did not take its protection back; the stock bytes are back";
    }
    if (bad) { because("%s", bad); return -1; }
    return 0;
}

static void report(int applied) {
    char out[2048], names[160];
    thread_names(names, sizeof names);
    int len = snprintf(out, sizeof out, "{\"v\":1,\"pid\":%ld,\"applied\":%s,\"threads\":%d,\"others\":\"%s\",\"edits\":[", (long)getpid(), applied ? "true" : "false",
                       threads(), names);
    for (int i = 0; applied && i < plan.n && len < (int)sizeof out - 64; i++)
        len += snprintf(out + len, sizeof out - (size_t)len, "%s\"%s\"", i ? "," : "", plan.edits[i].name);
    len += snprintf(out + len, sizeof out - (size_t)len, "],\"why\":\"");
    for (const char *c = applied ? "" : why; *c && len < (int)sizeof out - 4; c++) {
        if (*c == '"' || *c == '\\') out[len++] = '\\';
        out[len++] = (unsigned char)*c < 0x20 ? ' ' : *c;
    }
    len += snprintf(out + len, sizeof out - (size_t)len, "\"}\n");
    const char *path = getenv("WOC_PATCH_RESULT");
    if (path) {
        int fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC | O_NOFOLLOW);
        if (fd >= 0) { (void)!write(fd, out, (size_t)len); close(fd); }
    }
    char line[512];
    int l = applied ? snprintf(line, sizeof line, "wocpatch: applied %d edits in memory\n", plan.n)
                    : snprintf(line, sizeof line, "wocpatch: not applied, the program runs as it ships: %s\n", why);
    if (l > 0) (void)!write(2, line, (size_t)(l < (int)sizeof line ? l : (int)sizeof line - 1));
}

/* ---- the redirects ------------------------------------------------------ */

/* The file to open in place of `path` for a read: its redirect's target
 * while that exists, else `path` itself. */
static const char *redirected(const char *path, int reading) {
    int n = __atomic_load_n(&nactive, __ATOMIC_ACQUIRE);
    if (!reading || !path) return path;
    for (int i = 0; i < n; i++) {
        if (strcmp(path, active[i].from) != 0) continue;
        int saved = errno, there = access(active[i].to, F_OK) == 0;
        errno = saved;
        return there ? active[i].to : path;
    }
    return path;
}

static int reads(int flags) { return (flags & O_ACCMODE) == O_RDONLY && !(flags & (O_CREAT | O_TRUNC)); }
static int reads_mode(const char *mode) { return mode && mode[0] == 'r' && !strchr(mode, '+'); }
/* open's mode argument: given with O_CREAT or O_TMPFILE only. */
static int wants_mode(int flags) { return (flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE; }

/* The C library's function `name`, looked up once. */
static void *next(void **slot, const char *name) {
    void *f = __atomic_load_n(slot, __ATOMIC_ACQUIRE);
    if (!f) {
        f = dlsym(RTLD_NEXT, name);
        if (!f) { static const char msg[] = "wocpatch: no next open function; aborting\n"; (void)!write(2, msg, sizeof msg - 1); abort(); }
        __atomic_store_n(slot, f, __ATOMIC_RELEASE);
    }
    return f;
}

/* Each function is defined under its own name with an asm label, which
 * keeps it clear of the C library's _FORTIFY_SOURCE inline of open. */
#define EXPORT __attribute__((visibility("default")))
#define OPEN_LIKE(fn, sym)                                                                     \
    static void *real_##fn;                                                                  \
    EXPORT int fn(const char *path, int flags, ...) __asm__(sym);                              \
    int fn(const char *path, int flags, ...) {                                                 \
        mode_t mode = 0;                                                                       \
        if (wants_mode(flags)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); } \
        return ((int (*)(const char *, int, ...))next(&real_##fn, sym))(redirected(path, reads(flags)), flags, mode); \
    }
#define OPENAT_LIKE(fn, sym)                                                                   \
    static void *real_##fn;                                                                  \
    EXPORT int fn(int dir, const char *path, int flags, ...) __asm__(sym);                     \
    int fn(int dir, const char *path, int flags, ...) {                                        \
        mode_t mode = 0;                                                                       \
        if (wants_mode(flags)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); } \
        return ((int (*)(int, const char *, int, ...))next(&real_##fn, sym))(dir, redirected(path, reads(flags)), flags, mode); \
    }
#define OPEN2_LIKE(fn, sym)                                                                    \
    static void *real_##fn;                                                                  \
    EXPORT int fn(const char *path, int flags) __asm__(sym);                                   \
    int fn(const char *path, int flags) {                                                      \
        return ((int (*)(const char *, int))next(&real_##fn, sym))(redirected(path, reads(flags)), flags); \
    }
#define OPENAT2_LIKE(fn, sym)                                                                  \
    static void *real_##fn;                                                                  \
    EXPORT int fn(int dir, const char *path, int flags) __asm__(sym);                          \
    int fn(int dir, const char *path, int flags) {                                             \
        return ((int (*)(int, const char *, int))next(&real_##fn, sym))(dir, redirected(path, reads(flags)), flags); \
    }
#define FOPEN_LIKE(fn, sym)                                                                    \
    static void *real_##fn;                                                                  \
    EXPORT FILE *fn(const char *path, const char *mode) __asm__(sym);                          \
    FILE *fn(const char *path, const char *mode) {                                             \
        return ((FILE *(*)(const char *, const char *))next(&real_##fn, sym))(redirected(path, reads_mode(mode)), mode); \
    }
#define FREOPEN_LIKE(fn, sym)                                                                  \
    static void *real_##fn;                                                                  \
    EXPORT FILE *fn(const char *path, const char *mode, FILE *f) __asm__(sym);                 \
    FILE *fn(const char *path, const char *mode, FILE *f) {                                    \
        return ((FILE *(*)(const char *, const char *, FILE *))next(&real_##fn, sym))(redirected(path, reads_mode(mode)), mode, f); \
    }

#define INTERPOSERS(X)                                                                         \
    X(OPEN_LIKE, woc_open, "open") X(OPEN_LIKE, woc_open64, "open64")                          \
    X(OPENAT_LIKE, woc_openat, "openat") X(OPENAT_LIKE, woc_openat64, "openat64")              \
    X(OPEN2_LIKE, woc_open_2, "__open_2") X(OPEN2_LIKE, woc_open64_2, "__open64_2")            \
    X(OPENAT2_LIKE, woc_openat_2, "__openat_2") X(OPENAT2_LIKE, woc_openat64_2, "__openat64_2") \
    X(FOPEN_LIKE, woc_fopen, "fopen") X(FOPEN_LIKE, woc_fopen64, "fopen64")                    \
    X(FREOPEN_LIKE, woc_freopen, "freopen") X(FREOPEN_LIKE, woc_freopen64, "freopen64")
#define DEFINE(kind, fn, sym) kind(fn, sym)
INTERPOSERS(DEFINE)

/* Every one of them looked up now, so no call after this one looks one up
 * (dlsym is not safe in a signal handler or a child of fork). */
#define RESOLVE(kind, fn, sym) next(&real_##fn, sym);
static void resolve_all(void) { INTERPOSERS(RESOLVE) }

__attribute__((constructor)) static void wocpatch_init(void) {
    static char text[PLAN_MAX];
    resolve_all();
    const char *path = getenv("WOC_PATCH_PLAN");
    if (!path) return;
    struct image img = { 0 };
    dl_iterate_phdr(first_object, &img);
    if (!img.found) return;
    const unsigned char *id;
    size_t idlen;
    size_t size;
    /* A plan that cannot be read names no program: the line goes to
     * stderr, and the result file, which may be another process's, stays
     * as it is. Not the plan's program: nothing, not even a result. */
    if (read_file(path, text, sizeof text, &size) < 0) {
        static char line[400];
        int l = snprintf(line, sizeof line, "wocpatch: not applied: plan %s: %s\n", path, strerror(errno));
        if (l > 0) (void)!write(2, line, (size_t)(l < (int)sizeof line ? l : (int)sizeof line - 1));
        return;
    }
    if (parse_plan(text, size) < 0) {
        static char line[400];
        int l = snprintf(line, sizeof line, "wocpatch: not applied: %s\n", why);
        if (l > 0) (void)!write(2, line, (size_t)(l < (int)sizeof line ? l : (int)sizeof line - 1));
        return;
    }
    if (build_id(&img, &id, &idlen) < 0 || idlen != plan.build_id_len || memcmp(id, plan.build_id, idlen) != 0) return;
    if (place(&img) < 0 || apply() < 0) { report(0); return; }
    memcpy(active, plan.redirects, sizeof active);
    __atomic_store_n(&nactive, plan.nr, __ATOMIC_RELEASE);
    report(1);
#ifdef WOC_TEST_CRASH
    /* Test builds only (make test-preload): an armed start that crashes. */
    abort();
#endif
}
