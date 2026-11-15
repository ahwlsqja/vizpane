/* A stand-in for Codex, written in C so that it behaves the same with and without the relay
 * and the shell's view of it can be compared byte for byte (the Node fake TUI in fake-tui.mjs
 * keeps reading its stdin after it has restored the terminal, so it is no baseline for what the
 * shell receives as type-ahead).
 *
 * Like Codex it takes raw mode on stdin and the alternate screen on stdout, reads keys one at a
 * time, and writes its frames to stdout. After it has restored the terminal it never reads again,
 * so whatever is typed afterwards belongs to the shell. Its suspend and exit follow Codex's order.
 *
 *   X  restore (screen + termios), idle 500 ms, write 40000 bytes, exit 0
 *   Y  same, then stop the process group (Ctrl+Z); on SIGCONT raw again
 *   D  restore, idle 700 ms, exit 0
 *   q  frame, restore, "<<Q>>", exit 3
 *   z  frame, restore, "<<R>>", cooked, kill(0, SIGTSTP); after the continue: raw again, "<<C>>"
 *   S  600 frames of about 4000 bytes in single writes, "<<S>>": CSI moves, 24-bit colour, Korean,
 *      box drawing, emoji, placeholder rows with their diacritics, a chunked kitty load
 *   T  5 MiB in 4096-byte writes, then START and DONE with the time of each
 *   w  report the size of stdout, of /dev/tty, and whether stderr is stdout's device
 *   a  "A" to stdout, "B" to stderr, "C" to stdout, each in its own write
 *   e  a line on stderr
 *   c  "L1\nL2\n" with the terminal cooked, then raw again
 *   r  "R1\r\nR2\r\n" in raw mode
 *   v  a child that clears output processing on stdin and writes "E1\nE2\n" to stdout, like an editor
 *   u  write 1000 bytes and exit at once
 *   p  do not read for 1500 ms, then exit 0 without restoring anything: what was typed meanwhile is
 *      the shell's, and the terminal settings are the ones this process set
 *   K  leave a process that writes without end, restore, exit 0
 *   V  a vim-shaped resize reader: no timer, the handler only sets a flag, the loop handles it once
 *      (reads the size of stdout, writes "<<VWINCH cols rows>>", works 5 ms)
 *      and clears the flag afterwards, so a signal that arrives meanwhile is swallowed; q ends it like q
 *
 *   i  two rows of placeholder cells for the picture id 0x123456, then "<<PIC>>"
 *
 * Modes for the job-control tests (environment variables):
 *   XP5_MAIN      stay on the main screen (no alternate screen), like Codex's inline viewport, so a
 *                 picture loaded there is still loaded when the program is killed
 *   XP5_TERMREAD  on SIGTERM, read the terminal once before ending with status 143, with SIGTTIN caught
 *                 so that a background read is a group signal and not an immediate EIO: what a dying
 *                 program that still touches its terminal does (a model of the real Codex's last moments)
 *   XP5_NOREAD    never read stdin, never touch the terminal settings, stay cooked: write a line to
 *                 stdout every 50 ms until it is killed or stopped, so that the only thing that
 *                 touches the terminal from the background is whoever carries those lines
 * On SIGWINCH it reads the size of stdout at once, like vim, and writes "<<WINCH cols rows>>".
 * FAKE_TUI_LOG gets READY / RESTORED / WRITTEN / CONT lines, with times in ms where they matter. */
#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static const char ENTER[] = "\x1b[?2004h\x1b[?1049h";
static const char LEAVE[] = "\x1b[?2004l\x1b[?1049l";
/* XP5_MAIN: Codex's inline viewport, which stays on the main screen (no alternate screen) */
static const char ENTER_MAIN[] = "\x1b[?2004h";
static const char LEAVE_MAIN[] = "\x1b[?2004l";
static const char *g_enter = ENTER, *g_leave = LEAVE;
static struct termios g_orig;
static volatile sig_atomic_t g_cont, g_winch;

static void on_cont(int s) { (void)s; g_cont = 1; }
static void on_winch(int s) { (void)s; g_winch = 1; }
static void on_alrm(int s) { (void)s; }
static void on_ttin(int s) { (void)s; }

/* XP5_TERMREAD: runs in the SIGTERM handler, so it happens at the moment of the signal wherever the
 * main loop is (read, sigaction and _exit are async-signal-safe). */
