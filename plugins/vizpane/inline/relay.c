/*
 * vizpane relay: puts Codex's output through a filter (relay-filter.h) that may
 * insert each picture's kitty transmit once, at a point where the terminal parser is
 * in ground state, so a picture can be anchored to placeholder cells Codex draws itself.
 * Only Codex's output goes through the relay. Keys, terminal modes, window size
 * and job control stay between the terminal and Codex, as without a relay.
 *
 * Process structure (docs/how-it-works.md has the full picture):
 *
 *   shell, session leader, controlling terminal = the pane
 *     job process group P, foreground on the pane
 *       relay    pid P, one thread, a poll loop; the process the shell waits for
 *         codex  child in the same process group; stdin is the pane itself,
 *                stdout (and stderr, when it was the pane) is the relay's pty
 *
 * The relay never reads the terminal: it writes through its own write-only descriptor and
 * leaves the shell's descriptors 0 to 2 unread (they stay open, read-write, and a future
 * change that read one would not be stopped by the type of a descriptor). It never
 * changes the pane's termios, size or foreground group. Codex's own stop
 * (kill(0, SIGTSTP)) and exit are followed, not emulated: the relay writes out
 * everything Codex wrote, then stops or exits itself, so the shell, which
 * waits for the relay, can only write after the last byte of Codex.
 *
 * When the relay stops and when it leaves:
 *   - It stops only when its child is seen stopped (SIGCHLD: Ctrl+Z, Codex's own kill(0), a
 *     background terminal access), with the signal that stopped the child, after writing out
 *     what Codex wrote. Its own write to the pane being refused with SIGTTOU (a background
 *     group, TOSTOP set) is no reason to stop by itself: the group's SIGTTOU stops the child
 *     too, and the relay holds its output until it sees that stop (or a SIGCONT, or 250 ms
 *     pass, for a child that catches SIGTTOU), then follows it like any other stop. Stopping on
 *     its own and retrying after the continue would, after `kill %1`, retry before the child's
 *     death is read, be refused again and stop for good. Once the child is gone there is
 *     nothing to follow: a child that died of a signal wrote nothing more in stock, so what
 *     the relay still owes (deletes of pictures) is dropped when refused; after a normal
 *     exit the relay stops as stock's writer would and writes when continued, unless it was
 *     told to end meanwhile.
 *   - SIGTSTP, SIGTTIN and SIGTTOU are caught and never a reason to stop by themselves. The
 *     default action would stop the relay on the group-wide SIGTTIN of a dying Codex's last
 *     terminal read, which stock does not see (its launcher's death orphans the group, so
 *     the read gets EIO), leaving a stopped relay with an unreaped child and nobody to
 *     continue it (Ctrl+Z, bg, fg, Ctrl+Z, kill %1; the PTY suite runs it).
 *   - It leaves when its child has exited and the output is drained. Whatever stopped
 *     members are left then are handled by the kernel's orphaned-group rule, as in stock.
 *
 * Any failure before Codex has been forked ends in execv() of the real Codex,
 * so installing the relay can never make `codex` fail to start.
 *
 * Known differences from running Codex directly:
 *   - Not deliberate: under `stty tostop`, after Ctrl+Z, bg and fg, Codex comes back without raw
 *     mode. On resume Codex writes its screen modes to stdout, then calls tcsetattr and does not
 *     retry it when interrupted. Stock Codex is stopped at the write by tostop, so its tcsetattr
 *     later runs in the foreground; here stdout is the inner pty, not Codex's controlling
 *     terminal, so Codex is stopped at the tcsetattr instead, as stock is without tostop. The
 *     relay cannot fix that without racing Codex. test/relay-pty.test.mjs (P5g) pins it.
 *   The rest are deliberate:
 *   - A relay write is whole unless a foreign write took the room (it waits for POLLOUT and
 *     writes at most 512 bytes that end at a safe cut point, up to 768 to reach the first one),
 *     so another writer normally lands between whole items. Inside a run with no cut point the relay
 *     cuts at a character start. A foreign write larger than the free space of the pane's
 *     1 KiB output queue can still be cut by one of ours, and order against writers that
 *     bypass Codex's stdout is not kept for the few hundred bytes in flight. The writer
 *     that matters is Codex's OSC 52 copy to /dev/tty when its native clipboard fails:
 *     stock writes it from the same thread after the frame, here the frame can still be in
 *     flight, so a large copy (measured: 1 KiB and up) is often cut by relayed frame text,
 *     which then ends up inside the OSC string. cmux's terminal nearly always drops such a copy as
 *     invalid base64, so the clipboard keeps what it held before (docs/codex-setup.md has the rates).
 *   - Output is processed (ONLCR and the like) when the relay writes it, not
 *     when Codex wrote it. Codex writes \r\n in raw mode, so nothing changes.
 *   - Codex runs at most about 2.5 KB ahead of the pane, not a whole pty buffer.
 *   - Whatever still holds Codex's stdout when the relay's child has gone loses it when the
 *     relay exits: its writes fail with EIO, where in stock they would still reach the
 *     terminal. That is a process Codex leaves behind, and also the program itself behind a
 *     launcher that forks (the stock npm `codex` script) when the launcher dies first, for
 *     example a program that restores its terminal on SIGTERM after the launcher is gone.
 *   - A resize reaches the job twice: the terminal's SIGWINCH, then one more
 *     from the relay 40 ms later, after it has updated the size of its pty, for
 *     programs that read the size from stdout.
 *   - kill -TSTP <relay pid> alone does nothing: a SIGTSTP is Codex's own stop
 *     or the terminal's group stop, and the relay follows the child's stop. A
 *     stop of the whole job (Ctrl+Z, kill -TSTP %1, SIGSTOP) works.
 *   - A signal sent to the whole group (the terminal's SIGINT and SIGQUIT, the shell's kill of
 *     a job) reaches the child twice, once from the kernel and once forwarded by the relay.
 *   - If the relay is killed, nothing restores the terminal (Codex's restore
 *     bytes go to a dead pty): the shell gets its prompt at once, Codex should end at its
 *     next write to its output or read of the terminal (an idle one can stay), and `reset`
 *     repairs what is left.
 *   - In a cooked phase (start-up, exit) Ctrl+C makes the terminal flush its output queue;
 *     stock Codex dies and nothing more appears, the relay still writes what it holds (up
 *     to about 2.5 KB) after the flush.
 *   - Freeing the pictures at exit is best effort: if the relay is killed, or the
 *     terminal is gone, they stay in the terminal's memory until its pane closes.
 *
 * Build: cc -O2 -Wall -Wextra -o relay relay.c
 * Test build without the real filter: add -DVF_STUB.
 * Test build that writes counters to $VIZPANE_RELAY_LOG at exit: add -DVIZPANE_RELAY_DEBUG.
 * Test builds that leave out the drain before a stop, or the follow-up SIGWINCH, so that the
 * tests can show they notice: -DVIZPANE_RELAY_NODRAIN, -DVIZPANE_RELAY_NOFOLLOW.
 */
#ifndef __APPLE__
#error "the vizpane relay supports macOS only"
#endif

