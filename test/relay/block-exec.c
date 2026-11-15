/* Blocks the signals named on the command line (numbers), then execs the rest: a launcher that
 * hands its child a non-empty signal mask. Usage: block-exec 20 15 -- prog args... */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  sigset_t s;
  int i = 1;
  sigemptyset(&s);
  for (; i < argc && strcmp(argv[i], "--") != 0; i++) sigaddset(&s, atoi(argv[i]));
  if (i >= argc - 1) return 2;
  if (sigprocmask(SIG_BLOCK, &s, NULL) != 0) return 3;
  execv(argv[i + 1], argv + i + 1);
  perror("exec");
  return 127;
}
