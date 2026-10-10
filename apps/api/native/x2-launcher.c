#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <poll.h>
#include <sched.h>
#include <seccomp.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "x2-memory-limit.h"

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "X2S1 records require a qualified little-endian Linux target"
#endif

enum { HELLO = 1, START, ARMED, DOCUMENT, RESULT, DONE, ERROR, CANCEL, WORKER_INIT, WORKER_READY };
enum { DOC_ERROR = 10, UNAVAILABLE = 20, PROTOCOL_ERROR, DEADLINE, RESOURCE_LIMIT,
       WORKER_FAILED, CANCELLED, CALLER_GONE, QUARANTINED, BUSY };
enum { CLEAN = 0, INTENT, OWNED, READY, RUNNING, TERMINATING, QUARANTINE };
enum { GROUPS = 3, MAX_DOCUMENT = 10485760, QUEUE_SIZE = 65536, DEADLINE_MS = 60000 };
static const char *const roots[GROUPS] = {
    "/sys/fs/cgroup/memory", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup/pids"
};
static const char *const slot_names[2] = { "slot-0", "slot-1" };
static const char state_root[] = "/data/reformaflow-x2";

/* X2S1 is a fixed little-endian, packed on-disk ABI. Bootstrap is external. */
struct __attribute__((packed)) record {
    char magic[8];
    uint32_t slot, state, profile, owner_pid, init_pid;
    uint64_t owner_birth, init_birth, pid_namespace;
    char boot[37];
    unsigned char nonce[16], tenant[32];
    char seal[65];
    uint64_t memory, quota, period, budget, poll_ms, pids, cleanup_ms;
    uint32_t uid, gid;
    uint64_t devices[GROUPS], inodes[GROUPS];
    uint16_t primary, resource, document_code, reason, cleanup;
};
struct __attribute__((packed)) installation {
    char magic[8];
    unsigned char identity[16];
    char boot[37];
};
_Static_assert(sizeof(struct record) == 324, "X2S1 record layout changed");
_Static_assert(sizeof(struct installation) == 61, "X2I1 installation layout changed");
struct config {
    char runtime[PATH_MAX], seal[65];
    uint64_t memory, quota, period, budget, poll_ms, pids, cleanup_ms;
    uid_t uid;
    gid_t gid;
};
struct queue { unsigned char bytes[QUEUE_SIZE]; size_t begin, end; };
struct header { unsigned char bytes[12]; size_t used; uint32_t length; unsigned kind, profile; };
struct child_context { int barrier, supervisor, input, output; struct config config; };
struct execution {
    uint64_t started, cleanup_until;
    struct config config;
    struct record record;
    int state_fd, lock_fd, root_fd[GROUPS], group_fd[GROUPS], caller_fd, init_fd;
    int worker_in, worker_out;
    pid_t init_pid;
    bool has_slot, init_reaped;
    int init_status;
    unsigned profile;
    unsigned char nonce[16], tenant[32];
    uint32_t document_length;
    unsigned primary, resource, document_code, reason;
    char boot[37], name[64];
};