#define _DARWIN_C_SOURCE 1

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------------ */
/* Filter selection. The stub is a pass-through that only watches for bracketed
 * paste (CSI ?2004 h/l) and reports a cut point before every ASCII byte outside
 * its prefix match, so the process part can be tested without the real filter
 * and without any insertion. It does not track sequences, so a cut may fall
 * inside one; the tests that care about where a write ends use the real filter. */

#ifdef VF_STUB
#define VF_SLACK 16384
#define VF_CUT_GAP 64
#define VF_MAX_CUTS 1024
typedef struct vf {
  int tui;
  int st;
  unsigned transmits;
  uint32_t cut[VF_MAX_CUTS];
  unsigned ncut;
} vf_t;

static const char vf_stub_prefix[] = "\x1b[?2004";
#define VF_STUB_PREFIX_LEN 7

static void vf_init(vf_t *f, const char *session_dir) {
  (void)session_dir;
  f->tui = 0;
  f->st = 0;
  f->transmits = 0;
  f->ncut = 0;
}

static size_t vf_feed(vf_t *f, const unsigned char *in, size_t n, unsigned char *out, size_t cap) {
  size_t i, last = 0;
  int have = 0;
  (void)cap;
  f->ncut = 0;
  for (i = 0; i < n; i++) {
    unsigned char c = in[i];
    if (f->st == 0 && c < 0x80 && (!have || i - last >= VF_CUT_GAP) && f->ncut < VF_MAX_CUTS) {
      f->cut[f->ncut++] = (uint32_t)i;
      last = i;
      have = 1;
    }
    if (f->st == VF_STUB_PREFIX_LEN) {
      if (c == 'h') f->tui = 1;
      else if (c == 'l') f->tui = 0;
      f->st = 0;
    }
    if (f->st < VF_STUB_PREFIX_LEN && c == (unsigned char)vf_stub_prefix[f->st]) f->st++;
    else if (c == 0x1b) f->st = 1;
    else f->st = 0;
    out[i] = c;
  }
  if (n > 0 && f->st == 0 && f->ncut < VF_MAX_CUTS && (!have || last != n)) f->cut[f->ncut++] = (uint32_t)n;
  return n;
}

static size_t vf_flush(vf_t *f, unsigned char *out, size_t cap) {
  (void)out; (void)cap;
  f->ncut = 0;
  return 0;
}

static size_t vf_finish(vf_t *f, unsigned char *out, size_t cap) {
  (void)out; (void)cap;
  f->ncut = 0;
  return 0;
}

static int vf_held(const vf_t *f) { (void)f; return 0; }
static int vf_tui(const vf_t *f) { return f->tui; }
static unsigned vf_transmits(const vf_t *f) { return f->transmits; }
static unsigned vf_cuts(const vf_t *f, const uint32_t **offs) {
  *offs = f->cut;
  return f->ncut;
}
#else
#include "relay-filter.h"
#endif

/* ------------------------------------------------------------------------ */
/* Constants */

#define CHUNK 512                   /* most bytes of one write to the pane: it waits for POLLOUT, which on a
                                       pty means at most 256 of the queue's 1024 bytes are taken, so a chunk
                                       normally fits whole; a foreign write that took the room can still make
                                       the kernel split it */
#define CHUNK_MAX 768               /* only to reach a safe cut point; the free space after POLLOUT */
#define READ_MAX 1024               /* one read from the master: the inner queue holds no more */
#define READ_ROOM CHUNK             /* read the master only with at most one chunk pending, so Codex is
                                       throttled by the terminal as it is without a relay */
#define OUT_SIZE (READ_ROOM + READ_MAX + 2 * VF_SLACK)  /* a feed, then a flush, each with the filter's slack */
#define CUT_MAX 4096
#define FOLLOW_MS 40                /* delay of the follow-up SIGWINCH, see mirror_size */
#define HOLD_MS 5                   /* the filter's holdback timer */
#define TOSTOP_RETRY_MS 250         /* how long a refused background write waits for the child's stop, see out_step */
/* Upper bound for reading what Codex left in the master after it stopped or
 * exited. Normally the read ends at EAGAIN within microseconds; the bound
 * only matters when something that inherited the inner terminal keeps writing.
 * Time spent waiting for the pane does not count against it. */
#define DRAIN_GUARD_MS 2000

#define CONTRACT "s1"

/* ------------------------------------------------------------------------ */
/* Small helpers */

static long long mono_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void set_cloexec(int fd) {
  int fl = fcntl(fd, F_GETFD);
  if (fl >= 0) (void)fcntl(fd, F_SETFD, fl | FD_CLOEXEC);
}

