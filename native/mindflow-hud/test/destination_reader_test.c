/* Controlled child-process test; no car or permission-policy changes. */
#define READER_TEST
#include "../destination_reader.c"
#include <assert.h>
#include <pthread.h>
#include <dlfcn.h>
#include <sys/mman.h>

typedef struct {const char *p; uint64_t size,unused[2];} Str;
typedef struct {uint64_t pad[3]; Str *begin,*end,*cap;} State;
extern void test_callback(State *state);
extern char test_site[];
__asm__(".text\n.globl test_callback\ntest_callback:\npush %r15\nmov %rdi,%rsi\nmov %rdi,%r15\n.globl test_site\ntest_site:\n.rept 13\nnop\n.endr\npop %r15\nret\n");
static volatile sig_atomic_t delivered;
static volatile sig_atomic_t *signal_seen;
static void received(int sig){(void)sig;delivered=1;*signal_seen=1;}
static void *sleeper(void *v){(void)v;for(;;)usleep(10000);return NULL;}
static pid_t child(int mode) {
    pid_t pid=fork();assert(pid>=0);if(pid)return pid;
    signal(SIGUSR1,received);
    if(mode==8){pthread_t th;assert(!pthread_create(&th,NULL,sleeper,NULL));}
    char text[]="  Cep\303\243es \"north\"\\road\n4740-575  ";
    Str strings[]={{" ",1,{0,0}},{text,sizeof(text)-1,{0,0}}};
    State state={{0,0,0},strings,strings+2,strings+2};
    if(mode==1)strings[1].size=4097;
    if(mode==2){strings[1].p="\300\257";strings[1].size=2;}
    if(mode==3)state.end=(Str*)((char*)strings+1);
    if(mode==4){state.begin=NULL;state.end=NULL;state.cap=NULL;}
    usleep(100000);
    if(mode==10){pthread_t th;assert(!pthread_create(&th,NULL,sleeper,NULL));}
    if(mode==6)_exit(0);
    if(mode==7){raise(SIGUSR1);for(;;)usleep(10000);}
    int i=0;
    for(;;){if(mode!=5){test_callback(&state);if(++i==1 && mode==9){strings[1].p="Final place";strings[1].size=11;}}usleep(10000);}
}
static void detached_alive(pid_t pid) {
    char p[64],line[128];snprintf(p,sizeof(p),"/proc/%d/status",pid);FILE *f=fopen(p,"r");assert(f);int tracer=-1,stopped=0;
    while(fgets(line,sizeof(line),f)){if(sscanf(line,"TracerPid: %d",&tracer)==1)continue;if(!strncmp(line,"State:",6)&&(line[7]=='t'||line[7]=='T'))stopped=1;}fclose(f);assert(tracer==0);assert(!stopped);assert(!kill(pid,0));
    /* Attach again and verify the debug registers were restored. */
    assert(!ptrace(PTRACE_SEIZE,pid,0,0));assert(!ptrace(PTRACE_INTERRUPT,pid,0,0));int status;assert(waitpid(pid,&status,__WALL)==pid);assert(WIFSTOPPED(status));
    unsigned long dr;assert(!trace(PTRACE_PEEKUSER,pid,DR(0),0,&dr));assert(dr==0);
    assert(!trace(PTRACE_PEEKUSER,pid,DR(7),0,&dr));assert(dr==0);
    assert(!ptrace(PTRACE_DETACH,pid,0,0));
}
int main(void) {
    signal_seen=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);assert(signal_seen!=MAP_FAILED);
    char hash[65];int fd=open("/proc/self/exe",O_RDONLY);assert(fd>=0);assert(!hash_file(fd,hash));close(fd);
    Elf64_Ehdr eh;fd=open("/proc/self/exe",O_RDONLY);assert(pread(fd,&eh,sizeof(eh),0)==sizeof(eh));close(fd);
    Dl_info info;assert(dladdr(test_site,&info));
    Profile p={0};p.hash=hash;p.site=(uint64_t)test_site-(eh.e_type==ET_DYN?(uint64_t)info.dli_fbase:0);p.code_start=p.site;memset(p.code,0x90,sizeof(p.code));
    struct sigaction sa={0};sa.sa_handler=cancel;sigemptyset(&sa.sa_mask);sigaction(SIGALRM,&sa,NULL);
    for(int mode=0;mode<=10;mode++) {
        pid_t pid=child(mode);if(mode==8)usleep(30000);
        Tap t={0};t.pid=pid;t.profile=&p;cancelled=0;failure=NULL;
        int r=collect(&t,0.4,2);
        if(mode==1||mode==2||mode==3||mode==6||mode==7||mode==10)assert(r<0);else assert(!r);
        if(mode==0||mode==8)assert(!strcmp(t.address,"Cep\303\243es \"north\"\\road\n4740-575"));
        if(mode==4||mode==5)assert(!t.address[0]);
        if(mode==9)assert(!strcmp(t.address,"Final place"));
        if(mode!=6)detached_alive(pid);
        if(mode==7){usleep(10000);assert(*signal_seen);}
        kill(pid,SIGKILL);waitpid(pid,NULL,0);
        printf("PASS native capture scenario %d\n",mode);
    }
    pid_t pid=child(5);Tap t={0};t.pid=pid;t.profile=&p;cancelled=0;ualarm(150000,0);assert(!collect(&t,3,2));assert(cancelled);detached_alive(pid);kill(pid,SIGKILL);waitpid(pid,NULL,0);puts("PASS cancellation and register restoration");
    pid=child(0);t=(Tap){0};t.pid=pid;p.hash=firmware.hash;t.profile=&p;cancelled=0;assert(collect(&t,.4,2)<0);assert(!strcmp(failure,"Unsupported executable hash"));detached_alive(pid);kill(pid,SIGKILL);waitpid(pid,NULL,0);puts("PASS wrong executable rejected before attach");
    p.hash=hash;p.code[0]=0xcc;pid=child(0);t=(Tap){0};t.pid=pid;t.profile=&p;assert(collect(&t,.4,2)<0);assert(!strcmp(failure,"Runtime callback bytes differ"));detached_alive(pid);kill(pid,SIGKILL);waitpid(pid,NULL,0);puts("PASS wrong callback rejected and detached");
    p.code[0]=0x90;pid=child(5);int status;assert(!ptrace(PTRACE_SEIZE,pid,0,0));assert(!ptrace(PTRACE_INTERRUPT,pid,0,0));assert(waitpid(pid,&status,__WALL)==pid);
    assert(!trace(PTRACE_POKEUSER,pid,DR(0),0x1234,NULL));assert(!trace(PTRACE_POKEUSER,pid,DR(7),1,NULL));assert(!ptrace(PTRACE_DETACH,pid,0,0));
    t=(Tap){0};t.pid=pid;t.profile=&p;assert(collect(&t,.4,2)<0);assert(!strcmp(failure,"Existing hardware breakpoints"));
    assert(!ptrace(PTRACE_SEIZE,pid,0,0));assert(!ptrace(PTRACE_INTERRUPT,pid,0,0));assert(waitpid(pid,&status,__WALL)==pid);
    unsigned long dr;assert(!trace(PTRACE_PEEKUSER,pid,DR(0),0,&dr));assert(dr==0x1234);assert(!trace(PTRACE_PEEKUSER,pid,DR(7),0,&dr));assert(dr&1);
    assert(!trace(PTRACE_POKEUSER,pid,DR(7),0,NULL));assert(!trace(PTRACE_POKEUSER,pid,DR(0),0,NULL));assert(!ptrace(PTRACE_DETACH,pid,0,0));detached_alive(pid);kill(pid,SIGKILL);waitpid(pid,NULL,0);puts("PASS existing debugger state preserved");
    char value[8193];assert(!text_value((const unsigned char*)"\302\240Porto\343\200\200",10,value));assert(!strcmp(value,"Porto"));
    assert(text_value((const unsigned char*)"a\0b",3,value)<0);assert(text_value((const unsigned char*)"\355\240\200",3,value)<0);puts("PASS Unicode trimming and malformed text rejection");
    output("Example \"quoted\" place");
    (void)find_target;
    return 0;
}
