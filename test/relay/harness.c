/*
 * Test harness for the relay: an outer pty that plays "the terminal and the
 * shell". It runs a program the way an interactive shell would (own session,
 * own foreground process group, the pty as controlling terminal), copies bytes
 * between its stdin/stdout and the pty master, and reports job-control events.
 *
 *   harness [-i] [-o] [-b] [-z] [-e file] [-s cols,rows,xpix,ypix] [-q quiet_ms] -- prog args...
 *   harness --winsz            print "cols rows xpix ypix" of stdin and exit
 *
 *   -i  run the program with stdin on /dev/null (not a terminal)
 *   -o  run the program with stdout on /dev/null
 *   -b  run the program as a background job: the "shell" keeps the terminal
 *   -z  the program itself is the shell: it is exec'd as the session leader of the
 *       terminal (a real `/bin/zsh -i`), and there is no job-control stand-in. Its
 *       exit is reported as EXIT or SIGNAL, its pid as PID; the test types the
 *       command lines and reads job-control reports from the terminal output
 *   -e  run the program with stderr redirected to this file, like `2>file`
 *   -s  initial window size, pixel fields included (default 80,24,800,480)
 *   -q  after the program ended, keep reading the terminal until it has been
 *       silent for this long (default 300); leftover helper processes such as
 *       a process Codex left behind can still write then
 *
 * fd 0   bytes typed at the terminal (to the pty master)
 * fd 1   bytes the terminal received (from the pty master)
 * fd 3   control lines in:  W cols rows xpix ypix | CONT | BGJOB | KILLJOB | READIN | T | PAUSE | RESUME |
 *                           SLOW bytes usec | HANGUP | QUIT
 *        (CONT is the shell's `fg`; KILLJOB is `kill %1`: SIGTERM and SIGCONT to the job,
 *        the shell stays in the foreground; READIN reads what is queued in the terminal)
 *        (PAUSE stops reading the terminal, to model a busy one; SLOW reads at most that many
 *        bytes, then sleeps that many microseconds, to model a slow one; SLOW 0 0 ends it;
 *        HANGUP closes the terminal's master side, as a closed pane does)
 * fd 4   event lines out:   TTY path | PID n | STOPPED bytes t sig | TERMIOS ... | TYPEAHEAD hex |
 *                           EXIT code bytes t | SIGNAL n bytes t
 *        (the job is the shell's child; it is waited for with WUNTRACED, so a stop of
 *        its process group shows here with the signal that stopped it. After the job
 *        ended the shell reports what was left in the terminal's input as TYPEAHEAD.)
 *
 * "bytes" is how many terminal bytes the harness had read when the event was
 * observed, so a test can check what had been written before a stop.
 * The "shell" process stays alive after the program ended, like a real shell,
 * because a session leader's exit would revoke the terminal.
 */
#define _DARWIN_C_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <util.h>

#define QUIET_CAP_MS 3000

static volatile sig_atomic_t g_cont;
static volatile sig_atomic_t g_killjob;
static volatile sig_atomic_t g_readin;
static volatile sig_atomic_t g_bgjob;
static volatile sig_atomic_t g_quit;
static int g_slow_bytes, g_slow_us;

static void on_usr1(int s) { (void)s; g_cont = 1; }
static void on_usr2(int s) { (void)s; g_killjob = 1; }
static void on_urg(int s) { (void)s; g_readin = 1; }
static void on_xcpu(int s) { (void)s; g_bgjob = 1; }
static void on_quit(int s) { (void)s; g_quit = 1; }

static long long now_ms(void) {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) != 0) return 0;
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void die(const char *what) {
  perror(what);
  _exit(99);
}

static void cloexec(int fd) {
  int fl = fcntl(fd, F_GETFD);
  if (fl >= 0 && fcntl(fd, F_SETFD, fl | FD_CLOEXEC) != 0) die("fcntl");
}

static void nonblock(int fd) {
  int fl = fcntl(fd, F_GETFL);
  if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) != 0) die("fcntl nonblock");
}

static int fd_open(int fd) { return fcntl(fd, F_GETFD) >= 0; }