static int set_nonblock(int fd) {
  int fl = fcntl(fd, F_GETFL);
  if (fl < 0) return -1;
  return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static int make_pipe(int fds[2]) {
  if (pipe(fds) != 0) return -1;
  set_cloexec(fds[0]);
  set_cloexec(fds[1]);
  return 0;
}

static void note(const char *msg) {
  size_t n = strlen(msg);
  ssize_t r = write(2, msg, n);
  (void)r; /* nothing useful to do if stderr is gone */
}

static int str_ends_with(const char *s, const char *suffix) {
  size_t a = strlen(s), b = strlen(suffix);
  return a >= b && strcmp(s + a - b, suffix) == 0;
}

/* ------------------------------------------------------------------------ */
/* Startup state captured before anything is changed, so Codex gets exactly
 * the signal dispositions and mask the shell gave the relay. */

static struct sigaction g_orig_act[NSIG];
static int g_orig_act_valid[NSIG];
static sigset_t g_orig_mask;

static void capture_signal_state(void) {
  int s;
  if (sigprocmask(SIG_SETMASK, NULL, &g_orig_mask) != 0) sigemptyset(&g_orig_mask);
  for (s = 1; s < NSIG; s++) {
    if (s == SIGKILL || s == SIGSTOP) continue;
    g_orig_act_valid[s] = sigaction(s, NULL, &g_orig_act[s]) == 0;
  }
}

static void restore_signal_state(void) {
  int s;
  for (s = 1; s < NSIG; s++) {
    if (s == SIGKILL || s == SIGSTOP) continue;
    if (g_orig_act_valid[s]) (void)sigaction(s, &g_orig_act[s], NULL);
  }
  (void)sigprocmask(SIG_SETMASK, &g_orig_mask, NULL);
}

/* ------------------------------------------------------------------------ */
/* Gating */

static int env_set(const char *name) {
  return getenv(name) != NULL;
}

static int env_nonempty(const char *name) {
  const char *v = getenv(name);
  return v != NULL && v[0] != '\0';
}

static int is_nonint_subcommand(const char *s) {
  static const char *const names[] = {
      "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "app-server",
      "completion", "sandbox", "debug", "apply", "a", "cloud", "cloud-tasks", "features",
      "help",
      /* Not in the design list: subcommands that never start a TUI, taken from
       * the Codex CLI definition and from the cmux wrapper's own list. */
      "plugin", "remote-control", "app", "doctor", "update", "archive", "delete",
      "unarchive", "exec-server", "execpolicy", "responses-api-proxy", "stdio-to-uds",
      "tcp-tunnel", "migrate-rollouts", "migrate-nfs-db", "queue",
  };
  size_t i;
  for (i = 0; i < sizeof names / sizeof names[0]; i++)
    if (strcmp(s, names[i]) == 0) return 1;
  return 0;
}

/* Options of the Codex CLI that take a separate value, so that the value is
 * not mistaken for the subcommand or the prompt. */
static int option_takes_value(const char *s) {
  static const char *const names[] = {
      "-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
      "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
      "--add-dir", "-a", "--ask-for-approval", "--remote", "--remote-auth-token-env",
      "--output-last-message",
  };
  size_t i;
  for (i = 0; i < sizeof names / sizeof names[0]; i++)
    if (strcmp(s, names[i]) == 0) return 1;
  return 0;
}

/* Returns NULL when the relay should run, otherwise the reason it must not. */
static const char *gate(int argc, char **argv) {
  const char *v;
  struct stat s0, s1;
  int i, skip = 0, sub_checked = 0;

  v = getenv("VIZPANE_INLINE");
  if (v != NULL && strcmp(v, "off") == 0) return "VIZPANE_INLINE=off";
  if (!isatty(0) || !isatty(1)) return "stdin or stdout is not a terminal";
  if (fstat(0, &s0) != 0 || fstat(1, &s1) != 0) return "fstat failed";
  if (!S_ISCHR(s0.st_mode) || !S_ISCHR(s1.st_mode) || s0.st_rdev != s1.st_rdev)
    return "stdin and stdout are different devices";
  /* Stock Codex started in the background stops at its first terminal setting,
   * after its probe has timed out. Leave that to Codex. */
  if (tcgetpgrp(0) != getpgrp()) return "not in the foreground of the terminal";
  if (!env_nonempty("CMUX_SURFACE_ID")) return "not inside cmux (CMUX_SURFACE_ID)";
  /* A relay above this one already carries Codex's output; a second pty would only add latency. */
  if (env_nonempty("VIZPANE_INLINE_DIR")) return "already inside a relay session";
  v = getenv("TERM_PROGRAM");
  if (v == NULL || strstr(v, "ghostty") == NULL) return "TERM_PROGRAM is not ghostty";
  /* Codex takes either variable for tmux and then writes OSC 52 on every copy. */
  if (env_set("TMUX") || env_set("TMUX_PANE")) return "inside tmux";
  if (env_set("ZELLIJ")) return "inside zellij";
  /* A terminal emulator started inside a cmux pane inherits CMUX_SURFACE_ID and
   * TERM_PROGRAM, but it cannot show kitty Unicode-placeholder pictures, and GNU
   * screen takes an APC as its hardstatus command. */
  if (env_set("STY")) return "inside GNU screen";
  if (env_set("VIM_TERMINAL")) return "inside a Vim terminal";
  if (env_set("NVIM")) return "inside a Neovim terminal";
  if (env_set("INSIDE_EMACS")) return "inside an Emacs terminal";
  v = getenv("TERMINAL_EMULATOR");
  if (v != NULL && strstr(v, "JediTerm") != NULL) return "inside a JetBrains terminal";
  v = getenv("TERM");
  if (v != NULL && (strncmp(v, "screen", 6) == 0 || strncmp(v, "tmux", 4) == 0))
    return "TERM is a multiplexer's";
  if (env_nonempty("NO_COLOR")) return "NO_COLOR is set";
  if (env_set("CODEX_THREAD_ID")) return "launched by a Codex tool (CODEX_THREAD_ID)";
  /* Over SSH Codex writes OSC 52 (a copy to the clipboard) to the terminal on every copy, a
   * writer the relay cannot keep out of its own writes, and the picture is sent as a path
   * on this machine. Herdr is treated as a multiplexer by Codex and gets the same OSC 52. */
  if (env_set("SSH_CONNECTION") || env_set("SSH_TTY")) return "inside an SSH session";
  v = getenv("HERDR_ENV");
  if (v != NULL && strcmp(v, "1") == 0) return "inside Herdr";

  for (i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "--") == 0) break;
    if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0 || strcmp(a, "-V") == 0 ||
        strcmp(a, "--version") == 0)
      return "help or version request";
  }
  for (i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (skip) {
      skip = 0;
      continue;
    }
    if (strcmp(a, "--") == 0) break;
    if (a[0] == '-' && a[1] != '\0') {
      if (strchr(a, '=') == NULL && option_takes_value(a)) skip = 1;
      continue;
    }
    if (!sub_checked) {
      sub_checked = 1;
      if (is_nonint_subcommand(a)) return "non-interactive subcommand";
    }
  }
  return NULL;
}

/* ------------------------------------------------------------------------ */
/* Real Codex resolution */

static int is_exec_file(const char *p) {
  struct stat st;
  return stat(p, &st) == 0 && S_ISREG(st.st_mode) && access(p, X_OK) == 0;
}

static int same_file(const char *a, const char *b) {
  struct stat sa, sb;
  if (stat(a, &sa) != 0 || stat(b, &sb) != 0) return 0;
  return sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

static struct stat g_self_st;
static int g_self_st_valid;

/* self_real may be empty when the relay could not find its own path. A copy or a
 * hard link of the relay is recognised by device and inode, and anything that
 * resolves to the cmux wrapper is skipped whatever it is named: running either
 * from here would start another relay. */
static int skip_candidate(const char *cand, const char *self_real) {
  const char *shim = getenv("CMUX_CODEX_WRAPPER_SHIM");
  const char *root = getenv("CMUX_CODEX_WRAPPER_SHIM_ROOT");
  struct stat cs;
  char cand_real[PATH_MAX];
  if (strstr(cand, "/cmux-cli-shims/") != NULL) return 1;
  if (g_self_st_valid && stat(cand, &cs) == 0 && cs.st_dev == g_self_st.st_dev &&
      cs.st_ino == g_self_st.st_ino)
    return 1;
  if (realpath(cand, cand_real) != NULL && str_ends_with(cand_real, "/cmux-codex-wrapper")) return 1;
  if (str_ends_with(cand, "/Resources/bin/codex")) return 1;
  if (shim != NULL && shim[0] != '\0' && same_file(cand, shim)) return 1;
  if (root != NULL && root[0] != '\0') {
    char want[PATH_MAX];
    size_t rl = strlen(root);
    while (rl > 1 && root[rl - 1] == '/') rl--;
    if (snprintf(want, sizeof want, "%.*s/codex", (int)rl, root) < (int)sizeof want &&
        strcmp(cand, want) == 0)
      return 1;
  }
  if (self_real[0] != '\0') {
    char real[PATH_MAX];
    if (realpath(cand, real) != NULL && strcmp(real, self_real) == 0) return 1;
  }
  return 0;
}

static int resolve_real(const char *self_real, char *out, size_t cap) {
  const char *over = getenv("VIZPANE_REAL_CODEX");
  const char *path = getenv("PATH");
  const char *p;

  if (over != NULL && over[0] != '\0' && is_exec_file(over)) {
    if (!skip_candidate(over, self_real) && strlen(over) < cap) {
      strcpy(out, over);
      return 0;
    }
  }
  if (path == NULL) return -1;
  p = path;
  for (;;) {
    const char *end = strchr(p, ':');
    size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
    char cand[PATH_MAX];
    int n;
    if (len == 0) n = snprintf(cand, sizeof cand, "./codex");
    else n = snprintf(cand, sizeof cand, "%.*s/codex", (int)len, p);
    if (n > 0 && (size_t)n < sizeof cand && !skip_candidate(cand, self_real) && is_exec_file(cand)) {
      if ((size_t)n < cap) {
        memcpy(out, cand, (size_t)n + 1);
        return 0;
      }
    }
    if (end == NULL) break;
    p = end + 1;
  }
  return -1;
}

static void self_path(char *out, size_t cap) {
  char raw[PATH_MAX];
  uint32_t sz = (uint32_t)sizeof raw;
  out[0] = '\0';
  if (_NSGetExecutablePath(raw, &sz) != 0) return;
  if (realpath(raw, out) == NULL) out[0] = '\0';
  (void)cap; /* realpath writes at most PATH_MAX and cap is PATH_MAX */
}

/* ------------------------------------------------------------------------ */
/* Session directory */

static int mkdir_one(const char *path) {
  if (mkdir(path, 0700) == 0) return 0;
  return errno == EEXIST ? 0 : -1;
}

/* opendir() allocates; this runs at start-up and at exit only, and a failure leaves a directory
 * that the next start removes as stale, so it is the one accepted exception to "no heap use
 * after start-up". */
static void remove_flat_dir(const char *dir) {
  DIR *d = opendir(dir);
  if (d != NULL) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      char p[PATH_MAX];
      if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
      if (snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= (int)sizeof p) continue;
      if (unlink(p) != 0) (void)rmdir(p);
    }
    (void)closedir(d);
  }
  (void)rmdir(dir);
}

