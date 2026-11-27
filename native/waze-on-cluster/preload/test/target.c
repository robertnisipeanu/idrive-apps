// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The program preload_test.sh preloads libwocpatch.so into: a PIE with a
 * string in .rodata and a function whose immediate is in .text.
 *   target dump   the two sites as "<name> <vaddr hex> <bytes hex>"
 *   target        "<message> <answer()>", then the same from a child
 *                 (sh -c), which inherits LD_PRELOAD
 *   target read <file>
 *                 "<message> <answer()>", then the first line of <file>
 *                 as fopen, open and openat each read it (and errno when a
 *                 successful open left one), and whether an
 *                 open of it for writing names <file> itself */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <link.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

const char message[16] __attribute__((aligned(16))) = "stock message!!";
__attribute__((noinline)) int answer(void) { return 0x41414141; }

static int base_of(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    *(ElfW(Addr) *)data = info->dlpi_addr;
    return 1;
}

static void dump(const char *name, const void *at, size_t len, ElfW(Addr) base) {
    printf("%s %lx ", name, (unsigned long)((ElfW(Addr))at - base));
    for (size_t i = 0; i < len; i++) printf("%02x", ((const unsigned char *)at)[i]);
    printf("\n");
}

static void line_of(const char *how, int fd) {
    char b[64] = { 0 };
    ssize_t n = fd < 0 ? -1 : read(fd, b, sizeof b - 1);
    if (fd >= 0) close(fd);
    if (n > 0) b[strcspn(b, "\n")] = 0;
    printf("%s %s\n", how, n > 0 ? b : "-");
}

static void read_all(const char *file) {
    char b[64] = { 0 };
    FILE *f = fopen(file, "r");
    if (f && fgets(b, sizeof b, f)) b[strcspn(b, "\n")] = 0;
    if (f) fclose(f);
    printf("fopen %s\n", b[0] ? b : "-");
    errno = 0;
    int ofd = open(file, O_RDONLY), oerr = errno;
    line_of("open", ofd);
    if (ofd >= 0 && oerr) printf("errno %d\n", oerr);
    line_of("openat", openat(AT_FDCWD, file, O_RDONLY | O_CLOEXEC));
    /* For writing: the file itself, whatever the plan says. */
    int fd = open(file, O_WRONLY | O_APPEND);
    char link[64], got[256] = { 0 };
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    if (fd >= 0 && readlink(link, got, sizeof got - 1) > 0) printf("write %s\n", strcmp(got, file) == 0 ? "itself" : got);
    else printf("write -\n");
    if (fd >= 0) close(fd);
}

int main(int argc, char **argv) {
    ElfW(Addr) base = 0;
    dl_iterate_phdr(base_of, &base);
    if (argc > 1 && strcmp(argv[1], "dump") == 0) {
        dump("message", message, sizeof message, base);
        /* the 4-byte immediate of answer()'s mov eax,imm32 */
        const unsigned char *f = (const unsigned char *)answer;
        for (int i = 0; i < 16; i++) if (f[i] == 0xb8) { dump("answer", f + i + 1, 4, base); break; }
        return 0;
    }
    printf("%s %x\n", message, answer());
    if (argc > 2 && strcmp(argv[1], "read") == 0) read_all(argv[2]);
    fflush(stdout);
    if (argc == 1) return system("echo child");
    return 0;
}