static void write_fully(int fd, const void *buf, size_t n) {
  const char *p = buf;
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w > 0) {
      p += w;
      n -= (size_t)w;
    } else if (w < 0 && errno == EINTR) {
      continue;
    } else if (w < 0 && errno == EAGAIN) {
      struct pollfd pf = {fd, POLLOUT, 0};
      (void)poll(&pf, 1, 100);
    } else {
      return; /* the reader is gone; the test is over */
    }
  }
}

/* ---- the "shell" ------------------------------------------------------- */

/* What is in the terminal's input, without touching the descriptor's flags (the
 * job shares the description). Once something is there it keeps reading until
 * HARNESS_QUIET_MS pass without a new byte, because a terminal emulator that held
 * a long paste back refills the queue as it is read, which a single look at the
 * queue cannot see. The event carries the first 512 bytes in hex; if
 * HARNESS_TYPEAHEAD_FILE is set, everything goes there. */
static void report_typeahead(int ev) {
  struct pollfd pf = {0, POLLIN, 0};
  static char buf[1 << 17];
  char line[1200];
  size_t n = 0, i, shown;
  const char *path = getenv("HARNESS_TYPEAHEAD_FILE");
  int len, wait_ms = path != NULL ? 250 : 0;
  while (n < sizeof buf && poll(&pf, 1, wait_ms) > 0 && (pf.revents & POLLIN)) {
    ssize_t k = read(0, buf + n, sizeof buf - n);
    if (k <= 0) break;
    n += (size_t)k;
    wait_ms = 250;
  }
  if (path != NULL) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
      write_fully(fd, buf, n);
      (void)close(fd);
    }
  }
  shown = n < 512 ? n : 512;
  len = snprintf(line, sizeof line, "TYPEAHEAD ");
  for (i = 0; i < shown; i++) len += snprintf(line + len, sizeof line - (size_t)len, "%02x", (unsigned char)buf[i]);
  line[len++] = '\n';
  write_fully(ev, line, (size_t)len);
}

static void shell_main(int slave, int ev, int release, int no_in, int no_out, int bg, const char *errfile,
                       char **cmd) __attribute__((noreturn));