/* Remove sibling session dirs whose relay is dead. Best effort. */
static void clean_stale(const char *sessions) {
  DIR *d = opendir(sessions);
  struct dirent *e;
  if (d == NULL) return;
  while ((e = readdir(d)) != NULL) {
    long pid;
    char *endp;
    char p[PATH_MAX];
    if (strncmp(e->d_name, CONTRACT "-", 3) != 0) continue;
    pid = strtol(e->d_name + 3, &endp, 10);
    if (endp == e->d_name + 3 || *endp != '-' || pid <= 0) continue;
    if (kill((pid_t)pid, 0) == 0 || errno != ESRCH) continue;
    if (snprintf(p, sizeof p, "%s/%s", sessions, e->d_name) >= (int)sizeof p) continue;
    remove_flat_dir(p);
  }
  (void)closedir(d);
}

static int make_session_dir(const char *root, char *out, size_t cap) {
  char inl[PATH_MAX], sessions[PATH_MAX];
  unsigned char rnd[8];
  int i;
  char hex[17];
  if (snprintf(inl, sizeof inl, "%s/inline", root) >= (int)sizeof inl) return -1;
  if (snprintf(sessions, sizeof sessions, "%s/inline/sessions", root) >= (int)sizeof sessions) return -1;
  if (mkdir_one(inl) != 0 || mkdir_one(sessions) != 0) return -1;
  clean_stale(sessions);
  arc4random_buf(rnd, sizeof rnd);
  for (i = 0; i < 8; i++) snprintf(hex + i * 2, 3, "%02x", rnd[i]);
  if (snprintf(out, cap, "%s/" CONTRACT "-%d-%s", sessions, (int)getpid(), hex) >= (int)cap) return -1;
  if (mkdir(out, 0700) != 0) return -1;
  return 0;
}

/* ------------------------------------------------------------------------ */
/* Relay */

static int g_sigpipe[2] = {-1, -1};
/* The last terminating signal (TERM, HUP, INT, QUIT) that arrived, set by the handler: relay_finish
 * looks at it after a stop, where it does not read the self-pipe. */
static volatile sig_atomic_t g_term_sig;

static void on_signal(int s) {
  int e = errno;
  unsigned char b = (unsigned char)s;
  if (s == SIGTERM || s == SIGHUP || s == SIGINT || s == SIGQUIT) g_term_sig = s;
  ssize_t r = write(g_sigpipe[1], &b, 1);
  (void)r; /* non-blocking self-pipe; a full pipe already means "wake up" */
  errno = e;
}

#ifdef VIZPANE_RELAY_DEBUG
static unsigned long g_dbg_chunks, g_dbg_partial, g_dbg_forced, g_dbg_long;
#define DBG(counter) ((counter)++)
static void dbg_dump(void) {
  const char *p = getenv("VIZPANE_RELAY_LOG");
  char line[160];
  int fd, n;
  if (p == NULL || p[0] == '\0') return;
  fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  n = snprintf(line, sizeof line, "chunks=%lu partials=%lu forced=%lu longseq=%lu\n", g_dbg_chunks,
               g_dbg_partial, g_dbg_forced, g_dbg_long);
  if (n > 0 && write(fd, line, (size_t)n) < 0) { /* best effort */ }
  (void)close(fd);
}
#else
#define DBG(counter) ((void)0)
static void dbg_dump(void) {}
#endif

static vf_t g_vf;
static unsigned char g_out[OUT_SIZE];   /* filter output not yet written to the pane */
static size_t g_cut[CUT_MAX];           /* safe cut points in g_out, ascending */
static unsigned char g_rd[READ_MAX];
static long long g_waited_ms;           /* time spent waiting for the pane, for the drain guard */

typedef struct relay {
  int pane;                       /* own write-only description of the terminal */
  int master;
  int hold;                       /* own descriptor of the inner slave, open until the last byte is out */
  pid_t child;
  int pane_dead;                  /* terminal hung up or errored: output is discarded from then on */
  int tostop_hold;                /* a background write was refused under TOSTOP: no writes until the child's
                                     stop (SIGCHLD), a SIGCONT or the retry timer, see out_step */
  long long tostop_ms;            /* when it was refused */
  int finishing;                  /* the child is gone: relay_finish is writing out what is left */
  int child_signaled;             /* ... and it died of a signal */
  int term_sig;                   /* a terminating signal that arrived while finishing, stopped */
  int master_done;                /* EOF or EIO on the master */
  int idle_flushed;               /* the filter was flushed after the last read */
  int tui_marker;
  unsigned last_transmits;
  size_t outlen, outoff, ncut;
  long long last_read_ms;
  long long follow_due_ms;  /* when the follow-up SIGWINCH is due, 0 for none */
  char dir[PATH_MAX];
  char tui_path[PATH_MAX];
  char resolved_path[PATH_MAX];
} relay_t;