static uint64_t now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) _exit(UNAVAILABLE);
    return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static bool alive_fd(int fd) {
    struct pollfd p = { .fd = fd, .events = POLLIN };
    return fd >= 0 && poll(&p, 1, 0) == 0;
}
static bool lock_execution(struct execution *x) {
    const uint64_t until = x->cleanup_until ? x->cleanup_until : x->started + DEADLINE_MS;
    for (;;) {
        if (now_ms() >= until) {
            if (!x->primary) x->primary = DEADLINE;
            return false;
        }
        if (!x->cleanup_until && !alive_fd(x->caller_fd)) {
            if (!x->primary) x->primary = CALLER_GONE;
            return false;
        }
        if (flock(x->lock_fd, LOCK_EX | LOCK_NB) == 0) return true;
        if (errno != EWOULDBLOCK && errno != EINTR) return false;
        struct timespec pause = {0, 10000000};
        nanosleep(&pause, NULL);
    }
}
static int pidfd(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }
static int kill_fd(int fd) { return (int)syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0); }
static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static bool hex_string(const char *p, size_t n) {
    if (strlen(p) != n) return false;
    for (size_t i = 0; i < n; ++i)
        if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return false;
    return true;
}
static bool decimal(const char *text, uint64_t *value) {
    if (!text || !*text) return false;
    uint64_t n = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p < '0' || *p > '9' || n > (INT64_MAX - (uint64_t)(*p - '0')) / 10) return false;
        n = n * 10 + (uint64_t)(*p - '0');
    }
    *value = n;
    return true;
}
static bool config_number(const char *key, uint64_t *out) {
    return decimal(getenv(key), out) && *out > 0;
}
static int directory(const char *path) {
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) return -1;
    char copy[PATH_MAX];
    strcpy(copy, path);
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    char *save = NULL;
    for (char *s = strtok_r(copy, "/", &save); s; s = strtok_r(NULL, "/", &save)) {
        if (!strcmp(s, ".") || !strcmp(s, "..")) { close(fd); return -1; }
        int next = openat(fd, s, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        if (next < 0) return -1;
        fd = next;
    }
    return fd;
}
static bool owned(int fd, mode_t mode, bool exact) {
    struct stat st;
    return fstat(fd, &st) == 0 && st.st_uid == 0 && st.st_gid == 0 &&
        (exact ? (st.st_mode & 07777) == mode : (st.st_mode & 0022) == 0);
}
static bool read_exact_file(int dir, const char *name, void *out, size_t size, mode_t mode) {
    int fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd < 0) return false;
    bool ok = owned(fd, mode, true) && fstat(fd, &st) == 0 && S_ISREG(st.st_mode) &&
        st.st_nlink == 1 && st.st_size >= 0 && (uint64_t)st.st_size == size;
    size_t offset = 0;
    while (ok && offset < size) {
        ssize_t n = read(fd, (char *)out + offset, size - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ok = false; break; }
        offset += (size_t)n;
    }
    close(fd);
    return ok;
}
static bool read_text(int dir, const char *name, char *out, size_t cap) {
    int fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || cap < 2) { if (fd >= 0) close(fd); return false; }
    size_t offset = 0;
    for (;;) {
        ssize_t n = read(fd, out + offset, cap - 1 - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { close(fd); return false; }
        if (!n) break;
        offset += (size_t)n;
        if (offset == cap - 1) { close(fd); return false; }
    }
    close(fd);
    out[offset] = 0;
    return true;
}
static bool read_number(int dir, const char *name, uint64_t *out) {
    char text[64];
    if (!read_text(dir, name, text, sizeof(text))) return false;
    size_t n = strlen(text);
    if (n && text[n - 1] == '\n') text[n - 1] = 0;
    return decimal(text, out);
}
static bool set_number(int dir, const char *name, uint64_t value) {
    char text[32];
    int length = snprintf(text, sizeof(text), "%" PRIu64, value);
    int fd = openat(dir, name, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    ssize_t written;
    do { written = write(fd, text, (size_t)length); } while (written < 0 && errno == EINTR);
    bool ok = written == length;
    close(fd);
    uint64_t observed;
    return ok && read_number(dir, name, &observed) && observed == value;
}
static bool write_all(int fd, const void *buf, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t n = write(fd, (const char *)buf + offset, length - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        offset += (size_t)n;
    }
    return true;
}
static void name_for(const unsigned char nonce[16], char out[64]) {
    static const char prefix[] = "reformaflow-x2-";
    strcpy(out, prefix);
    for (size_t i = 0; i < 16; ++i) snprintf(out + sizeof(prefix) - 1 + 2 * i, 3, "%02x", nonce[i]);
}
static bool record_valid(const struct record *r, unsigned slot) {
    if (memcmp(r->magic, "X2SLT1\0", 8) || r->slot != slot || r->state > QUARANTINE ||
        r->boot[36] != 0 || strlen(r->boot) != 36 || r->seal[64] != 0) return false;
    if (r->state == CLEAN) {
        unsigned char zero[16] = {0};
        return memcmp(r->nonce, zero, 16) == 0 && r->cleanup == 1;
    }
    return r->profile >= 1 && r->profile <= 3 && hex_string(r->seal, 64) &&
        r->owner_pid > 1 && r->owner_birth > 0 && r->memory > 0 && r->pids >= 2;
}
static bool save_locked(struct execution *x, const struct record *next) {
    struct record previous;
    if (!read_exact_file(x->state_fd, slot_names[x->record.slot], &previous, sizeof(previous), 0600) ||
        memcmp(&previous, &x->record, sizeof(previous))) return false;
    char temporary[80], nonce_name[64];
    name_for(x->nonce, nonce_name);
    snprintf(temporary, sizeof(temporary), ".slot-%u-%s.tmp", next->slot, nonce_name);
    int fd = openat(x->state_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    bool ok = write_all(fd, next, sizeof(*next)) && fsync(fd) == 0;
    if (close(fd) < 0) ok = false;
    if (ok) ok = renameat(x->state_fd, temporary, x->state_fd, slot_names[next->slot]) == 0 &&
        fsync(x->state_fd) == 0;
    if (ok) x->record = *next;
    return ok;
}
static bool save(struct execution *x, const struct record *next) {
    if (!lock_execution(x)) return false;
    bool ok = save_locked(x, next);
    if (flock(x->lock_fd, LOCK_UN) < 0) ok = false;
    return ok;
}
static bool transition(struct execution *x, unsigned state) {
    struct record next = x->record;
    next.state = state;
    return save(x, &next);
}
static bool birth(pid_t pid, uint64_t *out) {
    char path[64], text[8192];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    if (!read_text(AT_FDCWD, path, text, sizeof(text))) return false;
    char *p = strrchr(text, ')');
    if (!p || p[1] != ' ') return false;
    p += 2;
    for (int field = 3; field < 22; ++field) {
        p = strchr(p, ' ');
        if (!p) return false;
        ++p;
    }
    char *end = strchr(p, ' ');
    if (!end) return false;
    *end = 0;
    return decimal(p, out) && *out > 0;
}
static bool namespace_id(pid_t pid, uint64_t *id) {
    char path[64];
    struct stat st;
    snprintf(path, sizeof(path), "/proc/%d/ns/pid", pid);
    if (stat(path, &st) < 0) return false;
    *id = st.st_ino;
    return true;
}
static bool member(int group, pid_t pid) {
    char text[65536];
    if (!read_text(group, "cgroup.procs", text, sizeof(text))) return false;
    char wanted[32];
    snprintf(wanted, sizeof(wanted), "%d", pid);
    char *save = NULL;
    for (char *p = strtok_r(text, "\n", &save); p; p = strtok_r(NULL, "\n", &save))
        if (!strcmp(p, wanted)) return true;
    return false;
}
static bool empty_group(int fd) {
    char text[64];
    return read_text(fd, "cgroup.procs", text, sizeof(text)) && text[0] == 0;
}
static bool identity(int fd, uint64_t device, uint64_t inode) {
    struct stat st;
    return device && inode && fstat(fd, &st) == 0 && (uint64_t)st.st_dev == device && st.st_ino == inode;
}
static bool reconcile_locked(struct execution *x, struct record *r) {
    if (r->state == CLEAN) return true;
    const bool same_boot = !strcmp(r->boot, x->boot);
    if (same_boot) {
        int owner = pidfd((pid_t)r->owner_pid);
        uint64_t observed = 0;
        if (owner < 0 && errno != ESRCH) return false;
        if (owner >= 0 && alive_fd(owner)) {
            if (!birth((pid_t)r->owner_pid, &observed)) { close(owner); return false; }
            if (observed == r->owner_birth && alive_fd(owner)) { close(owner); return true; }
        }
        if (owner >= 0) close(owner);
    }
    char name[64];
    name_for(r->nonce, name);
    int groups[GROUPS] = {-1, -1, -1};
    bool ok = true, live = false;
    for (int i = 0; i < GROUPS; ++i) {
        groups[i] = openat(x->root_fd[i], name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (groups[i] < 0) { if (errno != ENOENT) ok = false; continue; }
        if (!same_boot || !identity(groups[i], r->devices[i], r->inodes[i])) ok = false;
        if (!empty_group(groups[i])) live = true;
    }
    if (ok && live) {
        int init = r->init_pid > 1 ? pidfd((pid_t)r->init_pid) : -1;
        uint64_t start, ns;
        ok = init >= 0 && alive_fd(init) && birth((pid_t)r->init_pid, &start) &&
            start == r->init_birth && namespace_id((pid_t)r->init_pid, &ns) && ns == r->pid_namespace;
        for (int i = 0; i < GROUPS; ++i)
            if (groups[i] < 0 || !member(groups[i], (pid_t)r->init_pid)) ok = false;
        if (ok) ok = alive_fd(init) && kill_fd(init) == 0;
        if (init >= 0) close(init);
        /* Cleanup is retried by a later admission, never by reusing a pidfd. */
        ok = false;
    }
    if (ok) {
        for (int i = 0; i < GROUPS; ++i)
            if (groups[i] >= 0 && (!empty_group(groups[i]) ||
                unlinkat(x->root_fd[i], name, AT_REMOVEDIR) < 0)) ok = false;
    }
    for (int i = 0; i < GROUPS; ++i) if (groups[i] >= 0) close(groups[i]);
    struct record old = x->record;
    x->record = *r;
    struct record next = *r;
    if (ok) {
        memset(&next, 0, sizeof(next));
        memcpy(next.magic, "X2SLT1\0", 8); next.slot = r->slot; next.cleanup = 1;
        strcpy(next.boot, x->boot);
    } else { next.state = QUARANTINE; next.cleanup = 2; next.primary = QUARANTINED; }
    bool saved = save_locked(x, &next);
    if (saved) *r = next;
    x->record = old;
    return ok && saved;
}
static bool runtime_tree(int fd, unsigned depth) {
    if (depth > 24 || !owned(fd, 0, false)) return false;
    int copy = dup(fd);
    if (copy < 0) return false;
    DIR *dir = fdopendir(copy);
    if (!dir) { close(copy); return false; }
    bool ok = true;
    errno = 0;
    struct dirent *entry;
    while (ok && (entry = readdir(dir))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat st;
        if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0 ||
            st.st_uid || st.st_gid || (st.st_mode & 0222)) { ok = false; break; }
        if (S_ISDIR(st.st_mode)) {
            int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            ok = child >= 0 && runtime_tree(child, depth + 1);
            if (child >= 0) close(child);
        } else if (!S_ISREG(st.st_mode) || st.st_nlink != 1) ok = false;
        errno = 0;
    }
    if (errno) ok = false;
    closedir(dir);
    return ok;
}
static bool load_config(struct config *c) {
    const char *root = getenv("X2_RUNTIME_ROOT"), *seal = getenv("X2_RUNTIME_SEAL");
    uint64_t uid, gid;
    if (!root || strlen(root) >= sizeof(c->runtime) || !seal || !hex_string(seal, 64) ||
        !config_number("X2_WORKER_UID", &uid) || uid >= UINT32_MAX ||
        !config_number("X2_WORKER_GID", &gid) || gid >= UINT32_MAX ||
        !config_number("X2_MEMORY_BYTES", &c->memory) ||
        !config_number("X2_CPU_QUOTA_US", &c->quota) || !config_number("X2_CPU_PERIOD_US", &c->period) ||
        !config_number("X2_CPU_BUDGET_NS", &c->budget) || !config_number("X2_CPU_POLL_MS", &c->poll_ms) ||
        !config_number("X2_PIDS_MAX", &c->pids) || c->pids < 2 ||
        !config_number("X2_CLEANUP_MS", &c->cleanup_ms) ||
        c->poll_ms > INT_MAX || c->cleanup_ms > INT_MAX || c->pids > INT_MAX) return false;
    long page = sysconf(_SC_PAGESIZE);
    if (!x2_memory_limit_valid(c->memory, page)) return false;
    c->uid = (uid_t)uid; c->gid = (gid_t)gid;
    strcpy(c->runtime, root); strcpy(c->seal, seal);
    int fd = directory(root);
    char observed[65];
    bool ok = fd >= 0 && runtime_tree(fd, 0) &&
        read_exact_file(fd, ".x2-seal", observed, sizeof(observed), 0444) &&
        observed[64] == '\n' && !memcmp(observed, seal, 64);
    if (fd >= 0) close(fd);
    return ok;
}
static bool capabilities(void) {
    struct __user_cap_header_struct h = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct d[2];
    if (geteuid() || getuid() || getegid() || syscall(SYS_capget, &h, d) < 0) return false;
    const unsigned required[] = { CAP_SYS_ADMIN, CAP_SYS_CHROOT, CAP_SETUID, CAP_SETGID, CAP_SETPCAP, CAP_KILL };
    for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); ++i)
        if (!(d[required[i] / 32].effective & (1U << (required[i] % 32)))) return false;
    return true;
}
static bool open_state(struct execution *x) {
    x->state_fd = directory(state_root);
    if (x->state_fd < 0 || !owned(x->state_fd, 0700, true)) return false;
    int data = directory("/data");
    struct stat a, b;
    bool mounted = data >= 0 && fstat(data, &a) == 0 &&
        fstatat(data, "..", &b, 0) == 0 && a.st_dev != b.st_dev;
    if (data >= 0) close(data);
    if (!mounted) return false;
    x->lock_fd = openat(x->state_fd, "admission.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    struct stat lock;
    if (x->lock_fd < 0 || !owned(x->lock_fd, 0600, true) ||
        fstat(x->lock_fd, &lock) < 0 || !S_ISREG(lock.st_mode) || lock.st_nlink != 1) return false;
    struct installation installation;
    unsigned char ready[16];
    if (!read_exact_file(x->state_fd, "installation", &installation, sizeof(installation), 0600) ||
        memcmp(installation.magic, "X2INS1\0", 8) || installation.boot[36] != 0 ||
        !read_exact_file(x->state_fd, "ready", ready, sizeof(ready), 0600) ||
        memcmp(ready, installation.identity, 16)) return false;
    for (int i = 0; i < GROUPS; ++i) {
        x->root_fd[i] = directory(roots[i]);
        struct statfs fs;
        if (x->root_fd[i] < 0 || fstatfs(x->root_fd[i], &fs) < 0 || fs.f_type != CGROUP_SUPER_MAGIC)
            return false;
    }
    uint64_t hierarchy, usage;
    return read_number(x->root_fd[0], "memory.use_hierarchy", &hierarchy) && hierarchy == 1 &&
        read_number(x->root_fd[1], "cpuacct.usage", &usage);
}
static bool admit(struct execution *x) {
    if (!lock_execution(x)) return false;
    struct record slots[2];
    bool ok = true;
    int available = -1;
    for (unsigned i = 0; i < 2; ++i) {
        if (!read_exact_file(x->state_fd, slot_names[i], &slots[i], sizeof(slots[i]), 0600) ||
            !record_valid(&slots[i], i) || !reconcile_locked(x, &slots[i])) { ok = false; break; }
        if (slots[i].state == CLEAN) available = (int)i;
        else if (!memcmp(slots[i].tenant, x->tenant, 32)) available = -2;
    }
    if (ok) for (unsigned i = 0; i < 2; ++i)
        if (slots[i].state != CLEAN && !memcmp(slots[i].tenant, x->tenant, 32)) available = -2;
    if (!ok || available < 0) {
        x->primary = ok ? BUSY : QUARANTINED;
        flock(x->lock_fd, LOCK_UN);
        return false;
    }
    x->record = slots[available];
    struct record next = {0};
    memcpy(next.magic, "X2SLT1\0", 8); next.slot = (uint32_t)available; next.state = INTENT;
    next.profile = x->profile; next.owner_pid = (uint32_t)getpid();
    uint64_t born = 0;
    ok = birth(getpid(), &born);
    next.owner_birth = born;
    strcpy(next.boot, x->boot); strcpy(next.seal, x->config.seal);
    memcpy(next.nonce, x->nonce, 16); memcpy(next.tenant, x->tenant, 32);
    next.memory = x->config.memory; next.quota = x->config.quota; next.period = x->config.period;
    next.budget = x->config.budget; next.poll_ms = x->config.poll_ms; next.pids = x->config.pids;
    next.cleanup_ms = x->config.cleanup_ms; next.uid = x->config.uid; next.gid = x->config.gid;
    ok = ok && save_locked(x, &next);
    x->has_slot = ok;
    if (!ok) x->primary = QUARANTINED;
    if (flock(x->lock_fd, LOCK_UN) < 0) ok = false;
    return ok;
}
static bool make_groups(struct execution *x) {
    for (int i = 0; i < GROUPS; ++i) {
        if (mkdirat(x->root_fd[i], x->name, 0700) < 0) return false;
        x->group_fd[i] = openat(x->root_fd[i], x->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        struct stat st;
        if (x->group_fd[i] < 0 || fstat(x->group_fd[i], &st) < 0) return false;
        struct record next = x->record;
        next.devices[i] = st.st_dev; next.inodes[i] = st.st_ino;
        if (!save(x, &next)) return false;
    }
    uint64_t hierarchy;
    return set_number(x->group_fd[0], "memory.limit_in_bytes", x->config.memory) &&
        set_number(x->group_fd[0], "memory.memsw.limit_in_bytes", x->config.memory) &&
        read_number(x->group_fd[0], "memory.use_hierarchy", &hierarchy) && hierarchy == 1 &&
        set_number(x->group_fd[1], "cpu.cfs_period_us", x->config.period) &&
        set_number(x->group_fd[1], "cpu.cfs_quota_us", x->config.quota) &&
        set_number(x->group_fd[2], "pids.max", x->config.pids);
}
static bool drop_privileges(const struct config *c) {
    if (setgroups(0, NULL) < 0) return false;
    for (int cap = 0; cap <= CAP_LAST_CAP; ++cap)
        if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) < 0) return false;
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 ||
        setresgid(c->gid, c->gid, c->gid) < 0 || setresuid(c->uid, c->uid, c->uid) < 0) return false;
    struct __user_cap_header_struct h = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct d[2] = {{0}};
    return syscall(SYS_capset, &h, d) == 0 && prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 &&
        prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == 0;
}
static bool seccomp_worker(void) {
    scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ERRNO(EPERM));
    if (!filter) return false;
    const char *const allowed[] = {
        "read", "readv", "pread64", "write", "writev", "close", "close_range", "fstat", "newfstatat", "stat",
        "lstat", "statx", "access", "faccessat", "faccessat2", "readlink", "readlinkat", "getdents64", "lseek",
        "mmap", "mprotect", "munmap", "mremap", "madvise", "brk", "futex", "futex_waitv", "set_robust_list",
        "rseq", "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "sigaltstack", "getpid", "getppid", "gettid",
        "getuid", "geteuid", "getgid", "getegid", "getgroups", "uname", "sysinfo", "getrandom",
        "clock_gettime", "gettimeofday", "time", "nanosleep", "clock_nanosleep", "sched_yield", "sched_getaffinity",
        "getcpu", "getcwd", "fcntl", "dup", "dup2", "dup3", "pipe", "pipe2", "eventfd2",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait", "epoll_pwait2",
        "poll", "ppoll", "select", "pselect6", "getrlimit", "getrusage", "times", "arch_prctl",
        "set_tid_address", "tgkill", "kill", "wait4", "waitid", "execve", "exit", "exit_group", "restart_syscall"
    };
    bool ok = true;
    for (size_t i = 0; ok && i < sizeof(allowed) / sizeof(allowed[0]); ++i) {
        int nr = seccomp_syscall_resolve_name(allowed[i]);
        if (nr != __NR_SCMP_ERROR && seccomp_rule_add(filter, SCMP_ACT_ALLOW, nr, 0) < 0) ok = false;
    }
    const uint64_t write_flags = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND | __O_TMPFILE;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(open), 1,
        SCMP_A1(SCMP_CMP_MASKED_EQ, write_flags, 0)) == 0;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(openat), 1,
        SCMP_A2(SCMP_CMP_MASKED_EQ, write_flags, 0)) == 0;
    const uint64_t clone_flags = CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD |
        CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | SIGCHLD;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(clone), 1,
        SCMP_A0(SCMP_CMP_MASKED_EQ, ~clone_flags, 0)) == 0;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0) == 0;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(prlimit64), 1,
        SCMP_A2(SCMP_CMP_EQ, 0)) == 0;
    ok = ok && seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(prctl), 1,
        SCMP_A0(SCMP_CMP_EQ, PR_SET_NAME)) == 0;
    if (ok) ok = seccomp_load(filter) == 0;
    seccomp_release(filter);
    return ok;
}
static bool close_except(int a, int b, int c, int d) {
    DIR *dir = opendir("/proc/self/fd");
    if (!dir) return false;
    int own = dirfd(dir);
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        uint64_t fd;
        if (!decimal(entry->d_name, &fd) || fd > INT_MAX) continue;
        if (fd > 2 && (int)fd != a && (int)fd != b && (int)fd != c && (int)fd != d && (int)fd != own) close((int)fd);
    }
    closedir(dir);
    return true;
}
static int init_main(void *argument) {
    struct child_context *c = argument;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || !alive_fd(c->supervisor)) return WORKER_FAILED;
    if (!close_except(c->barrier, c->supervisor, c->input, c->output)) return WORKER_FAILED;
    unsigned char release;
    ssize_t n;
    do { n = read(c->barrier, &release, 1); } while (n < 0 && errno == EINTR);
    if (n != 1 || release != 1 || !alive_fd(c->supervisor)) return WORKER_FAILED;
    close(c->barrier);
    struct sched_param schedule = { .sched_priority = 0 };
    if (sched_setscheduler(0, SCHED_OTHER, &schedule) < 0 ||
        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0 ||
        mount(c->config.runtime, c->config.runtime, NULL, MS_BIND | MS_REC, NULL) < 0) return WORKER_FAILED;
    char old[PATH_MAX];
    if (snprintf(old, sizeof(old), "%s/.old", c->config.runtime) >= (int)sizeof(old) ||
        syscall(SYS_pivot_root, c->config.runtime, old) < 0 || chdir("/") < 0 ||
        umount2("/.old", MNT_DETACH) < 0 ||
        mount(NULL, "/", NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) < 0)
        return WORKER_FAILED;
    if (!drop_privileges(&c->config) || !alive_fd(c->supervisor)) return WORKER_FAILED;
    close(c->supervisor);
    /* No old-root or supervisor descriptors may cross the worker exec. */
    if (dup2(c->input, 0) < 0 || dup2(c->output, 1) < 0 ||
        syscall(SYS_close_range, 3U, UINT_MAX, 0) < 0) return WORKER_FAILED;
    pid_t worker = fork();
    if (worker < 0) return WORKER_FAILED;
    if (!worker) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || getppid() != 1 || !seccomp_worker())
            _exit(WORKER_FAILED);
        char *const argv[] = { "/bin/node", "/app/worker.js", NULL };
        char *const env[] = { NULL };
        execve(argv[0], argv, env);
        _exit(WORKER_FAILED);
    }
    close(0); close(1);
    int status;
    do { n = waitpid(worker, &status, 0); } while (n < 0 && errno == EINTR);
    if (n != worker || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return WORKER_FAILED;
    pid_t other = waitpid(-1, &status, WNOHANG);
    return other == -1 && errno == ECHILD ? 0 : WORKER_FAILED;
}
static bool spawn_init(struct execution *x) {
    int barrier[2], input[2], output[2];
    if (pipe2(barrier, O_CLOEXEC) < 0) return false;
    if (pipe2(input, O_CLOEXEC) < 0) { close(barrier[0]); close(barrier[1]); return false; }
    if (pipe2(output, O_CLOEXEC) < 0) {
        close(barrier[0]); close(barrier[1]); close(input[0]); close(input[1]); return false;
    }
    int supervisor = pidfd(getpid());
    void *stack = malloc(1024 * 1024);
    struct child_context context = { .barrier = barrier[0], .supervisor = supervisor,
        .input = input[0], .output = output[1], .config = x->config };
    x->init_pid = supervisor >= 0 && stack ? clone(init_main, (char *)stack + 1024 * 1024,
        SIGCHLD | CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWNET | CLONE_PIDFD,
        &context, &x->init_fd, NULL, NULL) : -1;
    if (supervisor >= 0) close(supervisor);
    close(barrier[0]); close(input[0]); close(output[1]); free(stack);
    if (x->init_pid < 0) { close(barrier[1]); close(input[1]); close(output[0]); return false; }
    x->worker_in = input[1]; x->worker_out = output[0];
    struct record next = x->record;
    next.init_pid = (uint32_t)x->init_pid;
    uint64_t born = 0, ns = 0;
    bool ok = birth(x->init_pid, &born) && namespace_id(x->init_pid, &ns);
    next.init_birth = born; next.pid_namespace = ns;
    ok = ok && save(x, &next);
    for (int i = 0; ok && i < GROUPS; ++i) {
        char pid[32];
        int length = snprintf(pid, sizeof(pid), "%d", x->init_pid);
        int fd = openat(x->group_fd[i], "cgroup.procs", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
        ok = fd >= 0 && write_all(fd, pid, (size_t)length);
        if (fd >= 0) close(fd);
    }
    for (int i = 0; ok && i < GROUPS; ++i) ok = member(x->group_fd[i], x->init_pid);
    ok = ok && transition(x, OWNED) && alive_fd(x->caller_fd) &&
        now_ms() - x->started < DEADLINE_MS;
    unsigned char release = 1;
    if (ok) ok = write_all(barrier[1], &release, 1);
    close(barrier[1]);
    return ok && nonblocking(x->worker_in) == 0 && nonblocking(x->worker_out) == 0;
}
static void make_header(unsigned char h[12], unsigned kind, unsigned profile, uint32_t length) {
    memset(h, 0, 12); memcpy(h, "X2N1", 4); h[4] = (unsigned char)kind; h[5] = (unsigned char)profile;
    uint32_t big = htonl(length); memcpy(h + 8, &big, 4);
}
static bool control_frame(unsigned kind, unsigned profile, const void *body, uint32_t length) {
    unsigned char frame[64];
    if (length > sizeof(frame) - 12) return false;
    make_header(frame, kind, profile, length); memcpy(frame + 12, body, length);
    size_t offset = 0;
    const uint64_t until = now_ms() + 1000;
    while (offset < length + 12) {
        ssize_t n = write(3, frame + offset, length + 12 - offset);
        if (n > 0) { offset += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && now_ms() < until) {
            struct pollfd p = { .fd = 3, .events = POLLOUT };
            poll(&p, 1, 10); continue;
        }
        return false;
    }
    return true;
}
static bool decode_header(struct header *h) {
    uint16_t reserved;
    uint32_t length;
    memcpy(&reserved, h->bytes + 6, 2); memcpy(&length, h->bytes + 8, 4);
    h->length = ntohl(length); h->kind = h->bytes[4]; h->profile = h->bytes[5];
    return !memcmp(h->bytes, "X2N1", 4) && !reserved &&
        h->kind >= HELLO && h->kind <= WORKER_READY && h->profile <= 3;
}
static int get_header(int fd, struct header *h) {
    ssize_t n = read(fd, h->bytes + h->used, 12 - h->used);
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
    if (n <= 0) return -1;
    h->used += (size_t)n;
    if (h->used != 12) return 0;
    return decode_header(h) ? 1 : -1;
}
static void latch(struct execution *x, unsigned primary) { if (!x->primary) x->primary = primary; }
static bool terminal_check(struct execution *x) {
    if (!alive_fd(x->caller_fd)) latch(x, CALLER_GONE);
    else if (now_ms() - x->started >= DEADLINE_MS) latch(x, DEADLINE);
    return x->primary != 0;
}
static bool cancel_read(struct execution *x, struct header *h, unsigned char body[18], size_t *used) {
    if (h->used < 12) {
        int status = get_header(3, h);
        if (status < 0) { latch(x, PROTOCOL_ERROR); return false; }
        if (!status) return true;
        if (h->kind != CANCEL || h->profile || h->length != 18) { latch(x, PROTOCOL_ERROR); return false; }
    }
    ssize_t n = read(3, body + *used, 18 - *used);
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) return true;
    if (n <= 0) { latch(x, PROTOCOL_ERROR); return false; }
    *used += (size_t)n;
    if (*used < 18) return true;
    unsigned char zero[16] = {0};
    uint16_t reason;
    memcpy(&reason, body + 16, 2); reason = ntohs(reason);
    if ((memcmp(body, x->nonce, 16) && (x->profile || memcmp(body, zero, 16))) ||
        (reason != 1 && reason != 2)) latch(x, PROTOCOL_ERROR);
    else latch(x, reason == 2 ? DEADLINE : CANCELLED);
    return false;
}
static bool receive_start(struct execution *x) {
    struct header data = {0}, control = {0};
    unsigned char start[52], cancel[18];
    size_t used = 0, cancel_used = 0;
    while (!terminal_check(x)) {
        struct pollfd fds[] = {{3, POLLIN, 0}, {0, POLLIN, 0}, {x->caller_fd, POLLIN, 0}};
        if (poll(fds, 3, 20) < 0 && errno != EINTR) { latch(x, PROTOCOL_ERROR); break; }
        if (terminal_check(x)) break;
        if (fds[0].revents && !cancel_read(x, &control, cancel, &cancel_used)) break;
        if (!fds[1].revents) continue;
        if (data.used < 12) {
            int status = get_header(0, &data);
            if (status < 0) { latch(x, PROTOCOL_ERROR); break; }
            if (!status) continue;
            if (data.kind != START || !data.profile || data.length != 52) { latch(x, PROTOCOL_ERROR); break; }
        }
        ssize_t n = read(0, start + used, 52 - used);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (n <= 0) { latch(x, PROTOCOL_ERROR); break; }
        used += (size_t)n;
        if (used < 52) continue;
        if (memcmp(start, x->nonce, 16)) { latch(x, PROTOCOL_ERROR); break; }
        x->profile = data.profile; memcpy(x->tenant, start + 16, 32);
        memcpy(&x->document_length, start + 48, 4); x->document_length = ntohl(x->document_length);
        if (!x->document_length || x->document_length > MAX_DOCUMENT) {
            x->document_code = x->document_length ? 3 : 1; latch(x, DOC_ERROR); break;
        }
        return true;
    }
    return false;
}
static bool queue_write(int fd, struct queue *q) {
    if (q->begin == q->end) { q->begin = q->end = 0; return true; }
    ssize_t n = write(fd, q->bytes + q->begin, q->end - q->begin);
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) return true;
    if (n <= 0) return false;
    q->begin += (size_t)n;
    if (q->begin == q->end) q->begin = q->end = 0;
    return true;
}
static bool worker_error(struct execution *x, const unsigned char body[12]) {
    uint16_t fields[6];
    for (int i = 0; i < 6; ++i) { memcpy(&fields[i], body + i * 2, 2); fields[i] = ntohs(fields[i]); }
    if (fields[1] || fields[4] || fields[5]) return false;
    if (fields[0] == DOC_ERROR) {
        if (fields[2] < 1 || fields[2] > 4 || fields[3] > 6 || (fields[2] != 2 && fields[3])) return false;
    } else if (fields[0] != WORKER_FAILED || fields[2] || fields[3]) return false;
    latch(x, fields[0]); x->document_code = fields[2]; x->reason = fields[3];
    return true;
}
static void resource_check(struct execution *x, uint64_t memory_start, uint64_t pids_start) {
    if (x->primary) return;
    uint64_t value;
    if (!read_number(x->group_fd[1], "cpuacct.usage", &value)) { latch(x, UNAVAILABLE); return; }
    if (value >= x->config.budget) { x->resource = 3; latch(x, RESOURCE_LIMIT); return; }
    if (!read_number(x->group_fd[0], "memory.failcnt", &value)) { latch(x, UNAVAILABLE); return; }
    if (value > memory_start) { x->resource = 1; latch(x, RESOURCE_LIMIT); return; }
    char events[256];
    unsigned long long max;
    int consumed = 0;
    if (!read_text(x->group_fd[2], "pids.events", events, sizeof(events)) ||
        sscanf(events, "max %llu\n%n", &max, &consumed) != 1 || events[consumed]) { latch(x, UNAVAILABLE); return; }
    if ((uint64_t)max > pids_start) { x->resource = 2; latch(x, RESOURCE_LIMIT); }
}
static bool run_worker(struct execution *x) {
    struct queue to_worker = {0}, to_parent = {0};
    struct header from_parent = {0}, from_worker = {0}, control = {0};
    unsigned char cancel[18], error[12]; size_t cancel_used = 0, error_used = 0;
    uint64_t memory_start, next_check = now_ms();
    char events[256]; unsigned long long pids_start; int consumed = 0;
    if (!read_number(x->group_fd[0], "memory.failcnt", &memory_start) ||
        !read_text(x->group_fd[2], "pids.events", events, sizeof(events)) ||
        sscanf(events, "max %llu\n%n", &pids_start, &consumed) != 1 || events[consumed]) {
        latch(x, UNAVAILABLE); return false;
    }
    make_header(to_worker.bytes, WORKER_INIT, x->profile, 0); to_worker.end = 12;
    uint32_t document_read = 0, result_read = 0;
    bool ready = false, parent_eof = false, worker_eof = false, result_complete = false;
    while (!terminal_check(x)) {
        struct pollfd fds[] = {
            {3, POLLIN, 0},
            {0, !parent_eof && ready && to_worker.end == 0 ? POLLIN : 0, 0},
            {x->worker_in, to_worker.end ? POLLOUT : 0, 0},
            {x->worker_out, !worker_eof && to_parent.end == 0 ? POLLIN : 0, 0},
            {1, to_parent.end ? POLLOUT : 0, 0},
            {x->caller_fd, POLLIN, 0}, {x->init_fd, POLLIN, 0}
        };
        if (poll(fds, 7, 10) < 0 && errno != EINTR) { latch(x, PROTOCOL_ERROR); break; }
        if (terminal_check(x)) break;
        if (fds[0].revents && !cancel_read(x, &control, cancel, &cancel_used)) break;
        if (now_ms() >= next_check) {
            resource_check(x, memory_start, (uint64_t)pids_start);
            next_check = now_ms() + x->config.poll_ms;
            if (x->primary) break;
        }
        if (fds[2].revents && to_worker.end && !queue_write(x->worker_in, &to_worker)) {
            latch(x, WORKER_FAILED); break;
        }
        if (parent_eof && !to_worker.end && x->worker_in >= 0) { close(x->worker_in); x->worker_in = -1; }
        if (fds[4].revents && to_parent.end && !queue_write(1, &to_parent)) { latch(x, PROTOCOL_ERROR); break; }
        if (fds[1].revents && ready && !parent_eof && !to_worker.end) {
            if (from_parent.used < 12) {
                int status = get_header(0, &from_parent);
                if (status < 0) { latch(x, PROTOCOL_ERROR); break; }
                if (!status) continue;
                if (from_parent.kind != DOCUMENT || from_parent.profile != x->profile ||
                    from_parent.length != x->document_length) { latch(x, PROTOCOL_ERROR); break; }
                memcpy(to_worker.bytes, from_parent.bytes, 12); to_worker.end = 12;
            } else if (document_read < x->document_length) {
                size_t want = x->document_length - document_read;
                if (want > QUEUE_SIZE) want = QUEUE_SIZE;
                ssize_t n = read(0, to_worker.bytes, want);
                if (n > 0) { to_worker.end = (size_t)n; document_read += (uint32_t)n; }
                else if (!n || (errno != EAGAIN && errno != EINTR)) { latch(x, PROTOCOL_ERROR); break; }
            } else {
                unsigned char extra;
                ssize_t n = read(0, &extra, 1);
                if (!n) parent_eof = true;
                else if (n > 0 || (errno != EAGAIN && errno != EINTR)) { latch(x, PROTOCOL_ERROR); break; }
            }
        }
        if (fds[3].revents && !worker_eof && !to_parent.end) {
            if (result_complete) {
                unsigned char extra;
                ssize_t n = read(x->worker_out, &extra, 1);
                if (!n) worker_eof = true;
                else if (n > 0 || (errno != EAGAIN && errno != EINTR)) { latch(x, PROTOCOL_ERROR); break; }
            } else if (from_worker.used < 12) {
                int status = get_header(x->worker_out, &from_worker);
                if (status < 0) { latch(x, from_worker.used ? PROTOCOL_ERROR : WORKER_FAILED); break; }
                if (!status) continue;
                if (from_worker.profile != x->profile) { latch(x, PROTOCOL_ERROR); break; }
                if (!ready) {
                    if (from_worker.kind != WORKER_READY || from_worker.length) { latch(x, PROTOCOL_ERROR); break; }
                    if (!transition(x, READY) || !control_frame(ARMED, x->profile, x->nonce, 16) ||
                        !transition(x, RUNNING)) { latch(x, UNAVAILABLE); break; }
                    ready = true; memset(&from_worker, 0, sizeof(from_worker));
                } else if (from_worker.kind == RESULT && from_worker.length > 0 && from_worker.length <= MAX_DOCUMENT) {
                    memcpy(to_parent.bytes, from_worker.bytes, 12); to_parent.end = 12;
                } else if (from_worker.kind != ERROR || from_worker.length != 12) { latch(x, PROTOCOL_ERROR); break; }
            } else if (from_worker.kind == ERROR) {
                ssize_t n = read(x->worker_out, error + error_used, 12 - error_used);
                if (n > 0) {
                    error_used += (size_t)n;
                    if (error_used == 12 && !worker_error(x, error)) latch(x, PROTOCOL_ERROR);
                } else if (!n || (errno != EAGAIN && errno != EINTR)) latch(x, PROTOCOL_ERROR);
            } else {
                size_t want = from_worker.length - result_read;
                if (want > QUEUE_SIZE) want = QUEUE_SIZE;
                ssize_t n = read(x->worker_out, to_parent.bytes, want);
                if (n > 0) {
                    to_parent.end = (size_t)n; result_read += (uint32_t)n;
                    result_complete = result_read == from_worker.length;
                } else if (!n || (errno != EAGAIN && errno != EINTR)) { latch(x, PROTOCOL_ERROR); break; }
            }
        }
        if (!x->init_reaped) {
            pid_t pid = waitpid(x->init_pid, &x->init_status, WNOHANG);
            if (pid == x->init_pid) x->init_reaped = true;
            else if (pid < 0 && errno != EINTR) { latch(x, WORKER_FAILED); break; }
        }
        if (x->init_reaped && (!WIFEXITED(x->init_status) || WEXITSTATUS(x->init_status))) {
            resource_check(x, memory_start, (uint64_t)pids_start);
            latch(x, WORKER_FAILED); break;
        }
        if (x->init_reaped && worker_eof && result_complete && !to_parent.end && parent_eof) return true;
    }
    return false;
}
static bool cleanup(struct execution *x) {
    if (!x->has_slot) return x->primary != QUARANTINED;
    x->cleanup_until = now_ms() + x->config.cleanup_ms;
    bool durable = transition(x, TERMINATING);
    if (x->init_fd >= 0 && alive_fd(x->init_fd) && kill_fd(x->init_fd) < 0 && errno != ESRCH) durable = false;
    const uint64_t until = x->cleanup_until;
    bool empty = false;
    do {
        if (x->init_pid > 0 && !x->init_reaped) {
            pid_t got = waitpid(x->init_pid, &x->init_status, WNOHANG);
            if (got == x->init_pid) x->init_reaped = true;
        }
        empty = x->init_pid <= 0 || x->init_reaped;
        for (int i = 0; i < GROUPS; ++i) {
            if (x->group_fd[i] >= 0 && (!identity(x->group_fd[i], x->record.devices[i], x->record.inodes[i]) ||
                !empty_group(x->group_fd[i]))) empty = false;
            if (x->group_fd[i] < 0) {
                struct stat st;
                if (fstatat(x->root_fd[i], x->name, &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) empty = false;
            }
        }
        if (empty) break;
        struct timespec pause = {0, 10000000}; nanosleep(&pause, NULL);
    } while (now_ms() < until);
    bool ok = durable && empty;
    if (ok) for (int i = 0; i < GROUPS; ++i) {
        if (x->group_fd[i] >= 0 && unlinkat(x->root_fd[i], x->name, AT_REMOVEDIR) < 0) ok = false;
    }
    struct record next = x->record;
    if (!x->primary && now_ms() - x->started >= DEADLINE_MS) latch(x, DEADLINE);
    next.primary = (uint16_t)x->primary; next.resource = (uint16_t)x->resource;
    next.document_code = (uint16_t)x->document_code; next.reason = (uint16_t)x->reason;
    next.cleanup = ok ? 1 : 2;
    if (ok) {
        next.state = CLEAN; memset(next.nonce, 0, 16); memset(next.tenant, 0, 32);
    } else next.state = QUARANTINE;
    return save(x, &next) && ok;
}
int main(int argc, char **argv) {
    (void)argv;
    struct execution x = { .started = now_ms(), .state_fd = -1, .lock_fd = -1,
        .root_fd = {-1, -1, -1}, .group_fd = {-1, -1, -1}, .caller_fd = -1,
        .init_fd = -1, .worker_in = -1, .worker_out = -1 };
    umask(077);
    signal(SIGPIPE, SIG_IGN);
    pid_t parent = getppid();
    x.caller_fd = parent > 1 ? pidfd(parent) : -1;
    if (argc != 1 || x.caller_fd < 0 || getppid() != parent || !alive_fd(x.caller_fd) ||
        nonblocking(0) < 0 || nonblocking(1) < 0 || nonblocking(3) < 0 ||
        (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDWR || !close_except(3, x.caller_fd, -1, -1))
        latch(&x, UNAVAILABLE);
    char boot[64];
    if (!x.primary && (!capabilities() || !load_config(&x.config) ||
        !read_text(AT_FDCWD, "/proc/sys/kernel/random/boot_id", boot, sizeof(boot)) ||
        strlen(boot) != 37 || boot[36] != '\n')) latch(&x, UNAVAILABLE);
    if (!x.primary) { memcpy(x.boot, boot, 36); x.boot[36] = 0; }
    ssize_t random_bytes = getrandom(x.nonce, sizeof(x.nonce), 0);
    unsigned char zero[16] = {0};
    if (random_bytes != 16 || !memcmp(x.nonce, zero, 16)) latch(&x, UNAVAILABLE);
    name_for(x.nonce, x.name);
    if (!x.primary && !open_state(&x)) latch(&x, UNAVAILABLE);
    if (!x.primary && !terminal_check(&x) && !control_frame(HELLO, 0, x.nonce, 16)) latch(&x, PROTOCOL_ERROR);
    if (!x.primary && receive_start(&x)) {
        if (!admit(&x)) latch(&x, UNAVAILABLE);
        else if (terminal_check(&x) || !make_groups(&x) || !spawn_init(&x)) latch(&x, UNAVAILABLE);
        else run_worker(&x);
    }
    bool clean = cleanup(&x);
    if (!x.primary && now_ms() - x.started >= DEADLINE_MS) latch(&x, DEADLINE);
    if (!clean && !x.primary) latch(&x, QUARANTINED);
    if (!x.primary) {
        if (!control_frame(DONE, x.profile, x.nonce, 16)) return PROTOCOL_ERROR;
        return 0;
    }
    uint16_t fields[6] = { htons((uint16_t)x.primary), htons((uint16_t)x.resource),
        htons((uint16_t)x.document_code), htons((uint16_t)x.reason), htons(clean ? 1 : 2), 0 };
    control_frame(ERROR, x.profile, fields, sizeof(fields));
    return clean ? (int)x.primary : QUARANTINED;
}