static void shell_main(int slave, int ev, int release, int no_in, int no_out, int bg, const char *errfile,
                       char **cmd) {
  pid_t job;
  struct sigaction sa;
  int st = 0;
  char line[96];

  if (setsid() < 0) die("setsid");
  if (ioctl(slave, TIOCSCTTY, 0) != 0) die("TIOCSCTTY");
  if (dup2(slave, 0) < 0 || dup2(slave, 1) < 0 || dup2(slave, 2) < 0) die("dup2");
  if (slave > 2) (void)close(slave);
  signal(SIGTTOU, SIG_IGN);
  signal(SIGHUP, SIG_IGN);   /* the terminal's hang-up must not end the stand-in before it reports the job */

  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_usr1;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGUSR1, &sa, NULL) != 0) die("sigaction");
  sa.sa_handler = on_usr2;
  if (sigaction(SIGUSR2, &sa, NULL) != 0) die("sigaction");
  sa.sa_handler = on_urg;
  if (sigaction(SIGURG, &sa, NULL) != 0) die("sigaction");
  sa.sa_handler = on_xcpu;
  if (sigaction(SIGXCPU, &sa, NULL) != 0) die("sigaction");

  job = fork();
  if (job < 0) die("fork");
  if (job == 0) {
    if (setpgid(0, 0) != 0 && getpgrp() != getpid()) die("setpgid");
    if (!bg && tcsetpgrp(0, getpid()) != 0) die("tcsetpgrp");
    signal(SIGTTOU, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGUSR1, SIG_DFL);
    signal(SIGUSR2, SIG_DFL);
    signal(SIGURG, SIG_DFL);
    signal(SIGXCPU, SIG_DFL);
    if (errfile != NULL) {
      int fd = open(errfile, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd < 0 || dup2(fd, 2) < 0) die("stderr");
      if (fd > 2) (void)close(fd);
    }
    if (no_in) {
      int fd = open("/dev/null", O_RDONLY);
      if (fd < 0 || dup2(fd, 0) < 0) die("stdin");
      if (fd > 2) (void)close(fd);
    }
    if (no_out) {
      int fd = open("/dev/null", O_WRONLY);
      if (fd < 0 || dup2(fd, 1) < 0) die("stdout");
      if (fd > 2) (void)close(fd);
    }
    execvp(cmd[0], cmd);
    die("exec");
  }
  if (setpgid(job, job) != 0 && errno != EACCES && errno != EPERM) die("setpgid parent");
  if (!bg && tcsetpgrp(0, job) != 0) die("tcsetpgrp parent");
  snprintf(line, sizeof line, "PID %d\n", (int)job);
  write_fully(ev, line, strlen(line));

  for (;;) {
    pid_t w = waitpid(job, &st, WUNTRACED | WNOHANG);
    if (w == job) {
      if (WIFSTOPPED(st)) {
        /* A shell takes the terminal back when its job stops, so it can read the line the user types next. */
        (void)tcsetpgrp(0, getpgrp());
        snprintf(line, sizeof line, "STOPPED %d\n", WSTOPSIG(st));
        write_fully(ev, line, strlen(line));
      } else {
        if (WIFEXITED(st)) snprintf(line, sizeof line, "EXIT %d\n", WEXITSTATUS(st));
        else snprintf(line, sizeof line, "SIGNAL %d\n", WTERMSIG(st));
        write_fully(ev, line, strlen(line));
        break;
      }
    } else if (w < 0 && errno != EINTR) {
      break;
    }
    if (g_cont) {
      g_cont = 0;
      (void)tcsetpgrp(0, job); /* what a shell's fg does */
      (void)kill(-job, SIGCONT);
    }
    if (g_bgjob) {
      g_bgjob = 0;
      /* `bg`: continue the job and leave the terminal with the shell */
      (void)kill(-job, SIGCONT);
    }
    if (g_killjob) {
      g_killjob = 0;
      /* `kill %1`: the shell stays in the foreground, so the continued job is in the background */
      (void)kill(-job, SIGTERM);
      (void)kill(-job, SIGCONT);
    }
    if (g_readin) {
      g_readin = 0;
      report_typeahead(ev);
    }
    {
      struct timespec ts = {0, 2000000};
      (void)nanosleep(&ts, NULL);
    }
  }
  (void)tcsetpgrp(0, getpgrp());
  report_typeahead(ev);
  /* Stay alive, like a shell at its prompt, until the harness lets go. */
  {
    char b;
    ssize_t r;
    do {
      r = read(release, &b, 1);
    } while (r < 0 && errno == EINTR);
  }
  _exit(0);
}

/* ---- the terminal side ------------------------------------------------- */

static int g_master = -1;
static long long g_total;
static unsigned char g_inbuf[65536];
static size_t g_inlen, g_inoff;
static int g_master_done;
static int g_paused;

/* Move what the program wrote to our stdout; returns bytes moved. */
static size_t pump_master(void) {
  unsigned char buf[65536];
  size_t total = 0;
  while (!g_master_done && !g_paused) {
    ssize_t n = read(g_master, buf, g_slow_bytes > 0 ? (size_t)g_slow_bytes : sizeof buf);
    if (n > 0) {
      if (g_slow_bytes > 0) {
        struct timespec ts = {g_slow_us / 1000000, (g_slow_us % 1000000) * 1000L};
        write_fully(1, buf, (size_t)n);
        g_total += n;
        total += (size_t)n;
        (void)nanosleep(&ts, NULL);
        /* One slow chunk per pass: the main loop polls the control pipe (HANGUP, RESUME, ...) between
         * chunks. Looping here until the master runs dry would postpone every control line until the
         * program stops writing, so a hang-up "while Codex streams" waited for the whole stream. */
        break;
      }
      write_fully(1, buf, (size_t)n);
      g_total += n;
      total += (size_t)n;
    } else if (n < 0 && errno == EINTR) {
      continue;
    } else if (n < 0 && errno == EAGAIN) {
      break;
    } else {
      g_master_done = 1;
    }
  }
  return total;
}