static void sync_filter_state(relay_t *r) {
  int tui = vf_tui(&g_vf) ? 1 : 0;
  unsigned tx = vf_transmits(&g_vf);
  if (tui != r->tui_marker) {
    if (tui) {
      int fd = open(r->tui_path, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
      if (fd >= 0) (void)close(fd);
    } else {
      (void)unlink(r->tui_path);
    }
    r->tui_marker = tui;
  }
  if (tx != r->last_transmits) {
    int fd = open(r->resolved_path, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
    if (fd >= 0) {
      (void)futimes(fd, NULL);
      (void)close(fd);
    }
    r->last_transmits = tx;
  }
}

/* The pane's size goes to the relay's pty, so a program that asks its stdout for the
 * size gets the pane's. The pty is nobody's controlling terminal, so setting its size
 * signals no one; a reader of stdout's size that was woken by the pane's own SIGWINCH
 * before this ran has the old size, so one more SIGWINCH goes to the job, FOLLOW_MS
 * after the last time the size changed. The relay's own copy of it finds the sizes equal and ends the chain. */
static void mirror_size(relay_t *r, int follow) {
  struct winsize a, b;
  if (r->pane_dead || ioctl(r->pane, TIOCGWINSZ, &a) != 0) return;
  if (ioctl(r->master, TIOCGWINSZ, &b) == 0 && memcmp(&a, &b, sizeof a) == 0) return;
  if (ioctl(r->master, TIOCSWINSZ, &a) != 0) return;
#ifdef VIZPANE_RELAY_NOFOLLOW  /* a test build without the follow-up shows what the tests catch */
  follow = 0;
#endif
  /* Not at once: vim handles the pane's SIGWINCH, reads the size, and only looks at its
   * flag again when its select() is interrupted, so a second signal that arrives while it
   * is still handling the first is swallowed and its read stays stale until the next key.
   * A signal a few tens of ms later finds it back in select(). Each further resize
   * re-arms the timer, so the follow-up comes after the last one. */
  if (follow) r->follow_due_ms = mono_ms() + FOLLOW_MS;
}

/* ---- pending output and where it may be cut ---- */

/* Slide the unwritten bytes (and their cut points) down before appending. */
static void out_compact(relay_t *r) {
  size_t i, k = 0;
  if (r->outoff == 0) return;
  memmove(g_out, g_out + r->outoff, r->outlen - r->outoff);
  for (i = 0; i < r->ncut; i++)
    if (g_cut[i] > r->outoff) g_cut[k++] = g_cut[i] - r->outoff;
  r->ncut = k;
  r->outlen -= r->outoff;
  r->outoff = 0;
}

/* The filter's cut points for the bytes it just appended at offset base. A point that
 * does not fit is dropped, which only makes a later chunk longer. */
static void out_add_cuts(relay_t *r, size_t base) {
  const uint32_t *offs;
  unsigned n = vf_cuts(&g_vf, &offs), i;
  for (i = 0; i < n; i++) {
    size_t c = base + offs[i];
    if (r->ncut >= CUT_MAX) break;
    if (r->ncut > 0 && c <= g_cut[r->ncut - 1]) continue;
    g_cut[r->ncut++] = c;
  }
}

static void out_feed(relay_t *r, const unsigned char *in, size_t n) {
  size_t base;
  if (r->pane_dead) return;
  out_compact(r);
  base = r->outlen;
  r->outlen += vf_feed(&g_vf, in, n, g_out + base, OUT_SIZE - base);
  out_add_cuts(r, base);
  sync_filter_state(r);
}

static void out_flush_filter(relay_t *r) {
  size_t base;
  if (r->pane_dead) return;
  out_compact(r);
  base = r->outlen;
  r->outlen += vf_flush(&g_vf, g_out + base, OUT_SIZE - base);
  out_add_cuts(r, base);
  sync_filter_state(r);
}

/* Where to cut a run with no safe cut point of its own, at most n bytes in: at the start of a
 * character, so a short foreign write cannot land inside one, and preferably not between a
 * placeholder and the combining marks (U+0300..U+036F, lead byte 0xCC or 0xCD) that follow
 * it. Falls back to a plain character start, then to n. Only avail bytes are pending: the byte
 * at p[n] is the first of the next piece, and there is none when the run ends at n. */
static size_t utf8_cut(const unsigned char *p, size_t n, size_t avail) {
  size_t i, plain = 0;
  for (i = n; i > 0 && n - i < 64; i--) {
    if (i >= avail) {  /* beyond the pending bytes: the cut at the end of the run is always fine */
      if (i == n) return n;
      continue;
    }
    if ((p[i] & 0xC0) == 0x80) continue;  /* inside a character */
    if (plain == 0) plain = i;
    if (p[i] != 0xCC && p[i] != 0xCD) return i;
  }
  return plain != 0 ? plain : n;
}

/* How many pending bytes the next write takes: at most CHUNK, ending at the last safe
 * cut point within that; else at the first one within CHUNK_MAX. With none, a pending
 * string that already fills a chunk goes out in CHUNK pieces (no point inside it exists,
 * and the kernel would split a write that long in stock too); a shorter tail waits for
 * the rest of its sequence, unless force says the shell writes next or the timer ran
 * out. Returns 0 for "nothing may be written yet". *kind is 1 for a piece of a long
 * string, 2 for a forced tail. */
static size_t next_chunk(const relay_t *r, int force, int *kind) {
  size_t avail = r->outlen - r->outoff, lim, best = 0, near = 0, i;
  *kind = 0;
  if (avail == 0) return 0;
  lim = avail < CHUNK_MAX ? avail : CHUNK_MAX;
  for (i = 0; i < r->ncut; i++) {
    size_t d;
    if (g_cut[i] <= r->outoff) continue;
    d = g_cut[i] - r->outoff;
    if (d > lim) break;
    if (d <= CHUNK) best = d;
    else if (near == 0) near = d;
  }
  if (best == 0) best = near;
  if (best == 0 && avail >= CHUNK) {
    best = utf8_cut(g_out + r->outoff, CHUNK, avail);
    *kind = 1;
  }
  if (best == 0 && force) {
    best = avail;
    *kind = 2;
  }
  return best;
}

static void pane_lost(relay_t *r) {
  r->pane_dead = 1;
  r->outoff = r->outlen = 0;
  r->ncut = 0;
}

static void stop_self(int sig);

/* True when the relay is in a background group of the pane's session and the pane has TOSTOP,
 * the one case where an interrupted write to it is a terminal-output stop and not an ordinary
 * EINTR. Unknown counts as no: an ordinary EINTR just retries. */
static int pane_tostop_background(int pane) {
  struct termios t;
  pid_t fg = tcgetpgrp(pane);
  if (fg < 0 || fg == getpgrp()) return 0;
  return tcgetattr(pane, &t) == 0 && (t.c_lflag & TOSTOP) != 0;
}

/* One write of one chunk. Returns 1 if something happened (bytes written or the pane
 * was lost), 0 if nothing may be written or the pane took nothing. The caller has
 * seen POLLOUT, so the write fits whole unless a foreign write took the room. */
static int out_step(relay_t *r, int force) {
  int kind;
  size_t n = r->pane_dead ? 0 : next_chunk(r, force, &kind);
  ssize_t w;
  if (n == 0) return 0;
  w = write(r->pane, g_out + r->outoff, n);
  if (w > 0) {
    DBG(g_dbg_chunks);
    if ((size_t)w < n) DBG(g_dbg_partial);
    else if (kind == 1) DBG(g_dbg_long);
    else if (kind == 2) DBG(g_dbg_forced);
    r->outoff += (size_t)w;
    if (r->outoff == r->outlen) {
      r->outoff = r->outlen = 0;
      r->ncut = 0;
    }
    return 1;
  }
  if (w < 0 && errno == EINTR && pane_tostop_background(r->pane)) {
    /* A background write under TOSTOP: the kernel sent SIGTTOU to the whole group and, as the
     * relay catches it, returned EINTR instead of stopping it. Stock's writer would be stopped by
     * it and, continued by `kill %1` (SIGTERM, then SIGCONT), die of the pending SIGTERM before it
     * writes again. */
    if (!r->finishing) {
      /* The child got the same SIGTTOU and stops (Codex and sh both have the default action), and
       * follow_stop then stops the relay after it, like any stop of the child. Writing again before
       * that is the wrong order: after `kill %1` the retry is refused before the child's death is
       * read, and the relay stops again for good. So hold the output until the stop, a SIGCONT, or
       * a short while, for a child that catches or ignores SIGTTOU and never stops. */
      r->tostop_hold = 1;
      r->tostop_ms = mono_ms();
      return 0;
    }
    /* No child is left to follow. One that died of a signal (kill %1) did not write what is still
     * owed in stock either: discard it. After a normal exit stock's writer would be stopped at this
     * write, so stop, and write again when continued, unless a terminating signal came meanwhile. */
    if (!r->child_signaled) {
      g_term_sig = 0;
      stop_self(SIGTTOU);
      if (g_term_sig == 0) return 0;
      r->term_sig = g_term_sig;
    }
    pane_lost(r);
    return 1;
  }
  if (w < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  pane_lost(r);
  return 1;
}

/* Write everything that may go, waiting for the pane for as long as it takes: stock
 * Codex blocks in write() the same way, and a terminal that is merely busy must not
 * lose Codex's restore bytes. Only a failed write or a hang-up ends the wait. With
 * force the tail goes too. */
static void out_flush(relay_t *r, int force) {
  int kind;
  while (!r->pane_dead && !r->tostop_hold && next_chunk(r, force, &kind) > 0) {
    struct pollfd p;
    long long t0 = mono_ms();
    int ret;
    p.fd = r->pane;
    p.events = POLLOUT;
    p.revents = 0;
    ret = poll(&p, 1, -1);
    g_waited_ms += mono_ms() - t0;
    if (ret < 0 && errno == EINTR) continue;
    if (ret < 0) pane_lost(r);
    else (void)out_step(r, force);   /* ready, or HUP/ERR: the write reports it */
  }
}

/* Read what Codex has written until EAGAIN, so that the pane gets all of it before the
 * shell can write: the relay holds its own slave descriptor, so an empty queue is EAGAIN
 * and never EOF. The guard only stops a leaked writer from holding the relay forever;
 * the time the pane takes to accept bytes is not counted. */
static void drain_master(relay_t *r) {
  long long t0 = mono_ms(), w0 = g_waited_ms;
  while (!r->master_done) {
    ssize_t n;
    /* Output held back (TOSTOP): what is not read stays in the pty, where the child's own
     * writes wait as well, so the buffer does not grow. */
    if (r->tostop_hold && r->outlen - r->outoff > READ_ROOM) break;
    n = read(r->master, g_rd, sizeof g_rd);
    if (n > 0) {
      out_feed(r, g_rd, (size_t)n);
      out_flush(r, 0);
      if (mono_ms() - t0 - (g_waited_ms - w0) >= DRAIN_GUARD_MS) break;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    r->master_done = 1;  /* EOF or EIO: every slave descriptor is closed */
  }
  out_flush_filter(r);
  out_flush(r, 1);
}

/* ---- stop and exit ---- */

/* Stops the relay with the signal that stopped Codex, so the shell sees the job stop with
 * the same reason. kill(getpid()), not kill(0): the rest of the group is stopped already. */
static void stop_self(int sig) {
  struct sigaction dfl, old;
  sigset_t unblock, prev;
  memset(&dfl, 0, sizeof dfl);
  dfl.sa_handler = SIG_DFL;
  sigemptyset(&dfl.sa_mask);
  (void)sigaction(sig, &dfl, &old);
  sigemptyset(&unblock);
  sigaddset(&unblock, sig);
  (void)sigprocmask(SIG_UNBLOCK, &unblock, &prev);
  (void)kill(getpid(), sig);
  (void)sigprocmask(SIG_SETMASK, &prev, NULL);
  (void)sigaction(sig, &old, NULL);
}

/* waitpid() can still report a stop the child has already left: `fg` continues the job while the
 * relay, stopped with it, has not read its SIGCHLD yet. Stopping then would stop a running Codex's job
 * again. Asks the kernel for the child's state. Unknown counts as stopped. */
static int child_stopped(pid_t pid) {
  struct proc_bsdinfo bi;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi) != (int)sizeof bi) return 1;
  return bi.pbi_status == 4;  /* SSTOP */
}

/* Codex stopped (Ctrl+Z: its restore bytes, then kill(0, SIGTSTP)). Everything it wrote
 * is in the master, and nothing else of the job will write until the shell does. */
static void follow_stop(relay_t *r, int sig) {
#ifndef VIZPANE_RELAY_NODRAIN  /* a test build without the drain shows what the tests catch */
  drain_master(r);
#endif
  if (!child_stopped(r->child)) return;
  /* A child stopped around its execve() is reported stopped and then runs on without a SIGCONT
   * (seen on macOS). A real stop stays: look again after a moment before following it. The 10 ms
   * is a guess, not a measurement: the race was never reproduced here, so how much of it this
   * covers is unknown; it costs one short sleep per stop. */
  {
    struct timespec ts = {0, 10 * 1000000};
    (void)nanosleep(&ts, NULL);
  }
  if (!child_stopped(r->child)) return;
  stop_self(sig);
  r->tostop_hold = 0;
  /* Continued by the SIGCONT that went to the whole job, Codex included: the size may have changed
   * while the job was stopped. */
  mirror_size(r, 1);
}

static int status_to_code(int st, int *sig_out) {
  *sig_out = 0;
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) {
    *sig_out = WTERMSIG(st);
    return 128 + WTERMSIG(st);
  }
  return 1;
}

static void relay_finish(relay_t *r, int st) __attribute__((noreturn));

static void relay_finish(relay_t *r, int st) {
  int sig, code;
  r->finishing = 1;
  r->tostop_hold = 0;
  r->child_signaled = WIFSIGNALED(st) ? 1 : 0;
  drain_master(r);
  if (!r->pane_dead) {
    size_t base;
    out_compact(r);
    base = r->outlen;
    r->outlen += vf_finish(&g_vf, g_out + base, OUT_SIZE - base);
    out_add_cuts(r, base);
  }
  sync_filter_state(r);
  out_flush(r, 1);
  dbg_dump();
  (void)unlink(r->tui_path);
  remove_flat_dir(r->dir);
  /* Master first, then our slave: whatever still holds the pty gets EIO on its next
   * write instead of writing into the shell's prompt. */
  (void)close(r->master);
  (void)close(r->hold);
  code = status_to_code(st, &sig);
  if (sig == 0 && r->term_sig != 0) {
    /* Stopped on the last write, and told to end: end the way stock's writer would have. */
    sig = r->term_sig;
    code = 128 + sig;
  }
  if (sig != 0) {
    struct rlimit nocore = {0, 0};
    sigset_t none;
    /* The child's core, if any, is its own; the relay must not write another. */
    (void)setrlimit(RLIMIT_CORE, &nocore);
    signal(sig, SIG_DFL);
    sigemptyset(&none);
    (void)sigprocmask(SIG_SETMASK, &none, NULL);
    (void)kill(getpid(), sig);
  }
  _exit(code);
}

/* The signals the self-pipe delivered. */
static void handle_signals(relay_t *r) {
  unsigned char sigs[32];
  for (;;) {
    ssize_t n = read(g_sigpipe[0], sigs, sizeof sigs), i;
    if (n <= 0) return;
    for (i = 0; i < n; i++) {
      int s = sigs[i];
      if (s == SIGCHLD) {
        for (;;) {
          int st = 0;
          pid_t w = waitpid(r->child, &st, WUNTRACED | WNOHANG);
          if (w != r->child) break;
          if (WIFSTOPPED(st)) follow_stop(r, WSTOPSIG(st));
          else relay_finish(r, st);
        }
      } else if (s == SIGTSTP || s == SIGTTIN || s == SIGTTOU) {
        /* Never passed on, and never a reason to stop: a SIGTSTP is Codex's own kill(0) or the
         * terminal's group stop, a SIGTTIN or SIGTTOU is the kernel's answer to somebody else in
         * the group reading or writing the terminal from the background, and Codex got each one
         * too. The relay stops only when its child is seen stopped (SIGCHLD, follow_stop), and
         * for its own blocked pane write (out_step). Stopping on these at once, as the default
         * action does, strands it: when the group's last reader dies with such a signal pending,
         * nobody is left to continue the relay, and its dead child stays unreaped. A copy handled
         * after a later continue would also stop a running job. */
      } else if (s == SIGCONT) {
        /* Not passed on. fg, bg and kill -CONT %1 send it to the whole job, so Codex has it already, and
         * a copy that arrives after Codex stopped itself again (bg: its first terminal setting stops it
         * with SIGTTOU) would continue it in the background and make it do that again. A SIGCONT sent to
         * the relay alone reaches stock's launcher alone, too. Only the size may have changed. */
        r->tostop_hold = 0;
        mirror_size(r, 1);
      } else if (s == SIGWINCH) {
        mirror_size(r, 1);
      } else {
        /* To the child only: kill(0) would come straight back to the relay. */
        (void)kill(r->child, s);
      }
    }
  }
}

static void relay_loop(relay_t *r) {
  int nopoll = 0;
  for (;;) {
    struct pollfd p[3];
    int timeout = -1, force = 0, kind, held, ret;
    size_t pend = r->outlen - r->outoff;
    int may_write = pend > 0 && !r->tostop_hold && next_chunk(r, 0, &kind) > 0;

    /* A tail inside a sequence that is still arriving, or something the filter holds back,
     * waits for the rest only a moment: Codex may have gone quiet. */
    held = !r->pane_dead && !r->tostop_hold && ((vf_held(&g_vf) > 0 && !r->idle_flushed) || (pend > 0 && !may_write));
    if (held) {
      long long left = r->last_read_ms + HOLD_MS - mono_ms();
      if (left > 0) {
        timeout = (int)left;
      } else {
        if (vf_held(&g_vf) > 0 && !r->idle_flushed) {
          out_flush_filter(r);
          r->idle_flushed = 1;
          pend = r->outlen - r->outoff;
        }
        force = pend > 0;
      }
    }

    if (r->tostop_hold) {
      long long left = r->tostop_ms + TOSTOP_RETRY_MS - mono_ms();
      if (left <= 0) {
        /* The child did not stop: it catches or ignores SIGTTOU, so nothing will follow. A child
         * that is stopped has its SIGCHLD on the way, and is waited for. */
        if (child_stopped(r->child)) r->tostop_ms = mono_ms();
        else r->tostop_hold = 0;
        continue;
      }
      if (timeout < 0 || left < timeout) timeout = (int)left;
    }

    if (r->follow_due_ms != 0) {
      long long left = r->follow_due_ms - mono_ms();
      if (left <= 0) {
        r->follow_due_ms = 0;
        (void)kill(0, SIGWINCH);
      } else if (timeout < 0 || left < timeout) {
        timeout = (int)left;
      }
    }

    p[0].fd = r->master_done ? -1 : r->master;
    p[0].events = pend <= READ_ROOM ? POLLIN : 0;
    p[0].revents = 0;
    /* Every write waits for POLLOUT, so the pane's queue holds at most 256 bytes and a chunk of
     * at most 512 fits whole. Without events the descriptor still reports a hang-up. */
    p[1].fd = r->pane_dead ? -1 : r->pane;
    p[1].events = (pend > 0 && !r->tostop_hold && (force || may_write)) ? POLLOUT : 0;
    p[1].revents = 0;
    p[2].fd = g_sigpipe[0];
    p[2].events = POLLIN;
    p[2].revents = 0;

    if (nopoll) {
      /* poll() itself failed for a reason that cannot happen on these descriptors: carry on
       * as a plain copy loop so that Codex's session survives and its restore bytes arrive. */
      struct timespec ts = {0, 1000000};
      (void)nanosleep(&ts, NULL);
      p[0].revents = p[0].events;
      p[1].revents = p[1].events;
      p[2].revents = POLLIN;
    } else {
      ret = poll(p, 3, timeout);
      if (ret < 0) {
        if (errno == EINTR) continue;
        nopoll = 1;
        continue;
      }
    }

    if ((p[1].revents & (POLLOUT | POLLHUP | POLLERR | POLLNVAL)) != 0) {
      if ((p[1].revents & (POLLHUP | POLLERR | POLLNVAL)) != 0 && (p[1].revents & POLLOUT) == 0) pane_lost(r);
      else (void)out_step(r, force);
    }
    if ((p[0].revents & (POLLIN | POLLHUP)) != 0 && !r->master_done) {
      ssize_t n = read(r->master, g_rd, sizeof g_rd);
      if (n > 0) {
        out_feed(r, g_rd, (size_t)n);
        r->last_read_ms = mono_ms();
        r->idle_flushed = 0;
      } else if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) {
        r->master_done = 1;
      }
    }
    if ((p[2].revents & POLLIN) != 0) handle_signals(r);
  }
}