static void on_term_read(int s) {
  struct sigaction sa;
  char c;
  ssize_t r;
  (void)s;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_ttin;
  sigemptyset(&sa.sa_mask);
  (void)sigaction(SIGTTIN, &sa, NULL);
  r = read(0, &c, 1);
  (void)r;
  _exit(143);
}

static long long now_ms(void) {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) != 0) return 0;
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void logl(const char *l) {
  const char *p = getenv("FAKE_TUI_LOG");
  int fd;
  if (p == NULL) return;
  fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  if (write(fd, l, strlen(l)) < 0) { /* best effort */ }
  (void)close(fd);
}

static void log_time(const char *what) {
  char b[64];
  snprintf(b, sizeof b, "%s %lld\n", what, now_ms());
  logl(b);
}

static void put_fd(int fd, const void *buf, size_t n) {
  const char *p = buf;
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w > 0) { p += w; n -= (size_t)w; continue; }
    if (w < 0 && errno == EINTR) continue;
    if (w < 0 && errno == EAGAIN) { struct pollfd pf = {fd, POLLOUT, 0}; (void)poll(&pf, 1, 100); continue; }
    _exit(90);
  }
}

static void put(const void *buf, size_t n) { put_fd(1, buf, n); }
static void puts1(const char *s) { put(s, strlen(s)); }

static void sleep_ms(long ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
}

/* Codex's order on resume: the screen modes on stdout first, then raw mode on stdin. */
static void raw_on(void) {
  struct termios t = g_orig;
  cfmakeraw(&t);
  put(g_enter, strlen(g_enter));
  (void)tcsetattr(0, TCSANOW, &t);
}

static void restore(void) {
  put(g_leave, strlen(g_leave));
  (void)tcsetattr(0, TCSANOW, &g_orig);
  logl("RESTORED\n");
}

/* A Codex-shaped frame: cursor moves, 24-bit colour, Korean, box drawing, emoji, rows of
 * placeholder cells (U+10EEEE and two diacritics, the image id in the foreground colour), and a
 * chunked kitty load whose chunks are each one short APC. */
static char g_frame[70000];