static void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void emit(const char *fmt, ...) {
  char line[2048];
  va_list ap;
  int n;
  va_start(ap, fmt);
  n = vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  if (n > 0 && n < (int)sizeof line) write_fully(4, line, (size_t)n);
}

static pid_t g_shell, g_job;

static void do_control(const char *line) {
  unsigned c, r, xp, yp;
  if (sscanf(line, "W %u %u %u %u", &c, &r, &xp, &yp) == 4) {
    struct winsize ws;
    memset(&ws, 0, sizeof ws);
    ws.ws_col = (unsigned short)c;
    ws.ws_row = (unsigned short)r;
    ws.ws_xpixel = (unsigned short)xp;
    ws.ws_ypixel = (unsigned short)yp;
    if (ioctl(g_master, TIOCSWINSZ, &ws) != 0) perror("TIOCSWINSZ");
  } else if (strncmp(line, "CONT", 4) == 0) {
    (void)kill(g_shell, SIGUSR1);
  } else if (strncmp(line, "KILLJOB", 7) == 0) {
    (void)kill(g_shell, SIGUSR2);
  } else if (strncmp(line, "BGJOB", 5) == 0) {
    (void)kill(g_shell, SIGXCPU);
  } else if (strncmp(line, "READIN", 6) == 0) {
    (void)kill(g_shell, SIGURG);
  } else if (strncmp(line, "SLOW", 4) == 0) {
    int b = 0, us = 0;
    if (sscanf(line, "SLOW %d %d", &b, &us) == 2) { g_slow_bytes = b; g_slow_us = us; }
  } else if (strncmp(line, "HANGUP", 6) == 0) {
    if (g_master >= 0) (void)close(g_master);
    g_master = -1;
    g_master_done = 1;
  } else if (line[0] == 'T') {
    struct termios t;
    if (tcgetattr(g_master, &t) == 0)
      emit("TERMIOS i=%lx o=%lx c=%lx l=%lx vmin=%d vtime=%d\n", (unsigned long)t.c_iflag,
           (unsigned long)t.c_oflag, (unsigned long)t.c_cflag, (unsigned long)t.c_lflag,
           t.c_cc[VMIN], t.c_cc[VTIME]);
  } else if (strncmp(line, "PAUSE", 5) == 0) {
    g_paused = 1;
  } else if (strncmp(line, "RESUME", 6) == 0) {
    g_paused = 0;
  } else if (strncmp(line, "QUIT", 4) == 0) {
    g_quit = 1;
  }
}

/* Feed a stream of bytes to a line splitter. */
static void lines(char *acc, size_t *acclen, size_t cap, const char *in, size_t n,
                  void (*fn)(const char *)) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (in[i] == '\n') {
      acc[*acclen] = '\0';
      fn(acc);
      *acclen = 0;
    } else if (*acclen + 1 < cap) {
      acc[(*acclen)++] = in[i];
    }
  }
}

static int g_ended;
static long long g_ended_at;

static void do_event(const char *line) {
  if (strncmp(line, "STOPPED", 7) == 0) {
    (void)pump_master();
    emit("STOPPED %lld %lld %d\n", g_total, now_ms(), atoi(line + 7));
  } else if (strncmp(line, "TYPEAHEAD", 9) == 0) {
    emit("%s\n", line);
  } else if (strncmp(line, "TTY", 3) == 0) {
    emit("%s\n", line);
  } else if (strncmp(line, "PID", 3) == 0) {
    g_job = (pid_t)atoi(line + 4);
    emit("%s\n", line);
  } else if (strncmp(line, "EXIT", 4) == 0 || strncmp(line, "SIGNAL", 6) == 0) {
    (void)pump_master();
    emit("%s %lld %lld\n", line, g_total, now_ms());
    g_ended = 1;
    g_ended_at = now_ms();
  }
}