/* ------------------------------------------------------------------------ */

static void exec_real(const char *real, char **argv) __attribute__((noreturn));

static void exec_real(const char *real, char **argv) {
  int e;
  argv[0] = (char *)real;
  execv(real, argv);
  e = errno;
  note("codex: ");
  note(real);
  note(": ");
  note(strerror(e));
  note("\n");
  _exit(e == ENOENT ? 127 : 126);
}

/* The child's side of the fork: stdout (and stderr, if it was the pane) becomes the relay's
 * pty, everything else stays as the shell gave it. */
static void child_main(const char *slave_name, int err_follows, const char *session_dir, const char *pane_tty,
                       const char *real, char **argv) __attribute__((noreturn));

static void child_main(const char *slave_name, int err_follows, const char *session_dir, const char *pane_tty,
                       const char *real, char **argv) {
  /* A fresh description, so that O_NONBLOCK, which Codex's terminal probe sets on a
   * duplicate of its stdin, never reaches its stdout. */
  int o = open(slave_name, O_RDWR | O_NOCTTY);
  if (o < 0 || dup2(o, 1) < 0) {
    note("vizpane relay: cannot open the output terminal\n");
    _exit(125);
  }
  /* Codex keeps stray stderr output off its screen only if stdout and stderr are one
   * file, so stderr follows stdout when it was the pane. A redirect stays one. */
  if (err_follows && dup2(1, 2) < 0) _exit(125);
  if (o > 2) (void)close(o);
  if (setenv("VIZPANE_INLINE_DIR", session_dir, 1) != 0 || setenv("VIZPANE_TTY", pane_tty, 1) != 0) {
    note("vizpane relay: setenv failed\n");
    _exit(125);
  }
  restore_signal_state();
  exec_real(real, argv);
}