static size_t frame(size_t want, int seed) {
  static const char *texts[] = {"plain ascii text ", "\xea\xb0\x80\xeb\x82\x98\xeb\x8b\xa4 ", "\xe2\x94\x80\xe2\x94\x82\xe2\x94\x8c ",
                                "\xf0\x9f\x99\x82 "};
  static const char *dia[] = {"\xcc\x85", "\xcc\x8d", "\xcc\x8e", "\xcc\x90"};
  size_t n = 0;
  int row = 1;
  while (n + 700 < want && n + 700 < sizeof g_frame) {
    int k, c;
    n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b[%d;1H\x1b[38;2;%d;%d;%dm", row, (seed * 7 + row) & 255, row & 255, 200);
    for (k = 0; k < 4; k++) n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "%s", texts[(row + k + seed) & 3]);
    n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b[0m\x1b[K");
    if (row % 5 == 0) {
      n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b[%d;5H|\x1b[38;2;18;52;86;49m", row);
      for (c = 0; c < 6; c++)
        n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\xf4\x8e\xbb\xae%s%s", dia[row & 3], dia[c & 3]);
      n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b[39;49m|");
    }
    if (row % 7 == 0) {
      n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b" "7\x1b[3;40H\x1b_Ga=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1;QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\x1b\\");
      for (k = 0; k < 3; k++)
        n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b_Gm=1;QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=\x1b\\");
      n += (size_t)snprintf(g_frame + n, sizeof g_frame - n, "\x1b_Gm=0;QUJD\x1b\\\x1b" "8");
    }
    row = row % 40 + 1;
  }
  return n;
}

static void report_size(void) {
  struct winsize a, b;
  struct stat s1, s2;
  char buf[160];
  int fa = ioctl(1, TIOCGWINSZ, &a);
  int t = open("/dev/tty", O_RDONLY | O_NOCTTY);
  int fb = t >= 0 ? ioctl(t, TIOCGWINSZ, &b) : -1;
  int same = fstat(1, &s1) == 0 && fstat(2, &s2) == 0 && S_ISCHR(s1.st_mode) && s1.st_rdev == s2.st_rdev && s1.st_ino == s2.st_ino;
  if (t >= 0) (void)close(t);
  snprintf(buf, sizeof buf, "<<W %d %d / %d %d / err-same %d>>", fa ? -1 : a.ws_col, fa ? -1 : a.ws_row,
           fb ? -1 : b.ws_col, fb ? -1 : b.ws_row, same);
  puts1(buf);
}

static void ready(void) {
  char b[512];
  const char *dir = getenv("VIZPANE_INLINE_DIR"), *tty = getenv("VIZPANE_TTY");
  struct stat s0, s1;
  int have = fstat(0, &s0) == 0 && fstat(1, &s1) == 0;
  snprintf(b, sizeof b, "READY {\"pid\":%d,\"ppid\":%d,\"dir\":%s%s%s,\"tty\":%s%s%s,\"stdinRdev\":%ld,\"stdoutRdev\":%ld}\n",
           (int)getpid(), (int)getppid(), dir ? "\"" : "", dir ? dir : "null", dir ? "\"" : "", tty ? "\"" : "",
           tty ? tty : "null", tty ? "\"" : "", have ? (long)s0.st_rdev : -1L, have ? (long)s1.st_rdev : -1L);
  logl(b);
}

int main(void) {
  static char big[40000], blk[4096];
  struct sigaction sa;
  memset(big, 'P', sizeof big);
  memset(blk, 'Q', sizeof blk);
  if (tcgetattr(0, &g_orig) != 0) return 2;
  if (getenv("XP5_MAIN") != NULL) {
    g_enter = ENTER_MAIN;
    g_leave = LEAVE_MAIN;
  }
  if (getenv("XP5_NOREAD") != NULL) {
    puts1("<<READY>>");
    ready();
    for (;;) {
      puts1("tick\r\n");
      sleep_ms(50);
    }
  }
  memset(&sa, 0, sizeof sa);
  if (getenv("XP5_TERMREAD") != NULL) {
    sa.sa_handler = on_term_read;
    sigemptyset(&sa.sa_mask);
    (void)sigaction(SIGTERM, &sa, NULL);
  }
  sa.sa_handler = on_cont;
  sigemptyset(&sa.sa_mask);
  (void)sigaction(SIGCONT, &sa, NULL);
  sa.sa_handler = on_winch;
  (void)sigaction(SIGWINCH, &sa, NULL);
  raw_on();
  put(g_frame, frame(20000, 1));
  puts1("<<READY>>");
  ready();
  /* A blocking read, so that a process whose group was orphaned gets EIO and ends, as Codex does. A
   * short timer interrupts it, so that a SIGWINCH that arrives between looking at the flag and
   * reading is reported a few ms late, not lost behind the next key. */
  {
    struct itimerval it = {{0, 10000}, {0, 10000}};
    sa.sa_handler = on_alrm;
    (void)sigaction(SIGALRM, &sa, NULL);
    (void)setitimer(ITIMER_REAL, &it, NULL);
  }
  for (;;) {
    char c;
    ssize_t k = read(0, &c, 1);
    if (k < 0 && errno == EINTR) {
      if (g_winch) {
        struct winsize w;
        g_winch = 0;
        if (ioctl(1, TIOCGWINSZ, &w) == 0) {
          char b[64];
          snprintf(b, sizeof b, "<<WINCH %d %d>>", w.ws_col, w.ws_row);
          puts1(b);
        }
      }
      /* a SIGCONT that does not end a suspend is only noted: Codex's handler sets a flag, and the
       * resume code runs once, after its own kill(0, SIGTSTP) has returned */
      g_cont = 0;
      continue;
    }
    if (k <= 0) return 0;
    if (c == 'X' || c == 'Y') {
      restore();
      sleep_ms(500);
      put(big, sizeof big);
      logl("WRITTEN\n");
      if (c == 'X') return 0;
      (void)kill(0, SIGTSTP);
      if (g_cont) { g_cont = 0; raw_on(); logl("CONT\n"); }
    } else if (c == 'V') {
      struct itimerval off = {{0, 0}, {0, 0}};
      (void)setitimer(ITIMER_REAL, &off, NULL);
      puts1("<<V>>");
      g_winch = 0;
      for (;;) {
        char d;
        ssize_t n = read(0, &d, 1);
        if (n < 0 && errno == EINTR) {
          if (g_winch) {
            struct winsize w;
            if (ioctl(1, TIOCGWINSZ, &w) == 0) {
              char b[64];
              snprintf(b, sizeof b, "<<VWINCH %d %d>>", w.ws_col, w.ws_row);
              puts1(b);
            }
            sleep_ms(5);
            g_winch = 0;
          }
          continue;
        }
        if (n <= 0) return 0;
        if (d == 'q') break;
      }
      put(g_frame, frame(30000, 3));
      restore();
      puts1("<<Q>>");
      return 3;
    } else if (c == 'i') {
      /* two rows of six cells: U+10EEEE, row diacritic, column diacritic; the id in the fg colour */
      static const char *dia[] = {"\xcc\x85", "\xcc\x8d", "\xcc\x8e", "\xcc\x90", "\xcc\x92", "\xcc\xbd"};
      int row, col;
      for (row = 0; row < 2; row++) {
        char b[256];
        size_t n = (size_t)snprintf(b, sizeof b, "\x1b[38;2;18;52;86m");
        for (col = 0; col < 6; col++) n += (size_t)snprintf(b + n, sizeof b - n, "\xf4\x8e\xbb\xae%s%s", dia[row], dia[col]);
        n += (size_t)snprintf(b + n, sizeof b - n, "\x1b[39m\r\n");
        put(b, n);
      }
      puts1("<<PIC>>\r\n");
    } else if (c == 'D') {
      restore();
      sleep_ms(700);
      return 0;
    } else if (c == 'q') {
      put(g_frame, frame(30000, 3));
      restore();
      puts1("<<Q>>");
      return 3;
    } else if (c == 'z') {
      put(g_frame, frame(30000, 2));
      put(g_leave, strlen(g_leave));
      puts1("<<R>>");
      (void)tcsetattr(0, TCSANOW, &g_orig);
      g_cont = 0;
      logl("STOPPING\n");
      (void)kill(0, SIGTSTP);
      /* continued: Codex's own SIGCONT handler only sets a flag, then it re-enters raw mode */
      {
        int i;
        for (i = 0; i < 1000 && !g_cont; i++) sleep_ms(1);
      }
      g_cont = 0;
      raw_on();
      puts1("<<C>>");
      logl("CONT\n");
    } else if (c == 'S') {
      int i;
      for (i = 0; i < 600; i++) {
        put(g_frame, frame(4000, i));
        sleep_ms(0);
      }
      puts1("<<S>>");
      logl("STREAMED\n");
    } else if (c == 'T') {
      int i;
      log_time("START");
      for (i = 0; i < 1280; i++) put(blk, sizeof blk);
      log_time("DONE");
    } else if (c == 'w') {
      report_size();
    } else if (c == 'a') {
      put("A", 1);
      put_fd(2, "B", 1);
      put("C", 1);
      logl("ABC\n");
    } else if (c == 'e') {
      put_fd(2, "ERR-LINE\r\n", 10);
      logl("ERR-WRITTEN\n");
    } else if (c == 'c') {
      (void)tcsetattr(0, TCSANOW, &g_orig);
      puts1("L1\nL2\n");
      sleep_ms(100);   /* the pane processes the bytes when they reach it: let them, before it is raw again */
      raw_on();
      logl("COOKED-WRITTEN\n");
    } else if (c == 'r') {
      puts1("R1\r\nR2\r\n");
      logl("RAW-WRITTEN\n");
    } else if (c == 'v') {
      pid_t pid = fork();
      if (pid == 0) {
        struct termios t;
        if (tcgetattr(0, &t) == 0) {
          t.c_oflag &= ~(tcflag_t)OPOST;
          (void)tcsetattr(0, TCSANOW, &t);
        }
        puts1("E1\nE2\n");
        _exit(0);
      }
      if (pid > 0) { int st; (void)waitpid(pid, &st, 0); }
      logl("EDITOR-WRITTEN\n");
    } else if (c == 'u') {
      static char kb[1000];
      memset(kb, 'U', sizeof kb);
      put(kb, sizeof kb);
      log_time("WRITTEN");
      return 0;
    } else if (c == 'p') {
      logl("NOT-READING\n");
      sleep_ms(1500);
      return 0;
    } else if (c == 'K') {
      pid_t pid = fork();
      if (pid == 0) {
        (void)setsid();
        for (;;) {
          if (write(1, "leak ", 5) < 0) _exit(91);
          sleep_ms(1);
        }
      }
      {
        char b[48];
        snprintf(b, sizeof b, "LEAK %d\n", (int)pid);
        logl(b);
      }
      restore();
      return 0;
    }
  }
}
