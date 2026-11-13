/* SPDX-License-Identifier: GPL-3.0-or-later
 * Bounded Linux x86-64 destination reader. No target code/data writes.
 * Requires existing ptrace permission; never changes system tracing policy.
 */
#define _GNU_SOURCE
#define OPENSSL_SUPPRESS_DEPRECATED
#include <sys/ptrace.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <elf.h>
#include <openssl/sha.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <math.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error Requires Linux x86-64
#endif
typedef struct { const char *hash; uint64_t site, code_start; unsigned char code[13]; } Profile;
static const Profile firmware = {"7eda610dd0831377b8224733cd88ae3e46fedf136fcbe3b465308a5b00f3129f",0x2c9d29,0x2c9d21,{0x48,0x8b,0x7c,0x24,0x30,0x4c,0x89,0xfe,0xe8,0x52,0x13,0x1f,0x00}};
typedef struct { pid_t tid; int stopped,saved,signal; unsigned long dr[3]; } Task;
typedef struct { pid_t pid; int mem,count; Task tasks[128]; uint64_t start,bias,site; const Profile *profile; char address[8193]; } Tap;
static volatile sig_atomic_t cancelled;
static const char *failure;
static int fail(const char *s) { failure=s; return -1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
static void cancel(int sig) { (void)sig; cancelled=1; }
static int trace(int op,pid_t tid,unsigned long addr,unsigned long data,unsigned long *result) {
    errno=0; long r=ptrace(op,tid,(void*)addr,(void*)data);
    if(r==-1 && errno) return -1;
    if(result) *result=(unsigned long)r;
    return 0;
}
#define DR(i) (offsetof(struct user,u_debugreg)+(i)*sizeof(unsigned long))
static int exact(Tap *t,uint64_t address,void *out,size_t size) {
    if(size>65536 || address<4096 || address>=(1ULL<<47) || size>=(1ULL<<47)-address) return fail("Invalid memory range");
    ssize_t got; do {got=pread(t->mem,out,size,(off_t)address);} while(got<0 && errno==EINTR);
    return got==(ssize_t)size?0:fail("Short memory read");
}
static uint64_t identity(pid_t pid) {
    char path[64],line[4096]; snprintf(path,sizeof(path),"/proc/%d/stat",pid);
    FILE *f=fopen(path,"r"); if(!f)return 0;
    char *r=fgets(line,sizeof(line),f); fclose(f); if(!r)return 0;
    r=strrchr(line,')'); if(!r)return 0;
    char *save,*word=strtok_r(r+2," ",&save);
    for(int i=0;i<19 && word;i++)word=strtok_r(NULL," ",&save);
    return word?strtoull(word,NULL,10):0;
}
static int compare_pid(const void *a,const void *b) {pid_t x=*(const pid_t*)a,y=*(const pid_t*)b; return (x>y)-(x<y);}
static int threads(pid_t pid,pid_t out[128]) {
    char path[64]; snprintf(path,sizeof(path),"/proc/%d/task",pid); DIR *d=opendir(path); if(!d)return -1;
    int n=0; struct dirent *e;
    while((e=readdir(d))) {char *end; long v=strtol(e->d_name,&end,10); if(*end || v<=0)continue;
        if(n==128){closedir(d);return -1;} out[n++]=(pid_t)v;}
    closedir(d); qsort(out,n,sizeof(*out),compare_pid); return n;
}
static int same_process(Tap *t) {
    pid_t ids[128]; int n=threads(t->pid,ids);
    if(identity(t->pid)!=t->start || n!=t->count)return fail("Process/thread topology changed");
    for(int i=0;i<n;i++)if(ids[i]!=t->tasks[i].tid)return fail("Process/thread topology changed");
    return 0;
}
static int hash_file(int fd,char hex[65]) {
    SHA256_CTX c; unsigned char buf[16384],digest[32]; SHA256_Init(&c);
    if(lseek(fd,0,SEEK_SET)<0)return -1;
    ssize_t n; while((n=read(fd,buf,sizeof(buf)))!=0){if(n<0){if(errno==EINTR)continue;return -1;} SHA256_Update(&c,buf,(size_t)n);}
    SHA256_Final(digest,&c); for(int i=0;i<32;i++)sprintf(hex+i*2,"%02x",digest[i]); return 0;
}
static int verify(Tap *t) {
    char path[64],hex[65],line[4096]; snprintf(path,sizeof(path),"/proc/%d/exe",t->pid);
    int fd=open(path,O_RDONLY); if(fd<0)return fail("Cannot open executable");
    Elf64_Ehdr eh; Elf64_Phdr ph; struct stat st; int ok=0; uint64_t zero=0;
    if(hash_file(fd,hex)<0 || strcmp(hex,t->profile->hash)){close(fd);return fail("Unsupported executable hash");}
    if(pread(fd,&eh,sizeof(eh),0)!=sizeof(eh) || memcmp(eh.e_ident,"\177ELF\2\1",6) || eh.e_machine!=EM_X86_64 || eh.e_phentsize!=sizeof(ph) || eh.e_phnum>1024 || fstat(fd,&st)<0){close(fd);return fail("Invalid x86-64 ELF");}
    for(int i=0;i<eh.e_phnum;i++)if(pread(fd,&ph,sizeof(ph),eh.e_phoff+i*sizeof(ph))==sizeof(ph) && ph.p_type==PT_LOAD && ph.p_offset==0){zero=ph.p_vaddr&~4095ULL;ok=1;break;}
    close(fd); if(!ok)return fail("No ELF load segment");
    snprintf(path,sizeof(path),"/proc/%d/maps",t->pid); FILE *f=fopen(path,"r"); if(!f)return fail("Cannot read maps");
    unsigned long long a,b,off,ino; unsigned major_dev,minor_dev; char perm[5]; ok=0;
    while(fgets(line,sizeof(line),f))if(sscanf(line,"%llx-%llx %4s %llx %x:%x %llu",&a,&b,perm,&off,&major_dev,&minor_dev,&ino)==7 && ino==st.st_ino && major_dev==major(st.st_dev) && minor_dev==minor(st.st_dev) && off==0){t->bias=a-zero;ok=1;break;}
    if(!ok){fclose(f);return fail("No executable mapping");} t->site=t->bias+t->profile->site;
    rewind(f); ok=0;
    while(fgets(line,sizeof(line),f))if(sscanf(line,"%llx-%llx %4s %llx %x:%x %llu",&a,&b,perm,&off,&major_dev,&minor_dev,&ino)==7 && ino==st.st_ino && major_dev==major(st.st_dev) && minor_dev==minor(st.st_dev) && a<=t->site && t->site<b && strchr(perm,'x'))ok=1;
    fclose(f); return ok?0:fail("Callback is not executable");
}
static int callback_bytes(Tap *t) {unsigned char b[13]; return exact(t,t->bias+t->profile->code_start,b,sizeof(b))<0?-1:memcmp(b,t->profile->code,sizeof(b))?fail("Runtime callback bytes differ"):0;}
static int owned_stop(Tap *t,Task *task,int status) {
    struct user_regs_struct r; unsigned long dr6;
    return WSTOPSIG(status)==SIGTRAP && !(status>>16) && task->saved &&
        trace(PTRACE_GETREGS,task->tid,0,(unsigned long)&r,NULL)==0 &&
        trace(PTRACE_PEEKUSER,task->tid,DR(6),0,&dr6)==0 && r.rip==t->site && (dr6&1);
}
static int stop_status(Tap *t,Task *task,int status) {
    if(!WIFSTOPPED(status))return fail("Target thread exited");
    task->stopped=1; task->signal=(!(status>>16) && !owned_stop(t,task,status))?WSTOPSIG(status):0;
    return 0;
}
static int wait_stop(Tap *t,Task *task) {
    double deadline=now()+2; int status;
    do {pid_t r=waitpid(task->tid,&status,WNOHANG|__WALL);
        if(r==task->tid)return stop_status(t,task,status);
        if(r<0 && errno!=EINTR)return -1;
        usleep(2000);
    }while(now()<deadline);
    return fail("Thread stop timed out");
}
static int resume(Task *task) {
    if(trace(PTRACE_CONT,task->tid,0,task->signal,NULL)<0)return fail("Cannot resume target");
    task->signal=0; task->stopped=0; return 0;
}
static int arm(Tap *t) {
    pid_t ids[128]; int n=threads(t->pid,ids); if(n<=0)return fail("Unsupported thread count");
    for(int i=0;i<n;i++) {
        if(cancelled)return fail("Capture cancelled");
        if(trace(PTRACE_SEIZE,ids[i],0,0,NULL)<0)return fail("Cannot attach to target");
        Task *task=&t->tasks[t->count++]; task->tid=ids[i];
        if(trace(PTRACE_INTERRUPT,task->tid,0,0,NULL)<0 || wait_stop(t,task)<0)return fail("Cannot stop target");
    }
    if(same_process(t)<0)return -1;
    char path[64]; snprintf(path,sizeof(path),"/proc/%d/mem",t->pid); t->mem=open(path,O_RDONLY); if(t->mem<0)return fail("Cannot read target memory");
    if(callback_bytes(t)<0)return -1;
    const int indexes[]={0,6,7};
    for(int i=0;i<n;i++) {
        Task *task=&t->tasks[i];
        for(int j=0;j<3;j++)if(trace(PTRACE_PEEKUSER,task->tid,DR(indexes[j]),0,&task->dr[j])<0)return fail("Cannot read debug registers");
        if(task->dr[2]&255)return fail("Existing hardware breakpoints");
        task->saved=1;
        if(trace(PTRACE_POKEUSER,task->tid,DR(0),t->site,NULL)<0 || trace(PTRACE_POKEUSER,task->tid,DR(6),0,NULL)<0 || trace(PTRACE_POKEUSER,task->tid,DR(7),1,NULL)<0)return fail("Cannot arm breakpoint");
    }
    for(int i=0;i<n;i++)if(resume(&t->tasks[i])<0)return -1;
    return 0;
}
/* Validate UTF-8 strictly. Trim Unicode whitespace and cap at 2048 codepoints,
 * matching the former Python reader (the JS receiver imposes its own limit).
 */
static int whitespace(uint32_t c) {return (c>=9 && c<=13)||(c>=28 && c<=32)||c==0x85||c==0xa0||c==0x1680||(c>=0x2000 && c<=0x200a)||c==0x2028||c==0x2029||c==0x202f||c==0x205f||c==0x3000;}
static int text_value(const unsigned char *s,size_t n,char out[8193]) {
    size_t begin=n,end=0,limit=n; unsigned count=0;
    for(size_t i=0;i<n;) {size_t pos=i; uint32_t c=s[i++]; int more=0;
        if(c>=0xc2 && c<=0xdf){c&=31;more=1;}else if(c>=0xe0 && c<=0xef){c&=15;more=2;}else if(c>=0xf0 && c<=0xf4){c&=7;more=3;}else if(c>=128 || !c)return fail("Invalid address UTF-8");
        if(i+(size_t)more>n)return fail("Invalid address UTF-8");
        for(int j=0;j<more;j++){unsigned x=s[i++];if((x&192)!=128)return fail("Invalid address UTF-8");c=(c<<6)|(x&63);}
        if((more==1 && c<128)||(more==2 && c<2048)||(more==3 && c<65536)||c>0x10ffff||(c>=0xd800 && c<=0xdfff))return fail("Invalid address UTF-8");
        if(!whitespace(c)){if(begin==n)begin=pos;end=i;}
        if(begin!=n && ++count==2048)limit=i;
    }
    if(begin==n){out[0]=0;return 0;} if(end>limit)end=limit;
    memcpy(out,s+begin,end-begin);out[end-begin]=0;return 0;
}
static int snapshot(Tap *t,uint64_t state,char chosen[8193]) {
    uint64_t v[3]; unsigned total=0; chosen[0]=0;
    if(state>(1ULL<<47)-24 || exact(t,state+24,v,sizeof(v))<0)return -1;
    if(v[0]>v[1]||v[1]>v[2]||(v[1]-v[0])%32||(v[2]-v[0])%32||(v[1]-v[0])/32>16||v[2]-v[0]>65536||(!v[0]&&(v[1]||v[2])))return fail("Invalid address vector");
    for(uint64_t a=v[0];a<v[1];a+=32) {
        uint64_t str[2]; unsigned char bytes[4096]; char value[8193];
        if(exact(t,a,str,sizeof(str))<0)return -1;
        if(str[1]>4096 || (total+=str[1])>65536)return fail("Address exceeds bounds");
        if(str[1] && exact(t,str[0],bytes,str[1])<0)return -1;
        if(text_value(bytes,str[1],value)<0)return -1;
        if(!chosen[0] && value[0])strcpy(chosen,value);
    }
    return 0;
}
static int cleanup(Tap *t) {
    int errors=0; const int indexes[]={0,6,7};
    for(int i=0;i<t->count;i++) {
        Task *task=&t->tasks[i];
        if(!task->stopped){if(trace(PTRACE_INTERRUPT,task->tid,0,0,NULL)<0 && errno!=ESRCH){errors++;continue;}
            if(wait_stop(t,task)<0){if(errno!=ESRCH && errno!=ECHILD)errors++;continue;}}
        if(task->saved)for(int j=0;j<3;j++)if(trace(PTRACE_POKEUSER,task->tid,DR(indexes[j]),task->dr[j],NULL)<0 && errno!=ESRCH)errors++;
        if(trace(PTRACE_DETACH,task->tid,0,task->signal,NULL)<0 && errno!=ESRCH)errors++;
    }
    t->count=0;if(t->mem>=0){close(t->mem);t->mem=-1;}
    return errors?fail("Detach incomplete"):0;
}
static int collect(Tap *t,double seconds,int max_events) {
    int result=-1,events=0; t->mem=-1;t->start=identity(t->pid);
    if(!t->start)return fail("Target does not exist");
    if(verify(t)<0)return -1;
    if(arm(t)<0)goto done;
    double deadline=now()+seconds;
    while(now()<deadline && events<max_events && !cancelled) {
        if(same_process(t)<0)goto done;
        for(int i=0;i<t->count && events<max_events;i++) {
            Task *task=&t->tasks[i]; int status; pid_t got=waitpid(task->tid,&status,WNOHANG|__WALL);
            if(got<0){if(errno==EINTR)continue;fail("Target wait failed");goto done;} if(!got)continue;
            if(stop_status(t,task,status)<0)goto done;
            if(!owned_stop(t,task,status)){fail("Unexpected target stop");goto done;}
            struct user_regs_struct regs;
            if(trace(PTRACE_GETREGS,task->tid,0,(unsigned long)&regs,NULL)<0){fail("Cannot read registers");goto done;}
            if(regs.rsi!=regs.r15){fail("Unexpected callback registers");goto done;}
            char address[8193];
            if(callback_bytes(t)<0 || snapshot(t,regs.rsi,address)<0)goto done;
            regs.eflags|=1<<16;
            if(trace(PTRACE_SETREGS,task->tid,0,(unsigned long)&regs,NULL)<0 || trace(PTRACE_POKEUSER,task->tid,DR(6),0,NULL)<0 || resume(task)<0){fail("Cannot resume callback");goto done;}
            if(address[0])strcpy(t->address,address);
            events++;
        }
        usleep(2000);
    }
    result=0;
done:
    {const char *reason=failure; if(cleanup(t)<0)return -1;failure=reason;}
    return result;
}
static pid_t find_target(void) {
    DIR *d=opendir("/proc");if(!d)return 0; struct dirent *e;pid_t found=0;int count=0;
    while((e=readdir(d))) {char *end,path[64],comm[64];long pid=strtol(e->d_name,&end,10);if(*end||pid<=0)continue;
        snprintf(path,sizeof(path),"/proc/%ld/comm",pid);FILE *f=fopen(path,"r");if(!f)continue;
        if(fgets(comm,sizeof(comm),f) && !strcmp(comm,"aapd\n")){found=(pid_t)pid;count++;}fclose(f);}
    closedir(d);return count==1?found:0;
}
static void output(const char *address) {
    fputs("{\"address\":",stdout);if(!*address)fputs("null",stdout);else {putchar('"');for(const unsigned char *p=(const unsigned char*)address;*p;p++){if(*p=='"'||*p=='\\'){putchar('\\');putchar(*p);}else if(*p<32)printf("\\u%04x",*p);else putchar(*p);}putchar('"');}puts(",\"detached\":true}");
}
#ifndef READER_TEST
int main(int argc,char **argv) {
    double seconds=10;int max_events=16;pid_t pid=0;
    for(int i=1;i<argc;i+=2){if(i+1==argc){fputs("Missing argument\n",stderr);return 1;}char *end;
        double n=strtod(argv[i+1],&end);if(*end || !isfinite(n)){fputs("Invalid argument\n",stderr);return 1;}
        if(!strcmp(argv[i],"--seconds") && n>0 && n<=30)seconds=n;
        else if(!strcmp(argv[i],"--max-events") && n>=1 && n<=100 && n==(int)n)max_events=(int)n;
        else if(!strcmp(argv[i],"--pid") && n>0 && n<=2147483647 && n==(int)n)pid=(pid_t)n;
        else {fputs("Invalid argument or capture limit\n",stderr);return 1;}}
    struct sigaction sa={0};sa.sa_handler=cancel;sigemptyset(&sa.sa_mask);sigaction(SIGTERM,&sa,NULL);sigaction(SIGINT,&sa,NULL);
    if(!pid)pid=find_target();
    if(!pid){fputs("Expected exactly one aapd process\n",stderr);return 1;}
    Tap t={0};t.pid=pid;t.profile=&firmware;
    if(collect(&t,seconds,max_events)<0){fprintf(stderr,"%s\n",failure?failure:"Reader failed");return 1;}
    output(t.address);return 0;
}
#endif