/* Returns only on setup failure, before anything irreversible happened. */
static int run_relay(const char *root, const char *real, char **argv) {
  static relay_t r;
  char ttypath[PATH_MAX], slave_name[PATH_MAX];
  const char *tn, *sn;
  struct termios t;
  struct stat s0, s2;
  struct winsize ws;
  int master = -1, hold = -1, pane = -1, err_follows;
  pid_t pid;
  sigset_t block, old;
  struct sigaction sa;
  const int handled[] = {SIGCHLD, SIGTSTP, SIGTTIN, SIGTTOU, SIGCONT, SIGWINCH, SIGINT, SIGQUIT, SIGTERM, SIGHUP,
                         SIGUSR1, SIGUSR2, SIGALRM, SIGVTALRM, SIGPROF, SIGXCPU, SIGXFSZ};
  size_t i;

  memset(&r, 0, sizeof r);
  tn = ttyname(0);
  if (tn == NULL || strlen(tn) >= sizeof ttypath) return -1;
  strcpy(ttypath, tn);
  err_follows = fstat(0, &s0) == 0 && fstat(2, &s2) == 0 && S_ISCHR(s2.st_mode) && s2.st_rdev == s0.st_rdev;

  if (make_session_dir(root, r.dir, sizeof r.dir) != 0) return -1;
  if (snprintf(r.tui_path, sizeof r.tui_path, "%s/tui", r.dir) >= (int)sizeof r.tui_path ||
      snprintf(r.resolved_path, sizeof r.resolved_path, "%s/resolved", r.dir) >= (int)sizeof r.resolved_path)
    goto fail;

  /* Our own description of the pane, write-only: it cannot read a key, and the shell's
   * descriptors never get O_NONBLOCK from us. */
  pane = open(ttypath, O_WRONLY | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (pane < 0) goto fail;
  if (tcgetattr(0, &t) != 0 || ioctl(pane, TIOCGWINSZ, &ws) != 0) goto fail;

  master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0) goto fail;
  set_cloexec(master);
  if (grantpt(master) != 0 || unlockpt(master) != 0) goto fail;
  sn = ptsname(master);
  if (sn == NULL || strlen(sn) >= sizeof slave_name) goto fail;
  strcpy(slave_name, sn);
  /* Held until the last byte is out: when the last slave descriptor closes, macOS discards
   * the output nobody has read yet, after a pause of about 600 ms. */
  hold = open(slave_name, O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (hold < 0) goto fail;
  /* The pane's settings with output processing off, once: the pane applies its own when the
   * relay writes, so the bytes are processed once, as in stock. */
  t.c_oflag &= ~(tcflag_t)OPOST;
  if (tcsetattr(hold, TCSANOW, &t) != 0) goto fail;
  if (ioctl(master, TIOCSWINSZ, &ws) != 0) goto fail;
  if (set_nonblock(master) != 0) goto fail;

  if (make_pipe(g_sigpipe) != 0 || set_nonblock(g_sigpipe[0]) != 0 || set_nonblock(g_sigpipe[1]) != 0) goto fail;
  vf_init(&g_vf, r.dir);

  /* Block the signals we handle until the handlers exist, so none is lost to its default
   * action in between. The child restores the shell's mask itself. */
  sigemptyset(&block);
  for (i = 0; i < sizeof handled / sizeof handled[0]; i++) sigaddset(&block, handled[i]);
  if (sigprocmask(SIG_BLOCK, &block, &old) != 0) goto fail;

  pid = fork();
  if (pid < 0) {
    (void)sigprocmask(SIG_SETMASK, &old, NULL);
    goto fail;
  }
  if (pid == 0) child_main(slave_name, err_follows, r.dir, ttypath, real, argv);

  r.pane = pane;
  r.master = master;
  r.hold = hold;
  r.child = pid;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  for (i = 0; i < sizeof handled / sizeof handled[0]; i++) {
    /* A terminal-access stop signal the shell left ignored stays ignored: stock Codex would not
     * stop on it, and a background write of ours would succeed. */
    if ((handled[i] == SIGTTIN || handled[i] == SIGTTOU) && g_orig_act_valid[handled[i]] &&
        g_orig_act[handled[i]].sa_handler == SIG_IGN)
      continue;
    (void)sigaction(handled[i], &sa, NULL);
  }
  signal(SIGPIPE, SIG_IGN);
  /* The mask we were started with, minus the signals handled here: a launcher that left
   * SIGCHLD blocked would otherwise keep the relay from ever seeing Codex exit or stop. */
  for (i = 0; i < sizeof handled / sizeof handled[0]; i++) sigdelset(&old, handled[i]);
  (void)sigprocmask(SIG_SETMASK, &old, NULL);

  relay_loop(&r);
  _exit(1);  /* not reached: relay_finish ends the process */

fail:
  if (pane >= 0) (void)close(pane);
  if (master >= 0) (void)close(master);
  if (hold >= 0) (void)close(hold);
  remove_flat_dir(r.dir);
  return -1;
}

static void probe(int argc, char **argv, const char *root, const char *real_or_null) {
  const char *why = gate(argc, argv);
  if (why == NULL) printf("gate: relay\n");
  else printf("gate: direct (%s)\n", why);
  printf("real: %s\n", real_or_null != NULL ? real_or_null : "(not found)");
  printf("root: %s\n", root[0] != '\0' ? root : "(unknown)");
  fflush(stdout);
}

int main(int argc, char **argv) {
  char self[PATH_MAX], root[PATH_MAX], real[PATH_MAX];
  const char *why;
  const char *pr;
  int have_real;

  capture_signal_state();
  self_path(self, sizeof self);
  g_self_st_valid = self[0] != '\0' && stat(self, &g_self_st) == 0;
  root[0] = '\0';
  if (self[0] != '\0') {
    /* <root>/relay/codex -> <root>. A copy anywhere else has no state root: it
     * runs the real Codex instead of creating directories next to itself. */
    char *slash;
    strcpy(root, self);
    slash = strrchr(root, '/');
    if (slash != NULL) *slash = '\0';
    slash = strrchr(root, '/');
    if (slash != NULL && strcmp(slash, "/relay") == 0) *slash = '\0';
    else root[0] = '\0';
  }
  have_real = resolve_real(self, real, sizeof real) == 0;

  pr = getenv("VIZPANE_RELAY_PROBE");
  if (pr != NULL && strcmp(pr, "1") == 0) {
    probe(argc, argv, root, have_real ? real : NULL);
    return 0;
  }
  if (!have_real) {
    note("Error: codex not found in PATH\n");
    return 127;
  }

  why = gate(argc, argv);
  if (why != NULL || root[0] == '\0') exec_real(real, argv);
  if (access(real, X_OK) != 0) exec_real(real, argv);

  (void)run_relay(root, real, argv);
  /* Setup failed: stock Codex. */
  exec_real(real, argv);
}