int main(int argc, char **argv) {
  struct winsize ws;
  int m, s, ep[2], rl[2], no_in = 0, no_out = 0, bg = 0, zmode = 0, quiet = 300, i;
  const char *errfile = NULL;
  pid_t shell;
  char ctl_acc[256], ev_acc[2048];
  size_t ctl_len = 0, ev_len = 0;
  int ctl_open, quiet_ok = 0;
  long long last_data;
  struct sigaction sa;

  if (argc >= 2 && strcmp(argv[1], "--winsz") == 0) {
    if (ioctl(0, TIOCGWINSZ, &ws) != 0) die("TIOCGWINSZ");
    printf("%u %u %u %u\n", ws.ws_col, ws.ws_row, ws.ws_xpixel, ws.ws_ypixel);
    return 0;
  }

  memset(&ws, 0, sizeof ws);
  ws.ws_col = 80; ws.ws_row = 24; ws.ws_xpixel = 800; ws.ws_ypixel = 480;
  for (i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (strcmp(argv[i], "-i") == 0) no_in = 1;
    else if (strcmp(argv[i], "-o") == 0) no_out = 1;
    else if (strcmp(argv[i], "-b") == 0) bg = 1;
    else if (strcmp(argv[i], "-z") == 0) zmode = 1;
    else if (strcmp(argv[i], "-e") == 0 && i + 1 < argc) errfile = argv[++i];
    else if (strcmp(argv[i], "-q") == 0 && i + 1 < argc) quiet = atoi(argv[++i]);
    else if (strcmp(argv[i], "-s") == 0 && i + 1 < argc) {
      unsigned c, r, xp, yp;
      if (sscanf(argv[++i], "%u,%u,%u,%u", &c, &r, &xp, &yp) != 4) die("-s");
      ws.ws_col = (unsigned short)c; ws.ws_row = (unsigned short)r;
      ws.ws_xpixel = (unsigned short)xp; ws.ws_ypixel = (unsigned short)yp;
    } else {
      fprintf(stderr, "harness: unknown option %s\n", argv[i]);
      return 2;
    }
  }
  if (i >= argc) { fprintf(stderr, "harness: no program\n"); return 2; }

  ctl_open = fd_open(3);
  if (!fd_open(4)) { fprintf(stderr, "harness: fd 4 (events) is not open\n"); return 2; }
  if (ctl_open) cloexec(3);
  cloexec(4);

  if (openpty(&m, &s, NULL, NULL, &ws) != 0) die("openpty");
  cloexec(m);
  cloexec(s);
  if (pipe(ep) != 0 || pipe(rl) != 0) die("pipe");
  cloexec(ep[0]); cloexec(ep[1]); cloexec(rl[0]); cloexec(rl[1]);

  {
    /* the terminal's name, so a test can open it like another process writing to the pane */
    const char *tn = ttyname(s);
    if (tn != NULL) {
      char line[256];
      int len = snprintf(line, sizeof line, "TTY %s\n", tn);
      if (len > 0 && len < (int)sizeof line) write_fully(ep[1], line, (size_t)len);
    }
  }
  shell = fork();
  if (shell < 0) die("fork");
  if (shell == 0) {
    (void)close(m);
    (void)close(ep[0]);
    (void)close(rl[1]);
    if (zmode) {
      /* the program is the shell: session leader, the terminal as controlling terminal */
      if (setsid() < 0) die("setsid");
      if (ioctl(s, TIOCSCTTY, 0) != 0) die("TIOCSCTTY");
      if (dup2(s, 0) < 0 || dup2(s, 1) < 0 || dup2(s, 2) < 0) die("dup2");
      if (s > 2) (void)close(s);
      (void)close(ep[1]);
      (void)close(rl[0]);
      if (fd_open(3)) (void)close(3);
      if (fd_open(4)) (void)close(4);
      execvp(argv[i], argv + i);
      die("exec");
    }
    shell_main(s, ep[1], rl[0], no_in, no_out, bg, errfile, argv + i);
  }
  (void)close(s);
  (void)close(ep[1]);
  (void)close(rl[0]);
  g_master = m;
  g_shell = shell;
  if (zmode) {
    char line[48];
    snprintf(line, sizeof line, "PID %d", (int)shell);
    do_event(line);
    g_job = shell;
  }
  nonblock(m);
  nonblock(0);
  signal(SIGPIPE, SIG_IGN);
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_quit;
  sigemptyset(&sa.sa_mask);
  (void)sigaction(SIGTERM, &sa, NULL);
  (void)sigaction(SIGINT, &sa, NULL);
  last_data = now_ms();

  while (!g_quit) {
    struct pollfd p[4];
    int r, timeout = 50;
    p[0].fd = g_master_done ? -1 : m;
    p[0].events = (g_paused ? 0 : POLLIN) | (g_inlen > g_inoff ? POLLOUT : 0);
    p[0].revents = 0;
    p[1].fd = g_inlen == 0 ? 0 : -1;
    p[1].events = POLLIN;
    p[1].revents = 0;
    p[2].fd = ctl_open ? 3 : -1;
    p[2].events = POLLIN;
    p[2].revents = 0;
    p[3].fd = ep[0];
    p[3].events = POLLIN;
    p[3].revents = 0;
    r = poll(p, 4, timeout);
    if (r < 0 && errno != EINTR) die("poll");
    if (r > 0) {
      if (p[0].revents & POLLOUT) {
        while (g_inoff < g_inlen) {
          ssize_t w = write(g_master, g_inbuf + g_inoff, g_inlen - g_inoff);
          if (w > 0) g_inoff += (size_t)w;
          else if (w < 0 && errno == EINTR) continue;
          else break;
        }
        if (g_inoff == g_inlen) g_inoff = g_inlen = 0;
      }
      if (p[0].revents & (POLLIN | POLLHUP)) {
        if (pump_master() > 0) last_data = now_ms();
      }
      if (p[1].revents & (POLLIN | POLLHUP)) {
        ssize_t n = read(0, g_inbuf, sizeof g_inbuf);
        if (n > 0) {
          g_inlen = (size_t)n;
          g_inoff = 0;
          while (g_inoff < g_inlen) {
            ssize_t w = write(g_master, g_inbuf + g_inoff, g_inlen - g_inoff);
            if (w > 0) g_inoff += (size_t)w;
            else if (w < 0 && errno == EINTR) continue;
            else break;
          }
          if (g_inoff == g_inlen) g_inoff = g_inlen = 0;
        }
      }
      if (ctl_open && (p[2].revents & (POLLIN | POLLHUP))) {
        char b[128];
        ssize_t n = read(3, b, sizeof b);
        if (n > 0) {
          lines(ctl_acc, &ctl_len, sizeof ctl_acc, b, (size_t)n, do_control);
        } else if (n == 0 || errno != EAGAIN) {
          ctl_open = 0;
        }
      }
      if (p[3].revents & (POLLIN | POLLHUP)) {
        char b[128];
        ssize_t n = read(ep[0], b, sizeof b);
        if (n > 0) lines(ev_acc, &ev_len, sizeof ev_acc, b, (size_t)n, do_event);
      }
    }
    if (zmode && !g_ended) {
      int zst = 0;
      if (waitpid(shell, &zst, WNOHANG) == shell) {
        char line[48];
        if (WIFEXITED(zst)) snprintf(line, sizeof line, "EXIT %d", WEXITSTATUS(zst));
        else snprintf(line, sizeof line, "SIGNAL %d", WTERMSIG(zst));
        do_event(line);
      }
    }
    if (g_ended) {
      long long t = now_ms();
      if (g_master_done || t - last_data >= quiet || t - g_ended_at >= QUIET_CAP_MS) quiet_ok = 1;
      if (quiet_ok) break;
    }
  }
  if (g_master >= 0) (void)pump_master();
  (void)close(rl[1]);
  /* If the program is still around (QUIT or a signal), end it hard. The relay's
   * leader notices the dead relay by itself. */
  {
    int st;
    /* The whole job, not only its first process: after an aborted test a stopped relay and its
     * child would otherwise outlive the harness and fail the later leftover check too. */
    if (g_job > 0 && !g_ended) { (void)kill(-g_job, SIGKILL); (void)kill(g_job, SIGKILL); }
    (void)kill(shell, SIGKILL);
    (void)waitpid(shell, &st, 0);
  }
  return 0;
}
