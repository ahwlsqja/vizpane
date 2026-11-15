/* A writer that is not Codex: OSC 52-shaped sequences (the clipboard copy Codex writes straight to
 * /dev/tty) written to a terminal's path, one write(2) each, at random gaps.
 *   foreign-writer <tty path> <bytes per sequence> <count> <mean gap in microseconds>
 * The sequence is ESC ] 52 ; c ; <base64 alphabet> BEL, so a receiver can find it in the stream
 * and tell whether anything was written into it. */
#define _DARWIN_C_SOURCE 1
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  static const char pre[] = "\x1b]52;c;";
  static char b[8192];
  size_t size;
  int count, gap, fd, i;
  unsigned rng = 12345;
  if (argc < 5) return 2;
  size = (size_t)atoi(argv[2]);
  count = atoi(argv[3]);
  gap = atoi(argv[4]);
  if (size < sizeof pre + 1 || size > sizeof b) return 2;
  fd = open(argv[1], O_WRONLY | O_NOCTTY);
  if (fd < 0) { perror("open"); return 1; }
  for (i = 0; i < count; i++) {
    size_t n = sizeof pre - 1, k;
    memcpy(b, pre, n);
    for (k = n; k < size - 1; k++) b[k] = alphabet[(k + (size_t)i) & 63];
    b[size - 1] = '\a';
    if (write(fd, b, size) != (ssize_t)size) { perror("write"); return 1; }
    rng = rng * 1103515245u + 12345u;
    if (gap > 0) usleep((useconds_t)((rng >> 8) % (unsigned)(2 * gap)));
  }
  return 0;
}
