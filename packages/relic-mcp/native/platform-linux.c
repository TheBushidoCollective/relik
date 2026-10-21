#define _GNU_SOURCE

#include "platform.h"

#if !defined(__linux__)
#error "platform-linux.c may only be compiled for Linux"
#endif

#if !defined(__x86_64__) && !defined(__aarch64__)
#error "secure_open supports only Linux x86-64 and AArch64"
#endif

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_openat2
#error "secure_open requires SYS_openat2 from the target Linux UAPI headers"
#endif

#ifndef RESOLVE_BENEATH
#error "secure_open requires RESOLVE_BENEATH from the target Linux UAPI headers"
#endif

#ifndef RESOLVE_NO_SYMLINKS
#error "secure_open requires RESOLVE_NO_SYMLINKS from the target Linux UAPI headers"
#endif

static void relic_set_error(
  struct relic_open_error *error,
  int errno_value,
  const char *syscall_name,
  enum relic_open_reason reason
) {
  error->errno_value = errno_value;
  error->syscall_name = syscall_name;
  error->reason = reason;
}

static int relic_openat2(
  int directory_fd,
  const char *path,
  unsigned long long flags,
  unsigned long long resolve
) {
  struct open_how how = {0};
  how.flags = flags;
  how.mode = 0;
  how.resolve = resolve;

  return (int)syscall(SYS_openat2, directory_fd, path, &how, sizeof(how));
}

static int relic_probe_uncached(struct relic_open_error *error) {
  const unsigned long long root_flags =
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  const unsigned long long descendant_flags =
    O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  int probe_fd = -1;
  int opened_fd = -1;
  int probe_error = 0;

  probe_fd = open("/", (int)root_flags);
  if (probe_fd < 0) {
    relic_set_error(
      error,
      errno,
      "open confinement probe root",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  opened_fd = relic_openat2(
    probe_fd,
    ".",
    descendant_flags,
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
  );
  if (opened_fd < 0) {
    probe_error = errno;
    close(probe_fd);
    relic_set_error(
      error,
      probe_error,
      "openat2 confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  close(opened_fd);

  opened_fd = relic_openat2(
    probe_fd,
    "..",
    descendant_flags,
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
  );
  if (opened_fd >= 0) {
    close(opened_fd);
    close(probe_fd);
    relic_set_error(
      error,
      EINVAL,
      "openat2 confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  if (errno != EXDEV) {
    probe_error = errno;
    close(probe_fd);
    relic_set_error(
      error,
      probe_error,
      "openat2 confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  opened_fd = relic_openat2(
    probe_fd,
    "/",
    descendant_flags,
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
  );
  if (opened_fd >= 0) {
    close(opened_fd);
    close(probe_fd);
    relic_set_error(
      error,
      EINVAL,
      "openat2 confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  if (errno != EXDEV) {
    probe_error = errno;
    close(probe_fd);
    relic_set_error(
      error,
      probe_error,
      "openat2 confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  close(probe_fd);
  return 0;
}

int relic_probe_confined_open(struct relic_open_error *error) {
  static int probe_state = 0;
  static int probe_errno = 0;
  static const char *probe_syscall = "openat2 confinement probe";

  if (probe_state == 1) return 0;
  if (probe_state == -1) {
    relic_set_error(
      error,
      probe_errno,
      probe_syscall,
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  if (relic_probe_uncached(error) == 0) {
    probe_state = 1;
    return 0;
  }

  probe_errno = error->errno_value;
  probe_syscall = error->syscall_name;
  probe_state = -1;
  return -1;
}

int relic_open_root(const char *path, struct relic_open_error *error) {
  const unsigned long long flags =
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  const int fd = relic_openat2(AT_FDCWD, path, flags, RESOLVE_NO_SYMLINKS);

  if (fd < 0) {
    relic_set_error(error, errno, "open bundle root", RELIC_OPEN_REASON_NONE);
  }
  return fd;
}

int relic_open_descendant(
  int root_fd,
  const char *relative_path,
  struct relic_open_error *error
) {
  const unsigned long long flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  const int fd = relic_openat2(
    root_fd,
    relative_path,
    flags,
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
  );

  if (fd < 0) {
    relic_set_error(error, errno, "openat2 confined descendant", RELIC_OPEN_REASON_NONE);
  }
  return fd;
}
